import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FarmWorkspace } from '@harvest/contracts';
import { boundaryMetrics, fieldAreaHa, fieldView, legacyCycles, requireField } from '../src/services/workspace';
import { FixtureProvider } from '../src/agent/fixture-provider';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Field scope (FIELDS_MULTICROP_SOIL_SPEC.md 12.1 and 12.5): the field-scoped workspace view, the field area, requireField,
 * and the assistant turn's fieldId validation. Farms, fields and cycles here are SYNTHETIC test data; no network, no model.
 */
const rect = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][] });
const FARM = rect(76.249, 13.2495, 76.251, 13.2505);
const WEST = rect(76.249, 13.2495, 76.2498, 13.2505); // 0.0008 deg wide: a different, smaller area than EAST
const EAST = rect(76.2498, 13.2495, 76.251, 13.2505);
const FIELDS = [{ id: 'west', name: 'West strip', boundary: WEST }, { id: 'east', name: 'East strip', boundary: EAST }];
const cycle = (id: string, over: Record<string, unknown> = {}) => ({ id, cropId: 'maize', sowingDate: '2026-09-01', stage: 'growing', ...over });
const plan = (id: string, over: Record<string, unknown> = {}) => ({ id, year: 2027, season: 'Kharif', cropId: 'ragi', ...over });
const workspace = (over: Partial<FarmWorkspace> = {}): FarmWorkspace => ({
  farmId: '00000000-0000-4000-8000-000000000001', version: 3, updatedAt: null, boundary: FARM, previousHarvest: { status: 'unknown' }, fields: FIELDS,
  cycles: [cycle('c-west', { fieldId: 'west' }), cycle('c-east', { fieldId: 'east' }), cycle('c-legacy', { cropId: 'paddy' }), cycle('c-done', { cropId: 'sorghum', stage: 'harvested', harvestDate: '2026-04-01' })] as FarmWorkspace['cycles'],
  rotationPlans: [plan('p-west', { fieldId: 'west' }), plan('p-east', { fieldId: 'east' }), plan('p-legacy')] as FarmWorkspace['rotationPlans'], ...over,
});
const errOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { statusCode: number; code: string }; } throw new Error('expected a throw'); };

describe('fieldView (12.1)', () => {
  it('keeps the field\'s own records plus a legacy farm-wide cycle and season, swaps in the field polygon, keeps fields and the rest, and does not mutate', () => {
    const ws = workspace();
    const before = JSON.stringify(ws);
    const west = fieldView(ws, 'west');
    expect(west.cycles.map((c) => c.id)).toEqual(['c-west', 'c-legacy', 'c-done']); // c-done has no fieldId: the harvested record stays, legacyCycles filters it
    expect(west.rotationPlans.map((p) => p.id)).toEqual(['p-west', 'p-legacy']);
    expect(west.boundary).toEqual(WEST);
    expect(west.fields).toBe(ws.fields);
    expect(west).toMatchObject({ farmId: ws.farmId, version: 3, previousHarvest: { status: 'unknown' } });
    const east = fieldView(ws, 'east');
    expect(east.cycles.map((c) => c.id)).toEqual(['c-east', 'c-legacy', 'c-done']);
    expect(east.boundary).toEqual(EAST);
    expect(east.rotationPlans.map((p) => p.id)).toEqual(['p-east', 'p-legacy']);
    expect(JSON.stringify(ws)).toBe(before);
  });

  it('without a field id (undefined or null) the workspace is returned unchanged, also on a farm with fields', () => {
    const ws = workspace();
    expect(fieldView(ws)).toBe(ws);
    expect(fieldView(ws, null)).toBe(ws);
    const plain = workspace({ fields: [] });
    expect(fieldView(plain, undefined)).toBe(plain);
  });

  it('an unknown field is 404 field_not_found, including any field id on a farm without fields', () => {
    expect(errOf(() => fieldView(workspace(), 'north'))).toMatchObject({ statusCode: 404, code: 'field_not_found' });
    expect(errOf(() => fieldView(workspace({ fields: [] }), 'west'))).toMatchObject({ statusCode: 404, code: 'field_not_found' });
    expect(errOf(() => fieldAreaHa(workspace(), 'north'))).toMatchObject({ statusCode: 404, code: 'field_not_found' });
  });
});

describe('fieldAreaHa, requireField, legacyCycles', () => {
  it('the area is the spherical area of that field\'s polygon (not the farm\'s, not half of it)', () => {
    const ws = workspace();
    const west = fieldAreaHa(ws, 'west'), east = fieldAreaHa(ws, 'east'), farm = boundaryMetrics(FARM).areaHectares;
    expect(west).toBeCloseTo(boundaryMetrics(WEST).areaHectares, 9);
    expect(east).toBeCloseTo(boundaryMetrics(EAST).areaHectares, 9);
    expect(west).toBeGreaterThan(0);
    expect(east).toBeGreaterThan(west);
    expect(west + east).toBeCloseTo(farm, 2); // the strips tile the farm rectangle
  });

  it('requireField: null on a farm without fields when none is named; 400 field_required on a farm with fields; 404 for an unknown one', () => {
    expect(requireField(workspace({ fields: [] }), undefined)).toBeNull();
    expect(requireField(workspace({ fields: [] }), null)).toBeNull();
    expect(errOf(() => requireField(workspace(), undefined))).toMatchObject({ statusCode: 400, code: 'field_required' });
    expect(errOf(() => requireField(workspace(), null))).toMatchObject({ statusCode: 400, code: 'field_required' });
    expect(errOf(() => requireField(workspace(), 'north'))).toMatchObject({ statusCode: 404, code: 'field_not_found' });
    expect(errOf(() => requireField(workspace({ fields: [] }), 'west'))).toMatchObject({ statusCode: 404, code: 'field_not_found' });
    expect(requireField(workspace(), 'east')?.name).toBe('East strip');
  });

  it('legacyCycles lists only unharvested cycles without a fieldId of a field view', () => {
    expect(legacyCycles(fieldView(workspace(), 'west')).map((c) => c.id)).toEqual(['c-legacy']);
    expect(legacyCycles(workspace({ cycles: [cycle('c-west', { fieldId: 'west' })] as FarmWorkspace['cycles'] }))).toEqual([]);
  });
});

describe('assistant turn fieldId (12.5)', () => {
  let h: Harness, client: Client, created: number, app: Awaited<ReturnType<Harness['make']>>;
  const HASSAN = { districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate' };
  const farmWith = async (fields: unknown[]) => {
    const id = (await client.call('POST', '/api/v1/farms', { payload: farmBody({ name: 'Strips', location: HASSAN, facts: {} }) })).json().data.id as string;
    const put = await client.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { expectedVersion: 0, boundary: FARM, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [], fields } });
    expect(put.statusCode, put.body).toBe(200);
    return id;
  };
  const turn = (extra: Record<string, unknown>) => client.call('POST', '/api/v1/assistant/turns', { payload: { text: 'How is my field?', language: 'en', ...extra } });
  const runs = async () => Number((await h.pool.query('SELECT count(*) FROM agent_runs')).rows[0].count);
  beforeAll(async () => {
    h = await setupHarness();
    created = 0;
    app = await h.make({}, { assistant: { providerFactory: () => (created++, new FixtureProvider('profile_extraction')) } });
    client = await login(app);
  }, 60_000);
  afterAll(async () => h?.close());

  it('400 without farmId; 404 field_not_found for an unknown field (also on a farm without fields); a malformed id is 400; none of them reaches the provider or writes a run', async () => {
    const withFields = await farmWith(FIELDS), without = await farmWith([]);
    const before = await runs();
    const noFarm = await turn({ fieldId: 'west' });
    expect(noFarm.statusCode, noFarm.body).toBe(400);
    expect(noFarm.body).toMatch(/fieldId needs farmId/);
    const unknown = await turn({ farmId: withFields, fieldId: 'north' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('field_not_found');
    const none = await turn({ farmId: without, fieldId: 'west' });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('field_not_found');
    expect((await turn({ farmId: withFields, fieldId: 'a b' })).statusCode).toBe(400);
    expect((await turn({ farmId: withFields, fieldId: '' })).statusCode).toBe(400);
    expect(created).toBe(0);
    expect(await runs()).toBe(before);
  });

  it('another owner\'s farm with a field id is the same not_found as any foreign farm', async () => {
    const mine = await farmWith(FIELDS);
    const stranger = await login(app);
    const res = await stranger.call('POST', '/api/v1/assistant/turns', { payload: { text: 'hi', language: 'en', farmId: mine, fieldId: 'west' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(created).toBe(0);
  });

  it('a field of the farm is accepted and the turn runs', async () => {
    const id = await farmWith(FIELDS);
    const res = await turn({ farmId: id, fieldId: 'east' });
    expect(res.statusCode, res.body).toBe(200);
    expect(created).toBe(1);
  });
});
