import { CropRule, RuleEvaluationResult, type Condition, type RuleContext } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateRule, regionApplies, ruleAppliesToProduct, screenCrop } from './evaluate';

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

describe('weather rule fields', () => {
  const c: Condition = { field: 'weather.forecastRainMm7d', op: 'gte', value: 50 };
  it('unknown without weather.evidenceState even when a value is supplied', () => {
    expect(evaluateCondition(c, { weather: { forecastRainMm7d: 80 } })).toEqual({ truth: 'unknown', unknownFields: ['weather.forecastRainMm7d'] });
  });
  it('evaluated when evidenceState accompanies the value', () => {
    expect(evaluateCondition(c, { weather: { forecastRainMm7d: 80, evidenceState: 'forecast' } }).truth).toBe('true');
    expect(evaluateCondition({ field: 'weather.dailyRainMm', op: 'lte', value: 5 }, { weather: { dailyRainMm: 9, evidenceState: 'observed' } }).truth).toBe('false');
  });
  it.each(['farmer_reported', 'derived', 'scenario', 'illustrative', 'unavailable', 'unsupported'] as const)(
    'evidenceState %s is not proof: unknown, and known(false) agrees',
    (state) => {
      const ctx = { weather: { forecastRainMm7d: 80, evidenceState: state } } as never;
      expect(evaluateCondition(c, ctx)).toEqual({ truth: 'unknown', unknownFields: ['weather.forecastRainMm7d'] });
      expect(evaluateCondition({ field: 'weather.forecastRainMm7d', op: 'known', value: true }, ctx).truth).toBe('false');
    },
  );
  it('an approved rule on illustrative weather requires review, never ineligible', () => {
    const rule = {
      id: 'r', version: 1, cropId: 'crop', mode: 'synthetic', reviewStatus: 'approved',
      scope: { regionIds: ['IN'], seasons: [], irrigation: [] },
      when: c, exceptions: [], effect: { type: 'ineligible', reasonCode: 'wet_week' },
    } as never as CropRule;
    const ill = evaluateRule(rule, { weather: { forecastRainMm7d: 80, evidenceState: 'illustrative' } } as never, { mode: 'synthetic' });
    expect(ill.effect).not.toBe('ineligible');
    const real = evaluateRule(rule, { weather: { forecastRainMm7d: 80, evidenceState: 'forecast' } } as never, { mode: 'synthetic' });
    expect(real.effect).toBe('ineligible');
  });
});

describe('HARD/SOFT aggregation (F4)', () => {
  // Synthetic structural fixtures. HARD = eligible | ineligible; SOFT = prefer | caution | requires_review.
  const inWindow = rule({ id: 'synthetic-in-window', when: { field: 'planting.month', op: 'eq', value: 5 }, effect: { type: 'eligible', reasonCode: 'planting_in_window' } });
  const poorDrainage = rule({ id: 'synthetic-poor-drainage', when: { field: 'soil.drainage', op: 'eq', value: 'poor' }, effect: { type: 'requires_review', reasonCode: 'poor_drainage' } });
  const lowRain = rule({ id: 'synthetic-low-rain', when: { not: { field: 'rainfall.seasonalMm', op: 'gte', value: 1300 } }, effect: { type: 'caution', reasonCode: 'low_rain' } });
  const goodTexture = rule({ id: 'synthetic-texture', when: { field: 'soil.texture', op: 'eq', value: 'loam' }, effect: { type: 'prefer', reasonCode: 'loam' } });
  const highElev = rule({ id: 'synthetic-high', when: { field: 'elevation.m', op: 'gte', value: 1500 }, effect: { type: 'ineligible', reasonCode: 'too_high' } });
  const soft = [poorDrainage, lowRain, goodTexture];
  const may: RuleContext = { planting: { month: 5 } };

  it('unknown SOFT rules are unresolved conditions and do not change a HARD eligible verdict', () => {
    const s = screenCrop('synthetic-ginger', [inWindow, ...soft], may, S);
    expect(s.outcome).toBe('eligible');
    expect(s.verdictBasis).toBe('hard_eligible');
    expect(s.unresolvedConditions.map((u) => [u.ruleId, u.field, u.effectIfTrue, u.exceptionId])).toEqual([
      ['synthetic-poor-drainage', 'soil.drainage', 'requires_review', null],
      ['synthetic-low-rain', 'rainfall.seasonalMm', 'caution', null],
      ['synthetic-texture', 'soil.texture', 'prefer', null],
    ]);
    expect(s.unresolvedConditions[0]!.evidenceIds).toEqual(['synthetic-evidence-only']);
    expect(s.confidenceNote).toMatchObject({ resolvedRules: 1, unresolvedRules: 3, unresolvedFields: 3 });
  });
  it('true SOFT rules become reasons; a true requires_review rule escalates', () => {
    const c = screenCrop('synthetic-ginger', [inWindow, ...soft], { ...may, rainfall: { seasonalMm: 1000 }, soil: { texture: 'loam', drainage: 'good' } }, S);
    expect(c.outcome).toBe('eligible');
    expect(c.cautions.map((r) => r.reasonCode)).toEqual(['low_rain']);
    expect(c.preferences.map((r) => r.reasonCode)).toEqual(['loam']);
    expect(c.unresolvedConditions).toEqual([]);
    const r = screenCrop('synthetic-ginger', [inWindow, ...soft], { ...may, soil: { drainage: 'poor' } }, S);
    expect(r.outcome).toBe('requires_review');
    expect(r.verdictBasis).toBe('review_rule');
    expect(r.reviews.map((x) => x.reasonCode)).toEqual(['poor_drainage']);
  });
  it('an unknown HARD rule (planting month missing) -> requires_review', () => {
    const s = screenCrop('synthetic-ginger', [inWindow, ...soft], {}, S);
    expect(s.outcome).toBe('requires_review');
    expect(s.verdictBasis).toBe('hard_rule_unresolved');
    expect(s.unresolvedConditions.some((u) => u.field === 'planting.month' && u.effectIfTrue === 'eligible')).toBe(true);
  });
  it('an unknown HARD ineligible rule blocks eligible; a known one excludes', () => {
    expect(screenCrop('synthetic-ginger', [inWindow, highElev], may, S)).toMatchObject({ outcome: 'requires_review', verdictBasis: 'hard_rule_unresolved' });
    expect(screenCrop('synthetic-ginger', [inWindow, highElev], { ...may, elevation: { m: 1800 } }, S)).toMatchObject({ outcome: 'ineligible', verdictBasis: 'hard_ineligible' });
    expect(screenCrop('synthetic-ginger', [inWindow, highElev], { ...may, elevation: { m: 900 } }, S).outcome).toBe('eligible');
  });
  it('an unknown eligible-only rule is redundant once another HARD eligible holds', () => {
    const irrigated = rule({ id: 'synthetic-irrigated-ok', when: { field: 'irrigation.category', op: 'eq', value: 'irrigated' }, effect: { type: 'eligible', reasonCode: 'irrigated' } });
    const s = screenCrop('synthetic-ginger', [inWindow, irrigated], may, S);
    expect(s.outcome).toBe('eligible');
    expect(s.unresolvedConditions.map((u) => u.field)).toEqual(['irrigation.category']);
  });
  it('no applicable HARD rule -> unknown even when every SOFT rule is listed', () => {
    const s = screenCrop('synthetic-ginger', soft, may, S);
    expect(s).toMatchObject({ outcome: 'unknown', verdictBasis: 'no_applicable_hard_rule' });
    expect(s.unresolvedConditions).toHaveLength(3);
    // soft-only, all true and none requires_review: still unknown, never eligible
    expect(screenCrop('synthetic-ginger', [lowRain, goodTexture], { rainfall: { seasonalMm: 900 }, soil: { texture: 'loam' } }, S).outcome).toBe('unknown');
    // a true requires_review rule without a HARD rule -> requires_review
    expect(screenCrop('synthetic-ginger', [poorDrainage], { soil: { drainage: 'poor' } }, S).outcome).toBe('requires_review');
  });
  it('an unknown exception of a SOFT rule is attributed to the exception', () => {
    const rainUnknown = rule({
      id: 'synthetic-state-rain-unknown',
      scope: { regionIds: ['IN-KA'], seasons: [], irrigation: [] },
      when: { field: 'rainfall.seasonalMm', op: 'known', value: false },
      exceptions: [{ id: 'synthetic-district-exc', when: { field: 'location.districtId', op: 'eq', value: 'IN-KA-hassan' }, effect: { type: 'caution', reasonCode: 'district_normal_low' }, evidenceIds: ['synthetic-evidence-only'] }],
      effect: { type: 'requires_review', reasonCode: 'rain_unknown' },
    });
    const s = screenCrop('synthetic-ginger', [inWindow, rainUnknown], { ...may, location: { stateId: 'IN-KA' } }, S);
    expect(s.outcome).toBe('eligible');
    expect(s.unresolvedConditions).toEqual([{ field: 'location.districtId', ruleId: 'synthetic-state-rain-unknown', exceptionId: 'synthetic-district-exc', effectIfTrue: 'caution', evidenceIds: ['synthetic-evidence-only'] }]);
    const hassan = screenCrop('synthetic-ginger', [inWindow, rainUnknown], { ...may, location: { stateId: 'IN-KA', districtId: 'IN-KA-hassan' } }, S);
    expect(hassan.outcome).toBe('eligible');
    expect(hassan.cautions.map((r) => r.reasonCode)).toEqual(['district_normal_low']);
    const other = screenCrop('synthetic-ginger', [inWindow, rainUnknown], { ...may, location: { stateId: 'IN-KA', districtId: 'IN-KA-mysuru' } }, S);
    expect(other).toMatchObject({ outcome: 'requires_review', verdictBasis: 'review_rule' });
  });
  it('an unknown exception that could make a rule ineligible is a HARD unresolved', () => {
    const r = rule({
      id: 'synthetic-soft-with-hard-exception',
      when: { field: 'planting.month', op: 'eq', value: 5 },
      exceptions: [{ id: 'synthetic-exc-ineligible', when: { field: 'soil.drainage', op: 'eq', value: 'poor' }, effect: { type: 'ineligible', reasonCode: 'waterlogging' }, evidenceIds: ['synthetic-evidence-only'] }],
      effect: { type: 'caution', reasonCode: 'note' },
    });
    expect(screenCrop('synthetic-ginger', [inWindow, r], may, S).outcome).toBe('requires_review');
    expect(screenCrop('synthetic-ginger', [inWindow, r], { ...may, soil: { drainage: 'good' } }, S).outcome).toBe('eligible');
  });
});

describe('region scope matching (F4)', () => {
  const ka = { stateId: 'IN-KA', districtId: null };
  it('a state-scoped rule for another state does not apply when the district is unknown', () => {
    expect(regionApplies(['IN-TN'], ka).truth).toBe('false');
    expect(regionApplies(['IN-TN', 'IN-AS'], ka).truth).toBe('false');
    expect(regionApplies(['IN-KA'], ka).truth).toBe('true');
  });
  it('a district list that excludes the farm district does not apply; missing district is unknown', () => {
    expect(regionApplies(['IN-KA-hassan', 'IN-KA-kodagu'], { stateId: 'IN-KA', districtId: 'IN-KA-mysuru' }).truth).toBe('false');
    expect(regionApplies(['IN-KA-hassan'], { stateId: 'IN-KA', districtId: 'IN-KA-hassan' }).truth).toBe('true');
    expect(regionApplies(['IN-KA-hassan'], ka)).toEqual({ truth: 'unknown', unknownFields: ['location.districtId'] });
    expect(regionApplies(['IN-KA-hassan'], { stateId: 'IN-TN', districtId: null }).truth).toBe('false');
  });
  it('a known district implies its state; national always applies; opaque ids need both levels known', () => {
    expect(regionApplies(['IN-KA'], { districtId: 'IN-KA-hassan' }).truth).toBe('true');
    expect(regionApplies(['IN-TN'], { districtId: 'IN-KA-hassan' }).truth).toBe('false');
    expect(regionApplies(['IN'], undefined).truth).toBe('true');
    expect(regionApplies(['IN-KA'], undefined)).toEqual({ truth: 'unknown', unknownFields: ['location.stateId'] });
    expect(regionApplies(['IN-region-west-coast'], ka).truth).toBe('unknown');
    expect(regionApplies(['IN-region-west-coast'], { stateId: 'IN-KA', districtId: 'IN-KA-hassan' }).truth).toBe('false');
  });
  it('a district-scoped rule with an unknown district in the right state stays unknown in screening (soft -> unresolved)', () => {
    const r = rule({ id: 'synthetic-hassan-prefer', scope: { regionIds: ['IN-KA-hassan'], seasons: [], irrigation: [] }, when: { field: 'planting.month', op: 'eq', value: 5 }, effect: { type: 'prefer', reasonCode: 'xx' } });
    expect(evaluateRule(r, { location: ka, planting: { month: 5 } }, S).truth).toBe('unknown');
    expect(evaluateRule(r, { location: { stateId: 'IN-TN' }, planting: { month: 5 } }, S).effect).toBe('not_applicable');
  });
});

describe('product scoping (F4)', () => {
  const agronomic = rule({ id: 'synthetic-agro', productId: 'synthetic-ginger-fresh', when: { field: 'soil.drainage', op: 'eq', value: 'poor' }, effect: { type: 'requires_review', reasonCode: 'xx' } });
  const market = rule({ id: 'synthetic-market', productId: 'synthetic-ginger-fresh', scope: { regionIds: ['IN'], seasons: [], irrigation: [], productSpecific: true }, when: { field: 'soil.drainage', op: 'eq', value: 'poor' }, effect: { type: 'requires_review', reasonCode: 'yy' } });
  it('a rule naming one product applies to every product of the crop unless productSpecific', () => {
    expect(ruleAppliesToProduct(agronomic, 'synthetic-ginger-dry')).toBe(true);
    expect(ruleAppliesToProduct(market, 'synthetic-ginger-dry')).toBe(false);
    expect(ruleAppliesToProduct(market, 'synthetic-ginger-fresh')).toBe(true);
    const ctx: RuleContext = { soil: { drainage: 'poor' } };
    expect(screenCrop('synthetic-ginger', [agronomic, market], ctx, { ...S, productId: 'synthetic-ginger-dry' }).results.map((r) => r.ruleId)).toEqual(['synthetic-agro']);
    expect(screenCrop('synthetic-ginger', [agronomic, market], ctx, { ...S, productId: 'synthetic-ginger-fresh' }).results).toHaveLength(2);
  });
});
