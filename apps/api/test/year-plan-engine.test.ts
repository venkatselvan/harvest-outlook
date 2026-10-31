import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StageTimeline, YearPlanOption, YearPlanScenario, type HarvestPriceOutlook } from '@harvest/contracts';
import { parseAgronomyPool, parseFocusedPool, stageTimeline } from '../src/services/today/stage-timeline';
import { addDays } from '../src/services/year-plan/dates';
import type { TimelineFn } from '../src/services/year-plan/scenario';
import { deterministicSelection, gateSelection, hasPriceAndYield, selectionCandidates } from '../src/services/year-plan/select';
import {
  ASSUMPTIONS, PRUNED_RULES, buildScenario, collectInputKeys, data, emptyInputs, enumerateCandidates, enumerateSequences, evaluateSlot, marginNormaliser,
  monthlyRainFromDaily, predecessorOf, priceKey, priceScore, rescoreOption, runInputKeys, runYearPlanEngine, scoreSequences, sequenceScore, shortlist,
  soilRotationScore, transitionScorer, yieldScore, type BuildScenarioArgs, type Candidate, type EngineContext, type Inputs,
} from '../src/services/year-plan';

/**
 * Year-plan engine tests. Every agronomy, yield, cost and price figure below is SYNTHETIC fixture data injected through
 * data.invalidate(fixtures); none is a research value or a market observation. No database, network or model call.
 * Expected numbers for the small case are hand-computed in comments (checked independently in Python).
 */
const ASOF = '2026-11-01';
const H = 'IN-KA-hassan';
const SRC = 'SYN-AG';

const win = (region: string, season: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ region, season, from, to, condition: 'any', source: `${SRC} windows`, ...extra });
const dur = (method: string, min: number | null, max: number | null, cultivar = 'Synthetic cultivar (KA)') => ({ method, cultivar, min, max, source: `${SRC} durations` });
const role = (value: string) => ({ value, method: 'rule_v1', sources: [SRC] });
function crop(cropId: string, family: string, rotationRole: string | null, productIds: string[], extra: Record<string, unknown> = {}) {
  return {
    cropId, family, productIds, rotationRole: rotationRole ? role(rotationRole) : null, nitrogenCreditKgPerHa: null, waterNeedMm: { min: 500, max: 700, source: `${SRC} water` },
    rainfedSuitable: true, durationDays: [], stages: [], sowingWindows: [], recommendedPredecessors: [], recommendedSuccessors: [], avoidAfter: [], sources: [], unknownFutureField: { tolerated: true }, ...extra,
  };
}
const KHARIF_JUNE = win(H, 'kharif', '06-01', '06-30');
const RABI_NOV = win(H, 'rabi', '11-01', '11-30');
const AGRONOMY = {
  sourceCatalog: [{ id: SRC, url: 'https://example.org/synthetic-agronomy', title: 'Synthetic agronomy fixture' }],
  crops: [
    crop('maize', 'Poaceae', 'heavy_feeder', ['maize-grain'], { durationDays: [dur('direct_sowing', 100, 110)], sowingWindows: [KHARIF_JUNE, win(H, 'rabi', '10-01', '10-21')] }),
    crop('sorghum', 'Poaceae', 'moderate_feeder', ['sorghum-grain'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [KHARIF_JUNE, RABI_NOV] }),
    crop('groundnut', 'Fabaceae', 'nitrogen_fixer', ['groundnut-pod'], {
      nitrogenCreditKgPerHa: { min: 54, max: 58, specificity: 'crop_specific_india_review', successorCrop: null, source: `${SRC} credit` },
      durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [KHARIF_JUNE, RABI_NOV],
    }),
    crop('tomato', 'Solanaceae', null, ['tomato-fresh'], {
      durationDays: [dur('transplanting', 120, 130)], sowingWindows: [RABI_NOV, KHARIF_JUNE], rainfedSuitable: null,
      avoidAfter: [{ cropId: 'tomato', source: `${SRC} rot` }, { cropId: 'potato', source: `${SRC} rot` }, { family: 'Solanaceae', source: `${SRC} rot` }],
    }),
    crop('chilli', 'Solanaceae', 'moderate_feeder', ['chilli-green'], { durationDays: [dur('transplanting', 90, 100)], sowingWindows: [RABI_NOV, win(H, 'summer', '02-01', '02-28')], avoidAfter: [{ cropId: 'tomato', source: `${SRC} ipm` }] }),
    crop('potato', 'Solanaceae', 'heavy_feeder', ['potato-fresh'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [RABI_NOV], avoidAfter: [{ cropId: 'potato', source: `${SRC} rot` }] }),
    crop('paddy', 'Poaceae', 'moderate_feeder', ['paddy-grain'], {
      durationDays: [dur('transplanted_or_direct', 110, 120)], sowingWindows: [win(H, 'kharif', '07-01', '07-31'), win(H, 'summer', '12-01', '01-14')],
      recommendedSuccessors: [{ cropId: 'green-gram', source: `${SRC} seq`, context: 'paddy - green gram' }],
    }),
    crop('green-gram', 'Fabaceae', 'nitrogen_fixer', ['green-gram-whole'], {
      nitrogenCreditKgPerHa: { min: 40, max: 50, specificity: 'generic_preceding_legume', source: `${SRC} credit` },
      durationDays: [dur('direct_sowing', 60, 70), dur('relay_broadcast_in_rice_fallow', 66, 66)],
      sowingWindows: [
        win(H, 'kharif', '05-15', '05-21', { condition: 'rainfed', reviewStatus: 'provisional', evidenceType: 'contingency_plan' }),
        win(H, 'summer', '04-20', '04-30'),
        win('IN-KA', 'rabi', '10-01', '10-31', { sourceDistrict: 'Mysore' }),
        win('IN-KA', 'rabi', '11-01', '11-30', { sourceDistrict: 'Dakshina Kannada', stateFallback: false, condition: 'rainfed' }),
      ],
    }),
    crop('ginger', 'Zingiberaceae', 'moderate_feeder', ['ginger-fresh'], {
      durationDays: [dur('rhizome_planting', 200, 240, 'Synthetic rhizome')],
      sowingWindows: [win('IN-west-coast', 'summer', '05-01', '05-15', { candidateFor: 'IN-KA', reviewStatus: 'pending_user_decision', condition: 'rainfed' })],
    }),
    { cropId: 'broken-record', productIds: 'not-an-array' },
  ],
};
const POOL = {
  pool: [
    ['maize', 'maize-grain', 'heavy_feeder'], ['sorghum', 'sorghum-grain', 'moderate_feeder'], ['groundnut', 'groundnut-pod', 'nitrogen_fixer'], ['tomato', 'tomato-fresh', 'heavy_feeder'],
    ['chilli', 'chilli-green', 'moderate_feeder'], ['potato', 'potato-fresh', 'heavy_feeder'], ['paddy', 'paddy-grain', 'moderate_feeder'], ['green-gram', 'green-gram-whole', 'nitrogen_fixer'],
    ['ginger', 'ginger-fresh', 'moderate_feeder'],
  ].map(([cropId, productId, r]) => ({ cropId, productIds: [productId], rotationRole: r, why: 'synthetic' })),
};
const y = (region: string, season: string, cropYear: string, v: number, basis = 'main product as published', extra: Record<string, unknown> = {}) => ({ region, level: region === 'IN-KA' ? 'state' : 'district', season, cropYear, yieldKgPerHa: v, basis, sourceId: 'syn-des', ...extra });
const seasons = (region: string, rows: [string, number][], list = ['Kharif', 'Rabi', 'Summer']) => list.flatMap((s) => rows.map(([yr, v]) => y(region, s, yr, v)));
const GN_ROWS = [...seasons(H, [['2020-21', 900], ['2021-22', 1000], ['2022-23', 1200], ['2023-24', 1100]]), ...seasons('IN-KA', [['2021-22', 1300], ['2022-23', 1500], ['2023-24', 1400]])];
const desCost = (a2fl: number, c2: number) => ({ region: 'IN-KA', year: '2023-24', a2flPerHa: a2fl, c2PerHa: c2, authority: 'des', sourceId: 'syn-des', locator: 'Annex' });
const NO_LOSS = { value: null, sourceId: null, note: 'not researched' };
const YIELD_COST = {
  crops: [
    { cropId: 'maize', yields: [...seasons(H, [['2021-22', 3000], ['2022-23', 3400], ['2023-24', 3200]]), ...seasons('IN-KA', [['2021-22', 3500], ['2022-23', 4000], ['2023-24', 3800]])], costs: [desCost(50000, 70000), { region: 'IN-KA', year: 'KMS2025-26 (projected)', a2flPerHa: null, c2PerHa: null, costPerQuintal: 2141, authority: 'cacp', sourceId: 'syn-cacp' }], postHarvestLossPct: NO_LOSS },
    { cropId: 'sorghum', yields: GN_ROWS, costs: [desCost(30000, 40000)], postHarvestLossPct: NO_LOSS },
    { cropId: 'groundnut', yields: GN_ROWS, costs: [desCost(30000, 40000), { region: 'IN-KA', year: '2025-26', a2flPerHa: 999, c2PerHa: 999, authority: 'other', reliability: 'LOW. Internally inconsistent.', sourceId: 'syn-low' }], postHarvestLossPct: NO_LOSS },
    { cropId: 'tomato', yields: [y(H, 'Kharif & Rabi', '2022-23', 30000, 'fresh produce (form not stated)'), y('IN-KA', 'Kharif & Rabi', '2022-23', 20000, 'fresh produce (form not stated)')], costs: [], postHarvestLossPct: NO_LOSS },
    { cropId: 'chilli', yields: [y('IN-KA', 'all seasons combined', '2022-23', 1500, 'dry chilli inferred from magnitude only'), y('IN-KA', 'all seasons combined', '2023-24', 1600, 'dry chilli inferred from magnitude only')], costs: [{ region: 'IN-KA', district: 'Haveri', year: null, a2flPerHa: null, c2PerHa: 60000, authority: 'sau', reliability: 'MEDIUM-LOW. One season.', sourceId: 'syn-sau' }], postHarvestLossPct: NO_LOSS },
    { cropId: 'potato', yields: seasons('IN-KA', [['2021-22', 20000], ['2022-23', 22000], ['2023-24', 21000]], ['Rabi']).map((r) => ({ ...r, basis: 'tubers (form not stated)' })), costs: [], postHarvestLossPct: NO_LOSS },
    {
      cropId: 'paddy',
      yields: [
        ...['2012', '2013', '2014'].map((yr, i) => y(H, 'Kharif', yr, 2200 + i * 300, 'dataset crop label "Rice"; product form not stated', { stale: true })),
        ...([['2020-21', 2900], ['2021-22', 3000], ['2022-23', 3300], ['2023-24', 3150]] as const).map(([yr, v]) => y('IN-KA', 'Kharif', yr, v, 'rice (milled) equivalent as published by DES, not paddy grain')),
      ],
      costs: [desCost(70000, 90000)], postHarvestLossPct: NO_LOSS,
    },
    { cropId: 'green-gram', yields: seasons('IN-KA', [['2021-22', 400], ['2022-23', 450], ['2023-24', 420]]), costs: [desCost(25000, 35000)], postHarvestLossPct: NO_LOSS },
    { cropId: 'ginger', yields: [], costs: [], postHarvestLossPct: NO_LOSS },
  ],
  sources: { 'syn-des': { url: 'https://example.org/synthetic-des', title: 'Synthetic DES fixture' }, 'syn-otr': { url: 'https://example.org/synthetic-otr', title: 'Synthetic out-turn fixture' } },
  conversions: { riceToPaddy: { paddyKgPerKgRiceRaw: 1.4925, riceKgPerKgPaddyRaw: 0.67, sourceId: 'syn-otr', locator: 'Ch V' } },
};
type Fx = { agronomy: { sourceCatalog: unknown[]; crops: Record<string, unknown>[] }; pool: typeof POOL; yieldCost: typeof YIELD_COST };
const fixtures = (): Fx => structuredClone({ agronomy: AGRONOMY, pool: POOL, yieldCost: YIELD_COST }) as Fx;

function outlook(productId: string, harvestDate: string, p: { p25: number; p50: number; p75: number; annualMean: number } | null): HarvestPriceOutlook {
  return {
    productId, status: p ? 'available' : 'insufficient', missingReason: p ? null : 'price_history_insufficient',
    scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic mandi reference (wholesale), not a farm-gate price', limitations: ['synthetic fixture'],
    method: 'B_seasonal_reference/pooled-v1', harvestDate, harvestWeek: { year: Number(harvestDate.slice(0, 4)), week: 1 }, asOf: ASOF, weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: p ? [2023, 2024, 2025] : [2025], perYear: [], p10: p ? p.p25 * 0.9 : null, p25: p?.p25 ?? null, p50: p?.p50 ?? null, p75: p?.p75 ?? null,
    p90: p ? p.p75 * 1.1 : null, annualMean: p?.annualMean ?? null, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  };
}
type PriceFn = (productId: string, harvestDate: string) => { p25: number; p50: number; p75: number; annualMean: number } | null;
const FLAT: PriceFn = () => ({ p25: 20, p50: 25, p75: 30, annualMean: 25 });
const RAIN = [0, 0, 0, 0, 0, 100, 200, 200, 100, 0, 0, 0];
function inputsFor(ctx: EngineContext, slots: Iterable<{ productId: string; harvest: { earliest: string; latest: string } }>, price: PriceFn = FLAT, irrigation: Inputs['irrigationCategory'] = 'rainfed'): Inputs {
  const inputs = emptyInputs(ASOF, irrigation);
  for (const k of collectInputKeys([...(ctx.fixedSlot ? [ctx.fixedSlot] : []), ...slots])) inputs.priceOutlooks.set(k.key, outlook(k.productId, k.harvestDate, price(k.productId, k.harvestDate)));
  inputs.climatologyRainByMonth = RAIN;
  return inputs;
}
const farm = (irrigation = 'rainfed'): BuildScenarioArgs['farm'] => ({ location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1.2, facts: { irrigation_category: { value: irrigation, basis: 'farmer_reported', confirmed: true } } });
const freshArgs = (previous: string | null = 'maize'): BuildScenarioArgs => ({
  workspace: { previousHarvest: previous ? { status: 'known', cropId: previous, harvestDate: '2026-10-15' } : { status: 'none' }, cycles: [], rotationPlans: [] }, farm: farm(), asOf: ASOF,
});
const find = (cands: readonly Candidate[], cropId: string, sowing: string) => {
  const c = cands.find((x) => x.cropId === cropId && x.sowing === sowing);
  if (!c) throw new Error(`no ${cropId} candidate on ${sowing}`);
  return c;
};

beforeEach(() => data.invalidate(fixtures()));
afterAll(() => data.invalidate());

describe('data selectors', () => {
  it('tolerates unknown fields and skips a malformed record without failing the load', () => {
    expect(data.loadAgronomy().crops.map((c) => c.cropId)).toContain('maize');
    expect(data.agronomyCrop('broken-record')).toBeNull();
    expect(data.loadIssues().some((i) => i.startsWith('crop-agronomy.crops[9] skipped'))).toBe(true);
  });

  it('windowsFor: district first, neighbouring districts as state level, stateFallback:false only for its own district, pending rows unusable', () => {
    const hassan = data.windowsFor('green-gram', { stateId: 'IN-KA', districtId: H });
    expect(hassan.map((w) => [w.row.from, w.scope, w.provisional, w.usable])).toEqual([
      ['05-15', 'district', true, true], ['04-20', 'district', false, true], ['10-01', 'state', false, true],
    ]);
    expect(hassan.find((w) => w.row.from === '10-01')?.neighbour).toBe('Mysore');
    const dk = data.windowsFor('green-gram', { stateId: 'IN-KA', districtId: 'IN-KA-dakshina-kannada' });
    expect(dk.find((w) => w.row.from === '11-01')).toMatchObject({ scope: 'district', usable: true });
    const ginger = data.windowsFor('ginger', { stateId: 'IN-KA', districtId: H });
    expect(ginger).toHaveLength(1);
    expect(ginger[0]).toMatchObject({ scope: 'region', usable: false, reviewStatus: 'pending_user_decision' });
    // A state window is set aside for a season that has a non-provisional district window.
    const fx = fixtures();
    fx.agronomy.crops[0]!.sowingWindows = [...(fx.agronomy.crops[0]!.sowingWindows as object[]), win('IN-KA', 'kharif', '05-01', '05-31', { sourceDistrict: 'Mandya' })];
    data.invalidate(fx);
    expect(data.windowsFor('maize', { stateId: 'IN-KA', districtId: H }).find((w) => w.row.from === '05-01')).toMatchObject({ scope: 'state', usable: false, reason: 'A district window exists for this season.' });
  });

  it('durationFor merges cultivar rows into classes and skips rice-fallow relay rows', () => {
    expect(data.methodsFor('green-gram')).toEqual(['direct_sowing']);
    expect(data.durationFor('green-gram', 'direct_sowing', 'IN-KA', 'green-gram-whole')).toMatchObject([{ min: 60, max: 70, regionMatch: 'state' }]);
    const fx = fixtures();
    fx.agronomy.crops[0]!.durationDays = [dur('direct_sowing', 95, 105, 'Short (TN)'), dur('direct_sowing', 170, 180, 'Long (TN)'), dur('direct_sowing', null, 120, 'Mid (TN)')];
    data.invalidate(fx);
    const classes = data.durationFor('maize', 'direct_sowing', 'IN-KA', 'maize-grain');
    expect(classes.map((c) => [c.min, c.max, c.regionMatch])).toEqual([[95, 120, 'other_state'], [170, 180, 'other_state']]);
    expect(classes[0]!.notes.join(' ')).toContain('Lower bound not published');
  });

  it('yieldFor: rice-basis paddy rows are converted to paddy with a note; unstated district rows are not used for paddy', () => {
    const ref = data.yieldFor('paddy', 'paddy-grain', { stateId: 'IN-KA', districtId: H, season: 'kharif' })!;
    // Last 3 state years 3300, 3150, 3000 rice x 1.4925 = 4925.25, 4701.375, 4477.5 -> P25 4589, p50 4701, P75 4813; reference best year 4925.
    expect(ref).toMatchObject({ basis: 'state', p50: 4701, low: 4589, high: 4813, referenceKgPerHa: 4925, years: ['2023-24', '2022-23', '2021-22'] });
    expect(ref.conversion).toEqual({ factor: 1.4925, sourceId: 'syn-otr', locator: 'Ch V' });
    expect(ref.notes.join(' ')).toContain('converted to paddy at 1.4925');
    expect(ref.notes.join(' ')).toContain('not published in this product form');
  });

  it('yieldFor: district median of the last three years, single-year reference, and product-form mismatch', () => {
    expect(data.yieldFor('groundnut', 'groundnut-pod', { stateId: 'IN-KA', districtId: H, season: 'kharif' })).toMatchObject({ basis: 'district', p50: 1100, low: 1050, high: 1150, referenceKgPerHa: 1500, years: ['2023-24', '2022-23', '2021-22'] });
    expect(data.yieldFor('tomato', 'tomato-fresh', { stateId: 'IN-KA', districtId: H, season: 'rabi' })).toMatchObject({ basis: 'reference', p50: 30000, low: 30000, high: 30000, seasonMatch: 'combined' });
    expect(data.yieldFor('chilli', 'chilli-green', { stateId: 'IN-KA', districtId: H, season: 'rabi' })).toBeNull();
    expect(data.yieldGapReason('chilli', 'chilli-green', 'IN-KA')).toContain('dry');
  });

  it('costFor: excludes low reliability and per-quintal rows, prefers DES/CACP per-ha, flags C2-only', () => {
    expect(data.costFor('groundnut', { stateId: 'IN-KA' })).toMatchObject({ estimate: { a2flPerHa: 30000, c2PerHa: 40000, authority: 'des', year: '2023-24' }, deductionBasis: 'a2fl' });
    expect(data.costFor('maize', { stateId: 'IN-KA' })!.estimate.authority).toBe('des');
    const chilli = data.costFor('chilli', { stateId: 'IN-KA' })!;
    expect(chilli).toMatchObject({ deductionPerHa: 60000, deductionBasis: 'c2', estimate: { a2flPerHa: null, c2PerHa: 60000, authority: 'sau', region: 'IN-KA Haveri' } });
    expect(data.costFor('tomato', { stateId: 'IN-KA' })).toBeNull();
  });
});

describe('scenario', () => {
  it('fresh: horizon starts today and the previous harvested crop feeds the first transition', () => {
    const ctx = buildScenario(freshArgs('maize'));
    expect(YearPlanScenario.parse(ctx.scenario)).toBeTruthy();
    expect(ctx.scenario).toMatchObject({ kind: 'fresh', horizon: { from: ASOF, to: '2027-11-01' }, previousCropId: 'maize', irrigationCategory: 'rainfed' });
    expect(ctx.earliestSowing).toBe(ASOF);
    const set = enumerateCandidates(ctx);
    expect(set.candidates.length).toBeGreaterThan(0);
    expect(set.candidates.every((c) => c.sowing >= ASOF && c.harvest.latest < ctx.horizon.to)).toBe(true);
    const run = runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set });
    expect(run.options.length).toBeGreaterThan(0);
    for (const o of run.options) {
      YearPlanOption.parse(o);
      expect(o.slots[0]!.fixed).toBe(false);
    }
    // Fresh scenario: the first transition is scored from the previous harvested crop (maize), not neutral.
    for (const o of run.options) expect(o.slots[0]!.transitionNote!.startsWith('After maize:')).toBe(true);
  });

  it('occupied: slot 1 is the current cycle and no suggestion overlaps it or a saved season', () => {
    const args: BuildScenarioArgs = {
      workspace: {
        previousHarvest: { status: 'unknown' },
        cycles: [{ id: 'cyc-paddy', cropId: 'paddy', sowingDate: '2026-07-10', stage: 'growing' }],
        rotationPlans: [{ id: 'saved-maize', year: 2026, season: 'Rabi', cropId: 'maize', plannedSowingDate: '2026-12-10', plannedHarvestDate: '2027-03-20' }],
      },
      farm: farm(), asOf: ASOF,
    };
    const ctx = buildScenario(args);
    expect(ctx.scenario).toMatchObject({ kind: 'occupied', currentCycleId: 'cyc-paddy', horizon: { from: '2026-07-10', to: '2027-07-10' } });
    // No recorded harvest: sourced 110-120 days, held to sowing + 120 + 15 + 10 = 2026-12-02.
    expect(ctx.fixedSlot).toMatchObject({ cropId: 'paddy', harvest: { earliest: '2026-10-28', latest: '2026-11-07' }, occupancy: { from: '2026-07-10', to: '2026-12-02' }, harvestBasis: 'sourced_duration' });
    expect(ctx.occupied).toMatchObject([{ id: 'saved-maize', from: '2026-12-10', to: '2027-03-30', basis: 'planned' }]);
    expect(ctx.earliestSowing).toBe('2026-12-02');
    const set = enumerateCandidates(ctx);
    const run = runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set });
    expect(run.options.length).toBeGreaterThan(0);
    for (const o of [...run.options, ...run.shortlist]) {
      YearPlanOption.parse(o);
      expect(o.slots[0]).toMatchObject({ fixed: true, cropId: 'paddy', sowing: '2026-07-10' });
      for (const s of o.slots.slice(1)) {
        expect(s.fixed).toBe(false);
        expect(s.occupancy.from >= ctx.fixedSlot!.occupancy.to).toBe(true);
        expect(s.occupancy.from < '2027-03-30' && '2026-12-10' < s.occupancy.to).toBe(false);
      }
    }
    // Green gram after the saved maize season is a legume after a heavy feeder (the saved season is the predecessor).
    const gg = run.options.flatMap((o) => o.slots).find((s) => s.cropId === 'green-gram')!;
    expect(gg.reasonCodes).toContain('legume_after_heavy_feeder');
    expect(gg.transitionNote).toContain('After maize');
    expect(predecessorOf(ctx, [], gg.sowing)).toBe('maize');
  });
});

describe('current crop without a recorded harvest: stage-timeline window (2026-11-01)', () => {
  // SYNTHETIC maize with stage lengths and a 100-110 day duration; the harvest window is therefore sowing + 100 .. + 110 days.
  const SOWN = '2026-09-20';
  const maizeStages = [{ id: 'establishment', name: 'Establishment', startDay: 0, endDay: 30 }, { id: 'vegetative', name: 'Vegetative growth', startDay: 30, endDay: 70 }, { id: 'grain_filling', name: 'Grain filling', startDay: 70, endDay: 105 }];
  const todayTimeline: TimelineFn = (input) => {
    const fx = fixtures();
    const maize = fx.agronomy.crops.find((c) => c.cropId === 'maize')!;
    maize.stages = maizeStages;
    maize.stagesBasis = { type: 'crop_specific', source: SRC };
    return stageTimeline({ ...input, agronomy: parseAgronomyPool(fx.agronomy), focused: parseFocusedPool({}), snapshot: { stages: [] } });
  };
  const noWindow: TimelineFn = (i) => StageTimeline.parse({ cropId: i.cropId, productId: i.productId, establishmentMethod: i.establishmentMethod, anchorDate: i.anchorDate, stages: [], harvest: null, basis: { kind: 'duration', label: 'No sourced stage data', sourceId: null, url: null, scope: null, note: 'no sourced stage data' } });
  const argsFor = (harvestDate?: string): BuildScenarioArgs => ({
    workspace: { previousHarvest: { status: 'unknown' }, cycles: [{ id: 'cyc-maize', cropId: 'maize', sowingDate: SOWN, stage: 'growing', ...(harvestDate ? { harvestDate } : {}) }], rotationPlans: [] }, farm: farm(), asOf: ASOF,
  });
  const todayInput = { cropId: 'maize', productId: null, establishmentMethod: null, anchorDate: SOWN, stateId: 'IN-KA', districtId: H };

  it('holds the field until the Today harvest window latest date + 7 days + the 10-day gap, and shows the same window', () => {
    const calls: unknown[] = [];
    const ctx = buildScenario({ ...argsFor(), timeline: (i) => { calls.push(i); return todayTimeline(i); } });
    const tl = todayTimeline(todayInput);
    expect(tl.harvest).toEqual({ earliest: '2026-12-29', latest: '2027-01-08' });
    expect(calls).toEqual([todayInput]);
    expect(ctx.fixedSlot!.harvest).toEqual(tl.harvest);
    expect(ASSUMPTIONS.timelineHarvestBufferDays.value).toBe(7);
    expect(ctx.fixedSlot!.occupancy).toEqual({ from: SOWN, to: addDays(tl.harvest!.latest, 7 + ASSUMPTIONS.landPrepGapDays.value) });
    expect(ctx.fixedSlot!.occupancy.to).toBe('2027-01-25');
    expect(ctx.fixedSlot!.durationDays).toEqual({ low: 100, high: 110 });
    expect(ctx.fixedSlot).toMatchObject({ timelineEstimate: true, harvestBasis: 'sourced_duration', durationSourced: true });
    expect(ctx.fixedSlot!.uncertainties.join(' ')).toContain("Harvest date not recorded; estimated from the recorded sowing date and the crop's stage model");
    expect(ctx.fixedSlot!.basis.map((b) => b.sourceId)).toContain('year-plan-assumption:timelineHarvestBufferDays');
    expect(ctx.earliestSowing).toBe('2027-01-25');
    // The older rule (110 + 15 + 10 days) held the field until 2 February and so skipped the 1 February chilli sowing.
    const old = buildScenario(argsFor());
    expect(old.fixedSlot!.occupancy.to).toBe('2027-02-02');
    expect(old.fixedSlot!.timelineEstimate).toBe(false);
    const sowings = (c: EngineContext) => enumerateCandidates(c).candidates.filter((x) => x.cropId === 'chilli').map((x) => x.sowing);
    expect(sowings(ctx)).toContain('2027-02-01');
    expect(sowings(old)).not.toContain('2027-02-01');
    const set = enumerateCandidates(ctx);
    const run = runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set });
    expect(run.options.length).toBeGreaterThan(0);
    for (const o of run.options) {
      expect(o.slots[0]!.harvest).toEqual(tl.harvest);
      expect(o.warnings.join(' ')).toContain("estimated from the recorded sowing date and the crop's stage model");
    }
  });

  it('falls back to the duration rule when the timeline has no harvest window or cannot be computed, and ignores it when a harvest date is recorded', () => {
    const none = buildScenario({ ...argsFor(), timeline: noWindow });
    expect(none.fixedSlot).toMatchObject({ timelineEstimate: false, harvestBasis: 'sourced_duration', harvest: { earliest: '2026-12-29', latest: '2027-01-08' }, occupancy: { to: '2027-02-02' } });
    expect(none.fixedSlot!.uncertainties.join(' ')).toContain('15 days');
    // A stage model with a window but no named source is still used for the dates, but the duration is not counted as sourced.
    const unsourced = buildScenario({ ...argsFor(), timeline: (i) => { const t = todayTimeline(i); return { ...t, basis: { ...t.basis, sourceId: null } }; } });
    expect(unsourced.fixedSlot).toMatchObject({ timelineEstimate: true, harvestBasis: 'assumed_duration', durationSourced: false, occupancy: { to: '2027-01-25' } });
    const broken = buildScenario({ ...argsFor(), timeline: () => { throw new Error('stage file unreadable'); } });
    expect(broken.fixedSlot!.occupancy.to).toBe('2027-02-02');
    expect(broken.warnings.join(' ')).toContain('could not be computed');
    let called = 0;
    const recorded = buildScenario({ ...argsFor('2026-12-20'), timeline: (i) => { called++; return todayTimeline(i); } });
    expect(called).toBe(0);
    expect(recorded.fixedSlot).toMatchObject({ harvestBasis: 'recorded', timelineEstimate: false, occupancy: { to: '2026-12-30' } });
  });
});

describe('labels need price and yield on every suggested crop (2026-11-01)', () => {
  const NEEDS_EVIDENCE = ['Soil enrichment', 'Lowest water', 'Best price timing', 'Steady income', 'Low risk'] as const;
  const twin = (o: YearPlanOption, id: string, score: number): YearPlanOption => ({ ...structuredClone(o), optionId: id, score, totalProfitPerHa: { low: 1000, high: 2000 } });
  const base = (): YearPlanOption => {
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    return runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set }).shortlist[0]!;
  };
  it.each([
    ['price', (s: YearPlanOption['slots'][number]) => { s.price = null; }],
    ['yield', (s: YearPlanOption['slots'][number]) => { s.yieldKgPerHa = null; }],
  ])('a plan with a suggested crop that has no %s is never labelled Lowest water or Steady income; it is Alternative in the fallback and when Meta proposes the label', (_what, strip) => {
    const b = base();
    const a = twin(b, 'opt-a', 80), c = twin(b, 'opt-c', 79.9), bare = twin(b, 'opt-bare', 70);
    strip(bare.slots.find((s) => !s.fixed)!);
    expect([hasPriceAndYield(a), hasPriceAndYield(bare)]).toEqual([true, false]);
    const cands = selectionCandidates([a, c, bare]);
    // The evidenced twins of the same plan are allowed the labels, so only the evidence precondition excludes the bare plan.
    expect(cands[0]!.allowedLabels).toEqual(expect.arrayContaining(['Lowest water', 'Steady income']));
    for (const l of NEEDS_EVIDENCE) expect(cands[2]!.allowedLabels).not.toContain(l);
    expect(cands[2]!.allowedLabels).not.toContain('Best overall');
    const picked = deterministicSelection(cands);
    expect(picked.map((o) => [o.optionId, o.label === 'Alternative'])).toContainEqual(['opt-bare', true]);
    expect(picked.filter((o) => o.optionId !== 'opt-bare').every((o) => o.label !== 'Alternative')).toBe(true);
    const plan = (i: number, label: string) => ({ candidateId: cands[i]!.option.optionId, label, reasonCodes: cands[i]!.codes.slice(0, 1), sentence: 'Fits the free months of this field.' });
    expect(cands.every((x) => x.codes.length > 0)).toBe(true);
    const gate = gateSelection({ plans: [plan(0, 'Best overall'), plan(1, 'Lowest water'), plan(2, 'Steady income')] }, cands);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.labelAdjusted).toEqual([{ candidateId: 'opt-bare', proposed: 'Steady income', assigned: 'Alternative', reason: 'label_not_supported' }]);
    expect(gate.options.map((o) => [o.optionId, o.label])).toEqual([['opt-a', 'Best overall'], ['opt-c', 'Lowest water'], ['opt-bare', 'Alternative']]);
  });
});

describe('rotation scoring and pruning', () => {
  it('a legume after maize outranks a second cereal on soilRotation with everything else equal', () => {
    const credit = data.legumeCredit;
    const legume = soilRotationScore(data.rotationFacts('maize'), data.rotationFacts('groundnut'), credit, undefined);
    const cereal = soilRotationScore(data.rotationFacts('maize'), data.rotationFacts('sorghum'), credit, undefined);
    expect([legume.rule, legume.value]).toEqual(['legume_after_heavy_feeder', 1]);
    expect([cereal.rule, cereal.value]).toEqual(['same_family', 0]);
    // Same sowing date, same duration, yields, cost, water and prices: only family, role and N credit differ.
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    const gn = find(set.candidates, 'groundnut', '2027-06-01');
    const so = find(set.candidates, 'sorghum', '2027-06-01');
    const [a, b] = scoreSequences(ctx, [{ sequenceId: 'legume', slots: [gn] }, { sequenceId: 'cereal', slots: [so] }], inputsFor(ctx, [gn, so]));
    const byCrop = Object.fromEntries([a!, b!].map((o) => [o.slots[0]!.cropId, o]));
    expect(byCrop.groundnut!.components.soilRotation).toBeGreaterThan(byCrop.sorghum!.components.soilRotation);
    for (const k of ['price', 'yield', 'water', 'confidence'] as const) expect(byCrop.groundnut!.components[k]).toBe(byCrop.sorghum!.components[k]);
    expect(byCrop.groundnut!.score).toBeGreaterThan(byCrop.sorghum!.score);
    expect(byCrop.groundnut!.slots[0]!.reasonCodes).toContain('legume_after_heavy_feeder');
  });

  it('prunes avoidAfter and same-family transitions, including from the previous crop', () => {
    const ctx = buildScenario(freshArgs('tomato'));
    const set = enumerateCandidates(ctx);
    expect(set.candidates.some((c) => c.cropId === 'chilli')).toBe(true);
    const seqs = enumerateSequences(ctx, set.candidates, { maxSequences: 400, maxSlots: 4 });
    expect(seqs.length).toBeGreaterThan(0);
    const rot = transitionScorer();
    for (const s of seqs) {
      s.slots.forEach((slot, i) => {
        const prev = predecessorOf(ctx, s.slots.slice(0, i), slot.sowing);
        if (prev) expect(PRUNED_RULES.has(rot(prev, slot.cropId).rule)).toBe(false);
      });
      expect(['chilli', 'potato', 'tomato']).not.toContain(s.slots[0]!.cropId);
    }
    // The same transitions are kept (and scored -1) when a farmer edits them in.
    expect(soilRotationScore(data.rotationFacts('tomato'), data.rotationFacts('chilli'), data.legumeCredit, undefined)).toMatchObject({ rule: 'avoid_after', raw: -1, value: 0 });
  });

  it('a cited same-family succession is kept and scored as cited, an uncited one is pruned', () => {
    const fx = fixtures();
    fx.agronomy.crops[0]!.recommendedSuccessors = [{ cropId: 'sorghum', source: `${SRC} seq`, context: 'maize - sorghum' }];
    data.invalidate(fx);
    expect(soilRotationScore(data.rotationFacts('maize'), data.rotationFacts('sorghum'), data.legumeCredit, undefined)).toMatchObject({ rule: 'cited_succession', raw: ASSUMPTIONS.sameFamilyCitedSuccession.value, sameFamily: true });
    expect(soilRotationScore(data.rotationFacts('paddy'), data.rotationFacts('maize'), data.legumeCredit, undefined).rule).toBe('same_family');
  });
});

describe('slot scoring', () => {
  it('a provisional window lowers windowFit to 0.5 and is flagged; a pending window is skipped with a note', () => {
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    const prov = find(set.candidates, 'green-gram', '2027-05-15');
    const district = find(set.candidates, 'green-gram', '2027-04-20');
    expect([prov.windowFit, prov.flags.provisionalWindow, district.windowFit]).toEqual([0.5, true, 1]);
    const inputs = inputsFor(ctx, [prov, district]);
    const norm = marginNormaliser(ctx, [prov, district], inputs);
    // Same slot, same water and yield inputs; only the window differs (provisional 0.5 versus a district window 1).
    const ep = evaluateSlot(ctx, inputs, prov, norm);
    const asDistrict = evaluateSlot(ctx, inputs, { ...prov, key: `${prov.key}#district`, windowFit: 1, window: { ...prov.window!, provisional: false } }, norm);
    expect(ep.water.value).toBe(asDistrict.water.value);
    expect(ep.yield.value).toBeCloseTo(asDistrict.yield.value * 0.5, 12);
    expect(ep.confidenceFlags.districtWindow).toBe(false);
    const [opt] = scoreSequences(ctx, [{ sequenceId: 'p', slots: [prov] }], inputs, { norm });
    expect(opt!.slots[0]!.reasonCodes).toContain('provisional_window');
    expect(set.candidates.some((c) => c.cropId === 'green-gram' && c.sowing >= '2026-11-01' && c.sowing <= '2026-11-30')).toBe(false); // Dakshina Kannada row not used for Hassan
    expect(set.candidates.some((c) => c.cropId === 'ginger')).toBe(false);
    expect(set.skipped.find((s) => s.cropId === 'ginger')?.reason).toContain('user decision');
    expect(set.notes.join(' ')).toContain('awaits a user decision');
  });

  it('cost null gives cost_not_sourced, no profit and lower confidence', () => {
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    const tomato = find(set.candidates, 'tomato', '2026-11-01');
    const inputs = inputsFor(ctx, [tomato]);
    const without = evaluateSlot(ctx, inputs, tomato, { maxMarginRate: 1000 });
    expect(without.cost).toBeNull();
    expect(without.profit).toBeNull();
    expect(without.revenue).not.toBeNull();
    expect(without.codes).toContain('cost_not_sourced');
    expect(without.price.marginPart).toBe(0);
    // Rule change 2026-11-01: a missing cost scores 0.7 x gross revenue rate / candidate maximum; profit stays null.
    const rev = without.price.revenueRate!;
    const scaled = evaluateSlot(ctx, inputs, tomato, { maxMarginRate: 1000, maxRevenueRate: rev * 2 });
    expect(scaled.price.marginPart).toBeCloseTo(ASSUMPTIONS.missingCostRevenueFactor.value * 0.5, 12);
    expect(scaled.profit).toBeNull();
    expect(scaled.codes).toContain('cost_not_sourced');
    const fx = fixtures();
    fx.yieldCost.crops.find((c) => c.cropId === 'tomato')!.costs = [desCost(100000, 130000)] as never;
    data.invalidate(fx);
    const withCost = evaluateSlot(ctx, inputs, tomato, { maxMarginRate: 1000 });
    expect(withCost.confidence.value - without.confidence.value).toBeCloseTo(0.2, 10);
    expect(withCost.codes).not.toContain('cost_not_sourced');
  });

  it('price insufficient gives price component 0 with a reason and no revenue', () => {
    expect(priceScore({ yieldP50: 1000, costPerHa: 1, postHarvestLossPct: null, occupancyDays: 100 }, outlook('maize-grain', '2027-09-01', null), null, 10)).toEqual({ value: 0, marginPart: 0, timingPart: 0, marginRate: null, revenueRate: null, timingRatio: null, reasonCodes: ['price_insufficient'] });
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    const gn = find(set.candidates, 'groundnut', '2027-06-01');
    const [opt] = scoreSequences(ctx, [{ sequenceId: 'x', slots: [gn] }], inputsFor(ctx, [gn], () => null));
    const slot = opt!.slots[0]!;
    expect(slot.components.price).toBe(0);
    expect(slot.reasonCodes).toContain('price_insufficient');
    expect(slot.price).toMatchObject({ status: 'insufficient', p50: null, range: null, reason: 'price_history_insufficient' });
    expect(slot.revenuePerHa).toBeNull();
    expect(opt!.totalRevenuePerHa).toBeNull();
  });

  it('yieldScore and waterFit follow spec 5.1 (rainfed cap, NDVI only with observed months for the minus side)', () => {
    expect(yieldScore({}, { p50: 1100, referenceKgPerHa: 1500 }, 0.8, 0.5).value).toBeCloseTo((1100 / 1500 / 1.2) * 0.8 * 0.5, 12);
    expect(yieldScore({ yieldOverrideKgPerHa: 2000 }, { p50: 1100, referenceKgPerHa: 1500 }, 1, 1).value).toBeCloseTo(1, 12);
    const ctx = buildScenario(freshArgs('maize'));
    const tomato = find(enumerateCandidates(ctx).candidates, 'tomato', '2027-06-01');
    const inputs = inputsFor(ctx, [tomato]);
    const capped = evaluateSlot(ctx, inputs, tomato, { maxMarginRate: null });
    expect(capped.water.value).toBe(0.4); // rainfed field, crop not marked rainfed-suitable
    expect(capped.codes).toContain('rainfed_unsuitable');
    inputs.neighbourhoodActiveMonths = [11, 12];
    inputs.neighbourhoodObservedMonths = [1, 2, 3, 6, 7, 8, 9, 10, 11, 12];
    inputs.irrigationCategory = 'irrigated';
    const contradicted = evaluateSlot(ctx, inputs, tomato, { maxMarginRate: null });
    expect(contradicted.water.ndviAdjustment).toBe(-0.1);
    inputs.neighbourhoodObservedMonths = undefined;
    expect(evaluateSlot(ctx, inputs, tomato, { maxMarginRate: null }).water.ndviAdjustment).toBe(0);
  });
});

describe('sequence score, reproducibility and shortlist', () => {
  it('sequenceScore matches the hand-computed formula', () => {
    // base = 120/365 x 0.6 + 100/365 x 0.5 = 0.3342466; idle 145 d = 4.7638604 months -> penalty 0.02 x 2.7638604 = 0.0552772;
    // value = 0.3342466 + 0.15 x 0.75 - 0.0552772 = 0.3914694 -> 39.15.
    const r = sequenceScore({ slots: [{ weightDays: 120, slotScore: 0.6 }, { weightDays: 100, slotScore: 0.5 }], horizonDays: 365, rotationFit: 0.75, idleDays: 145 });
    expect(r.value).toBeCloseTo(0.39146936795, 10);
    expect(r.score).toBe(39.15);
    expect(r.idlePenalty).toBeCloseTo(0.05527720739, 10);
  });

  it('small case: every component reproduces the hand computation, and identical inputs give identical output', () => {
    const ctx = buildScenario(freshArgs('maize'));
    const gn = find(enumerateCandidates(ctx).candidates, 'groundnut', '2027-06-01');
    const price: PriceFn = (p) => (p === 'groundnut-pod' ? { p25: 50, p50: 60, p75: 70, annualMean: 50 } : null);
    const run = () => scoreSequences(ctx, [{ sequenceId: 'small', slots: [gn] }], inputsFor(ctx, [gn], price));
    const [opt] = run();
    const slot = opt!.slots[0]!;
    // Harvest 2027-08-30..2027-09-09, occupancy to 2027-09-19 (110 days). Price key at the midpoint 2027-09-04 (ISO week 35).
    expect(priceKey('groundnut-pod', '2027-09-04')).toBe('groundnut-pod@W35');
    expect(slot).toMatchObject({ harvest: { earliest: '2027-08-30', latest: '2027-09-09' }, occupancy: { from: '2027-06-01', to: '2027-09-19' }, yieldKgPerHa: { low: 1050, high: 1150 }, yieldBasis: 'district' });
    // price = (25 x 1 + 15 x (60/50 - 0.5)) / 40 = 0.8875 (margin rate is the normaliser itself)
    // water = rain(Jun 100 + Jul 200 + Aug 200 + 8/30 x Sep 100 = 526.667) / need 600 = 0.877778 (rainfed, no allowance)
    // yield = (1100 / 1500) / 1.2 x window 1 x water 0.877778 = 0.536420; confidence 5/5 = 1; rotation maize -> groundnut = 1
    expect(slot.components).toEqual({ price: 0.8875, yield: 0.5364, soilRotation: 1, water: 0.8778, confidence: 1 });
    // slot = 0.4 x 0.8875 + 0.3 x 0.536420 + 0.1 x 0.877778 + 0.05 x 1 = 0.653704; + 0.15 x 1 -> 80.37
    expect(slot.score).toBe(80.37);
    expect(slot.confidence).toBe('high');
    // revenue = 1050 x 50 .. 1150 x 70 = 52500 .. 80500; profit minus A2+FL 30000.
    expect([slot.revenuePerHa, slot.profitPerHa]).toEqual([{ low: 52500, high: 80500 }, { low: 22500, high: 50500 }]);
    // sequence = 110/365 x 0.653704 + 0.15 x 1 - 0.02 x (255/30.4375 - 2) = 0.219450 -> 21.95
    expect([opt!.score, opt!.idleMonths]).toEqual([21.95, 8.38]);
    expect(slot.reasonCodes).toEqual(expect.arrayContaining(['legume_after_heavy_feeder', 'price_timing_strong', 'margin_rate_high', 'district_window', 'water_fit_good']));
    expect(slot.basis.length).toBeGreaterThan(3);
    expect(slot.basis.every((b) => b.kind && b.label)).toBe(true);
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    const full = () => { const set = enumerateCandidates(ctx); return runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set }); };
    expect(JSON.stringify(full().shortlist)).toBe(JSON.stringify(full().shortlist));
  });

  it('shortlist is diverse: distinct crop sequences, labelled picks, more than one first crop, at most n', () => {
    const ctx = buildScenario(freshArgs(null));
    const set = enumerateCandidates(ctx);
    const run = runYearPlanEngine(ctx, inputsFor(ctx, set.candidates), { candidateSet: set });
    const list = shortlist(run.options, 8);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.length).toBeLessThanOrEqual(8);
    expect(new Set(list.map((o) => o.optionId)).size).toBe(list.length);
    const sig = (o: YearPlanOption) => o.slots.map((s) => s.cropId).join('>');
    expect(new Set(list.map(sig)).size).toBe(list.length);
    expect(list[0]!.label).toBe('Best overall');
    expect(list.map((o) => o.label)).toEqual(expect.arrayContaining(['Best overall', 'Soil enrichment']));
    expect(new Set(list.map((o) => o.slots[0]!.cropId)).size).toBeGreaterThan(1);
    expect(shortlist(run.options, 2)).toHaveLength(2);
  });
});

describe('farmer edits', () => {
  it('an edited date outside every window returns a warning, outside_window and a lower window-driven yield score', () => {
    const ctx = buildScenario(freshArgs('maize'));
    const set = enumerateCandidates(ctx);
    const gn = find(set.candidates, 'groundnut', '2027-06-01');
    const inputs = inputsFor(ctx, [gn]);
    const norm = marginNormaliser(ctx, set.candidates, inputs);
    const [original] = scoreSequences(ctx, [{ sequenceId: 'o', slots: [gn] }], inputs, { norm });
    const edits = [{ slotId: original!.slots[0]!.slotId, cropId: 'groundnut', productId: 'groundnut-pod', sowing: '2027-08-01' }];
    for (const k of collectInputKeys([{ productId: 'groundnut-pod', harvest: { earliest: '2027-10-30', latest: '2027-11-09' } }])) inputs.priceOutlooks.set(k.key, outlook(k.productId, k.harvestDate, FLAT(k.productId, k.harvestDate)));
    const edited = rescoreOption(ctx, inputs, edits, { norm });
    YearPlanOption.parse(edited);
    expect(edited.origin).toBe('farmer_edit');
    expect(edited.slots[0]!.slotId).toBe(original!.slots[0]!.slotId);
    expect(edited.warnings.join(' ')).toContain('outside every sourced window');
    expect(edited.warnings.join(' ')).toContain('after the 12-month plan horizon');
    expect(edited.slots[0]!.reasonCodes).toContain('outside_window');
    expect(edited.slots[0]!.components.yield).toBe(0);
    expect(original!.slots[0]!.components.yield).toBeGreaterThan(0);
  });

  it('edits that overlap a saved season or follow an avoided crop are kept with warnings, never refused', () => {
    const args: BuildScenarioArgs = { ...freshArgs('tomato'), workspace: { ...freshArgs('tomato').workspace, rotationPlans: [{ id: 'saved', year: 2027, season: 'Kharif', cropId: 'maize', plannedSowingDate: '2027-06-01', plannedHarvestDate: '2027-09-15' }] } };
    const ctx = buildScenario(args);
    const edits = [{ cropId: 'chilli', productId: 'chilli-green', sowing: '2026-11-08' }, { cropId: 'groundnut', productId: 'groundnut-pod', sowing: '2027-06-08' }];
    const opt = rescoreOption(ctx, emptyInputs(ASOF, 'rainfed'), edits);
    YearPlanOption.parse(opt);
    expect(opt.slots.map((s) => s.cropId)).toEqual(['chilli', 'groundnut']);
    const w = opt.warnings.join(' ');
    expect(w).toContain('a source advises against this order');
    expect(w).toContain('overlaps a saved season');
    expect(opt.slots[0]!.reasonCodes).toContain('avoid_after_violation');
    expect(opt.slots[0]!.components.soilRotation).toBe(0);
    expect(opt.slots[1]!.reasonCodes).toContain('occupancy_conflict');
  });
});

describe('edge cases', () => {
  it('a current crop that fills the horizon yields a current-crop-only option instead of nothing', () => {
    const ctx = buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [{ id: 'g1', cropId: 'ginger', sowingDate: '2026-05-01', stage: 'growing', harvestDate: '2027-04-30' }], rotationPlans: [] }, farm: farm(), asOf: ASOF });
    expect(ctx.earliestSowing >= ctx.horizon.to).toBe(true);
    const run = runYearPlanEngine(ctx, emptyInputs(ASOF, 'rainfed'));
    expect(run.options).toHaveLength(1);
    YearPlanOption.parse(run.options[0]);
    expect(run.options[0]!.slots).toHaveLength(1);
    expect(run.options[0]!.slots[0]).toMatchObject({ fixed: true, cropId: 'ginger', harvest: { earliest: '2027-04-30', latest: '2027-04-30' } });
  });

  it('farmer exclusions and an outlook computed for another date are respected and flagged', () => {
    const args = freshArgs('maize');
    args.farm.facts!.excluded_crop_ids = { value: 'tomato, chilli', basis: 'farmer_reported', confirmed: true };
    const ctx = buildScenario(args);
    const set = enumerateCandidates(ctx);
    expect(set.candidates.some((c) => c.cropId === 'tomato' || c.cropId === 'chilli')).toBe(false);
    expect(set.skipped.filter((s) => s.reason === 'Excluded by the farmer.').map((s) => s.cropId)).toEqual(['tomato', 'chilli']);
    const gn = find(set.candidates, 'groundnut', '2027-06-01');
    const inputs = inputsFor(ctx, [gn]);
    inputs.asOf = '2026-10-01';
    expect(evaluateSlot(ctx, inputs, gn, { maxMarginRate: null }).uncertainties.join(' ')).toContain('computed for 2026-11-01, not for this review date');
  });
});

describe('inputs helpers', () => {
  it('collectInputKeys dedupes by product and ISO week bucket; monthlyRainFromDaily needs every month', () => {
    const keys = collectInputKeys([
      { productId: 'maize-grain', harvest: { earliest: '2027-09-01', latest: '2027-09-11' } },
      { productId: 'maize-grain', harvest: { earliest: '2027-09-07', latest: '2027-09-11' } },
      { productId: 'maize-grain', harvest: { earliest: '2027-12-27', latest: '2028-01-04' } },
    ]);
    // Midpoints 2027-09-06 (Mon) and 2027-09-09 (Thu) share ISO week 36; 2027-12-31 is ISO week 52.
    expect(keys).toEqual([{ key: 'maize-grain@W36', productId: 'maize-grain', harvestDate: '2027-09-06' }, { key: 'maize-grain@W52', productId: 'maize-grain', harvestDate: '2027-12-31' }]);
    const days = Array.from({ length: 365 }, (_, i) => ({ date: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10), rainMm: 2 }));
    expect(monthlyRainFromDaily(days)![0]).toBe(62);
    expect(monthlyRainFromDaily(days.slice(0, 200))).toBeNull();
    const ctx = buildScenario(freshArgs('maize'));
    expect(runInputKeys(ctx, enumerateCandidates(ctx)).length).toBeGreaterThan(0);
  });
});

describe('real research files (read-only)', () => {
  it('load with the tolerant schemas; every pool crop has an agronomy record; Hassan occupied invariants hold', () => {
    data.invalidate();
    expect(data.poolEntries().length).toBeGreaterThanOrEqual(15);
    for (const p of data.poolEntries()) expect(data.agronomyCrop(p.cropId), p.cropId).not.toBeNull();
    const ctx = buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [{ id: 'c1', cropId: 'paddy', sowingDate: '2026-09-01', stage: 'growing' }], rotationPlans: [] }, farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: {} }, asOf: ASOF });
    const set = enumerateCandidates(ctx);
    const run = runYearPlanEngine(ctx, emptyInputs(ASOF), { candidateSet: set });
    for (const o of run.shortlist) {
      YearPlanOption.parse(o);
      expect(o.slots[0]).toMatchObject({ fixed: true, cropId: 'paddy' });
      for (const s of o.slots.slice(1)) expect(s.sowing >= ctx.fixedSlot!.occupancy.to).toBe(true);
    }
    expect(set.skipped.find((s) => s.cropId === 'ginger')?.reason).toContain('user decision');
  });
});
