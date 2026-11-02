import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CarbonFootprint, EnergyFootprint, HarvestEconomics, ResidueIncome, type HarvestPriceOutlook} from '@harvest/contracts';
import * as fdata from '../src/services/today/footprint-data';
import {AIR_DRY, FOOTPRINT_ASSUMPTIONS, PLANT_PRICE_LIMITATION, PLANT_PRICE_NOTE, RPR_DERIVED, UREA_CO2_LIMITATION, carbonFootprint, energyFootprint, irrigationCategoryOf, isPartialDose, residueIncome, type FootprintInput} from '../src/services/today/footprint';
import {NO_OVERRIDE, harvestEconomics, sowingSeason, type HarvestEconomicsInput} from '../src/services/today/economics';
import {estimateProfit} from '../src/services/estimate';
import {buildScenario, collectInputKeys, data, emptyInputs, evaluateSlot, priceHarvestDate, slotPriceKey} from '../src/services/year-plan';

/**
 * Today economics and footprint tests (TODAY_ECONOMICS_FOOTPRINT_SPEC.md sections 1 to 4). Every residue ratio, surplus share,
 * price, calorific value, emission factor, nitrogen rate, energy figure, yield, cost and mandi price below is an INVENTED
 * SYNTHETIC fixture of the section 5 shape (and of the year-plan file shapes), injected through invalidate(fixtures); none is a
 * research value, an IPCC table value or a market observation. Expected numbers are hand-computed in the comments.
 * Pure: no database, network or model call.
 */
const H = 'IN-KA-hassan';
const TODAY = '2026-11-02';
const AREA = 1.2;

// ------------------------------------------------------------------ footprint fixture (section 5 shape, invented numbers)

const range = (low: number, high: number, sourceId = 'SYN-FP', extra: Record<string, unknown> = {}) => ({low, high, sourceId, locator: 'Table S1', ...extra});
const f3 = (low: number, central: number, high: number) => ({low, central, high});
const FOOTPRINT = {
  generatedAt: '2026-11-02', purpose: 'synthetic test fixture', status: 'research_candidate_unreviewed', unknownTopLevel: {tolerated: true},
  conventions: {nulls: 'A missing value means no cited figure was found; it never means zero.'},
  constants: {
    gwp100: {ch4: 27, n2o: 273, sourceId: 'SYN-GWP', note: 'CH4 non-fossil'},
    n2oNToN2o: {value: 1.5714, note: '44/28'},
    cToCo2: {value: 3.6667, note: '44/12'},
    biomassCarbonFraction: range(0.47, 0.47, 'SYN-IPCC'),
    riceMethaneBaselineKgPerHaDay: {low: 0.8, central: 1.19, high: 2.2, sourceId: 'SYN-IPCC', locator: 'Table 5.11'},
    riceWaterRegimeScaling: {
      continuouslyFlooded: f3(0.73, 1, 1.27), singleDrainage: f3(0.57, 0.71, 0.85), multipleDrainage: f3(0.46, 0.55, 0.64),
      rainfedRegular: f3(0.39, 0.54, 0.73), rainfedDroughtProne: f3(0.11, 0.16, 0.24), sourceId: 'SYN-IPCC', locator: 'Table 5.12',
    },
    ricePreSeasonStrawScaling: {none: f3(1, 1, 1), strawShortBefore: f3(1.5, 1.8, 2), strawLongBefore: f3(1.1, 1.2, 1.3), sourceId: 'SYN-IPCC', locator: 'Table 5.14'},
    n2oEf1: {default: f3(0.002, 0.01, 0.018), floodedRice: f3(0.001, 0.004, 0.029), sourceId: 'SYN-IPCC', locator: 'Table 11.1'},
    residueBurning: {ch4GPerKgDm: 2.7, n2oGPerKgDm: 0.07, combustionFactor: {low: 0.8, high: 0.9}, sourceId: 'SYN-IPCC', locator: 'Table 2.5'},
    dieselKgCo2PerLitre: {value: 2.68, sourceId: 'SYN-IPCC', locator: 'Table 3.3.1'},
    ureaManufactureKgCo2ePerKgN: {low: null, high: null, sourceId: null, note: 'null when not sourced'},
    lpgMjPerKg: {value: 45.8, sourceId: 'SYN-LPG', locator: 'p 2'},
    lpgCylinderKg: {value: 14.2, sourceId: 'SYN-LPG', locator: 'p 1'},
    dieselMjPerLitre: {value: 36, sourceId: 'SYN-LPG', locator: 'p 3'},
    methaneKgPerM3: {value: 0.716, sourceId: 'SYN-LPG', locator: 'p 4'},
    cbgMethaneShare: {low: 0.9, high: 0.95, sourceId: 'SYN-CBG', note: 'CBG purity'},
  },
  crops: [
    {
      cropId: 'paddy',
      residue: {
        name: 'paddy straw', productBasis: 'paddy-grain', rpr: range(1.3, 1.5, 'SYN-RPR', {note: 'dry basis'}),
        surplusFraction: [range(0.25, 0.35, 'SYN-RPR', {region: 'IN'}), range(0.2, 0.3, 'SYN-RPR', {region: 'IN-KA'})],
        calorificValueMJPerKg: range(14, 15.5, 'SYN-CV'),
        biogasM3PerTonneDm: {...range(200, 300, 'SYN-BG'), methaneShare: {low: 0.5, high: 0.6}},
        uses: [
          {use: 'cbg_feedstock', label: 'Biomass for compressed biogas', share: null, priceInrPerTonne: range(1500, 2500, 'SYN-PRICE'), priceBasis: 'Synthetic: straw delivered to a CBG plant, 2024', sourceId: 'SYN-PRICE', locator: 'para 3'},
          {use: 'dry_fodder', label: 'Dry fodder for cattle', share: null, priceInrPerTonne: range(3000, 5000, 'SYN-PRICE'), priceBasis: 'Synthetic: fodder market, 2025', sourceId: 'SYN-PRICE', locator: 'para 4'},
          {use: 'mushroom_substrate', label: 'Mushroom beds', share: 0.1, priceInrPerTonne: null, priceBasis: null, sourceId: 'SYN-PRICE', locator: 'para 5'},
        ],
      },
      nitrogenRateKgPerHa: [range(100, 100, 'SYN-POP', {region: 'IN-KA', note: 'irrigated paddy 100:50:50'}), range(150, 150, 'SYN-POP', {region: 'IN-TN'})],
      energyInput: {gjPerHa: {low: 15, high: 25}, region: 'Synthetic state', year: '2020', sourceId: 'SYN-EN', locator: 'Table 2', breakdown: [{item: 'fertiliser', share: 0.4}, {item: 'diesel', share: 0.3}], dieselLitresPerHa: {low: 50, high: 70}},
      methane: {applies: true, note: 'flooded rice'},
      notes: ['synthetic'],
    },
    {
      cropId: 'finger-millet', residue: null, methane: {applies: false},
      nitrogenRateKgPerHa: [range(50, 50, 'SYN-POP', {region: 'IN-KA'})], energyInput: null, notes: [],
    },
    {
      cropId: 'maize',
      residue: {
        name: 'maize stover', productBasis: 'maize-grain', rpr: range(1.5, 2, 'SYN-RPR'), surplusFraction: [range(0.3, 0.4, 'SYN-RPR', {region: 'IN'})],
        calorificValueMJPerKg: null, biogasM3PerTonneDm: null,
        uses: [{use: 'dry_fodder', label: 'Dry fodder for cattle', share: null, priceInrPerTonne: range(2000, 3000, 'SYN-PRICE'), priceBasis: 'Synthetic: fodder market, 2025', sourceId: 'SYN-PRICE', locator: 'para 6'}],
      },
      nitrogenRateKgPerHa: [range(150, 150, 'SYN-POP', {region: 'IN-KA'})], energyInput: {gjPerHa: {low: 20, high: 30}, region: 'Synthetic', year: 2019, sourceId: 'SYN-EN', locator: 'Table 3', breakdown: [], dieselLitresPerHa: null},
      methane: {applies: false}, notes: [],
    },
    {cropId: 'groundnut', residue: {name: 'groundnut haulm', productBasis: 'groundnut-pod', rpr: range(2, 2.3, 'SYN-RPR'), surplusFraction: [], calorificValueMJPerKg: null, biogasM3PerTonneDm: null, uses: []}, nitrogenRateKgPerHa: [], energyInput: null, methane: {applies: false}, notes: []},
    {cropId: 'cotton', residue: {name: 'cotton stalk', productBasis: 'cotton-kapas', rpr: range(3, 3.5, 'SYN-RPR'), surplusFraction: [], calorificValueMJPerKg: null, biogasM3PerTonneDm: null, uses: []}, nitrogenRateKgPerHa: [], energyInput: null, methane: {applies: false}, notes: []},
    {residue: {name: 'no crop id'}, nitrogenRateKgPerHa: []}, // malformed: no cropId -> skipped and recorded
    {cropId: 'sorghum', residue: {name: 'sorghum stover', productBasis: 'sorghum-grain', rpr: {low: 'two', high: 2}}, nitrogenRateKgPerHa: []}, // malformed residue -> ignored and recorded
  ],
  sources: {
    'SYN-RPR': {url: 'https://example.org/synthetic-rpr', title: 'Synthetic residue ratio fixture', publisher: 'Test', retrievedAt: '2026-11-02'},
    'SYN-IPCC': {url: 'https://example.org/synthetic-ipcc', title: 'Synthetic emission factor fixture', publisher: 'Test', retrievedAt: '2026-11-02'},
    'SYN-GWP': {url: 'https://example.org/synthetic-gwp', title: 'Synthetic GWP fixture', publisher: 'Test', retrievedAt: '2026-11-02'},
  },
  failedSources: [],
};

// ------------------------------------------------------------------ year-plan fixture (yields, costs, durations; invented)

const SRC = 'SYN-AG';
const crop = (cropId: string, productIds: string[], durationDays: unknown[], sowingWindows: unknown[] = []) => ({
  cropId, family: 'Poaceae', productIds, rotationRole: {value: 'moderate_feeder', method: 'rule_v1', sources: [SRC]}, nitrogenCreditKgPerHa: null,
  waterNeedMm: {min: 500, max: 700, source: `${SRC} water`}, rainfedSuitable: true, durationDays, stages: [], sowingWindows,
  recommendedPredecessors: [], recommendedSuccessors: [], avoidAfter: [], sources: [],
});
const dur = (min: number, max: number) => ({method: 'any', cultivar: 'Synthetic cultivar (KA)', min, max, source: `${SRC} durations`});
const y = (cropYear: string, v: number, region = 'IN-KA') => ({region, level: 'state', season: 'Kharif', cropYear, yieldKgPerHa: v, basis: 'main product as published', sourceId: 'syn-des'});
const NO_LOSS = {value: null, sourceId: null, note: 'not researched'};
const desCost = (a2fl: number, c2: number) => ({region: 'IN-KA', year: '2023-24', a2flPerHa: a2fl, c2PerHa: c2, authority: 'des', sourceId: 'syn-des', locator: 'Annex'});
const YEAR_PLAN = {
  agronomy: {
    sourceCatalog: [{id: SRC, url: 'https://example.org/synthetic-agronomy', title: 'Synthetic agronomy fixture'}],
    crops: [
      crop('paddy', ['paddy-grain'], [dur(110, 120)], [{region: H, season: 'kharif', from: '07-01', to: '07-31', condition: 'any', source: `${SRC} windows`}]),
      crop('finger-millet', ['finger-millet-grain'], [dur(100, 110)]),
      crop('maize', ['maize-grain'], [dur(100, 110)]),
      crop('sesame', ['sesame-seed'], [dur(80, 90)]),
    ],
  },
  pool: {pool: ['paddy', 'finger-millet', 'maize', 'sesame', 'groundnut', 'cotton'].map((cropId) => ({cropId, productIds: [`${cropId}-grain`], why: 'synthetic'}))},
  yieldCost: {
    crops: [
      // Paddy (paddy-grain, main form): 4000, 4400, 4800 -> p50 4400, P25 4200, P75 4600 kg/ha (type-7 quantiles of three years).
      {cropId: 'paddy', yields: [y('2022-23', 4000), y('2023-24', 4400), y('2024-25', 4800)], costs: [desCost(70000, 90000)], postHarvestLossPct: NO_LOSS},
      {cropId: 'finger-millet', yields: [y('2022-23', 1400), y('2023-24', 1500)], costs: [desCost(50000, 60000)], postHarvestLossPct: NO_LOSS},
      // Sesame: one year only (reference, no spread) and no cost row.
      {cropId: 'sesame', yields: [y('2023-24', 500)], costs: [], postHarvestLossPct: {value: 5, sourceId: 'syn-loss', note: 'synthetic'}},
      {cropId: 'maize', yields: [y('2022-23', 3000), y('2023-24', 3400), y('2024-25', 3200)], costs: [desCost(50000, 70000)], postHarvestLossPct: NO_LOSS},
    ],
    sources: {'syn-des': {url: 'https://example.org/synthetic-des', title: 'Synthetic DES fixture'}},
    conversions: {},
  },
  greenManure: {crops: []},
};

function outlook(p: {p25: number; p50: number; p75: number} | null, harvestDate = '2026-11-25'): HarvestPriceOutlook {
  return {
    productId: 'paddy-grain', status: p ? 'available' : 'insufficient', missingReason: p ? null : 'price_history_insufficient',
    scope: {level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null},
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic mandi reference', limitations: [], method: 'B_seasonal_reference/pooled-v1',
    harvestDate, harvestWeek: {year: 2026, week: 48}, asOf: TODAY, weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], yearsUsed: p ? [2023, 2024, 2025] : [2025], perYear: [],
    p10: p ? p.p25 - 2 : null, p25: p?.p25 ?? null, p50: p?.p50 ?? null, p75: p?.p75 ?? null, p90: p ? p.p75 + 2 : null, annualMean: p?.p50 ?? null, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  };
}
const PRICE = {p25: 18, p50: 22, p75: 26};
const econ = (over: Partial<HarvestEconomicsInput> = {}, cycle: Partial<HarvestEconomicsInput['cycle']> = {}): HarvestEconomics => HarvestEconomics.parse(harvestEconomics({
  cycle: {id: 'cycle-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-07-20', ...cycle},
  farm: {stateId: 'IN-KA', districtId: H, areaHa: AREA}, harvest: {earliest: '2026-11-20', latest: '2026-11-30'}, harvestDate: '2026-11-25',
  headline: outlook(PRICE), priceScopeLabel: '3 years of Karnataka mandi prices (state pool, 3 markets)', priceMissingText: null, today: TODAY, ...over,
}));

const PADDY: FootprintInput = {
  cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', stateId: 'IN-KA', districtId: H, areaHa: AREA,
  yieldForFieldKg: {low: 5040, high: 5520}, irrigationCategory: 'irrigated', seasonDays: 100,
};
const fp = (over: Partial<FootprintInput> = {}) => ({...PADDY, ...over});

beforeEach(() => { fdata.invalidate(structuredClone(FOOTPRINT)); data.invalidate(structuredClone(YEAR_PLAN) as never); });
afterEach(() => { fdata.invalidate(); data.invalidate(); });
afterAll(() => { fdata.invalidate(); data.invalidate(); });

/** Every digit run of the summary appears, as printed, among the block's numbers (the index-stage digit rule). */
function digitsTraceable(c: CarbonFootprint) {
  const nums = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') nums.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'summary' && k !== 'limitations' && k !== 'basis' && k !== 'method' && k !== 'note') walk(x);
  };
  walk(c);
  for (const run of c.summary.match(/\d+(?:\.\d+)?/g) ?? []) expect(nums, `digit run ${run} in "${c.summary}"`).toContain(run);
}

// ------------------------------------------------------------------ loader

describe('footprint data loader (tolerant, cached, nothing invented)', () => {
  it('skips a malformed crop row and a malformed nested residue, records both, and ignores unknown fields', () => {
    const crops = fdata.footprintCrops().map((c) => c.cropId);
    expect(crops).toEqual(['paddy', 'finger-millet', 'maize', 'groundnut', 'cotton', 'sorghum']);
    expect(fdata.footprintCrop('sorghum')!.residue).toBeNull();
    const issues = fdata.loadIssues();
    expect(issues.some((s) => /^crops\[5\] skipped: cropId/.test(s))).toBe(true);
    expect(issues.some((s) => /^residue ignored: rpr\.low/.test(s))).toBe(true);
    // A figure recorded with null values is a documented gap: null, and not a load issue.
    expect(fdata.footprintConstants().ureaManufactureKgCo2ePerKgN).toBeNull();
    expect(issues.some((s) => /ureaManufacture/.test(s))).toBe(false);
    expect(fdata.footprintConstants().residueCarbonRetentionFraction).toBeNull();
    expect(fdata.footprintSource('SYN-RPR')).toMatchObject({url: 'https://example.org/synthetic-rpr', title: 'Synthetic residue ratio fixture'});
  });

  it('a top level that is not the section 5 shape throws (the view turns that into null blocks)', () => {
    fdata.invalidate('not an object');
    expect(() => fdata.loadFootprint()).toThrow();
    expect(() => residueIncome(PADDY)).toThrow();
  });
});

// ------------------------------------------------------------------ harvest economics

describe('harvest economics (section 1)', () => {
  it('paddy on 1.2 ha: yield band x field area, price headline, A2+FL cost, available with field figures', () => {
    const e = econ();
    expect(e).toMatchObject({status: 'available', reason: null, harvestDate: '2026-11-25', fieldAreaHa: 1.2, yieldBasis: 'state', keepFraction: 1});
    expect(e.yieldKgPerHa).toEqual({low: 4200, high: 4600});
    expect(e.yieldForFieldKg).toEqual({low: 5040, high: 5520}); // 4200 x 1.2, 4600 x 1.2
    expect(e.price).toEqual({status: 'available', unit: 'INR/kg', p50: 22, likely: {low: 18, high: 26}, scopeLabel: '3 years of Karnataka mandi prices (state pool, 3 markets)'});
    expect(e.cost).toMatchObject({a2flPerHa: 70000, authority: 'des'});
    // Revenue median 4400 x 22 = 96,800/ha; profit median = 96,800 - 70,000 = 26,800/ha (within the Rs 100 rounding).
    expect(Math.abs(e.revenuePerHa!.central - 96800)).toBeLessThanOrEqual(200);
    expect(Math.abs(e.profitPerHa!.central - 26800)).toBeLessThanOrEqual(200);
    expect(Math.abs(e.profitForField!.central - 26800 * 1.2)).toBeLessThanOrEqual(300);
    expect(e.basis.map((b) => b.kind)).toEqual(['yield_reference', 'price_history', 'cost_reference', 'model']);
    expect(e.limitations).toContain('Regional reference yield and cost, not this field\'s; the price is a seasonal reference of past years, not a forecast.');
    expect(e.limitations.join(' ')).toMatch(/No post-harvest loss share is sourced/);
  });

  it('equals the year plan: the fixed slot of the same paddy cycle gives the same field profit for the same yield, price, keep, cost and area', () => {
    const cycle = {id: 'cycle-same', cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', sowingDate: '2026-07-10', establishmentDate: '2026-07-10', stage: 'growing' as const};
    const ctx = buildScenario({
      workspace: {previousHarvest: {status: 'unknown'}, cycles: [cycle], rotationPlans: []} as never,
      farm: {location: {stateCode: 'IN-KA', districtId: H}, areaHectares: AREA, facts: {}}, asOf: TODAY,
    });
    const slot = ctx.fixedSlot!;
    const inputs = emptyInputs(TODAY, null);
    for (const k of collectInputKeys([slot])) inputs.priceOutlooks.set(k.key, outlook(PRICE, k.harvestDate));
    const plan = evaluateSlot(ctx, inputs, slot, {maxMarginRate: null});
    const e = econ({harvest: slot.harvest, harvestDate: priceHarvestDate(slot.harvest), headline: inputs.priceOutlooks.get(slotPriceKey(slot))!}, {id: cycle.id, sowingDate: cycle.sowingDate});
    expect(plan.estimate.profitForField).not.toBeNull();
    expect(e.profitForField).toEqual(plan.estimate.profitForField);
    expect(e.revenueForField).toEqual(plan.estimate.revenueForField);
    expect(e.profitPerHa).toEqual(plan.estimate.profitPerHa);
    // The same as estimateProfit on the fixed slot's inputs.
    const direct = estimateProfit({seed: slot.key, yieldKgPerHa: {p25: 4200, p50: 4400, p75: 4600}, pricePerKg: {p25: 18, p50: 22, p75: 26}, keep: 1, costPerHa: 70000, areaHa: AREA});
    expect(e.profitForField).toEqual(direct.profitForField);
  });

  it('status and reason: no product, no yield row, no area, no price, no cost, single-year yield', () => {
    expect(econ({}, {productId: null})).toMatchObject({status: 'unavailable', reason: 'no_product_recorded', revenuePerHa: null, profitForField: null});
    const noYield = econ({}, {cropId: 'cotton', productId: 'cotton-kapas'});
    expect(noYield).toMatchObject({status: 'unavailable', reason: 'yield_not_sourced', yieldKgPerHa: null});
    expect(noYield.limitations.join(' ')).toMatch(/No cotton yield rows are sourced for this state/);
    const noArea = econ({farm: {stateId: 'IN-KA', districtId: H, areaHa: null}});
    expect(noArea).toMatchObject({status: 'available', fieldAreaHa: null, yieldForFieldKg: null, profitForField: null, revenueForField: null});
    expect(noArea.profitPerHa).not.toBeNull();
    expect(noArea.limitations).toContain('No field area is recorded, so the figures are per hectare only.');
    const noPrice = econ({headline: outlook(null), priceMissingText: 'too few years with quotes in the harvest weeks'});
    expect(noPrice).toMatchObject({status: 'unavailable', reason: 'price_insufficient', revenuePerHa: null, profitPerHa: null, price: {status: 'insufficient', p50: null}});
    expect(noPrice.limitations).toContain('Harvest price: too few years with quotes in the harvest weeks.');
    expect(noPrice.yieldForFieldKg).toEqual({low: 5040, high: 5520}); // the yield is still a sourced fact
    expect(econ({harvest: null, harvestDate: null, headline: null})).toMatchObject({status: 'unavailable', reason: 'harvest_window_unknown'});
    const noCost = econ({}, {cropId: 'sesame', productId: 'sesame-seed'});
    expect(noCost).toMatchObject({status: 'partial', reason: null, cost: null, profitPerHa: null, profitForField: null, keepFraction: 0.95, yieldBasis: 'reference'});
    expect(noCost.revenuePerHa).not.toBeNull();
    expect(noCost.limitations).toContain('No cost-of-cultivation row is sourced for this crop in this state.');
    expect(noCost.limitations.join(' ')).toMatch(/assumes a yield spread \(sigma 0\.15\)/);
    expect(noCost.basis.map((b) => b.sourceId)).toContain('year-plan-assumption:singleYearYieldSigma');
  });
});

// ------------------------------------------------------------------ residue income

describe('residue income (section 2)', () => {
  it('paddy on 1.2 ha: residue, Karnataka surplus, option incomes as alternatives', () => {
    const r = ResidueIncome.parse(residueIncome(PADDY));
    expect(r).toMatchObject({status: 'available', reason: null, residueName: 'paddy straw', residueToProductRatio: {low: 1.3, high: 1.5}, surplusFraction: {low: 0.2, high: 0.3}});
    // Residue = yield for the field x RPR: 5040 x 1.3 = 6552 kg, 5520 x 1.5 = 8280 kg dry matter.
    expect(r.residueForFieldKg).toEqual({low: 6552, high: 8280});
    // Surplus = residue x the IN-KA share (the state figure wins over IN): 6552 x 0.2 = 1310.4 -> 1310, 8280 x 0.3 = 2484.
    expect(r.surplusForFieldKg).toEqual({low: 1310, high: 2484});
    const [cbg, fodder, mushroom] = r.options;
    expect(cbg).toMatchObject({use: 'cbg_feedstock', quantityKg: {low: 1310, high: 2484}, priceInrPerTonne: {low: 1500, high: 2500}});
    // CBG income = 1.3104 t x Rs 1500 = 1965.6 -> Rs 1970; 2.484 t x Rs 2500 = 6210.
    expect(cbg!.incomeForField).toEqual({low: 1970, high: 6210});
    // Fodder income = 1.3104 x 3000 = 3931.2 -> 3930; 2.484 x 5000 = 12420.
    expect(fodder!.incomeForField).toEqual({low: 3930, high: 12420});
    // Mushroom beds take a printed 10 % share: 131.04 -> 131 kg, 248.4 -> 248 kg; no price, no income.
    expect(mushroom).toMatchObject({quantityKg: {low: 131, high: 248}, priceInrPerTonne: null, incomeForField: null});
    expect(r.basis.filter((b) => b.kind === 'residue_reference').map((b) => b.label.split(' ')[0])).toEqual(['Residue-to-product', 'Surplus']);
    expect(r.basis.filter((b) => b.kind === 'price_history')).toHaveLength(2);
    expect(r.limitations).toContain('Options are alternatives for the same residue and do not add up.');
    expect(r.limitations).toContain('Prices are reported figures from the named place and date, not local quotes; transport to a plant is not deducted.');
    // Never summed: no number in the block equals the sum of two option incomes.
    const all = JSON.stringify(r);
    for (const sum of [1970 + 3930, 6210 + 12420]) expect(all).not.toContain(String(sum));
  });

  it('India surplus fallback and whole-residue fallback are flagged as engine assumptions', () => {
    const maize = residueIncome(fp({cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    expect(maize.surplusFraction).toEqual({low: 0.3, high: 0.4});
    expect(maize.limitations).toContain(FOOTPRINT_ASSUMPTIONS.indiaSurplusFallback.text);
    expect(maize.basis.map((b) => b.sourceId)).toContain('today-footprint-assumption:indiaSurplusFallback');
    const tn = residueIncome(fp({stateId: 'IN-TN', districtId: null}));
    expect(tn.surplusFraction).toEqual({low: 0.25, high: 0.35}); // no IN-TN row: the IN figure
  });

  it('status and reason: no product, no area or yield, basis mismatch, residue not sourced, crop without a row, not traded', () => {
    expect(residueIncome(fp({productId: null}))).toMatchObject({status: 'unavailable', reason: 'no_product_recorded', options: []});
    expect(residueIncome(fp({areaHa: null}))).toMatchObject({status: 'unavailable', reason: 'yield_or_area_missing'});
    expect(residueIncome(fp({yieldForFieldKg: null}))).toMatchObject({status: 'unavailable', reason: 'yield_or_area_missing'});
    expect(residueIncome(fp({cropId: 'groundnut', productId: 'groundnut-kernel'}))).toMatchObject({status: 'unavailable', reason: 'residue_basis_mismatch', residueName: 'groundnut haulm'});
    expect(residueIncome(fp({cropId: 'finger-millet', productId: 'finger-millet-grain'}))).toMatchObject({status: 'unavailable', reason: 'residue_not_sourced'});
    const none = ResidueIncome.parse(residueIncome(fp({cropId: 'sesame', productId: 'sesame-seed'})));
    expect(none).toMatchObject({status: 'unavailable', reason: 'crop_not_in_footprint_data', residueForFieldKg: null});
    expect(none.limitations[0]).toBe('No residue, energy or emission figure is sourced for this crop.');
    const cotton = ResidueIncome.parse(residueIncome(fp({cropId: 'cotton', productId: 'cotton-kapas', yieldForFieldKg: {low: 1000, high: 1200}})));
    expect(cotton).toMatchObject({status: 'unavailable', reason: 'residue_not_traded', options: [], residueForFieldKg: {low: 3000, high: 4200}, surplusFraction: null});
    expect(cotton.limitations).toContain(FOOTPRINT_ASSUMPTIONS.wholeResidueFallback.text);
  });
});

// ------------------------------------------------------------------ energy

describe('energy footprint (section 4)', () => {
  it('paddy: input energy from the study x area, residue energy and the LPG equivalent', () => {
    const e = EnergyFootprint.parse(energyFootprint(PADDY));
    expect(e).toMatchObject({status: 'available', reason: null, inputEnergyGJPerHa: {low: 15, high: 25}, calorificValueMJPerKg: {low: 14, high: 15.5}});
    expect(e.inputEnergyGJForField).toEqual({low: 18, high: 30}); // 15 x 1.2, 25 x 1.2
    expect(e.inputBreakdown).toEqual([{item: 'fertiliser', share: 0.4}, {item: 'diesel', share: 0.3}]);
    // Residue energy = surplus x CV / 1000: 1310.4 x 14 = 18,345.6 MJ -> 18.35 GJ; 2484 x 15.5 = 38,502 MJ -> 38.5 GJ.
    expect(e.residueEnergyGJForField).toEqual({low: 18.35, high: 38.5});
    // LPG: one cylinder = 14.2 kg x 45.8 MJ/kg = 650.36 MJ; 18,345.6 / 650.36 = 28.21 -> 28.2; 38,502 / 650.36 = 59.20 -> 59.2.
    const lpg = e.equivalents.find((q) => q.unit === 'cylinders')!;
    expect(lpg.amount).toEqual({low: 28.2, high: 59.2});
    expect(lpg.sourceIds).toEqual(['SYN-LPG', 'SYN-CV']);
    // Methane in biogas: 1.3104 t x 200 m3 x 0.5 x 0.716 = 93.82 -> 94 kg; 2.484 x 300 x 0.6 x 0.716 = 320.14 -> 320 kg.
    expect(e.equivalents.find((q) => q.unit === 'kg CH₄')!.amount).toEqual({low: 94, high: 320});
    expect(e.basis.find((b) => b.label.startsWith('Energy-use study'))!.kind).toBe('energy_reference');
    expect(e.limitations).toContain('Input energy is a published study average for the crop and region, not this field\'s use.');
  });

  it('partial without a calorific value or a study; unavailable without either', () => {
    const maize = energyFootprint(fp({cropId: 'maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    expect(maize).toMatchObject({status: 'partial', reason: 'calorific_value_not_sourced', residueEnergyGJForField: null, inputEnergyGJForField: {low: 24, high: 36}});
    expect(energyFootprint(fp({cropId: 'cotton', productId: 'cotton-kapas'}))).toMatchObject({status: 'unavailable', reason: 'energy_study_not_sourced'});
    expect(energyFootprint(fp({cropId: 'sesame'}))).toMatchObject({status: 'unavailable', reason: 'crop_not_in_footprint_data'});
  });
});

// ------------------------------------------------------------------ carbon

describe('carbon footprint (section 4)', () => {
  it('paddy on 1.2 ha, irrigated, 100 days: methane, N2O and diesel terms, burn and incorporate scenarios', () => {
    const c = CarbonFootprint.parse(carbonFootprint(PADDY));
    expect(c).toMatchObject({status: 'available', reason: null, fieldAreaHa: 1.2, seasonDays: 100, gwp: {ch4: 27, n2o: 273}});
    const term = (s: string) => c.terms.find((t) => t.source === s)!;
    // Methane: irrigated -> SF_w 0.57 (single drainage low) to 1.27 (continuously flooded high); straw 1 to 2.
    // kg CH4/ha = 0.8 x 0.57 x 1 x 100 = 45.6 and 2.2 x 1.27 x 2 x 100 = 558.8; x 27 / 1000 = 1.2312 and 15.0876 t/ha;
    // x 1.2 ha = 1.47744 -> 1.48 and 18.10512 -> 18.11 t.
    expect(term('rice_methane')).toMatchObject({kind: 'baseline', tCO2ePerHa: {low: 1.23, high: 15.09}, tCO2eForField: {low: 1.48, high: 18.11}});
    // N2O: 100 kg N x EF1 flooded rice 0.001 to 0.029 x 1.5714 x 273 / 1000 = 0.0429 and 1.2441 t/ha; x 1.2 = 0.0515 -> 0.05, 1.4929 -> 1.49.
    expect(term('fertiliser_n2o')).toMatchObject({kind: 'baseline', tCO2ePerHa: {low: 0.04, high: 1.24}, tCO2eForField: {low: 0.05, high: 1.49}});
    // Diesel: 50 to 70 l/ha x 2.68 / 1000 = 0.134 and 0.1876 t/ha; x 1.2 = 0.1608 -> 0.16, 0.22512 -> 0.23.
    expect(term('fuel_and_machinery')).toMatchObject({tCO2eForField: {low: 0.16, high: 0.23}});
    expect(c.terms.some((t) => t.source === 'fertiliser_manufacture')).toBe(false); // urea factor not sourced
    expect(c.limitations.join(' ')).toMatch(/Emissions from making the fertiliser are not included/);
    // Baseline per ha = 1.2312 + 0.04289922 + 0.134 = 1.40810 and 15.0876 + 1.24407738 + 0.1876 = 16.51928; x 1.2 = 1.68972 and 19.82313.
    expect(c.emissionsPerHa).toEqual({low: 1.41, high: 16.52});
    expect(c.emissionsForField).toEqual({low: 1.69, high: 19.82});
    // Burn: whole residue 6552 to 8280 kg x CF 0.8 to 0.9 = 5241.6 and 7452 kg burnt; x (2.7 x 27 + 0.07 x 273 = 92.01 g CO2e/kg) / 1e6
    // = 0.48228 -> 0.48 and 0.68566 -> 0.69 t. Net = 1.68972 + 0.48228 = 2.172 -> 2.17; 19.82313 + 0.68566 = 20.50879 -> 20.51.
    expect(term('residue_burning')).toMatchObject({kind: 'scenario', tCO2eForField: {low: 0.48, high: 0.69}});
    const scen = (id: string) => c.residueScenarios.find((s) => s.id === id)!;
    expect(scen('burn').netForField).toEqual({low: 2.17, high: 20.51});
    expect(scen('burn').note).toMatch(/biogenic by IPCC convention/);
    // Incorporate: the carbon the straw holds, -(8280 x 0.47 x 3.6667 / 1000) = -14.26933 -> -14.27 (low) and
    // -(6552 x 0.47 x 3.6667 / 1000) = -11.29138 -> -11.29 (high), shown as its own term but not netted (orchestrator decision):
    // the net equals the baseline.
    expect(term('residue_carbon')).toMatchObject({kind: 'scenario', tCO2eForField: {low: -14.27, high: -11.29}});
    expect(scen('incorporate').netForField).toEqual(c.emissionsForField);
    expect(scen('incorporate').note).toMatch(/^Carbon the straw holds; not counted in the net because the share that stays in the soil is not estimated, and straw ploughed in raises next season's rice methane/);
    expect(scen('sell_cbg')).toMatchObject({netForField: {low: 1.69, high: 19.82}, note: 'Avoids burning; the fuel or feed it replaces is not credited here.'});
    expect(scen('sell_fodder').netForField).toEqual(c.emissionsForField);
    expect(new Set(c.basis.map((b) => b.kind))).toEqual(new Set(['emission_factor', 'model', 'residue_reference']));
    expect(c.basis.filter((b) => b.kind === 'model').every((b) => b.sourceId!.startsWith('today-footprint-assumption:'))).toBe(true);
    expect(c.limitations).toContain('Residue scenarios are alternatives; only one happens.');
    expect(c.limitations).toContain('Emission factors are IPCC and published Indian references applied to the recommended inputs for the state, not measurements on this field.');
    expect(c.limitations.join(' ')).toMatch(/Rice methane assumes the water regime "irrigated/);
  });

  it('water regime with the IPCC aggregated defaults: irrigated and rainfed unflagged, unknown spans rainfed low to irrigated high (flagged)', () => {
    const fx = structuredClone(FOOTPRINT) as unknown as {constants: {riceWaterRegimeScaling: Record<string, unknown>}};
    fx.constants.riceWaterRegimeScaling.aggregatedIrrigated = f3(0.44, 0.6, 0.78);
    fx.constants.riceWaterRegimeScaling.aggregatedRainfed = f3(0.32, 0.45, 0.62);
    fdata.invalidate(fx);
    const methane = (c: CarbonFootprint) => c.terms.find((t) => t.source === 'rice_methane')!;
    const flagged = (c: CarbonFootprint) => c.basis.some((b) => b.sourceId === 'today-footprint-assumption:riceWaterRegime');
    // Irrigated: 0.8 x 0.44 x 1 x 100 x 27 / 1000 = 0.9504 -> 0.95; 2.2 x 0.78 x 2 x 100 x 27 / 1000 = 9.2664 -> 9.27 t/ha.
    const irrigated = CarbonFootprint.parse(carbonFootprint(PADDY));
    expect(methane(irrigated).tCO2ePerHa).toEqual({low: 0.95, high: 9.27});
    expect(methane(irrigated).method).toMatch(/water regime 0\.44 to 0\.78 \(irrigated, IPCC aggregated default\)/);
    expect(flagged(irrigated)).toBe(false);
    // Rainfed: 0.8 x 0.32 x 100 x 27 / 1000 = 0.6912 -> 0.69; 2.2 x 0.62 x 2 x 100 x 27 / 1000 = 7.3656 -> 7.37.
    const rainfed = carbonFootprint(fp({irrigationCategory: 'rainfed'}));
    expect(methane(rainfed).tCO2ePerHa).toEqual({low: 0.69, high: 7.37});
    expect(flagged(rainfed)).toBe(false);
    // Unknown or supplemental: rainfed low 0.32 to irrigated high 0.78 -> 0.69 to 9.27, flagged.
    for (const cat of [null, 'supplemental']) {
      const u = carbonFootprint(fp({irrigationCategory: cat}));
      expect(methane(u).tCO2ePerHa).toEqual({low: 0.69, high: 9.27});
      expect(flagged(u)).toBe(true);
      expect(u.limitations.join(' ')).toMatch(/span from the rainfed aggregated low to the irrigated aggregated high/);
    }
  });

  it('water regime without aggregated defaults (fallback rule): follows the irrigation category, flagged', () => {
    // Rainfed: SF_w 0.11 (drought-prone low) to 0.73 (regular high): 0.8 x 0.11 x 1 x 100 x 27 / 1000 = 0.2376 t/ha.
    const rainfed = carbonFootprint(fp({irrigationCategory: 'rainfed'}));
    expect(rainfed.terms.find((t) => t.source === 'rice_methane')!.tCO2ePerHa).toEqual({low: 0.24, high: 8.67}); // 2.2 x 0.73 x 2 x 100 x 27 / 1000 = 8.6724
    const unknown = carbonFootprint(fp({irrigationCategory: null}));
    expect(unknown.terms.find((t) => t.source === 'rice_methane')!.tCO2ePerHa).toEqual({low: 1.23, high: 15.09});
    expect(unknown.terms.find((t) => t.source === 'rice_methane')!.method).toMatch(/irrigation not recorded/);
  });

  it('IPCC pre-season water default and an equation-only straw factor (the shape research delivered); no GWP -> unavailable', () => {
    const fx = structuredClone(FOOTPRINT) as unknown as {constants: Record<string, unknown>};
    fx.constants.ricePreSeasonWaterScaling = {aggregated: f3(1.08, 1.22, 1.37), sourceId: 'SYN-IPCC', locator: 'Table 5.13'};
    fx.constants.ricePreSeasonStrawScaling = {none: {low: 1, high: 1}, strawShortBefore: {low: null, high: null, cfoa: f3(0.85, 1, 1.17)}, equation: 'SFo = (1 + ROA x CFOA)^0.59', sourceId: 'SYN-IPCC'};
    fdata.invalidate(fx);
    const c = carbonFootprint(PADDY);
    // 0.8 x 0.57 x 1.08 x 1 x 100 x 27 / 1000 = 1.329696 -> 1.33; 2.2 x 1.27 x 1.37 x 1 x 100 x 27 / 1000 = 10.335006 -> 10.34 t/ha.
    const m = c.terms.find((t) => t.source === 'rice_methane')!;
    expect(m.tCO2ePerHa).toEqual({low: 1.33, high: 10.34});
    expect(m.method).toMatch(/pre-season water 1\.08 to 1\.37 \(aggregated, not recorded\) x straw 1 x 100 days/);
    expect(c.limitations.join(' ')).toMatch(/no straw amendment is included and the high end may be understated/);
    expect(fdata.loadIssues().some((s) => /strawShortBefore/.test(s))).toBe(false);
    fx.constants.gwp100 = {ch4: null, n2o: null, sourceId: null, note: 'not yet retrieved'};
    fdata.invalidate(fx);
    expect(CarbonFootprint.parse(carbonFootprint(PADDY))).toMatchObject({status: 'unavailable', reason: 'gwp_not_sourced', gwp: null, terms: []});
  });

  it('the summary is code-written and every digit in it appears in the fields', () => {
    const c = carbonFootprint(PADDY);
    expect(c.summary).toBe('Paddy on 1.2 ha: about 1.69 to 19.82 t CO₂e this season, mostly methane from the flooded field; finger millet on the same area would be about 0.05 to 0.46.');
    digitsTraceable(c);
    digitsTraceable(carbonFootprint(fp({cropId: 'finger-millet', cropName: 'Finger millet', productId: 'finger-millet-grain'})));
    digitsTraceable(carbonFootprint(fp({areaHa: null})));
    digitsTraceable(carbonFootprint(fp({cropId: 'sesame'})));
  });

  it('pool comparison: paddy ranks above finger millet; the growing crop\'s figure equals its baseline', () => {
    const c = carbonFootprint(PADDY);
    // Finger millet: 50 kg N x EF1 default 0.002 to 0.018 x 1.5714 x 273 / 1000 = 0.0429 to 0.3861 t/ha; x 1.2 = 0.0515 -> 0.05, 0.4633 -> 0.46.
    // Maize: 150 kg N -> 0.1287 to 1.1583 t/ha; x 1.2 = 0.15 to 1.39. Paddy is the highest of the three.
    expect(c.comparison).toEqual({
      rank: 3, of: 3,
      lowest: {cropId: 'finger-millet', cropName: 'Finger millet', tCO2eForField: {low: 0.05, high: 0.46}},
      highest: {cropId: 'paddy', cropName: 'Paddy', tCO2eForField: c.emissionsForField},
    });
    const millet = carbonFootprint(fp({cropId: 'finger-millet', cropName: 'Finger millet', productId: 'finger-millet-grain'}));
    expect(millet.comparison!.rank).toBe(1);
    expect(millet.comparison!.rank).toBeLessThan(c.comparison!.rank);
    expect(millet.comparison!.lowest!.tCO2eForField).toEqual(millet.emissionsForField);
    expect(millet.summary).toMatch(/the lowest of the 3 crops compared on this field/);
    // The paddy figure inside the millet comparison uses its shortest sourced duration (110 days), not this field's season.
    expect(millet.comparison!.highest!.cropId).toBe('paddy');
  });

  it('status and reason: no area (per hectare only), crop without a row, no N rate, no harvest window (duration fallback)', () => {
    const noArea = CarbonFootprint.parse(carbonFootprint(fp({areaHa: null})));
    expect(noArea).toMatchObject({status: 'partial', reason: 'field_area_missing', emissionsForField: null, emissionsPerHa: {low: 1.41, high: 16.52}, residueScenarios: [], comparison: null});
    expect(noArea.terms.map((t) => [t.source, t.tCO2eForField, t.tCO2ePerHa])).toEqual([
      ['rice_methane', null, {low: 1.23, high: 15.09}], ['fertiliser_n2o', null, {low: 0.04, high: 1.24}], ['fuel_and_machinery', null, {low: 0.13, high: 0.19}],
    ]);
    const none = CarbonFootprint.parse(carbonFootprint(fp({cropId: 'sesame'})));
    expect(none).toMatchObject({status: 'unavailable', reason: 'crop_not_in_footprint_data', terms: []});
    expect(none.summary).not.toMatch(/\d/);
    const noN = CarbonFootprint.parse(carbonFootprint(fp({stateId: 'IN-AP', districtId: null})));
    expect(noN).toMatchObject({status: 'partial', reason: 'nitrogen_rate_not_sourced'});
    expect(noN.terms.map((t) => t.source)).toEqual(expect.arrayContaining(['rice_methane', 'fuel_and_machinery']));
    expect(CarbonFootprint.parse(carbonFootprint(fp({cropId: 'cotton', productId: 'cotton-kapas'})))).toMatchObject({status: 'unavailable', reason: 'emission_inputs_not_sourced'});
    // No harvest window: the shortest sourced paddy duration (110 days): 0.8 x 0.57 x 110 x 27 / 1000 = 1.35432 t/ha.
    const noWindow = carbonFootprint(fp({seasonDays: null}));
    expect(noWindow.seasonDays).toBe(110);
    expect(noWindow.terms.find((t) => t.source === 'rice_methane')!.tCO2ePerHa.low).toBe(1.35);
    expect(noWindow.limitations.join(' ')).toMatch(/the season length is the shortest sourced duration \(110 days\)/);
  });
});

// ------------------------------------------------------------------ independent review fixes (2026-11-02)

type Fx = {constants: Record<string, Record<string, unknown>>; crops: Record<string, any>[]};
const fx = (): Fx => structuredClone(FOOTPRINT) as unknown as Fx;
const row = (f: Fx, cropId: string) => f.crops.find((c) => c.cropId === cropId)!;

describe('review fix 1: pool comparison leaves out contingency or part nitrogen doses', () => {
  it('isPartialDose: doseKind decides; the note is matched only without one; "contingency plan" is not a part dose', () => {
    expect(isPartialDose({doseKind: 'contingency_partial', note: null})).toBe(true);
    expect(isPartialDose({doseKind: 'recommended', note: 'Contingency dose, 50% of the RDF'})).toBe(false);
    for (const note of ['Contingency dose for a second crop', '25:10:10 = 50% of the RDF', 'half the recommended dose', 'Not the full recommended dose']) expect(isPartialDose({note}), note).toBe(true);
    expect(isPartialDose({note: 'irrigated paddy 100:50:50 NPK, Hassan district contingency plan'})).toBe(false);
    expect(isPartialDose({note: 'blanket recommendation 60:30:30'})).toBe(false);
    expect(isPartialDose({doseKind: 'something else', note: 'half dose'})).toBe(true); // unknown doseKind -> note fallback
  });

  it('the loader keeps doseKind; a crop whose only rate is a part dose is dropped from the comparison and named', () => {
    const f = fx();
    row(f, 'finger-millet').nitrogenRateKgPerHa[0].note = 'Contingency dose for a second-crop ragi: 25:10:10 NPK = 50% of the RDF. Not the full recommended dose.';
    row(f, 'maize').nitrogenRateKgPerHa[0].doseKind = 'recommended';
    fdata.invalidate(f);
    expect(fdata.footprintCrop('maize')!.nitrogenRateKgPerHa[0]!.doseKind).toBe('recommended');
    const c = CarbonFootprint.parse(carbonFootprint(PADDY));
    // Without finger millet: paddy and maize only; maize (150 kg N -> 0.15 to 1.39 t on 1.2 ha) is the lowest.
    expect(c.comparison).toMatchObject({rank: 2, of: 2, lowest: {cropId: 'maize', tCO2eForField: {low: 0.15, high: 1.39}}});
    expect(c.limitations.join(' ')).toMatch(/^.*Finger millet is left out of the crop comparison: the only nitrogen rate sourced for it in this state is a contingency or part dose, which would understate it, so fewer crops are compared\./);
    expect(c.summary).toMatch(/maize on the same area would be about 0\.15 to 1\.39\.$/);
    digitsTraceable(c);
    // The same through doseKind (no note): maize marked contingency_partial is dropped too; two names are listed.
    row(f, 'maize').nitrogenRateKgPerHa[0].doseKind = 'contingency_partial';
    fdata.invalidate(f);
    const both = carbonFootprint(PADDY);
    expect(both.comparison).toBeNull();
    expect(both.limitations.join(' ')).toMatch(/Finger millet and Maize are left out of the crop comparison/);
  });

  it('a part dose spanned with a full dose: the comparison uses the full row only', () => {
    const f = fx();
    row(f, 'maize').nitrogenRateKgPerHa.push(range(40, 40, 'SYN-POP', {region: 'IN-KA', doseKind: 'contingency_partial'}));
    fdata.invalidate(f);
    const c = carbonFootprint(PADDY);
    // Maize keeps 150 kg N (not 40 to 150) and is not named as left out.
    expect(c.comparison).toMatchObject({of: 3, lowest: {cropId: 'finger-millet'}});
    expect(c.limitations.join(' ')).not.toMatch(/left out of the crop comparison/);
    const maize = carbonFootprint(fp({cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    // The growing crop keeps every row (40 to 150 kg N) and says the rate includes a contingency figure.
    expect(maize.terms.find((t) => t.source === 'fertiliser_n2o')!.method).toMatch(/^40 to 150 kg N\/ha/);
    expect(maize.limitations.join(' ')).toMatch(/The nitrogen rate for IN-KA is a contingency figure/);
  });

  it('the growing crop\'s own part dose keeps its term and adds the contingency limitation', () => {
    const f = fx();
    row(f, 'finger-millet').nitrogenRateKgPerHa[0].note = 'Contingency dose, 50% of the RDF';
    fdata.invalidate(f);
    const m = CarbonFootprint.parse(carbonFootprint(fp({cropId: 'finger-millet', cropName: 'Finger millet', productId: 'finger-millet-grain'})));
    expect(m.terms.map((t) => t.source)).toContain('fertiliser_n2o');
    expect(m.emissionsForField).toEqual({low: 0.05, high: 0.46});
    expect(m.limitations).toContain('The nitrogen rate for IN-KA is a contingency figure (a part dose, not the full recommended dose), so the fertiliser emissions of this crop are understated, here and in the comparison.');
    expect(m.comparison).toMatchObject({rank: 1, of: 3});
    expect(m.limitations.join(' ')).not.toMatch(/left out of the crop comparison/);
  });
});

describe('review fix 1b: a pool crop with no nitrogen rate for the state is left out unless nothing else is left', () => {
  it('left out and named; kept and named when it is the only other crop; the growing crop keeps its own figure', () => {
    const f = fx();
    // Maize: no IN-KA nitrogen row (only IN-TN), but a diesel term (100 l/ha x 2.68 / 1000 = 0.268 t/ha), so it has a figure.
    row(f, 'maize').nitrogenRateKgPerHa = [range(150, 150, 'SYN-POP', {region: 'IN-TN'})];
    row(f, 'maize').energyInput.dieselLitresPerHa = {low: 100, high: 100};
    fdata.invalidate(f);
    const c = CarbonFootprint.parse(carbonFootprint(PADDY));
    expect(c.comparison).toMatchObject({rank: 2, of: 2, lowest: {cropId: 'finger-millet'}});
    expect(c.limitations).toContain('Maize is left out of the crop comparison: no nitrogen rate is sourced for IN-KA, so its emissions would be understated.');
    // Without finger millet, leaving maize out would leave nothing to compare: maize is kept and named.
    f.crops = f.crops.filter((x) => x.cropId !== 'finger-millet');
    fdata.invalidate(f);
    const kept = CarbonFootprint.parse(carbonFootprint(PADDY));
    // Maize: 0.268 t/ha x 1.2 = 0.3216 -> 0.32 t.
    expect(kept.comparison).toMatchObject({rank: 2, of: 2, lowest: {cropId: 'maize', tCO2eForField: {low: 0.32, high: 0.32}}});
    expect(kept.limitations).toContain('Maize is kept in the crop comparison although no nitrogen rate is sourced for IN-KA, because no other crop could be compared; its emissions are understated.');
    expect(kept.limitations.join(' ')).not.toMatch(/Maize is left out/);
    digitsTraceable(kept);
    // The growing crop without a rate keeps its own figure in the comparison (paddy in IN-AP: methane and diesel only).
    const ap = CarbonFootprint.parse(carbonFootprint(fp({stateId: 'IN-AP', districtId: null})));
    expect(ap.comparison).toMatchObject({of: 2, highest: {cropId: 'paddy', tCO2eForField: ap.emissionsForField}});
    expect(ap.limitations).toContain('Maize is kept in the crop comparison although no nitrogen rate is sourced for IN-AP, because no other crop could be compared; its emissions are understated.');
  });
});

describe('review fix 2: plant prices are paid to balers, not at the farm gate', () => {
  it('always-on limitation; the note of an option priced at a plant or to balers starts with the plant-price sentence', () => {
    const f = fx();
    const uses = row(f, 'paddy').residue.uses;
    uses[1].priceBasis = 'Synthetic: bought from balers and aggregators, 2024';
    uses[1].note = 'Synthetic note.';
    uses.push({use: 'biomass_fuel', label: 'Biomass power fuel', share: null, priceInrPerTonne: range(1600, 1700, 'SYN-PRICE'), priceBasis: 'Synthetic: farm gate sale, 2024', sourceId: 'SYN-PRICE', locator: 'para 7'});
    fdata.invalidate(f);
    const r = ResidueIncome.parse(residueIncome(PADDY));
    expect(r.limitations).toContain(PLANT_PRICE_LIMITATION);
    expect(PLANT_PRICE_LIMITATION).toBe('Plant prices are paid to balers or aggregators; baling, loading and haulage are not deducted, so the farmer\'s share is lower.');
    const note = (use: string) => r.options.find((o) => o.use === use)!.note;
    expect(note('cbg_feedstock')).toBe(PLANT_PRICE_NOTE); // "a CBG plant", no row note
    expect(note('dry_fodder')).toBe(`${PLANT_PRICE_NOTE} Synthetic note.`); // "balers and aggregators"
    expect(note('biomass_fuel')).toBeNull(); // farm gate: no prefix
    expect(note('mushroom_substrate')).toBeNull(); // no price basis
    expect(ResidueIncome.parse(residueIncome(fp({cropId: 'maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}))).limitations).toContain(PLANT_PRICE_LIMITATION);
  });
});

describe('review fix 3: residue quantities are approximately air-dry, not dry matter', () => {
  it('basis labels, limitations and method lines say air-dry; a derived ratio says so', () => {
    const f = fx();
    row(f, 'paddy').residue.rpr.note = 'Ratio derived as biomass generation / crop production from the state residue tables.';
    fdata.invalidate(f);
    const r = residueIncome(PADDY);
    const rpr = r.basis.find((b) => b.label.startsWith('Residue-to-product'))!;
    expect(rpr.label).toContain(`(kg paddy straw per kg paddy-grain), ${AIR_DRY}`);
    expect(AIR_DRY).toBe('approximately air-dry (moisture basis not stated in the source)');
    expect(rpr.note).toMatch(/^Ratio derived from the atlas's generation and production figures\./);
    expect(r.limitations).toContain(`The residue-to-product ratio is ${RPR_DERIVED}; residue quantities are ${AIR_DRY}.`);
    const c = carbonFootprint(PADDY);
    const e = energyFootprint(PADDY);
    for (const text of [JSON.stringify(r.basis.map((b) => b.label)), r.limitations.join(' '), JSON.stringify(c.terms.map((t) => t.method)), c.limitations.join(' '), e.limitations.join(' ')]) {
      expect(text).not.toMatch(/dry matter|kg dry/);
    }
    expect(c.terms.find((t) => t.source === 'residue_burning')!.method).toMatch(/^6552 to 8280 kg paddy straw, approximately air-dry \(moisture basis not stated in the source\), x combustion factor/);
    expect(c.terms.find((t) => t.source === 'residue_carbon')!.method).toContain(`kg paddy straw, ${AIR_DRY}, x carbon fraction`);
    expect(c.residueScenarios.find((x) => x.id === 'burn')!.note).toMatch(/per kg dry matter and are applied to residue that is approximately air-dry/);
    // Without "derived" in the note: no derived sentence.
    fdata.invalidate(structuredClone(FOOTPRINT));
    expect(residueIncome(PADDY).limitations.join(' ')).not.toContain(RPR_DERIVED);
  });
});

describe('review fix 4: harvest economics uses the year plan\'s fixed-slot season rule, unrounded keep', () => {
  it('a sowing date inside a kharif window but in a rabi calendar month takes the kharif yield, as the year plan does', () => {
    const yp = structuredClone(YEAR_PLAN) as any;
    const paddy = yp.agronomy.crops.find((c: any) => c.cropId === 'paddy');
    paddy.sowingWindows = [{region: H, season: 'kharif', from: '07-01', to: '09-20', condition: 'any', source: `${SRC} windows`}];
    const pyc = yp.yieldCost.crops.find((c: any) => c.cropId === 'paddy');
    // Rabi rows 3000, 3200, 3400 (P25 3100, P75 3300) beside the Kharif rows 4000, 4400, 4800 (P25 4200, P75 4600).
    pyc.yields.push(...[['2022-23', 3000], ['2023-24', 3200], ['2024-25', 3400]].map(([cy, v]) => ({...y(cy as string, v as number), season: 'Rabi'})));
    pyc.postHarvestLossPct = {value: 3.333, sourceId: 'syn-loss', note: 'synthetic'};
    data.invalidate(yp);
    const sowing = '2026-09-10'; // September: rabi by the calendar month, kharif by the sourced window
    expect(data.seasonOfMonth(9)).toBe('rabi');
    expect(sowingSeason('paddy', sowing, {stateId: 'IN-KA', districtId: H})).toBe('kharif');
    expect(sowingSeason('paddy', '2026-10-05', {stateId: 'IN-KA', districtId: H})).toBe('rabi'); // outside the window: calendar
    const cycle = {id: 'cycle-sep', cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', sowingDate: sowing, establishmentDate: sowing, stage: 'growing' as const};
    const ctx = buildScenario({
      workspace: {previousHarvest: {status: 'unknown'}, cycles: [cycle], rotationPlans: []} as never,
      farm: {location: {stateCode: 'IN-KA', districtId: H}, areaHectares: AREA, facts: {}}, asOf: TODAY,
    });
    const slot = ctx.fixedSlot!;
    expect(slot.season).toBe('kharif');
    const inputs = emptyInputs(TODAY, null);
    for (const k of collectInputKeys([slot])) inputs.priceOutlooks.set(k.key, outlook(PRICE, k.harvestDate));
    const plan = evaluateSlot(ctx, inputs, slot, {maxMarginRate: null});
    const e = econ({harvest: slot.harvest, harvestDate: priceHarvestDate(slot.harvest), headline: inputs.priceOutlooks.get(slotPriceKey(slot))!}, {id: cycle.id, sowingDate: sowing});
    expect(e.yieldKgPerHa).toEqual({low: 4200, high: 4600}); // the kharif rows, not the rabi 3100 to 3300
    expect(e.keepFraction).toBe(1 - 3.333 / 100); // unrounded (0.96667), as evaluateSlot passes it
    expect(e.keepFraction).not.toBe(0.9667);
    expect(plan.estimate.profitForField).not.toBeNull();
    expect(e.profitForField).toEqual(plan.estimate.profitForField);
    expect(e.revenuePerHa).toEqual(plan.estimate.revenuePerHa);
    const direct = estimateProfit({seed: slot.key, yieldKgPerHa: {p25: 4200, p50: 4400, p75: 4600}, pricePerKg: {p25: 18, p50: 22, p75: 26}, keep: 1 - 3.333 / 100, costPerHa: 70000, areaHa: AREA});
    expect(e.profitForField).toEqual(direct.profitForField);
    // The farmer yield override of the year plan is not reachable here: said in a limitation.
    expect(e.limitations).toContain(NO_OVERRIDE);
    // A sowing outside every window falls back to the calendar season (rabi rows).
    expect(econ({}, {sowingDate: '2026-10-05'}).yieldKgPerHa).toEqual({low: 3100, high: 3300});
  });
});

describe('review fix 5: CO2 from applying urea is named as not included', () => {
  it('present whenever a fertiliser_n2o term exists, absent otherwise', () => {
    expect(UREA_CO2_LIMITATION).toBe('CO2 released when urea is applied (IPCC 2006 Vol 4 Ch 11 Eq 11.13) is not included.');
    expect(carbonFootprint(PADDY).limitations).toContain(UREA_CO2_LIMITATION);
    expect(carbonFootprint(fp({areaHa: null})).limitations).toContain(UREA_CO2_LIMITATION);
    const noN = carbonFootprint(fp({stateId: 'IN-AP', districtId: null}));
    expect(noN.terms.some((t) => t.source === 'fertiliser_n2o')).toBe(false);
    expect(noN.limitations).not.toContain(UREA_CO2_LIMITATION);
  });
});

describe('review fix 6: per-residue combustion factor for burning', () => {
  it('rice uses its Table 2.6 entry; a residue without one uses the envelope; a malformed entry is skipped and recorded', () => {
    const f = fx();
    f.constants.residueBurning!.combustionFactorByResidue = {rice: 0.85, wheat: 'high'};
    fdata.invalidate(f);
    expect(fdata.footprintConstants().residueBurning!.combustionFactorByResidue).toEqual({rice: 0.85});
    expect(fdata.loadIssues().some((x) => /combustionFactorByResidue\.wheat skipped/.test(x))).toBe(true);
    const c = carbonFootprint(PADDY);
    const burn = c.terms.find((t) => t.source === 'residue_burning')!;
    // 6552 x 0.85 = 5569.2 kg and 8280 x 0.85 = 7038 kg burnt; x 92.01 g CO2e/kg / 1e6 = 0.51242 -> 0.51 and 0.64757 -> 0.65 t.
    expect(burn.tCO2eForField).toEqual({low: 0.51, high: 0.65});
    expect(burn.method).toMatch(/combustion factor 0\.85 \(rice residue\)/);
    // Maize has no entry: the 0.8 to 0.9 envelope. 3000 x 1.5 = 4500 and 4000 x 2 = 8000 kg; x 0.8 and 0.9 -> 3600 and 7200 kg;
    // x 92.01 / 1e6 = 0.33124 -> 0.33 and 0.66247 -> 0.66 t.
    const maize = carbonFootprint(fp({cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    const mb = maize.terms.find((t) => t.source === 'residue_burning')!;
    expect(mb.tCO2eForField).toEqual({low: 0.33, high: 0.66});
    expect(mb.method).toMatch(/combustion factor 0\.8 to 0\.9 \(range; no factor for this residue\)/);
  });
});

describe('review fix 7: additional source ids are kept and cited', () => {
  it('Value, Range and biogas figures keep additionalSourceIds; equivalents, terms and basis notes name them', () => {
    const f = fx();
    const res = row(f, 'paddy').residue;
    res.rpr.additionalSourceIds = ['SYN-RPR2'];
    res.calorificValueMJPerKg.additionalSourceIds = ['SYN-CV2'];
    res.biogasM3PerTonneDm.additionalSourceIds = ['SYN-BG2'];
    f.constants.lpgMjPerKg!.additionalSourceIds = ['SYN-LPG2'];
    f.constants.dieselMjPerLitre!.additionalSourceIds = ['SYN-HPCL'];
    fdata.invalidate(f);
    expect(fdata.footprintConstants().lpgMjPerKg!.additionalSourceIds).toEqual(['SYN-LPG2']);
    expect(fdata.footprintCrop('paddy')!.residue!.biogasM3PerTonneDm!.additionalSourceIds).toEqual(['SYN-BG2']);
    expect(fdata.footprintConstants().lpgCylinderKg!.additionalSourceIds).toEqual([]); // absent -> empty
    const e = energyFootprint(PADDY);
    const eq = (unit: string) => e.equivalents.find((q) => q.unit === unit)!.sourceIds;
    expect(eq('cylinders')).toEqual(['SYN-LPG', 'SYN-CV', 'SYN-LPG2', 'SYN-CV2']);
    expect(eq('litres')).toEqual(['SYN-LPG', 'SYN-CV', 'SYN-HPCL', 'SYN-CV2']);
    expect(eq('kg CH₄')).toEqual(['SYN-BG', 'SYN-LPG', 'SYN-BG2']);
    expect(e.basis.find((b) => b.label.startsWith('Gross calorific'))!.note).toMatch(/Additional sources: SYN-CV2\.$/);
    const r = residueIncome(PADDY);
    expect(r.basis.find((b) => b.label.startsWith('Residue-to-product'))!.note).toBe('dry basis Additional sources: SYN-RPR2.'); // no register entry for SYN-RPR2, so no title
    const c = carbonFootprint(PADDY);
    expect(c.terms.find((t) => t.source === 'residue_burning')!.sourceIds).toEqual(['SYN-IPCC', 'SYN-RPR', 'SYN-RPR2']);
  });
});

describe('review fix 8: the LPG gross-versus-net note', () => {
  it('goes into the LPG basis note and the limitations when the equivalent is shown', () => {
    const f = fx();
    f.constants.lpgMjPerKg!.note = 'Net calorific value; the straw value is gross, so the LPG equivalent is overstated.';
    fdata.invalidate(f);
    const e = energyFootprint(PADDY);
    expect(e.basis.find((b) => b.label.startsWith('LPG'))!.note).toBe('Net calorific value; the straw value is gross, so the LPG equivalent is overstated.');
    expect(e.limitations).toContain('LPG equivalent: Net calorific value; the straw value is gross, so the LPG equivalent is overstated.');
    // No equivalent (no residue energy): no LPG limitation.
    const maize = energyFootprint(fp({cropId: 'maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    expect(maize.equivalents).toEqual([]);
    expect(maize.limitations.join(' ')).not.toMatch(/LPG equivalent/);
  });
});

describe('review fix 9: the summary and the term order use the web\'s largest-term rule (high values)', () => {
  it('a term with the larger high but the smaller midpoint is named and ordered first', () => {
    const f = fx();
    // Maize diesel 300 to 330 l/ha x 2.68 / 1000 = 0.804 to 0.8844 t/ha (midpoint 0.844); N2O 150 kg N -> 0.1287 to 1.1583 t/ha
    // (midpoint 0.6435). By midpoints diesel is larger; by high values nitrous oxide is (1.1583 > 0.8844).
    row(f, 'maize').energyInput.dieselLitresPerHa = {low: 300, high: 330};
    fdata.invalidate(f);
    const c = CarbonFootprint.parse(carbonFootprint(fp({cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}})));
    const baseline = c.terms.filter((t) => t.kind === 'baseline');
    expect(baseline.map((t) => t.source)).toEqual(['fertiliser_n2o', 'fuel_and_machinery']);
    // Field highs: 1.1583 x 1.2 = 1.39, 0.8844 x 1.2 = 1.06; share 1.39 / 2.45 = 0.567 >= 0.5 -> "mostly".
    expect(baseline.map((t) => t.tCO2eForField!.high)).toEqual([1.39, 1.06]);
    expect(c.summary).toMatch(/^Maize on 1\.2 ha: about 1\.12 to 2\.45 t CO₂e this season, mostly nitrous oxide from fertiliser nitrogen/);
    // The web's rule, written out: the first baseline term has the largest high, and it is at least half of the sum of highs.
    const highs = baseline.map((t) => t.tCO2eForField!.high);
    expect(highs[0]).toBe(Math.max(...highs));
    expect(highs[0]! / highs.reduce((a, b) => a + Math.max(0, b), 0)).toBeGreaterThanOrEqual(0.5);
    // Scenario terms come after the baseline terms.
    expect(c.terms.findIndex((t) => t.kind === 'scenario')).toBe(baseline.length);
    // Below half: three terms where the largest high is under 0.5 of the sum -> "the largest part from".
    row(f, 'maize').energyInput.dieselLitresPerHa = {low: 380, high: 400}; // 1.0184 to 1.072 t/ha -> field high 1.29
    f.constants.ureaManufactureKgCo2ePerKgN = {low: 5, high: 6, sourceId: 'SYN-IPCC', note: 'synthetic'}; // 150 x 6 / 1000 = 0.9 t/ha -> 1.08
    fdata.invalidate(f);
    const d = carbonFootprint(fp({cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', yieldForFieldKg: {low: 3000, high: 4000}}));
    const db = d.terms.filter((t) => t.kind === 'baseline');
    expect(db.map((t) => [t.source, t.tCO2eForField!.high])).toEqual([['fertiliser_n2o', 1.39], ['fuel_and_machinery', 1.29], ['fertiliser_manufacture', 1.08]]);
    expect(d.summary).toMatch(/the largest part from nitrous oxide from fertiliser nitrogen/);
    digitsTraceable(d);
  });
});

describe('irrigation category as the year plan reads it', () => {
  it('only farmer-reported, lab or confirmed values; irrigation_category before irrigation', () => {
    expect(irrigationCategoryOf({irrigation_category: {value: 'irrigated', basis: 'farmer_reported', confirmed: false}})).toBe('irrigated');
    expect(irrigationCategoryOf({irrigation_category: {value: 'irrigated', basis: 'ai_proposed', confirmed: false}})).toBeNull();
    expect(irrigationCategoryOf({irrigation: {value: 'rainfed', basis: 'ai_proposed', confirmed: true}})).toBe('rainfed');
    expect(irrigationCategoryOf(undefined)).toBeNull();
  });
});
