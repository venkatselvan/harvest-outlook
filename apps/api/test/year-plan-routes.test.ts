import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyYearPlanResult, YearPlanOption, YearPlanReview } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { patchFarm } from '../src/services/farms';
import { generateYearPlan, type YearPlanDeps } from '../src/services/year-plan/service';
import { farmBody, login, ORIGIN, setupHarness, type Client, type Harness } from './helpers';

/**
 * Year-plan routes through the registered app (synthetic mode: deterministic options, no network or model call), the
 * PUT /workspace hook and the demo refresh. The worker step is run in-process with generateYearPlan.
 */
let h: Harness, a: Client, b: Client;
beforeAll(async () => { h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); b = await login(h.app); });
afterAll(async () => h?.close());
const deps = (): YearPlanDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config) });
const hassan = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 };
async function farm(client = a) { return (await client.call('POST', '/api/v1/farms', { payload: farmBody({ location: hassan, facts: {} }) })).json().data as { id: string; ownerId?: string }; }
const ownerOf = async (farmId: string) => (await h.pool.query<{ owner_id: string }>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const jobs = async (farmId: string) => Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type='farm.year-plan' AND payload->>'farmId'=$1", [farmId])).rows[0].count);
async function ready(farmId: string): Promise<YearPlanReview> {
  const posted = YearPlanReview.parse((await a.call('POST', `/api/v1/farms/${farmId}/year-plan`, { payload: {} })).json().data);
  expect(posted.status).toBe('pending');
  await generateYearPlan(deps(), posted.reviewId!, await ownerOf(farmId));
  return YearPlanReview.parse((await a.call('GET', `/api/v1/farms/${farmId}/year-plan`)).json().data);
}
const slotsOf = (o: YearPlanOption) => o.slots.filter((s) => !s.fixed).map((s) => ({ slotId: s.slotId, cropId: s.cropId, productId: s.productId, sowing: s.sowing, harvestLatest: s.harvest.latest, ...(s.establishmentMethod ? { establishmentMethod: s.establishmentMethod } : {}) }));

describe('year-plan routes (registered)', () => {
  it('401 without a session, 404 for another owner, blank 200 before generation', async () => {
    const f = await farm();
    for (const [method, url] of [['GET', ''], ['POST', ''], ['POST', '/rescore'], ['POST', '/apply']] as const)
      expect((await h.app.inject({ method, url: `/api/v1/farms/${f.id}/year-plan${url}`, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect((await b.call('GET', `/api/v1/farms/${f.id}/year-plan`)).statusCode).toBe(404);
    expect((await b.call('POST', `/api/v1/farms/${f.id}/year-plan`, { payload: {} })).statusCode).toBe(404);
    const blank = YearPlanReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/year-plan`)).json().data);
    expect(blank).toMatchObject({ reviewId: null, status: 'unavailable', options: [] });
    expect(await jobs(f.id)).toBe(0);
  });

  it('POST accepts {} and {"force":true} and rejects any other body', async () => {
    const f = await farm();
    const url = `/api/v1/farms/${f.id}/year-plan`;
    const plain = YearPlanReview.parse((await a.call('POST', url, { payload: {} })).json().data);
    const forced = await a.call('POST', url, { payload: { force: true } });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(YearPlanReview.parse(forced.json().data).reviewId).toBe(plain.reviewId); // the first plan is still being built
    expect((await a.call('POST', url, { payload: { force: 'yes' } })).statusCode).toBe(400);
    expect((await a.call('POST', url, { payload: { force: true, extra: 1 } })).statusCode).toBe(400);
  });

  it('POST pending -> worker -> three options; rescore ":edit"; apply ":edit" idempotent; foreign 404; stale 409', async () => {
    const f = await farm();
    const review = await ready(f.id);
    expect(review.status).toBe('partial');
    expect(review.options).toHaveLength(3);
    expect(await jobs(f.id)).toBe(1);
    const option = review.options[0]!;
    const body = { reviewId: review.reviewId!, optionId: option.optionId, slots: slotsOf(option) };
    expect((await b.call('POST', `/api/v1/farms/${f.id}/year-plan/rescore`, { payload: body })).statusCode).toBe(404);
    const res = await a.call('POST', `/api/v1/farms/${f.id}/year-plan/rescore`, { payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const edited = YearPlanOption.parse(res.json().data);
    expect(edited).toMatchObject({ optionId: `${option.optionId}:edit`, origin: 'farmer_edit' });
    const ws = (await a.call('GET', `/api/v1/farms/${f.id}/workspace`)).json().data;
    const apply = { reviewId: review.reviewId!, optionId: edited.optionId, expectedWorkspaceVersion: ws.version };
    expect((await b.call('POST', `/api/v1/farms/${f.id}/year-plan/apply`, { payload: apply })).statusCode).toBe(404);
    const first = await a.call('POST', `/api/v1/farms/${f.id}/year-plan/apply`, { payload: apply });
    expect(first.statusCode, first.body).toBe(200);
    const applied = ApplyYearPlanResult.parse(first.json().data);
    expect(applied.workspace.rotationPlans.filter((p) => p.id.startsWith(`yearplan:${review.reviewId}:${edited.optionId}:`))).toHaveLength(edited.slots.filter((s) => !s.fixed).length);
    expect(applied.review.appliedOptionIds).toContain(edited.optionId);
    const again = ApplyYearPlanResult.parse((await a.call('POST', `/api/v1/farms/${f.id}/year-plan/apply`, { payload: apply })).json().data);
    expect(again.workspace.version).toBe(applied.workspace.version);
    await patchFarm(h.pool, await ownerOf(f.id), f.id, { facts: { irrigation_category: { value: 'irrigated', basis: 'farmer_reported', confirmed: true } } });
    const other = review.options[1]!;
    const stale = await a.call('POST', `/api/v1/farms/${f.id}/year-plan/rescore`, { payload: { reviewId: review.reviewId!, optionId: other.optionId, slots: slotsOf(other) } });
    expect(stale.statusCode).toBe(409);
    // The HTTP envelope reports 409 with error.code 'bad_request' (the service raises review_stale); the web keys on the status.
    expect(YearPlanReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/year-plan`)).json().data).stale).toBe(true);
  });

  it('PUT /workspace enqueues exactly one farm.year-plan job for known history and none for unknown history', async () => {
    const f = await farm();
    const put = (previousHarvest: unknown, expectedVersion: number) => a.call('PUT', `/api/v1/farms/${f.id}/workspace`, { payload: { expectedVersion, boundary: null, previousHarvest, cycles: [], rotationPlans: [] } });
    expect((await put({ status: 'unknown' }, 0)).statusCode).toBe(200);
    expect(await jobs(f.id)).toBe(0);
    expect((await put({ status: 'none' }, 1)).statusCode).toBe(200);
    expect(await jobs(f.id)).toBe(1);
    expect(Number((await h.pool.query('SELECT count(*) FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL', [f.id])).rows[0].count)).toBe(1);
    expect(Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type<>'farm.year-plan' AND payload->>'farmId'=$1", [f.id])).rows[0].count)).toBe(0);
  });

  it('demo refresh that removes legacy seed records archives the farm year plans', async () => {
    const demo = (await a.call('POST', '/api/v1/farms/demo', { payload: {} })).json().data;
    const id = demo.farm.id as string;
    expect((await a.call('POST', `/api/v1/farms/${id}/year-plan`, { payload: {} })).statusCode).toBe(200);
    await h.pool.query("UPDATE farm_facts SET value='3'::jsonb WHERE farm_id=$1 AND fact_key='demo_seed_version' AND superseded_by IS NULL", [id]);
    const legacy = { boundary: demo.workspace.boundary, previousHarvest: { status: 'known', cropId: 'maize', cropName: 'Maize (illustrative previous crop)', harvestDate: '2026-04-20' }, cycles: [], rotationPlans: [] };
    await h.pool.query('UPDATE farm_workspaces SET version=version+1,state=$2::jsonb WHERE farm_id=$1', [id, JSON.stringify(legacy)]);
    expect((await a.call('POST', '/api/v1/farms/demo', { payload: {} })).statusCode).toBe(200);
    const rows = (await h.pool.query('SELECT archived_at FROM farm_year_plans WHERE farm_id=$1', [id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.archived_at !== null)).toBe(true);
    const job = (await h.pool.query("SELECT cancel_requested FROM jobs WHERE type='farm.year-plan' AND payload->>'farmId'=$1", [id])).rows;
    expect(job.every((r) => r.cancel_requested === true)).toBe(true);
  });
});
