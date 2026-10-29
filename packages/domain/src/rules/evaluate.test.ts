import { CropRule, RuleEvaluationResult, type Condition, type RuleContext } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateRule, screenCrop } from './evaluate';

// All rules below are SYNTHETIC structural fixtures, not agronomic evidence.
const rule = (r: Record<string, unknown>) =>
  CropRule.parse({
    schemaVersion: '1.0',
    version: 1,
    mode: 'synthetic',
    cropId: 'synthetic-ginger',
    scope: { regionIds: ['IN'], seasons: [], irrigation: [] },
    exceptions: [],
    alternatives: [],
    evidenceIds: ['synthetic-evidence-only'],
    reviewStatus: 'synthetic',
    ...r,
  });

const S = { mode: 'synthetic' as const };

describe('three-valued conditions', () => {
  const ctx: RuleContext = { soil: { ph: 6 }, season: 'kharif' };
  it('missing field -> unknown with the field reported', () => {
    expect(evaluateCondition({ field: 'soil.drainage', op: 'eq', value: 'poor' }, ctx)).toEqual({ truth: 'unknown', unknownFields: ['soil.drainage'] });
    expect(evaluateCondition({ field: 'soil.drainage', op: 'eq', value: 'poor' }, { soil: { drainage: null } }).truth).toBe('unknown');
  });
  it('Kleene all/any/not', () => {
    const unk: Condition = { field: 'soil.drainage', op: 'eq', value: 'poor' };
    const t: Condition = { field: 'soil.ph', op: 'between', value: [5.5, 6.5] };
    const f: Condition = { field: 'season', op: 'eq', value: 'rabi' };
    expect(evaluateCondition({ all: [t, unk] }, ctx).truth).toBe('unknown');
    expect(evaluateCondition({ all: [f, unk] }, ctx).truth).toBe('false');
    expect(evaluateCondition({ any: [t, unk] }, ctx).truth).toBe('true');
    expect(evaluateCondition({ any: [f, unk] }, ctx).truth).toBe('unknown');
    expect(evaluateCondition({ not: unk }, ctx).truth).toBe('unknown');
    expect(evaluateCondition({ not: f }, ctx).truth).toBe('true');
  });
  it('known is always decidable', () => {
    expect(evaluateCondition({ field: 'farm.areaHa', op: 'known', value: true }, ctx).truth).toBe('false');
    expect(evaluateCondition({ field: 'soil.ph', op: 'known', value: true }, ctx).truth).toBe('true');
  });
  it('date and numeric ordering', () => {
    const c: RuleContext = { planting: { date: '2027-04-20', month: 4 } };
    expect(evaluateCondition({ field: 'planting.date', op: 'between', value: ['2027-04-01', '2027-05-15'] }, c).truth).toBe('true');
    expect(evaluateCondition({ field: 'planting.month', op: 'gte', value: 6 }, c).truth).toBe('false');
  });
});

describe('unknown never yields eligible or ineligible', () => {
  const eligibleRule = rule({ id: 'synthetic-eligible', when: { field: 'irrigation.category', op: 'in', value: ['irrigated', 'supplemental'] }, effect: { type: 'eligible', reasonCode: 'water_available' } });
  const ineligibleRule = rule({ id: 'synthetic-ineligible', when: { field: 'soil.drainage', op: 'eq', value: 'poor' }, effect: { type: 'ineligible', reasonCode: 'waterlogging_risk' } });
  it('returns requires_review with truth unknown', () => {
    for (const r of [eligibleRule, ineligibleRule]) {
      const res = evaluateRule(r, {}, S);
      expect(res.truth).toBe('unknown');
      expect(res.effect).toBe('requires_review');
      expect(RuleEvaluationResult.parse(res)).toEqual(res);
    }
  });
  it('screening with only unknowns is never eligible', () => {
    const s = screenCrop('synthetic-ginger', [eligibleRule, ineligibleRule], {}, S);
    expect(s.outcome).toBe('requires_review');
    expect(s.unknownFields.sort()).toEqual(['irrigation.category', 'soil.drainage']);
  });
  it('no applicable rules -> unknown, not eligible', () => {
    expect(screenCrop('synthetic-ginger', [ineligibleRule], { soil: { drainage: 'good' } }, S).outcome).toBe('unknown');
  });
  it('definitive exclusion dominates', () => {
    const s = screenCrop('synthetic-ginger', [eligibleRule, ineligibleRule], { irrigation: { category: 'irrigated' }, soil: { drainage: 'poor' } }, S);
    expect(s.outcome).toBe('ineligible');
  });
  it('known inputs give eligible', () => {
    expect(screenCrop('synthetic-ginger', [eligibleRule, ineligibleRule], { irrigation: { category: 'irrigated' }, soil: { drainage: 'good' } }, S).outcome).toBe('eligible');
  });
});

describe('regional exception: state-wide rule with district exception', () => {
  // Pattern: a state-wide exclusion for rainfed kharif planting, with a named
  // high-rainfall district exception. IDs and thresholds are synthetic.
  const stateRule = rule({
    id: 'synthetic-state-rainfed-exclusion',
    scope: { regionIds: ['synthetic-state-a'], seasons: ['kharif'], irrigation: ['rainfed'] },
    when: { field: 'irrigation.category', op: 'eq', value: 'rainfed' },
    exceptions: [
      {
        id: 'synthetic-hill-district-exception',
        when: { all: [{ field: 'location.districtId', op: 'eq', value: 'synthetic-district-hills' }, { field: 'rainfall.seasonalMm', op: 'gte', value: 1500 }] },
        effect: { type: 'eligible', reasonCode: 'district_high_rainfall_exception' },
        evidenceIds: ['synthetic-evidence-only'],
      },
    ],
    effect: { type: 'ineligible', reasonCode: 'statewide_rainfed_insufficient' },
  });
  const base: RuleContext = { location: { stateId: 'synthetic-state-a' }, season: 'kharif', irrigation: { category: 'rainfed' } };

  it('applies the exception in the excepted district', () => {
    const r = evaluateRule(stateRule, { ...base, location: { stateId: 'synthetic-state-a', districtId: 'synthetic-district-hills' }, rainfall: { seasonalMm: 2200 } }, S);
    expect(r.effect).toBe('eligible');
    expect(r.appliedExceptionId).toBe('synthetic-hill-district-exception');
    expect(r.reasons[0]?.source).toBe('exception');
  });
  it('keeps the state-wide rule for other districts (exception not generalized)', () => {
    const r = evaluateRule(stateRule, { ...base, location: { stateId: 'synthetic-state-a', districtId: 'synthetic-district-plains' }, rainfall: { seasonalMm: 2200 } }, S);
    expect(r.effect).toBe('ineligible');
    expect(r.appliedExceptionId).toBeNull();
  });
  it('excepted district without rainfall evidence -> requires_review, not ineligible', () => {
    const r = evaluateRule(stateRule, { ...base, location: { stateId: 'synthetic-state-a', districtId: 'synthetic-district-hills' } }, S);
    expect(r.effect).toBe('requires_review');
    expect(r.unknownFields).toContain('rainfall.seasonalMm');
  });
  it('unknown district in the state -> requires_review (exception might apply)', () => {
    const r = evaluateRule(stateRule, base, S);
    expect(r.truth).toBe('unknown');
    expect(r.effect).toBe('requires_review');
    expect(r.reasons.some((x) => x.source === 'unresolved_exception')).toBe(true);
  });
  it('does not apply outside the state or to irrigated farms', () => {
    expect(evaluateRule(stateRule, { ...base, location: { stateId: 'synthetic-state-b', districtId: 'synthetic-district-x' } }, S).effect).toBe('not_applicable');
    expect(evaluateRule(stateRule, { ...base, location: { stateId: 'synthetic-state-a', districtId: 'synthetic-district-plains' }, irrigation: { category: 'irrigated' } }, S).effect).toBe('not_applicable');
  });
});

describe('execution gate by mode and review status', () => {
  const r = rule({ id: 'synthetic-gate', when: { field: 'season', op: 'eq', value: 'kharif' }, effect: { type: 'eligible', reasonCode: 'season_ok' } });
  it('synthetic rules never run in live or replay', () => {
    expect(evaluateRule(r, { season: 'kharif' }, { mode: 'live' }).reasons[0]?.reasonCode).toBe('rule_mode_mismatch');
    expect(evaluateRule(r, { season: 'kharif' }, { mode: 'live' }).effect).toBe('not_applicable');
  });
  it('candidate and disabled rules do not execute', () => {
    const cand = CropRule.parse({ ...r, mode: 'live', reviewStatus: 'candidate', evidenceIds: ['live-evidence-1'] });
    expect(evaluateRule(cand, { season: 'kharif' }, { mode: 'live' }).reasons[0]?.reasonCode).toBe('rule_not_approved');
    const dis = CropRule.parse({ ...r, reviewStatus: 'disabled' });
    expect(evaluateRule(dis, { season: 'kharif' }, S).effect).toBe('not_applicable');
  });
});
