import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { deterministicPicks, gatePicks, pickPool } from '../src/services/crop-fit/select';
import { marketNowFromRows } from '../src/services/crop-fit/market-now';
import { ensureCropFit, fitContext, generateCropFit, MODEL_UNAVAILABLE, type CropFitDeps } from '../src/services/crop-fit/service';
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
const stub = (cropId: string, rank: number, codes: string[]) => ({ cropId, productId: `${cropId}-grain`, cropName: cropId[0]!.toUpperCase() + cropId.slice(1), productName: 'Grain', rank, reasonCodes: codes }) as unknown as CropFitCandidate;
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
    expect(ready.candidates.find((c) => c.cropId === 'maize')?.sowing).toBe('2027-05-22');
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
          const input = JSON.parse(String(req.input)) as { candidates: { cropId: string; productId: string; reasonCodes: string[] }[] };
          const picks = input.candidates.slice(1, 4).map((c) => ({ cropId: c.cropId, productId: c.productId, headline: 'A good fit for this sowing date', reasons: [{ code: c.reasonCodes[0]!, text: mode === 'digit' ? 'Sow within 2 weeks.' : 'Fits the sowing date and the field.' }] }));
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
