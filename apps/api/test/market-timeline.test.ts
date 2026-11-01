import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {MarketTimeline} from '@harvest/contracts';
import {SYNTHETIC_SOURCE_ID, ensureSource} from '../src/ingest/sources';
import {isoWeek} from '../src/plans/adapters/market-outlook';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';
import {eachDate} from '../src/plans/weather';
import {harvestPriceOutlook, isoWeekMonday, seasonalReferenceByWeek} from '../src/services/price-series';
import {
  ANALOGUE_LIMITATION, MAX_POINTS, SEASON_FETCHING_REASON, addMonths, cropYearOf, marketTimeline, monsoonTotals, mondayOf, priceMoves, rainSimilarity, weekRange, weeklyWeather,
  type MarketTimelineDeps,
} from '../src/services/market-timeline';
import {marketTimelineRoutes} from '../src/routes/market-timeline';
import {persistAlerts, type AlertDraft} from '../src/services/today/alerts';
import {stageTimeline} from '../src/services/today/stage-timeline';
import {login, setupHarness, type Client, type Harness} from './helpers';

/**
 * Every price, rain day, forecast, farm and alert in this file is SYNTHETIC test data (market rows: mode 'synthetic',
 * is_synthetic true, market ids prefixed synth-). Weather comes from an injected fake source; nothing reaches the network.
 * Expected values are computed from the same closed-form fixture formulas below, or by hand in comments.
 */
const NOW = new Date('2026-11-01T04:00:00Z'); // 09:30 IST on Sunday 2026-11-01
const TODAY = '2026-11-01';
const SOWING = '2026-09-01';
const HA = {type: 'Polygon', coordinates: [[[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]]]};
const HASSAN = {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'};
const KOLAR = {districtName: 'Kolar', stateId: 'IN-KA', precision: 'district'};
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------------ price fixture (one quote per market per ISO week, on Wednesday)
/** Hassan: 20 + 2 sin(2 pi week / 52); 2026 weeks 27-40 overridden to make one clear price move (week 36, +25%). */
const base = (date: string) => r2(20 + 2 * Math.sin((2 * Math.PI * isoWeek(date).week) / 52));
const OVERRIDE_2026: Record<number, number> = {27: 20, 28: 20, 29: 20, 30: 20, 31: 20, 32: 20, 33: 20, 34: 20, 35: 20, 36: 25, 37: 20, 38: 20, 39: 20, 40: 22};
const hassanPrice = (date: string) => { const w = isoWeek(date); return w.year === 2026 && OVERRIDE_2026[w.week] !== undefined ? OVERRIDE_2026[w.week]! : base(date); };
const LAST_QUOTE = '2026-10-31';
const wednesdays = (fromYear: number): string[] => {
  const out: string[] = [];
  for (let m = isoWeekMonday(fromYear, 1); plus(m, 2) <= LAST_QUOTE; m = plus(m, 7)) out.push(plus(m, 2));
  return out;
};

// ------------------------------------------------------------------ weather fixture (fake source)
/** Monsoon (1 June to 30 September) rain per day by year; no archive before 2023. Other days 1 mm, 30/19 C. */
const MONSOON_RAIN: Record<number, number> = {2023: 6, 2024: 7.5, 2025: 10, 2026: 9};
const dw = (date: string, rain: number, tMin: number, tMax: number, sourceId: string): DailyWeather => ({date, rainMm: rain, et0Mm: null, tMinC: tMin, tMaxC: tMax, sourceId});
const istDate = (iso: string) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(0, 10);
function fakeWeather(o: {forecastEnd?: string; noArchiveFrom?: string} = {}): WeatherSource & {calls: {obs: number}} {
  const calls = {obs: 0};
  return {
    calls,
    modes: ['live', 'replay', 'synthetic'],
    getDailyObservations: async (_s, range, opts) => {
      calls.obs++;
      const cutoff = istDate(opts.availableBy); // nothing on or after the as-of date is "observed"
      return eachDate(range.start, range.end).filter((d) => d >= '2023-01-01' && d < cutoff && (!o.noArchiveFrom || d < o.noArchiveFrom)).map((d) => {
        const y = Number(d.slice(0, 4)), md = d.slice(5);
        return dw(d, md >= '06-01' && md <= '09-30' ? MONSOON_RAIN[y]! : 1, 19, 30, 'open-meteo-archive');
      });
    },
    getForecast: async (_s, opts) => {
      const from = istDate(opts.issuedAtOrBefore);
      return {issuedAt: `${from}T01:00:00.000Z`, sourceId: 'open-meteo-forecast', days: eachDate(from, o.forecastEnd ?? plus(from, 3)).map((d) => dw(d, 3, 21, 31, 'open-meteo-forecast'))};
    },
    getClimatology: async (_s, range) => ({years: {from: 2016, to: 2025}, qualifyingYears: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025], sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map((d) => dw(d, 4, 18, 29, 'open-meteo-archive'))}),
    dataVersion: async () => 'v',
  };
}

// ------------------------------------------------------------------ harness

let h: Harness, owner: Client, stranger: Client;
let hassanFarm: string, kolarFarm: string, strangerFarm: string, ownerId: string, strangerId: string;
let maizeId: string, ragiId: string, src: string;
const MAIZE = {id: 'cycle-maize', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', sowingDate: SOWING, establishmentDate: SOWING, establishmentMethod: 'direct_sowing', stage: 'growing'};

async function row(o: {market: string; product: string; date: string; kg: number; district: string}) {
  await h.pool.query(
    `INSERT INTO market_observations (market_id, product_id, observed_on, source_id, price_min, price_modal, price_max, unit, is_synthetic, mode, evidence_state,
       market_name, state_name, district_name, variety, grade, variety_key, grade_key, price_min_inr_per_kg, price_modal_inr_per_kg, price_max_inr_per_kg, available_at, vintage_seq)
     VALUES ($1,$2,$3,$4,$5,$5,$5,'INR/quintal',true,'synthetic','illustrative',$1,'Karnataka',$6,'Synth','Local','synth','local',$7,$7,$7,'2026-01-01T00:00:00Z',1)`,
    [o.market, o.product, o.date, src, o.kg * 100, o.district, o.kg],
  );
}
const ownerOf = async (id: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0]!.owner_id;
async function createFarm(client: Client, name: string, location: object) {
  const res = await client.call('POST', '/api/v1/farms', {payload: {name, location}});
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
const alert = (title: string, validFrom: string, validTo: string): AlertDraft => ({
  type: 'crop_threat', severity: 'watch', origin: 'rule', title, detail: 'Synthetic test alert, not a real outbreak.',
  source: {name: 'Synthetic test source', url: 'https://example.test/maize-guide', date: validFrom}, validFrom, validTo, suggestedStep: null,
});
const deps = (over: Partial<MarketTimelineDeps> = {}): MarketTimelineDeps => ({config: {RUNTIME_MODE: 'synthetic'}, pool: h.pool, now: () => NOW, weatherSource: fakeWeather(), ...over});

beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  stranger = await login(h.app);
  src = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, {title: 'Synthetic development fixtures', publisher: 'Harvest Outlook (generated)', url: 'local:data/fixtures/synthetic', licence: 'synthetic, not real data'});
  await h.pool.query(`INSERT INTO crop_identities (slug, names, category) VALUES ('maize', '{"en": ["Maize"]}'::jsonb, 'cereal'), ('ragi', '{"en": ["Finger millet"]}'::jsonb, 'cereal'), ('sugarcane', '{"en": ["Sugarcane"]}'::jsonb, 'cash') ON CONFLICT DO NOTHING`);
  const ins = async (crop: string, slug: string, name: string) => (await h.pool.query<{id: string}>(`INSERT INTO crop_products (crop_id, slug, name, form) SELECT id, $2, $3, 'grain' FROM crop_identities WHERE slug=$1 RETURNING id`, [crop, slug, name])).rows[0]!.id;
  maizeId = await ins('maize', 'maize-grain', 'Maize grain');
  ragiId = await ins('ragi', 'ragi-grain', 'Finger millet grain');
  await ins('sugarcane', 'sugarcane-cane', 'Sugarcane');

  // Maize: Hassan (formula with the 2026 overrides) and Mandya (base + 2) every ISO week from 2022-W01 to the last Wednesday before today.
  for (const d of wednesdays(2022)) {
    await row({market: 'synth-has-a', product: maizeId, date: d, kg: hassanPrice(d), district: 'Hassan'});
    await row({market: 'synth-man', product: maizeId, date: d, kg: r2(base(d) + 2), district: 'Mandya'});
  }
  // A second Hassan market in the week of Monday 2026-10-19 only: Tue 30 and Thu 10 next to synth-has-a on Wed.
  await row({market: 'synth-has-b', product: maizeId, date: '2026-10-20', kg: 30, district: 'Hassan'});
  await row({market: 'synth-has-b', product: maizeId, date: '2026-10-22', kg: 10, district: 'Hassan'});
  // Kolar: three trading days in 2026 only (fewer than the 8 the scope rule needs) -> the Kolar farm falls back to the state pool.
  for (const d of ['2026-03-04', '2026-03-11', '2026-03-18']) await row({market: 'synth-kol', product: maizeId, date: d, kg: 40, district: 'Kolar'});
  // Ragi: Hassan quotes only from 2025-12-31 (ISO 2026-W01) -> one crop year (2025-26) with prices -> analogues insufficient.
  for (const d of wednesdays(2026)) await row({market: 'synth-has-r', product: ragiId, date: d, kg: 35, district: 'Hassan'});

  hassanFarm = await createFarm(owner, 'Hassan maize', HASSAN);
  ownerId = await ownerOf(hassanFarm);
  const put = await owner.call('PUT', `/api/v1/farms/${hassanFarm}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles: [MAIZE], rotationPlans: []}});
  expect(put.statusCode, put.body).toBe(200);
  kolarFarm = await createFarm(owner, 'Kolar plot', KOLAR);
  strangerFarm = await createFarm(stranger, 'Stranger farm', HASSAN);
  strangerId = await ownerOf(strangerFarm);

  // Alerts: one active across two weeks, one expired in June that the farmer dismissed, one on the stranger's farm.
  await persistAlerts(h.pool, ownerId, hassanFarm, 'synthetic', [alert('Fall armyworm scouting window', '2026-10-20', '2026-10-28'), alert('Heavy rain last June', '2026-06-01', '2026-06-05')]);
  await h.pool.query(`UPDATE farm_alerts SET dismissed_at = now() WHERE title = 'Heavy rain last June'`);
  await persistAlerts(h.pool, strangerId, strangerFarm, 'synthetic', [alert('Stranger alert', '2026-10-20', '2026-10-28')]);
}, 120_000);
afterAll(async () => h?.close());

// ------------------------------------------------------------------ pure helpers

describe('pure helpers', () => {
  it('weekRange: Monday-start ISO weeks, inclusive of both ends, trimmed from the oldest side at 260 weeks', () => {
    const {weeks, trimmedFrom} = weekRange('2023-11-01', '2027-11-01');
    expect(trimmedFrom).toBeNull();
    expect(weeks[0]).toEqual({weekStart: '2023-10-30', weekEnd: '2023-11-05', isoWeek: '2023-W44'});
    expect(weeks.at(-1)).toEqual({weekStart: '2027-11-01', weekEnd: '2027-11-07', isoWeek: '2027-W44'});
    for (let i = 1; i < weeks.length; i++) expect(dayDiff(weeks[i - 1]!.weekStart, weeks[i]!.weekStart)).toBe(7);
    expect(weeks.every((w) => new Date(`${w.weekStart}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    const long = weekRange(addMonths('2026-11-01', -60), addMonths('2026-11-01', 18));
    expect(long.trimmedFrom).toBeNull(); // 60 back + 18 ahead fits in MAX_POINTS (400)
    expect(long.weeks.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(long.weeks[0]!.weekStart).toBe('2021-11-01');
    const trimmed = weekRange(addMonths('2026-11-01', -60), addMonths('2026-11-01', 18), 260);
    expect(trimmed.weeks).toHaveLength(260);
    expect(trimmed.trimmedFrom).toBe('2021-11-01');
    expect(trimmed.weeks.at(-1)!.weekEnd).toBe('2028-05-07');
    // ISO week 53 of 2026 is labelled as such (2026 has 53 ISO weeks).
    expect(weekRange('2026-12-30', '2026-12-30').weeks[0]).toEqual({weekStart: '2026-12-28', weekEnd: '2027-01-03', isoWeek: '2026-W53'});
  });

  it('weeklyWeather: majority kind, ties to the less certain kind, values over that kind only', () => {
    const day = (kind: 'observed' | 'forecast' | 'typical' | 'unavailable', rain: number | null) => ({kind, rainMm: rain, tMaxC: rain === null ? null : 30, tMinC: rain === null ? null : 20});
    expect(weeklyWeather([...Array(6)].map(() => day('observed', 2)).concat([day('forecast', 9)]))).toEqual({kind: 'observed', rainMm: 12, tMaxC: 30, tMinC: 20, days: 6});
    expect(weeklyWeather([day('forecast', 1), day('forecast', 1), day('forecast', 1), day('typical', 4), day('typical', 4), day('typical', 4), day('typical', 4)])).toEqual({kind: 'typical', rainMm: 16, tMaxC: 30, tMinC: 20, days: 4});
    // 3 observed, 3 forecast, 1 unavailable: a tie goes to the less certain kind.
    expect(weeklyWeather([day('observed', 1), day('observed', 1), day('observed', 1), day('forecast', 5), day('forecast', 5), day('forecast', 5), day('unavailable', null)]).kind).toBe('forecast');
    expect(weeklyWeather([day('unavailable', null)])).toEqual({kind: 'unavailable', rainMm: null, tMaxC: null, tMinC: null, days: 0});
    expect(weeklyWeather([])).toEqual({kind: 'unavailable', rainMm: null, tMaxC: null, tMinC: null, days: 0});
  });

  it('priceMoves: 15 percent against the median of the previous four weekly medians, at least three of them with quotes', () => {
    const w = (start: string, p50: number | null) => ({weekStart: start, weekEnd: plus(start, 6), p50});
    const weeks = [w('2026-01-05', 20), w('2026-01-12', 20), w('2026-01-19', 22), w('2026-01-26', 18), w('2026-02-02', 23), w('2026-02-09', 16.9), w('2026-02-16', null), w('2026-02-23', 30)];
    // 01-26: prior 22,20,20 -> median 20 -> -10% (no event). 02-02: prior 18,22,20,20 -> median 20 -> +15.0% (event, at the boundary).
    // 02-09: prior 23,18,22,20 -> median 21 -> -19.5% (event). 02-23: prior 16.9,23,18 (02-16 empty) -> 3 weeks, median 18 -> +66.7% (event).
    const moves = priceMoves(weeks);
    expect(moves.map((m) => [m.weekStart, m.changePct, m.priorWeeks])).toEqual([['2026-02-02', 15, 4], ['2026-02-09', -19.5, 4], ['2026-02-23', 66.7, 3]]);
    expect(priceMoves([w('2026-01-05', 20), w('2026-01-12', null), w('2026-01-19', null), w('2026-01-26', 20), w('2026-02-02', 40)])).toEqual([]); // only 2 prior weeks with quotes
    expect(priceMoves([w('2026-01-05', 20), w('2026-01-12', 20), w('2026-01-19', 20), w('2026-01-26', 20), w('2026-02-02', 22.9)])).toEqual([]); // 14.5%
  });

  it('rainSimilarity and monsoonTotals: clipped similarity, only complete 122-day monsoons count', () => {
    expect(rainSimilarity(1098, 1098)).toBe(1);
    expect(rainSimilarity(1220, 1098)).toBeCloseTo(1 - 122 / 1098, 12);
    expect(rainSimilarity(3000, 1000)).toBe(0); // clipped
    expect(rainSimilarity(5, 0)).toBe(0); // max(rain_now, 1) guards a zero season
    const days = eachDate('2024-06-01', '2025-09-30').map((d) => ({date: d, rainMm: 2}));
    const gap = days.filter((d) => d.date !== '2025-07-15');
    expect(monsoonTotals(days, [2023, 2024, 2025])).toEqual([{year: 2024, rainMm: 244}, {year: 2025, rainMm: 244}]);
    expect(monsoonTotals(gap, [2024, 2025])).toEqual([{year: 2024, rainMm: 244}]); // one missing day excludes 2025
    expect(cropYearOf('2026-06-30')).toBe(2025);
    expect(cropYearOf('2026-07-01')).toBe(2026);
  });
});

// ------------------------------------------------------------------ step 1: seasonal reference by week

describe('seasonalReferenceByWeek', () => {
  const fields = (o: {status: string; missingReason: unknown; scope: unknown; yearsUsed: number[]; perYear: unknown; p10: unknown; p25: unknown; p50: unknown; p75: unknown; p90: unknown; annualMean: unknown; annualWeeks: number; weeksUsed: number; observations: number; marketsUsed: number; residualCount: number}) => ({
    status: o.status, missingReason: o.missingReason, scope: o.scope, yearsUsed: o.yearsUsed, perYear: o.perYear, p10: o.p10, p25: o.p25, p50: o.p50, p75: o.p75, p90: o.p90,
    annualMean: o.annualMean, annualWeeks: o.annualWeeks, weeksUsed: o.weeksUsed, observations: o.observations, marketsUsed: o.marketsUsed, residualCount: o.residualCount,
  });

  it('equals harvestPriceOutlook for three sample harvest dates (district, state fallback and state only), including ISO week 53', async () => {
    const harvestDates = ['2027-01-13', '2027-06-30', '2026-12-31']; // weeks 2, 26 and 53 (pooled with 52)
    for (const districtName of ['Hassan', 'Kolar', null]) {
      const byWeek = await seasonalReferenceByWeek(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName, asOf: TODAY});
      expect(byWeek.weeks).toHaveLength(52);
      expect(byWeek.stateWeeks).toHaveLength(52);
      expect(byWeek.yearsConsidered).toEqual([2023, 2024, 2025]);
      for (const harvestDate of harvestDates) {
        const one = await harvestPriceOutlook(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName, harvestDate, asOf: TODAY});
        const bucket = Math.min(52, isoWeek(harvestDate).week);
        expect(byWeek.weeks[bucket - 1]!.week).toBe(bucket);
        expect(fields(byWeek.weeks[bucket - 1]!)).toEqual(fields(one));
        const stateOnly = await harvestPriceOutlook(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName: null, harvestDate, asOf: TODAY});
        expect(fields(byWeek.stateWeeks[bucket - 1]!)).toEqual(fields(stateOnly));
        expect(one.status).toBe('available'); // fixture sanity: the comparisons are on real numbers
      }
    }
  });

  it('keeps the district where it qualifies and falls back to the state pool with harvestPriceOutlook\'s note', async () => {
    const hassan = await seasonalReferenceByWeek(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName: 'Hassan', asOf: TODAY});
    expect(hassan.weeks.every((w) => w.scope.level === 'district' && w.status === 'available')).toBe(true);
    // Different pools give different numbers (Mandya quotes sit 2 INR/kg above the Hassan base).
    expect(hassan.weeks[9]!.p50).not.toBe(hassan.stateWeeks[9]!.p50);
    const kolar = await seasonalReferenceByWeek(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName: 'Kolar', asOf: TODAY});
    expect(kolar.weeks.every((w) => w.scope.level === 'state' && w.scope.requestedLevel === 'district')).toBe(true);
    expect(kolar.weeks[0]!.scope.fallbackNote).toBe('Kolar district: no quotes in the years considered; showing Karnataka markets.');
    const none = await seasonalReferenceByWeek(h.pool, 'synthetic', {productId: 'sugarcane-cane', stateName: 'Karnataka', districtName: 'Hassan', asOf: TODAY});
    expect(none.weeks.every((w) => w.status === 'insufficient' && w.missingReason === 'price_history_not_ingested')).toBe(true);
  });
});

// ------------------------------------------------------------------ step 2: the timeline

describe('marketTimeline: Hassan maize (synthetic prices, fake weather)', () => {
  it('buckets weekly from 36 months back to 12 months ahead with observed, reference and today', async () => {
    const t = MarketTimeline.parse(await marketTimeline(deps(), ownerId, hassanFarm));
    expect(t).toMatchObject({farmId: hassanFarm, productId: 'maize-grain', productName: 'Maize grain', cropName: 'Maize', today: TODAY, from: '2023-10-30', to: '2027-11-07', unit: 'INR/kg'});
    expect(t.points).toHaveLength((dayDiff('2023-10-30', '2027-11-07') + 1) / 7);
    expect(t.points).toHaveLength(210);
    expect(t.points[t.todayIndex]!.weekStart).toBe('2026-10-26');
    for (const [i, p] of t.points.entries()) {
      expect(p.weekStart).toBe(plus('2023-10-30', 7 * i));
      expect(p.weekEnd).toBe(plus(p.weekStart, 6));
      expect(p.isoWeek).toBe(`${isoWeek(p.weekStart).year}-W${String(isoWeek(p.weekStart).week).padStart(2, '0')}`);
      if (i <= t.todayIndex) expect(p.price.kind).not.toBe('reference');
      else expect(p.price.kind).toBe('reference');
    }
    // A one-quote week: the bucket is that Wednesday's value.
    const w = t.points.find((p) => p.weekStart === '2024-05-13')!;
    expect(w.price).toEqual({kind: 'observed', p50: hassanPrice('2024-05-15'), min: hassanPrice('2024-05-15'), max: hassanPrice('2024-05-15'), n: 1, markets: 1});
    // The week of 2026-10-19 pools three market-days from two Hassan markets: values 30 (Tue), v (Wed), 10 (Thu).
    const v = hassanPrice('2026-10-21');
    expect(t.points.find((p) => p.weekStart === '2026-10-19')!.price).toEqual({kind: 'observed', p50: v, min: 10, max: 30, n: 3, markets: 2});
    // Scope: Hassan district qualifies for the reference and the observed series.
    expect(t.scope).toEqual({level: 'district', stateName: 'Karnataka', districtName: 'Hassan', marketCount: 2, label: 'Hassan district mandis, 2 markets'});
    // Future weeks: the reference for that ISO week, equal to harvestPriceOutlook for a date in that week.
    const future = t.points[t.todayIndex + 10]!;
    const one = await harvestPriceOutlook(h.pool, 'synthetic', {productId: 'maize-grain', stateName: 'Karnataka', districtName: 'Hassan', harvestDate: plus(future.weekStart, 3), asOf: TODAY});
    expect(future.price).toEqual({kind: 'reference', p50: one.p50, likely: {low: one.p25, high: one.p75}, possible: {low: one.p10, high: one.p90}, yearsUsed: one.yearsUsed, observations: one.observations});
    expect(t.band).toEqual({likely: 'p25_p75', possible: 'p10_p90'});
    // Harvest window from the current cycle's stage timeline.
    const expected = stageTimeline({cropId: 'maize', productId: 'maize-grain', establishmentMethod: 'direct_sowing', anchorDate: SOWING, stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
    expect(t.harvestWindow).toEqual(expected.harvest);
    expect(t.limitations).toContain(ANALOGUE_LIMITATION);
    expect(ANALOGUE_LIMITATION).toMatch(/a selection of history, not a forecast/);
  });

  it('labels weather observed, forecast or typical by week and never as forecast after the stored horizon', async () => {
    const t = await marketTimeline(deps(), ownerId, hassanFarm); // forecast 2026-11-01 to 2026-11-04 (Wednesday)
    expect(t.forecastHorizonEnd).toBe('2026-11-04');
    const at = (start: string) => t.points.find((p) => p.weekStart === start)!.weather;
    expect(at('2025-07-07')).toEqual({kind: 'observed', rainMm: 70, tMaxC: 30, tMinC: 19, days: 7}); // monsoon 2025: 10 mm/day
    expect(at('2026-10-26')).toEqual({kind: 'observed', rainMm: 6, tMaxC: 30, tMinC: 19, days: 6}); // Mon-Sat archive, Sunday is forecast
    expect(at('2026-11-02')).toEqual({kind: 'typical', rainMm: 16, tMaxC: 29, tMinC: 18, days: 4}); // 3 forecast days lose to 4 typical days
    expect(at('2027-03-01')).toEqual({kind: 'typical', rainMm: 28, tMaxC: 29, tMinC: 18, days: 7});
    expect(t.points.some((p) => p.weather.kind === 'forecast')).toBe(false);

    const later = await marketTimeline(deps({weatherSource: fakeWeather({forecastEnd: '2026-11-06'})}), ownerId, hassanFarm);
    expect(later.forecastHorizonEnd).toBe('2026-11-06');
    const fc = later.points.filter((p) => p.weather.kind === 'forecast');
    expect(fc.map((p) => [p.weekStart, p.weather.days])).toEqual([['2026-11-02', 5]]);
    for (const p of later.points.filter((x) => x.weather.kind === 'forecast')) {
      expect(p.weekStart <= later.forecastHorizonEnd!).toBe(true);
      expect(p.weather.days).toBeLessThanOrEqual(dayDiff(p.weekStart, later.forecastHorizonEnd!) + 1);
    }
    expect(later.points.filter((p) => p.weekStart > later.forecastHorizonEnd!).every((p) => p.weather.kind !== 'forecast')).toBe(true);
  });

  it('lists alerts by overlapping week (dismissed and expired included, never another owner\'s) and computes price moves', async () => {
    const t = await marketTimeline(deps(), ownerId, hassanFarm);
    const ev = (start: string) => t.points.find((p) => p.weekStart === start)!.events;
    expect(ev('2026-10-19').map((e) => [e.kind, e.title, e.dismissed])).toEqual([['alert', 'Fall armyworm scouting window', false]]);
    expect(ev('2026-10-26').map((e) => e.title)).toEqual(['Fall armyworm scouting window']);
    expect(ev('2026-10-19')[0]!.validTo).toBe('2026-10-28');
    expect(ev('2026-06-01')).toMatchObject([{kind: 'alert', title: 'Heavy rain last June', dismissed: true, validTo: '2026-06-05', type: 'crop_threat', source: {name: 'Synthetic test source', url: 'https://example.test/maize-guide', date: '2026-06-01'}}]);
    expect(t.points.flatMap((p) => p.events).some((e) => e.title === 'Stranger alert')).toBe(false);
    // Price moves: only the week of 2026-08-31 (ISO 36): 25 against the median 20 of the four flat weeks before it.
    const moves = t.points.flatMap((p) => p.events.filter((e) => e.kind === 'price_move').map((e) => ({week: p.weekStart, e})));
    expect(moves.map((m) => m.week)).toEqual(['2026-08-31']);
    expect(moves[0]!.e).toMatchObject({id: 'price_move:2026-08-31', type: 'price', severity: 'info', title: 'Mandi price up 25% this week', alertId: null, dismissed: false, date: '2026-09-06'});
    expect(moves[0]!.e.detail).toContain('₹25.0/kg against ₹20.0/kg');
    expect(moves[0]!.e.source).toEqual({name: 'Synthetic development fixtures', url: null, date: '2026-09-06'}); // local: URL is not a link
  });

  it('finds years with similar rain, ordered by similarity, with price paths and harvest change', async () => {
    const t = await marketTimeline(deps(), ownerId, hassanFarm);
    // This season: 1 June to 30 September 2026 fully observed at 9 mm/day = 1098 mm.
    expect(t.analogues.thisSeason).toEqual({cropYear: '2026-27', rainMm: 1098, observedThrough: '2026-09-30', typicalRemainderMm: 0});
    expect(t.analogues.status).toBe('available');
    // 2025: 1220 mm -> 1 - 122/1098 = 0.889; 2024: 915 -> 0.833; 2023: 732 -> 0.667. 2022 has no archive, so it is not a candidate.
    expect(t.analogues.years.map((y) => [y.cropYear, y.rainMm, y.similarity])).toEqual([['2025-26', 1220, 0.889], ['2024-25', 915, 0.833], ['2023-24', 732, 0.667]]);
    const y25 = t.analogues.years[0]!;
    expect(y25.pricePath).toHaveLength(52);
    expect(y25.pricePath[0]).toEqual({isoWeek: 28, p50: hassanPrice('2025-07-09')});
    expect(y25.pricePath.at(-1)).toEqual({isoWeek: 27, p50: hassanPrice('2026-07-01')});
    // Harvest change: p50 in the harvest-midpoint week versus the sowing week, both shifted one year back for 2025-26.
    const harvest = t.harvestWindow!;
    const mid = plus(harvest.earliest, Math.floor(dayDiff(harvest.earliest, harvest.latest) / 2));
    const shift = (d: string, k: number) => `${Number(d.slice(0, 4)) - k}${d.slice(4)}`;
    const p = (d: string) => hassanPrice(plus(mondayOf(d), 2));
    expect(y25.harvestChangePct).toBe(Math.round((p(shift(mid, 1)) / p(shift(SOWING, 1)) - 1) * 1000) / 10);
  });

  it('mid-monsoon: this season is observed days plus the typical remainder, and the order follows', async () => {
    const t = await marketTimeline(deps({now: () => new Date('2026-08-15T06:00:00Z')}), ownerId, hassanFarm);
    // Observed 1 June to 14 August (75 days x 9 = 675) plus typical 15 August to 30 September (47 days x 4 = 188).
    expect(t.analogues.thisSeason).toEqual({cropYear: '2026-27', rainMm: 863, observedThrough: '2026-08-14', typicalRemainderMm: 188});
    // 2024: 1 - 52/863 = 0.940; 2023: 1 - 131/863 = 0.848; 2025: 1 - 357/863 = 0.586.
    expect(t.analogues.years.map((y) => [y.cropYear, y.similarity])).toEqual([['2024-25', 0.94], ['2023-24', 0.848], ['2025-26', 0.586]]);
    expect(t.limitations.join(' ')).toContain('plus typical values for the 47 remaining days');
  });

  it('analogues are insufficient with a reason when fewer than two years have rain and prices', async () => {
    const ragi = await marketTimeline(deps(), ownerId, hassanFarm, {productId: 'ragi-grain'});
    expect(ragi.analogues).toMatchObject({status: 'insufficient', years: []});
    expect(ragi.analogues.reason).toBe('Fewer than two past crop years have both complete June to September rain at the field and mandi prices (found 1).');
    expect(ragi.harvestWindow).toBeNull(); // the current crop grows maize, not ragi
    expect(ragi.limitations).toContain('The current crop grows a different product, so no harvest window is shaded for this product.');
    // No field location: weather unavailable everywhere and no analogues.
    const kolar = await marketTimeline(deps(), ownerId, kolarFarm, {productId: 'maize-grain'});
    expect(kolar.analogues).toEqual({status: 'insufficient', reason: 'No field location is recorded, so rain at the field cannot be read.', thisSeason: null, years: []});
    expect(kolar.points.every((p) => p.weather.kind === 'unavailable' && p.weather.days === 0)).toBe(true);
    expect(kolar.forecastHorizonEnd).toBeNull();
  });

  it('scope fallback: a district with too few quotes uses the state pool and says so', async () => {
    const t = MarketTimeline.parse(await marketTimeline(deps(), ownerId, kolarFarm, {productId: 'maize-grain'}));
    expect(t.scope).toMatchObject({level: 'state', stateName: 'Karnataka', districtName: null});
    expect(t.scope.label).toMatch(/^Karnataka mandis, \d+ markets$/);
    expect(t.limitations).toContain('Kolar district: no quotes in the years considered; showing Karnataka markets.');
    // State weekly medians pool Hassan and Mandya: for a one-quote-each week, the mean of the two.
    const w = t.points.find((p) => p.weekStart === '2024-05-13')!;
    expect(w.price).toMatchObject({kind: 'observed', p50: r2((hassanPrice('2024-05-15') + r2(base('2024-05-15') + 2)) / 2), n: 2, markets: 2});
    expect(t.harvestWindow).toBeNull(); // no cycle on this farm
  });

  it('products without stored history get price kind none with price_history_not_ingested', async () => {
    for (const productId of ['sugarcane-cane', 'no-such-product']) {
      const t = MarketTimeline.parse(await marketTimeline(deps(), ownerId, hassanFarm, {productId}));
      expect(t.points.every((p) => p.price.kind === 'none' && p.price.reason === 'price_history_not_ingested')).toBe(true);
      expect(t.analogues.status).toBe('insufficient');
      expect(t.scope.marketCount).toBe(0);
    }
  });

  it('live mode queues one archive job when this season\'s rain is missing at the field point, never in synthetic mode', async () => {
    const count = async () => (await h.pool.query<{n: string}>("SELECT count(*) n FROM jobs WHERE type = 'ingest.weather_archive'")).rows[0]!.n;
    const noSeason = () => fakeWeather({noArchiveFrom: '2026-01-01'});
    const synth = await marketTimeline(deps({weatherSource: noSeason()}), ownerId, hassanFarm);
    expect(await count()).toBe('0');
    expect(synth.analogues.reason).toMatch(/not known: no rain observations are stored/);
    const live = await marketTimeline(deps({config: {RUNTIME_MODE: 'live'}, weatherSource: noSeason()}), ownerId, hassanFarm);
    expect(live.analogues).toMatchObject({status: 'insufficient', reason: SEASON_FETCHING_REASON, years: []});
    await marketTimeline(deps({config: {RUNTIME_MODE: 'live'}, weatherSource: noSeason()}), ownerId, hassanFarm); // second read: deduplicated
    const jobs = (await h.pool.query<{owner_id: string | null; idempotency_key: string; payload: Record<string, unknown>; state: string}>("SELECT owner_id, idempotency_key, payload, state FROM jobs WHERE type = 'ingest.weather_archive'")).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({owner_id: null, idempotency_key: 'clim:13.25,76.25:2026', state: 'queued', payload: {lat: 13.25, lon: 76.25, start: '2026-01-01', end: '2026-10-31'}});
    // With the season stored, live mode queues nothing more and the analogues are computed.
    const full = await marketTimeline(deps({config: {RUNTIME_MODE: 'live'}}), ownerId, hassanFarm);
    expect(full.analogues.thisSeason?.rainMm).toBe(1098);
    expect(await count()).toBe('1');
  });

  it('defaults to the current cycle\'s product, requires one otherwise, and is owner-private', async () => {
    expect((await marketTimeline(deps(), ownerId, hassanFarm)).productId).toBe('maize-grain');
    await expect(marketTimeline(deps(), ownerId, kolarFarm)).rejects.toMatchObject({statusCode: 400});
    await expect(marketTimeline(deps(), strangerId, hassanFarm)).rejects.toMatchObject({statusCode: 404});
    await expect(marketTimeline(deps(), ownerId, hassanFarm, {monthsBack: 61})).rejects.toMatchObject({statusCode: 400});
  });
});

// ------------------------------------------------------------------ step 3: the route

describe('GET /api/v1/farms/:id/market-timeline', () => {
  let app: FastifyInstance, client: Client;
  beforeAll(async () => {
    // The orchestrator registers marketTimelineRoutes in routes/index.ts; this app uses that registration (real clock,
    // the stored-data weather source, synthetic mode, so no network).
    app = h.app;
    expect(typeof marketTimelineRoutes).toBe('function');
    client = await login(app);
  });

  it('validates the query and the farm id, needs a session and hides other owners\' farms', async () => {
    const url = (q: string) => `/api/v1/farms/${hassanFarm}/market-timeline${q}`;
    for (const q of ['?monthsBack=0', '?monthsBack=61', '?monthsAhead=19', '?monthsAhead=-1', '?monthsBack=abc', '?productId=has%20space', '?monthsBack=2.5']) {
      const res = await client.call('GET', url(q));
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toMatchObject({data: null, error: {code: expect.any(String)}});
    }
    expect((await client.call('GET', '/api/v1/farms/not-a-uuid/market-timeline')).statusCode).toBe(400);
    expect((await client.call('GET', url(''), {cookie: null, csrf: null})).statusCode).toBe(401);
    expect((await client.call('GET', url('?productId=maize-grain'))).statusCode).toBe(404); // another owner's farm
  });

  it('returns the contract in the standard envelope for the owner', async () => {
    const mine = await createFarm(client, 'Route farm', HASSAN);
    const put = await client.call('PUT', `/api/v1/farms/${mine}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles: [MAIZE], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const res = await client.call('GET', `/api/v1/farms/${mine}/market-timeline?monthsBack=12&monthsAhead=6`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json();
    expect(body).toMatchObject({schemaVersion: '1.0', mode: 'synthetic', error: null, warnings: []});
    const t = MarketTimeline.parse(body.data);
    expect(t.farmId).toBe(mine);
    expect(t.productId).toBe('maize-grain');
    expect(t.from).toBe(mondayOf(addMonths(t.today, -12)));
    expect(t.to).toBe(plus(mondayOf(addMonths(t.today, 6)), 6));
    const ragi = await client.call('GET', `/api/v1/farms/${mine}/market-timeline?productId=ragi-grain&monthsAhead=0`);
    expect(ragi.statusCode).toBe(200);
    const r = MarketTimeline.parse(ragi.json().data);
    expect(r.points.at(-1)!.weekStart).toBe(mondayOf(r.today));
  });
});

// Spy guard: the suite must not reach the network.
vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network disabled in tests'); });
