import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CropFitReview, type CropFitCandidate, type FarmSoilMarkers, type HarvestPriceOutlook, type SoilMarker, type StageTimeline } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { ASSUMPTIONS, buildScenario, collectInputKeys, emptyInputs } from '../src/services/year-plan';
import { addDays } from '../src/services/year-plan/dates';
import type { EngineContext } from '../src/services/year-plan/types';
import type { TextModelProvider } from '../src/agent/provider';
import { normaliseRequest, placeCandidates, rankCandidates, resolveMode, type PlacedPlan } from '../src/services/crop-fit/rank';
import { compareSoil, needClass, nutrientUptake, soilFacts, uptakeAt, verdictFor, type RateMarkerFn } from '../src/services/crop-fit/soil-compare';
import { candidateKey, deterministicPicks, gatePicks, isPrunedOrder, pickPool, picksSchema } from '../src/services/crop-fit/select';
import { marketNowFromRows } from '../src/services/crop-fit/market-now';
import { companionOf, currentYearPlan, ensureCropFit, fitContext, generateCropFit, grownBeforeOf, MODEL_UNAVAILABLE, PLAN_LABELS_NOTE, requestKey, toCandidate, type CropFitDeps } from '../src/services/crop-fit/service';
import { intercropSystemOf, planCandidates, scorePlacements, seasonContext, waitPenaltyFor } from '../src/services/crop-fit/rank';
import { enumerateCandidates } from '../src/services/year-plan/candidates';
import { marginNormaliser, runInputKeys, runYearPlanEngine, scoreSequences, type ScoringNorm } from '../src/services/year-plan/assemble';
import { daysBetween } from '../src/services/year-plan/dates';
import { PRICE_LOOKUP_CAP as YEAR_PLAN_PRICE_LOOKUP_CAP, spreadKeys, yearPlanContext } from '../src/services/year-plan/service';
import { monthlyRainFromDaily, slotPriceKey } from '../src/services/year-plan/inputs';
import * as data from '../src/services/year-plan/data';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Crop fit v2 (ROUND2_SPEC.md 4.3 acceptance). Every price, rain and soil figure here is a SYNTHETIC fake injected through
 * deps.sources or built in the test; the Meta transport is a fake provider. Research files are the real read-only ones
 * (Hassan windows: maize kharif rainfed 22 May to 30 Jun, sorghum 1 Apr to 14 Jun, groundnut rabi irrigated 8 Dec to 14 Jan).
 */
const ASOF = '2026-11-01';
const NOW = () => new Date('2026-11-01T06:00:00Z');
const HASSAN = { location: { stateCode: 'IN-KA', districtId: 'IN-KA-hassan' }, areaHectares: 0.16, facts: {} };
const fresh = (): EngineContext => buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [] }, farm: HASSAN, asOf: ASOF });
const timeline = (i: { cropId: string; productId: string | null; anchorDate: string }): StageTimeline => ({
  cropId: i.cropId, productId: i.productId, establishmentMethod: null, anchorDate: i.anchorDate, stages: [], harvest: { earliest: '2027-01-05', latest: '2027-01-25' },
  basis: { kind: 'duration', label: 'Synthetic stage timeline', sourceId: 'synthetic-timeline', url: null, scope: null, note: null },
});
const occupied = (): EngineContext => buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [{ id: 'cyc-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-09-15', stage: 'growing' }], rotationPlans: [] } as never, farm: HASSAN, asOf: ASOF, timeline });

function fakeOutlook(args: { productId: string; harvestDate: string; asOf: string }): HarvestPriceOutlook {
  return {
    productId: args.productId, status: 'available', missingReason: null,
    scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price, not a market observation', limitations: ['synthetic'],
    method: 'B_seasonal_reference/pooled-v1', harvestDate: args.harvestDate, harvestWeek: { year: 2027, week: 30 }, asOf: args.asOf, weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 18, p25: 20, p50: 25, p75: 30, p90: 33, annualMean: 24, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  } as HarvestPriceOutlook;
}
function inputsFor(ctx: EngineContext, placed: readonly PlacedPlan[]) {
  const inputs = emptyInputs(ASOF, ctx.irrigation);
  for (const k of collectInputKeys(placed.map((p) => p.plan))) inputs.priceOutlooks.set(k.key, fakeOutlook({ productId: k.productId, harvestDate: k.harvestDate, asOf: ASOF }));
  return inputs;
}

describe('crop fit: mode resolution and placement (pure, real research files)', () => {
  it('defaults: next when a crop is growing, date (today) on a fresh field; season needs a season', () => {
    expect(normaliseRequest({}, true, ASOF)).toEqual({ mode: 'next', season: null, sowing: null });
    expect(normaliseRequest({}, false, ASOF)).toEqual({ mode: 'date', season: null, sowing: ASOF });
    expect(normaliseRequest({ mode: 'season', season: 'rabi', sowing: '2027-01-01' }, false, ASOF)).toEqual({ mode: 'season', season: 'rabi', sowing: null });
    expect(() => normaliseRequest({ mode: 'season' }, false, ASOF)).toThrow(/season is required/);
    expect(() => normaliseRequest({ mode: 'date', sowing: '2027-02-30' }, false, ASOF)).toThrow(/calendar date/);
  });

  it('next uses the year-plan release date (latest harvest + buffer + land preparation gap) and the growing crop as the previous crop', () => {
    const ctx = occupied();
    const r = resolveMode(ctx, normaliseRequest({}, true, ASOF));
    expect(r.target).toBe(ctx.fixedSlot!.occupancy.to);
    expect(r.target).toBe(addDays('2027-01-25', ASSUMPTIONS.timelineHarvestBufferDays.value + ASSUMPTIONS.landPrepGapDays.value));
    expect(r.previousCropId).toBe('paddy');
    const { placed } = placeCandidates(ctx, r);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((p) => p.plan.sowing >= r.target!)).toBe(true);
    const ranked = rankCandidates(ctx, inputsFor(ctx, placed), placed);
    expect(ranked.every((c) => c.previousCropId === 'paddy')).toBe(true);
  });

  it('season uses each crop\'s own earliest window start of that season on or after the first free day', () => {
    const ctx = fresh();
    const r = resolveMode(ctx, { mode: 'season', season: 'kharif', sowing: null });
    expect(r.target).toBeNull();
    const { placed } = placeCandidates(ctx, r);
    const sowingOf = (cropId: string) => [...new Set(placed.filter((p) => p.plan.cropId === cropId).map((p) => p.plan.sowing))];
    expect(sowingOf('maize')).toEqual(['2027-05-22']);
    expect(sowingOf('sorghum')).toEqual(['2027-04-01']);
    expect(placed.every((p) => p.plan.season === 'kharif' && p.shiftedDays === 0 && p.plan.sowing >= ASOF)).toBe(true);
    // A growing crop moves the floor to its release: no summer sowing before the field is free.
    const occ = occupied();
    const summer = placeCandidates(occ, resolveMode(occ, { mode: 'season', season: 'summer', sowing: null }));
    expect(summer.placed.every((p) => p.plan.sowing >= occ.fixedSlot!.occupancy.to)).toBe(true);
  });

  it('date uses the farmer\'s date; a crop whose window opens within 21 days is moved there and flagged window_shifted', () => {
    const ctx = fresh();
    const r = resolveMode(ctx, normaliseRequest({ mode: 'date', sowing: '2027-05-17' }, false, ASOF));
    expect(r.target).toBe('2027-05-17');
    const { placed } = placeCandidates(ctx, r);
    const maize = placed.filter((p) => p.plan.cropId === 'maize');
    expect(maize.length).toBeGreaterThan(0);
    expect(maize.every((p) => p.plan.sowing === '2027-05-22' && p.shiftedDays === 5)).toBe(true);
    expect(placed.filter((p) => p.plan.cropId === 'sorghum').every((p) => p.plan.sowing === '2027-05-17' && p.shiftedDays === 0)).toBe(true);
    const ranked = rankCandidates(ctx, inputsFor(ctx, placed), placed);
    const m = ranked.find((c) => c.plan.cropId === 'maize')!;
    expect(m.reasonCodes).toContain('window_shifted');
    expect(m.uncertainties.some((u) => /moved 5 days later.*window_shifted/.test(u))).toBe(true);
    expect(ranked.find((c) => c.plan.cropId === 'sorghum')!.reasonCodes).not.toContain('window_shifted');
    // One candidate per crop and product, sorted by score; scores are the year-plan per-slot display score.
    expect(new Set(ranked.map((c) => `${c.plan.cropId}|${c.plan.productId}`)).size).toBe(ranked.length);
    expect(ranked.map((c) => c.score)).toEqual([...ranked.map((c) => c.score)].sort((a, b) => b - a));
  });

  it('a crop more than 21 days from every window is not ranked; shifts never go before the floor', () => {
    const ctx = fresh();
    const { placed, unplaced } = placeCandidates(ctx, resolveMode(ctx, { mode: 'date', season: null, sowing: '2026-11-20' }));
    expect(unplaced.find((u) => u.cropId === 'maize')?.reason).toMatch(/within 21 days/);
    expect(unplaced.some((u) => u.cropId === 'onion')).toBe(true); // rabi window ended 31 Oct, before today
    const groundnut = placed.filter((p) => p.plan.cropId === 'groundnut');
    expect(groundnut.length).toBeGreaterThan(0);
    expect(groundnut.every((p) => p.plan.sowing === '2026-12-08' && p.shiftedDays === 18 && p.plan.flags.conditional)).toBe(true);
  });
});

// ------------------------------------------------------------------ soil
const marker = (over: Partial<SoilMarker> & Pick<SoilMarker, 'id' | 'parameter'>): SoilMarker => ({
  rawLabel: over.parameter, rawValue: String(over.canonical?.value ?? 0), rawUnit: over.canonical?.unit ?? null, numericValue: over.canonical?.value ?? 0, qualifier: 'exact', range: null,
  analyteForm: null, method: null, extractant: null, soilWaterRatio: null, temperatureC: null, matrix: 'soil', massBasis: null, reportedRating: null, reportedReference: null,
  evidence: { page: 1, quote: 'synthetic', nativeTextCheck: 'matched' }, extractionConfidence: 'high', warnings: [],
  canonical: { value: 0, unit: null, conversion: null, missingReason: null }, reviewStatus: 'confirmed', confirmedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const soilOf = (markers: SoilMarker[]): FarmSoilMarkers => ({
  farmId: randomUUID(), limitations: [],
  samples: [{ id: randomUUID(), reportId: randomUUID(), sourceSampleId: 's1', sampleLabel: null, laboratory: null, collectionDate: '2026-09-20', reportDate: null, depth: null, confirmedAt: '2026-10-01T00:00:00.000Z', markers }],
});
const fakeRate: RateMarkerFn = (m) => {
  const v = m.canonical.value ?? 0;
  if (m.parameter === 'ph') return { rating: v < 5.5 ? 'strongly_acidic' : 'neutral', status: 'rated', source: { id: 'syn-ph', title: 'Synthetic pH bands', url: 'https://example.org/ph' }, note: null };
  if (m.parameter === 'nitrogen_available') return { rating: v < 280 ? 'low' : v <= 560 ? 'medium' : 'high', status: 'rated', source: { id: 'syn-n', title: 'Synthetic N bands', url: null }, note: null };
  if (m.parameter === 'nitrogen_unspecified') return { rating: v < 280 ? 'low' : 'medium', status: 'rated', source: null, note: null, assumption: 'Pool not printed; rated as available N.' };
  if (m.parameter === 'potassium_available') return { rating: 'high', status: 'rated', source: null, note: null };
  return { rating: 'unrated', status: 'unrated', source: null, note: 'No cited rating band covers this parameter.' };
};

describe('crop fit: soil comparison (pure)', () => {
  it('need classes use the ROUND2_SPEC thresholds (boundaries in the medium class)', () => {
    expect([59.9, 60, 120, 120.1].map((x) => needClass('N', x))).toEqual(['low', 'medium', 'medium', 'high']);
    expect([29.9, 30, 60, 60.1].map((x) => needClass('P2O5', x))).toEqual(['low', 'medium', 'medium', 'high']);
    expect([59.9, 60, 120, 120.1].map((x) => needClass('K2O', x))).toEqual(['low', 'medium', 'medium', 'high']);
  });

  it('uptake scales with the regional yield: per tonne, or linearly from the yield it was stated at', () => {
    expect(uptakeAt(nutrientUptake('paddy'), 'N', 4000)).toEqual({ kgPerHa: 80, scaled: 'per_tonne' });
    const maize = uptakeAt(nutrientUptake('maize'), 'N', 4750)!;
    expect(maize.scaled).toBe('linear_from_stated_yield');
    expect(maize.kgPerHa).toBeCloseTo(95.5, 6);
    expect(uptakeAt(nutrientUptake('maize'), 'N', null)).toBeNull();
    expect(nutrientUptake('ginger')).toBeNull();
  });

  it('verdict matrix: short = low soil vs high need; watch = low/medium vs medium/high; ok otherwise; unknown when a side is missing', () => {
    const table: [Parameters<typeof verdictFor>[0], Parameters<typeof verdictFor>[1], string][] = [
      ['low', 'high', 'short'], ['low', 'medium', 'watch'], ['low', 'low', 'ok'],
      ['medium', 'high', 'watch'], ['medium', 'medium', 'watch'], ['medium', 'low', 'ok'],
      ['high', 'high', 'ok'], ['high', 'medium', 'ok'], ['high', 'low', 'ok'],
      [null, 'high', 'unknown'], ['low', null, 'unknown'],
    ];
    for (const [level, need, verdict] of table) expect(verdictFor(level, need), `${level} vs ${need}`).toBe(verdict);
  });

  it('compares confirmed markers with the crop need; pH outside a cited range is watch with the range in the note; no report is no_report', () => {
    const soil = soilOf([
      marker({ id: 'm-ph', parameter: 'ph', canonical: { value: 5.0, unit: 'pH', conversion: null, missingReason: null } }),
      marker({ id: 'm-n', parameter: 'nitrogen_available', canonical: { value: 200, unit: 'kg/ha', conversion: null, missingReason: null } }),
      marker({ id: 'm-k', parameter: 'potassium_available', canonical: { value: 300, unit: 'kg/ha', conversion: null, missingReason: null } }),
      marker({ id: 'm-ec', parameter: 'electrical_conductivity', canonical: { value: 0.4, unit: 'dS/m', conversion: null, missingReason: null } }),
    ]);
    const facts = soilFacts(soil, fakeRate);
    const r = compareSoil(facts, soil, { cropId: 'maize', cropName: 'Maize', yieldKgPerHa: 9500, phRange: { min: 6, max: 6.5, source: 'Synthetic source, Soil' } });
    expect(r.status).toBe('compared');
    const by = Object.fromEntries(r.checks.map((c) => [c.parameter, c]));
    expect(by.nitrogen_available).toMatchObject({ rating: 'low', need: 'high', verdict: 'short', markerId: 'm-n', ratingSource: { id: 'syn-n' } });
    expect(by.potassium_available).toMatchObject({ rating: 'high', need: 'high', verdict: 'ok' });
    expect(by.ph).toMatchObject({ verdict: 'watch', need: null });
    expect(by.ph!.note).toMatch(/pH 6 to 6\.5/);
    expect(by.electrical_conductivity).toMatchObject({ rating: 'unrated', verdict: 'unknown' });
    // A crop without sourced uptake: need unknown.
    expect(compareSoil(facts, soil, { cropId: 'ginger', cropName: 'Ginger', yieldKgPerHa: 20000, phRange: null }).checks.find((c) => c.parameter === 'nitrogen_available')).toMatchObject({ need: null, verdict: 'unknown' });
    expect(compareSoil([], soilOf([]), { cropId: 'maize', cropName: 'Maize', yieldKgPerHa: 9500, phRange: null })).toEqual({ status: 'no_report', checks: [] });
  });

  it('nitrogen without a printed pool is used when no available N exists, with the rating assumption carried', () => {
    const soil = soilOf([marker({ id: 'm-nu', parameter: 'nitrogen_unspecified', canonical: { value: 278, unit: 'kg/ha', conversion: null, missingReason: null } })]);
    const check = compareSoil(soilFacts(soil, fakeRate), soil, { cropId: 'paddy', cropName: 'Paddy', yieldKgPerHa: 4000, phRange: null }).checks[0]!;
    expect(check).toMatchObject({ parameter: 'nitrogen_unspecified', label: 'Nitrogen (pool not printed)', rating: 'low', need: 'medium', verdict: 'watch', assumption: 'Pool not printed; rated as available N.' });
  });
});

// ------------------------------------------------------------------ Meta gate
// Round 3 review: stubs carry the rotation rule (pickPool leaves out avoid_after and same_family orders); no_rule keeps them all.
const stub = (cropId: string, rank: number, codes: string[], rule = 'no_rule') => ({ cropId, productId: `${cropId}-grain`, cropName: cropId[0]!.toUpperCase() + cropId.slice(1), productName: 'Grain', rank, reasonCodes: codes, rotation: { previousCropId: 'paddy', rule, note: null } }) as unknown as CropFitCandidate;
const POOL = ['maize', 'sorghum', 'groundnut', 'sunflower', 'sesame', 'cotton', 'onion', 'pigeon-pea', 'paddy'].map((c, i) => stub(c, i + 1, ['price_timing_strong', 'district_window', 'cost_not_sourced']));
const answer = (over: (p: { cropId: string; productId: string; headline: string; reasons: { code: string; text: string }[] }[]) => void = () => undefined) => {
  const picks = pickPool(POOL).slice(0, 3).map((c) => ({ cropId: c.cropId, productId: c.productId, headline: 'Strong harvest prices and a local sowing window', reasons: [{ code: 'price_timing_strong', text: 'Harvest usually falls in weeks of good prices.' }] }));
  over(picks);
  return { picks };
};

describe('crop fit: Meta gate (pure)', () => {
  it('accepts a valid answer and ranks the picks in Meta\'s order', () => {
    const g = gatePicks(answer(), pickPool(POOL));
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.picks.map((p) => [p.cropId, p.rank])).toEqual([['maize', 1], ['sorghum', 2], ['groundnut', 3]]);
  });
  it('rejects a foreign crop, a digit, an unknown or unsupported code, long texts and a wrong count', () => {
    const pool = pickPool(POOL);
    expect(pool).toHaveLength(8);
    const reason = (over: Parameters<typeof answer>[0]) => { const g = gatePicks(answer(over), pool); return g.ok ? 'ok' : g.reason; };
    expect(reason((p) => { p[0]!.cropId = 'paddy'; p[0]!.productId = 'paddy-grain'; })).toBe('foreign_crop'); // ninth by rank: outside the eight
    expect(reason((p) => { p[1]!.reasons[0]!.text = 'Harvest falls in 3 strong price weeks.'; })).toBe('digit_in_reason');
    expect(reason((p) => { p[1]!.headline = 'Top 3 pick'; })).toBe('digit_in_headline');
    expect(reason((p) => { p[2]!.reasons[0]!.code = 'nitrogen_boost'; })).toBe('unknown_reason_code');
    expect(reason((p) => { p[2]!.reasons[0]!.code = 'legume_after_heavy_feeder'; })).toBe('reason_code_not_supported');
    expect(reason((p) => { p[0]!.headline = 'one two three four five six seven eight nine ten eleven twelve thirteen'; })).toBe('headline_length');
    expect(reason((p) => { p[0]!.reasons[0]!.text = Array.from({ length: 21 }, () => 'word').join(' '); })).toBe('sentence_length');
    expect(reason((p) => { p[1]!.cropId = p[0]!.cropId; p[1]!.productId = p[0]!.productId; })).toBe('duplicate_pick');
    expect(reason((p) => { p.pop(); })).toBe('pick_count');
    expect(gatePicks({ picks: 'none' }, pool)).toEqual({ ok: false, reason: 'schema_mismatch' });
  });
  it('round 3: picks identify crop, product and intercrop system (candidateKey), and carry systemId', () => {
    const sole = stub('finger-millet', 1, ['price_timing_strong']);
    const companion = { systemId: 'fm-pp-8-1', cropId: 'pigeon-pea', productId: 'pigeon-pea-whole', cropName: 'Pigeon pea', productName: 'Whole', rowRatio: '8:1', arrangement: 'row', yieldShare: { main: { low: 0.8, high: 0.9 }, companion: { low: 0.3, high: 0.4 } }, shareBasis: 'sourced', yieldKgPerHa: null, yieldBasis: null, price: null, nitrogenCreditKgPerHa: null, source: null } as const;
    const inter = { ...stub('finger-millet', 2, ['district_window']), kind: 'intercrop', companion } as CropFitCandidate;
    const pool = [sole, inter, stub('maize', 3, ['price_timing_strong']), stub('onion', 4, ['water_fit_good'])];
    const ok = gatePicks({ picks: [inter, sole, pool[2]!].map((c) => ({ candidateKey: candidateKey(c), headline: 'A good fit for this field', reasons: [{ code: c.reasonCodes[0]!, text: 'Fits the field.' }] })) }, pool);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.picks.map((p) => [p.cropId, p.systemId])).toEqual([['finger-millet', 'fm-pp-8-1'], ['finger-millet', null], ['maize', null]]);
    // Crop and product alone cannot tell sole finger millet from the intercrop.
    expect(gatePicks({ picks: [sole, pool[2]!, pool[3]!].map((c) => ({ cropId: c.cropId, productId: c.productId, headline: 'A good fit', reasons: [{ code: c.reasonCodes[0]!, text: 'Fits the field.' }] })) }, pool)).toEqual({ ok: false, reason: 'ambiguous_candidate' });
    const schema = picksSchema(pool).shape.picks.element.shape.candidateKey;
    expect(schema.options).toEqual(['finger-millet|finger-millet-grain', 'finger-millet|finger-millet-grain|fm-pp-8-1', 'maize|maize-grain', 'onion|onion-grain']);
    expect(deterministicPicks(pool).map((p) => p.systemId)).toEqual([null, null, null]);
  });

  it('review: the pick pool leaves out avoid_after and same_family orders while three others remain; Meta cannot pick them', () => {
    const ranked = POOL.map((c) => (c.cropId === 'maize' ? stub('maize', 1, c.reasonCodes, 'avoid_after') : c.cropId === 'groundnut' ? stub('groundnut', 3, c.reasonCodes, 'same_family') : c));
    const pool = pickPool(ranked);
    expect(pool.map((c) => c.cropId)).toEqual(['sorghum', 'sunflower', 'sesame', 'cotton', 'onion', 'pigeon-pea', 'paddy']);
    expect(pool.some(isPrunedOrder)).toBe(false);
    expect(deterministicPicks(pool).map((p) => [p.cropId, p.rank])).toEqual([['sorghum', 1], ['sunflower', 2], ['sesame', 3]]);
    const pick = (c: CropFitCandidate) => ({ cropId: c.cropId, productId: c.productId, headline: 'Strong harvest prices', reasons: [{ code: 'price_timing_strong', text: 'Harvest usually falls in weeks of good prices.' }] });
    expect(gatePicks({ picks: pool.slice(0, 3).map(pick) }, pool).ok).toBe(true);
    expect(gatePicks({ picks: [ranked[0]!, pool[0]!, pool[1]!].map(pick) }, pool)).toEqual({ ok: false, reason: 'foreign_crop' }); // maize: a pruned order
  });
  it('review: pruned orders fill the pool only when fewer than three others remain, and come after the others', () => {
    const codes = ['price_timing_strong'];
    const c = [stub('maize', 1, codes, 'avoid_after'), stub('sorghum', 2, codes), stub('groundnut', 3, codes, 'same_family'), stub('sunflower', 4, codes, 'avoid_after'), stub('sesame', 5, codes)];
    const pool = pickPool(c);
    expect(pool.map((x) => x.cropId)).toEqual(['sorghum', 'sesame', 'maize']); // two others plus the best-ranked pruned one
    expect(deterministicPicks(pool).map((p) => [p.cropId, p.rank])).toEqual([['sorghum', 1], ['sesame', 2], ['maize', 3]]);
    expect(pickPool(c.filter(isPrunedOrder)).map((x) => x.cropId)).toEqual(['maize', 'groundnut', 'sunflower']);
    expect(pickPool([...c, stub('cotton', 6, codes)]).map((x) => x.cropId)).toEqual(['sorghum', 'sesame', 'cotton']); // three others: no fallback
  });

  it('deterministic picks: best score first, one product per crop first, digit-free headlines, positive reasons only', () => {
    const pool = [stub('chilli', 1, ['price_timing_strong']), { ...stub('chilli', 2, ['district_window']), productId: 'chilli-dry' } as CropFitCandidate, stub('maize', 3, ['cost_not_sourced']), stub('onion', 4, ['water_fit_good'])];
    const picks = deterministicPicks(pool);
    expect(picks.map((p) => [p.cropId, p.rank])).toEqual([['chilli', 1], ['maize', 2], ['onion', 3]]);
    expect(picks.every((p) => !/\d/.test(p.headline) && p.headline.split(' ').length <= 12)).toBe(true);
    expect(picks[1]!.reasons).toEqual([]);
    expect(picks[2]!.reasons.map((r) => r.code)).toEqual(['water_fit_good']);
  });
});

describe('crop fit: price now (pure aggregation)', () => {
  const row = (date: string, market: string, modal: number, district = 'Hassan') => ({ date, modal, marketKey: `karnataka|${market}`, stateKey: 'karnataka', districtKey: district.toLowerCase() });
  it('uses the district when it has enough trading days, the last 14 trading days only, medians of market-day values', () => {
    const days = Array.from({ length: 16 }, (_, i) => addDays('2026-10-01', i));
    const rows = [...days.map((d, i) => row(d, 'hassan', i < 2 ? 1000 : 20)), row(days[15]!, 'arsikere', 30), row(days[15]!, 'mysuru', 99, 'Mysuru')];
    const now = marketNowFromRows(rows, { stateName: 'Karnataka', districtName: 'Hassan' })!;
    expect(now).toMatchObject({ p50: 20, date: '2026-10-16', markets: 2 });
    expect(now.scopeLabel).toMatch(/^Hassan district mandis, last 14 trading days/);
    const state = marketNowFromRows([row('2026-10-10', 'hassan', 20), row('2026-10-11', 'mysuru', 40, 'Mysuru')], { stateName: 'Karnataka', districtName: 'Hassan' })!;
    expect(state).toMatchObject({ p50: 30, markets: 2 });
    expect(state.scopeLabel).toMatch(/^Karnataka mandis/);
    expect(marketNowFromRows([], { stateName: 'Karnataka', districtName: 'Hassan' })).toBeNull();
  });
});

// ------------------------------------------------------------------ service (test DB)
let h: Harness, a: Client;
beforeAll(async () => { h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); });
afterAll(async () => h?.close());

const RAIN_DAYS = (start: string, end: string) => { const out = []; for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400_000) { const d = new Date(t).toISOString().slice(0, 10); const m = Number(d.slice(5, 7)); out.push({ date: d, rainMm: m >= 6 && m <= 10 ? 6 : 0.5, et0Mm: null, tMaxC: null, tMinC: null, sourceId: 'synthetic' }); } return out; };
const sources: CropFitDeps['sources'] = {
  priceOutlook: async (x) => fakeOutlook(x),
  climatology: async (_s, range) => ({ years: { from: 2016, to: 2025 }, sourceId: 'synthetic-normals', days: RAIN_DAYS(range.start, range.end) }),
  neighbourhood: async () => { throw new Error('ndvi unavailable in test'); },
  marketNow: async () => ({ p50: 22.5, date: '2026-10-30', markets: 4, scopeLabel: 'Synthetic mandis, last 14 trading days' }),
};
const deps = (over: Partial<CropFitDeps> = {}): CropFitDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW, sources, ...over });
const liveDeps = (provider: TextModelProvider) => deps({ config: { ...h.config, RUNTIME_MODE: 'live', MODEL_API_KEY: 'fixture-key' }, provider });
const MAY = { mode: 'date' as const, sowing: '2027-05-17' };

async function farm() {
  const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Crop fit QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data as { id: string };
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  return { f, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
const jobsOf = async (farmId: string) => (await h.pool.query<{ idempotency_key: string; max_attempts: number }>("SELECT idempotency_key,max_attempts FROM jobs WHERE type='farm.crop-fit' AND payload->>'farmId'=$1 ORDER BY created_at", [farmId])).rows;
async function confirmSoil(ownerId: string, farmId: string, value: number) {
  const report = (await h.pool.query<{ id: string }>("INSERT INTO soil_reports(owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,'field_report',$3,'confirmed','r.pdf','application/pdf',1,$4,'k') RETURNING id", [ownerId, farmId, h.config.RUNTIME_MODE, randomUUID()])).rows[0]!;
  const sample = (await h.pool.query<{ id: string }>("INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,collection_date) VALUES($1,$2,$3,'s1',1,'2026-09-20') RETURNING id", [ownerId, farmId, report.id])).rows[0]!;
  await h.pool.query("INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,'m-ph','ph','pH',$2,'pH',$3,'exact','soil',1,'pH','matched','high','[]'::jsonb,$3,'pH')", [sample.id, String(value), value]);
}

/** Confirmed laboratory markers (parameter, value, unit) in one sample of a confirmed field report. */
async function confirmMarkers(ownerId: string, farmId: string, markers: readonly (readonly [string, number, string, string])[]) {
  const report = (await h.pool.query<{ id: string }>("INSERT INTO soil_reports(owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,'field_report',$3,'confirmed','r.pdf','application/pdf',1,$4,'k') RETURNING id", [ownerId, farmId, h.config.RUNTIME_MODE, randomUUID()])).rows[0]!;
  const sample = (await h.pool.query<{ id: string }>("INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,collection_date) VALUES($1,$2,$3,'s1',1,'2026-09-20') RETURNING id", [ownerId, farmId, report.id])).rows[0]!;
  for (const [i, [parameter, value, unit, label]] of markers.entries())
    await h.pool.query("INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,$2,$3,$4,$5,$6,$7,'exact','soil',1,$4,'matched','high','[]'::jsonb,$7,$6)", [sample.id, `m-${i}`, parameter, label, String(value), unit, value]);
}

describe('crop fit service (test DB)', () => {
  it('synthetic: concurrent GETs converge on one pending row and one job (key cropfit:<farm>:<hash>); the job stores a ready review with calculated picks and no model call', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const [one, two] = await Promise.all([ensureCropFit(d, auth, f.id, MAY), ensureCropFit(d, auth, f.id, MAY)]);
    expect(one.reviewId).toBe(two.reviewId);
    expect(one).toMatchObject({ status: 'pending', resolvedSowing: '2027-05-17', request: { mode: 'date', season: null, sowing: '2027-05-17' } });
    const jobs = await jobsOf(f.id);
    expect(jobs).toEqual([{ idempotency_key: `cropfit:${f.id}:${one.contextHash}`, max_attempts: 1 }]);
    await generateCropFit(d, one.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, MAY);
    expect(CropFitReview.safeParse(review).success).toBe(true);
    expect(review).toMatchObject({ reviewId: one.reviewId, status: 'ready', pickOrigin: 'deterministic', stale: false, fieldAreaHa: 1.5 });
    expect(review.picks).toHaveLength(3);
    expect(review.candidates.length).toBeGreaterThanOrEqual(8);
    expect(review.candidates.map((c) => c.rank)).toEqual(review.candidates.map((_, i) => i + 1));
    const maize = review.candidates.find((c) => c.cropId === 'maize')!;
    expect(maize).toMatchObject({ sowing: '2027-05-22', window: { shiftedDays: 5 }, marketNow: { p50: 22.5 } });
    expect(maize.reasonCodes).toContain('window_shifted');
    const withProfit = review.candidates.find((c) => c.profitPerHa && c.profitForField)!;
    const p = withProfit.profitPerHa!;
    expect(p.possible.low <= p.likely.low && p.likely.low <= p.central && p.central <= p.likely.high && p.likely.high <= p.possible.high).toBe(true);
    expect(Math.abs(withProfit.profitForField!.central - p.central * 1.5)).toBeLessThanOrEqual(200);
    expect(review.candidates.every((c) => c.soil.status === 'no_report')).toBe(true);
    expect(review.limitations.some((l) => l.startsWith('Meta is not used in this runtime mode'))).toBe(true);
    expect(review.limitations.some((l) => l.startsWith(MODEL_UNAVAILABLE))).toBe(false);
    expect(await jobsOf(f.id)).toHaveLength(1);
    expect(Number((await h.pool.query('SELECT count(*) FROM ai_invocations WHERE owner_id=$1', [auth.ownerId])).rows[0].count)).toBe(0);
    // Same inputs again: same numbers (seeded simulation).
    const forced = await ensureCropFit(d, auth, f.id, MAY, { force: true });
    expect(forced.reviewId).not.toBe(one.reviewId);
    await generateCropFit(d, forced.reviewId!, auth.ownerId);
    const again = await ensureCropFit(d, auth, f.id, MAY);
    expect(again.candidates.map((c) => c.profitPerHa)).toEqual(review.candidates.map((c) => c.profitPerHa));
    expect((await jobsOf(f.id)).map((j) => j.idempotency_key)).toEqual([`cropfit:${f.id}:${one.contextHash}`, `cropfit:${f.id}:${one.contextHash}:r2`]);
    expect((await h.pool.query('SELECT archived_at FROM crop_fit_reviews WHERE id=$1', [one.reviewId])).rows[0].archived_at).not.toBeNull();
  });

  it('the context hash changes on a workspace change and on a soil confirmation; the next GET re-plans and archives the old row', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const first = await ensureCropFit(d, auth, f.id, MAY);
    const h0 = (await fitContext(d, auth.ownerId, f.id, MAY)).hash;
    expect(h0).toBe(first.contextHash);
    const ws = await getWorkspace(h.pool, auth.ownerId, f.id);
    await putWorkspace(h.pool, auth.ownerId, f.id, { expectedVersion: ws.version, boundary: null, previousHarvest: { status: 'none' }, cycles: [], rotationPlans: [] } as never);
    const h1 = (await fitContext(d, auth.ownerId, f.id, MAY)).hash;
    expect(h1).not.toBe(h0);
    await confirmSoil(auth.ownerId, f.id, 6.1);
    const c2 = await fitContext(d, auth.ownerId, f.id, MAY);
    expect(c2.hash).not.toBe(h1);
    expect(c2.soilReportStatus).toBe('confirmed');
    expect((await fitContext(d, auth.ownerId, f.id, { mode: 'season', season: 'kharif' })).hash).not.toBe(c2.hash);
    const second = await ensureCropFit(d, auth, f.id, MAY);
    expect(second.reviewId).not.toBe(first.reviewId);
    expect((await h.pool.query('SELECT archived_at FROM crop_fit_reviews WHERE id=$1', [first.reviewId])).rows[0].archived_at).not.toBeNull();
    // Another request on the same farm is cached separately (not archived by this one).
    const kharif = await ensureCropFit(d, auth, f.id, { mode: 'season', season: 'kharif' });
    expect((await h.pool.query('SELECT archived_at FROM crop_fit_reviews WHERE id=$1', [second.reviewId])).rows[0].archived_at).toBeNull();
    await generateCropFit(d, kharif.reviewId!, auth.ownerId);
    const ready = await ensureCropFit(d, auth, f.id, { mode: 'season', season: 'kharif' });
    expect(ready.status).toBe('ready');
    // Round 3: season = the year plan's sowing weeks of that season, best week per crop by score (maize kharif window 22 May to 30 Jun).
    const maizeSowing = ready.candidates.find((c) => c.cropId === 'maize')!.sowing;
    expect(maizeSowing >= '2027-05-22' && maizeSowing <= '2027-06-30').toBe(true);
    expect(ready.candidates.every((c) => c.rankScore === c.score && c.waitPenalty === 0 && c.window?.season === 'kharif')).toBe(true);
    expect(ready.resolvedSowing).toBe([...ready.candidates].sort((x, y) => x.sowing.localeCompare(y.sowing))[0]!.sowing);
    expect(ready.candidates.every((c) => c.soil.status === 'compared' && c.soil.checks.some((s) => s.parameter === 'ph'))).toBe(true);
  });

  it('live, provider failure: the review is still ready with the calculated top three and a "Model unavailable" limitation', async () => {
    const { f, auth } = await farm();
    const provider: TextModelProvider = { kind: 'meta', provenance: 'meta_live', billable: false, call: vi.fn(async () => ({ ok: false as const, error: { code: 'provider_unavailable' as const, message: 'down', retryable: true, outcomeUncertain: false } })) } as unknown as TextModelProvider;
    const d = liveDeps(provider);
    const r = await ensureCropFit(d, auth, f.id, MAY);
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, MAY);
    expect(review).toMatchObject({ status: 'ready', pickOrigin: 'deterministic' });
    expect(review.picks).toHaveLength(3);
    expect(review.limitations.some((l) => l.startsWith(`${MODEL_UNAVAILABLE} (provider_provider_unavailable)`))).toBe(true);
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('live, Meta: valid picks are kept (store false, reasoning low, response deleted); a digit in a reason falls back to code', async () => {
    const make = (mode: 'valid' | 'digit') => {
      const calls: { input: string; store: unknown; effort: unknown }[] = [];
      const provider = {
        kind: 'meta', provenance: 'meta_live', billable: false,
        call: vi.fn(async (req: { input: unknown; store?: unknown; reasoningEffort?: unknown }) => {
          calls.push({ input: String(req.input), store: req.store, effort: req.reasoningEffort });
          const input = JSON.parse(String(req.input)) as { candidates: { candidateKey: string; reasonCodes: string[] }[] };
          const picks = input.candidates.slice(1, 4).map((c) => ({ candidateKey: c.candidateKey, headline: 'A good fit for this sowing date', reasons: [{ code: c.reasonCodes[0]!, text: mode === 'digit' ? 'Sow within 2 weeks.' : 'Fits the sowing date and the field.' }] }));
          return { ok: true as const, result: { provenance: 'meta_live' as const, responseId: `resp-${mode}`, requestId: 'req', model: 'fixture-received-model', outputText: JSON.stringify({ picks }), functionCalls: [], usage: { inputTokens: 900, outputTokens: 150, cachedInputTokens: 0 }, latencyMs: 1, retries: 0 } };
        }),
        deleteResponse: vi.fn(async () => ({ ok: true, code: null })),
      };
      return { provider: provider as unknown as TextModelProvider & { deleteResponse: ReturnType<typeof vi.fn> }, calls };
    };
    const { f, auth } = await farm();
    const meta = make('valid');
    const d = liveDeps(meta.provider);
    const r = await ensureCropFit(d, auth, f.id, MAY);
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, MAY);
    expect(review).toMatchObject({ status: 'ready', pickOrigin: 'model' });
    expect(review.picks.map((p) => p.cropId)).toEqual(review.candidates.slice(1, 4).map((c) => c.cropId));
    expect(review.picks.every((p) => p.reasons[0]!.text === 'Fits the sowing date and the field.')).toBe(true);
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toMatchObject({ store: false, effort: 'low' });
    expect(meta.calls[0]!.input).not.toMatch(/13\.0|76\.1/); // district only, never the farm point
    expect(JSON.parse(meta.calls[0]!.input).candidates).toHaveLength(8);
    expect(meta.provider.deleteResponse).toHaveBeenCalledWith('resp-valid');

    const other = await farm();
    const bad = make('digit');
    const d2 = liveDeps(bad.provider);
    const r2 = await ensureCropFit(d2, other.auth, other.f.id, MAY);
    await generateCropFit(d2, r2.reviewId!, other.auth.ownerId);
    const fallback = await ensureCropFit(d2, other.auth, other.f.id, MAY);
    expect(fallback).toMatchObject({ status: 'ready', pickOrigin: 'deterministic' });
    expect(fallback.limitations.some((l) => l.startsWith(`${MODEL_UNAVAILABLE} (gate_digit_in_reason)`))).toBe(true);
    expect(bad.provider.deleteResponse).toHaveBeenCalledWith('resp-digit');
  });

  it('a date with no window nearby stores an unavailable review with the reasons', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const r = await ensureCropFit(d, auth, f.id, { mode: 'date', sowing: '2026-11-03' });
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { mode: 'date', sowing: '2026-11-03' });
    expect(CropFitReview.safeParse(review).success).toBe(true);
    expect(review).toMatchObject({ status: 'unavailable', candidates: [], picks: [] });
    expect(review.summary).toMatch(/within 21 days of 3 Nov 2026/);
    expect(review.limitations.some((l) => /^Not ranked \(.*maize.*\): No sourced sowing window within 21 days/.test(l))).toBe(true);
  });
});

// ------------------------------------------------------------------ round 3: one scoring for crop fit and the year plan
/**
 * ROUND3_SPEC 5 acceptance. Hassan-like field: paddy growing, the field free on 25 March 2027 (stage timeline harvest by
 * 15 March + buffer + land preparation). Prices are SYNTHETIC: 25 INR/kg for every product unless overridden.
 */
const RELEASE = '2027-03-25';
const RELEASE_LATEST = addDays(RELEASE, -(ASSUMPTIONS.timelineHarvestBufferDays.value + ASSUMPTIONS.landPrepGapDays.value));
const releaseTimeline = (i: { cropId: string; productId: string | null; anchorDate: string }): StageTimeline => ({ ...timeline(i), harvest: { earliest: addDays(RELEASE_LATEST, -20), latest: RELEASE_LATEST } });
const PADDY_GROWING = { id: 'cyc-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-10-15', stage: 'growing' as const };
const hassanGrowing = (horizonFrom?: string): EngineContext =>
  buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [PADDY_GROWING], rotationPlans: [] } as never, farm: HASSAN, asOf: ASOF, timeline: releaseTimeline, ...(horizonFrom ? { horizonFrom } : {}) });
function pricedInputs(ctx: EngineContext, keys: readonly { key: string; productId: string; harvestDate: string }[], priceOf: (productId: string) => number = () => 25) {
  const inputs = emptyInputs(ASOF, ctx.irrigation);
  for (const k of keys) {
    const p = priceOf(k.productId);
    inputs.priceOutlooks.set(k.key, { ...fakeOutlook({ productId: k.productId, harvestDate: k.harvestDate, asOf: ASOF }), p10: p * 0.7, p25: p * 0.8, p50: p, p75: p * 1.2, p90: p * 1.3, annualMean: p } as HarvestPriceOutlook);
  }
  return inputs;
}
const NEXT = { mode: 'next' as const, season: null, sowing: null };

describe('crop fit round 3: the year plan candidates, normaliser and scores (pure, real research files)', () => {
  it('equality: crop fit score equals the year plan slot score for the same crop, product and sowing on one context', () => {
    const ctx = hassanGrowing();
    expect(ctx.earliestSowing).toBe(RELEASE);
    const set = enumerateCandidates(ctx);
    const inputs = pricedInputs(ctx, runInputKeys(ctx, set), (p) => (p.startsWith('pigeon-pea') ? 60 : 25));
    const run = runYearPlanEngine(ctx, inputs, { candidateSet: set });
    // The same normaliser: marginNormaliser over the plan's candidate set.
    expect(marginNormaliser(ctx, set.candidates, inputs)).toEqual(run.norm);
    const scored = scorePlacements(ctx, inputs, planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { norm: run.norm, waitFrom: ctx.earliestSowing, penaliseWait: true });
    let compared = 0;
    let intercrops = 0;
    for (const o of [...run.options, ...run.shortlist]) {
      const s = o.slots.find((x) => !x.fixed);
      if (!s || s.kind === 'green_manure') continue;
      const system = s.kind === 'intercrop' ? (s as { companion?: { systemId: string } | null }).companion?.systemId ?? null : null;
      const hit = scored.find((c) => c.plan.cropId === s.cropId && c.plan.productId === s.productId && c.plan.sowing === s.sowing && intercropSystemOf(c.plan) === system && (c.plan.method ?? null) === (s.establishmentMethod ?? null) && c.plan.durationDays.low === s.durationDays.low && c.plan.durationDays.high === s.durationDays.high);
      expect(hit, `${s.cropId} ${s.sowing}`).toBeDefined();
      expect(hit!.score).toBe(s.score);
      expect(hit!.components).toEqual(s.components);
      compared++;
    }
    // Every crop and intercrop candidate scored by the plan's own option builder as a one-slot plan after the growing crop.
    const sole = set.candidates.filter((c) => c.kind !== 'green_manure');
    const asPlans = scoreSequences(ctx, sole.map((c) => ({ sequenceId: c.candidateId, slots: [c] })), inputs, { norm: run.norm });
    expect(asPlans).toHaveLength(sole.length);
    for (const o of asPlans) {
      const s = o.slots.find((x) => !x.fixed)!;
      const system = s.kind === 'intercrop' ? (s as { companion?: { systemId: string } | null }).companion?.systemId ?? null : null;
      const hits = scored.filter((c) => c.plan.cropId === s.cropId && c.plan.productId === s.productId && c.plan.sowing === s.sowing && intercropSystemOf(c.plan) === system && (c.plan.method ?? null) === (s.establishmentMethod ?? null) && c.plan.durationDays.low === s.durationDays.low && c.plan.durationDays.high === s.durationDays.high);
      expect(hits.length, `${s.cropId} ${s.sowing}`).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.score, `${s.cropId} ${s.sowing}`).toBe(s.score);
        if (system) { expect(companionOf(hit)).toEqual((s as { companion?: unknown }).companion); intercrops++; } // same companion block as the plan slot
      }
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(sole.length);
    expect(intercrops).toBeGreaterThan(0); // Hassan has a maize + soybean system in intercropping.json
  });

  it('review HIGH-1: an intercrop candidate carries the plan slot\'s two-product profit and the field yield at the main share', () => {
    const ctx = hassanGrowing();
    const set = enumerateCandidates(ctx);
    const inputs = pricedInputs(ctx, runInputKeys(ctx, set), (p) => (p.startsWith('pigeon-pea') ? 60 : 25));
    const norm = marginNormaliser(ctx, set.candidates, inputs);
    const scored = scorePlacements(ctx, inputs, planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { norm, waitFrom: ctx.earliestSowing, penaliseWait: true });
    const systems = set.candidates.filter((c) => c.kind === 'intercrop');
    expect(systems.length).toBeGreaterThan(0);
    const area = ctx.scenario.fieldAreaHa ?? null;
    expect(area).toBe(0.16);
    const extras = { marketNow: null, facts: [], phRange: null, seed: 'review-high-1', areaHa: area, soil: { farmId: randomUUID(), samples: [], limitations: [] } };
    let priced = 0;
    let scaled = 0;
    for (const o of scoreSequences(ctx, systems.map((c) => ({ sequenceId: c.candidateId, slots: [c] })), inputs, { norm })) {
      const s = o.slots.find((x) => !x.fixed)!;
      const system = (s as { companion?: { systemId: string } | null }).companion?.systemId ?? null;
      expect(system).not.toBeNull();
      const hits = scored.filter((c) => c.plan.cropId === s.cropId && c.plan.productId === s.productId && c.plan.sowing === s.sowing && intercropSystemOf(c.plan) === system && (c.plan.method ?? null) === (s.establishmentMethod ?? null) && c.plan.durationDays.low === s.durationDays.low && c.plan.durationDays.high === s.durationDays.high);
      expect(hits.length, `${system} ${s.sowing}`).toBeGreaterThan(0);
      for (const hit of hits) {
        const cand = toCandidate(hit, 1, extras);
        expect(cand.kind).toBe('intercrop');
        expect(cand.profitPerHa, `${system} ${s.sowing}`).toEqual(s.profitEstimate ?? null);
        expect(cand.profitForField, `${system} ${s.sowing}`).toEqual(s.profitForField ?? null);
        expect(cand.yieldForFieldKg, `${system} ${s.sowing}`).toEqual(s.yieldForFieldKg ?? null);
        if (cand.profitPerHa && cand.profitForField) priced++;
        if (cand.yieldKgPerHa && cand.yieldForFieldKg && cand.yieldForFieldKg.high < Math.round(cand.yieldKgPerHa.high * area!)) scaled++;
      }
    }
    expect(priced).toBeGreaterThan(0); // both products priced: the plan's estimateProfitMulti result, not a sole-crop recomputation
    expect(scaled).toBeGreaterThan(0); // the main share is below one
  });

  it('next: best sowing week per crop by score less the wait penalty; pigeon pea in May ranks above sorghum in April', () => {
    const ctx = hassanGrowing();
    const set = enumerateCandidates(ctx);
    const inputs = pricedInputs(ctx, runInputKeys(ctx, set), (p) => (p.startsWith('pigeon-pea') ? 120 : 25));
    const norm = marginNormaliser(ctx, set.candidates, inputs);
    const ranked = rankCandidates(ctx, inputs, planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { norm, waitFrom: ctx.earliestSowing, penaliseWait: true });
    const pigeon = ranked.find((c) => c.plan.cropId === 'pigeon-pea')!;
    const sorghum = ranked.find((c) => c.plan.cropId === 'sorghum')!;
    expect(pigeon.plan.sowing.slice(0, 7)).toBe('2027-05');
    expect(sorghum.plan.sowing.slice(0, 7)).toBe('2027-04');
    expect(pigeon.waitPenalty).toBeGreaterThan(sorghum.waitPenalty);
    expect(ranked.indexOf(pigeon)).toBeLessThan(ranked.indexOf(sorghum));
    // Green manures are not crop fit candidates; one entry per crop and product.
    expect(ranked.some((c) => c.plan.kind === 'green_manure')).toBe(false);
    expect(new Set(ranked.map((c) => `${c.plan.cropId}|${c.plan.productId}|${intercropSystemOf(c.plan) ?? ''}`)).size).toBe(ranked.length);
    const { perMonth, freeMonths } = ASSUMPTIONS.idlePenalty.value;
    for (const c of ranked) {
      expect(c.waitDays).toBe(daysBetween(RELEASE, c.plan.sowing));
      expect(c.waitPenalty).toBeCloseTo(100 * perMonth * Math.max(0, c.waitDays! / ASSUMPTIONS.daysPerMonth.value - freeMonths), 2);
      expect(c.waitPenalty).toBe(waitPenaltyFor(c.waitDays!));
      expect(c.rankScore).toBeCloseTo(c.score - c.waitPenalty, 2);
    }
    expect(ranked.map((c) => c.rankScore)).toEqual([...ranked.map((c) => c.rankScore)].sort((a, b) => b - a));
    // With even prices the penalty reorders: some crop with a higher score ranks below one that can be sown sooner.
    const flat = pricedInputs(ctx, runInputKeys(ctx, set));
    const even = rankCandidates(ctx, flat, planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { norm: marginNormaliser(ctx, set.candidates, flat), waitFrom: ctx.earliestSowing, penaliseWait: true });
    expect(even.some((c, i) => even.slice(i + 1).some((d) => d.score > c.score))).toBe(true);
    expect(waitPenaltyFor(0)).toBe(0);
    expect(waitPenaltyFor(15)).toBe(0); // inside the free half month
  });

  it('season keeps that season\'s plan weeks within 12 months of the floor; date gains after (previous-crop override)', () => {
    const ctx = hassanGrowing();
    const set = enumerateCandidates(ctx);
    const kharif = planCandidates(ctx, resolveMode(ctx, { mode: 'season', season: 'kharif', sowing: null }), set);
    expect(kharif.placed.length).toBeGreaterThan(0);
    expect(kharif.placed.every((p) => p.plan.season === 'kharif' && p.plan.sowing >= RELEASE && p.plan.sowing < addDays(RELEASE, 365) && p.plan.kind !== 'green_manure')).toBe(true);
    // after: date mode only, a crop id; other modes drop it.
    expect(normaliseRequest({ mode: 'date', sowing: '2027-05-17', after: 'pigeon-pea' }, true, ASOF)).toEqual({ mode: 'date', season: null, sowing: '2027-05-17', after: 'pigeon-pea' });
    expect(normaliseRequest({ mode: 'next', after: 'pigeon-pea' }, true, ASOF)).toEqual({ mode: 'next', season: null, sowing: null });
    expect(() => normaliseRequest({ mode: 'date', sowing: '2027-05-17', after: 'Pigeon Pea!' }, true, ASOF)).toThrow(/crop id/);
    expect(requestKey({ mode: 'date', season: null, sowing: '2027-05-17', after: 'pigeon-pea' })).not.toBe(requestKey({ mode: 'date', season: null, sowing: '2027-05-17' }));
    const r = resolveMode(ctx, normaliseRequest({ mode: 'date', sowing: '2027-05-17', after: 'pigeon-pea' }, true, ASOF));
    expect(r.previousCropId).toBe('pigeon-pea');
    const { placed } = placeCandidates(ctx, r);
    const ranked = rankCandidates(ctx, inputsFor(ctx, placed), placed, { previousOverride: r.previousOverride, waitFrom: r.target });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((c) => c.previousCropId === 'pigeon-pea' && c.waitPenalty === 0 && c.rankScore === c.score)).toBe(true);
    const own = rankCandidates(ctx, inputsFor(ctx, placed), placed, { waitFrom: r.target });
    expect(own.every((c) => c.previousCropId === 'paddy')).toBe(true);
  });

  it('season covers 12 months from the floor: rabi windows after the plan horizon end are enumerated and scored on the same basis', () => {
    const ctx = hassanGrowing();
    const resolved = resolveMode(ctx, { mode: 'season', season: 'rabi', sowing: null });
    const planSet = enumerateCandidates(ctx);
    const inPlan = planCandidates(ctx, resolved, planSet).placed;
    const wide = seasonContext(ctx, resolved.floor, hassanGrowing(ctx.horizon.to));
    expect(wide.horizon).toEqual({ from: ctx.horizon.from, to: addDays(RELEASE, 366) });
    expect(wide.earliestSowing).toBe(ctx.earliestSowing);
    const wideSet = enumerateCandidates(wide);
    const placed = planCandidates(wide, resolved, wideSet).placed;
    expect(placed.length).toBeGreaterThan(inPlan.length);
    const after = placed.filter((p) => p.plan.sowing >= ctx.horizon.to);
    expect(after.length).toBeGreaterThan(0); // rabi windows opening after the plan horizon end (15 Oct 2027)
    expect(placed.every((p) => p.plan.season === 'rabi' && p.plan.sowing >= RELEASE && p.plan.harvest.latest < wide.horizon.to)).toBe(true);
    const inputs = pricedInputs(wide, runInputKeys(wide, wideSet));
    const norm = marginNormaliser(wide, wideSet.candidates, inputs);
    const ranked = rankCandidates(wide, inputs, placed, { norm, waitFrom: resolved.floor });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((c) => c.waitPenalty === 0 && c.rankScore === c.score && c.waitDays === daysBetween(RELEASE, c.plan.sowing))).toBe(true);
    // A candidate inside the plan horizon scores the same in the widened context (same functions and normaliser).
    const kharif = planCandidates(ctx, resolveMode(ctx, { mode: 'season', season: 'kharif', sowing: null }), planSet).placed.slice(0, 5);
    expect(scorePlacements(wide, inputs, kharif, { norm }).map((c) => c.score)).toEqual(scorePlacements(ctx, inputs, kharif, { norm }).map((c) => c.score));
    // A context already reaching 366 days past the floor is returned unchanged.
    expect(seasonContext(wide, resolved.floor, null)).toBe(wide);
  });

  it('grownBefore counts recorded cycles and a known previous harvest', () => {
    const history = { cycles: [{ id: 'a', cropId: 'sorghum', sowingDate: '2024-06-01', stage: 'harvested', harvestDate: '2024-10-01' }, { id: 'b', cropId: 'sorghum', sowingDate: '2025-06-03', stage: 'harvested', harvestDate: '2025-10-04' }], previousHarvest: { status: 'known', cropId: 'maize', harvestDate: '2023-10-01' } } as never;
    expect(grownBeforeOf(history, 'sorghum')).toEqual({ cycles: 2, lastSowing: '2025-06-03', lastHarvest: '2025-10-04' });
    expect(grownBeforeOf(history, 'maize')).toEqual({ cycles: 1, lastSowing: null, lastHarvest: '2023-10-01' });
    expect(grownBeforeOf(history, 'onion')).toBeNull();
  });
});

describe('crop fit round 3 service (test DB)', () => {
  it('next lists yearPlanLabels from the ready, current year plan and names the rank of its Best overall crop; a stale plan is ignored', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const before = (await fitContext(d, auth.ownerId, f.id, { mode: 'next' })).hash;
    const yp = await yearPlanContext({ pool: h.pool, config: h.config }, auth.ownerId, f.id, ASOF);
    const slot = (cropId: string, productId: string, cropName: string, sowing: string) => ({ slotId: `slot-${cropId}`, fixed: false, kind: 'crop', cropId, productId, cropName, sowing });
    const options = [
      { optionId: 'opt-a', label: 'Best overall', slots: [slot('sorghum', 'sorghum-grain', 'Sorghum', '2027-04-01')] },
      { optionId: 'opt-b', label: 'Soil enrichment', slots: [slot('pigeon-pea', 'pigeon-pea-whole', 'Pigeon pea', '2027-05-16')] },
      { optionId: 'opt-c', label: 'Lowest water', slots: [slot('sorghum', 'sorghum-grain', 'Sorghum', '2027-04-08')] },
    ];
    const planId = randomUUID();
    await h.pool.query("INSERT INTO farm_year_plans(id,owner_id,farm_id,mode,context_hash,input_versions,input_context,result,status) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'{\"norm\":null}'::jsonb,$6::jsonb,'ready')",
      [planId, auth.ownerId, f.id, h.config.RUNTIME_MODE, yp.hash, JSON.stringify({ options })]);
    expect((await fitContext(d, auth.ownerId, f.id, { mode: 'next' })).hash).not.toBe(before); // a newly ready plan re-runs crop fit
    expect((await currentYearPlan(d, auth.ownerId, f.id, ASOF))?.id).toBe(planId);
    const r = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    expect(CropFitReview.safeParse(review).success).toBe(true);
    expect(review).toMatchObject({ status: 'ready', yearPlanReviewId: planId, request: { mode: 'next' } });
    const sorghum = review.candidates.find((c) => c.cropId === 'sorghum' && c.productId === 'sorghum-grain')!;
    const pigeon = review.candidates.find((c) => c.cropId === 'pigeon-pea' && c.productId === 'pigeon-pea-whole')!;
    expect(sorghum.yearPlanLabels).toEqual(['Best overall', 'Lowest water']);
    expect(pigeon.yearPlanLabels).toEqual(['Soil enrichment']);
    expect(review.candidates.filter((c) => c !== sorghum && c !== pigeon).every((c) => c.yearPlanLabels?.length === 0)).toBe(true);
    expect(review.summary).toContain(`The year plan's Best overall starts with sorghum (sown 1 Apr 2027), ranked ${sorghum.rank} of ${review.candidates.length} here.`);
    expect(review.summary).toContain(`Same candidates, dates and scoring as the year plan; ${PLAN_LABELS_NOTE}`);
    expect(review.limitations).toContain(`Same candidates, dates and scoring as the year plan; ${PLAN_LABELS_NOTE}.`);
    // Intercrops (P1's intercropping.json) are their own candidates with the companion; the sole crops carry the labels.
    expect(sorghum.kind).toBe('crop');
    expect(review.candidates.filter((c) => c.kind === 'intercrop').every((c) => !!c.companion?.systemId && c.companion.cropId !== c.cropId && (c.yearPlanLabels ?? []).length === 0)).toBe(true);
    expect(review.picks.every((p) => (p.systemId ?? null) === (review.candidates.find((c) => c.cropId === p.cropId && c.productId === p.productId && (c.companion?.systemId ?? null) === (p.systemId ?? null)) ? p.systemId ?? null : 'missing'))).toBe(true);
    for (const c of review.candidates) {
      expect(['crop', 'intercrop']).toContain(c.kind);
      expect(c.rankScore!).toBeCloseTo(c.score - c.waitPenalty!, 2);
      expect(c.waitDays).toBe(daysBetween(ASOF, c.sowing)); // fresh field: free from today
      const share = c.kind === 'intercrop' ? c.companion?.yieldShare.main ?? null : null; // round 3 review: the main crop's share of an intercrop
      if (c.yieldKgPerHa) expect(c.yieldForFieldKg).toEqual({ low: Math.round(c.yieldKgPerHa.low * (share?.low ?? 1) * 1.5), high: Math.round(c.yieldKgPerHa.high * (share?.high ?? 1) * 1.5) });
      expect(c.grownBefore).toBeNull();
    }
    expect(review.candidates.map((c) => c.rankScore)).toEqual([...review.candidates.map((c) => c.rankScore)].sort((a, b) => b! - a!));
    expect(review.candidates.length).toBeLessThanOrEqual(40);
    // A plan whose inputs no longer match is not used.
    await h.pool.query("UPDATE farm_year_plans SET context_hash='stale-hash' WHERE id=$1", [planId]);
    expect(await currentYearPlan(d, auth.ownerId, f.id, ASOF)).toBeNull();
  });

  it('season=rabi on a field under paddy returns the rabi weeks after the plan horizon, with the plan-horizon limitation', async () => {
    const { f, auth } = await farm();
    const d = deps({ timeline: releaseTimeline });
    const ws = await getWorkspace(h.pool, auth.ownerId, f.id);
    await putWorkspace(h.pool, auth.ownerId, f.id, { expectedVersion: ws.version, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [PADDY_GROWING], rotationPlans: [] } as never);
    const r = await ensureCropFit(d, auth, f.id, { mode: 'season', season: 'rabi' });
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { mode: 'season', season: 'rabi' });
    expect(review.status).toBe('ready');
    expect(review.candidates.length).toBeGreaterThan(0);
    expect(review.candidates.every((c) => c.window?.season === 'rabi' && c.sowing >= RELEASE && c.waitPenalty === 0)).toBe(true);
    expect(review.candidates.some((c) => c.harvest.latest >= '2027-10-15')).toBe(true); // past the plan horizon (15 Oct 2027)
    expect(review.limitations).toContain('Windows after the plan horizon are scored on the same basis; the year plan itself stops at 14 Oct 2027.');
  });

  it('date with after: scored after the given crop, cached as its own request', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const plain = await ensureCropFit(d, auth, f.id, MAY);
    const after = await ensureCropFit(d, auth, f.id, { ...MAY, after: 'pigeon-pea' });
    expect(after.reviewId).not.toBe(plain.reviewId);
    expect(after.contextHash).not.toBe(plain.contextHash);
    expect(after).toMatchObject({ request: { mode: 'date', sowing: '2027-05-17', after: 'pigeon-pea' }, previousCropId: 'pigeon-pea' });
    await generateCropFit(d, after.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { ...MAY, after: 'pigeon-pea' });
    expect(review.status).toBe('ready');
    expect(review.candidates.every((c) => c.rotation.previousCropId === 'pigeon-pea' && c.waitPenalty === 0 && c.rankScore === c.score)).toBe(true);
    expect(review.limitations.some((l) => l.startsWith('Scored after pigeon pea'))).toBe(true);
    // The plain request was not archived by the after request (different request key).
    expect((await h.pool.query('SELECT archived_at FROM crop_fit_reviews WHERE id=$1', [plain.reviewId])).rows[0].archived_at).toBeNull();
  });

  it('review HIGH-2: with a confirmed soil report rating N and K low (K2O short), crop fit scores equal the plan slot scores (yield v2 soil factor) through generateCropFit', async () => {
    const { f, auth } = await farm();
    await confirmMarkers(auth.ownerId, f.id, [['nitrogen_available', 110, 'kg/ha', 'Available nitrogen (N)'], ['potassium_available', 70, 'kg/ha', 'Available potassium (K2O)']]);
    const d = deps();
    const c = await fitContext(d, auth.ownerId, f.id, { mode: 'next' });
    expect(c.soilReportStatus).toBe('confirmed');
    const r = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    expect(review.status).toBe('ready');
    // The plan side: the year plan's own context and soil checks, inputs from the same synthetic sources, the job's normaliser.
    const yp = await yearPlanContext({ pool: h.pool, config: h.config }, auth.ownerId, f.id, ASOF);
    const ctx = yp.ctx;
    const set = enumerateCandidates(ctx);
    const keys = runInputKeys(ctx, set);
    const looked = spreadKeys(keys, YEAR_PLAN_PRICE_LOOKUP_CAP, []);
    const inputs = emptyInputs(ASOF, ctx.irrigation);
    for (const k of looked) { inputs.priceOutlooks.set(k.key, fakeOutlook({ productId: k.productId, harvestDate: k.harvestDate, asOf: ASOF })); inputs.annualMeans.set(k.productId, 24); }
    inputs.climatologyRainByMonth = monthlyRainFromDaily(RAIN_DAYS(ctx.horizon.from, addDays(ctx.horizon.to, -1)));
    inputs.climatologySource = { sourceId: 'synthetic-normals', years: { from: 2016, to: 2025 } };
    inputs.soilChecks = yp.soilChecks;
    const lookedSet = new Set(looked.map((k) => k.key));
    const normCandidates = looked.length < keys.length ? set.candidates.filter((x) => x.kind === 'green_manure' || lookedSet.has(slotPriceKey(x))) : set.candidates;
    const norm = (await h.pool.query<{ input_context: { norm: { source: string; value: ScoringNorm } } }>('SELECT input_context FROM crop_fit_reviews WHERE id=$1', [r.reviewId])).rows[0]!.input_context.norm;
    expect(norm.source).toBe('year_plan_candidates');
    expect(norm.value).toEqual(marginNormaliser(ctx, normCandidates, inputs)); // the reconstructed inputs are the job's
    const planScore = (x: (typeof set.candidates)[number], soil: boolean) =>
      scoreSequences(ctx, [{ sequenceId: x.candidateId, slots: [x] }], soil ? inputs : { ...inputs, soilChecks: null }, { norm: norm.value })[0]!.slots.find((s) => !s.fixed)!.score;
    let compared = 0;
    let soilMoved = 0;
    for (const cand of review.candidates) {
      const system = cand.kind === 'intercrop' ? cand.companion?.systemId ?? null : null;
      const xs = set.candidates.filter((x) => x.kind !== 'green_manure' && x.cropId === cand.cropId && x.productId === cand.productId && x.sowing === cand.sowing && intercropSystemOf(x) === system && (x.method ?? null) === (cand.establishmentMethod ?? null) && x.durationDays.low === cand.durationDays.low && x.durationDays.high === cand.durationDays.high);
      expect(xs.length, `${cand.cropId} ${cand.sowing}`).toBeGreaterThan(0);
      for (const x of xs) {
        expect(cand.score, `${cand.cropId} ${system ?? ''} ${cand.sowing}`).toBe(planScore(x, true));
        if (planScore(x, false) !== cand.score) soilMoved++;
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(soilMoved).toBeGreaterThan(0); // the soil factor moves plan scores, so the equality covers it
    // Synthetic markers rated by the real DAC 2011 bands: N 110 and K 70 kg/ha are low, so K2O is short for heavy feeders.
    expect(review.candidates.some((x) => x.soil.checks.some((k) => k.parameter === 'potassium_available' && k.verdict === 'short'))).toBe(true);
    expect(review.candidates.every((x) => x.soil.checks.find((k) => k.parameter === 'nitrogen_available')?.rating === 'low')).toBe(true);
  });

  it('review MEDIUM-3: a ready later-horizon plan neither changes the crop fit hash nor counts as the current plan', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const before = (await fitContext(d, auth.ownerId, f.id, { mode: 'next' })).hash;
    const yp = await yearPlanContext({ pool: h.pool, config: h.config }, auth.ownerId, f.id, ASOF);
    const insert = (id: string, horizonFrom: string | null) => h.pool.query("INSERT INTO farm_year_plans(id,owner_id,farm_id,mode,context_hash,input_versions,input_context,result,status,horizon_from) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'{\"norm\":null}'::jsonb,'{\"options\":[]}'::jsonb,'ready',$6::date)",
      [id, auth.ownerId, f.id, h.config.RUNTIME_MODE, yp.hash, horizonFrom]);
    const later = randomUUID();
    await insert(later, yp.ctx.horizon.to); // plan year 2 (even with the current hash, contrived)
    expect((await fitContext(d, auth.ownerId, f.id, { mode: 'next' })).hash).toBe(before);
    expect(await currentYearPlan(d, auth.ownerId, f.id, ASOF)).toBeNull();
    await h.pool.query('UPDATE farm_year_plans SET archived_at=now() WHERE id=$1', [later]);
    const current = randomUUID();
    await insert(current, null);
    expect((await fitContext(d, auth.ownerId, f.id, { mode: 'next' })).hash).not.toBe(before);
    expect((await currentYearPlan(d, auth.ownerId, f.id, ASOF))?.id).toBe(current);
  });

  it('review L2: the green manure and intercropping research files are part of the hash (an absent file hashes, never throws)', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const base = (await fitContext(d, auth.ownerId, f.id, MAY)).hash;
    const files = data.DATA_FILES as unknown as Record<string, string>;
    for (const k of ['greenManure', 'intercropping']) {
      const orig = files[k]!;
      try {
        files[k] = data.DATA_FILES.pool;
        expect((await fitContext(d, auth.ownerId, f.id, MAY)).hash, k).not.toBe(base);
        files[k] = 'data/research/rotation/no-such-file.json';
        expect((await fitContext(d, auth.ownerId, f.id, MAY)).hash, k).not.toBe(base);
      } finally { files[k] = orig; }
    }
    expect((await fitContext(d, auth.ownerId, f.id, MAY)).hash).toBe(base);
  });
});

// ------------------------------------------------------------------ saved-season swap: occupancy and companion harvest
/**
 * Saved-season follow-up, review fix 1 (docs/research/YEAR_PLAN_SAVED_SEASONS.md): every candidate carries the engine's
 * occupancy (sowing to release) and an intercrop its companion's harvest, so the web swap writes the saved season's planned
 * harvest as applyYearPlan does (the later of the main and companion harvest) and checks the swap against other seasons.
 */
const GAP = ASSUMPTIONS.landPrepGapDays.value;
const latestOf = (a: string, b: string) => (a > b ? a : b);
const swapExtras = (areaHa: number | null) => ({ marketNow: null, facts: [], phRange: null, seed: 'swap-occupancy', areaHa, soil: { farmId: randomUUID(), samples: [], limitations: [] } });

describe('crop fit: candidate occupancy and companion harvest (test DB, real research files)', () => {
  it('date mode: every candidate carries occupancy from its sowing to its latest harvest plus the land-preparation gap, and companionHarvest null', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const r = await ensureCropFit(d, auth, f.id, MAY);
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, MAY);
    expect(review.status).toBe('ready');
    expect(CropFitReview.safeParse(review).success).toBe(true);
    expect(review.candidates.length).toBeGreaterThan(0);
    for (const c of review.candidates) {
      expect(c.occupancy, c.cropId).toBeDefined();
      expect(c.occupancy!.from, c.cropId).toBe(c.sowing);
      expect(c.occupancy!.to >= c.harvest.latest, c.cropId).toBe(true);
      // Date mode places sole crops only (placeCandidates): the release is the latest harvest plus the gap.
      expect(c.kind).toBe('crop');
      expect(c.occupancy!.to, c.cropId).toBe(addDays(c.harvest.latest, GAP));
      expect(c.companionHarvest, c.cropId).toBeNull();
    }
    // The stored row carries the fields too (read back through the contract).
    const stored = (await h.pool.query<{ result: { candidates: CropFitCandidate[] } }>('SELECT result FROM crop_fit_reviews WHERE id=$1', [r.reviewId])).rows[0]!.result;
    expect(stored.candidates.every((c) => c.occupancy?.from === c.sowing && c.companionHarvest === null)).toBe(true);
  });

  it('next mode: intercrop candidates carry the companion harvest and an occupancy to the later harvest plus the gap; sole crops null', async () => {
    const { f, auth } = await farm();
    const d = deps();
    const r = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    await generateCropFit(d, r.reviewId!, auth.ownerId);
    const review = await ensureCropFit(d, auth, f.id, { mode: 'next' });
    expect(review.status).toBe('ready');
    expect(CropFitReview.safeParse(review).success).toBe(true);
    let intercrops = 0;
    for (const c of review.candidates) {
      expect(c.occupancy!.from).toBe(c.sowing);
      if (c.kind === 'intercrop') {
        intercrops++;
        expect(c.companionHarvest, c.companion?.systemId ?? c.cropId).not.toBeNull();
        // A companion harvested first (before_main) ends earlier and never shortens the season; one harvested later extends it.
        expect(c.occupancy!.to).toBe(addDays(latestOf(c.harvest.latest, c.companionHarvest!.latest), GAP));
      } else {
        expect(c.companionHarvest).toBeNull();
        expect(c.occupancy!.to).toBe(addDays(c.harvest.latest, GAP));
      }
    }
    expect(intercrops).toBeGreaterThan(0);
  });
});

describe('crop fit: candidate occupancy for the Hassan pigeon pea intercrops (pure, real research files)', () => {
  it('toCandidate copies the slot plan occupancy and companion harvest for every plan candidate, including the after-main pigeon pea systems', () => {
    const ctx = fresh();
    const set = enumerateCandidates(ctx);
    const scored = scorePlacements(ctx, pricedInputs(ctx, runInputKeys(ctx, set)), planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { waitFrom: ctx.earliestSowing });
    expect(scored.length).toBeGreaterThan(0);
    const afterMain = new Set<string>();
    for (const rc of scored) {
      const cand = toCandidate(rc, 1, swapExtras(0.16));
      expect(cand.occupancy).toEqual(rc.plan.occupancy);
      if (cand.kind === 'intercrop') {
        expect(cand.companionHarvest).toEqual(rc.plan.intercrop!.companionHarvest);
        expect(cand.occupancy!.to).toBe(addDays(latestOf(cand.harvest.latest, cand.companionHarvest!.latest), GAP));
        if (rc.plan.intercrop!.system.companionAfterMain) afterMain.add(rc.plan.intercrop!.systemId);
      } else expect(cand.companionHarvest).toBeNull();
    }
    // ka-hassan-groundnut-redgram and ka-hassan-ragi-redgram-8-1 are offered (companionHarvest after_main in intercropping.json).
    // Measured on the current files: the companion's shortest sourced pigeon pea class (95-105 days) ends no later than the
    // main crop's latest harvest, so on this field their companion harvest equals the main harvest; the synthetic case below
    // covers a companion that is harvested later.
    expect([...afterMain].sort()).toEqual(expect.arrayContaining(['ka-hassan-groundnut-redgram', 'ka-hassan-ragi-redgram-8-1']));
  });
});

describe('crop fit: a companion harvested after the main crop (pure, SYNTHETIC fixtures)', () => {
  const SRC = 'SYN-SWAP';
  const win = (season: string, from: string, to: string) => ({ region: 'IN-KA-hassan', season, from, to, condition: 'any', source: `${SRC} windows` });
  const dur = (method: string, min: number, max: number) => ({ method, cultivar: 'Synthetic cultivar (KA)', min, max, source: `${SRC} durations` });
  const crop = (cropId: string, productIds: string[], extra: Record<string, unknown>) => ({
    cropId, family: 'Fabaceae', productIds, rotationRole: { value: 'nitrogen_fixer', method: 'rule_v1', sources: [SRC] }, nitrogenCreditKgPerHa: null, waterNeedMm: { min: 500, max: 700, source: `${SRC} water` },
    rainfedSuitable: true, durationDays: [], stages: [], sowingWindows: [], recommendedPredecessors: [], recommendedSuccessors: [], avoidAfter: [], sources: [], ...extra,
  });
  const JUNE = win('kharif', '06-01', '06-30');
  const fixtures = () => structuredClone({
    agronomy: {
      sourceCatalog: [{ id: SRC, url: 'https://example.org/synthetic-swap', title: 'Synthetic swap fixture' }],
      crops: [
        crop('groundnut', ['groundnut-pod'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [JUNE] }),
        crop('pigeon-pea', ['pigeon-pea-whole'], { durationDays: [dur('direct_sowing', 120, 130)], sowingWindows: [JUNE] }),
      ],
    },
    pool: { pool: [['groundnut', 'groundnut-pod'], ['pigeon-pea', 'pigeon-pea-whole']].map(([cropId, productId]) => ({ cropId, productIds: [productId], why: 'synthetic' })) },
    yieldCost: { crops: [], sources: {}, conversions: {} },
    greenManure: { crops: [] },
    intercropping: {
      systems: [{
        id: 'syn-groundnut-pigeonpea-after', name: 'Groundnut + pigeon pea', mainCropId: 'groundnut', mainProductId: 'groundnut-pod', companionCropId: 'pigeon-pea', companionProductId: 'pigeon-pea-whole',
        rowRatio: '6:1', arrangement: 'row', regions: ['IN-KA-hassan'], season: 'kharif', condition: 'any', sowingWindow: null, companionHarvest: 'after_main',
        yieldShare: { main: { min: 0.8, max: 0.9 }, companion: { min: 0.2, max: 0.3 }, basis: 'synthetic', source: 'SYN-IC' }, ler: null,
        seedRateShare: { main: 1, companion: 0.2, source: 'SYN-IC' }, nitrogenCreditKgPerHa: null, notes: [], reviewStatus: 'sourced', sources: ['SYN-IC'],
      }],
      fallback: { yieldShare: null, ler: { min: 1.1, max: 1.2 }, source: 'SYN-FB', engineRule: 'Synthetic fallback rule.' },
      sources: { 'SYN-IC': { url: 'https://example.org/synthetic-intercrop', title: 'Synthetic intercrop trial', locator: 'Table 1' } },
    },
  });
  afterEach(() => data.invalidate());

  it('companionHarvest.latest is after the main harvest, occupancy.to is that date plus the land-preparation gap (applyYearPlan\'s planned harvest); a sole crop has null', () => {
    data.invalidate(fixtures() as never);
    const ctx = fresh();
    const set = enumerateCandidates(ctx);
    const scored = scorePlacements(ctx, pricedInputs(ctx, runInputKeys(ctx, set)), planCandidates(ctx, resolveMode(ctx, NEXT), set).placed, { waitFrom: ctx.earliestSowing });
    const inter = scored.filter((rc) => intercropSystemOf(rc.plan) === 'syn-groundnut-pigeonpea-after');
    const sole = scored.filter((rc) => intercropSystemOf(rc.plan) === null);
    expect(inter.length).toBeGreaterThan(0);
    expect(sole.length).toBeGreaterThan(0);
    for (const rc of inter) {
      const c = toCandidate(rc, 1, swapExtras(0.16));
      expect(c.kind).toBe('intercrop');
      // Main groundnut 90-100 days, companion pigeon pea 120-130 days (its shortest class): harvested 30 days later.
      expect(c.harvest).toEqual({ earliest: addDays(c.sowing, 90), latest: addDays(c.sowing, 100) });
      expect(c.companionHarvest).toEqual({ earliest: addDays(c.sowing, 120), latest: addDays(c.sowing, 130) });
      expect(c.companionHarvest!.latest > c.harvest.latest).toBe(true);
      expect(c.occupancy).toEqual({ from: c.sowing, to: addDays(c.companionHarvest!.latest, GAP) });
      // applyYearPlan's rule: held = occupancy.to - gap; the planned harvest is held when it is after the main harvest.
      const held = addDays(c.occupancy!.to, -GAP);
      expect(held > c.harvest.latest ? held : c.harvest.latest).toBe(c.companionHarvest!.latest);
    }
    for (const rc of sole) {
      const c = toCandidate(rc, 1, swapExtras(0.16));
      expect(c.kind).toBe('crop');
      expect(c.companionHarvest).toBeNull();
      expect(c.occupancy).toEqual({ from: c.sowing, to: addDays(c.harvest.latest, GAP) });
    }
  });
});
