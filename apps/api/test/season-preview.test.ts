import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {SeasonPreview} from '@harvest/contracts';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';
import {eachDate} from '../src/plans/weather';
import type {HarvestPriceOutlook, SeasonalReferenceByWeek} from '../src/services/price-series';
import {seasonPreviewRoutes} from '../src/routes/season-preview';
import {randomUUID} from 'node:crypto';
import type {SeasonPreviewQuery} from '@harvest/contracts';
import {MAX_STEPS, NO_REVIEW_LIMITATION, PATH_MAX_POINTS, WEATHER_NOTE, pricePath, seasonPreview, typicalMonths, type SeasonPreviewDeps} from '../src/services/season-preview';
import {emptyInputs} from '../src/services/year-plan/inputs';
import {yearPlanContext} from '../src/services/year-plan/service';
import {login, setupHarness, type Client, type Harness} from './helpers';

/**
 * Every price, rain day and farm in this file is SYNTHETIC test data. Weather, prices and price-now come from injected
 * fakes; nothing reaches the network. The year-plan engine context is the real one built from the repo research files
 * for the test farm (yearPlanContext), with fixture inputs (rain normals, no NDVI) instead of a stored review.
 */
const NOW = new Date('2026-11-01T04:00:00Z');
const HA = {type: 'Polygon', coordinates: [[[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]]]};
const HASSAN = {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'};
const PIGEON = {id: 'rot-pigeon', year: 2027, season: 'Kharif', cropId: 'pigeon-pea', cropName: 'Pigeon pea', productId: 'pigeon-pea-whole', productName: 'Whole', plannedSowingDate: '2027-05-16', plannedHarvestDate: '2027-12-10'};
const INTER = {id: 'rot-inter', year: 2027, season: 'Kharif', cropId: 'ragi', cropName: 'Finger millet', productId: 'ragi-grain', plannedSowingDate: '2027-06-20', plannedHarvestDate: '2027-10-30', kind: 'intercrop', companion: {systemId: 'ragi-pigeonpea-ka', cropId: 'pigeon-pea', cropName: 'Pigeon pea', rowRatio: '8:2'}};
const dw = (date: string, rain: number | null): DailyWeather => ({date, rainMm: rain, et0Mm: null, tMinC: 18, tMaxC: 29, sourceId: 'open-meteo-archive'});

function fakeWeather(missing = false): Pick<WeatherSource, 'getClimatology'> & {ranges: {start: string; end: string}[]} {
  const ranges: {start: string; end: string}[] = [];
  return {
    ranges,
    getClimatology: async (_s, range) => { ranges.push(range); return missing ? null : {years: {from: 2016, to: 2025}, sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map((d) => dw(d, 4))}; },
  };
}
const outlook = (productId: string, harvestDate: string): HarvestPriceOutlook => ({
  productId, status: 'available', missingReason: null, unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'wholesale mandi modal price', limitations: [],
  scope: {level: 'district', requestedLevel: 'district', stateName: 'Karnataka', districtName: 'Hassan', marketCount: 2, marketIds: [], fallbackNote: null},
  method: 'B_seasonal_reference/pooled-v1', harvestDate, harvestWeek: {year: Number(harvestDate.slice(0, 4)), week: 37}, asOf: '2026-11-01', weekWindow: 2, yearsRequested: 3,
  yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 60, p25: 66, p50: 70, p75: 75, p90: 80, annualMean: 68, annualWeeks: 50, weeksUsed: 15, observations: 90, marketsUsed: 2, residualCount: 30,
});
const seasonal = (productId: string): SeasonalReferenceByWeek => ({
  productId, method: 'B_seasonal_reference/pooled-v1', asOf: '2026-11-01', weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'x', limitations: [],
  weeks: Array.from({length: 52}, (_, i) => ({...outlook(productId, '2027-01-01'), week: i + 1, p25: 38 + i, p50: 40 + i, p75: 42 + i, status: i === 51 ? 'insufficient' as const : 'available' as const})) as unknown as SeasonalReferenceByWeek['weeks'],
  stateWeeks: [],
});

let h: Harness, owner: Client, stranger: Client, app: FastifyInstance;
let farmId: string, strangerFarm: string;
const deps = {weather: fakeWeather(), engine: true as boolean};
const ownerOf = async (id: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0]!.owner_id;
async function createFarm(client: Client, name: string) {
  const res = await client.call('POST', '/api/v1/farms', {payload: {name, location: HASSAN, areaHectares: 2}});
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
function routeDeps(o: {weather: Pick<WeatherSource, 'getClimatology'>; engine: boolean}): Omit<SeasonPreviewDeps, 'config' | 'pool'> {
  return {
    now: () => NOW, weatherSource: o.weather, rateMarker: null,
    sources: {
      priceOutlook: async (a) => outlook(a.productId, a.harvestDate), seasonal: async (a) => seasonal(a.productId),
      marketNow: async () => ({p50: 72.5, date: '2026-10-30', markets: 3, scopeLabel: 'Hassan district mandis, last 14 trading days'}),
      ...(o.engine ? {engine: async (ownerId: string, id: string) => {
        const c = await yearPlanContext({pool: h.pool, config: h.config}, ownerId, id, '2026-11-01');
        const inputs = emptyInputs(c.asOf, c.ctx.irrigation);
        inputs.climatologyRainByMonth = [5, 5, 10, 40, 90, 120, 160, 140, 120, 150, 60, 15];
        return {ctx: c.ctx, inputs, norm: {maxMarginRate: 400, maxRevenueRate: 800}};
      }} : {}),
    },
  };
}

beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  stranger = await login(h.app);
  await h.pool.query(`INSERT INTO crop_identities (slug, names, category) VALUES ('pigeon-pea', '{"en": ["Pigeon pea"]}'::jsonb, 'pulse'), ('ragi', '{"en": ["Finger millet"]}'::jsonb, 'cereal'), ('maize', '{"en": ["Maize"]}'::jsonb, 'cereal') ON CONFLICT DO NOTHING`);
  for (const [crop, slug, name] of [['pigeon-pea', 'pigeon-pea-whole', 'Pigeon pea whole'], ['ragi', 'ragi-grain', 'Finger millet grain'], ['maize', 'maize-grain', 'Maize grain']] as const)
    await h.pool.query(`INSERT INTO crop_products (crop_id, slug, name, form) SELECT id, $2, $3, 'grain' FROM crop_identities WHERE slug=$1 ON CONFLICT DO NOTHING`, [crop, slug, name]);
  farmId = await createFarm(owner, 'Hassan preview');
  const put = await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'known', cropId: 'maize', harvestDate: '2026-10-15'}, cycles: [], rotationPlans: [PIGEON, INTER]}});
  expect(put.statusCode, put.body).toBe(200);
  strangerFarm = await createFarm(stranger, 'Stranger farm');
  // A separate app with the route mounted under /t and injected sources (the orchestrator's routes/index.ts registration
  // uses production deps); the session cookies of the shared harness app are valid here (same pool and secret).
  app = await h.make();
  await app.register(async (child) => {
    await child.register(seasonPreviewRoutes, {config: h.config, pool: h.pool, ...routeDeps(deps)});
  }, {prefix: '/t'});
  await app.register(async (child) => { await child.register(seasonPreviewRoutes, {config: h.config, pool: h.pool, ...routeDeps({weather: fakeWeather(true), engine: false})}); }, {prefix: '/bare'});
}, 120_000);
afterAll(async () => h?.close());

const get = (prefix: string, query: string, client: Client = owner, farm = farmId) =>
  app.inject({method: 'GET', url: `${prefix}/api/v1/farms/${farm}/season-preview?${query}`, headers: {cookie: client.cookie, origin: 'http://localhost:5173'}});

describe('pure helpers', () => {
  it('typicalMonths: rain = mean daily normal x days in season, temperatures are means, months clipped to the season', () => {
    const days = eachDate('2027-05-16', '2027-07-10').map((d) => dw(d, d < '2027-06-01' ? 2 : 5));
    const m = typicalMonths(days, '2027-05-16', '2027-07-10');
    expect(m.map((x) => [x.month, x.days, x.rainMm])).toEqual([['2027-05-01', 16, 32], ['2027-06-01', 30, 150], ['2027-07-01', 10, 50]]);
    expect(m[0]).toMatchObject({label: 'May 2027', tMaxC: 29, tMinC: 18});
  });
  it('pricePath: weekly from the sowing week Monday to four weeks after the latest harvest, at most 60 points, insufficient weeks null', () => {
    const p = pricePath(seasonal('x'), '2027-05-16', '2027-12-10');
    expect(p[0]!.weekStart).toBe('2027-05-10');
    expect(p.at(-1)!.weekStart <= '2028-01-07').toBe(true);
    expect(p.length).toBeLessThanOrEqual(PATH_MAX_POINTS);
    expect(p[0]).toEqual({weekStart: '2027-05-10', p50: 40 + 18, likely: {low: 56, high: 60}});
    const long = pricePath(seasonal('x'), '2027-01-04', '2029-06-30');
    expect(long.length).toBeLessThanOrEqual(PATH_MAX_POINTS);
    expect(long.some((x) => x.p50 === null)).toBe(true); // week 52 is insufficient in the fixture
  });
});

describe('GET /farms/:id/season-preview', () => {
  it('saved season: timeline, typical months, price path, market now, engine scoring, steps; owner-private and not cached', async () => {
    const res = await get('/t', 'planId=rot-pigeon');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const p = SeasonPreview.parse(res.json().data);
    expect(p).toMatchObject({planId: 'rot-pigeon', origin: 'saved_season', cropId: 'pigeon-pea', productId: 'pigeon-pea-whole', kind: 'crop', sowing: '2027-05-16', today: '2026-11-01'});
    // The workspace boundary sets the farm area (1.2062 ha for the fixture polygon); field totals use it.
    expect(p.fieldAreaHa).toBeCloseTo(1.2062, 3);
    expect(p.harvest!.latest).toBe('2027-12-10');
    expect(p.timeline).not.toBeNull();
    expect(p.weather.status).toBe('typical');
    expect(p.weather.note).toBe(WEATHER_NOTE);
    expect(p.weather.months[0]).toMatchObject({month: '2027-05-01', days: 16, rainMm: 64, tMaxC: 29, tMinC: 18});
    expect(p.weather.months.reduce((a, m) => a + m.days, 0)).toBe(209); // 16 May to 10 Dec inclusive
    expect(p.price).toMatchObject({status: 'available', p50: 70, likely: {low: 66, high: 75}, yearsUsed: [2023, 2024, 2025]});
    expect(p.price!.path[0]!.weekStart).toBe('2027-05-10');
    expect(p.marketNow).toEqual({p50: 72.5, date: '2026-10-30', markets: 3, scopeLabel: 'Hassan district mandis, last 14 trading days'});
    expect(p.components).not.toBeNull();
    expect(p.score).toBeGreaterThan(0);
    expect(p.water).not.toBeNull();
    expect(p.water!.fit).toBeGreaterThanOrEqual(0);
    expect(p.limitations).not.toContain(NO_REVIEW_LIMITATION);
    expect(p.yieldKgPerHa).not.toBeNull();
    expect(p.yieldForFieldKg).toEqual({low: Math.round(p.yieldKgPerHa!.low * p.fieldAreaHa!), high: Math.round(p.yieldKgPerHa!.high * p.fieldAreaHa!)});
    expect(p.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(p.steps.some((s) => s.kind === 'harvest' && s.to === '2027-12-10')).toBe(true);
    expect([...p.steps].map((s) => s.from)).toEqual([...p.steps].map((s) => s.from).sort());
    expect(p.soil).toEqual({status: 'no_report', checks: []});
    expect(p.basis.some((b) => b.kind === 'climatology')).toBe(true);
    expect(deps.weather.ranges.at(-1)).toEqual({start: '2027-05-16', end: '2027-12-10'});
  });

  it('custom slot: the query names the crop; the harvest is the stage-timeline window', async () => {
    const res = await get('/t', 'cropId=maize&productId=maize-grain&sowing=2027-06-10');
    expect(res.statusCode, res.body).toBe(200);
    const p = SeasonPreview.parse(res.json().data);
    expect(p).toMatchObject({planId: null, origin: 'custom', cropId: 'maize', productId: 'maize-grain', sowing: '2027-06-10'});
    expect(p.harvest).toEqual(p.timeline!.harvest);
    expect(p.price!.harvestWeek).toMatch(/^2027-W\d\d$/);
  });

  it('intercrop saved season: previewed as the sole main crop with a limitation until the engine scores intercrops', async () => {
    const p = SeasonPreview.parse((await get('/t', 'planId=rot-inter')).json().data);
    expect(p.kind).toBe('intercrop');
    // The fixture system id is not in intercropping.json, so the main crop is scored alone with a limitation.
    expect(p.companion).toBeNull();
    expect(p.limitations.some((l) => /previews? scores Finger millet as the sole crop|scores .* as the sole crop/.test(l))).toBe(true);
  });

  it('intercrop custom slot with a research system: scored with P1 makeIntercropSlotPlan and the companion block filled', async () => {
    const sys = (JSON.parse(readFileSync(resolve(__dirname, '../../../data/research/rotation/intercropping.json'), 'utf8')).systems as {id: string; mainCropId: string; mainProductId: string}[]).find((s) => s.id === 'ka-hassan-ragi-blackgram-4-1')!;
    const res = await get('/t', `cropId=${sys.mainCropId}&productId=${sys.mainProductId}&sowing=2027-07-05&systemId=${sys.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const p = SeasonPreview.parse(res.json().data);
    expect(p.kind).toBe('intercrop');
    expect(p.companion, JSON.stringify(p.limitations)).not.toBeNull();
    expect(p.companion).toMatchObject({systemId: sys.id, cropId: 'black-gram', rowRatio: '4:1'});
    expect(p.score).not.toBeNull();
  });

  it('missing climatology and no ready review: weather unavailable with the reason; scoring fields null with the generate line', async () => {
    const res = await get('/bare', 'planId=rot-pigeon');
    expect(res.statusCode, res.body).toBe(200);
    const p = SeasonPreview.parse(res.json().data);
    expect(p.weather).toMatchObject({status: 'unavailable', months: [], source: null});
    expect(p.weather.note).toContain('not stored yet');
    expect(p).toMatchObject({score: null, components: null, yieldKgPerHa: null, profitPerHa: null, profitForField: null, water: null, cost: null, reasonCodes: []});
    expect(p.limitations).toContain(NO_REVIEW_LIMITATION);
    expect(p.price!.status).toBe('available'); // price does not need the review
  });

  it('validation and isolation: unknown saved season 404, no slot 400, bad dates 400, a stranger gets 404', async () => {
    expect((await get('/t', 'planId=nope')).statusCode).toBe(404);
    expect((await get('/t', 'cropId=maize')).statusCode).toBe(400);
    expect((await get('/t', 'cropId=maize&sowing=2027-06-10&harvestLatest=2027-01-01')).statusCode).toBe(400);
    expect((await get('/t', 'cropId=maize&sowing=2027-13-01')).statusCode).toBe(400);
    expect((await get('/t', 'planId=rot-pigeon', stranger)).statusCode).toBe(404);
    expect((await get('/t', 'planId=rot-pigeon', owner, strangerFarm)).statusCode).toBe(404);
    expect(await ownerOf(strangerFarm)).not.toBe(await ownerOf(farmId));
  });
});

/**
 * Review MEDIUM-4 (2026-11-01): the preview reads a really stored year-plan review (a row written the way the service
 * stores one: the context hash and chain hash from yearPlanContext, SYNTHETIC rain normals and price scale) instead of the
 * stubbed engine source, and picks the plan year the season is sown in. A pending current-horizon row may already exist
 * (a workspace save can queue a plan); the helper then marks that row ready with the synthetic inputs.
 */
describe('stored year-plan review (review MEDIUM-4)', () => {
  const LATER = {id: 'rot-later', year: 2028, season: 'Kharif', cropId: 'ragi', cropName: 'Finger millet', productId: 'ragi-grain', plannedSowingDate: '2028-06-20', plannedHarvestDate: '2028-10-30'};
  async function storeReview(ownerId: string, farm: string, from: string | null) {
    const c = await yearPlanContext({pool: h.pool, config: h.config}, ownerId, farm, '2026-11-01', from, {candidates: false});
    const inputs = {annualMeans: {}, climatologyRainByMonth: [5, 5, 10, 40, 90, 120, 160, 140, 120, 150, 60, 15], climatologySource: {sourceId: 'synthetic-normals', years: {from: 2016, to: 2025}}, soilPh: null, neighbourhoodActiveMonths: null, neighbourhoodObservedMonths: null, priceKeys: {needed: 0, looked: 0, available: 0, failed: 0}};
    const stored = {asOf: c.asOf, scenario: c.ctx.scenario, candidateIds: [], norm: {maxMarginRate: 400, maxRevenueRate: 800}, inputs, chainHash: c.chainHash};
    await h.pool.query("INSERT INTO farm_year_plans(id,owner_id,farm_id,mode,context_hash,input_versions,input_context,result,status,horizon_from) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6::jsonb,$7::jsonb,'ready',$8::date) ON CONFLICT (farm_id,mode,context_hash) WHERE archived_at IS NULL DO UPDATE SET status='ready',input_context=EXCLUDED.input_context,result=EXCLUDED.result",
      [randomUUID(), ownerId, farm, h.config.RUNTIME_MODE, c.hash, JSON.stringify(stored), JSON.stringify({options: [], summary: 'Synthetic stored review for the preview test.'}), from]);
    return c;
  }

  it('a later-year season is scored in its own plan year; the current-year review scores current seasons; an intercrop shows companion price, cost and share-scaled field yield', async () => {
    const id = await createFarm(owner, 'Hassan preview stored review');
    const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'known', cropId: 'maize', harvestDate: '2026-10-15'}, cycles: [], rotationPlans: [PIGEON, LATER]}});
    expect(put.statusCode, put.body).toBe(200);
    const ownerId = await ownerOf(id);
    const d: SeasonPreviewDeps = {config: h.config, pool: h.pool, ...routeDeps({weather: fakeWeather(), engine: false})};
    const q = (x: Record<string, string>) => x as unknown as SeasonPreviewQuery;
    expect((await seasonPreview(d, ownerId, id, q({planId: 'rot-later'}))).limitations).toContain(NO_REVIEW_LIMITATION);
    // Only the 2027-11-01 plan year has a review: the 2028 season is scored, the 2027 season is not.
    const y1 = await storeReview(ownerId, id, '2027-11-01');
    expect(y1.ctx.scenario).toMatchObject({kind: 'future', yearIndex: 1, previousCropId: 'pigeon-pea'});
    const later = SeasonPreview.parse(await seasonPreview(d, ownerId, id, q({planId: 'rot-later'})));
    expect(later.limitations).not.toContain(NO_REVIEW_LIMITATION);
    expect(later.score).not.toBeNull();
    expect(later.components).not.toBeNull();
    const pigeonBefore = await seasonPreview(d, ownerId, id, q({planId: 'rot-pigeon'}));
    expect(pigeonBefore.limitations).toContain(NO_REVIEW_LIMITATION);
    expect(pigeonBefore.score).toBeNull();
    await storeReview(ownerId, id, null);
    const pigeon = SeasonPreview.parse(await seasonPreview(d, ownerId, id, q({planId: 'rot-pigeon'})));
    expect(pigeon.score).not.toBeNull();
    expect(pigeon.limitations).not.toContain(NO_REVIEW_LIMITATION);
    // Intercrop custom slot in the current year with a research system.
    const sys = (JSON.parse(readFileSync(resolve(__dirname, '../../../data/research/rotation/intercropping.json'), 'utf8')).systems as {id: string; mainCropId: string; mainProductId: string}[]).find((s) => s.id === 'ka-hassan-ragi-blackgram-4-1')!;
    const ic = SeasonPreview.parse(await seasonPreview(d, ownerId, id, q({cropId: sys.mainCropId, productId: sys.mainProductId, sowing: '2027-07-05', systemId: sys.id})));
    expect(ic.kind).toBe('intercrop');
    expect(ic.companion, JSON.stringify(ic.limitations)).toMatchObject({systemId: sys.id, cropId: 'black-gram'});
    expect(ic.companion!.price).toMatchObject({status: 'available', p50: 70});
    const main = ic.companion!.yieldShare.main;
    expect(ic.yieldKgPerHa, JSON.stringify(ic.limitations)).not.toBeNull();
    // Main-crop field yield after its share (the field area follows the saved boundary), as on the year-plan slot.
    const area = ic.fieldAreaHa!;
    expect(area).toBeGreaterThan(0);
    expect(ic.yieldForFieldKg).toEqual({low: Math.round(ic.yieldKgPerHa!.low * main.low * area), high: Math.round(ic.yieldKgPerHa!.high * main.high * area)});
    expect(main.high).toBeLessThan(1);
    if (ic.companion!.costPerHa != null) expect(ic.limitations.some((l) => l.includes(`companion adds ${ic.companion!.costPerHa} INR/ha`) && l.includes('profit counts both crops'))).toBe(true);
    else expect(ic.limitations.some((l) => l.includes('companion cost is not sourced'))).toBe(true);
  }, 120_000);
});
