import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {StageTimeline, TodayView} from '@harvest/contracts';
import {setupHarness, login, testConfig, ORIGIN, type Harness, type Client} from './helpers';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {MAX_OUTLOOK_CALLS, boundedWindow, todayView, type TodayProviders, type TodayViewDeps} from '../src/services/today/view';
import {todayRoutes} from '../src/routes/today';
import {stageAt, stageTimeline} from '../src/services/today/stage-timeline';
import {persistAlerts, type AlertDraft} from '../src/services/today/alerts';
import {focusedResearch, type FocusedResearch} from '../src/services/focused-crops';
import {PRICE_OUTLOOK_METHOD, type HarvestPriceOutlook, type HarvestPriceOutlookArgs, type PriceBucket, type PriceScope, type PriceSeries, type PriceSeriesArgs} from '../src/services/price-series';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';
import {eachDate} from '../src/plans/weather';
import {isoWeek} from '../src/plans/adapters/market-outlook';
import {ApiError, notFound} from '../src/services/errors';

/**
 * Every farm, scene, price, forecast, care schedule and alert in this file is SYNTHETIC test data. Providers are
 * injected fakes (Planetary Computer through its fetch seam; prices and weather through the view's provider seam);
 * nothing reaches the network.
 */
const NOW = new Date('2026-11-01T04:00:00Z'); // 09:30 IST on 2026-11-01
const TODAY = '2026-11-01';
const SOWING = '2026-09-01';
const HA = {type: 'Polygon', coordinates: [[[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]]]};
const HASSAN = {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'};

const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const mondayOf = (d: string) => plus(d, 1 - (new Date(`${d}T00:00:00Z`).getUTCDay() || 7));
const bucketOf = (d: string) => Math.min(52, isoWeek(d).week);
const ID = (date: string) => `S2A_MSIL2A_${date.replace(/-/g, '')}T052231_R062_T43PFQ_${date.replace(/-/g, '')}T101714`;
const scene = (date: string, field: FakeScene['field'], neighbourhood?: FakeScene['neighbourhood']): FakeScene => ({id: ID(date), datetime: `${date}T05:22:31.024Z`, field, ...(neighbourhood ? {neighbourhood} : {})});
const SCENES: FakeScene[] = [
  scene('2026-10-29', 'bad'), // implausible 8-bit-looking bands: not usable
  scene('2026-10-27', {ndvi: 0.7}, {ndvi: 0.55}),
  scene('2026-10-12', {ndvi: 0.5}, {ndvi: 0.48}),
  scene('2026-09-27', 'cloudy', {ndvi: 0.4}),
  scene('2026-08-20', {ndvi: 0.3}), // before sowing, inside the 30-day lead
];

// ------------------------------------------------------------------ fake providers

interface PriceCalls { series: PriceSeriesArgs[]; outlook: HarvestPriceOutlookArgs[] }
const scopeOf = (district: string | null | undefined): PriceScope => district
  ? {level: 'district', requestedLevel: 'district', stateName: 'Karnataka', districtName: district, marketCount: 5, marketIds: [], fallbackNote: null}
  : {level: 'state', requestedLevel: 'state', stateName: 'Karnataka', districtName: null, marketCount: 46, marketIds: [], fallbackNote: null};
const BASIS = {unit: 'INR/kg' as const, priceBasis: 'wholesale_mandi_modal' as const, basisLabel: 'synthetic test prices'};
/** Synthetic seasonal reference: p50 = 30 + (ISO week mod 7), P25 = p50 - 4, P75 = p50 + 5. */
const refP50 = (date: string) => 30 + (isoWeek(date).week % 7);

function fakePrices(calls: PriceCalls, opts: {noSeries?: boolean} = {}): Pick<TodayProviders, 'priceSeries' | 'harvestPriceOutlook'> {
  return {
    priceSeries: async (_pool, _mode, args): Promise<PriceSeries> => {
      calls.series.push(args);
      const buckets: PriceBucket[] = [];
      let i = 0;
      for (let m = mondayOf(args.from); m <= args.to; m = plus(m, 7), i++) {
        const p50 = i === 2 ? null : 20 + i; // the third week has no quotes
        buckets.push({start: m < args.from ? args.from : m, end: plus(m, 6) > args.to ? args.to : plus(m, 6), p50, min: p50 === null ? null : p50 - 2, max: p50 === null ? null : p50 + 3, n: p50 === null ? 0 : 4, markets: p50 === null ? 0 : 3});
      }
      return {
        productId: args.productId, status: 'available', missingReason: null, scope: scopeOf(args.districtName), ...BASIS, limitations: ['Synthetic test series.'],
        bucket: args.bucket, from: args.from, to: args.to, buckets, coverage: {observations: 40, markets: 3, firstDate: args.from, lastDate: args.to, validDays: 30, excludedRows: 0}, gaps: [],
      };
    },
    harvestPriceOutlook: async (_pool, _mode, args): Promise<HarvestPriceOutlook> => {
      calls.outlook.push(args);
      const p50 = opts.noSeries ? null : refP50(args.harvestDate);
      return {
        productId: args.productId, status: opts.noSeries ? 'insufficient' : 'available', missingReason: opts.noSeries ? 'price_history_not_ingested' : null,
        scope: scopeOf(args.districtName), ...BASIS, limitations: ['Synthetic test outlook.'],
        method: PRICE_OUTLOOK_METHOD, harvestDate: args.harvestDate, harvestWeek: isoWeek(args.harvestDate), asOf: args.asOf, weekWindow: 2, yearsRequested: 3,
        yearsConsidered: [2023, 2024, 2025], yearsUsed: opts.noSeries ? [] : [2023, 2024, 2025], perYear: [],
        p10: p50 === null ? null : p50 - 6, p25: p50 === null ? null : p50 - 4, p50, p75: p50 === null ? null : p50 + 5, p90: p50 === null ? null : p50 + 8,
        annualMean: p50, annualWeeks: 150, weeksUsed: 15, observations: 300, marketsUsed: 4, residualCount: 150,
      };
    },
  };
}

const dw = (date: string, rain: number, tMin: number, tMax: number, sourceId: string): DailyWeather => ({date, rainMm: rain, et0Mm: null, tMinC: tMin, tMaxC: tMax, sourceId});
const FORECAST_END = '2026-11-07';
function fakeWeather(o: {fail?: boolean} = {}): WeatherSource {
  return {
    modes: ['live', 'replay', 'synthetic'],
    getDailyObservations: async (_s, range) => eachDate(range.start, range.end).map((d) => dw(d, 2, 19, 29, 'open-meteo-archive')),
    getForecast: async () => {
      if (o.fail) throw new Error('weather provider down');
      return {issuedAt: '2026-11-01T01:00:00Z', sourceId: 'open-meteo-forecast', days: eachDate(TODAY, FORECAST_END).map((d) => dw(d, 1, 21, 31, 'open-meteo-forecast'))};
    },
    getClimatology: async (_s, range) => ({years: {from: 2019, to: 2025}, qualifyingYears: [2019, 2020, 2021, 2022, 2023, 2024, 2025], sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map((d) => dw(d, 4, 20, 30, 'open-meteo-archive'))}),
    dataVersion: async () => 'v',
  };
}

// ------------------------------------------------------------------ fixtures

let h: Harness, owner: Client, stranger: Client;
let research: FocusedResearch;
let farmId: string, ownerId: string, strangerId: string, emptyFarmId: string;
let illustrationId: string;
const fetchSpy = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network disabled in tests'); });

const ownerOf = async (id: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0]!.owner_id;
async function createFarm(client: Client, name: string) {
  const res = await client.call('POST', '/api/v1/farms', {payload: {name, location: HASSAN}});
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
const maizeCycle = {id: 'cycle-maize', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', sowingDate: SOWING, establishmentDate: SOWING, establishmentMethod: 'direct_sowing', stage: 'growing'};
const alert = (title: string): AlertDraft => ({
  type: 'crop_threat', severity: 'watch', origin: 'rule', title, detail: 'Synthetic test alert, not a real outbreak.',
  source: {name: 'Synthetic test source', url: 'https://example.test/maize-guide', date: '2026-10-20'}, validFrom: '2026-10-28', validTo: '2026-11-15',
  suggestedStep: 'Scout the whorls for fresh feeding marks.',
});
const careItem = (id: string, title: string, startDay: number, endDay: number) => ({
  id, title, action: `${title} (synthetic test schedule).`, anchor: 'sowing' as const, startDay, endDay, repeatEveryDays: null, stage: null, conditions: [],
  sourceRefs: [{sourceId: 'synthetic-test', locator: 'n/a'}], establishmentMethods: ['direct_sowing'], geographyIds: ['IN-KA'],
});

function liveDeps(over: {calls?: PriceCalls; providers?: Partial<TodayProviders>; scenes?: FakeScene[]} = {}): TodayViewDeps & {fake: ReturnType<typeof fakePlanetary>} {
  const fake = fakePlanetary(over.scenes ?? SCENES);
  return {
    config: {RUNTIME_MODE: 'live'}, pool: h.pool, now: () => NOW, sentinelFetch: fake.fetchImpl, fake,
    providers: {...fakePrices(over.calls ?? {series: [], outlook: []}), weatherSource: fakeWeather(), focusedResearch: async () => research, ...over.providers},
  };
}

beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  stranger = await login(h.app);
  await h.pool.query(`INSERT INTO crop_identities (slug, names, category) VALUES ('maize', '{"en": ["Maize"]}'::jsonb, 'cereal'), ('sugarcane', '{"en": ["Sugarcane"]}'::jsonb, 'cash') ON CONFLICT DO NOTHING`);
  await h.pool.query(`INSERT INTO crop_products (crop_id, slug, name, form) SELECT id, 'maize-grain', 'Maize grain', 'grain' FROM crop_identities WHERE slug='maize' ON CONFLICT DO NOTHING`);
  await h.pool.query(`INSERT INTO crop_products (crop_id, slug, name, form) SELECT id, 'sugarcane-cane', 'Sugarcane', 'cane' FROM crop_identities WHERE slug='sugarcane' ON CONFLICT DO NOTHING`);
  const real = await focusedResearch();
  research = {...real, crops: real.crops.map((c) => (c.cropId === 'maize' ? {...c, care: [
    careItem('t-old', 'Thin the seedlings', 10, 12), // overdue by more than 14 days: not listed
    careItem('t-due', 'Top dress nitrogen', 60, 66), // 2026-10-31 to 2026-11-06: due today
    careItem('t-soon', 'Check for stem borer', 70, 72), // 2026-11-10: within 14 days
    careItem('t-late', 'Plan harvest labour', 100, 105), // 2026-12-10: beyond 14 days
  ]} : c))};

  farmId = await createFarm(owner, 'Hassan maize');
  ownerId = await ownerOf(farmId);
  const put = await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles: [maizeCycle], rotationPlans: []}});
  expect(put.statusCode, put.body).toBe(200);
  await persistAlerts(h.pool, ownerId, farmId, 'live', [alert('Fall armyworm scouting window')]);
  emptyFarmId = await createFarm(owner, 'Nothing planted');
  await persistAlerts(h.pool, ownerId, emptyFarmId, 'live', [alert('Pest window for the area')]);
  const strangerFarm = await createFarm(stranger, 'Stranger farm');
  strangerId = await ownerOf(strangerFarm);

  // Illustrations (synthetic rows): one ready for the next stage, one still queued, one for a stage not in the timeline.
  const expected = expectedTimeline();
  const next = expected.stages.find((s) => s.from > TODAY)!;
  const ins = (stageId: string, status: string) => h.pool.query<{id: string}>(
    `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, storage_key)
     VALUES ($1,$2,'cycle-maize',$3,'2026-10-27T05:22:31Z',$4,$4,'maize','Maize','test-v1',$5,$6) RETURNING id`,
    [ownerId, farmId, ID('2026-10-27'), stageId, status, status === 'ready' ? `future-look/${farmId}/${stageId}.png` : null]);
  illustrationId = (await ins(next.id, 'ready')).rows[0]!.id;
  await ins('not_a_stage_here', 'ready');
  await ins(expected.stages[0]!.id, 'queued');
}, 60_000);
afterAll(async () => h?.close());
beforeEach(async () => { await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'"); });
afterEach(() => { vi.restoreAllMocks(); });

function expectedTimeline(): StageTimeline {
  return stageTimeline({cropId: 'maize', productId: 'maize-grain', establishmentMethod: 'direct_sowing', anchorDate: SOWING, stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
}

// ------------------------------------------------------------------ tests

describe('todayView: Hassan farm with a maize cycle (live, injected providers)', () => {
  it('composes a contract-valid view: slider at today, harvest countdown, scenes, health, tracks, alerts and upcoming steps', async () => {
    const spy = fetchSpy();
    const calls: PriceCalls = {series: [], outlook: []};
    const deps = liveDeps({calls});
    const view = TodayView.parse(await todayView(deps, ownerId, farmId));
    const expected = expectedTimeline();
    const harvest = expected.harvest!;

    // Cycle, product and timeline (the same calendar arithmetic as the stage-timeline route).
    expect(view).toMatchObject({farmId, asOf: NOW.toISOString(), today: TODAY, imdStatus: 'not_connected'});
    expect(view.cycle).toMatchObject({id: 'cycle-maize', cropId: 'maize', productId: 'maize-grain'});
    expect(view.product).toEqual({productId: 'maize-grain', productName: 'Maize grain', cropName: 'Maize'});
    expect(view.timeline).toEqual(expected);
    expect(harvest.earliest > TODAY).toBe(true); // fixture sanity: the harvest window is still ahead
    expect(new Set(expected.stages.map((s) => s.basis))).toEqual(new Set(['fao_generic']));

    // Slider opens at today; days to harvest from the IST calendar date.
    expect(view.slider).toEqual({from: SOWING, to: harvest.latest, todayProgress: dayDiff(SOWING, TODAY) / dayDiff(SOWING, harvest.latest)});
    expect(view.slider!.todayProgress).toBeGreaterThan(0);
    expect(view.slider!.todayProgress).toBeLessThan(1);
    expect(view.daysToHarvest).toEqual({earliest: dayDiff(TODAY, harvest.earliest), latest: dayDiff(TODAY, harvest.latest)});

    // Satellite: usable readings only, owner-private image paths, stage ids from the timeline, one ready illustration.
    const observed = view.scenes.filter((s) => s.kind === 'observed');
    expect(observed.map((s) => s.date)).toEqual(['2026-08-20', '2026-10-12', '2026-10-27']);
    for (const s of observed) {
      expect(s).toMatchObject({itemId: ID(s.date), acquisitionDate: s.date, derivedFromItemId: null, imagePath: `/api/v1/farms/${farmId}/ndvi/${ID(s.date)}/image?kind=visual`, ndviImagePath: `/api/v1/farms/${farmId}/ndvi/${ID(s.date)}/image?kind=ndvi`});
      expect(s.stageId).toBe(stageAt(expected, s.date).stage?.id ?? null);
    }
    expect(observed[0]!.stageId).toBeNull(); // before sowing
    const next = expected.stages.find((s) => s.from > TODAY)!;
    expect(view.scenes.filter((s) => s.kind === 'illustration')).toEqual([{
      date: next.from, kind: 'illustration', itemId: null, acquisitionDate: '2026-10-27', cloudPct: 1,
      imagePath: `/api/v1/farms/${farmId}/future-look/${illustrationId}/image`, ndviImagePath: null, derivedFromItemId: ID('2026-10-27'), stageId: next.id,
    }]);
    expect(view.limitations.join(' ')).toMatch(/1 stage illustration is not shown because the stage is no longer in this cycle's timeline/);
    expect(view.ndvi).toMatchObject({status: 'available', scenesAnalysed: 5, smallField: false});

    // Health: latest usable reading against its neighbourhood (0.70 vs 0.55), no stage reference.
    expect(view.health).toMatchObject({date: '2026-10-27', verdict: 'above_typical', typicalRange: null, basis: {kind: 'ndvi', sourceId: ID('2026-10-27'), url: null}});
    expect(view.health!.ndviMean).toBeCloseTo(0.7, 2);
    expect(view.health!.neighbourhoodMean).toBeCloseTo(0.55, 2);
    expect(view.health!.basis.note).toMatch(/No typical NDVI range is sourced/);

    // Price: the harvest-midpoint outlook resolved to the district, so observed weeks use it too; then weekly references.
    const mid = plus(harvest.earliest, Math.floor(dayDiff(harvest.earliest, harvest.latest) / 2));
    expect(calls.outlook[0]).toEqual({productId: 'maize-grain', stateName: 'Karnataka', districtName: 'Hassan', harvestDate: mid, asOf: TODAY});
    expect(calls.series).toEqual([{productId: 'maize-grain', stateName: 'Karnataka', districtName: 'Hassan', from: SOWING, to: TODAY, bucket: 'week', asOf: TODAY}]);
    expect(view.harvestPrice).toEqual({p50: refP50(mid), range: {low: refP50(mid) - 4, high: refP50(mid) + 5}, status: 'available', reason: null, scopeLabel: '3 years of Hassan district mandi prices (district pool, 5 markets)'});
    const obsPts = view.priceTrack.filter((p) => p.kind === 'observed');
    const refPts = view.priceTrack.filter((p) => p.kind === 'reference');
    expect(view.priceTrack.map((p) => p.kind)).toEqual([...obsPts.map(() => 'observed'), ...refPts.map(() => 'reference')]); // observed first, then reference
    expect(obsPts[0]).toEqual({date: SOWING, kind: 'observed', p50: 20, range: {low: 18, high: 23}, unit: 'INR/kg'});
    expect(obsPts[2]).toMatchObject({p50: null, range: null}); // a week without quotes stays empty
    expect(obsPts.every((p) => p.date <= TODAY)).toBe(true);
    const mondays: string[] = [];
    for (let m = plus(mondayOf(TODAY), 7); m <= harvest.latest; m = plus(m, 7)) mondays.push(m);
    expect(refPts.map((p) => p.date)).toEqual(mondays);
    expect(refPts[0]).toEqual({date: '2026-11-02', kind: 'reference', p50: refP50('2026-11-02'), range: {low: refP50('2026-11-02') - 4, high: refP50('2026-11-02') + 5}, unit: 'INR/kg'});
    expect(calls.outlook.length).toBeLessThanOrEqual(MAX_OUTLOOK_CALLS);
    expect(new Set(calls.outlook.map((a) => bucketOf(a.harvestDate))).size).toBe(calls.outlook.length); // one outlook per ISO week
    expect(calls.outlook.every((a) => a.districtName === 'Hassan' && a.asOf === TODAY)).toBe(true);

    // Weather along the slider: observed, then the stored forecast to its horizon, then typical; never forecast beyond it.
    expect(view.weatherTrack.map((d) => d.date)).toEqual(eachDate(SOWING, harvest.latest));
    const kindOn = (d: string) => view.weatherTrack.find((w) => w.date === d)!.kind;
    expect([kindOn('2026-10-31'), kindOn(TODAY), kindOn(FORECAST_END), kindOn(plus(FORECAST_END, 1))]).toEqual(['observed', 'forecast', 'forecast', 'typical']);
    expect(view.weatherTrack.filter((d) => d.kind === 'forecast' && d.date > FORECAST_END)).toEqual([]);
    expect(view.weatherTrack.find((d) => d.date === TODAY)!.basis).toEqual({source: 'open-meteo-forecast', issuedAt: '2026-11-01T01:00:00.000Z', years: null});
    expect(view.weatherTrack.find((d) => d.date === plus(FORECAST_END, 1))!.basis.years).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025]);

    // Alerts, upcoming steps (care tasks in 14 days, the next stage transition, the alert's step), monitoring.
    expect(view.alerts.map((a) => a.title)).toEqual(['Fall armyworm scouting window']);
    expect(view.newsReview).not.toBeNull();
    const care = view.upcoming.filter((s) => s.kind === 'care_task');
    expect(care.map((s) => [s.title, s.status, s.dueFrom])).toEqual([['Top dress nitrogen', 'due', '2026-10-31'], ['Check for stem borer', 'upcoming', '2026-11-10']]);
    expect(care[0]!.careTask).toMatchObject({actionId: 't-due', cycleId: 'cycle-maize', evidenceState: 'source_schedule'});
    expect(view.upcoming.find((s) => s.kind === 'stage_transition')).toMatchObject({dueFrom: next.from, dueTo: next.from, status: 'upcoming', title: `${next.name} expected to start`});
    expect(view.upcoming.find((s) => s.kind === 'alert_step')).toMatchObject({alertId: view.alerts[0]!.id, dueFrom: '2026-10-28', status: 'due', detail: 'Scout the whorls for fresh feeding marks.'});
    expect(view.upcoming.map((s) => s.dueFrom)).toEqual([...view.upcoming.map((s) => s.dueFrom)].sort());
    expect(view.limitations.join(' ')).toMatch(/1 care action overdue by more than 14 days is not listed/);
    expect(view.monitoring.enabled).toBe(true);
    expect(view.monitoring.nextCheckAt).not.toBeNull();

    // Limitations are merged and unique; no network outside the injected Planetary Computer fake.
    expect(new Set(view.limitations).size).toBe(view.limitations.length);
    expect(view.limitations.join(' ')).toMatch(/not a forecast/);
    expect(view.limitations.join(' ')).toMatch(/never marked reached by an observation/);
    expect(deps.fake.calls.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a provider failure degrades only its section and says so; a vanished farm is still a 404', async () => {
    const boom = async (): Promise<never> => { throw new Error('upstream exploded with secret detail'); };
    const deps = liveDeps({providers: {ndviSeries: boom, harvestPriceOutlook: boom, weatherSource: fakeWeather({fail: true})}});
    const view = TodayView.parse(await todayView(deps, ownerId, farmId));
    expect(view.ndvi).toBeNull();
    expect(view.health).toBeNull();
    expect(view.scenes.filter((s) => s.kind === 'observed')).toEqual([]);
    expect(view.priceTrack).toEqual([]);
    expect(view.harvestPrice).toBeNull();
    expect(view.weatherTrack.length).toBe(dayDiff(SOWING, expectedTimeline().harvest!.latest) + 1);
    expect(view.weatherTrack.every((d) => d.kind === 'unavailable')).toBe(true);
    expect(view.limitations.slice(0, 3)).toEqual([
      'Satellite readings could not be read now (internal_error); that part of the view is left empty.',
      'Mandi prices could not be read now (internal_error); that part of the view is left empty.',
      'Weather could not be read now (internal_error); that part of the view is left empty.',
    ]);
    expect(view.limitations.join(' ')).not.toMatch(/secret detail/);
    // Everything else is intact.
    expect(view.timeline).toEqual(expectedTimeline());
    expect(view.slider).not.toBeNull();
    expect(view.alerts).toHaveLength(1);
    expect(view.upcoming.some((s) => s.kind === 'care_task')).toBe(true);

    const gone = liveDeps({providers: {ndviSeries: async () => { throw notFound('Farm'); }}});
    await expect(todayView(gone, ownerId, farmId)).rejects.toMatchObject({statusCode: 404, message: 'Farm not found'});
  });

  it('a product without a verified price series gets an insufficient harvest price and an empty track', async () => {
    const calls: PriceCalls = {series: [], outlook: []};
    const view = TodayView.parse(await todayView(liveDeps({calls, providers: fakePrices(calls, {noSeries: true})}), ownerId, farmId));
    expect(view.priceTrack).toEqual([]);
    expect(view.harvestPrice).toMatchObject({status: 'insufficient', reason: 'price_history_not_ingested', p50: null, range: null});
    expect(view.harvestPrice!.scopeLabel).toMatch(/no verified mandi price series/);
    expect(calls.outlook).toHaveLength(1); // no weekly references or observed series after the headline says there is no series
    expect(calls.series).toEqual([]);
  });
});

describe('todayView: edges', () => {
  it('no current cycle: null cycle and timeline, no satellite or price, but weather and alerts are present', async () => {
    const ndvi = vi.fn(), outlook = vi.fn();
    const deps = liveDeps({providers: {ndviSeries: ndvi as unknown as TodayProviders['ndviSeries'], harvestPriceOutlook: outlook as unknown as TodayProviders['harvestPriceOutlook']}});
    const view = TodayView.parse(await todayView(deps, ownerId, emptyFarmId));
    expect(view).toMatchObject({cycle: null, product: null, timeline: null, slider: null, daysToHarvest: null, ndvi: null, health: null, harvestPrice: null, scenes: [], priceTrack: []});
    expect(view.weatherTrack.map((d) => d.date)).toEqual(eachDate(plus(TODAY, -7), plus(TODAY, 14)));
    expect(new Set(view.weatherTrack.map((d) => d.kind))).toEqual(new Set(['observed', 'forecast', 'typical']));
    expect(view.alerts.map((a) => a.title)).toEqual(['Pest window for the area']);
    expect(view.upcoming.map((s) => s.kind)).toEqual(['alert_step']);
    expect(view.limitations).toContain('This farm has no current crop cycle.');
    expect(ndvi).not.toHaveBeenCalled();
    expect(outlook).not.toHaveBeenCalled();
    // sliderWindowDays widens the no-cycle weather window.
    const wide = await todayView(deps, ownerId, emptyFarmId, {sliderWindowDays: 30});
    expect(wide.weatherTrack.at(-1)!.date).toBe(plus(TODAY, 30));
  });

  it('owner isolation: a foreign farm is a 404 and its data never leaks into another owner view', async () => {
    await expect(todayView(liveDeps(), strangerId, farmId)).rejects.toBeInstanceOf(ApiError);
    await expect(todayView(liveDeps(), strangerId, farmId)).rejects.toMatchObject({statusCode: 404});
    const strangerFarm = (await h.pool.query<{id: string}>('SELECT id FROM farms WHERE owner_id=$1', [strangerId])).rows[0]!.id;
    const own = TodayView.parse(await todayView(liveDeps(), strangerId, strangerFarm));
    expect(own).toMatchObject({farmId: strangerFarm, cycle: null, alerts: [], scenes: []});
    expect(JSON.stringify(own)).not.toContain(farmId);
  });

  it('synthetic and replay modes make no network call and show no satellite scenes or illustrations', async () => {
    for (const mode of ['synthetic', 'replay'] as const) {
      const spy = fetchSpy();
      const reached: string[] = [];
      const record = async (url: string): Promise<never> => { reached.push(url); throw new Error('network disabled in tests'); };
      const view = TodayView.parse(await todayView({config: {RUNTIME_MODE: mode}, pool: h.pool, now: () => NOW, sentinelFetch: record, weatherFetch: record}, ownerId, farmId));
      expect(reached, mode).toEqual([]);
      expect(spy, mode).not.toHaveBeenCalled();
      expect(view.ndvi, mode).toMatchObject({status: 'unavailable', reason: 'live_mode_required'});
      expect(view.scenes, mode).toEqual([]); // the ready illustration row is live-only
      expect(view.timeline, mode).toEqual(expectedTimeline());
      // No synthetic or replay price rows exist here, so the honest answer is "no series", not a number.
      expect(view.harvestPrice, mode).toMatchObject({status: 'insufficient', reason: 'price_history_not_ingested'});
      expect(view.priceTrack, mode).toEqual([]);
      expect(view.alerts, mode).toEqual([]); // the stored alerts are live-mode rows
      vi.restoreAllMocks();
    }
  });

  it('a long cycle is bounded: at most 40 weekly outlooks, later weeks left out with a stated limitation', async () => {
    const caneFarm = await createFarm(owner, 'Hassan sugarcane');
    const cane = {id: 'cycle-cane', cropId: 'sugarcane', cropName: 'Sugarcane', productId: 'sugarcane-cane', sowingDate: '2026-10-15', establishmentDate: '2026-10-15', establishmentMethod: 'sett_planting', stage: 'growing'};
    const put = await owner.call('PUT', `/api/v1/farms/${caneFarm}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [cane], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const calls: PriceCalls = {series: [], outlook: []};
    const view = TodayView.parse(await todayView(liveDeps({calls, scenes: []}), ownerId, caneFarm));
    const mondays: string[] = [];
    for (let m = plus(mondayOf(TODAY), 7); m <= view.slider!.to; m = plus(m, 7)) mondays.push(m);
    expect(new Set(mondays.map(bucketOf)).size).toBeGreaterThan(MAX_OUTLOOK_CALLS); // fixture sanity: the bound must bite
    expect(calls.outlook).toHaveLength(MAX_OUTLOOK_CALLS);
    expect(new Set(calls.outlook.map((a) => bucketOf(a.harvestDate))).size).toBe(MAX_OUTLOOK_CALLS);
    // Every Monday whose ISO-week outlook was computed is priced (2026-W53 shares the W52 outlook), nearer weeks first.
    const called = new Set(calls.outlook.map((a) => bucketOf(a.harvestDate)));
    const refs = view.priceTrack.filter((p) => p.kind === 'reference');
    expect(refs.map((p) => p.date)).toEqual(mondays.filter((m) => called.has(bucketOf(m))));
    const omitted = mondays.filter((m) => !called.has(bucketOf(m)));
    expect(omitted.length).toBeGreaterThan(0);
    const firstOmitted = mondays.indexOf(omitted[0]!);
    expect(refs.slice(0, firstOmitted).map((p) => p.date)).toEqual(mondays.slice(0, firstOmitted));
    expect(view.limitations.join(' ')).toMatch(new RegExp(`${omitted.length} later weeks? (are|is) not priced: at most ${MAX_OUTLOOK_CALLS}`));
    expect(view.weatherTrack.length).toBe(dayDiff('2026-10-15', view.slider!.to) + 1);
  });

  it('boundedWindow keeps today inside a window of at most the given length', () => {
    expect(boundedWindow('2026-01-01', '2026-01-10', '2026-01-05', 400)).toEqual({from: '2026-01-01', to: '2026-01-10', clipped: false});
    const w = boundedWindow('2025-01-01', '2027-12-31', '2026-06-01', 400);
    expect(dayDiff(w.from, w.to) + 1).toBe(400);
    expect(w.from <= '2026-06-01' && '2026-06-01' <= w.to && w.clipped).toBe(true);
    expect(boundedWindow('2025-01-01', '2027-12-31', '2027-12-30', 400).to).toBe('2027-12-31');
  });
});

describe('GET /api/v1/farms/:id/today', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await h.make({RUNTIME_MODE: 'live'});
    const deps = liveDeps();
    await app.register(todayRoutes, {...deps, config: testConfig({RUNTIME_MODE: 'live'}), pool: h.pool});
  });
  const get = (c: Client | null, id: string) => app.inject({method: 'GET', url: `/api/v1/farms/${id}/today`, headers: {origin: ORIGIN, ...(c ? {cookie: c.cookie} : {})}});

  it('returns the owner view in the envelope, private and uncached', async () => {
    const spy = fetchSpy();
    const res = await get(owner, farmId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json();
    expect(body).toMatchObject({mode: 'live', error: null});
    const view = TodayView.parse(body.data);
    expect(view.cycle?.id).toBe('cycle-maize');
    expect(view.upcoming.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires a session and never serves another owner farm', async () => {
    expect((await get(null, farmId)).statusCode).toBe(401);
    const foreign = await get(stranger, farmId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain('cycle-maize');
    expect((await get(owner, 'not-a-uuid')).statusCode).toBe(400);
  });
});
