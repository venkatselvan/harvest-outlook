import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YearPlanReview, type HarvestPriceOutlook } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { buildScenario, data, REALISED_WITHIN_DAYS, realisingCycle, seasonRealisation, type BuildScenarioArgs } from '../src/services/year-plan';
import { addDays } from '../src/services/year-plan/dates';
import { ALT_PREFIX, alternativesFrom, alternativesSetup, isSameAsSavedSeason, onlySavedSeasonsFit, ONLY_SAVED_LIMITATION } from '../src/services/year-plan/alternatives';
import { applyYearPlan, ensureYearPlan, generateYearPlan, readYearPlan, type YearPlanDeps } from '../src/services/year-plan/service';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Planned-season replaceability and year plan alternatives (docs/research/EVARA_ACTIONS_SPEC.md 1.1 and 1.3, packet E1).
 * Realisation tests are pure. Service tests use the test DB, the real read-only research files (Hassan, Karnataka) and
 * SYNTHETIC price and rain sources; no model is called (alternatives are code-selected). Farms, cycles, saved seasons and
 * prices are SYNTHETIC test data, not field observations.
 */
const ASOF = '2026-11-01';
const H = 'IN-KA-hassan';

// ---------------------------------------------------------------- realisation (pure)
describe('saved-season realisation (EVARA_ACTIONS_SPEC 1.1)', () => {
  const season = (over: Record<string, unknown> = {}) => ({ cropId: 'pigeon-pea', plannedSowingDate: '2027-02-12', ...over });
  const cy = (over: Record<string, unknown> = {}) => ({ id: 'cy', cropId: 'pigeon-pea', sowingDate: '2027-02-12', ...over }) as { id: string; cropId: string; sowingDate: string; fieldId?: string };

  it('sown within 45 days either side (inclusive), same crop; one day further, another crop or no cycle is planned', () => {
    expect(REALISED_WITHIN_DAYS).toBe(45);
    expect(seasonRealisation(season(), [cy({ sowingDate: addDays('2027-02-12', 45) })], ASOF)).toBe('sown');
    expect(seasonRealisation(season(), [cy({ sowingDate: addDays('2027-02-12', -45) })], ASOF)).toBe('sown');
    expect(seasonRealisation(season(), [cy({ sowingDate: addDays('2027-02-12', 46) })], ASOF)).toBe('planned');
    expect(seasonRealisation(season(), [cy({ sowingDate: addDays('2027-02-12', -46) })], ASOF)).toBe('planned');
    expect(seasonRealisation(season(), [cy({ cropId: 'paddy' })], ASOF)).toBe('planned');
    expect(seasonRealisation(season(), [], ASOF)).toBe('planned');
    expect(seasonRealisation({ cropId: 'pigeon-pea' }, [cy()], ASOF)).toBeNull();
    // The closest cycle realises it.
    expect(realisingCycle(season(), [cy({ id: 'far', sowingDate: '2027-03-20' }), cy({ id: 'near', sowingDate: '2027-02-01' })])!.id).toBe('near');
  });

  it('overdue when the planned date has passed unsown; planned on the day itself (IST calendar date)', () => {
    expect(seasonRealisation(season({ plannedSowingDate: '2026-10-31' }), [], ASOF)).toBe('overdue');
    expect(seasonRealisation(season({ plannedSowingDate: ASOF }), [], ASOF)).toBe('planned');
    expect(seasonRealisation(season({ plannedSowingDate: '2026-10-31' }), [cy({ sowingDate: '2026-10-20' })], ASOF)).toBe('sown');
  });

  it('fields: same field or a legacy whole-farm cycle (or a farm-wide season) realises; another field\'s cycle does not', () => {
    expect(seasonRealisation(season({ fieldId: 'west' }), [cy({ fieldId: 'west' })], ASOF)).toBe('sown');
    expect(seasonRealisation(season({ fieldId: 'west' }), [cy()], ASOF)).toBe('sown'); // legacy whole-farm cycle
    expect(seasonRealisation(season(), [cy({ fieldId: 'east' })], ASOF)).toBe('sown'); // farm-wide season
    expect(seasonRealisation(season({ fieldId: 'west' }), [cy({ fieldId: 'east' })], ASOF)).toBe('planned');
  });

  it('buildScenario: a realised season is not an occupant (the cycle is); planned and overdue seasons carry their realisation; cycles are sown', () => {
    const args = (workspace: BuildScenarioArgs['workspace']): BuildScenarioArgs => ({ workspace, farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: {} }, asOf: ASOF });
    const ctx = buildScenario(args({
      previousHarvest: { status: 'none' },
      cycles: [
        { id: 'cy-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-08-01', stage: 'growing' },
        { id: 'cy-gg', cropId: 'green-gram', sowingDate: '2026-10-25', stage: 'sowed', harvestDate: '2026-12-30' },
      ],
      rotationPlans: [
        { id: 'sv-paddy', year: 2026, season: 'Kharif', cropId: 'paddy', plannedSowingDate: '2026-07-20' }, // realised by cy-paddy
        { id: 'sv-gg', year: 2026, season: 'Rabi', cropId: 'green-gram', plannedSowingDate: '2026-10-15', plannedHarvestDate: '2026-12-30' }, // realised by cy-gg
        { id: 'sv-late', year: 2026, season: 'Rabi', cropId: 'maize', plannedSowingDate: '2026-10-10', plannedHarvestDate: '2027-02-10' }, // overdue
        { id: 'sv-pp', year: 2027, season: 'Summer', cropId: 'pigeon-pea', plannedSowingDate: '2027-02-12' }, // planned
      ],
    } as never));
    expect(ctx.fixedSlot!.cycleId).toBe('cy-gg'); // the latest sown active cycle is the current one
    expect(ctx.occupied.map((o) => [o.id, o.realisation ?? null])).toEqual([['cy-paddy', null], ['sv-late', 'overdue'], ['sv-pp', 'planned']]);
    expect(ctx.scenario.occupied!.map((o) => [o.id, o.realisation])).toEqual([['cy-paddy', 'sown'], ['sv-late', 'overdue'], ['sv-pp', 'planned']]);
    const setup = alternativesSetup(ctx);
    expect(setup.basis).toBe('replace_planned');
    expect(setup.basis === 'replace_planned' && setup.replaced.map((o) => o.id)).toEqual(['sv-late', 'sv-pp']);
    expect(setup.basis === 'replace_planned' && setup.ctx.occupied.map((o) => o.id)).toEqual(['cy-paddy']);
  });
});

// ---------------------------------------------------------------- twins of saved seasons (pure)
describe('alternatives leave out plans that only repeat the saved seasons (EVARA_ACTIONS_SPEC 1.3, 2026-11-04)', () => {
  // The demo-farm case: paddy growing, Maize saved 5 Feb to 26 May 2027 and not sown. The engine then finds Maize 5 Feb 2027
  // again plus Sorghum and Black gram; the plan equal to the saved season must not be offered as its own replacement.
  const MAIZE = { id: 'sv-maize', year: 2027, season: 'Summer', cropId: 'maize', productId: 'maize-grain', plannedSowingDate: '2027-02-05', plannedHarvestDate: '2027-05-26' };
  const ctx = buildScenario({
    workspace: { previousHarvest: { status: 'none' }, cycles: [{ id: 'cy-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-08-01', stage: 'growing' }], rotationPlans: [MAIZE] } as never,
    farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: {} }, asOf: ASOF,
  });
  const setup = alternativesSetup(ctx);
  if (setup.basis !== 'replace_planned') throw new Error('fixture must give a replace_planned setup');
  const slot = (cropId: string, productId: string, sowing: string, fixed = false) => ({
    slotId: `slot-${cropId}-${sowing}`, cropId, productId, cropName: cropId, productName: productId, establishmentMethod: null, fixed, sowing,
    harvest: { earliest: addDays(sowing, 100), latest: addDays(sowing, 120) }, occupancy: { from: sowing, to: addDays(sowing, 125) }, durationDays: { min: 100, max: 120 },
    yieldKgPerHa: null, yieldBasis: null, price: null, cost: null, revenuePerHa: null, profitPerHa: null, score: 50,
    components: { soilRotation: 0.5, water: 0.5, price: 0.5, confidence: 0.5, windowFit: 0.5 }, confidence: 'medium', transitionNote: null, reasonCodes: [], uncertainties: [], basis: [],
  });
  const option = (optionId: string, score: number, ...own: ReturnType<typeof slot>[]) => ({
    optionId, label: 'Alternative', origin: 'deterministic', score, components: { soilRotation: 0.5, water: 0.5, price: 0.5, confidence: 0.5, windowFit: 0.5 },
    slots: [slot('paddy', 'paddy-grain', '2026-08-01', true), ...own], idleMonths: 0, reasons: [], totalRevenuePerHa: null, totalProfitPerHa: null,
  }) as never;
  const twin = (days = 0) => option('opt-maize', 90, slot('maize', 'maize-grain', addDays('2027-02-05', days)));
  const sorghum = option('opt-sorghum', 80, slot('sorghum', 'sorghum-grain', '2027-02-10'));
  const blackGram = option('opt-black-gram', 70, slot('black-gram', 'black-gram-whole', '2027-02-12'));
  const run = (...shortlist: unknown[]) => ({ sequencesConsidered: shortlist.length, shortlist: shortlist as never[] });

  it('the identical rule: same crop and product, planned sowing within 7 days either way; a product, crop or 8-day difference is not identical; no planned date is never identical', () => {
    const plan = { cropId: 'maize', productId: 'maize-grain', plannedSowingDate: '2027-02-05' };
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-grain', sowing: '2027-02-12' }, plan)).toBe(true);
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-grain', sowing: '2027-01-29' }, plan)).toBe(true);
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-grain', sowing: '2027-02-13' }, plan)).toBe(false);
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-green-cob', sowing: '2027-02-05' }, plan)).toBe(false);
    expect(isSameAsSavedSeason({ cropId: 'sorghum', productId: 'maize-grain', sowing: '2027-02-05' }, plan)).toBe(false);
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-grain', sowing: '2027-02-05' }, { cropId: 'maize' })).toBe(false);
    // A saved season that names no product leaves the crop to decide.
    expect(isSameAsSavedSeason({ cropId: 'maize', productId: 'maize-green-cob', sowing: '2027-02-05' }, { cropId: 'maize', plannedSowingDate: '2027-02-05' })).toBe(true);
  });

  it('live case: the engine finds Maize 5 Feb again plus Sorghum and Black gram -> the alternatives are Sorghum and Black gram, none is the Maize twin', () => {
    const alt = alternativesFrom(ctx, setup, run(twin(), sorghum, blackGram), [MAIZE] as never)!;
    expect(alt.options.map((o) => o.optionId)).toEqual(expect.arrayContaining([`${ALT_PREFIX}opt-sorghum`, `${ALT_PREFIX}opt-black-gram`]));
    expect(alt.options).toHaveLength(2);
    expect(alt.options.some((o) => o.slots.some((s) => !s.fixed && s.cropId === 'maize'))).toBe(false);
    expect(alt.replaces.map((r) => r.rotationPlanId)).toEqual(['sv-maize']);
    expect(alt.summary).toContain('2 alternative plans');
  });

  it('a twin sown 7 days off is still dropped, 8 days off is kept; the next options fill the cap of 3', () => {
    const more = option('opt-groundnut', 60, slot('groundnut', 'groundnut-pod', '2027-02-20'));
    const alt = alternativesFrom(ctx, setup, run(twin(7), twin(-7), option('opt-maize-8', 85, slot('maize', 'maize-grain', '2027-02-13')), sorghum, blackGram, more), [MAIZE] as never)!;
    const ids = alt.options.map((o) => o.optionId.replace(ALT_PREFIX, ''));
    expect(ids).not.toContain('opt-maize');
    expect(ids).toHaveLength(3);
    expect(ids).toContain('opt-maize-8');
  });

  it('a plan with a non-identical season next to the saved crop is kept (only plans made wholly of saved seasons are dropped)', () => {
    const mixed = option('opt-mixed', 95, slot('maize', 'maize-grain', '2027-02-05'), slot('sorghum', 'sorghum-grain', '2027-06-20'));
    const alt = alternativesFrom(ctx, setup, run(mixed, sorghum), [MAIZE] as never)!;
    expect(alt.options.map((o) => o.optionId)).toContain(`${ALT_PREFIX}opt-mixed`);
  });

  it('only the saved season fits: alternatives are null and onlySavedSeasonsFit gives the reason; with no plans at all it does not', () => {
    expect(alternativesFrom(ctx, setup, run(twin(), twin(3)), [MAIZE] as never)).toBeNull();
    expect(onlySavedSeasonsFit(setup, run(twin(), twin(3)), [MAIZE] as never)).toBe(true);
    expect(ONLY_SAVED_LIMITATION).toBe('The only plans that fit are the seasons already saved.');
    expect(onlySavedSeasonsFit(setup, run(twin(), sorghum), [MAIZE] as never)).toBe(false);
    expect(onlySavedSeasonsFit(setup, run(), [MAIZE] as never)).toBe(false);
    expect(alternativesFrom(ctx, setup, run(), [MAIZE] as never)).toBeNull();
  });

  it('a sown comparison never drops anything (nothing is replaced)', () => {
    const comparison = alternativesSetup(buildScenario({
      workspace: { previousHarvest: { status: 'none' }, cycles: [{ id: 'cy-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-08-01', stage: 'growing' }], rotationPlans: [] } as never,
      farm: { location: { stateCode: 'IN-KA', districtId: H }, areaHectares: 1, facts: {} }, asOf: ASOF,
    }));
    if (comparison.basis !== 'sown_comparison') throw new Error('expected a comparison');
    expect(alternativesFrom(ctx, comparison, run(twin()), [MAIZE] as never)!.options).toHaveLength(1);
    expect(onlySavedSeasonsFit(comparison, run(twin()), [MAIZE] as never)).toBe(false);
  });
});

// ---------------------------------------------------------------- service (test DB, real research files)
let h: Harness, a: Client;
const NOW = () => new Date(`${ASOF}T06:00:00Z`);
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
const deps = (): YearPlanDeps => ({
  pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW,
  sources: { priceOutlook: async (x) => fakeOutlook(x), climatology: async (_s, range) => ({ years: { from: 2016, to: 2025 }, sourceId: 'synthetic-normals', days: RAIN_DAYS(range.start, range.end) }), neighbourhood: async () => { throw new Error('ndvi unavailable in test'); } },
});

async function farm() {
  const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Alternatives QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: H, precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data as { id: string };
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  return { id: f.id, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
async function put(ownerId: string, farmId: string, cycles: unknown[], rotationPlans: unknown[]) {
  const cur = await getWorkspace(h.pool, ownerId, farmId);
  return putWorkspace(h.pool, ownerId, farmId, { expectedVersion: cur.version, boundary: null, previousHarvest: { status: 'none' }, cycles, rotationPlans } as never);
}
async function generate(auth: { ownerId: string; sessionId: string }, id: string) {
  const r = await ensureYearPlan(deps(), auth, id);
  await generateYearPlan(deps(), r.reviewId!, auth.ownerId);
  return readYearPlan(deps(), auth.ownerId, id);
}
/** The Hassan case of the request (2026-11-04): growing paddy, pigeon pea saved for Feb 2027 and not sown. */
const PADDY = { id: 'cy-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-08-01', establishmentDate: '2026-08-01', stage: 'growing' };
const PIGEON_PEA = { id: 'sv-pp', year: 2027, season: 'Summer', cropId: 'pigeon-pea', cropName: 'Pigeon pea', plannedSowingDate: '2027-02-12' };

describe('year plan alternatives (test DB)', () => {
  beforeAll(async () => { data.invalidate(); h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); }, 120_000);
  afterAll(async () => h?.close());

  it('Hassan: growing paddy + pigeon pea planned (not sown) -> noFreeWindow, alternatives replace_planned naming pigeon pea, code-selected, the paddy fixed in each', async () => {
    const { id, auth } = await farm();
    await put(auth.ownerId, id, [PADDY], [PIGEON_PEA]);
    const review = await generate(auth, id);
    expect(YearPlanReview.safeParse(review).success).toBe(true);
    expect(review.noFreeWindow).toBe(true);
    expect(review.scenario.occupied!.map((o) => [o.id, o.realisation])).toEqual([['sv-pp', 'planned']]);
    const alt = review.alternatives!;
    expect(alt).toBeTruthy();
    expect(alt.basis).toBe('replace_planned');
    expect(alt.replaces).toEqual([{ rotationPlanId: 'sv-pp', cropId: 'pigeon-pea', cropName: 'Pigeon pea', plannedSowingDate: '2027-02-12' }]);
    expect(alt.options.length).toBeGreaterThan(0);
    expect(alt.options.length).toBeLessThanOrEqual(3);
    for (const o of alt.options) {
      expect(o.optionId.startsWith(ALT_PREFIX)).toBe(true);
      expect(o.origin).toBe('deterministic');
      expect(o.slots[0]).toMatchObject({ fixed: true, cropId: 'paddy' });
      expect(o.slots.some((s) => !s.fixed)).toBe(true);
    }
    // At least one alternative takes over the pigeon pea months (nothing fits around it, so every plan does).
    const pp = { from: '2027-02-12' };
    expect(alt.options.every((o) => o.slots.some((s) => !s.fixed && s.occupancy.to > pp.from))).toBe(true);
    expect(alt.options.map((o) => o.optionId)).not.toEqual(expect.arrayContaining(review.options.map((o) => o.optionId)));
    expect(alt.summary).toBe(`Pigeon pea (planned 12 Feb 2027) is planned but not sown, so ${alt.options.length} alternative plan${alt.options.length > 1 ? 's' : ''} below show what could grow instead; using one replaces the planned season it overlaps.`);
    expect(alt.limitations.join(' ')).toContain('no model selection');
    // The review's own summary points at the alternatives instead of a dead end; the main options stay the growing crop alone.
    expect(review.summary).toContain('alternative plan');
    expect(review.options).toHaveLength(1);
    expect(review.options[0]!.slots.every((s) => s.fixed)).toBe(true);
    expect(review.modelSelection).toEqual({ outcome: 'not_needed', detail: null });
  });

  it('apply with alternative: removes the replaced pigeon pea and appends the slots with the usual ids in one write; a repeat is a no-op; without the flag the option is not found', async () => {
    const { id, auth } = await farm();
    await put(auth.ownerId, id, [PADDY], [PIGEON_PEA, { id: 'sv-keep', year: 2028, season: 'Kharif', cropId: 'maize', plannedSowingDate: '2028-06-10', plannedHarvestDate: '2028-09-30' }]);
    const review = await generate(auth, id);
    const option = review.alternatives!.options[0]!;
    const before = await getWorkspace(h.pool, auth.ownerId, id);
    await expect(applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version })).rejects.toMatchObject({ statusCode: 404 });
    const applied = await applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version, alternative: true });
    const ids = applied.workspace.rotationPlans.map((p) => p.id);
    expect(ids).not.toContain('sv-pp');
    expect(ids).toContain('sv-keep'); // outside the horizon, not listed as replaced
    const added = option.slots.filter((s) => !s.fixed).map((s) => `yearplan:${review.reviewId}:${option.optionId}:${s.slotId}`);
    expect(ids).toEqual(expect.arrayContaining(added));
    expect(applied.workspace.version).toBe(before.version + 1);
    // The applied review is not re-keyed: the response carries the fresh review of the new context, not the applied one.
    expect(applied.review.reviewId).not.toBe(review.reviewId);
    expect(applied.review.contextHash).not.toBe(review.contextHash);
    expect(applied.review.appliedOptionIds).toEqual([]);
    expect(applied.review.stale).toBe(false);
    // Repeated apply: same workspace, no new version, and again the current review (the same pending one), never the stale applied one.
    const again = await applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version, alternative: true });
    expect(again.workspace.version).toBe(applied.workspace.version);
    expect(again.workspace.rotationPlans.map((p) => p.id)).toEqual(ids);
    expect(again.review.reviewId).toBe(applied.review.reviewId);
  });

  it('after an alternative apply the field reads a fresh review of the new context, not the re-keyed old one (no "Instead of" cards, the removed season gone); a normal apply still re-keys', async () => {
    const { id, auth } = await farm();
    await put(auth.ownerId, id, [PADDY], [PIGEON_PEA]);
    const review = await generate(auth, id);
    expect(review.alternatives).toBeTruthy();
    expect(review.scenario.occupied!.map((o) => o.id)).toEqual(['sv-pp']);
    const option = review.alternatives!.options[0]!;
    const before = await getWorkspace(h.pool, auth.ownerId, id);
    const applied = await applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version, alternative: true });
    expect(applied.workspace.rotationPlans.some((p) => p.id === 'sv-pp')).toBe(false);
    // Apply response: pending/running for the new hash, with the new occupants and none of the old alternatives.
    expect(['pending', 'running']).toContain(applied.review.status);
    expect(applied.review.contextHash).not.toBe(review.contextHash);
    expect(applied.review.alternatives ?? null).toBeNull();
    expect(applied.review.scenario.occupied!.map((o) => o.id)).not.toContain('sv-pp');
    // The old row keeps its old hash and no longer matches the field.
    const old = (await h.pool.query<{ context_hash: string; archived_at: Date | null }>('SELECT context_hash,archived_at FROM farm_year_plans WHERE id=$1', [review.reviewId])).rows[0]!;
    expect(old.context_hash).toBe(review.contextHash);
    // Reading the year plan finds the new row (the one the build job fills), and ensure does not skip the build.
    const read = await readYearPlan(deps(), auth.ownerId, id);
    expect(read.reviewId).toBe(applied.review.reviewId);
    expect(read.contextHash).toBe(applied.review.contextHash);
    expect(read.stale).toBe(false);
    expect(read.alternatives ?? null).toBeNull();
    const ensured = await ensureYearPlan(deps(), auth, id);
    expect(ensured.reviewId).toBe(applied.review.reviewId);
    expect(ensured.jobId).toBeTruthy();
    await generateYearPlan(deps(), applied.review.reviewId!, auth.ownerId);
    const built = await readYearPlan(deps(), auth.ownerId, id);
    expect(built.reviewId).toBe(applied.review.reviewId);
    expect(['ready', 'partial', 'unavailable']).toContain(built.status);
    expect(built.appliedOptionIds).toEqual([]);
    expect(built.scenario.occupied!.map((o) => o.id)).not.toContain('sv-pp');
    expect(`${built.summary} ${built.alternatives?.summary ?? ''}`).not.toContain('Instead of Pigeon pea');
    expect(JSON.stringify(built.alternatives?.replaces ?? [])).not.toContain('sv-pp');

    // A normal apply (free window) is unchanged: the same row is re-keyed to the new hash and records the applied option.
    const n = await farm();
    await put(n.auth.ownerId, n.id, [PADDY], []);
    const nr = await generate(n.auth, n.id);
    const nopt = nr.options.find((o) => o.slots.some((s) => !s.fixed && s.sowing >= ASOF))!;
    const nbefore = await getWorkspace(h.pool, n.auth.ownerId, n.id);
    const napplied = await applyYearPlan(deps(), n.auth.ownerId, n.id, { reviewId: nr.reviewId!, optionId: nopt.optionId, expectedWorkspaceVersion: nbefore.version });
    expect(napplied.review.reviewId).toBe(nr.reviewId);
    expect(napplied.review.contextHash).not.toBe(nr.contextHash);
    expect(napplied.review.appliedOptionIds).toContain(nopt.optionId);
    expect(napplied.review.stale).toBe(false);
    expect((await readYearPlan(deps(), n.auth.ownerId, n.id)).reviewId).toBe(nr.reviewId);
  });

  it('a fresh field whose planned seasons fill the year: status unavailable with alternatives; an alternative can still be applied', async () => {
    const { id, auth } = await farm();
    const full = [
      { id: 'full-1', year: 2026, season: 'Rabi', cropId: 'groundnut', plannedSowingDate: '2026-11-01', plannedHarvestDate: '2027-03-01' },
      { id: 'full-2', year: 2027, season: 'Summer', cropId: 'groundnut', plannedSowingDate: '2027-03-11', plannedHarvestDate: '2027-07-01' },
      { id: 'full-3', year: 2027, season: 'Kharif', cropId: 'groundnut', plannedSowingDate: '2027-07-11', plannedHarvestDate: '2027-11-05' },
    ];
    await put(auth.ownerId, id, [], full);
    const review = await generate(auth, id);
    expect(review.status).toBe('unavailable');
    expect(review.options).toEqual([]);
    expect(review.noFreeWindow).toBe(true);
    const alt = review.alternatives!;
    expect(alt.basis).toBe('replace_planned');
    expect(alt.replaces.map((r) => r.rotationPlanId)).toEqual(['full-1', 'full-2', 'full-3']);
    expect(review.summary).toBe(`The planned seasons fill this year, so no new season fits around them; ${alt.options.length} alternative plan${alt.options.length > 1 ? 's' : ''} below would use the months of the planned, unsown seasons instead.`);
    const option = alt.options.find((o) => o.slots.every((s) => s.sowing >= ASOF))!;
    const before = await getWorkspace(h.pool, auth.ownerId, id);
    const applied = await applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version, alternative: true });
    const overlapped = full.filter((p) => option.slots.some((s) => s.occupancy.from < addDays(p.plannedHarvestDate, 10) && p.plannedSowingDate < s.occupancy.to)).map((p) => p.id);
    expect(overlapped.length).toBeGreaterThan(0);
    for (const p of full) expect(applied.workspace.rotationPlans.some((x) => x.id === p.id)).toBe(!overlapped.includes(p.id));
  });

  it('sown comparison: every saved season is realised by a recorded cycle and the crops fill the year -> basis sown_comparison from the sowing date, no fixed slot; apply refuses it (400 alternative_not_applicable)', async () => {
    const { id, auth } = await farm();
    // Paddy sown 1 Aug and turmeric sown 10 Aug 2026 (the current crop, held into mid 2027); both saved seasons are realised by them.
    const turmeric = { id: 'cy-turmeric', cropId: 'turmeric', sowingDate: '2026-08-10', establishmentDate: '2026-08-10', stage: 'growing' };
    await put(auth.ownerId, id, [PADDY, turmeric], [
      { id: 'sv-paddy', year: 2026, season: 'Kharif', cropId: 'paddy', plannedSowingDate: '2026-07-25', plannedHarvestDate: '2026-12-15' },
      { id: 'sv-turmeric', year: 2026, season: 'Kharif', cropId: 'turmeric', plannedSowingDate: '2026-08-20' },
    ]);
    const review = await generate(auth, id);
    expect(YearPlanReview.safeParse(review).success).toBe(true);
    // The realised seasons are the cycles themselves, not drawn twice; the paddy cycle is the only occupant.
    expect(review.scenario.currentCycleId).toBe('cy-turmeric');
    expect(review.scenario.occupied!.map((o) => [o.id, o.source, o.realisation])).toEqual([['cy-paddy', 'recorded_cycle', 'sown']]);
    // The growing turmeric alone fills the year (noFreeWindow is about occupants, so false); no sequence fits, so alternatives run.
    expect(review.noFreeWindow).toBe(false);
    expect(review.options).toHaveLength(1);
    expect(review.options[0]!.slots.every((s) => s.fixed)).toBe(true);
    const alt = review.alternatives!;
    expect(alt.basis).toBe('sown_comparison');
    expect(alt.replaces).toEqual([]);
    expect(alt.horizon.from).toBe('2026-08-10');
    expect(alt.options.length).toBeGreaterThan(0);
    expect(alt.options.every((o) => o.optionId.startsWith(ALT_PREFIX) && o.slots.every((s) => !s.fixed) && o.slots[0]!.sowing >= '2026-08-10')).toBe(true);
    expect(alt.summary).toContain('for comparison');
    expect(alt.summary).toContain('the sown turmeric stays');
    expect(review.summary).toContain('comparison plan');
    const ws = await getWorkspace(h.pool, auth.ownerId, id);
    await expect(applyYearPlan(deps(), auth.ownerId, id, { reviewId: review.reviewId!, optionId: alt.options[0]!.optionId, expectedWorkspaceVersion: ws.version, alternative: true }))
      .rejects.toMatchObject({ statusCode: 400, code: 'alternative_not_applicable' });
    // Through the route: the code is in the ApiErrorCode enum, so the envelope carries it as the top-level code.
    const res = await a.call('POST', `/api/v1/farms/${id}/year-plan/apply`, { payload: { reviewId: review.reviewId, optionId: alt.options[0]!.optionId, expectedWorkspaceVersion: ws.version, alternative: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'alternative_not_applicable' });
    expect((await getWorkspace(h.pool, auth.ownerId, id)).version).toBe(ws.version);
  });

  it('a field with a free window has alternatives null', async () => {
    const { id, auth } = await farm();
    await put(auth.ownerId, id, [PADDY], []);
    const review = await generate(auth, id);
    expect(review.noFreeWindow).toBe(false);
    expect(review.options.some((o) => o.slots.some((s) => !s.fixed))).toBe(true);
    expect(review.alternatives).toBeNull();
  });
});
