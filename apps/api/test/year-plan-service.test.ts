import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { YearPlanOption, YearPlanReview, type HarvestPriceOutlook } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { patchFarm } from '../src/services/farms';
import { ASSUMPTIONS, buildScenario, data, emptyInputs, priceScore, runYearPlanEngine } from '../src/services/year-plan';
import { applyYearPlan, ensureYearPlan, generateYearPlan, INPUTS_CHANGED_BEFORE_START, readYearPlan, rescoreYearPlan, yearPlanContext, type YearPlanDeps } from '../src/services/year-plan/service';
import { stageTimeline } from '../src/services/today/stage-timeline';
import { addDays } from '../src/services/year-plan/dates';
import { gateSelection, PLAN_LABELS, selectionCandidates } from '../src/services/year-plan/select';
import type { TextModelProvider } from '../src/agent/provider';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Year-plan service tests (test DB). Every price, rain and NDVI figure here is a SYNTHETIC fake injected through
 * deps.sources; the Meta transport is a fake provider. Research files are the real read-only ones.
 */
let h: Harness, a: Client, b: Client;
beforeAll(async () => { h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); b = await login(h.app); });
afterAll(async () => h.close());

const ASOF_NOW = () => new Date('2026-11-01T06:00:00Z');
function fakeOutlook(args: { productId: string; harvestDate: string; asOf: string }): HarvestPriceOutlook {
  return {
    productId: args.productId, status: 'available', missingReason: null,
    scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 3, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price, not a market observation', limitations: ['synthetic'],
    method: 'B_seasonal_reference/pooled-v1', harvestDate: args.harvestDate, harvestWeek: { year: 2027, week: 10 }, asOf: args.asOf, weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 18, p25: 20, p50: 25, p75: 30, p90: 33, annualMean: 24, annualWeeks: 150, weeksUsed: 15, observations: 120, marketsUsed: 3, residualCount: 140,
  } as HarvestPriceOutlook;
}
const RAIN_DAYS = (start: string, end: string) => { const out = []; for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400_000) { const d = new Date(t).toISOString().slice(0, 10); const m = Number(d.slice(5, 7)); out.push({ date: d, rainMm: m >= 6 && m <= 10 ? 6 : 0.5, et0Mm: null, tMaxC: null, tMinC: null, sourceId: 'synthetic' }); } return out; };
const liveSources: YearPlanDeps['sources'] = {
  priceOutlook: async (x) => fakeOutlook(x),
  climatology: async (_scope, range) => ({ years: { from: 2016, to: 2025 }, sourceId: 'synthetic-normals', days: RAIN_DAYS(range.start, range.end) }),
  neighbourhood: async () => { throw new Error('ndvi unavailable in test'); },
};
const deps = (over: Partial<YearPlanDeps> = {}): YearPlanDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: ASOF_NOW, ...over });
const liveDeps = (provider: TextModelProvider, over: Partial<YearPlanDeps> = {}) => deps({ config: { ...h.config, RUNTIME_MODE: 'live', MODEL_API_KEY: 'fixture-key' }, provider, sources: liveSources, ...over });

async function farm(client = a) {
  const f = (await client.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Year plan QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data;
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  return { f, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
async function generate(d: YearPlanDeps, auth: { ownerId: string; sessionId: string }, id: string) {
  const r = await ensureYearPlan(d, auth, id);
  await generateYearPlan(d, r.reviewId!, auth.ownerId);
  return readYearPlan(d, auth.ownerId, id);
}

/** Fake Meta: reads the candidates from the input and answers per `mode`. */
function fakeMeta(mode: 'valid' | 'foreign' | 'digit' | 'unknown_code') {
  const calls: { input: string; store: unknown; effort: unknown }[] = [];
  const provider: TextModelProvider & { deleteResponse: ReturnType<typeof vi.fn> } = {
    kind: 'meta', provenance: 'meta_live', billable: false,
    call: vi.fn(async (req) => {
      calls.push({ input: String(req.input), store: req.store, effort: req.reasoningEffort });
      const input = JSON.parse(String(req.input)) as { candidates: { candidateId: string; allowedLabels: string[]; reasonCodes: string[] }[] };
      const used = new Set<string>(); const plans: { candidateId: string; label: string; reasonCodes: string[]; sentence: string }[] = [];
      for (const c of input.candidates) {
        const label = c.allowedLabels.find((l) => !used.has(l));
        if (!label || plans.length >= 3) continue;
        used.add(label);
        plans.push({ candidateId: c.candidateId, label, reasonCodes: c.reasonCodes.slice(0, 2), sentence: 'Fits the free months of the field and follows the previous crop well.' });
      }
      if (mode === 'foreign') plans[0]!.candidateId = 'opt-not-in-shortlist';
      if (mode === 'digit') plans[1]!.sentence = 'Harvest falls in 3 strong price weeks.';
      if (mode === 'unknown_code') plans[2]!.reasonCodes = ['nitrogen_boost'];
      return { ok: true as const, result: { provenance: 'meta_live' as const, responseId: `resp-${mode}`, requestId: 'req', model: 'fixture-received-model', outputText: JSON.stringify({ plans }), functionCalls: [], usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0 }, latencyMs: 1, retries: 0 } };
    }),
    deleteResponse: vi.fn(async () => ({ ok: true, code: null })),
  };
  return { provider, calls };
}

describe('year-plan review service', () => {
  it('synthetic: concurrent ensures converge, the worker saves three deterministic options, cached by hash, no network or model call', async () => {
    const { f, auth } = await farm();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = deps({ fetchImpl: vi.fn(async () => { throw new Error('network not allowed'); }) as unknown as typeof fetch });
    const [one, two] = await Promise.all([ensureYearPlan(d, auth, f.id), ensureYearPlan(d, auth, f.id)]);
    expect(one.reviewId).toBe(two.reviewId);
    expect(one.status).toBe('pending');
    expect(Number((await h.pool.query('SELECT count(*) FROM farm_year_plans WHERE farm_id=$1', [f.id])).rows[0].count)).toBe(1);
    await generateYearPlan(d, one.reviewId!, auth.ownerId);
    const review = await readYearPlan(d, auth.ownerId, f.id);
    expect(YearPlanReview.safeParse(review).success).toBe(true);
    expect(review.status).toBe('partial');
    expect(review.options).toHaveLength(3);
    expect(review.options.every((o) => o.origin === 'deterministic')).toBe(true);
    expect(review.stale).toBe(false);
    const again = await ensureYearPlan(d, auth, f.id);
    expect(again.reviewId).toBe(one.reviewId);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((d.fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(Number((await h.pool.query('SELECT count(*) FROM ai_invocations WHERE owner_id=$1', [auth.ownerId])).rows[0].count)).toBe(0);
    fetchSpy.mockRestore();
  });

  it('live with a valid Meta answer: ready, three model options with code-allowed labels, store false, response deleted', async () => {
    const { f, auth } = await farm();
    const meta = fakeMeta('valid');
    const review = await generate(liveDeps(meta.provider), auth, f.id);
    expect(review.status).toBe('ready');
    expect(review.options).toHaveLength(3);
    for (const o of review.options) {
      YearPlanOption.parse(o);
      expect(o.origin).toBe('model');
      expect((PLAN_LABELS as readonly string[]).includes(o.label)).toBe(true);
      expect(o.reasons.at(-1)).toEqual({ code: 'model_sentence', text: 'Fits the free months of the field and follows the previous crop well.' });
    }
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toMatchObject({ store: false, effort: 'low' });
    expect(meta.provider.deleteResponse).toHaveBeenCalledWith('resp-valid');
    const stored = (await h.pool.query('SELECT input_context FROM farm_year_plans WHERE id=$1', [review.reviewId])).rows[0].input_context;
    expect(stored.norm.maxMarginRate === null || stored.norm.maxMarginRate > 0).toBe(true);
    expect(stored.inputs.priceKeys.looked).toBeLessThanOrEqual(160);
  });

  for (const mode of ['foreign', 'digit', 'unknown_code'] as const) {
    it(`rejects a Meta answer with ${mode} and keeps the deterministic plans (partial, retry later)`, async () => {
      const { f, auth } = await farm();
      const meta = fakeMeta(mode);
      const review = await generate(liveDeps(meta.provider), auth, f.id);
      expect(review.status).toBe('partial');
      expect(review.retryAfter).not.toBeNull();
      expect(review.options.every((o) => o.origin === 'deterministic')).toBe(true);
      expect(review.limitations.join(' ')).toContain('gate_');
      expect(meta.provider.deleteResponse).toHaveBeenCalled();
    });
  }

  it('rescore keeps the stored norm and returns "<id>:edit" as farmer_edit; apply is idempotent and never changes existing seasons', async () => {
    const { f, auth } = await farm();
    const existing = { id: 'own-2028', year: 2028, season: 'Kharif', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', productName: 'Maize grain', plannedSowingDate: '2028-06-10', plannedHarvestDate: '2028-09-30', notes: 'farmer entry' };
    await putWorkspace(h.pool, auth.ownerId, f.id, { expectedVersion: 0, boundary: null, previousHarvest: { status: 'none' }, cycles: [], rotationPlans: [existing] });
    const d = liveDeps(fakeMeta('valid').provider);
    const review = await generate(d, auth, f.id);
    const option = review.options[0]!;
    const edited = await rescoreYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, slots: option.slots.filter((s) => !s.fixed).map((s) => ({ slotId: s.slotId, cropId: s.cropId, productId: s.productId, sowing: s.sowing, harvestLatest: s.harvest.latest, ...(s.establishmentMethod ? { establishmentMethod: s.establishmentMethod } : {}) })) });
    YearPlanOption.parse(edited);
    expect(edited.origin).toBe('farmer_edit');
    expect(edited.optionId).toBe(`${option.optionId}:edit`);
    expect(edited.warnings.join(' ')).not.toContain('normalised within this edited plan only');
    await expect(rescoreYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, slots: [{ cropId: 'maize', productId: 'maize-grain', sowing: 'not-a-date' as string }] })).rejects.toMatchObject({ statusCode: 400 });
    const before = await getWorkspace(h.pool, auth.ownerId, f.id);
    const applied = await applyYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version });
    const added = applied.workspace.rotationPlans.filter((p) => p.id.startsWith(`yearplan:${review.reviewId}:${option.optionId}:`));
    expect(added.length).toBe(option.slots.filter((s) => !s.fixed).length);
    expect(applied.workspace.rotationPlans.find((p) => p.id === 'own-2028')).toEqual(before.rotationPlans.find((p) => p.id === 'own-2028'));
    expect(applied.review.appliedOptionIds).toContain(option.optionId);
    expect(applied.review.stale).toBe(false);
    const again = await applyYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: before.version });
    expect(again.workspace.version).toBe(applied.workspace.version);
    expect(again.workspace.rotationPlans).toHaveLength(applied.workspace.rotationPlans.length);
  });

  it('ensure restarts at once after a context-mismatch error or force, keeps the 15-minute rule for provider errors, never replaces a plan being built', async () => {
    const d = deps();
    const state = async (id: string) => (await h.pool.query<{ archived: boolean; status: string }>('SELECT archived_at IS NOT NULL AS archived, status FROM farm_year_plans WHERE id=$1', [id])).rows[0]!;
    const setError = (id: string, summary: string) => h.pool.query("UPDATE farm_year_plans SET status='error', result=jsonb_set(result,'{summary}',to_jsonb($2::text)) WHERE id=$1", [id, summary]);

    // 1. A real mismatch written by the worker: inputs change between ensure and generate.
    const m = await farm();
    const first = await ensureYearPlan(d, m.auth, m.f.id);
    await patchFarm(h.pool, m.auth.ownerId, m.f.id, { facts: { irrigation_category: { value: 'irrigated', basis: 'farmer_reported', confirmed: true } } });
    await generateYearPlan(d, first.reviewId!, m.auth.ownerId);
    const failed = (await h.pool.query<{ status: string; result: { summary: string } }>('SELECT status,result FROM farm_year_plans WHERE id=$1', [first.reviewId])).rows[0]!;
    expect(failed.status).toBe('error');
    expect(failed.result.summary.startsWith(INPUTS_CHANGED_BEFORE_START)).toBe(true);
    // The inputs are back to what that row recorded: the row now matches the current hash and still holds the mismatch error.
    const current = await yearPlanContext(d, m.auth.ownerId, m.f.id, '2026-11-01');
    await h.pool.query('UPDATE farm_year_plans SET context_hash=$2 WHERE id=$1', [first.reviewId, current.hash]);
    const second = await ensureYearPlan(d, m.auth, m.f.id);
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(second.status).toBe('pending');
    expect(await state(first.reviewId!)).toMatchObject({ archived: true });

    // 2. A provider error inside the cooldown is not retried by a plain ensure.
    const p = await farm();
    const row = await ensureYearPlan(d, p.auth, p.f.id);
    await setError(row.reviewId!, 'The year plan could not be built right now. Retry after the cooldown.');
    const same = await ensureYearPlan(d, p.auth, p.f.id);
    expect(same.reviewId).toBe(row.reviewId);
    expect(same.status).toBe('error');
    expect(await state(row.reviewId!)).toMatchObject({ archived: false, status: 'error' });
    // ... but force replaces it immediately, and the error row is archived.
    const forced = await ensureYearPlan(d, p.auth, p.f.id, { force: true });
    expect(forced.reviewId).not.toBe(row.reviewId);
    expect(forced.status).toBe('pending');
    expect(await state(row.reviewId!)).toMatchObject({ archived: true });
    expect(Number((await h.pool.query('SELECT count(*) FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL', [p.f.id])).rows[0].count)).toBe(1);

    // 3. force never replaces a plan whose job is still in flight.
    const again = await ensureYearPlan(d, p.auth, p.f.id, { force: true });
    expect(again.reviewId).toBe(forced.reviewId);
    expect(await state(forced.reviewId!)).toMatchObject({ archived: false, status: 'pending' });
  });

  it('a changed farm context makes rescore and apply 409 review_stale; other owners get 404', async () => {
    const { f, auth } = await farm();
    const d = liveDeps(fakeMeta('valid').provider);
    const review = await generate(d, auth, f.id);
    const option = review.options[0]!;
    const other = await farm(b);
    await expect(readYearPlan(d, other.auth.ownerId, f.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ensureYearPlan(d, other.auth, f.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(applyYearPlan(d, other.auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: 0 })).rejects.toMatchObject({ statusCode: 404 });
    await patchFarm(h.pool, auth.ownerId, f.id, { facts: { irrigation_category: { value: 'irrigated', basis: 'farmer_reported', confirmed: true } } });
    expect((await readYearPlan(d, auth.ownerId, f.id)).stale).toBe(true);
    await expect(rescoreYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, slots: [{ cropId: 'maize', productId: 'maize-grain', sowing: '2027-06-01' }] })).rejects.toMatchObject({ statusCode: 409, code: 'review_stale' });
    await expect(applyYearPlan(d, auth.ownerId, f.id, { reviewId: review.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: 0 })).rejects.toMatchObject({ statusCode: 409, code: 'review_stale' });
  });

  it('gate unit: an unsupported label is replaced by a code-allowed one (labelAdjusted); foreign ids, unknown codes and digits still reject', () => {
    data.invalidate();
    const ctx = buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [] }, farm: { location: { stateCode: 'IN-KA', districtId: 'IN-KA-hassan' }, areaHectares: 1, facts: {} }, asOf: '2026-11-01' });
    const run = runYearPlanEngine(ctx, emptyInputs('2026-11-01'));
    const cands = selectionCandidates(run.shortlist);
    const notAllowed = cands.find((c) => !c.allowedLabels.includes('Best price timing'))!;
    const ok = cands.filter((c) => c.allowedLabels.length).slice(0, 3);
    const plans = cands.slice(0, 3).map((c, i) => ({ candidateId: c.option.optionId, label: i === 0 ? 'Best price timing' : PLAN_LABELS[i]!, reasonCodes: c.codes.slice(0, 1), sentence: 'A plain sentence.' }));
    plans[0]!.candidateId = notAllowed.option.optionId;
    const gated = gateSelection({ plans }, cands);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect(gated.labelAdjusted).toEqual(expect.arrayContaining([expect.objectContaining({ candidateId: notAllowed.option.optionId, proposed: 'Best price timing', reason: 'label_not_supported' })]));
    const adjusted = gated.options.find((o) => o.optionId === notAllowed.option.optionId)!;
    expect(adjusted.label === 'Alternative' || notAllowed.allowedLabels.includes(adjusted.label as never)).toBe(true);
    expect(adjusted.reasons.at(-1)).toEqual({ code: 'model_sentence', text: 'A plain sentence.' });
    for (const o of gated.options) { const c = cands.find((x) => x.option.optionId === o.optionId)!; expect(o.label === 'Alternative' || c.allowedLabels.includes(o.label as never)).toBe(true); }
    expect(new Set(gated.options.filter((o) => o.label !== 'Alternative').map((o) => o.label)).size).toBe(gated.options.filter((o) => o.label !== 'Alternative').length);
    expect(gateSelection({ plans: plans.map((p, i) => (i === 1 ? { ...p, candidateId: 'opt-foreign' } : p)) }, cands)).toMatchObject({ ok: false, reason: 'foreign_candidate' });
    expect(gateSelection({ plans: plans.map((p, i) => (i === 1 ? { ...p, reasonCodes: ['nitrogen_boost'] } : p)) }, cands)).toMatchObject({ ok: false, reason: 'unknown_reason_code' });
    expect(gateSelection({ plans: plans.map((p, i) => (i === 1 ? { ...p, sentence: 'Sells in 3 good weeks.' } : p)) }, cands)).toMatchObject({ ok: false, reason: 'digit_in_sentence' });
    expect(ok.length).toBeGreaterThan(0);
  });
});

describe('engine adjustments (2026-11-01)', () => {
  afterEach(() => data.invalidate());
  it('missing cost: 0.7 x gross revenue rate relative to the candidate maximum, cost_not_sourced', () => {
    const outlook = { status: 'available', p50: 20, annualMean: 20 } as HarvestPriceOutlook;
    const slot = { yieldP50: 1000, costPerHa: null, postHarvestLossPct: null, occupancyDays: 100 };
    const r = priceScore(slot, outlook, null, 50, null);
    expect(r.marginPart).toBe(0);
    const rate = (20 * 1000) / (100 / 30.4375);
    const s = priceScore(slot, outlook, null, 50, rate * 2);
    expect(s.revenueRate).toBeCloseTo(rate, 9);
    expect(s.marginPart).toBeCloseTo(ASSUMPTIONS.missingCostRevenueFactor.value * 0.5, 12);
    expect(s.reasonCodes).toContain('cost_not_sourced');
  });
  it('district yields older than six crop years fall to state rows with a note', () => {
    const y = (region: string, cropYear: string, v: number) => ({ region, level: region === 'IN-KA' ? 'state' : 'district', season: 'Kharif', cropYear, yieldKgPerHa: v, basis: 'main product as published', sourceId: 'syn' });
    data.invalidate({ pool: { pool: [] }, agronomy: { crops: [] }, yieldCost: { crops: [{ cropId: 'maize', yields: [y('IN-KA-hassan', '2012-13', 2000), y('IN-KA-hassan', '2013-14', 2100), y('IN-KA', '2022-23', 3000), y('IN-KA', '2023-24', 3200)], costs: [] }] } });
    const where = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', season: 'kharif' as const };
    expect(data.yieldFor('maize', 'maize-grain', where)!.basis).toBe('district');
    const aged = data.yieldFor('maize', 'maize-grain', { ...where, asOf: '2026-11-01' })!;
    expect(aged.basis).toBe('state');
    expect(aged.notes.join(' ')).toContain('District figures too old');
  });
  it('the fixed current crop has window fit 1 and no outside_window reason', () => {
    data.invalidate();
    const ctx = buildScenario({ workspace: { previousHarvest: { status: 'unknown' }, cycles: [{ id: 'c1', cropId: 'paddy', sowingDate: '2026-10-25', stage: 'growing' }], rotationPlans: [] }, farm: { location: { stateCode: 'IN-KA', districtId: 'IN-KA-hassan' }, areaHectares: 1, facts: {} }, asOf: '2026-11-01' });
    expect(ctx.fixedSlot!.windowFit).toBe(1);
    expect(ctx.fixedSlot!.flags.outsideWindow).toBe(false);
    const run = runYearPlanEngine(ctx, emptyInputs('2026-11-01'));
    for (const o of run.options) expect(o.slots[0]!.reasonCodes).not.toContain('outside_window');
  });
});

describe('current crop harvest window and label evidence through the service (2026-11-01)', () => {
  afterEach(() => data.invalidate());
  it('the plan holds the field until the Today stage-timeline latest harvest date + 7 + 10 days and shows the same harvest window', async () => {
    data.invalidate();
    const { f, auth } = await farm();
    await putWorkspace(h.pool, auth.ownerId, f.id, { expectedVersion: 0, boundary: null, previousHarvest: { status: 'none' }, cycles: [{ id: randomUUID(), cropId: 'maize', sowingDate: '2026-09-20', stage: 'growing' }], rotationPlans: [] } as never);
    const c = await yearPlanContext(deps(), auth.ownerId, f.id, '2026-11-01');
    const tl = stageTimeline({ cropId: 'maize', productId: null, establishmentMethod: null, anchorDate: '2026-09-20', stateId: 'IN-KA', districtId: 'IN-KA-hassan' });
    expect(tl.harvest).not.toBeNull();
    expect(c.ctx.scenario.kind).toBe('occupied');
    expect(c.ctx.fixedSlot!.harvest).toEqual(tl.harvest);
    expect(c.ctx.fixedSlot!.occupancy.to).toBe(addDays(tl.harvest!.latest, ASSUMPTIONS.timelineHarvestBufferDays.value + ASSUMPTIONS.landPrepGapDays.value));
    expect(c.ctx.fixedSlot!.timelineEstimate).toBe(true);
    // A stage timeline without a harvest window gives back the older rule.
    const none = await yearPlanContext({ ...deps(), timeline: (i) => ({ ...stageTimeline(i), stages: [], harvest: null }) }, auth.ownerId, f.id, '2026-11-01');
    expect(none.ctx.fixedSlot!.timelineEstimate).toBe(false);
    expect(none.ctx.fixedSlot!.occupancy.to > c.ctx.fixedSlot!.occupancy.to).toBe(true);
  });

  it('a stored plan carries a label other than Best overall or Alternative only with price and yield on every suggested crop', async () => {
    data.invalidate();
    const { f, auth } = await farm();
    const review = await generate(liveDeps(fakeMeta('valid').provider), auth, f.id);
    expect(review.options.length).toBeGreaterThan(0);
    for (const o of review.options) {
      if (o.label === 'Best overall' || o.label === 'Alternative') continue;
      for (const s of o.slots.filter((x) => !x.fixed)) {
        expect(s.price?.status, `${o.label} / ${s.cropId} price`).toBe('available');
        expect(s.yieldKgPerHa, `${o.label} / ${s.cropId} yield`).not.toBeNull();
      }
    }
  });
});
