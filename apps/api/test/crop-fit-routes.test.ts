import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CropFitReview, type HarvestPriceOutlook } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { cropFitRoutes, SOWING_LIMIT_DAYS } from '../src/routes/crop-fit';
import { generateCropFit, type CropFitDeps } from '../src/services/crop-fit/service';
import { CROP_FIT_JOB_TYPE, createCropFitHandler } from '../src/worker/handlers/crop-fit';
import { farmBody, login, ORIGIN, setupHarness, type Client, type Harness } from './helpers';

/**
 * Crop fit routes (synthetic mode, no network or model call). routes/index.ts registration belongs to the orchestrator,
 * so the plugin is registered here on a fresh app unless the app already serves it. Prices are SYNTHETIC fakes.
 */
let h: Harness, app: FastifyInstance, a: Client, b: Client;
const NOW = () => new Date('2026-11-01T06:00:00Z');
const outlook = (x: { productId: string; harvestDate: string; asOf: string }) => ({
  productId: x.productId, status: 'available', missingReason: null, scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 2, marketIds: [], fallbackNote: null },
  unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price', limitations: [], method: 'B_seasonal_reference/pooled-v1', harvestDate: x.harvestDate, harvestWeek: { year: 2027, week: 30 }, asOf: x.asOf,
  weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 15, p25: 18, p50: 21, p75: 24, p90: 27, annualMean: 20, annualWeeks: 150, weeksUsed: 15, observations: 90, marketsUsed: 2, residualCount: 140,
}) as unknown as HarvestPriceOutlook;
let deps: CropFitDeps;
/** IST day the route resolves "today" with: the fixed test clock, or the real clock when routes/index.ts already wires the plugin. */
let today = '2026-11-01';
beforeAll(async () => {
  h = await setupHarness();
  await loadCatalogueIntoDb(h.pool);
  app = await h.make();
  const wired = app.hasRoute({ method: 'GET', url: '/api/v1/farms/:id/crop-fit' });
  // When the orchestrator has wired the plugin with production deps, the worker step must use the same clock and sources.
  deps = wired ? { pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config) } : { pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW, sources: { priceOutlook: async (x) => outlook(x) } };
  if (wired) today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  else await app.register(cropFitRoutes, deps);
  a = await login(app);
  b = await login(app);
});
afterAll(async () => h?.close());

const hassan = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 };
const farm = async () => (await a.call('POST', '/api/v1/farms', { payload: farmBody({ location: hassan, facts: {} }) })).json().data as { id: string };
const ownerOf = async (farmId: string) => (await h.pool.query<{ owner_id: string }>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const jobs = async (farmId: string) => Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type='farm.crop-fit' AND payload->>'farmId'=$1", [farmId])).rows[0].count);

describe('crop-fit routes', () => {
  it('401 without a session, 404 for another owner, 400 for a bad query or body', async () => {
    const f = await farm();
    const url = `/api/v1/farms/${f.id}/crop-fit`;
    for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect((await b.call('GET', url)).statusCode).toBe(404);
    expect((await b.call('POST', url, { payload: {} })).statusCode).toBe(404);
    const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    for (const q of ['?mode=weekly', '?mode=season', '?mode=season&season=winter', '?mode=date&sowing=2027-02-30', '?mode=date&sowing=2026-10-01', `?mode=date&sowing=${plus(1462)}`, '?mode=date&after=Pigeon%20Pea', `?mode=date&after=${'a'.repeat(121)}`, '?extra=1'])
      expect((await a.call('GET', `${url}${q}`)).statusCode, q).toBe(400);
    expect((await a.call('POST', `${url}?mode=date&sowing=2027-05-17`, { payload: { force: true } })).statusCode).toBe(400);
    expect(await jobs(f.id)).toBe(0);
  });

  it('GET starts one review (pending, one job), the job makes it ready; POST with the same query forces a fresh row; another mode is its own review', async () => {
    const f = await farm();
    const url = `/api/v1/farms/${f.id}/crop-fit?mode=date&sowing=2027-05-17`;
    const res = await a.call('GET', url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const pending = CropFitReview.parse(res.json().data);
    expect(pending).toMatchObject({ status: 'pending', resolvedSowing: '2027-05-17' });
    expect(CropFitReview.parse((await a.call('GET', url)).json().data).reviewId).toBe(pending.reviewId);
    expect(await jobs(f.id)).toBe(1);
    expect(CROP_FIT_JOB_TYPE).toBe('farm.crop-fit');
    const job = (await h.pool.query<{ id: string; payload: unknown; owner_id: string }>("SELECT id,payload,owner_id FROM jobs WHERE type='farm.crop-fit' AND payload->>'farmId'=$1", [f.id])).rows[0]!;
    // The registered handler shape: owner + payload { reviewId }.
    const out = await createCropFitHandler(deps)({ ...job, type: CROP_FIT_JOB_TYPE } as never, { isCancelled: async () => false, heartbeat: async () => undefined, pool: h.pool } as never);
    expect(out).toMatchObject({ status: 'ready' });
    const ready = CropFitReview.parse((await a.call('GET', url)).json().data);
    expect(ready).toMatchObject({ status: 'ready', pickOrigin: 'deterministic', reviewId: pending.reviewId });
    expect(ready.picks).toHaveLength(3);
    const forced = CropFitReview.parse((await a.call('POST', url, { payload: {} })).json().data);
    expect(forced.reviewId).not.toBe(pending.reviewId);
    expect(forced.status).toBe('pending');
    expect(await jobs(f.id)).toBe(2);
    const season = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=season&season=kharif`)).json().data);
    expect(season).toMatchObject({ status: 'pending', request: { mode: 'season', season: 'kharif', sowing: null }, resolvedSowing: null });
    await generateCropFit(deps, season.reviewId!, await ownerOf(f.id));
    const kharif = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=season&season=kharif&sowing=2027-01-01`)).json().data);
    expect(kharif).toMatchObject({ status: 'ready', reviewId: season.reviewId }); // sowing ignored outside date mode
  });

  it('round 3: after applies to mode=date (own request key), sowing may be up to 1,461 days ahead (the end of plan year 3)', async () => {
    const f = await farm();
    const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const far = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=date&sowing=${plus(1461)}`)).json().data);
    expect(far).toMatchObject({ status: 'pending', request: { mode: 'date', sowing: plus(1461) } });
    expect(SOWING_LIMIT_DAYS).toBe(1461);
    expect((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=date&sowing=${plus(1462)}`)).statusCode).toBe(400);
    const url = `/api/v1/farms/${f.id}/crop-fit?mode=date&sowing=2027-05-17`;
    const plain = CropFitReview.parse((await a.call('GET', url)).json().data);
    const after = CropFitReview.parse((await a.call('GET', `${url}&after=pigeon-pea`)).json().data);
    expect(after.reviewId).not.toBe(plain.reviewId);
    expect(after).toMatchObject({ request: { mode: 'date', sowing: '2027-05-17', after: 'pigeon-pea' }, previousCropId: 'pigeon-pea' });
    // Outside date mode `after` is ignored: the same review as without it.
    const season = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=season&season=kharif`)).json().data);
    const seasonAfter = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit?mode=season&season=kharif&after=pigeon-pea`)).json().data);
    expect(seasonAfter.reviewId).toBe(season.reviewId);
    expect(seasonAfter.request).toEqual({ mode: 'season', season: 'kharif', sowing: null });
  });

  it('review L4: after accepts the intercrop rotation token ic:<systemId> and scores it as the system\'s main crop', async () => {
    const f = await farm();
    const base = `/api/v1/farms/${f.id}/crop-fit?mode=date&sowing=2027-05-17`;
    const token = 'ic:ka-hassan-ragi-redgram-8-1'; // finger millet + pigeon pea (intercropping.json)
    for (const bad of ['ic:', 'ic:Ragi', 'xx:ragi', 'ic:ic:ragi']) expect((await a.call('GET', `${base}&after=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
    const ic = CropFitReview.parse((await a.call('GET', `${base}&after=${encodeURIComponent(token)}`)).json().data);
    expect(ic).toMatchObject({ status: 'pending', request: { mode: 'date', sowing: '2027-05-17', after: token }, previousCropId: token });
    const main = CropFitReview.parse((await a.call('GET', `${base}&after=finger-millet`)).json().data);
    expect(main.reviewId).not.toBe(ic.reviewId);
    const owner = await ownerOf(f.id);
    await generateCropFit(deps, ic.reviewId!, owner);
    await generateCropFit(deps, main.reviewId!, owner);
    const icReady = CropFitReview.parse((await a.call('GET', `${base}&after=${encodeURIComponent(token)}`)).json().data);
    const mainReady = CropFitReview.parse((await a.call('GET', `${base}&after=finger-millet`)).json().data);
    expect(icReady.status).toBe('ready');
    expect(icReady.limitations.some((l) => l.startsWith('Scored after finger millet + pigeon pea'))).toBe(true);
    // No sourced nitrogen credit on this system, so the rotation reads exactly as after its main crop (year-plan rotationFacts).
    const key = (c: CropFitReview['candidates'][number]) => `${c.cropId}|${c.productId}|${c.companion?.systemId ?? ''}|${c.sowing}`;
    const mainRules = new Map(mainReady.candidates.map((c) => [key(c), c.rotation.rule]));
    expect(icReady.candidates.length).toBeGreaterThan(0);
    expect(icReady.candidates.length).toBe(mainReady.candidates.length);
    for (const c of icReady.candidates) {
      expect(c.rotation.previousCropId).toBe(token);
      expect(c.rotation.rule, key(c)).toBe(mainRules.get(key(c)));
    }
    expect(icReady.candidates.some((c) => c.rotation.rule === 'same_family' || c.rotation.rule === 'avoid_after')).toBe(true); // cereals after a millet
  });

  it('no mode on a fresh field defaults to date with today', async () => {
    const f = await farm();
    const r = CropFitReview.parse((await a.call('GET', `/api/v1/farms/${f.id}/crop-fit`)).json().data);
    expect(r.request).toEqual({ mode: 'date', season: null, sowing: today });
    expect(r.resolvedSowing).toBe(today);
  });
});
