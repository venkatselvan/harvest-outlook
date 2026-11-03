import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyYearPlanResult, YearPlanOption, YearPlanReview, type FarmWorkspace } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { automaticPlanTarget } from '../src/routes/farms';
import { addDays } from '../src/services/year-plan/dates';
import { generateYearPlan, todayIst, yearPlanContext, type YearPlanDeps } from '../src/services/year-plan/service';
import { boundaryMetrics } from '../src/services/workspace';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Year plan per field (FIELDS_MULTICROP_SOIL_SPEC.md 12.2) through the registered app in synthetic mode (deterministic
 * options, no network, no model call). Farms, fields, cycles and saved seasons are SYNTHETIC; every date is relative to
 * today's IST date because the registered routes use the real clock.
 */
let h: Harness, a: Client, b: Client;
beforeAll(async () => { h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); b = await login(h.app); }, 120_000);
afterAll(async () => h?.close());

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][] });
const FARM = rect(76.249, 13.2495, 76.251, 13.2505);
const WEST = rect(76.249, 13.2495, 76.2498, 13.2505);
const EAST = rect(76.2498, 13.2495, 76.251, 13.2505);
const FIELDS = [{ id: 'west', name: 'West strip', boundary: WEST }, { id: 'east', name: 'East strip', boundary: EAST }];
const HASSAN = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.25, lon: 76.25 };
const today = () => todayIst(new Date());
const ago = (n: number) => addDays(today(), -n);
const cycle = (id: string, cropId: string, productId: string, sownDaysAgo: number, fieldId?: string) => ({ id, cropId, productId, sowingDate: ago(sownDaysAgo), establishmentDate: ago(sownDaysAgo), stage: 'growing', ...(fieldId ? { fieldId } : {}) });
const deps = (): YearPlanDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config) });
const ownerOf = async (farmId: string) => (await h.pool.query<{ owner_id: string }>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const jobs = async (farmId: string) => Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type='farm.year-plan' AND payload->>'farmId'=$1", [farmId])).rows[0].count);
const url = (id: string, tail = '', fieldId?: string) => `/api/v1/farms/${id}/year-plan${tail}${fieldId ? `?fieldId=${fieldId}` : ''}`;

/** A farm with fields and the given cycles and saved seasons (history unknown: no automatic plan is started by the save). */
async function farmWith(cycles: unknown[], rotationPlans: unknown[] = [], fields: unknown[] = FIELDS) {
  const id = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: 'Strips', location: HASSAN, facts: {} }) })).json().data.id as string;
  const put = await a.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { expectedVersion: 0, boundary: FARM, fields, previousHarvest: { status: 'unknown' }, cycles, rotationPlans } });
  expect(put.statusCode, put.body).toBe(200);
  return id;
}
const read = async (id: string, fieldId: string) => YearPlanReview.parse((await a.call('GET', url(id, '', fieldId))).json().data);
async function build(id: string, fieldId: string): Promise<YearPlanReview> {
  const posted = await a.call('POST', url(id, '', fieldId), { payload: {} });
  expect(posted.statusCode, posted.body).toBe(200);
  const review = YearPlanReview.parse(posted.json().data);
  expect(review.status).toBe('pending');
  await generateYearPlan(deps(), review.reviewId!, await ownerOf(id));
  return read(id, fieldId);
}
const slotsOf = (o: YearPlanOption) => o.slots.filter((s) => !s.fixed).map((s) => ({ slotId: s.slotId, cropId: s.cropId, productId: s.productId, sowing: s.sowing, harvestLatest: s.harvest.latest, ...(s.establishmentMethod ? { establishmentMethod: s.establishmentMethod } : {}) }));
const wsOf = async (id: string) => (await a.call('GET', `/api/v1/farms/${id}/workspace`)).json().data as FarmWorkspace;

describe('context and review per field', () => {
  it('two fields give different context hashes, areas and fixed crops; a farm with fields needs the field', async () => {
    const id = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west'), cycle('c-east', 'maize', 'maize-grain', 25, 'east')]);
    const owner = await ownerOf(id);
    const asOf = today();
    const west = await yearPlanContext(deps(), owner, id, asOf, null, { fieldId: 'west' });
    const east = await yearPlanContext(deps(), owner, id, asOf, null, { fieldId: 'east' });
    expect(west.hash).not.toBe(east.hash);
    expect(west.chainHash).not.toBe(east.chainHash);
    expect([west.fieldId, east.fieldId]).toEqual(['west', 'east']);
    expect(west.fieldAreaHa).toBeCloseTo(boundaryMetrics(WEST).areaHectares, 9);
    expect(east.fieldAreaHa).toBeCloseTo(boundaryMetrics(EAST).areaHectares, 9);
    expect(west.fieldAreaHa).not.toBe(east.fieldAreaHa);
    expect([west.ctx.scenario.currentCycleId, east.ctx.scenario.currentCycleId]).toEqual(['c-west', 'c-east']);
    expect([west.ctx.fixedSlot?.cycleId, east.ctx.fixedSlot?.cycleId]).toEqual(['c-west', 'c-east']);
    // The same field twice is the same hash (the hash is not time-of-call dependent).
    expect((await yearPlanContext(deps(), owner, id, asOf, null, { fieldId: 'west' })).hash).toBe(west.hash);
    await expect(yearPlanContext(deps(), owner, id, asOf, null)).rejects.toMatchObject({ statusCode: 400, code: 'field_required' });
    await expect(yearPlanContext(deps(), owner, id, asOf, null, { fieldId: 'north' })).rejects.toMatchObject({ statusCode: 404, code: 'field_not_found' });
  });

  it('each field has its own current review and horizon chain; the growing crop is that field\'s fixed slot and is never added', async () => {
    const id = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west'), cycle('c-east', 'maize', 'maize-grain', 25, 'east')]);
    const west = await build(id, 'west');
    const east = await build(id, 'east');
    expect(west.reviewId).not.toBe(east.reviewId);
    expect(west.contextHash).not.toBe(east.contextHash);
    expect([west.fieldId, east.fieldId]).toEqual(['west', 'east']);
    expect(west.fieldAreaHa).toBeCloseTo(boundaryMetrics(WEST).areaHectares, 9);
    expect(east.fieldAreaHa).toBeCloseTo(boundaryMetrics(EAST).areaHectares, 9);
    expect([west.status, east.status]).toEqual(['partial', 'partial']);
    expect([west.scenario.currentCycleId, east.scenario.currentCycleId]).toEqual(['c-west', 'c-east']);
    for (const [review, cropId] of [[west, 'paddy'], [east, 'maize']] as const) {
      expect(review.options.length).toBeGreaterThan(0);
      for (const o of review.options) expect(o.slots.filter((s) => s.fixed).map((s) => s.cropId)).toEqual([cropId]);
    }
    // Two live rows, one per field; a re-read returns the same row, not the other field's.
    const rows = (await h.pool.query<{ field: string | null; n: string }>("SELECT input_context->>'fieldId' AS field, count(*) AS n FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL GROUP BY 1 ORDER BY 1", [id])).rows;
    expect(rows).toEqual([{ field: 'east', n: '1' }, { field: 'west', n: '1' }]);
    expect((await read(id, 'west')).reviewId).toBe(west.reviewId);
    expect((await read(id, 'east')).reviewId).toBe(east.reviewId);
    expect(await jobs(id)).toBe(2);
    // The growing crop of a field cannot be added by naming its fixed slot.
    const fixed = west.options[0]!.slots.find((s) => s.fixed)!;
    const bad = await a.call('POST', url(id, '/apply'), { payload: { reviewId: west.reviewId!, optionId: west.options[0]!.optionId, fieldId: 'west', slotIds: [fixed.slotId], expectedWorkspaceVersion: (await wsOf(id)).version } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.body).toMatch(/growing crop cannot be added/);
    // A field with no crop is a fresh plan of its own.
    const fresh = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west')]);
    const freshEast = await build(fresh, 'east');
    expect(freshEast.scenario.currentCycleId).toBeNull();
    expect(freshEast.scenario.kind).toBe('fresh');
  });

  it('field_required (400) and field_not_found (404) on GET, POST, rescore and apply; a review of another field is not found', async () => {
    const id = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west')]);
    const west = await build(id, 'west');
    const option = west.options[0]!;
    const rescoreBody = { reviewId: west.reviewId!, optionId: option.optionId, slots: slotsOf(option) };
    const applyBody = { reviewId: west.reviewId!, optionId: option.optionId, expectedWorkspaceVersion: (await wsOf(id)).version };
    const call = (method: 'GET' | 'POST', tail: string, fieldId: string | undefined, payload?: Record<string, unknown>) =>
      a.call(method, url(id, tail, tail ? undefined : fieldId), method === 'POST' ? { payload: { ...payload, ...(fieldId && tail ? { fieldId } : {}) } } : {});
    const matrix: [string, 'GET' | 'POST', string, Record<string, unknown> | undefined][] = [['GET', 'GET', '', undefined], ['POST', 'POST', '', {}], ['rescore', 'POST', '/rescore', rescoreBody], ['apply', 'POST', '/apply', applyBody]];
    for (const [name, method, tail, payload] of matrix) {
      const missing = await call(method, tail, undefined, payload);
      expect(missing.statusCode, `${name} without fieldId: ${missing.body}`).toBe(400);
      expect(missing.json().error.code, name).toBe('field_required');
      const unknown = await call(method, tail, 'north', payload);
      expect(unknown.statusCode, `${name} unknown field: ${unknown.body}`).toBe(404);
      expect(unknown.json().error.code, name).toBe('field_not_found');
    }
    expect(await jobs(id)).toBe(1); // none of the refused calls started a build
    // Another field's id finds no such review: the review belongs to west.
    for (const [tail, payload] of [['/rescore', rescoreBody], ['/apply', applyBody]] as const) {
      const wrong = await a.call('POST', url(id, tail), { payload: { ...payload, fieldId: 'east' } });
      expect(wrong.statusCode, `${tail}: ${wrong.body}`).toBe(404);
    }
    // Owner isolation holds with a field id.
    expect((await b.call('GET', url(id, '', 'west'))).statusCode).toBe(404);
    // A farm without fields rejects any field id and still needs none.
    const plain = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ location: HASSAN, facts: {} }) })).json().data.id as string;
    expect((await a.call('GET', url(plain))).statusCode).toBe(200);
    expect((await a.call('GET', url(plain, '', 'west'))).statusCode).toBe(404);
  });
});

describe('apply per field', () => {
  it('writes fieldId on the new seasons, keeps the other field\'s seasons, and leaves the other field\'s review current', async () => {
    const eastSeason = { id: 'rot-east', year: 2027, season: 'Kharif', cropId: 'ragi', cropName: 'Finger millet', plannedSowingDate: addDays(today(), 150), plannedHarvestDate: addDays(today(), 260), fieldId: 'east' };
    const id = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west'), cycle('c-east', 'maize', 'maize-grain', 25, 'east')], [eastSeason]);
    const west = await build(id, 'west');
    const east = await build(id, 'east');
    expect(east.stale).toBe(false);
    const option = west.options[0]!;
    const rescored = await a.call('POST', url(id, '/rescore'), { payload: { reviewId: west.reviewId!, optionId: option.optionId, fieldId: 'west', slots: slotsOf(option) } });
    expect(rescored.statusCode, rescored.body).toBe(200);
    const edited = YearPlanOption.parse(rescored.json().data);
    expect(edited.optionId).toBe(`${option.optionId}:edit`);
    const before = await wsOf(id);
    const res = await a.call('POST', url(id, '/apply'), { payload: { reviewId: west.reviewId!, optionId: edited.optionId, fieldId: 'west', expectedWorkspaceVersion: before.version } });
    expect(res.statusCode, res.body).toBe(200);
    const applied = ApplyYearPlanResult.parse(res.json().data);
    const added = applied.workspace.rotationPlans.filter((p) => p.id.startsWith(`yearplan:${west.reviewId}:${edited.optionId}:`));
    expect(added).toHaveLength(edited.slots.filter((s) => !s.fixed).length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p.fieldId === 'west')).toBe(true);
    // The fixed slot (west's growing paddy) is not a saved season.
    expect(added.some((p) => p.cropId === 'paddy' && p.plannedSowingDate === ago(40))).toBe(false);
    // The other field's season and the stored fields and cycles are intact.
    expect(applied.workspace.rotationPlans.find((p) => p.id === 'rot-east')).toMatchObject({ fieldId: 'east', cropId: 'ragi' });
    expect(applied.workspace.rotationPlans).toHaveLength(before.rotationPlans.length + added.length);
    expect(applied.workspace.fields.map((f) => f.id)).toEqual(['west', 'east']);
    expect(applied.workspace.cycles.map((c) => c.id)).toEqual(['c-west', 'c-east']);
    expect(applied.review.fieldId).toBe('west');
    expect(applied.review.appliedOptionIds).toContain(edited.optionId);
    // The same apply again is a no-op for the same field.
    const again = ApplyYearPlanResult.parse((await a.call('POST', url(id, '/apply'), { payload: { reviewId: west.reviewId!, optionId: edited.optionId, fieldId: 'west', expectedWorkspaceVersion: before.version } })).json().data);
    expect(again.workspace.version).toBe(applied.workspace.version);
    // Seasons saved on west do not change east's context: east's review is still current and still its own row.
    const eastAfter = await read(id, 'east');
    expect(eastAfter.reviewId).toBe(east.reviewId);
    expect(eastAfter.stale).toBe(false);
    expect(eastAfter.contextHash).toBe(east.contextHash);
    expect((await read(id, 'west')).stale).toBe(false);
  });

  it('applying with the other field named is not found and writes nothing', async () => {
    const id = await farmWith([cycle('c-west', 'paddy', 'paddy-grain', 40, 'west')]);
    const west = await build(id, 'west');
    const version = (await wsOf(id)).version;
    const res = await a.call('POST', url(id, '/apply'), { payload: { reviewId: west.reviewId!, optionId: west.options[0]!.optionId, fieldId: 'east', expectedWorkspaceVersion: version } });
    expect(res.statusCode).toBe(404);
    expect((await wsOf(id)).version).toBe(version);
  });
});

describe('a cycle recorded for the whole farm before fields were drawn', () => {
  it('is counted on a field as an occupant with the "recorded for the whole farm" note when it is not the current crop, and as its fixed crop where the field has none', async () => {
    // The farm-wide maize (older) and west's own paddy (newer, so the current crop of west). East has no crop of its own.
    const id = await farmWith([cycle('c-legacy', 'maize', 'maize-grain', 70), cycle('c-west', 'paddy', 'paddy-grain', 20, 'west')]);
    const west = await build(id, 'west');
    expect(west.scenario.currentCycleId).toBe('c-west');
    const occupant = west.scenario.occupied?.find((o) => o.id === 'c-legacy');
    expect(occupant).toMatchObject({ source: 'recorded_cycle', cropId: 'maize' });
    expect(occupant!.note).toMatch(/^Recorded for the whole farm before fields were drawn\./);
    // East: the legacy cycle is the only crop in its view, so it is east's growing crop and the review says so.
    const east = await read(id, 'east');
    expect(east.scenario.currentCycleId).toBe('c-legacy');
    expect(east.limitations.some((l) => l.includes('was recorded for the whole farm before fields were drawn'))).toBe(true);
    const eastBuilt = await build(id, 'east');
    expect(eastBuilt.limitations.some((l) => l.includes('recorded for the whole farm before fields were drawn'))).toBe(true);
    // A harvested legacy cycle is not counted.
    const harvested = await farmWith([{ ...cycle('c-legacy', 'maize', 'maize-grain', 70), stage: 'harvested', harvestDate: ago(10) }]);
    const clean = await read(harvested, 'west');
    expect(clean.scenario.currentCycleId).toBeNull();
    expect(clean.limitations.some((l) => l.includes('recorded for the whole farm'))).toBe(false);
  });
});

describe('automatic year plan after a workspace save (routes/farms.ts)', () => {
  const save = (id: string, version: number, body: Record<string, unknown>) =>
    a.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { expectedVersion: version, boundary: FARM, fields: FIELDS, previousHarvest: { status: 'none' }, cycles: [], rotationPlans: [], ...body } });
  const rowsOf = async (id: string) => (await h.pool.query<{ field: string | null }>("SELECT input_context->>'fieldId' AS field FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL ORDER BY created_at", [id])).rows.map((r) => r.field);
  const newFarm = async () => (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: 'Auto', location: HASSAN, facts: {} }) })).json().data.id as string;

  it('automaticPlanTarget: the first field with its own current cycle in stored order; skip with a code when none; the farm-wide start without fields', () => {
    const ws = (fields: string[], cycles: { fieldId?: string; stage?: string }[]) => ({ fields: fields.map((f) => ({ id: f, name: f, boundary: WEST })), cycles: cycles.map((c, i) => ({ id: `c${i}`, cropId: 'maize', sowingDate: '2026-09-01', stage: 'growing', ...c })) }) as unknown as Pick<FarmWorkspace, 'fields' | 'cycles'>;
    expect(automaticPlanTarget(ws([], []))).toEqual({ kind: 'plan' });
    expect(automaticPlanTarget(ws([], [{}]))).toEqual({ kind: 'plan' });
    expect(automaticPlanTarget(ws(['west', 'east'], [{ fieldId: 'east' }, { fieldId: 'west', stage: 'harvested' }]))).toEqual({ kind: 'plan', fieldId: 'east' });
    expect(automaticPlanTarget(ws(['west', 'east'], [{ fieldId: 'east' }, { fieldId: 'west' }]))).toEqual({ kind: 'plan', fieldId: 'west' }); // stored order, not the latest cycle
    expect(automaticPlanTarget(ws(['west', 'east'], [{}, { fieldId: 'west', stage: 'harvested' }]))).toMatchObject({ kind: 'skip', code: 'year_plan_skipped_no_field_crop' }); // a farm-wide cycle belongs to no field here
    expect(automaticPlanTarget(ws(['west', 'east'], []))).toMatchObject({ kind: 'skip', note: expect.stringMatching(/no field has a current crop/) });
  });

  it('a save on a farm with fields starts the plan of the first field with a current cycle (one job; the same save again adds none); a save with no field crop starts nothing and still succeeds', async () => {
    const id = await newFarm();
    const none = await save(id, 0, {});
    expect(none.statusCode, none.body).toBe(200);
    expect(await jobs(id)).toBe(0);
    expect(await rowsOf(id)).toEqual([]);
    const planted = await save(id, 1, { cycles: [cycle('c-east', 'maize', 'maize-grain', 25, 'east')] });
    expect(planted.statusCode, planted.body).toBe(200);
    expect(await rowsOf(id)).toEqual(['east']);
    expect(await jobs(id)).toBe(1);
    // A second crop on the earlier field: the first field in stored order with a cycle (west) is planned too.
    const both = await save(id, 2, { cycles: [cycle('c-east', 'maize', 'maize-grain', 25, 'east'), cycle('c-west', 'paddy', 'paddy-grain', 10, 'west')] });
    expect(both.statusCode, both.body).toBe(200);
    expect((await rowsOf(id)).sort()).toEqual(['east', 'west']);
    expect(await jobs(id)).toBe(2);
    // The same save again (same context hash for west): no new job, no new row.
    expect((await save(id, 3, { cycles: [cycle('c-east', 'maize', 'maize-grain', 25, 'east'), cycle('c-west', 'paddy', 'paddy-grain', 10, 'west')] })).statusCode).toBe(200);
    expect(await jobs(id)).toBe(2);
    expect((await rowsOf(id)).length).toBe(2);
    // Unknown history is still never planned automatically.
    const unknown = await newFarm();
    expect((await save(unknown, 0, { previousHarvest: { status: 'unknown' }, cycles: [cycle('c-west', 'paddy', 'paddy-grain', 10, 'west')] })).statusCode).toBe(200);
    expect(await jobs(unknown)).toBe(0);
  });

  it('a farm without fields keeps today\'s farm-wide start', async () => {
    const id = await newFarm();
    expect((await save(id, 0, { fields: [] })).statusCode).toBe(200);
    expect(await jobs(id)).toBe(1);
    expect(await rowsOf(id)).toEqual([null]);
  });
});
