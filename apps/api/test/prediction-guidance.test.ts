import {describe, expect, it} from 'vitest';
import type {FieldConditionPoint} from '@harvest/contracts';
import {GUIDANCE_MAX_CHARS, buildPredictionGuidance, phaseForTarget, stageChange, type PredictionGuidanceInput} from '../src/services/today/prediction-guidance';

// SYNTHETIC inputs: stages, readings and conditions below are invented for the rule tests.
const base: PredictionGuidanceInput = {
  sourceDate: '2026-10-15', targetDate: '2026-11-03',
  sourceStage: {id: 'tillering', name: 'Tillering'}, targetStage: {id: 'tillering', name: 'Tillering'}, targetTimeline: 'growing',
  phaseAtTarget: null, latestNdvi: {value: 0.62, date: '2026-10-15'}, conditions: null, cropName: 'Paddy',
};
const cond = (over: Partial<FieldConditionPoint> = {}): FieldConditionPoint => ({
  date: '2026-11-03', kind: 'forecast', rain: {mm: 3, class: 'light'}, water: {state: 'moist', basis: 'rain_rule'},
  heat: {tMaxC: 31, stress: false, thresholdC: 40}, greenness: {ndvi: 0.62, verdict: 'near_typical', observedOn: '2026-10-15', daysSince: 19},
  events: [], stage: {id: 'tillering', name: 'Tillering', progress: 0.4}, ...over,
});
const NUMBER_WITH_DECIMAL = /\d[.,]\d/;

describe('buildPredictionGuidance', () => {
  it('green_up and rising: denser, more uniform green, less bare soil; days elapsed and stage in words', () => {
    for (const phase of ['green_up', 'rising'] as const) {
      const g = buildPredictionGuidance({...base, phaseAtTarget: phase});
      expect(g).toMatchObject({change: 'denser', rule: 'index_phase'});
      expect(g.guidance).toBe('19 days after the real image, in the tillering stage of paddy: the canopy fills in, so the field turns a denser, more uniform green with less bare soil between the rows.');
    }
  });

  it('plateau: full closed canopy, deep green; falling: fading to yellow-brown', () => {
    expect(buildPredictionGuidance({...base, phaseAtTarget: 'plateau'}).guidance).toContain('a full, closed canopy of deep green covers the ground');
    expect(buildPredictionGuidance({...base, phaseAtTarget: 'falling'})).toMatchObject({change: 'senescing', rule: 'index_phase'});
  });

  it('calendar stage decides without a carried phase: maturing and late season fade, development fills in, initial stays mostly soil', () => {
    expect(buildPredictionGuidance({...base, targetStage: {id: 'maturity', name: 'Maturing'}})).toMatchObject({change: 'senescing', rule: 'calendar_stage'});
    expect(buildPredictionGuidance({...base, targetStage: {id: 'late_season', name: 'Late season'}}).guidance).toContain('the green fades to yellow-brown as the crop ripens');
    expect(buildPredictionGuidance({...base, targetStage: {id: 'development', name: 'Crop development'}}).change).toBe('denser');
    expect(buildPredictionGuidance({...base, targetStage: {id: 'mid_season', name: 'Mid-season'}}).change).toBe('full_canopy');
    expect(buildPredictionGuidance({...base, targetStage: {id: 'initial', name: 'Initial'}}).change).toBe('establishing');
    expect(stageChange({id: 'x', name: 'Rhizome development'})).toBe('denser');
    expect(stageChange({id: 'x', name: 'Something else'})).toBeNull();
  });

  it('after the harvest window or a harvested curve: stubble and bare soil, whatever the calendar or phase says', () => {
    const a = buildPredictionGuidance({...base, targetStage: null, targetTimeline: 'after_harvest', phaseAtTarget: 'plateau'});
    expect(a).toMatchObject({change: 'after_harvest', rule: 'harvest'});
    expect(a.guidance).toBe('19 days after the real image, after the paddy harvest: the crop has been harvested, so the field shows stubble and bare soil with little or no green.');
    expect(buildPredictionGuidance({...base, phaseAtTarget: 'harvested'}).change).toBe('after_harvest');
  });

  it('before establishment: bare prepared soil; nothing known: a generic small change', () => {
    expect(buildPredictionGuidance({...base, targetStage: null, targetTimeline: 'before_anchor'}).change).toBe('before_sowing');
    expect(buildPredictionGuidance({...base, targetStage: {id: 'x', name: 'Something else'}})).toMatchObject({change: 'generic', rule: 'generic'});
  });

  it('flooded by crop practice: water visible between rows; heavy rain and heat stress noted without a colour claim', () => {
    const flooded = buildPredictionGuidance({...base, phaseAtTarget: 'rising', conditions: cond({water: {state: 'flooded', basis: 'crop_practice'}})});
    expect(flooded.guidance).toContain('Standing water is visible between the rows.');
    // A rain-rule pond is rain, not drawn water.
    const ponded = buildPredictionGuidance({...base, conditions: cond({water: {state: 'ponded', basis: 'rain_rule'}, rain: {mm: 80, class: 'heavy'}})});
    expect(ponded.guidance).not.toContain('Standing water');
    expect(ponded.guidance).toContain('With heavy rain around that date; do not change the colours for it.');
    const hot = buildPredictionGuidance({...base, conditions: cond({heat: {tMaxC: 41, stress: true, thresholdC: 40}})});
    expect(hot.guidance).toContain('With hot weather around that date; do not change the colours for it.');
    expect(hot.facts).toContain('Maximum temperature on the target date: 41 C (heat stress)');
    // No standing water after harvest.
    expect(buildPredictionGuidance({...base, targetTimeline: 'after_harvest', targetStage: null, conditions: cond({water: {state: 'flooded', basis: 'crop_practice'}})}).guidance).not.toContain('Standing water');
  });

  it('never puts an NDVI number in the guidance; the facts list every input used', () => {
    const g = buildPredictionGuidance({...base, phaseAtTarget: 'rising', conditions: cond({rain: {mm: 70.5, class: 'heavy'}, heat: {tMaxC: 41.2, stress: true, thresholdC: 40}})});
    expect(g.guidance).not.toMatch(NUMBER_WITH_DECIMAL);
    expect(g.guidance).not.toMatch(/ndvi/i);
    expect(g.facts).toEqual([
      'Real image date: 2026-10-15', 'Target date: 2026-11-03 (19 days later)', 'Calendar stage at the real image: Tillering', 'Calendar stage at the target: Tillering',
      'Satellite curve phase carried to the target: rising', 'Latest field NDVI: 0.62 on 2026-10-15 (not used in the image prompt)', 'Rule applied: index phase (denser)',
      'Water on the target date: moist (rain rule)', 'Rain on the target date: heavy (70.5 mm, forecast)', 'Maximum temperature on the target date: 41.2 C (heat stress)',
    ]);
  });

  it('a short gap says the change is small; output is bounded to 400 characters', () => {
    expect(buildPredictionGuidance({...base, targetDate: '2026-10-18', phaseAtTarget: 'rising'}).guidance).toMatch(/^3 days after the real image, .* The change is small\.$/);
    const long = buildPredictionGuidance({...base, cropName: 'x'.repeat(500), conditions: cond({water: {state: 'flooded', basis: 'crop_practice'}, rain: {mm: 90, class: 'heavy'}, heat: {tMaxC: 42, stress: true, thresholdC: 40}})});
    expect(long.guidance.length).toBeLessThanOrEqual(GUIDANCE_MAX_CHARS);
  });
});

describe('phaseForTarget', () => {
  it('carries the phase only within the same calendar stage; harvested always; bare and unknown never', () => {
    expect(phaseForTarget({phase: 'rising', sourceStageId: 'tillering', targetStageId: 'tillering'})).toBe('rising');
    expect(phaseForTarget({phase: 'rising', sourceStageId: 'tillering', targetStageId: 'flowering'})).toBeNull();
    expect(phaseForTarget({phase: 'rising', sourceStageId: null, targetStageId: null})).toBeNull();
    expect(phaseForTarget({phase: 'harvested', sourceStageId: 'a', targetStageId: null})).toBe('harvested');
    expect(phaseForTarget({phase: 'bare', sourceStageId: 'a', targetStageId: 'a'})).toBeNull();
    expect(phaseForTarget({phase: 'unknown', sourceStageId: 'a', targetStageId: 'a'})).toBeNull();
    expect(phaseForTarget({phase: null, sourceStageId: 'a', targetStageId: 'a'})).toBeNull();
  });
});
