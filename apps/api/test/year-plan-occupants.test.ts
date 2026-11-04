import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { YearPlanReview, YearPlanScenario, type HarvestPriceOutlook } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { patchFarm } from '../src/services/farms';
import { ASSUMPTIONS, buildScenario, data, type BuildScenarioArgs } from '../src/services/year-plan';
import { addDays } from '../src/services/year-plan/dates';
import { applyYearPlan, ensureYearPlan, fitsWithoutOccupants, generateYearPlan, readYearPlan, yearPlanContext, type YearPlanDeps } from '../src/services/year-plan/service';
import { enumerateCandidates } from '../src/services/year-plan/candidates';
import type { TextModelProvider } from '../src/agent/provider';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Saved-season follow-up (docs/research/YEAR_PLAN_SAVED_SEASONS.md, Packet A): scenario.occupied, modelSelection,
 * noFreeWindow, the view fill for stored plans that predate the field, and the unchanged context hash.
 * Scenario tests use SYNTHETIC agronomy and intercrop fixtures (data.invalidate); service tests use the test DB, the real
 * read-only research files, SYNTHETIC price and rain sources and a fake Meta transport. No figure here is a field observation.
 */

// The hash test runs yearPlanContext once with scenario.occupied removed (toggle) and once with it.
const strip = vi.hoisted(() => ({ occupied: false }));
vi.mock('../src/services/year-plan/scenario', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/year-plan/scenario')>();
  return {
    ...mod,
    buildScenario: (args: Parameters<typeof mod.buildScenario>[0]) => {
      const ctx = mod.buildScenario(args);
      if (strip.occupied) delete ctx.scenario.occupied;
      return ctx;
    },
  };
});

const ASOF = '2026-11-01';
const H = 'IN-KA-hassan';
const SRC = 'SYN-AG';
const GAP = ASSUMPTIONS.landPrepGapDays.value;
const BUFFER = ASSUMPTIONS.unknownHarvestBufferDays.value;

// ---------------------------------------------------------------- synthetic fixtures (scenario tests)
const win = (season: string, from: string, to: string) => ({ region: H, season, from, to, condition: 'any', source: `${SRC} windows` });
const dur = (method: string, min: number, max: number) => ({ method, cultivar: 'Synthetic cultivar (KA)', min, max, source: `${SRC} durations` });
const crop = (cropId: string, family: string, r: string, productIds: string[], extra: Record<string, unknown> = {}) => ({
  cropId, family, productIds, rotationRole: { value: r, method: 'rule_v1', sources: [SRC] }, nitrogenCreditKgPerHa: null, waterNeedMm: { min: 500, max: 700, source: `${SRC} water` },
  rainfedSuitable: true, durationDays: [], stages: [], sowingWindows: [], recommendedPredecessors: [], recommendedSuccessors: [], avoidAfter: [], sources: [], ...extra,
});
const JUNE = win('kharif', '06-01', '06-30');
const NOV = win('rabi', '11-01', '11-30');
const AGRONOMY = {
  sourceCatalog: [{ id: SRC, url: 'https://example.org/synthetic-agronomy', title: 'Synthetic agronomy fixture' }],
  crops: [
    crop('maize', 'Poaceae', 'heavy_feeder', ['maize-grain'], { durationDays: [dur('direct_sowing', 100, 110)], sowingWindows: [JUNE] }),
    crop('sorghum', 'Poaceae', 'moderate_feeder', ['sorghum-grain'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [JUNE, NOV] }),
    crop('groundnut', 'Fabaceae', 'nitrogen_fixer', ['groundnut-pod'], { durationDays: [dur('direct_sowing', 90, 100)], sowingWindows: [JUNE, NOV] }),
    crop('green-gram', 'Fabaceae', 'nitrogen_fixer', ['green-gram-whole'], { durationDays: [dur('direct_sowing', 60, 70)], sowingWindows: [JUNE, NOV] }),
  ],
};
const POOL = { pool: [['maize', 'maize-grain'], ['sorghum', 'sorghum-grain'], ['groundnut', 'groundnut-pod'], ['green-gram', 'green-gram-whole']].map(([cropId, productId]) => ({ cropId, productIds: [productId], why: 'synthetic' })) };
const YIELD_COST = { crops: [], sources: {}, conversions: {} };
const INTERCROP = {
  systems: [{
    id: 'syn-sorghum-greengram-credit', name: 'Sorghum + green gram', mainCropId: 'sorghum', mainProductId: 'sorghum-grain', companionCropId: 'green-gram', companionProductId: 'green-gram-whole',
    rowRatio: '4:1', arrangement: 'row', regions: [H], season: 'rabi', condition: 'any', sowingWindow: null, companionHarvest: null,
    yieldShare: { main: { min: 0.8, max: 0.9 }, companion: { min: 0.2, max: 0.3 }, basis: 'synthetic', source: 'SYN-IC' }, ler: null,
    seedRateShare: { main: 1, companion: 0.25, source: 'SYN-IC' }, nitrogenCreditKgPerHa: { min: 20, max: 30, source: 'SYN-IC' }, notes: [], reviewStatus: 'sourced', sources: ['SYN-IC'],
  }],
  fallback: { yieldShare: null, ler: { min: 1.16, max: 1.22 }, source: 'SYN-FB', engineRule: 'Synthetic fallback rule.' },
  sources: { 'SYN-IC': { url: 'https://example.org/synthetic-intercrop', title: 'Synthetic intercrop trial', locator: 'Table 1' } },
};
const fixtures = () => structuredClone({ agronomy: AGRONOMY, pool: POOL, yieldCost: YIELD_COST, greenManure: { crops: [] }, intercropping: INTERCROP });
type Workspace = BuildScenarioArgs['workspace'];
const ws = (over: Partial<Workspace> = {}): Workspace => ({ previousHarvest: { status: 'known', cropId: 'maize', harvestDate: '2026-10-15' }, cycles: [], rotationPlans: [], ...over }) as Workspace;
const args = (workspace: Workspace, over: Partial<BuildScenarioArgs> = {}): BuildScenarioArgs => ({ workspace, farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: {} }, asOf: ASOF, ...over });

describe('scenario.occupied (synthetic fixtures)', () => {
  beforeEach(() => data.invalidate(fixtures()));
  afterAll(() => data.invalidate());

  it('a saved sole-crop season with a planned harvest is a saved_season occupant with its own crop, product, names, dates and the engine interval (basis planned)', () => {
    const saved = { id: 'sv-gn', year: 2027, season: 'Kharif', cropId: 'groundnut', cropName: 'Groundnut', productId: 'groundnut-pod', productName: 'Groundnut pods', plannedSowingDate: '2027-06-01', plannedHarvestDate: '2027-09-15', establishmentMethod: 'direct_sowing' };
    const ctx = buildScenario(args(ws({ rotationPlans: [saved] })));
    expect(ctx.occupied).toEqual([{ id: 'sv-gn', cropId: 'groundnut', source: 'rotation_plan', from: '2027-06-01', to: addDays('2027-09-15', GAP), basis: 'planned', note: null, realisation: 'planned' }]);
    expect(ctx.scenario.occupied).toEqual([{
      id: 'sv-gn', source: 'saved_season', cropId: 'groundnut', productId: 'groundnut-pod', cropName: 'Groundnut', productName: 'Groundnut pods', kind: 'crop', companion: null,
      establishmentMethod: 'direct_sowing', sowing: '2027-06-01', harvestDate: '2027-09-15', occupancy: { from: '2027-06-01', to: addDays('2027-09-15', GAP) }, occupancyBasis: 'planned', note: null,
      realisation: 'planned',
    }]);
    expect(YearPlanScenario.parse(ctx.scenario).occupied).toHaveLength(1);
    // The engine's name map comes first for crops; a product keeps the farmer's own name.
    const named = buildScenario(args(ws({ rotationPlans: [saved] }), { names: { crop: { groundnut: 'Kadalekai' }, product: { 'groundnut-pod': 'Pods (map)' } } }));
    expect(named.scenario.occupied![0]).toMatchObject({ cropName: 'Kadalekai', productName: 'Groundnut pods' });
    const bare = buildScenario(args(ws({ rotationPlans: [{ id: 'sv-bare', year: 2027, season: 'Kharif', cropId: 'groundnut', productId: 'groundnut-pod', plannedSowingDate: '2027-06-01', plannedHarvestDate: '2027-09-15' }] }), { names: { product: { 'groundnut-pod': 'Pods (map)' } } }));
    expect(bare.scenario.occupied![0]).toMatchObject({ cropName: 'Groundnut', productName: 'Pods (map)', establishmentMethod: null, kind: 'crop' });
  });

  it('a saved intercrop season whose system has a sourced nitrogen credit: the engine keeps the ic: token, the occupant shows the main crop, kind intercrop and the companion', () => {
    const saved = { id: 'sv-ic', year: 2026, season: 'Rabi', cropId: 'sorghum', productId: 'sorghum-grain', plannedSowingDate: '2026-11-10', plannedHarvestDate: '2027-02-20', kind: 'intercrop' as const, companion: { systemId: 'syn-sorghum-greengram-credit', cropId: 'green-gram', rowRatio: '4:1' } };
    const ctx = buildScenario(args(ws({ rotationPlans: [saved] })));
    expect(ctx.occupied[0]!.cropId).toBe('ic:syn-sorghum-greengram-credit');
    const [o] = ctx.scenario.occupied!;
    expect(o).toMatchObject({
      id: 'sv-ic', source: 'saved_season', cropId: 'sorghum', productId: 'sorghum-grain', cropName: 'Sorghum', productName: null, kind: 'intercrop',
      companion: { systemId: 'syn-sorghum-greengram-credit', cropId: 'green-gram', cropName: 'Green gram', rowRatio: '4:1' }, sowing: '2026-11-10', harvestDate: '2027-02-20', occupancyBasis: 'planned',
    });
    expect(JSON.stringify(ctx.scenario.occupied)).not.toContain('ic:');
    // A companion's own name wins over the map.
    const own = buildScenario(args(ws({ rotationPlans: [{ ...saved, companion: { ...saved.companion, cropName: 'Moong' } }] }), { names: { crop: { 'green-gram': 'Hesaru' } } }));
    expect(own.scenario.occupied![0]!.companion!.cropName).toBe('Moong');
  });

  it('a saved season without a planned harvest: harvestDate null, occupancy and basis from the sourced duration, or the assumed 180 days', () => {
    const ctx = buildScenario(args(ws({ rotationPlans: [
      { id: 'sv-gn', year: 2027, season: 'Kharif', cropId: 'groundnut', plannedSowingDate: '2027-06-01' },
      { id: 'sv-x', year: 2026, season: 'Rabi', cropId: 'mystery-crop', plannedSowingDate: '2026-11-15' },
    ] })));
    const byId = Object.fromEntries(ctx.scenario.occupied!.map((o) => [o.id, o]));
    expect(byId['sv-gn']).toMatchObject({ harvestDate: null, occupancyBasis: 'sourced_duration', occupancy: { from: '2027-06-01', to: addDays('2027-06-01', 100 + BUFFER + GAP) } });
    expect(byId['sv-gn']!.note).toContain('No harvest date recorded');
    expect(byId['sv-x']).toMatchObject({ cropName: 'Mystery crop', harvestDate: null, occupancyBasis: 'assumed_duration', occupancy: { from: '2026-11-15', to: addDays('2026-11-15', ASSUMPTIONS.unknownDurationDays.value + BUFFER + GAP) } });
    expect(ctx.scenario.occupied!.map((o) => o.id)).toEqual(['sv-x', 'sv-gn']);
  });

  it('another active cycle is a recorded_cycle occupant; the current growing crop stays the fixed slot and is not listed', () => {
    const current = { id: 'cy-1', cropId: 'maize', sowingDate: '2026-09-20', stage: 'growing' as const };
    const other = { id: 'cy-2', cropId: 'green-gram', cropName: 'Green gram', productId: 'green-gram-whole', productName: 'Whole grain', sowingDate: '2026-12-01', establishmentMethod: 'direct_sowing', stage: 'sowed' as const, harvestDate: '2027-02-10' };
    const harvested = { id: 'cy-0', cropId: 'sorghum', sowingDate: '2026-05-01', stage: 'harvested' as const, harvestDate: '2026-08-20' };
    const ctx = buildScenario(args(ws({ cycles: [current, other, harvested] })));
    expect(ctx.fixedSlot!.cycleId).toBe('cy-1');
    expect(ctx.scenario.occupied).toEqual([{
      id: 'cy-2', source: 'recorded_cycle', cropId: 'green-gram', productId: 'green-gram-whole', cropName: 'Green gram', productName: 'Whole grain', kind: 'crop', companion: null,
      establishmentMethod: 'direct_sowing', sowing: '2026-12-01', harvestDate: '2027-02-10', occupancy: { from: '2026-12-01', to: addDays('2027-02-10', GAP) }, occupancyBasis: 'recorded', note: null,
      realisation: 'sown',
    }]);
  });

  it('a later horizon lists the assumed previous-year plan (assumed_plan) and the current cycle when it runs into that horizon', () => {
    const cycle = { id: 'cy-1', cropId: 'maize', productId: 'maize-grain', sowingDate: '2026-09-20', stage: 'growing' as const };
    const assumedPredecessor = { cropId: 'groundnut', cropName: 'Groundnut', occupancy: { from: '2027-06-01', to: '2027-10-05' }, optionLabel: 'Best overall', horizonFrom: '2026-09-20', reviewId: 'r0', signature: 'groundnut/groundnut-pod' };
    const ctx = buildScenario(args(ws({ previousHarvest: { status: 'none' }, cycles: [cycle] }), { horizonFrom: '2027-09-20', assumedPredecessor }));
    expect(ctx.scenario.kind).toBe('future');
    expect(ctx.scenario.occupied).toEqual([{
      id: 'assumed:r0', source: 'assumed_plan', cropId: 'groundnut', productId: null, cropName: 'Groundnut', productName: null, kind: 'crop', companion: null, establishmentMethod: null,
      sowing: '2027-06-01', harvestDate: null, occupancy: { from: '2027-06-01', to: '2027-10-05' }, occupancyBasis: 'planned', note: 'Assumed from the Best overall plan of the previous year (not saved).',
    }]);
    expect(YearPlanScenario.safeParse(ctx.scenario).success).toBe(true);
    // A current crop recorded to harvest after the next horizon starts is listed there with the fixed slot's release.
    const long = buildScenario(args(ws({ previousHarvest: { status: 'none' }, cycles: [{ ...cycle, harvestDate: '2027-09-25' }] }), { horizonFrom: '2027-09-20' }));
    expect(long.scenario.occupied).toEqual([expect.objectContaining({ id: 'cy-1', source: 'recorded_cycle', cropId: 'maize', sowing: '2026-09-20', harvestDate: '2027-09-25', occupancy: { from: '2026-09-20', to: addDays('2027-09-25', GAP) }, occupancyBasis: 'recorded' })]);
  });

  it('saved seasons outside the horizon are not listed; more than 24 are capped in sowing order', () => {
    const inside = Array.from({ length: 30 }, (_, i) => ({ id: `s-${String(99 - i)}`, year: 2027, season: 'Rabi', cropId: 'green-gram', plannedSowingDate: addDays('2027-01-01', i), plannedHarvestDate: addDays('2027-01-01', i + 30) }));
    const outside = [
      { id: 'later', year: 2028, season: 'Kharif', cropId: 'maize', plannedSowingDate: '2028-06-01', plannedHarvestDate: '2028-09-10' },
      { id: 'earlier', year: 2026, season: 'Kharif', cropId: 'maize', plannedSowingDate: '2026-06-01', plannedHarvestDate: '2026-09-10' },
    ];
    const ctx = buildScenario(args(ws({ rotationPlans: [...outside, ...[...inside].reverse()] })));
    expect(ctx.occupied).toHaveLength(30);
    const listed = ctx.scenario.occupied!;
    expect(listed).toHaveLength(24);
    expect(listed.map((o) => o.id)).toEqual(inside.slice(0, 24).map((p) => p.id));
    expect(listed.map((o) => o.sowing)).toEqual([...listed.map((o) => o.sowing)].sort());
    expect(listed.some((o) => o.id === 'later' || o.id === 'earlier')).toBe(false);
    expect(YearPlanScenario.safeParse(ctx.scenario).success).toBe(true);
  });

  it('review fix, noFreeWindow counterfactual: true only when the field has crop candidates without its occupants (missing state, excluded crops or no window are not "full")', () => {
    // One saved season takes the whole current horizon (1 Nov 2026 to 1 Nov 2027) of a fresh field.
    const filling = { id: 'sv-fill', year: 2026, season: 'Rabi', cropId: 'groundnut', plannedSowingDate: '2026-11-01', plannedHarvestDate: '2027-10-25' };
    const full = buildScenario(args(ws({ rotationPlans: [filling] })));
    expect(full.occupied).toHaveLength(1);
    expect(enumerateCandidates(full).candidates).toEqual([]);
    expect(fitsWithoutOccupants(full)).toBe(true);
    // The same saved season on a farm with no state: no sourced window anywhere, so the occupants are not the cause.
    const noState = buildScenario(args(ws({ rotationPlans: [filling] }), { farm: { location: { stateCode: null, districtId: null }, areaHectares: 1, facts: {} } }));
    expect(noState.occupied).toHaveLength(1);
    expect(enumerateCandidates({ ...noState, occupied: [] }).candidates).toEqual([]);
    expect(fitsWithoutOccupants(noState)).toBe(false);
    // Every pool crop excluded by the farmer.
    const excluded = buildScenario(args(ws({ rotationPlans: [filling] }), { farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: { excluded_crop_ids: { value: 'maize,sorghum,groundnut,green-gram', basis: 'farmer_reported', confirmed: true } } } }));
    expect(excluded.excludedCropIds).toEqual(['maize', 'sorghum', 'groundnut', 'green-gram']);
    expect(fitsWithoutOccupants(excluded)).toBe(false);
    // A growing crop keeps its months in the counterfactual (fixed slot and earliestSowing unchanged): sown 1 Oct 2026 and
    // recorded to harvest on 30 Sep 2027, it leaves no window of its own, so the saved season is not the cause either.
    const grown = buildScenario(args(ws({ cycles: [{ id: 'cy-long', cropId: 'maize', sowingDate: '2026-10-01', stage: 'growing', harvestDate: '2027-09-30' }], rotationPlans: [{ ...filling, plannedSowingDate: '2026-10-10' }] })));
    expect(grown.earliestSowing >= grown.horizon.to).toBe(true);
    expect(fitsWithoutOccupants(grown)).toBe(false);
  });

  it('review fix, noFreeWindow counterfactual in a later horizon: earliestSowing is recomputed without the occupants that started before the horizon', () => {
    // Fresh field: the current horizon is 1 Nov 2026 to 1 Nov 2027; year 2 starts 1 Nov 2027. A saved season sown in October
    // 2027 and harvested in October 2028 pushes year 2's earliest sowing past its last window.
    const long = { id: 'sv-long', year: 2027, season: 'Rabi', cropId: 'maize', plannedSowingDate: '2027-10-01', plannedHarvestDate: '2028-10-10' };
    const ctx = buildScenario(args(ws({ rotationPlans: [long] }), { horizonFrom: '2027-11-01' }));
    expect(ctx.scenario.kind).toBe('future');
    expect(ctx.earliestSowing).toBe(addDays('2028-10-10', GAP));
    expect(enumerateCandidates(ctx).candidates).toEqual([]);
    // Dropping only the intervals would keep the pushed earliestSowing and find nothing (the trap the recompute avoids).
    expect(enumerateCandidates({ ...ctx, occupied: [] }).candidates).toEqual([]);
    expect(fitsWithoutOccupants(ctx)).toBe(true);
    const free = enumerateCandidates({ ...ctx, occupied: [], earliestSowing: '2027-11-01' }).candidates;
    expect(free.some((c) => c.sowing.startsWith('2027-11'))).toBe(true);
  });
});

// ---------------------------------------------------------------- service (test DB, real research files)
let h: Harness, a: Client;
const ASOF_NOW = () => new Date('2026-11-01T06:00:00Z');
function fakeOutlook(x: { productId: string; harvestDate: string; asOf: string }): HarvestPriceOutlook {
  return {
    productId: x.productId, status: 'available', missingReason: null,
    scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price, not a market observation', limitations: ['synthetic'],
    method: 'B_seasonal_reference/pooled-v1', harvestDate: x.harvestDate, harvestWeek: { year: 2027, week: 10 }, asOf: x.asOf, weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 18, p25: 20, p50: 25, p75: 30, p90: 33, annualMean: 24, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  } as HarvestPriceOutlook;
}
const RAIN_DAYS = (start: string, end: string) => { const out = []; for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400_000) { const d = new Date(t).toISOString().slice(0, 10); const m = Number(d.slice(5, 7)); out.push({ date: d, rainMm: m >= 6 && m <= 10 ? 6 : 0.5, et0Mm: null, tMaxC: null, tMinC: null, sourceId: 'synthetic' }); } return out; };
const sources: YearPlanDeps['sources'] = {
  priceOutlook: async (x) => fakeOutlook(x),
  climatology: async (_scope, range) => ({ years: { from: 2016, to: 2025 }, sourceId: 'synthetic-normals', days: RAIN_DAYS(range.start, range.end) }),
  neighbourhood: async () => { throw new Error('ndvi unavailable in test'); },
};
const deps = (over: Partial<YearPlanDeps> = {}): YearPlanDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: ASOF_NOW, sources, ...over });
const liveDeps = (provider: TextModelProvider | undefined, over: Partial<YearPlanDeps> = {}) => deps({ config: { ...h.config, RUNTIME_MODE: 'live', MODEL_API_KEY: 'fixture-key' }, provider, ...over });

/** Fake Meta: a valid answer (first allowed label per candidate), or a provider failure. */
function fakeMeta(mode: 'valid' | 'rate_limited') {
  const provider: TextModelProvider = {
    kind: 'meta', provenance: 'meta_live', billable: false,
    call: vi.fn(async (req) => {
      if (mode === 'rate_limited') return { ok: false as const, error: { code: 'rate_limited' as const, message: 'synthetic rate limit', retryable: true, outcomeUncertain: false, requestId: null, retries: 0 } };
      const input = JSON.parse(String(req.input)) as { candidates: { candidateId: string; allowedLabels: string[]; reasonCodes: string[] }[] };
      const used = new Set<string>(); const plans: { candidateId: string; label: string; reasonCodes: string[]; sentence: string }[] = [];
      for (const c of input.candidates) {
        const label = c.allowedLabels.find((l) => !used.has(l));
        if (!label || plans.length >= 3) continue;
        used.add(label);
        plans.push({ candidateId: c.candidateId, label, reasonCodes: c.reasonCodes.slice(0, 2), sentence: 'Fits the free months of the field and follows the previous crop well.' });
      }
      return { ok: true as const, result: { provenance: 'meta_live' as const, responseId: 'resp-occupants', requestId: 'req', model: 'fixture-received-model', outputText: JSON.stringify({ plans }), functionCalls: [], usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0 }, latencyMs: 1, retries: 0 } };
    }),
    deleteResponse: vi.fn(async () => ({ ok: true, code: null })),
  };
  return provider;
}

async function farm() {
  const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Occupants QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: H, precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data;
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  return { f: f as { id: string }, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
async function generate(d: YearPlanDeps, auth: { ownerId: string; sessionId: string | null }, id: string) {
  const r = await ensureYearPlan(d, auth, id);
  await generateYearPlan(d, r.reviewId!, auth.ownerId);
  return readYearPlan(d, auth.ownerId, id);
}
const putSeasons = async (auth: { ownerId: string }, farmId: string, patch: { cycles?: unknown[]; rotationPlans?: unknown[] }) => {
  const cur = await getWorkspace(h.pool, auth.ownerId, farmId);
  return putWorkspace(h.pool, auth.ownerId, farmId, { expectedVersion: cur.version, boundary: null, previousHarvest: { status: 'none' }, cycles: patch.cycles ?? cur.cycles, rotationPlans: patch.rotationPlans ?? cur.rotationPlans } as never);
};

describe('year-plan service: occupants, model selection and no free window (test DB)', () => {
  beforeAll(async () => { data.invalidate(); h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); });
  afterAll(async () => h.close());
  afterEach(() => { strip.occupied = false; data.invalidate(); });

  it('growing crop + saved seasons filling the rest of the year: noFreeWindow, not_needed (no model call), the fixed slot alone and the saved seasons as occupants', async () => {
    const { f, auth } = await farm();
    await patchFarm(h.pool, auth.ownerId, f.id, { facts: { irrigation_category: { value: 'supplemental', basis: 'farmer_reported', confirmed: true } } });
    await putSeasons(auth, f.id, {
      cycles: [{ id: randomUUID(), cropId: 'maize', sowingDate: '2026-09-20', stage: 'growing' }],
      rotationPlans: [
        { id: 'saved-gn', year: 2027, season: 'Rabi', cropId: 'groundnut', cropName: 'Groundnut', plannedSowingDate: '2027-01-29', plannedHarvestDate: '2027-05-19' },
        { id: 'saved-sf', year: 2027, season: 'Kharif', cropId: 'sunflower', cropName: 'Sunflower', plannedSowingDate: '2027-05-29', plannedHarvestDate: '2027-09-01' },
      ],
    });
    const meta = fakeMeta('valid');
    const review = await generate(liveDeps(meta), auth, f.id);
    expect(YearPlanReview.safeParse(review).success).toBe(true);
    expect(review.status).toBe('ready');
    expect(review.noFreeWindow).toBe(true);
    expect(review.modelSelection).toEqual({ outcome: 'not_needed', detail: null });
    expect(meta.call).not.toHaveBeenCalled();
    expect(review.options).toHaveLength(1);
    expect(review.options[0]!.slots).toHaveLength(1);
    expect(review.options[0]!.slots[0]!.fixed).toBe(true);
    expect(review.limitations.join(' ')).toContain('fill the months after the growing crop');
    expect(review.scenario.occupied!.map((o) => [o.id, o.source, o.cropId, o.cropName, o.sowing, o.harvestDate, o.occupancyBasis])).toEqual([
      ['saved-gn', 'saved_season', 'groundnut', 'Groundnut', '2027-01-29', '2027-05-19', 'planned'],
      ['saved-sf', 'saved_season', 'sunflower', 'Sunflower', '2027-05-29', '2027-09-01', 'planned'],
    ]);
    const stored = (await h.pool.query('SELECT input_context FROM farm_year_plans WHERE id=$1', [review.reviewId])).rows[0].input_context;
    expect(stored.scenario.occupied).toHaveLength(2);
  });

  it('a fresh field whose saved seasons take the whole horizon: unavailable, noFreeWindow, no model selection', async () => {
    const { f, auth } = await farm();
    await putSeasons(auth, f.id, { rotationPlans: [
      { id: 'full-1', year: 2026, season: 'Rabi', cropId: 'groundnut', plannedSowingDate: '2026-11-01', plannedHarvestDate: '2027-03-01' },
      { id: 'full-2', year: 2027, season: 'Summer', cropId: 'groundnut', plannedSowingDate: '2027-03-11', plannedHarvestDate: '2027-07-01' },
      { id: 'full-3', year: 2027, season: 'Kharif', cropId: 'groundnut', plannedSowingDate: '2027-07-11', plannedHarvestDate: '2027-11-05' },
    ] });
    const meta = fakeMeta('valid');
    const review = await generate(liveDeps(meta), auth, f.id);
    expect(review.status).toBe('unavailable');
    expect(review.options).toEqual([]);
    expect(review.noFreeWindow).toBe(true);
    expect(review.modelSelection).toBeNull();
    expect(review.scenario.occupied!.map((o) => o.id)).toEqual(['full-1', 'full-2', 'full-3']);
    expect(meta.call).not.toHaveBeenCalled();
  });

  it('review fix: a farm with no state and a saved season is unavailable for lack of sourced windows, not "no free window"', async () => {
    const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Occupants no state ${randomUUID()}`, location: { districtName: 'Unlisted place QA', precision: 'district' }, facts: {} }) })).json().data as { id: string };
    const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
    const auth = { ownerId: s.owner_id, sessionId: s.id };
    expect((await h.pool.query('SELECT state_code FROM farms WHERE id=$1', [f.id])).rows[0].state_code).toBeNull();
    await putSeasons(auth, f.id, { rotationPlans: [{ id: 'nostate-gn', year: 2027, season: 'Kharif', cropId: 'groundnut', plannedSowingDate: '2027-06-01', plannedHarvestDate: '2027-09-15' }] });
    const meta = fakeMeta('valid');
    const review = await generate(liveDeps(meta), auth, f.id);
    expect(YearPlanReview.safeParse(review).success).toBe(true);
    expect(review.status).toBe('unavailable');
    expect(review.options).toEqual([]);
    expect(review.candidatesConsidered).toBe(0);
    expect(review.scenario.occupied!.map((o) => o.id)).toEqual(['nostate-gn']);
    expect(review.noFreeWindow).toBe(false);
    expect(review.modelSelection).toBeNull();
    expect(meta.call).not.toHaveBeenCalled();
  });

  it('modelSelection: model, failed (with the failure code), not_used (synthetic mode), not_configured (live, no key) and cancelled (no session)', async () => {
    const valid = fakeMeta('valid');
    const m = await farm();
    const model = await generate(liveDeps(valid), m.auth, m.f.id);
    expect(model.modelSelection).toEqual({ outcome: 'model', detail: null });
    expect(model.noFreeWindow).toBe(false);
    expect(model.options.slice(0, 3).every((o) => o.origin === 'model')).toBe(true);
    expect(model.scenario.occupied).toEqual([]);

    const failing = fakeMeta('rate_limited');
    const fl = await farm();
    const failed = await generate(liveDeps(failing), fl.auth, fl.f.id);
    expect(failing.call).toHaveBeenCalledTimes(1);
    expect(failed.status).toBe('partial');
    expect(failed.modelSelection).toEqual({ outcome: 'failed', detail: 'provider_rate_limited' });
    expect(failed.options.every((o) => o.origin === 'deterministic')).toBe(true);

    const s = await farm();
    const synthetic = await generate(deps(), s.auth, s.f.id);
    expect(synthetic.status).toBe('partial');
    expect(synthetic.modelSelection).toEqual({ outcome: 'not_used', detail: null });

    const n = await farm();
    const noKey = await generate(deps({ config: { ...h.config, RUNTIME_MODE: 'live', MODEL_API_KEY: undefined } }), n.auth, n.f.id);
    expect(noKey.modelSelection).toEqual({ outcome: 'not_configured', detail: null });

    const c = await farm();
    const unused = fakeMeta('valid');
    const cancelled = await generate(liveDeps(unused), { ownerId: c.auth.ownerId, sessionId: null }, c.f.id);
    expect(cancelled.modelSelection).toEqual({ outcome: 'cancelled', detail: null });
    expect(unused.call).not.toHaveBeenCalled();
  });

  it('view() fills scenario.occupied for a stored plan that predates it (current rows only, without the seasons its own apply saved); no modelSelection is invented', async () => {
    const { f, auth } = await farm();
    const own = { id: 'own-2027', year: 2027, season: 'Kharif', cropId: 'groundnut', cropName: 'Groundnut', productId: 'groundnut-pod', productName: 'Groundnut pods', plannedSowingDate: '2027-06-10', plannedHarvestDate: '2027-09-30' };
    await putSeasons(auth, f.id, { rotationPlans: [own] });
    const d = liveDeps(fakeMeta('valid'));
    const review = await generate(d, auth, f.id);
    expect(review.scenario.occupied!.map((o) => o.id)).toEqual(['own-2027']);
    const legacy = (id: string) => h.pool.query("UPDATE farm_year_plans SET result = (result #- '{scenario,occupied}') - 'modelSelection' - 'noFreeWindow' WHERE id=$1", [id]);
    await legacy(review.reviewId!);
    const raw = (await h.pool.query('SELECT result FROM farm_year_plans WHERE id=$1', [review.reviewId])).rows[0].result;
    expect(raw.scenario.occupied).toBeUndefined();
    const filled = await readYearPlan(d, auth.ownerId, f.id);
    expect(filled.reviewId).toBe(review.reviewId);
    expect(filled.scenario.occupied).toEqual(review.scenario.occupied);
    expect(filled.modelSelection).toBeUndefined();
    expect(filled.noFreeWindow).toBeUndefined();

    // After applying an option, the row is re-keyed; the seasons its apply saved are the plan's own slots, not occupants.
    const option = review.options[0]!;
    const before = await getWorkspace(h.pool, auth.ownerId, f.id);
    const applied = await applyYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version });
    expect(applied.workspace.rotationPlans.some((p) => p.id.startsWith(`yearplan:${review.reviewId}:`))).toBe(true);
    await legacy(review.reviewId!);
    const afterApply = await readYearPlan(d, auth.ownerId, f.id);
    expect(afterApply.reviewId).toBe(review.reviewId);
    expect(afterApply.stale).toBe(false);
    expect(afterApply.scenario.occupied!.map((o) => o.id)).toEqual(['own-2027']);

    // A stale legacy row is left as stored (its options were placed around other occupants).
    await patchFarm(h.pool, auth.ownerId, f.id, { facts: { irrigation_category: { value: 'irrigated', basis: 'farmer_reported', confirmed: true } } });
    const stale = await readYearPlan(d, auth.ownerId, f.id);
    expect(stale.stale).toBe(true);
    expect(stale.scenario.occupied).toBeUndefined();
  });

  it('the context hash and chain hash do not depend on scenario.occupied (the scenario is not hashed)', async () => {
    const { f, auth } = await farm();
    await putSeasons(auth, f.id, {
      cycles: [{ id: randomUUID(), cropId: 'maize', sowingDate: '2026-09-20', stage: 'growing' }],
      rotationPlans: [{ id: 'saved-gn', year: 2027, season: 'Rabi', cropId: 'groundnut', cropName: 'Groundnut', plannedSowingDate: '2027-01-29', plannedHarvestDate: '2027-05-19' }],
    });
    const d = deps();
    strip.occupied = false;
    const withOcc = await yearPlanContext(d, auth.ownerId, f.id, ASOF, null, { candidates: false });
    strip.occupied = true;
    const without = await yearPlanContext(d, auth.ownerId, f.id, ASOF, null, { candidates: false });
    strip.occupied = false;
    expect(withOcc.ctx.scenario.occupied).toHaveLength(1);
    expect(without.ctx.scenario.occupied).toBeUndefined();
    expect(withOcc.hash).toBe(without.hash);
    expect(withOcc.chainHash).toBe(without.chainHash);
    // Later horizon too (the occupancy is still covered by the hashed workspace seasons).
    const next = withOcc.ctx.horizonStarts!.futures[0]!;
    const fOcc = await yearPlanContext(d, auth.ownerId, f.id, ASOF, next, { candidates: false });
    strip.occupied = true;
    const fWithout = await yearPlanContext(d, auth.ownerId, f.id, ASOF, next, { candidates: false });
    strip.occupied = false;
    expect(fOcc.hash).toBe(fWithout.hash);
  });
});
