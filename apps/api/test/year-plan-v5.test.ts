import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { YearPlanReview, type HarvestPriceOutlook, type YearPlanOption } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { estimateProfit, estimateProfitMulti } from '../src/services/estimate';
import { getWorkspace } from '../src/services/workspace';
import {
  ASSUMPTIONS, buildScenario, collectInputKeys, data, emptyInputs, enumerateCandidates, evaluateSlot, HorizonError, predecessorOf, pricedSlots, rescoreOption, scoreSequences,
  soilRotationScore, soilYieldFactor, type BuildScenarioArgs, type Candidate, type EngineContext, type Inputs,
} from '../src/services/year-plan';
import { applyYearPlan, ensureYearPlan, ENGINE_VERSION, generateYearPlan, readYearPlan, rescoreYearPlan, yearPlanContext, type YearPlanDeps } from '../src/services/year-plan/service';
import { currentMandiQuotes } from '../src/services/market-quotes';
import { appendBestProfitOption, appendGreenManureOption, BEST_PROFIT_LABEL, selectionCandidates } from '../src/services/year-plan/select';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Round 3 engine tests (ROUND3_SPEC sections 1, 4, 6, 8.2). Every agronomy, yield, cost, price and intercrop figure in the
 * fixtures below is SYNTHETIC; the "real file" test only checks that the research intercropping file parses. Service tests
 * use the test DB with synthetic price and rain sources and the real research files.
 */
const ASOF = '2026-11-01';
const H = 'IN-KA-hassan';
const SRC = 'SYN-AG';
const win = (region: string, season: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ region, season, from, to, condition: 'any', source: `${SRC} windows`, ...extra });
const dur = (method: string, min: number, max: number) => ({ method, cultivar: 'Synthetic cultivar (KA)', min, max, source: `${SRC} durations` });
const crop = (cropId: string, family: string, r: string, productIds: string[], extra: Record<string, unknown> = {}) => ({
  cropId, family, productIds, rotationRole: { value: r, method: 'rule_v1', sources: [SRC] }, nitrogenCreditKgPerHa: null, waterNeedMm: { min: 500, max: 700, source: `${SRC} water` },
  rainfedSuitable: true, durationDays: [], stages: [], sowingWindows: [], recommendedPredecessors: [], recommendedSuccessors: [], avoidAfter: [], sources: [], ...extra,
});
const JUNE = win(H, 'kharif', '06-01', '06-30');
const NOV = win(H, 'rabi', '11-01', '11-30');
const credit = (min: number, max: number) => ({ min, max, specificity: 'synthetic', successorCrop: null, source: `${SRC} credit` });
const AGRONOMY = {
  sourceCatalog: [{ id: SRC, url: 'https://example.org/synthetic-agronomy', title: 'Synthetic agronomy fixture' }],
  crops: [
    crop('maize', 'Poaceae', 'heavy_feeder', ['maize-grain'], { durationDays: [dur('direct_sowing', 100, 110)], sowingWindows: [JUNE, win(H, 'rabi', '10-01', '10-21')] }),
    crop('sorghum', 'Poaceae', 'moderate_feeder', ['sorghum-grain'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [JUNE, NOV] }),
    crop('groundnut', 'Fabaceae', 'nitrogen_fixer', ['groundnut-pod'], { nitrogenCreditKgPerHa: credit(54, 58), durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [JUNE, NOV] }),
    crop('green-gram', 'Fabaceae', 'nitrogen_fixer', ['green-gram-whole'], { nitrogenCreditKgPerHa: credit(40, 50), durationDays: [dur('direct_sowing', 60, 70)], sowingWindows: [JUNE, NOV] }),
    crop('potato', 'Solanaceae', 'heavy_feeder', ['potato-fresh'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [NOV] }),
  ],
};
const POOL = { pool: [['maize', 'maize-grain'], ['sorghum', 'sorghum-grain'], ['groundnut', 'groundnut-pod'], ['green-gram', 'green-gram-whole'], ['potato', 'potato-fresh']].map(([cropId, productId]) => ({ cropId, productIds: [productId], why: 'synthetic' })) };
const y = (region: string, season: string, cropYear: string, v: number) => ({ region, level: region === 'IN-KA' ? 'state' : 'district', season, cropYear, yieldKgPerHa: v, basis: 'main product as published', sourceId: 'syn-des' });
const rows = (region: string, list: [string, number][]) => ['Kharif', 'Rabi'].flatMap((s) => list.map(([yr, v]) => y(region, s, yr, v)));
const cost = (a2fl: number) => [{ region: 'IN-KA', year: '2023-24', a2flPerHa: a2fl, c2PerHa: a2fl + 10000, authority: 'des', sourceId: 'syn-des', locator: 'Annex' }];
const NO_LOSS = { value: null, sourceId: null, note: 'synthetic' };
const YIELD_COST = {
  crops: [
    { cropId: 'maize', yields: [...rows(H, [['2021-22', 3000], ['2022-23', 3400], ['2023-24', 3200]]), ...rows('IN-KA', [['2021-22', 3500], ['2022-23', 4000], ['2023-24', 3800]])], costs: cost(50000), postHarvestLossPct: NO_LOSS },
    { cropId: 'sorghum', yields: [...rows(H, [['2021-22', 1000], ['2022-23', 1200], ['2023-24', 1100]]), ...rows('IN-KA', [['2021-22', 1300], ['2022-23', 1500], ['2023-24', 1400]])], costs: cost(30000), postHarvestLossPct: NO_LOSS },
    { cropId: 'groundnut', yields: rows('IN-KA', [['2023-24', 1400]]), costs: cost(30000), postHarvestLossPct: NO_LOSS },
    { cropId: 'green-gram', yields: rows('IN-KA', [['2021-22', 400], ['2022-23', 450], ['2023-24', 420]]), costs: cost(25000), postHarvestLossPct: NO_LOSS },
    { cropId: 'potato', yields: [], costs: [], postHarvestLossPct: NO_LOSS },
  ],
  sources: { 'syn-des': { url: 'https://example.org/synthetic-des', title: 'Synthetic DES fixture' } },
  conversions: {},
};
const system = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Sorghum + green gram', mainCropId: 'sorghum', mainProductId: 'sorghum-grain', companionCropId: 'green-gram', companionProductId: 'green-gram-whole',
  rowRatio: '4:1', arrangement: 'row', regions: [H], season: 'kharif', condition: 'any', sowingWindow: null, companionHarvest: null,
  yieldShare: { main: { min: 0.8, max: 0.9 }, companion: { min: 0.2, max: 0.3 }, basis: 'synthetic', source: 'SYN-IC' }, ler: null,
  seedRateShare: { main: 1, companion: 0.25, source: 'SYN-IC' }, nitrogenCreditKgPerHa: null, notes: [], reviewStatus: 'sourced', sources: ['SYN-IC'], ...extra,
});
const INTERCROP = {
  systems: [
    system('syn-sorghum-greengram-4-1'),
    system('syn-sorghum-greengram-credit', { season: 'rabi', nitrogenCreditKgPerHa: { min: 20, max: 30, source: 'SYN-IC' } }),
    system('syn-maize-groundnut-2-1', { mainCropId: 'maize', mainProductId: 'maize-grain', companionCropId: 'groundnut', companionProductId: 'groundnut-pod', rowRatio: '2:1', yieldShare: null, seedRateShare: null, reviewStatus: 'provisional', sources: [] }),
    { id: 'broken-system' },
  ],
  fallback: { yieldShare: null, ler: { min: 1.16, max: 1.22 }, source: 'SYN-FB', engineRule: 'Synthetic fallback rule.' },
  sources: { 'SYN-IC': { url: 'https://example.org/synthetic-intercrop', title: 'Synthetic intercrop trial', locator: 'Table 1' } },
};
const fixtures = () => structuredClone({ agronomy: AGRONOMY, pool: POOL, yieldCost: YIELD_COST, greenManure: { crops: [] }, intercropping: INTERCROP });

function outlook(productId: string, harvestDate: string, p = { p25: 20, p50: 25, p75: 30, annualMean: 25 }): HarvestPriceOutlook {
  return {
    productId, status: 'available', missingReason: null, scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic mandi reference', limitations: [], method: 'B_seasonal_reference/pooled-v1', harvestDate,
    harvestWeek: { year: Number(harvestDate.slice(0, 4)), week: 1 }, asOf: ASOF, weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [],
    p10: p.p25 * 0.9, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p75 * 1.1, annualMean: p.annualMean, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  };
}
function inputsFor(ctx: EngineContext, plans: Iterable<Candidate | ReturnType<typeof enumerateCandidates>['candidates'][number]>, rain: number[] | null = [0, 0, 0, 0, 0, 100, 200, 200, 100, 0, 0, 0]): Inputs {
  const inputs = emptyInputs(ASOF, 'rainfed');
  for (const k of collectInputKeys(pricedSlots([...(ctx.fixedSlot ? [ctx.fixedSlot] : []), ...plans]))) inputs.priceOutlooks.set(k.key, outlook(k.productId, k.harvestDate));
  inputs.climatologyRainByMonth = rain;
  return inputs;
}
const farm = (): BuildScenarioArgs['farm'] => ({ location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1.2, facts: { irrigation_category: { value: 'rainfed', basis: 'farmer_reported', confirmed: true } } });
const fresh = (over: Partial<BuildScenarioArgs> = {}): BuildScenarioArgs => ({ workspace: { previousHarvest: { status: 'known', cropId: 'maize', harvestDate: '2026-10-15' }, cycles: [], rotationPlans: [] }, farm: farm(), asOf: ASOF, ...over });
const find = (cands: readonly Candidate[], pred: (c: Candidate) => boolean) => { const c = cands.find(pred); if (!c) throw new Error('candidate not found'); return c; };

describe('round 3 engine (synthetic fixtures)', () => {
  beforeEach(() => data.invalidate(fixtures()));
  afterAll(() => data.invalidate());

  it('yield v2: water fit is not in the yield part; the reference is the state median, the best state year only as a flagged fallback', () => {
    const ctx = buildScenario(fresh());
    const sorghum = find(enumerateCandidates(ctx).candidates, (c) => c.cropId === 'sorghum' && c.kind === 'crop' && c.sowing === '2027-06-01');
    const wet = evaluateSlot(ctx, inputsFor(ctx, [sorghum]), sorghum, { maxMarginRate: 1 });
    const dry = evaluateSlot(ctx, inputsFor(ctx, [sorghum], Array(12).fill(0)), sorghum, { maxMarginRate: 1 });
    expect(dry.water.value).toBeLessThan(wet.water.value);
    expect(dry.yield.value).toBe(wet.yield.value);
    // District p50 1100 / state median 1400 (1300, 1500, 1400) / 1.2 x window 1 x soil 1.
    expect(wet.yieldRef).toMatchObject({ p50: 1100, referenceKgPerHa: 1400, referenceBasis: 'state_median' });
    expect(wet.yield.value).toBeCloseTo(1100 / 1400 / 1.2, 12);
    expect(wet.codes).not.toContain('yield_reference_best_year');
    const gn = find(enumerateCandidates(ctx).candidates, (c) => c.cropId === 'groundnut' && c.sowing === '2027-06-01');
    const single = evaluateSlot(ctx, inputsFor(ctx, [gn]), gn, { maxMarginRate: 1 });
    expect(single.yieldRef).toMatchObject({ referenceBasis: 'state_best_year', referenceKgPerHa: 1400 });
    expect(single.codes).toContain('yield_reference_best_year');
    expect(single.basis.some((b) => b.sourceId === 'year-plan-assumption:referenceYield')).toBe(true);
  });

  it('yield v2: the soil factor multiplies the yield part (watch 0.95, short 0.85, floor 0.7) with soil_limits_yield and the limiting markers named', () => {
    expect(soilYieldFactor(null).value).toBe(1);
    expect(soilYieldFactor([{ key: 'ph', label: 'Soil pH', verdict: 'unknown' }, { key: 'n', label: 'N', verdict: 'ok' }]).value).toBe(1);
    expect(soilYieldFactor([{ key: 'n', label: 'N', verdict: 'short' }, { key: 'p', label: 'P', verdict: 'short' }, { key: 'k', label: 'K', verdict: 'short' }, { key: 'ph', label: 'pH', verdict: 'watch' }]).value).toBe(0.7);
    const ctx = buildScenario(fresh());
    const sorghum = find(enumerateCandidates(ctx).candidates, (c) => c.cropId === 'sorghum' && c.kind === 'crop' && c.sowing === '2027-06-01');
    const inputs = inputsFor(ctx, [sorghum]);
    const base = evaluateSlot(ctx, inputs, sorghum, { maxMarginRate: 1 });
    const seen: [string, number | null][] = [];
    inputs.soilChecks = (cropId, yieldP50) => { seen.push([cropId, yieldP50]); return [{ key: 'nitrogen_available', label: 'Available nitrogen', verdict: 'watch' }, { key: 'potassium_available', label: 'Available potassium', verdict: 'short' }, { key: 'ph', label: 'Soil pH', verdict: 'ok' }]; };
    const limited = evaluateSlot(ctx, inputs, sorghum, { maxMarginRate: 1 });
    expect(seen).toContainEqual(['sorghum', 1100]);
    expect(limited.yield.soilFactor).toBeCloseTo(0.95 * 0.85, 12);
    expect(limited.yield.value).toBeCloseTo(base.yield.value * 0.8075, 12);
    expect(limited.codes).toContain('soil_limits_yield');
    expect(limited.basis.find((b) => b.kind === 'soil')?.note).toContain('Available nitrogen watch, Available potassium short');
    expect(limited.basis.some((b) => b.sourceId === 'year-plan-assumption:soilYieldFactors')).toBe(true);
    expect(base.codes).not.toContain('soil_limits_yield');
  });

  it('yieldForFieldKg is the yield range times the field area, and option components are the occupancy-weighted slot means', () => {
    const ctx = buildScenario(fresh());
    const set = enumerateCandidates(ctx).candidates;
    const a = find(set, (c) => c.cropId === 'groundnut' && c.sowing === '2026-11-01' && c.kind === 'crop');
    const b = find(set, (c) => c.cropId === 'sorghum' && c.kind === 'crop' && c.sowing === '2027-06-01');
    const [opt] = scoreSequences(ctx, [{ sequenceId: 's', slots: [a, b] }], inputsFor(ctx, [a, b]));
    const s0 = opt!.slots.find((s) => s.cropId === 'sorghum')!;
    expect(s0.yieldForFieldKg).toEqual({ low: Math.round(1050 * 1.2), high: Math.round(1150 * 1.2) });
    const w = opt!.slots.map((s) => (Date.parse(s.occupancy.to) - Date.parse(s.occupancy.from)) / 86_400_000);
    for (const k of ['price', 'yield', 'water', 'confidence'] as const) {
      const mean = opt!.slots.reduce((sum, s, i) => sum + w[i]! * s.components[k], 0) / (w[0]! + w[1]!);
      expect(opt!.components[k]).toBeCloseTo(mean, 3);
    }
  });

  it('future horizon: no fixed slot, starts at the previous horizon end, follows saved seasons, else the previous review, else neutral with a warning', () => {
    const cycle = { id: 'cy-1', cropId: 'maize', productId: 'maize-grain', sowingDate: '2026-09-20', stage: 'vegetative' };
    const ws = (rotationPlans: unknown[] = []) => ({ previousHarvest: { status: 'none' as const }, cycles: [cycle], rotationPlans }) as unknown as BuildScenarioArgs['workspace'];
    const current = buildScenario(fresh({ workspace: ws() }));
    expect(current.horizonStarts).toEqual({ current: { from: '2026-09-20', to: '2027-09-20' }, futures: ['2027-09-20', '2028-09-20', '2029-09-20'] });
    expect(() => buildScenario(fresh({ workspace: ws(), horizonFrom: '2027-10-01' }))).toThrow(HorizonError);
    const none = buildScenario(fresh({ workspace: ws(), horizonFrom: '2027-09-20' }));
    expect(none).toMatchObject({ fixedSlot: null, yearIndex: 1, previousCropId: null, horizon: { from: '2027-09-20', to: '2028-09-20' }, scenario: { kind: 'future', yearIndex: 1, currentCycleId: null, assumedPredecessor: null } });
    expect(none.warnings.join(' ')).toContain('generate the plan for that year first');
    const saved = { id: 'sv-1', year: 2027, season: 'Kharif', cropId: 'groundnut', cropName: 'Groundnut', productId: 'groundnut-pod', productName: 'Groundnut pods', plannedSowingDate: '2027-06-01', plannedHarvestDate: '2027-09-15' };
    const followsSaved = buildScenario(fresh({ workspace: ws([saved]), horizonFrom: '2027-09-20', assumedPredecessor: { cropId: 'sorghum', occupancy: { from: '2027-06-01', to: '2027-09-30' }, optionLabel: 'Best overall', horizonFrom: '2026-09-20', reviewId: 'r0', signature: 'x' } }));
    expect(followsSaved.previousCropId).toBe('groundnut');
    expect(followsSaved.scenario.assumedPredecessor).toMatchObject({ cropId: 'groundnut', basis: 'saved_season', optionLabel: null });
    expect(followsSaved.earliestSowing).toBe('2027-09-25');
    expect(followsSaved.assumed).toBeNull();
    const assumed = buildScenario(fresh({ workspace: ws(), horizonFrom: '2027-09-20', assumedPredecessor: { cropId: 'groundnut', cropName: 'Groundnut', occupancy: { from: '2027-06-01', to: '2027-10-05' }, optionLabel: 'Best overall', horizonFrom: '2026-09-20', reviewId: 'r0', signature: 'groundnut/groundnut-pod' } }));
    expect(assumed.scenario.assumedPredecessor).toEqual({ cropId: 'groundnut', cropName: 'Groundnut', basis: 'year_plan_option', optionLabel: 'Best overall', horizonFrom: '2026-09-20' });
    expect(assumed.occupied).toContainEqual(expect.objectContaining({ id: 'assumed:r0', basis: 'planned', from: '2027-06-01', to: '2027-10-05' }));
    expect(assumed.earliestSowing).toBe('2027-10-05');
    expect(assumed.assumed).toEqual({ reviewId: 'r0', signature: 'groundnut/groundnut-pod' });
    expect(predecessorOf(assumed, [], '2027-11-01')).toBe('groundnut');
    const cands = enumerateCandidates(assumed).candidates;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.sowing >= '2027-10-05' && c.harvest.latest < '2028-09-20')).toBe(true);
    const year3 = buildScenario(fresh({ workspace: ws(), horizonFrom: '2029-09-20' }));
    expect(year3.scenario.yearIndex).toBe(3);
  });

  it('intercrop: enumerated on the main crop window, revenue sums both products, cost uses the seed-rate share, fallback shares are flagged', () => {
    const ctx = buildScenario(fresh());
    const set = enumerateCandidates(ctx);
    expect(data.loadIssues().some((i) => i.startsWith('intercropping.systems[3] skipped'))).toBe(true);
    const ic = find(set.candidates, (c) => c.kind === 'intercrop' && c.intercrop?.systemId === 'syn-sorghum-greengram-4-1' && c.sowing === '2027-06-01');
    expect(ic.key).toBe('intercrop:syn-sorghum-greengram-4-1|sorghum-grain|direct_sowing|d0|2027-06-01');
    expect([...new Set(set.candidates.filter((c) => c.intercrop?.systemId === 'syn-sorghum-greengram-4-1').map((c) => c.season))]).toEqual(['kharif']);
    const inputs = inputsFor(ctx, [ic]);
    const ev = evaluateSlot(ctx, inputs, ic, { maxMarginRate: 1e9, maxRevenueRate: 1e9 });
    // Sorghum district p50 1100 x share 0.85 x 25 + green gram state p50 420 x share 0.25 x 25 = 23375 + 2625.
    expect(ev.estimate.median).toBeCloseTo(26000, 6);
    expect(ev.companion).toMatchObject({ cropId: 'green-gram', yieldRange: { low: 410, high: 435 }, combinedCostPerHa: 30000 + 25000 * 0.25, costAssumed: false });
    expect(ev.estimate.profitPerHa!.central).toBeCloseTo(26000 - 36250, -3);
    expect(ev.codes).toEqual(expect.arrayContaining(['intercrop']));
    expect(ev.codes).not.toContain('intercrop_shares_assumed');
    const [opt] = scoreSequences(ctx, [{ sequenceId: 'ic', slots: [ic] }], inputs);
    const slot = opt!.slots[0]!;
    expect(slot).toMatchObject({ kind: 'intercrop', cropId: 'sorghum', companion: { systemId: 'syn-sorghum-greengram-4-1', cropId: 'green-gram', rowRatio: '4:1', shareBasis: 'sourced', yieldShare: { main: { low: 0.8, high: 0.9 } } } });
    expect(slot.yieldForFieldKg).toEqual({ low: Math.round(1050 * 0.8 * 1.2), high: Math.round(1150 * 0.9 * 1.2) });
    expect(slot.companion!.costPerHa).toBe(25000 * 0.25);
    // 2026-11-01 to 2027-06-01 idle (212 days) and 2027-09-19 to the horizon end at half weight.
    expect(opt!.idlePenaltyPoints).toBeCloseTo(ASSUMPTIONS.idlePenalty.value.perMonth * ((212 + (Date.parse('2027-11-01') - Date.parse(slot.occupancy.to)) / 86_400_000 / 2) / 30.4375 - 0.5) * 100, 1);
    const prov = find(set.candidates, (c) => c.intercrop?.systemId === 'syn-maize-groundnut-2-1');
    const pe = evaluateSlot(ctx, inputsFor(ctx, [prov]), prov, { maxMarginRate: 1e9 });
    expect(prov.intercrop!.system.yieldShare).toEqual(ASSUMPTIONS.intercropFallbackShares.value);
    expect(pe.codes).toEqual(expect.arrayContaining(['intercrop_shares_assumed', 'intercrop_cost_assumed']));
    expect(pe.companion!.combinedCostPerHa).toBeCloseTo(50000 + 30000 / 3, 6);
  });

  it('intercrop rotation: a successor gets the legume credit only when the system nitrogen credit is sourced; rescore accepts systemId', () => {
    const ctx = buildScenario(fresh());
    const set = enumerateCandidates(ctx).candidates;
    const plain = find(set, (c) => c.intercrop?.systemId === 'syn-sorghum-greengram-4-1');
    const withCredit = find(set, (c) => c.intercrop?.systemId === 'syn-sorghum-greengram-credit');
    const later = '2028-01-01';
    expect(predecessorOf(ctx, [plain], later)).toBe('sorghum');
    expect(predecessorOf(ctx, [withCredit], later)).toBe('ic:syn-sorghum-greengram-credit');
    const after = (prev: string) => soilRotationScore(data.rotationFacts(prev), data.rotationFacts('potato'), data.legumeCredit, undefined);
    expect(after('ic:syn-sorghum-greengram-credit').rule).toBe('heavy_feeder_after_legume');
    expect(after('sorghum').rule).not.toBe('heavy_feeder_after_legume');
    // The token keeps the main crop's family: maize after the sorghum intercrop is still a same-family repeat.
    expect(soilRotationScore(data.rotationFacts('ic:syn-sorghum-greengram-credit'), data.rotationFacts('maize'), data.legumeCredit, undefined).rule).toBe('same_family');
    const inputs = inputsFor(ctx, [plain]);
    const edited = rescoreOption(ctx, inputs, [{ cropId: 'sorghum', productId: 'sorghum-grain', kind: 'intercrop', systemId: 'syn-sorghum-greengram-4-1', sowing: '2027-06-01' }]);
    expect(edited.slots[0]).toMatchObject({ kind: 'intercrop', companion: { cropId: 'green-gram' } });
    const unknown = rescoreOption(ctx, inputs, [{ cropId: 'sorghum', productId: 'sorghum-grain', kind: 'intercrop', systemId: 'no-such-system', sowing: '2027-06-01' }]);
    expect(unknown.slots[0]!.kind).toBe('crop');
    expect(unknown.warnings.join(' ')).toContain('not known for this field');
  });

  it('estimateProfitMulti: one term has the single-crop median; two terms add their medians', () => {
    const q = { yieldKgPerHa: { p25: 900, p50: 1000, p75: 1100 }, pricePerKg: { p25: 20, p50: 25, p75: 30 } };
    const one = estimateProfitMulti({ seed: 's', terms: [q], costPerHa: 10000, areaHa: 1 });
    expect(one.median).toBe(estimateProfit({ seed: 's', ...q, costPerHa: 10000, areaHa: 1 }).median);
    const two = estimateProfitMulti({ seed: 's', terms: [q, { ...q, yieldKgPerHa: { p25: 180, p50: 200, p75: 220 } }], costPerHa: 10000, areaHa: 2 });
    expect(two.median).toBe(25000 + 5000);
    expect(Math.abs(two.revenuePerHa!.central - 30000)).toBeLessThan(1500);
    expect(estimateProfitMulti({ seed: 's', terms: [q, { yieldKgPerHa: null, pricePerKg: q.pricePerKg }], costPerHa: 1, areaHa: 1 }).revenuePerHa).toBeNull();
  });

  it('the research intercropping file parses: 19 systems, none skipped; a sourced LER without shares is split and flagged', () => {
    data.invalidate();
    const file = data.loadIntercropping();
    expect(file.status).toBe('loaded');
    expect(file.systems).toHaveLength(19);
    expect(data.loadIssues().filter((i) => i.startsWith('intercropping'))).toEqual([]);
    const sri = data.intercropSystem('tn-ragi-blackgram-2-1-sri')!;
    expect(sri.shareBasis).toBe('assumed');
    expect(sri.yieldShare.main).toEqual({ min: 0.83, max: 0.93 });
    expect(sri.yieldShare.companion.min).toBeCloseTo(0.19, 9);
    expect(sri.yieldShare.companion.max).toBeCloseTo(0.29, 9);
    expect(data.intercropSystem('ka-hassan-ragi-blackgram-4-1')!.shareBasis).toBe('sourced');
    expect(data.intercropSystems({ stateId: 'IN-KA', districtId: H }).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ best profit (section 6)
const PRICE = { status: 'available' as const, unit: 'INR/kg' as const, p50: 20, range: { low: 18, high: 22 }, harvestWeek: '2027-W36', yearsUsed: [2024, 2025], observations: 10, scope: { level: 'state' as const, stateName: 'Karnataka', districtName: null, marketCount: 1 }, reason: null };
function opt(id: string, o: { score?: number; profit: number | null; crops?: string[]; cost?: boolean; gm?: boolean; label?: string }): YearPlanOption {
  const slot = (cropId: string, kind: 'crop' | 'green_manure' = 'crop') => ({
    slotId: `s-${id}-${cropId}`, cropId, productId: `${cropId}-p`, cropName: cropId, productName: cropId, establishmentMethod: null, kind, fixed: false, sowing: '2027-06-01',
    harvest: { earliest: '2027-09-01', latest: '2027-09-10' }, occupancy: { from: '2027-06-01', to: '2027-09-20' }, durationDays: { low: 90, high: 100 },
    yieldKgPerHa: kind === 'green_manure' ? null : { low: 1, high: 2 }, yieldBasis: 'state' as const, price: kind === 'green_manure' ? null : PRICE,
    cost: o.cost === false ? null : { a2flPerHa: 1, c2PerHa: 1, authority: 'des' as const, year: '2023-24', region: 'IN-KA' }, revenuePerHa: null, profitPerHa: null, score: 50,
    components: { price: 0.5, yield: 0.5, soilRotation: 0.5, water: 0.5, confidence: 0.5 }, confidence: 'high' as const, transitionNote: null, reasonCodes: [], uncertainties: [], basis: [],
  });
  const est = o.profit === null ? null : { central: o.profit, likely: { low: o.profit - 100, high: o.profit + 100 }, possible: { low: o.profit - 200, high: o.profit + 200 } };
  return {
    optionId: id, label: o.label ?? 'Alternative', origin: 'deterministic', score: o.score ?? 50, components: { price: 0.5, yield: 0.5, soilRotation: 0.5, water: 0.5, confidence: 0.5 },
    slots: [...(o.gm ? [slot('sunhemp', 'green_manure')] : []), ...(o.crops ?? ['maize']).map((c) => slot(c))], idleMonths: 1, reasons: [], totalRevenuePerHa: null, totalProfitPerHa: null,
    totalProfitEstimate: est, totalProfitForField: est, fieldAreaHa: 1, warnings: [], editable: true,
  };
}

describe('round 3 Best profit (section 6)', () => {
  it('label rule: the highest central profit within 1 percent, only with price, yield and a sourced cost on every suggested crop', () => {
    const list = [opt('a', { profit: 100000, crops: ['maize'] }), opt('b', { profit: 99500, crops: ['sorghum'] }), opt('c', { profit: 90000, crops: ['groundnut'] }), opt('d', { profit: 200000, crops: ['potato'], cost: false })];
    const allowed = Object.fromEntries(selectionCandidates(list).map((c) => [c.option.optionId, c.allowedLabels.includes(BEST_PROFIT_LABEL)]));
    expect(allowed).toEqual({ a: true, b: true, c: false, d: false });
  });

  it('a chosen plan with the best-profit signature gets the secondary label; otherwise the plan is appended; at most five options with green manure', () => {
    const pool = [opt('a', { profit: 100000, crops: ['maize', 'groundnut'] }), opt('x', { profit: 50000, crops: ['sorghum'] }), opt('y', { profit: 40000, crops: ['green-gram'] }), opt('z', { profit: 30000, crops: ['potato'] })];
    const variant = { ...opt('a2', { profit: 99000, crops: ['maize', 'groundnut'] }), label: 'Best overall' };
    const secondary = appendBestProfitOption([variant, pool[1]!, pool[2]!], pool);
    expect(secondary.options).toHaveLength(3);
    expect(secondary.options[0]).toMatchObject({ label: 'Best overall', secondaryLabels: [BEST_PROFIT_LABEL] });
    const appended = appendBestProfitOption([pool[1]!, pool[2]!, pool[3]!], pool);
    expect(appended.options).toHaveLength(4);
    expect(appended.options[3]).toMatchObject({ optionId: 'a', label: BEST_PROFIT_LABEL, origin: 'deterministic' });
    const gm = opt('g', { profit: 10000, gm: true, crops: ['sorghum'] });
    const five = appendGreenManureOption(appended.options, [gm]);
    expect(five.options.map((o) => o.label)).toEqual(['Alternative', 'Alternative', 'Alternative', BEST_PROFIT_LABEL, 'Green manure first']);
    expect(appendGreenManureOption([...five.options], [opt('g2', { profit: 1, gm: true, crops: ['maize'] })]).options).toHaveLength(5);
    expect(appendBestProfitOption([{ ...pool[1]!, label: BEST_PROFIT_LABEL }], pool).options).toHaveLength(1);
    const none = appendBestProfitOption([pool[1]!], [opt('n', { profit: null }), opt('m', { profit: 5, cost: false })]);
    expect(none.options).toHaveLength(1);
    expect(none.limitation).toContain('no Best profit plan');
  });
});

// ------------------------------------------------------------------ service and routes (test DB, real research files)
describe('round 3 year plan horizons through the service (test DB)', () => {
  let h: Harness, a: Client;
  beforeAll(async () => { data.invalidate(); h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); });
  afterAll(async () => h.close());
  const NOW = () => new Date('2026-11-01T06:00:00Z');
  const rain = (start: string, end: string) => { const out = []; for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400_000) { const d = new Date(t).toISOString().slice(0, 10); const m = Number(d.slice(5, 7)); out.push({ date: d, rainMm: m >= 6 && m <= 10 ? 6 : 0.5, et0Mm: null, tMaxC: null, tMinC: null, sourceId: 'synthetic' }); } return out; };
  const deps = (): YearPlanDeps => ({
    pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW,
    sources: { priceOutlook: async (x) => outlook(x.productId, x.harvestDate), climatology: async (_s, r) => ({ years: { from: 2016, to: 2025 }, sourceId: 'synthetic-normals', days: rain(r.start, r.end) }), neighbourhood: async () => { throw new Error('no ndvi'); } },
  });
  async function newFarm() {
    const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Round 3 QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: H, precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data as { id: string };
    const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
    return { id: f.id, auth: { ownerId: s.owner_id, sessionId: s.id } };
  }
  async function gen(d: YearPlanDeps, auth: { ownerId: string; sessionId: string }, id: string, from?: string, force = false) {
    const r = await ensureYearPlan(d, auth, id, { from, force });
    await generateYearPlan(d, r.reviewId!, auth.ownerId);
    return readYearPlan(d, auth.ownerId, id, { from });
  }

  it('from validation (route 400), three later horizons stored side by side, year 2 follows the year-1 first plan, apply on year 2', async () => {
    const d = deps();
    const { id, auth } = await newFarm();
    expect(ENGINE_VERSION).toBe('year-plan-v5-2026-11-01');
    const bad = await a.call('GET', `/api/v1/farms/${id}/year-plan?from=2020-01-01`);
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('validation_error');
    await expect(ensureYearPlan(d, auth, id, { from: '2027-01-01' })).rejects.toMatchObject({ statusCode: 400 });
    const y0 = await gen(d, auth, id);
    expect(y0.navigation).toEqual({ from: ASOF, previousFrom: null, nextFrom: '2027-11-01', yearIndex: 0, maxYearIndex: 3 });
    expect(y0.options.length).toBeGreaterThan(0);
    const blank1 = await readYearPlan(d, auth.ownerId, id, { from: '2027-11-01' });
    expect(blank1).toMatchObject({ status: 'unavailable', reviewId: null, scenario: { kind: 'future', yearIndex: 1 }, navigation: { yearIndex: 1, previousFrom: ASOF, nextFrom: '2028-11-01' } });
    const y1 = await gen(d, auth, id, '2027-11-01');
    YearPlanReview.parse(y1);
    expect(y1.scenario).toMatchObject({ kind: 'future', yearIndex: 1, currentCycleId: null, horizon: { from: '2027-11-01', to: '2028-11-01' } });
    const last0 = y0.options[0]!.slots.filter((s) => !s.fixed).at(-1)!;
    expect(y1.scenario.assumedPredecessor).toMatchObject({ basis: 'year_plan_option', cropId: last0.cropId, optionLabel: y0.options[0]!.label, horizonFrom: ASOF });
    expect(y1.summary.startsWith(`Follows the ${y0.options[0]!.label} plan for Nov 2026 to Nov 2027 (not saved yet; save a plan to fix the order).`)).toBe(true);
    expect(y1.options.every((o) => o.slots.every((s) => !s.fixed && s.sowing >= '2027-11-01'))).toBe(true);
    const y2 = await gen(d, auth, id, '2028-11-01');
    const y3 = await gen(d, auth, id, '2029-11-01');
    expect(y3.navigation).toMatchObject({ yearIndex: 3, nextFrom: null, previousFrom: '2028-11-01' });
    expect(y2.scenario.assumedPredecessor?.horizonFrom).toBe('2027-11-01');
    const stored = (await h.pool.query<{ h: string | null }>('SELECT horizon_from::text AS h FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL ORDER BY horizon_from NULLS FIRST', [id])).rows.map((r) => r.h);
    expect(stored).toEqual([null, '2027-11-01', '2028-11-01', '2029-11-01']);
    expect((await readYearPlan(d, auth.ownerId, id, { from: '2027-11-01' })).stale).toBe(false);
    // Apply on year 2.
    const before = await getWorkspace(h.pool, auth.ownerId, id);
    const o2 = y2.options[0]!;
    const applied = await applyYearPlan(d, auth.ownerId, id, { reviewId: y2.reviewId!, optionId: o2.optionId, expectedWorkspaceVersion: before.version });
    const added = applied.workspace.rotationPlans.filter((p) => p.id.startsWith(`yearplan:${y2.reviewId}:`));
    expect(added.length).toBe(o2.slots.length);
    expect(added.every((p) => (p.plannedSowingDate ?? '') >= '2028-11-01')).toBe(true);
    for (const s of o2.slots.filter((x) => x.establishmentMethod && x.kind !== 'green_manure')) expect(added.find((p) => p.plannedSowingDate === s.sowing)?.establishmentMethod).toBe(s.establishmentMethod);
    expect(applied.review).toMatchObject({ stale: false, navigation: { yearIndex: 2 } });
    expect(applied.review.appliedOptionIds).toContain(o2.optionId);
  }, 240_000);

  it('a later year goes stale when the year-1 review changes; rescore and apply an intercrop edit save kind, companion and method', async () => {
    const d = deps();
    const { id, auth } = await newFarm();
    const y0 = await gen(d, auth, id);
    const y1 = await gen(d, auth, id, '2027-11-01');
    expect(y1.stale).toBe(false);
    const y0b = await gen(d, auth, id, undefined, true);
    expect(y0b.reviewId).not.toBe(y0.reviewId);
    expect((await readYearPlan(d, auth.ownerId, id, { from: '2027-11-01' })).stale).toBe(true);
    // Intercrop edit on the current horizon (real Hassan systems).
    const c = await yearPlanContext(d, auth.ownerId, id, ASOF);
    const ic = c.set.candidates.find((x) => x.kind === 'intercrop');
    expect(ic, 'a Hassan intercrop candidate exists in the real research files').toBeTruthy();
    const base = y0b.options[0]!;
    const edited = await rescoreYearPlan(d, auth.ownerId, id, { reviewId: y0b.reviewId!, optionId: base.optionId, slots: [{ cropId: ic!.cropId, productId: ic!.productId, kind: 'intercrop', systemId: ic!.intercrop!.systemId, sowing: ic!.sowing, ...(ic!.method ? { establishmentMethod: ic!.method } : {}) }] });
    const slot = edited.slots.find((s) => !s.fixed)!;
    expect(slot).toMatchObject({ kind: 'intercrop', companion: { systemId: ic!.intercrop!.systemId } });
    const ws = await getWorkspace(h.pool, auth.ownerId, id);
    const applied = await applyYearPlan(d, auth.ownerId, id, { reviewId: y0b.reviewId!, optionId: edited.optionId, expectedWorkspaceVersion: ws.version });
    const saved = applied.workspace.rotationPlans.find((p) => p.id.startsWith(`yearplan:${y0b.reviewId}:${edited.optionId}:`))!;
    expect(saved).toMatchObject({ kind: 'intercrop', cropId: ic!.cropId, companion: { systemId: ic!.intercrop!.systemId, cropId: ic!.intercrop!.system.companionCropId, rowRatio: ic!.intercrop!.system.rowRatio } });
    if (slot.establishmentMethod) expect(saved.establishmentMethod).toBe(slot.establishmentMethod);
    expect(saved.notes).toContain('Intercrop with');
  }, 240_000);

  it('review MEDIUM-2: applying a later year keeps the earlier year current and the assumed predecessor; the next year follows the saved seasons; the chain hash ignores the day', async () => {
    const d = deps();
    const { id, auth } = await newFarm();
    const y0 = await gen(d, auth, id);
    const y1 = await gen(d, auth, id, '2027-11-01');
    expect(y1.scenario.assumedPredecessor).toMatchObject({ basis: 'year_plan_option', horizonFrom: ASOF });
    // Same field inputs on the next day: the full hash changes (prices and yields are read as of the day), the chain hash does not.
    const c0 = await yearPlanContext(d, auth.ownerId, id, ASOF, null, { candidates: false });
    const c0next = await yearPlanContext(d, auth.ownerId, id, '2026-11-02', null, { candidates: false });
    expect(c0next.hash).not.toBe(c0.hash);
    expect(c0next.chainHash).toBe(c0.chainHash);
    const ws = await getWorkspace(h.pool, auth.ownerId, id);
    const o1 = y1.options[0]!;
    const applied = await applyYearPlan(d, auth.ownerId, id, { reviewId: y1.reviewId!, optionId: o1.optionId, expectedWorkspaceVersion: ws.version });
    expect(applied.workspace.version).toBeGreaterThan(ws.version);
    expect(applied.review).toMatchObject({ reviewId: y1.reviewId, stale: false, scenario: { assumedPredecessor: { basis: 'year_plan_option', horizonFrom: ASOF } } });
    // Year 0 (the current horizon): the later-year seasons do not touch it, so it stays current.
    const r0 = await readYearPlan(d, auth.ownerId, id);
    expect(r0).toMatchObject({ reviewId: y0.reviewId, status: y0.status, stale: false });
    // Year 1: re-keyed with the predecessor it was built with, and a fresh context agrees (same hash, same predecessor).
    const r1 = await readYearPlan(d, auth.ownerId, id, { from: '2027-11-01' });
    expect(r1).toMatchObject({ reviewId: y1.reviewId, status: y1.status, stale: false });
    expect(r1.appliedOptionIds).toContain(o1.optionId);
    expect(r1.summary.startsWith('Follows the')).toBe(true);
    const c1 = await yearPlanContext(d, auth.ownerId, id, ASOF, '2027-11-01', { candidates: false });
    expect(c1.hash).toBe(r1.contextHash);
    expect(c1.ctx.scenario.assumedPredecessor).toMatchObject({ basis: 'year_plan_option', cropId: y1.scenario.assumedPredecessor!.cropId, horizonFrom: ASOF });
    expect(c1.assumedInput).toMatchObject({ reviewId: y0.reviewId });
    // Year 2: no plan yet; its previous crop is the latest-ending saved year-1 season, not an assumed plan.
    const r2 = await readYearPlan(d, auth.ownerId, id, { from: '2028-11-01' });
    expect(r2).toMatchObject({ status: 'unavailable', reviewId: null, stale: false });
    const savedY1 = applied.workspace.rotationPlans.filter((p) => p.id.startsWith(`yearplan:${y1.reviewId}:`)).sort((a, b) => (a.plannedHarvestDate ?? '').localeCompare(b.plannedHarvestDate ?? ''));
    expect(savedY1.length).toBeGreaterThan(0);
    expect(r2.scenario.assumedPredecessor).toMatchObject({ basis: 'saved_season', cropId: savedY1.at(-1)!.cropId });
  }, 240_000);

  it('review L1: the mandi watchlist reads the current-horizon plan only, never a later plan year', async () => {
    const { id, auth } = await newFarm();
    const plan = async (productIds: string[], horizonFrom: string | null) => {
      const result = { options: [{ optionId: 'o0', slots: productIds.map((productId, j) => ({ slotId: `s${j}`, productId })) }] };
      await h.pool.query("INSERT INTO farm_year_plans(owner_id,farm_id,mode,context_hash,input_versions,input_context,result,status,horizon_from) VALUES($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,$5::jsonb,'ready',$6::date)",
        [auth.ownerId, id, h.config.RUNTIME_MODE, `l1-${randomUUID()}`, JSON.stringify(result), horizonFrom]);
      await new Promise((r) => setTimeout(r, 5));
    };
    const watch = async () => { const r = await currentMandiQuotes({ pool: h.pool, config: h.config, now: NOW }, auth.ownerId, id); return { basis: r.selectionBasis, products: r.products.map((p) => p.productId) }; };
    await plan(['potato-fresh'], '2027-11-01');
    expect(await watch()).toEqual({ basis: 'none', products: [] });
    await plan(['maize-grain'], null);
    await plan(['sorghum-grain'], '2028-11-01');
    expect(await watch()).toEqual({ basis: 'recommendation_watchlist', products: ['maize-grain'] });
  });
});

// ------------------------------------------------------------------ review fixes L3 and L7 (synthetic fixtures)
describe('round 3 review fixes: intercrop figure sources (L3) and state-wide systems (L7)', () => {
  const withSystems = (...extra: Record<string, unknown>[]) => { const f = fixtures(); (f.intercropping.systems as unknown[]).push(...extra); return f; };
  afterAll(() => data.invalidate());

  it('L3: a bare-number nitrogen credit and a seed-rate share without its own source are assumed and flagged', () => {
    data.invalidate(withSystems(system('syn-bare-credit', { nitrogenCreditKgPerHa: 25 }), system('syn-unsourced-seed', { seedRateShare: { main: 1, companion: 0.25 } })));
    expect(data.intercropSystem('syn-bare-credit')!.nitrogenCredit).toEqual({ min: 25, max: 25, source: null, sourced: false });
    expect(data.intercropSystem('syn-sorghum-greengram-credit')!.nitrogenCredit).toMatchObject({ source: 'SYN-IC', sourced: true });
    expect(data.intercropSystem('syn-unsourced-seed')!.seedRateShare).toEqual({ main: 1, companion: 0.25, source: null, sourced: false });
    expect(data.intercropSystem('syn-sorghum-greengram-4-1')!.seedRateShare).toMatchObject({ companion: 0.25, sourced: true });
    const ctx = buildScenario(fresh());
    const set = enumerateCandidates(ctx).candidates;
    const bare = find(set, (c) => c.intercrop?.systemId === 'syn-bare-credit');
    expect(predecessorOf(ctx, [bare], '2028-01-01')).toBe('sorghum');
    const be = evaluateSlot(ctx, inputsFor(ctx, [bare]), bare, { maxMarginRate: 1e9 });
    expect(be.uncertainties.join(' ')).toContain('nitrogen credit of 25 kg/ha has no source of its own');
    const seed = find(set, (c) => c.intercrop?.systemId === 'syn-unsourced-seed' && c.sowing === '2027-06-01');
    const se = evaluateSlot(ctx, inputsFor(ctx, [seed]), seed, { maxMarginRate: 1e9 });
    expect(se.codes).toContain('intercrop_cost_assumed');
    expect(se.companion).toMatchObject({ combinedCostPerHa: 30000 + 25000 * 0.25, costAssumed: true });
    expect(se.uncertainties.join(' ')).toContain('seed-rate share without its own source, assumed');
    const sourced = find(set, (c) => c.intercrop?.systemId === 'syn-sorghum-greengram-4-1' && c.sowing === '2027-06-01');
    expect(evaluateSlot(ctx, inputsFor(ctx, [sourced]), sourced, { maxMarginRate: 1e9 }).codes).not.toContain('intercrop_cost_assumed');
  });

  it('L7: a state-wide system whose notes name a command area or district says so on the slot; district systems do not', () => {
    data.invalidate(withSystems(system('syn-bhadra', { regions: ['IN-KA'], notes: ['Trial in the Bhadra Command area (irrigated).'] }), system('syn-salem', { regions: ['IN-KA'], notes: ['Farm trial, Thalaivasal block, Salem district.'] })));
    expect(data.intercropSystem('syn-bhadra')!.localityNote).toBe('Bhadra Command area');
    expect(data.intercropSystem('syn-salem')!.localityNote).toBe('Salem district');
    expect(data.intercropSystem('syn-sorghum-greengram-4-1')!.localityNote).toBeNull();
    const ctx = buildScenario(fresh());
    const set = enumerateCandidates(ctx).candidates;
    const slotOf = (id: string) => find(set, (x) => x.intercrop?.systemId === id && x.sowing === '2027-06-01');
    const ev = (id: string) => { const c = slotOf(id); return evaluateSlot(ctx, inputsFor(ctx, [c]), c, { maxMarginRate: 1e9 }); };
    expect(ev('syn-bhadra').uncertainties).toContain('System reported for Bhadra Command area in the state, not this district.');
    expect(ev('syn-salem').uncertainties).toContain('System reported for Salem district in the state, not this district.');
    expect(ev('syn-sorghum-greengram-4-1').uncertainties.join(' ')).not.toContain('System reported for');
    const [o] = scoreSequences(ctx, [{ sequenceId: 'bhadra', slots: [slotOf('syn-bhadra')] }], inputsFor(ctx, [slotOf('syn-bhadra')]));
    expect(o!.slots[0]!.uncertainties).toContain('System reported for Bhadra Command area in the state, not this district.');
    data.invalidate();
    expect(data.intercropSystem('ka-bhadra-maize-greengram-1-1')!.localityNote).toBe('Bhadra Command area');
    expect(data.intercropSystem('ka-bhadra-maize-blackgram-2-2')!.localityNote).toBe('Bhadra Command area');
    expect(data.intercropSystem('ka-hassan-ragi-blackgram-4-1')!.localityNote).toBeNull();
  });
});
