import { clearSharedWeatherReads } from '../src/ingest/scope';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FarmProfile, ValueRecord } from '@harvest/contracts';
import { setupHarness, login, farmBody, type Harness, type Client } from './helpers';
import { createMonitorHandler } from '../src/worker/handlers/monitoring';
import { monitoringAt, monitoringSnapshot, monitoringReferences, workspaceMarketProducts } from '../src/services/monitoring';
import { enqueueDueMonitors, monitorChanges, monitorFingerprint, readMonitorSettings, saveMonitorSnapshot } from '../src/services/monitor-schedule';
import { getFarmContextHandler } from '../src/agent/tools/handlers';
import { unitAtPointer } from '../src/agent/tool-units';
import { Budget } from '../src/services/budget';
import { enqueue } from '../src/services/jobs';
import { structuredAlerts } from '../src/services/today/alerts';
import { ensureSource, OPENMETEO_SOURCES } from '../src/ingest/sources';

let h: Harness, owner: Client, stranger: Client;
const body = { expectedVersion: 0, boundary: { type: 'Polygon', coordinates: [[[76, 13], [76.01, 13], [76.01, 13.01], [76, 13.01], [76, 13]]] }, previousHarvest: { status: 'known', cropId: 'rice', harvestDate: '2026-04-02' }, cycles: [{ id: 'c1', cropId: 'ginger', sowingDate: '2026-05-01', stage: 'growing' }], rotationPlans: [{ id: 'r1', cropId: 'rice', year: 2027, season: 'Kharif' }] };
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); });
afterAll(async () => h?.close());
const create = async () => (await owner.call('POST', '/api/v1/farms', { payload: farmBody({ facts: {} }) })).json().data.id as string;
describe('workspace persistence and authorization', () => {
  it('starts unknown and persists farm-scoped boundary, history and cycles across app instances', async () => {
    const id = await create();
    expect((await owner.call('GET', `/api/v1/farms/${id}/workspace`)).json().data).toMatchObject({ version: 0, previousHarvest: { status: 'unknown' } });
    const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body });
    expect(put.statusCode).toBe(200);
    const { expectedVersion: _, ...expected } = body;
    expect(put.json().data).toMatchObject({ ...expected, version: 1 });
    const anotherApp = await h.make();
    const reloaded = await anotherApp.inject({ method: 'GET', url: `/api/v1/farms/${id}/workspace`, headers: { cookie: owner.cookie } });
    expect(reloaded.json().data.cycles[0].cropId).toBe('ginger');
    const updatedFarm=(await owner.call('GET',`/api/v1/farms/${id}`)).json().data;
    expect(updatedFarm.areaHectares).toBeGreaterThan(100);
    expect(updatedFarm.location.lat).toBeCloseTo(13.005,5);
    expect(updatedFarm.location.lon).toBeCloseTo(76.005,5);
    expect(updatedFarm.facts.area_hectares).toMatchObject({basis:'derived',unit:'ha'});
    expect(updatedFarm.version).toBe(2);
    const otherFarm = await create();
    expect((await owner.call('GET', `/api/v1/farms/${otherFarm}/workspace`)).json().data.cycles).toEqual([]);
  });
  it('hides foreign farms for reads, writes, monitoring and plan lists', async () => {
    const id = await create();
    for (const path of ['workspace', 'monitoring', 'plans']) expect((await stranger.call('GET', `/api/v1/farms/${id}/${path}`)).statusCode).toBe(404);
    expect((await stranger.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body })).statusCode).toBe(404);
    expect((await stranger.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: true } })).statusCode).toBe(404);
  });
  it('rejects lost updates, foreign plan links, invalid geometry and nonchronological cycles', async () => {
    const id = await create();
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body })).statusCode).toBe(200);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body })).statusCode).toBe(409);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { ...body, expectedVersion: 1, cycles: [{ ...body.cycles[0], latestPlanId: randomUUID() }] } })).statusCode).toBe(404);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { ...body, expectedVersion: 1, boundary: { type: 'Polygon', coordinates: [[[76, 13], [76.1, 13], [76, 13.1]]] } } })).statusCode).toBe(400);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { ...body, expectedVersion: 1, cycles: [{ ...body.cycles[0], stage: 'harvested', harvestDate: '2026-01-01' }] } })).statusCode).toBe(400);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { ...body, expectedVersion: 1, cycles: [{ ...body.cycles[0], sowingDate: '2099-01-01' }] } })).statusCode).toBe(400);
  });
  it('cascade-deletes workspace and monitoring with the existing farm deletion procedure', async () => {
    const id = await create();
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body });
    await owner.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: true } });
    expect((await owner.call('DELETE', `/api/v1/farms/${id}`)).statusCode).toBe(200);
    expect((await h.pool.query('SELECT 1 FROM farm_workspaces WHERE farm_id=$1', [id])).rowCount).toBe(0);
    expect((await h.pool.query('SELECT 1 FROM farm_monitors WHERE farm_id=$1', [id])).rowCount).toBe(0);
  });
  it('persists a chosen rotation product, rejects crop mismatches, and narrows monitor products',async()=>{
    const crop=(await h.pool.query("INSERT INTO crop_identities(slug) VALUES('qa-ginger') RETURNING id")).rows[0].id;
    const other=(await h.pool.query("INSERT INTO crop_identities(slug) VALUES('qa-rice') RETURNING id")).rows[0].id;
    const product=(await h.pool.query("INSERT INTO crop_products(crop_id,slug,name) VALUES($1,'qa-ginger-fresh','Fresh ginger') RETURNING id",[crop])).rows[0].id;
    await h.pool.query("INSERT INTO crop_products(crop_id,slug,name) VALUES($1,'qa-ginger-dry','Dry ginger'),($2,'qa-rice-paddy','Paddy')",[crop,other]);
    const id=await create();const endpoint=`/api/v1/farms/${id}/workspace`;
    const chosen={expectedVersion:0,boundary:null,previousHarvest:{status:'unknown'},cycles:[],rotationPlans:[{id:'product-choice',year:2027,season:'Kharif',cropId:'qa-ginger',productId:product,productName:'Untrusted label'}]};
    const saved=await owner.call('PUT',endpoint,{payload:chosen});expect(saved.statusCode).toBe(200);
    expect(saved.json().data.rotationPlans[0]).toMatchObject({productId:'qa-ginger-fresh',productName:'Fresh ginger'});
    expect(await workspaceMarketProducts(h.pool,saved.json().data)).toEqual(['qa-ginger-fresh']);
    expect((await stranger.call('PUT',endpoint,{payload:chosen})).statusCode).toBe(404);
    const invalid=await owner.call('PUT',endpoint,{payload:{...chosen,expectedVersion:1,rotationPlans:[{...chosen.rotationPlans[0],productId:'qa-rice-paddy'}]}});
    expect(invalid.statusCode).toBe(400);
    expect((await owner.call('GET',endpoint)).json().data.version).toBe(1);
  });
  it('uses the canonical irrigation category for Meta and retains legacy compatibility',async()=>{
    const id=(await owner.call('POST','/api/v1/farms',{payload:farmBody({facts:{irrigation:{value:'irrigated',basis:'farmer_reported',confirmed:true,source:'legacy'},irrigation_category:{value:'rainfed',basis:'farmer_reported',confirmed:true,source:'farmer form'}}})})).json().data.id;
    const ownerId=(await h.pool.query('SELECT owner_id FROM farms WHERE id=$1',[id])).rows[0].owner_id;
    const context={ownerId,pool:h.pool,mode:'synthetic' as const,requestId:randomUUID(),agentRunId:randomUUID(),asOf:new Date().toISOString()};
    expect((await getFarmContextHandler({farmId:id},context)).farm.water.category).toMatchObject({value:'rainfed',basis:'farmer_reported',source:{ref:'farmer form'}});
    await owner.call('PATCH',`/api/v1/farms/${id}`,{payload:{facts:{irrigation_category:{value:null,basis:'unknown',confirmed:false}}}});
    expect((await getFarmContextHandler({farmId:id},context)).farm.water.category).toMatchObject({value:null,basis:'unknown'});
    const legacyId=(await owner.call('POST','/api/v1/farms',{payload:farmBody({facts:{irrigation:{value:'irrigated',basis:'farmer_reported',confirmed:true,source:'legacy'}}})})).json().data.id;
    expect((await getFarmContextHandler({farmId:legacyId},context)).farm.water.category.value).toBe('irrigated');
  });
});

describe('honest recurring monitoring', () => {
  it('does not call live providers in synthetic mode and schedules once with concurrent scanners', async () => {
    const id = await create();
    const fetchImpl = vi.fn();
    const snapshot = await monitoringSnapshot({ config: h.config, pool: h.pool, fetchImpl }, (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0].owner_id, id);
    expect(snapshot.weather).toMatchObject({ status: 'unavailable', reason: 'farm_coordinates_missing', days: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    const setting = await owner.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: true, metaEnabled: true, intervalHours: 6 } });
    expect(setting.statusCode).toBe(200);
    // Farms are monitored by default from creation; keep only this farm due for the concurrency check.
    await h.pool.query("UPDATE farm_monitors SET next_check_at=now()+interval '1 day' WHERE farm_id<>$1", [id]);
    const counts = await Promise.all([enqueueDueMonitors(h.pool), enqueueDueMonitors(h.pool)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await h.pool.query("SELECT 1 FROM jobs WHERE type='farm.monitor' AND payload->>'farmId'=$1", [id])).rowCount).toBe(1);
  });
  it('stores real provider fixture output and exposes unit-checked references and bounded crop history to Meta', async () => {
    const id = await create();
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body });
    const ownerId = (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0].owner_id;
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json', import.meta.url), 'utf8'));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture.body), { status: 200 }));
    const config = { ...h.config, RUNTIME_MODE: 'live' as const };
    const snap = await monitoringSnapshot({ config, pool: h.pool, fetchImpl, now: () => new Date('2026-10-30T02:00:00Z') }, ownerId, id);
    expect(snap.weather).toMatchObject({ status: 'fresh', coordinateBasis: 'boundary_center' });
    expect(snap.weather.days.length).toBeGreaterThan(0);
    for (const ref of monitoringReferences(snap)) expect(ValueRecord.safeParse(ref).success).toBe(true);
    await saveMonitorSnapshot(h.pool, ownerId, snap);
    const output = await getFarmContextHandler({ farmId: id }, { ownerId, pool: h.pool, mode: 'live', requestId: randomUUID(), agentRunId: randomUUID(), asOf: snap.checkedAt });
    expect(FarmProfile.safeParse(output.farm).success).toBe(true);
    expect(output.farm.history).toMatchObject({ previousHarvest: body.previousHarvest, rotationAssessment: 'not_assessed', boundaryRecorded: true });
    expect(output.farm.location.value?.point).toBeNull();
    expect(unitAtPointer('get_farm_context', output, '/farm/monitoring/references/0/value')?.unit).toBe('mm');
    expect(monitorChanges(snap, { ...snap, checkedAt: '2026-10-30T03:00:00Z' })).toEqual([]);
    const replay = await getFarmContextHandler({ farmId: id }, { ownerId, pool: h.pool, mode: 'replay', requestId: randomUUID(), agentRunId: randomUUID(), asOf: snap.checkedAt });
    expect(replay.farm.history).toBeUndefined();
    expect(replay.farm.monitoring).toBeUndefined();
    const synthetic = await getFarmContextHandler({ farmId: id }, { ownerId, pool: h.pool, mode: 'synthetic', requestId: randomUUID(), agentRunId: randomUUID(), asOf: snap.checkedAt });
    expect(synthetic.farm.monitoring).toBeUndefined();
    expect(monitoringAt(snap, '2026-11-30T03:00:00Z').weather).toMatchObject({ status: 'unavailable', days: [] });
  });
  it('stored forecast row (jsonb) carrying wind_gusts_10m_max reaches the monitoring day and fires the gust alert when the refresh fails; without the key the check is noted as skipped', async () => {
    const id = await create();
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body });
    const ownerId = (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0].owner_id;
    const sourceId = await ensureSource(h.pool, OPENMETEO_SOURCES.forecast.manifestId, OPENMETEO_SOURCES.forecast.fallback);
    const locationKey = 'open-meteo:13.005,76.005';
    const gusts = [66, 40, 71];
    for (const [i, gust] of gusts.entries()) {
      const variables = { precipitation_sum: 0, temperature_2m_max: 30, temperature_2m_min: 20, et0_fao_evapotranspiration: 4, wind_gusts_10m_max: gust };
      await h.pool.query(
        `INSERT INTO weather_forecasts (location_key, lon, lat, issued_at, valid_on, variables, source_id, is_synthetic, mode, available_at, horizon_days)
         VALUES ($1, 76.005, 13.005, '2026-10-29T20:00:00Z', $2::date, $3::jsonb, $4, false, 'live', '2026-10-29T20:00:00Z', 3)`,
        [locationKey, ['2026-10-30', '2026-10-31', '2026-11-01'][i], JSON.stringify(variables), sourceId],
      );
    }
    try {
      await h.pool.query("DELETE FROM provider_cache WHERE key LIKE 'open-meteo:%'"); // force the stored-forecast path, not a cached refresh
      clearSharedWeatherReads(); // the raw SQL insert above bypasses insertVintage's memo clear
      const down = vi.fn(async () => { throw new Error('provider down'); });
      const config = { ...h.config, RUNTIME_MODE: 'live' as const };
      const now = () => new Date('2026-10-30T02:00:00Z');
      const snap = await monitoringSnapshot({ config, pool: h.pool, fetchImpl: down, now }, ownerId, id);
      expect(snap.weather.status).toBe('stale');
      expect(snap.weather.days.map((d) => d.gustMaxKmh)).toEqual(gusts);
      const ws = { farmId: id, version: 1, updatedAt: null, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [], fields: [] } as never;
      const { alerts, notes } = structuredAlerts(snap, ws, [], '2026-10-30T02:00:00Z');
      const wind = alerts.filter((a) => a.title === 'Strong wind gusts in the forecast');
      expect(wind.map((a) => [a.validFrom, a.validTo])).toEqual([['2026-10-30', '2026-10-30'], ['2026-11-01', '2026-11-01']]);
      expect(wind[1]!.detail).toContain('Gusts up to 71 km/h');
      expect(notes.some((n) => n.startsWith('wind_gust_check_skipped'))).toBe(false);

      // A row stored before the gust variable was requested: the check is skipped and says why.
      await h.pool.query("UPDATE weather_forecasts SET variables = variables - 'wind_gusts_10m_max' WHERE location_key=$1", [locationKey]);
      clearSharedWeatherReads();
      const old = await monitoringSnapshot({ config, pool: h.pool, fetchImpl: down, now }, ownerId, id);
      expect(old.weather.days.every((d) => d.gustMaxKmh === null)).toBe(true);
      const skipped = structuredAlerts(old, ws, [], '2026-10-30T02:00:00Z');
      expect(skipped.alerts.some((a) => a.title.startsWith('Strong wind'))).toBe(false);
      expect(skipped.notes).toContain('wind_gust_check_skipped:variable_not_in_stored_forecast');
    } finally {
      await h.pool.query('DELETE FROM weather_forecasts WHERE location_key=$1', [locationKey]);
      clearSharedWeatherReads();
    }
  });
  it('humidity, gust or soil-moisture movement alone does not raise weather_changed or change the fingerprint; a rain or temperature change still does', () => {
    const day = (over: Record<string, number | null> = {}) => ({ date: '2026-10-31', rainMm: 1.2, tMinC: 18, tMaxC: 27, et0Mm: 4, gustMaxKmh: 30, rhMeanPct: 78, soilMoisture0to7: 0.31, ...over });
    const snap = (days: ReturnType<typeof day>[]) => ({ mode: 'live', farmId: 'f', checkedAt: '2026-10-30T02:00:00Z',
      weather: { status: 'fresh', reason: null, issuedAt: '2026-10-30T01:00:00Z', attribution: 'Open-Meteo', point: { lat: 13, lon: 76 }, coordinateBasis: 'farm_location', days },
      market: { status: 'unavailable', reason: null, products: [] }, meta: { status: 'unavailable', reason: null, automatic: false } }) as never;
    const before = snap([day()]);
    const moved = snap([day({ gustMaxKmh: 66, rhMeanPct: 91, soilMoisture0to7: 0.42 })]);
    expect(monitorChanges(before, moved)).toEqual([]);
    expect(monitorFingerprint(before)).toBe(monitorFingerprint(moved));
    expect(monitorFingerprint(snap([{ date: '2026-10-31', rainMm: 1.2, tMinC: 18, tMaxC: 27, et0Mm: 4 } as never]))).toBe(monitorFingerprint(before)); // earlier snapshots keep their fingerprint
    expect(monitorChanges(before, snap([day({ rainMm: 9 })])).map((c) => c.kind)).toEqual(['weather_changed']);
    expect(monitorChanges(before, snap([day({ tMaxC: 31 })])).map((c) => c.kind)).toEqual(['weather_changed']);
  });
  it('stops provider spending after disable and does not run Meta in synthetic mode', async () => {
    const id = await create();
    const ownerId = (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0].owner_id;
    await owner.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: true, metaEnabled: true } });
    const fetchImpl = vi.fn(); const review = { createResponse: vi.fn(), deleteResponse: vi.fn() };
    const handler = createMonitorHandler({ config: h.config, pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl, metaTransport: review });
    const job = { id: randomUUID(), owner_id: ownerId, type: 'farm.monitor', attempt: 1, max_attempts: 1, payload: { farmId: id } };
    const ctx = { pool: h.pool, heartbeat: async () => {}, isCancelled: async () => false };
    expect(await handler(job, ctx)).toMatchObject({ status: 'checked', metaStatus: 'live_mode_required' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(review.createResponse).not.toHaveBeenCalled();
    await owner.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: false } });
    expect(await handler(job, ctx)).toMatchObject({ status: 'cancelled' });
  });
  it('claims at most one farm-level daily review across overlapping jobs and needs no live guest session', async () => {
    // Since 2026-11-01 the automatic review is farm-level (user decision): it is attributed to the farm owner and
    // capped per day, not billed to the session that toggled monitoring, so an expired session does not block it.
    const other = await login(h.app);
    const id = (await other.call('POST', '/api/v1/farms', { payload: farmBody({ facts: {} }) })).json().data.id;
    await other.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: body });
    await other.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: true, metaEnabled: true } });
    const ownerId = (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0].owner_id;
    await h.pool.query("UPDATE sessions SET expires_at=now()-interval '1 hour' WHERE owner_id=$1", [ownerId]);
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json', import.meta.url), 'utf8'));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture.body), { status: 200 }));
    const createResponse = vi.fn(async () => ({ responseId: 'resp_test', requestId: 'req', model: 'muse-spark-1.3', status: 'completed', outputText: '{"alerts":[]}', functionCalls: [], refusal: null, usage: { inputTokens: 3000, outputTokens: 500, cachedInputTokens: 0 }, latencyMs: 1, retries: 0, incompleteReason: null, citations: [], webSearchCalls: [{ id: 'ws', status: 'completed', queries: ['ginger Kerala'], sourceUrls: [], results: [] }] }));
    const review = { createResponse, deleteResponse: vi.fn(async () => ({ ok: true, code: null })) };
    const handler = createMonitorHandler({ config: { ...h.config, RUNTIME_MODE: 'live' }, pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl, metaTransport: review });
    const job = async () => ({ id: (await enqueue(h.pool, 'farm.monitor', { farmId: id }, ownerId, `t-${randomUUID()}`)).job.id, owner_id: ownerId, type: 'farm.monitor', attempt: 1, max_attempts: 1, payload: { farmId: id } });
    const ctx = { pool: h.pool, heartbeat: async () => {}, isCancelled: async () => false };
    // Store the forecast once first: concurrent first-time storage of one vintage is a known ingest race (weather_fc_vintage_uq).
    await monitoringSnapshot({ config: { ...h.config, RUNTIME_MODE: 'live' }, pool: h.pool, fetchImpl }, ownerId, id);
    const results = await Promise.all([handler(await job(), ctx), handler(await job(), ctx)]) as { metaStatus: string }[];
    expect(results.map((r) => r.metaStatus).sort()).toEqual(['completed', 'daily_limit']);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect((await readMonitorSettings(h.pool, ownerId, id, 'live')).metaReview).toMatchObject({ mode: 'live', kind: 'grounded_alert_review', status: 'completed' });
    expect((await readMonitorSettings(h.pool, ownerId, id, 'synthetic')).metaReview).toBeNull();
    // A farmer's explicit disable stops the next run before any provider work.
    await h.pool.query("UPDATE sessions SET expires_at=now()+interval '1 hour' WHERE owner_id=$1", [ownerId]);
    await other.call('PUT', `/api/v1/farms/${id}/monitoring`, { payload: { enabled: false } });
    expect(await handler(await job(), ctx)).toMatchObject({ status: 'cancelled' });
    expect(createResponse).toHaveBeenCalledTimes(1);
  });
});
