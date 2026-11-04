import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {IndexStageReading, StageTimeline, TodayView, type FarmWorkspace, type UpcomingStep} from '@harvest/contracts';
import {setupHarness, login, testConfig, ORIGIN, type Harness, type Client} from './helpers';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {AT_STAGE_DAYS, MAX_OUTLOOK_CALLS, boundedWindow, matchStage, orderSteps, pickNextAction, referenceCareSteps, regionPrefix, stageCheckSteps, todayView, type StepLocation, type TodayProviders, type TodayViewDeps} from '../src/services/today/view';
import {careSchedule} from '../src/services/command-center';
import {stageAt, stageTimeline} from '../src/services/today/stage-timeline';
import {persistAlerts, type AlertDraft} from '../src/services/today/alerts';
import {focusedResearch, type FocusedResearch} from '../src/services/focused-crops';
import {PRICE_OUTLOOK_METHOD, type HarvestPriceOutlook, type HarvestPriceOutlookArgs, type PriceBucket, type PriceScope, type PriceSeries, type PriceSeriesArgs} from '../src/services/price-series';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';
import {eachDate} from '../src/plans/weather';
import {isoWeek} from '../src/plans/adapters/market-outlook';
import {ApiError, notFound} from '../src/services/errors';
import {CarbonFootprint, EnergyFootprint, HarvestEconomics, ResidueIncome, TodayOverview} from '@harvest/contracts';
import {gateOverview} from '../src/services/today/overview';
import {fieldImageBbox, fieldScenePaths} from '../src/services/today/ndvi';
import {FieldConditions} from '@harvest/contracts';
import * as footprintData from '../src/services/today/footprint-data';

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
    // Index stage: three clear scenes in the reader window are too few; the reason is a limitation, the timeline is untouched.
    expect(view.indexStage).toMatchObject({status: 'insufficient', reason: 'too_few_clear_scenes', readingsUsed: 3, asOf: '2026-10-27', phase: 'unknown'});
    expect(view.limitations).toContain('The satellite greenness curve is not read beside the stage estimate (too_few_clear_scenes).');

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
    const rank = {overdue: 0, due: 1, upcoming: 2, completed: 3} as const;
    expect(view.upcoming.map((s) => rank[s.status])).toEqual([...view.upcoming.map((s) => rank[s.status])].sort());
    // Next action: care tasks and alert steps first, then due before upcoming, then the earlier start (the alert step).
    expect(view.nextAction).toMatchObject({kind: 'alert_step', status: 'due', dueFrom: '2026-10-28'});
    expect(view.upcoming.find((s) => s.id === view.nextAction!.id)).toEqual(view.nextAction);
    expect(view.upcoming.some(s => s.fieldCheck?.kind === 'interval')).toBe(false);
    // Outlook note: live mode queues the job for these facts; the facts carry the card's range.
    expect(view.outlookNote).toMatchObject({status: 'pending', text: null, origin: null});
    expect(view.outlookNote!.facts[1]).toBe(`Likely price in the harvest weeks: ₹${refP50(mid) - 4} to ₹${refP50(mid) + 5} per kg (middle half of past years), typical ₹${refP50(mid)} per kg`);
    expect(view.outlookNote!.facts).toContain('Harvest weeks usually run close to the yearly average price');
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

  it('weather depth: a track day whose source day has agro carries it into TodayView.weatherTrack (contract-valid); a day without stays without the key', async () => {
    fetchSpy();
    const agro = {et0Mm: 3.4, rhMeanPct: 81, rhMinPct: 55, rhMaxPct: 96, dewPointC: 19.5, vpdMaxKpa: 1.1, windMaxKmh: 15, gustMaxKmh: 33, soilMoisture0to7: 0.31, soilTemp0to7C: 24, leafWetnessPct: 58, sunshineHours: 7.2, rainHours: 2, rainProbabilityPct: 40};
    const base = fakeWeather();
    const weatherSource: WeatherSource = {
      ...base,
      getForecast: async (...args) => {
        const f = (await base.getForecast(...args))!;
        return {...f, days: f.days.map((d) => (d.date === TODAY ? {...d, agro} : d))};
      },
    };
    const view = TodayView.parse(await todayView(liveDeps({providers: {weatherSource}}), ownerId, farmId));
    expect(view.weatherTrack.find((d) => d.date === TODAY)!.agro).toEqual({...agro, basis: 'grid_model_estimate'});
    const next = view.weatherTrack.find((d) => d.date === plus(TODAY, 1))!;
    expect(next.kind).toBe('forecast');
    expect('agro' in next).toBe(false);
    expect(view.weatherTrack.filter((d) => d.agro).map((d) => d.date)).toEqual([TODAY]);
  });

  it('a provider failure degrades only its section and says so; a vanished farm is still a 404', async () => {
    const boom = async (): Promise<never> => { throw new Error('upstream exploded with secret detail'); };
    const deps = liveDeps({providers: {ndviSeries: boom, harvestPriceOutlook: boom, weatherSource: fakeWeather({fail: true})}});
    const view = TodayView.parse(await todayView(deps, ownerId, farmId));
    expect(view.ndvi).toBeNull();
    expect(view.health).toBeNull();
    expect(view.indexStage).toMatchObject({status: 'unavailable', reason: 'satellite_readings_unavailable', asOf: null});
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

  it('reads the field NDVI curve beside the calendar stage when enough clear scenes exist, without moving the timeline', async () => {
    const curveFarm = await createFarm(owner, 'Hassan maize curve');
    const put = await owner.call('PUT', `/api/v1/farms/${curveFarm}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles: [maizeCycle], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    // Synthetic green-up: bare before sowing, greening through October; one cloudy scene in between.
    const greening: [string, number][] = [['2026-08-10', 0.22], ['2026-08-25', 0.21], ['2026-09-09', 0.24], ['2026-09-19', 0.33], ['2026-09-29', 0.45], ['2026-10-09', 0.58], ['2026-10-19', 0.66], ['2026-10-29', 0.72]];
    const scenes = [...greening.map(([d, v]) => scene(d, {ndvi: v}, {ndvi: 0.5})), scene('2026-10-14', 'cloudy', {ndvi: 0.5})];
    const view = TodayView.parse(await todayView(liveDeps({scenes}), ownerId, curveFarm));
    const reading = IndexStageReading.parse(view.indexStage);
    const expected = expectedTimeline();
    expect(view.timeline).toEqual(expected); // evidence only: the calendar estimate is unchanged
    expect(reading).toMatchObject({status: 'available', reason: null, asOf: '2026-10-29', readingsUsed: greening.length, phase: 'rising', agreement: 'consistent'});
    expect(reading.window).toEqual({from: view.ndvi!.window.from, to: view.today}); // never earlier than the fetched series
    const stage = expected.stages.filter((s) => s.from <= '2026-10-29' && '2026-10-29' <= s.to).at(-1)!;
    expect(reading.calendarStage).toEqual({id: stage.id, name: stage.name, from: stage.from, to: stage.to});
    expect(reading.greenUpDate! > '2026-09-01' && reading.greenUpDate! <= '2026-10-29').toBe(true);
    expect(reading.basis).toMatchObject({kind: 'ndvi', sourceId: 'index-stage-reader-v1', scope: 'drawn field boundary'});
    expect(reading.summary).toMatch(/^Satellite greenness has been rising since the green-up on .*, so the curve and the calendar agree\.$/);
    expect(view.limitations.join(' ')).not.toMatch(/satellite greenness curve is not read/);
  });
});

describe('todayView: edges', () => {
  it('no current cycle: null cycle and timeline, no satellite or price, but weather and alerts are present', async () => {
    const ndvi = vi.fn(), outlook = vi.fn();
    const deps = liveDeps({providers: {ndviSeries: ndvi as unknown as TodayProviders['ndviSeries'], harvestPriceOutlook: outlook as unknown as TodayProviders['harvestPriceOutlook']}});
    const view = TodayView.parse(await todayView(deps, ownerId, emptyFarmId));
    expect(view).toMatchObject({cycle: null, product: null, timeline: null, slider: null, daysToHarvest: null, ndvi: null, health: null, harvestPrice: null, scenes: [], priceTrack: [], indexStage: null});
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
      expect(view.indexStage, mode).toMatchObject({status: 'unavailable', reason: 'live_mode_required'});
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
    app = await h.make({RUNTIME_MODE: 'live'}, {today: {view: liveDeps()}});
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

// ------------------------------------------------------------------ upcoming steps v2 (ROUND2_SPEC.md 2.1)

type Cycle = FarmWorkspace['cycles'][number];
type CareItem = FocusedResearch['crops'][number]['care'][number];
const HASSAN_LOC: StepLocation = {stateId: 'IN-KA', districtId: 'IN-KA-hassan', districtName: 'Hassan'};
const stageItem = (id: string, title: string, stage: string | null, geographyIds = ['IN-KA']): CareItem => ({
  id, title, action: `${title} (synthetic test guidance).`, anchor: 'observed_stage', startDay: 0, endDay: 0, repeatEveryDays: null, stage, conditions: [],
  sourceRefs: [{sourceId: 'synthetic-test', locator: 'n/a'}], establishmentMethods: ['direct_sowing'], geographyIds,
});
const step = (o: Partial<UpcomingStep> & Pick<UpcomingStep, 'id' | 'kind' | 'status' | 'dueFrom'>): UpcomingStep => ({title: o.id, detail: null, dueTo: o.dueFrom, careTask: null, alertId: null, ...o});

describe('upcoming steps v2: stage matching (substring, keyword, fallback)', () => {
  const maize = () => expectedTimeline(); // initial, development, mid_season, late_season (FAO split)
  const ginger = () => stageTimeline({cropId: 'ginger', productId: null, establishmentMethod: 'rhizome_planting', anchorDate: '2026-05-01', stateId: 'IN-KA', districtId: 'IN-KA-hassan'});

  it('substring in either direction against the stage name or id', () => {
    expect(maize().stages.map((s) => s.id)).toEqual(['initial', 'development', 'mid_season', 'late_season']); // fixture sanity
    expect(matchStage('mid_season', maize())).toMatchObject({stage: {id: 'mid_season'}, rule: 'substring'});
    expect(matchStage('Crop development', maize())).toMatchObject({stage: {id: 'development'}, rule: 'substring'});
    expect(matchStage('late season grain fill', maize())).toMatchObject({stage: {id: 'late_season'}, rule: 'substring'}); // stage text inside the guidance
    expect(matchStage('rhizome_initiation', ginger())).toMatchObject({stage: {id: 'rhizome_initiation'}, rule: 'substring'});
  });

  it('keyword table: flowering -> mid-season, maturity -> late season, tillering or establishment -> development (else initial)', () => {
    expect(matchStage('flowering', maize())).toMatchObject({stage: {id: 'mid_season'}, rule: 'keyword'});
    expect(matchStage('heading', maize())).toMatchObject({stage: {id: 'mid_season'}, rule: 'keyword'});
    expect(matchStage('grain_maturity', maize())).toMatchObject({stage: {id: 'late_season'}, rule: 'keyword'});
    expect(matchStage('active_tillering', maize())).toMatchObject({stage: {id: 'development'}, rule: 'keyword'});
    // Ginger in Hassan uses the sourced catalogue stages: maturity -> "Maturation", establishment -> the vegetative stage.
    expect(matchStage('rhizome_maturity', ginger())).toMatchObject({stage: {id: 'maturation'}, rule: 'keyword'});
    expect(matchStage('established', ginger())).toMatchObject({stage: {id: 'sprouting_vegetative'}, rule: 'keyword'});
    // Seedling, emergence, transplant -> initial.
    expect(matchStage('seedling vigour', {stages: [{id: 'initial', name: 'Initial', from: '2026-01-01', to: '2026-01-20', basis: 'estimate'}]})).toMatchObject({stage: {id: 'initial'}, rule: 'keyword'});
  });

  it('orchestrator keyword table: reproductive stages to mid-season, vegetative to development, emergence to initial, grain fill to late', () => {
    for (const stage of ['panicle_initiation', 'booting', 'heading', 'flowering', 'silking', 'tasselling', 'pod formation']) expect(matchStage(stage, maize()), stage).toMatchObject({stage: {id: 'mid_season'}, rule: 'keyword'});
    for (const stage of ['tillering', 'vegetative growth', 'branching']) expect(matchStage(stage, maize()), stage).toMatchObject({stage: {id: 'development'}, rule: 'keyword'});
    for (const stage of ['germination', 'emergence', 'seedling', 'establishment', 'after transplant']) expect(matchStage(stage, maize()), stage).toMatchObject({stage: {id: 'initial'}, rule: 'keyword'});
    for (const stage of ['grain fill', 'milk stage', 'dough', 'maturity', 'ripening', 'harvest readiness']) expect(matchStage(stage, maize()), stage).toMatchObject({stage: {id: 'late_season'}, rule: 'keyword'});
  });

  it('no match: null (the caller windows it to the rest of the season)', () => {
    expect(matchStage('height_1m', maize())).toBeNull();
    expect(matchStage('first_leaf_ready', maize())).toBeNull();
    expect(matchStage('flowering', {stages: [{id: 'growing', name: 'Growing', from: '2026-01-01', to: '2026-03-01', basis: 'estimate'}, {id: 'maturing', name: 'Maturing', from: '2026-03-01', to: '2026-04-01', basis: 'estimate'}]})).toBeNull();
    expect(matchStage('', maize())).toBeNull();
    expect(matchStage(null, maize())).toBeNull();
  });
});

describe('upcoming steps v2: stage checks and other-region references', () => {
  const cycle = maizeCycle as Cycle;

  it('stage checks: matched stage window, rest-of-season fallback, other-region prefix, never completable', async () => {
    const real = await focusedResearch();
    const crop = {...real.crops.find((c) => c.cropId === 'maize')!, care: [
      stageItem('c-flower', 'Water check at flowering', 'flowering'),
      stageItem('c-height', 'Train branches at observed height', 'height_1m'),
      stageItem('c-mature', 'Check grain maturity', 'grain_maturity', ['IN-GA']),
      stageItem('c-panicle', 'Review nutrients at panicle initiation', 'panicle_initiation'),
    ]};
    const tl = expectedTimeline();
    const mid = tl.stages.find((s) => s.id === 'mid_season')!, late = tl.stages.find((s) => s.id === 'late_season')!;
    const {steps, undated} = stageCheckSteps({crop, cycle, timeline: tl, today: TODAY, location: HASSAN_LOC, sources: real.sources});
    expect(undated).toBe(0);
    expect(steps.map((s) => [s.kind, s.title, s.dueFrom, s.dueTo])).toEqual([
      // "at <stage>": the first 14 days of the matched stage.
      ['stage_check', 'Check: Water check at flowering', mid.from, plus(mid.from, AT_STAGE_DAYS - 1) < mid.to ? plus(mid.from, AT_STAGE_DAYS - 1) : mid.to],
      ['stage_check', 'Check: Train branches at observed height', TODAY, tl.harvest!.latest],
      ['stage_check', 'Check: Check grain maturity', late.from, late.to], // not phrased "at": the whole stage
      ['stage_check', 'Check: Review nutrients at panicle initiation', mid.from, plus(mid.from, AT_STAGE_DAYS - 1) < mid.to ? plus(mid.from, AT_STAGE_DAYS - 1) : mid.to],
    ]);
    expect(dayDiff(steps[0]!.dueFrom, steps[0]!.dueTo)).toBe(AT_STAGE_DAYS - 1); // fixture sanity: the stage is longer than 14 days
    expect(steps[3]!.status).toBe(mid.from > TODAY ? 'upcoming' : 'due');
    expect(steps[0]!.detail).toMatch(/^Dated from the calendar estimate of the start of the Mid-season stage; check the actual crop stage first\. Water check at flowering/);
    expect(steps[1]!.detail).toMatch(/^Any time this season\. Train branches/);
    expect(steps[2]!.detail).toMatch(/^Guidance from Goa sources \(no local schedule for Hassan\)\. Dated from the calendar estimate of the Late season stage/);
    expect(steps.every((s) => s.careTask === null && s.alertId === null)).toBe(true);
    expect(steps[0]!.status).toBe(mid.from <= TODAY && TODAY <= mid.to ? 'due' : mid.from > TODAY ? 'upcoming' : 'overdue');
    // Without a timeline nothing can be dated.
    expect(stageCheckSteps({crop, cycle, timeline: null, today: TODAY, location: HASSAN_LOC})).toEqual({steps: [], undated: 4, itemIds: []});
    // A matched check whose window starts later is upcoming and never the next action over a due care task.
    const due = step({id: 'care-due', kind: 'care_task', status: 'due', dueFrom: '2026-10-31', dueTo: '2026-11-06'});
    expect(pickNextAction([steps[3]!, due])?.id).toBe('care-due');
  });

  it('references from Tamil Nadu are dated on the sowing date with the prefix and the source, only without a local schedule', async () => {
    const real = await focusedResearch();
    const crop = real.crops.find((c) => c.cropId === 'maize')!;
    expect(new Set(crop.care.flatMap((c) => c.geographyIds))).toEqual(new Set(['IN-TN'])); // fixture sanity: no Karnataka maize schedule
    const sown = {...cycle, sowingDate: '2026-10-20', establishmentDate: '2026-10-20'};
    const schedule = careSchedule(sown, crop, TODAY, [], {stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
    expect(schedule.careTasks).toEqual([]);
    const steps = referenceCareSteps({schedule, crop, cycle: sown, today: TODAY, location: HASSAN_LOC, sources: real.sources});
    expect(steps.map((s) => [s.title, s.dueFrom, s.dueTo, s.status])).toEqual([
      ['Check stand and thin doubles', '2026-11-01', '2026-11-04', 'due'],
      ['First manual weed check', '2026-11-06', '2026-11-07', 'upcoming'],
      ['Weed and restore ridges', '2026-11-19', '2026-11-19', 'upcoming'],
      ['Protect flowering moisture', '2026-12-04', '2026-12-24', 'upcoming'],
    ]);
    for (const s of steps) {
      expect(s.kind).toBe('care_task');
      expect(s.careTask).toBeNull();
      expect(s.detail!.startsWith('Guidance from Tamil Nadu sources (no local schedule for Hassan).')).toBe(true);
      expect(s.detail).toMatch(/Source: Tamil Nadu Agricultural University \(/);
    }
    expect(steps[0]!.detail).toContain('Source: Tamil Nadu Agricultural University (Thinning and gap filling).');
    // A matched local schedule keeps the references undated.
    const local = {...crop, care: crop.care.map((c) => ({...c, geographyIds: ['IN-KA']}))};
    const localSchedule = careSchedule(sown, local, TODAY, [], {stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
    expect(localSchedule.careTasks.length).toBeGreaterThan(0);
    expect(referenceCareSteps({schedule: localSchedule, crop: local, cycle: sown, today: TODAY, location: HASSAN_LOC})).toEqual([]);
    expect(regionPrefix(['IN-TN', 'IN-KA-mysuru'], {stateId: 'IN-GA', districtId: null, districtName: null})).toBe('Guidance from Tamil Nadu and Karnataka sources (no local schedule for this district).');
    expect(regionPrefix(['IN'], HASSAN_LOC)).toBeNull();
  });
});

describe('upcoming steps v2: next action and order', () => {
  it('care tasks and alert steps come first as a tier; then overdue, due, upcoming; then the earlier start', () => {
    const overdueCheck = step({id: 'check-overdue', kind: 'stage_check', status: 'overdue', dueFrom: '2026-10-20', dueTo: '2026-10-25'});
    const dueAnyTime = step({id: 'check-season', kind: 'stage_check', status: 'due', dueFrom: TODAY, dueTo: '2027-01-30'});
    const transition = step({id: 'transition', kind: 'stage_transition', status: 'upcoming', dueFrom: '2026-11-03'});
    const careLater = step({id: 'care-later', kind: 'care_task', status: 'upcoming', dueFrom: '2026-11-09', dueTo: '2026-11-12'});
    const careSoon = step({id: 'care-soon', kind: 'care_task', status: 'upcoming', dueFrom: '2026-11-05', dueTo: '2026-11-06'});
    const alertDue = step({id: 'alert-due', kind: 'alert_step', status: 'due', dueFrom: '2026-10-30', dueTo: '2026-11-10'});
    const careOverdue = step({id: 'care-overdue', kind: 'care_task', status: 'overdue', dueFrom: '2026-10-25', dueTo: '2026-10-28'});
    const careDone = step({id: 'care-done', kind: 'care_task', status: 'completed', dueFrom: '2026-10-01'});

    expect(pickNextAction([overdueCheck, dueAnyTime, transition, careLater, careSoon])?.id).toBe('check-overdue'); // an overdue check precedes future care
    expect(pickNextAction([careLater, careSoon, alertDue])?.id).toBe('alert-due'); // due beats upcoming
    expect(pickNextAction([careLater, alertDue, careOverdue])?.id).toBe('care-overdue'); // overdue beats due
    expect(pickNextAction([overdueCheck, dueAnyTime, transition])?.id).toBe('check-overdue'); // no care or alert step
    expect(pickNextAction([careDone])).toBeNull();
    expect(pickNextAction([])).toBeNull();

    expect(orderSteps([careDone, careLater, transition, dueAnyTime, alertDue, overdueCheck, careOverdue, careSoon]).map((s) => s.id)).toEqual([
      'check-overdue', 'care-overdue', 'alert-due', 'check-season', 'transition', 'care-soon', 'care-later', 'care-done',
    ]);
  });
});

describe('todayView: Hassan maize with Tamil Nadu guidance only (real focused research)', () => {
  it('lists dated reference steps with the prefix, a next action with a window, and says they cannot be marked done', async () => {
    const real = await focusedResearch();
    const farm = await createFarm(owner, 'Hassan maize, TN guidance');
    const cycle = {...maizeCycle, id: 'cycle-maize-tn', sowingDate: '2026-10-20', establishmentDate: '2026-10-20'};
    const put = await owner.call('PUT', `/api/v1/farms/${farm}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles: [cycle], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const view = TodayView.parse(await todayView(liveDeps({scenes: [], providers: {focusedResearch: async () => real}}), ownerId, farm));
    const refs = view.upcoming.filter((s) => s.id.startsWith('ref:'));
    expect(refs.map((s) => [s.title, s.dueFrom, s.dueTo])).toEqual([
      ['Check stand and thin doubles', '2026-11-01', '2026-11-04'],
      ['First manual weed check', '2026-11-06', '2026-11-07'],
    ]); // 'Weed and restore ridges' (19 Nov) and the flowering window start beyond 14 days
    expect(refs.every((s) => s.kind === 'care_task' && s.careTask === null && s.detail!.startsWith('Guidance from Tamil Nadu sources (no local schedule for Hassan).'))).toBe(true);
    expect(view.nextAction).toMatchObject({title: 'Check stand and thin doubles', dueFrom: '2026-11-01', dueTo: '2026-11-04', status: 'due', careTask: null});
    expect(view.upcoming.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.dueFrom) && /^\d{4}-\d{2}-\d{2}$/.test(s.dueTo))).toBe(true);
    const notes = view.limitations.join(' ');
    expect(notes).toMatch(/No care schedule for Hassan is sourced for this crop/);
    expect(notes).toMatch(/cannot be marked done here: the completion endpoint accepts only care actions scheduled for this field's region/);
    expect(notes).toMatch(/2 later guidance steps appear when their window is within 14 days/);
    expect(notes).not.toMatch(/not dated for this field/);
    expect(view.outlookNote?.status).toBe('pending');
  });
});

// ------------------------------------------------------------------ economics and footprint (TODAY_ECONOMICS_FOOTPRINT_SPEC.md)

/**
 * SYNTHETIC footprint fixture of the section 5 shape for the maize case (invented numbers, not research values), injected
 * through footprint-data invalidate(). Yields and costs come from the year-plan research files as in production; prices are
 * the fake outlook above.
 */
const r2 = (low: number, high: number, extra: Record<string, unknown> = {}) => ({low, high, sourceId: 'SYN-FP', locator: 'Table S1', ...extra});
const MAIZE_FOOTPRINT = {
  constants: {
    gwp100: {ch4: 27, n2o: 273, sourceId: 'SYN-GWP'}, n2oNToN2o: {value: 1.5714}, cToCo2: {value: 3.6667}, biomassCarbonFraction: r2(0.47, 0.47),
    n2oEf1: {default: {low: 0.002, central: 0.01, high: 0.018}, floodedRice: {low: 0.001, central: 0.004, high: 0.029}, sourceId: 'SYN-IPCC'},
    residueBurning: {ch4GPerKgDm: 2.7, n2oGPerKgDm: 0.07, combustionFactor: {low: 0.8, high: 0.9}, sourceId: 'SYN-IPCC'},
    lpgMjPerKg: {value: 45.8, sourceId: 'SYN-LPG'}, lpgCylinderKg: {value: 14.2, sourceId: 'SYN-LPG'}, dieselMjPerLitre: {value: 36, sourceId: 'SYN-LPG'},
  },
  crops: [{
    cropId: 'maize',
    residue: {
      name: 'maize stover', productBasis: 'maize-grain', rpr: r2(1.5, 2), surplusFraction: [r2(0.3, 0.4, {region: 'IN-KA'})], calorificValueMJPerKg: r2(16, 17),
      uses: [{use: 'dry_fodder', label: 'Dry fodder for cattle', share: null, priceInrPerTonne: r2(2000, 3000), priceBasis: 'Synthetic fodder market, 2025', sourceId: 'SYN-FP'}],
    },
    nitrogenRateKgPerHa: [r2(150, 150, {region: 'IN-KA'})], energyInput: {gjPerHa: {low: 20, high: 30}, region: 'Synthetic', sourceId: 'SYN-FP', breakdown: []},
    methane: {applies: false},
  }],
  sources: {},
};

describe('todayView: expected profit, residue income, energy and carbon (synthetic footprint fixture)', () => {
  afterEach(() => footprintData.invalidate());
  let areaFarm: string, noAreaFarm: string;
  // No drawn boundary (a boundary would set the area from its own geometry): the recorded 1.2 ha, or no area at all.
  const maizeFarm = async (name: string, areaHectares?: number) => {
    const res = await owner.call('POST', '/api/v1/farms', {payload: {name, location: HASSAN, ...(areaHectares ? {areaHectares} : {})}});
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [maizeCycle], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    return id;
  };
  beforeAll(async () => {
    areaFarm = await maizeFarm('Hassan maize 1.2 ha', 1.2);
    noAreaFarm = await maizeFarm('Hassan maize, area not recorded');
  });

  it('the four blocks are present and contract-valid for the maize case; the profit is for the harvest midpoint the price is for', async () => {
    footprintData.invalidate(structuredClone(MAIZE_FOOTPRINT));
    const spy = fetchSpy();
    const calls: PriceCalls = {series: [], outlook: []};
    const view = TodayView.parse(await todayView(liveDeps({calls, scenes: []}), ownerId, areaFarm));
    const harvest = expectedTimeline().harvest!;
    const econ = HarvestEconomics.parse(view.harvestEconomics);
    const mid = plus(harvest.earliest, Math.floor(dayDiff(harvest.earliest, harvest.latest) / 2));
    expect(econ).toMatchObject({status: 'available', harvest, harvestDate: mid, fieldAreaHa: 1.2});
    expect(econ.price).toMatchObject({status: 'available', p50: refP50(mid), likely: {low: refP50(mid) - 4, high: refP50(mid) + 5}});
    expect(econ.price!.scopeLabel).toBe(view.harvestPrice!.scopeLabel);
    expect(econ.profitForField).not.toBeNull();
    expect(econ.yieldForFieldKg).toEqual({low: Math.round(econ.yieldKgPerHa!.low * 1.2), high: Math.round(econ.yieldKgPerHa!.high * 1.2)});
    // The price headline is not fetched again for the economics: only the slider's weekly references and the headline.
    expect(calls.outlook.filter((c) => c.harvestDate === mid)).toHaveLength(1);

    const residue = ResidueIncome.parse(view.residueIncome);
    expect(residue).toMatchObject({status: 'available', residueName: 'maize stover', surplusFraction: {low: 0.3, high: 0.4}});
    expect(residue.residueForFieldKg).toEqual({low: Math.round(econ.yieldForFieldKg!.low * 1.5), high: Math.round(econ.yieldForFieldKg!.high * 2)});
    const energy = EnergyFootprint.parse(view.energyFootprint);
    expect(energy).toMatchObject({status: 'available', inputEnergyGJForField: {low: 24, high: 36}});
    const carbon = CarbonFootprint.parse(view.carbonFootprint);
    // 150 kg N x EF1 default 0.002 to 0.018 x 1.5714 x 273 / 1000 = 0.1287 to 1.1583 t/ha; x 1.2 ha = 0.15444 -> 0.15 and 1.38996 -> 1.39.
    expect(carbon).toMatchObject({status: 'available', fieldAreaHa: 1.2, emissionsForField: {low: 0.15, high: 1.39}, comparison: null});
    expect(carbon.residueScenarios.map((s) => s.id)).toEqual(['burn', 'incorporate', 'sell_fodder']);
    // Each block's limitations are in the view's list, once.
    for (const line of ['Options are alternatives for the same residue and do not add up.', 'Residue scenarios are alternatives; only one happens.', ...econ.limitations]) {
      expect(view.limitations.filter((l) => l === line)).toHaveLength(1);
    }
    expect(view.limitations.join(' ')).not.toMatch(/could not be read now/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('an unreadable footprint file leaves residue, energy and carbon null with a limitation; the profit is still shown', async () => {
    footprintData.invalidate('not the section 5 shape');
    const view = TodayView.parse(await todayView(liveDeps({scenes: []}), ownerId, areaFarm));
    expect(view.harvestEconomics?.status).toBe('available');
    expect(view.residueIncome).toBeNull();
    expect(view.energyFootprint).toBeNull();
    expect(view.carbonFootprint).toBeNull();
    for (const section of ['The residue income', 'The energy footprint', 'The carbon footprint']) {
      expect(view.limitations).toContain(`${section} could not be read now (internal_error); that part of the view is left empty.`);
    }
  });

  it('a farm without a crop has none of the four blocks; without an area the profit is per hectare and the residue needs the area', async () => {
    footprintData.invalidate(structuredClone(MAIZE_FOOTPRINT));
    const empty = TodayView.parse(await todayView(liveDeps({scenes: []}), ownerId, emptyFarmId));
    expect([empty.harvestEconomics, empty.residueIncome, empty.energyFootprint, empty.carbonFootprint]).toEqual([null, null, null, null]);
    const noArea = TodayView.parse(await todayView(liveDeps({scenes: []}), ownerId, noAreaFarm));
    expect(noArea.harvestEconomics).toMatchObject({status: 'available', fieldAreaHa: null, profitForField: null});
    expect(noArea.harvestEconomics!.profitPerHa).not.toBeNull();
    expect(noArea.residueIncome).toMatchObject({status: 'unavailable', reason: 'yield_or_area_missing'});
    expect(noArea.carbonFootprint).toMatchObject({status: 'partial', reason: 'field_area_missing', emissionsForField: null});
  });
});

describe('todayView: the Today overview (spec section 9, synthetic mode)', () => {
  it('carries a contract-valid code-written overview whose facts point at real step and alert ids of the same view; no crop -> null', async () => {
    const farm = await owner.call('POST', '/api/v1/farms', {payload: {name: 'Hassan maize overview', location: HASSAN, areaHectares: 1.2}});
    expect(farm.statusCode, farm.body).toBe(201);
    const id = farm.json().data.id as string;
    const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [maizeCycle], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [alert('Fall armyworm scouting window')]);
    const spy = fetchSpy();
    const deps: TodayViewDeps = {...liveDeps({scenes: []}), config: {RUNTIME_MODE: 'synthetic'}};
    const view = TodayView.parse(await todayView(deps, ownerId, id));
    const overview = TodayOverview.parse(view.overview);
    expect(overview).toMatchObject({status: 'ready', origin: 'deterministic', modelInvocation: null});
    expect(overview.headline).toMatch(/^Maize, /);
    const stepIds = new Set([...view.upcoming.map((s) => s.id), ...(view.nextAction ? [view.nextAction.id] : [])]);
    const alertIds = new Set(view.alerts.map((a) => a.id));
    const refs = [...overview.facts.map((f) => f.ref), ...overview.points.map((p) => p.ref)].filter((r) => r !== null);
    expect(refs.some((r) => r.kind === 'step')).toBe(true);
    expect(refs.some((r) => r.kind === 'alert')).toBe(true);
    for (const r of refs) {
      if (r.kind === 'step') expect(stepIds.has(r.id), r.id).toBe(true);
      if (r.kind === 'alert') expect(alertIds.has(r.id), r.id).toBe(true);
    }
    expect(overview.facts.find((f) => f.id === 'next')!.ref).toEqual({kind: 'step', id: view.nextAction!.id});
    expect(overview.points[0]).toMatchObject({kind: 'do_now', factIds: ['next']});
    // The code-written overview passes the model gate against its own facts.
    expect(gateOverview({headline: overview.headline, points: overview.points.map(({kind, text, factIds}) => ({kind, text, factIds}))}, overview.facts).ok).toBe(true);
    // Synthetic mode: no overview row or job, no network.
    expect((await h.pool.query('SELECT 1 FROM farm_today_overviews WHERE farm_id=$1', [id])).rowCount).toBe(0);
    expect((await h.pool.query("SELECT 1 FROM jobs WHERE type='today.overview' AND payload->>'farmId'=$1", [id])).rowCount).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(view.limitations.join(' ')).not.toMatch(/Today overview/);
    const empty = TodayView.parse(await todayView(deps, ownerId, emptyFarmId));
    expect(empty.overview).toBeNull();
  });
});

describe('todayView: alerts across fields', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => ({type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][]});
  const FIELDS = [{id: 'west', name: 'West strip', boundary: rect(76.249, 13.2495, 76.2498, 13.2505)}, {id: 'east', name: 'East strip', boundary: rect(76.2498, 13.2495, 76.251, 13.2505)}];
  async function twoFieldFarm(name: string) {
    const id = await createFarm(owner, name);
    const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary: rect(76.249, 13.2495, 76.251, 13.2505), fields: FIELDS, previousHarvest: {status: 'unknown'}, rotationPlans: [],
      cycles: [{...maizeCycle, id: 'c-west', fieldId: 'west'}, {...maizeCycle, id: 'c-east', fieldId: 'east'}]}});
    expect(put.statusCode, put.body).toBe(200);
    return id;
  }
  const deps = (): TodayViewDeps & {fake: ReturnType<typeof fakePlanetary>} => ({...liveDeps({scenes: []}), config: {RUNTIME_MODE: 'synthetic'}});

  it('the All fields overview (no fieldId) lists every field\'s alerts, labelled by fieldId, and the per-field counts match the list', async () => {
    const id = await twoFieldFarm('Two fields, alerts');
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [{...alert('Armyworm window, east'), fieldId: 'east'}, alert('Farm-wide note')]);
    fetchSpy();
    const all = TodayView.parse(await todayView(deps(), ownerId, id));
    expect(all.alerts.map((a) => [a.title, a.fieldId ?? null]).sort()).toEqual([['Armyworm window, east', 'east'], ['Farm-wide note', null]]);
    expect(Object.fromEntries(all.fields!.map((f) => [f.id, f.alertCount]))).toEqual({west: 1, east: 2});
    // A request naming west lists only farm-wide ones; the counts of the other fields still see their own alert.
    const west = TodayView.parse(await todayView(deps(), ownerId, id, {fieldId: 'west'}));
    expect(west.alerts.map((a) => a.title)).toEqual(['Farm-wide note']);
    expect(Object.fromEntries(west.fields!.map((f) => [f.id, f.alertCount]))).toEqual({west: 1, east: 2});
    const east = TodayView.parse(await todayView(deps(), ownerId, id, {fieldId: 'east'}));
    expect(east.alerts.map((a) => a.title).sort()).toEqual(['Armyworm window, east', 'Farm-wide note']);
  });

  it('60 newer farm-wide alerts do not push a field\'s older alert out of its Today list', async () => {
    const id = await twoFieldFarm('Two fields, many alerts');
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [{...alert('Armyworm window, east'), fieldId: 'east'}]);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', Array.from({length: 60}, (_, i) => alert(`Farm-wide note ${i}`)));
    fetchSpy();
    const east = TodayView.parse(await todayView(deps(), ownerId, id, {fieldId: 'east'}));
    expect(east.alerts).toHaveLength(50); // the contract cap; the field's own alert is listed first
    expect(east.alerts[0]).toMatchObject({fieldId: 'east'});
    const all = TodayView.parse(await todayView(deps(), ownerId, id));
    expect(all.alerts).toHaveLength(50);
    expect(all.alerts.some((a) => a.fieldId === 'east')).toBe(false); // oldest of 61, beyond the cap: still counted below
    expect(all.fields!.find((f) => f.id === 'west')!.alertCount).toBe(60);
    expect(all.fields!.find((f) => f.id === 'east')!.alertCount).toBe(61);
  });
});

describe('todayView: daily field conditions and the field-zoom satellite view (spec section 10)', () => {
  it('one contract-valid condition point per slider day; observed scenes carry the field-zoom paths; the bbox follows the boundary', async () => {
    const spy = fetchSpy();
    const view = TodayView.parse(await todayView(liveDeps(), ownerId, farmId));
    const c = FieldConditions.parse(view.conditions);
    expect(c.points.map((p) => p.date)).toEqual(view.weatherTrack.map((w) => w.date));
    expect(c.points[0]!.date).toBe(view.slider!.from);
    expect(c.points.at(-1)!.date).toBe(view.slider!.to);
    for (const [k, p] of c.points.entries()) expect(p.kind).toBe(view.weatherTrack[k]!.kind);
    // Greenness is held from the latest usable reading (27 Oct, NDVI 0.70 vs 0.55: above typical) and null before the first.
    const today = c.points.find((p) => p.date === TODAY)!;
    expect(today.greenness).toMatchObject({observedOn: '2026-10-27', verdict: 'above_typical', daysSince: 5});
    expect(today.greenness.ndvi).toBeCloseTo(0.7, 2);
    expect(c.points.find((p) => p.date === SOWING)!.greenness).toMatchObject({observedOn: '2026-08-20'});
    // The live alert (28 Oct to 15 Nov) is an event on its days only.
    expect(today.events.map((e) => e.title)).toEqual(['Fall armyworm scouting window']);
    expect(c.points.find((p) => p.date === '2026-10-27')!.events).toEqual([]);
    expect(today.stage?.id).toBe(expectedTimeline().stages.filter((s) => s.from <= TODAY).at(-1)!.id);
    expect(c.limitations[0]).toMatch(/not seen on the field/);
    // Field-zoom paths on every observed scene, none on illustrations; the field window from the drawn boundary.
    const observed = view.scenes.filter((s) => s.kind === 'observed');
    expect(observed.length).toBeGreaterThan(0);
    for (const s of observed) expect({fieldImagePath: s.fieldImagePath, fieldNdviImagePath: s.fieldNdviImagePath}).toEqual(fieldScenePaths(farmId, s.itemId!));
    expect(observed[0]!.fieldImagePath).toMatch(/zoom=field/);
    expect(view.scenes.filter((s) => s.kind === 'illustration').every((s) => !s.fieldImagePath)).toBe(true);
    expect(view.fieldImageBbox).toEqual(fieldImageBbox(HA.coordinates[0] as [number, number][]));
    expect(spy).not.toHaveBeenCalled();
  });

  it('synthetic mode: conditions present without satellite readings (greenness null), no bbox without a boundary; no crop -> null', async () => {
    const farm = await owner.call('POST', '/api/v1/farms', {payload: {name: 'Hassan maize conditions', location: HASSAN}});
    const id = farm.json().data.id as string;
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [maizeCycle], rotationPlans: []}});
    const deps: TodayViewDeps = {...liveDeps({scenes: []}), config: {RUNTIME_MODE: 'synthetic'}};
    const view = TodayView.parse(await todayView(deps, ownerId, id));
    const c = FieldConditions.parse(view.conditions);
    expect(c.points).toHaveLength(view.weatherTrack.length);
    expect(c.points.every((p) => p.greenness.observedOn === null)).toBe(true);
    expect(view.fieldImageBbox).toBeNull();
    const empty = TodayView.parse(await todayView(deps, ownerId, emptyFarmId));
    expect(empty.conditions).toBeNull();
  });
});
