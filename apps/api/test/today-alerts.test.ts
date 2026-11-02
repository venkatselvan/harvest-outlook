import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FarmAlerts, type FarmWorkspace, type IndexStageReading, type NdviReading, type NdviSeries, type StageTimeline } from '@harvest/contracts';
import { setupHarness, login, farmBody, type Harness, type Client } from './helpers';
import {
  ALERT_LIMITATIONS, INSTRUCTIONS, SATELLITE_DROP_RULE, addDays, alertFingerprint, gateGroundedAlerts, groundedReview, istDate, listAlerts, loadPriceMoves, persistAlerts, priceMoveFromQuotes,
  satelliteAlerts, structuredAlerts, type AlertDraft, type GroundedTransport, type PriceMove,
} from '../src/services/today/alerts';
import { PC_ORIGIN } from '../src/providers/sentinel2';
import { fakePlanetary, type FakeScene } from './fixtures/sentinel2/fake-provider';
import { monitoringSnapshot, type MonitoringSnapshot } from '../src/services/monitoring';
import { enqueueDueMonitors, readMonitorSettings } from '../src/services/monitor-schedule';
import { createMonitorHandler } from '../src/worker/handlers/monitoring';
import { MetaClient } from '../src/providers/meta/client';
import { Budget } from '../src/services/budget';
import { enqueue } from '../src/services/jobs';
import { ensureSource } from '../src/ingest/sources';

/** All farms, quotes, forecasts and provider responses in this file are synthetic test data. */
const ASOF = '2026-11-01T06:00:00Z'; // 11:30 IST, calendar date 2026-11-01
const workspace = (over: Partial<FarmWorkspace> = {}): FarmWorkspace => ({ farmId: randomUUID(), version: 1, updatedAt: null, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [], fields: [], ...over });
const day = (date: string, v: Partial<MonitoringSnapshot['weather']['days'][number]> & { windGustKmh?: number } = {}) => ({ date, rainMm: 0, tMinC: 18, tMaxC: 28, et0Mm: 3, ...v });
const snapshot = (days: ReturnType<typeof day>[], over: Partial<MonitoringSnapshot['weather']> = {}): MonitoringSnapshot => ({
  mode: 'live', farmId: randomUUID(), checkedAt: ASOF,
  weather: { status: 'fresh', reason: null, issuedAt: '2026-11-01T01:00:00Z', attribution: 'Open-Meteo', point: { lat: 13, lon: 76 }, coordinateBasis: 'farm_location', days, ...over },
  market: { status: 'unavailable', reason: null, products: [] }, meta: { status: 'available', reason: null, automatic: false },
});

describe('structured alerts: weather thresholds (code only)', () => {
  it('flags daily rain >= 50 mm (warning from 115.6 mm), merges runs, and keeps numbers out of titles', () => {
    const s = snapshot([day('2026-10-31', { rainMm: 300 }), day('2026-11-01', { rainMm: 49.9 }), day('2026-11-02', { rainMm: 50 }), day('2026-11-03', { rainMm: 120 }), day('2026-11-04', { rainMm: 10 }), day('2026-11-06', { rainMm: 60 })]);
    const { alerts, notes } = structuredAlerts(s, workspace(), [], ASOF);
    const rain = alerts.filter((a) => a.title === 'Heavy rain in the forecast');
    expect(rain.map((a) => [a.validFrom, a.validTo, a.severity])).toEqual([['2026-11-02', '2026-11-03', 'warning'], ['2026-11-06', '2026-11-06', 'watch']]);
    expect(rain[0]!.detail).toContain('120 mm forecast on 2026-11-03');
    expect(rain[0]!.detail).toContain('not an IMD warning');
    expect(rain[0]!.source).toEqual({ name: 'Open-Meteo forecast for the field point, issued 2026-11-01', url: 'https://open-meteo.com/', date: '2026-11-01' });
    expect(alerts.every((a) => a.origin === 'rule' && !/\d/.test(a.title))).toBe(true);
    // 2026-10-31 is before the as-of date and is ignored.
    expect(alerts.some((a) => a.validFrom === '2026-10-31')).toBe(false);
    expect(notes).toContain('wind_gust_check_skipped:variable_not_in_stored_forecast');
  });

  it('three-day totals need three consecutive known days and merge overlapping windows', () => {
    const s = snapshot([day('2026-11-01', { rainMm: 30 }), day('2026-11-02', { rainMm: 40 }), day('2026-11-03', { rainMm: 35 }), day('2026-11-04', { rainMm: 30 }), day('2026-11-05', { rainMm: 0 }), day('2026-11-06', { rainMm: 0 }),
      day('2026-11-08', { rainMm: 49 }), day('2026-11-09', { rainMm: 49 }), day('2026-11-11', { rainMm: 49 })]);
    const multi = structuredAlerts(s, workspace(), [], ASOF).alerts.filter((a) => a.title === 'Heavy multi-day rain in the forecast');
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ validFrom: '2026-11-01', validTo: '2026-11-04', severity: 'watch' });
    expect(multi[0]!.detail).toContain('105 mm forecast over 2026-11-01 to 2026-11-03');
    const gap = snapshot([day('2026-11-01', { rainMm: 60, tMaxC: 39.9 }), day('2026-11-02', { rainMm: null }), day('2026-11-03', { rainMm: 60 })]);
    expect(structuredAlerts(gap, workspace(), [], ASOF).alerts.filter((a) => a.title.includes('multi-day'))).toEqual([]);
  });

  it('heat >= 40 C, cold <= 5 C, wind gusts only when the variable exists, nothing from an unavailable forecast', () => {
    const s = snapshot([day('2026-11-01', { tMaxC: 40, tMinC: 5.1 }), day('2026-11-02', { tMaxC: 41.5, tMinC: 5 }), day('2026-11-03', { tMaxC: 30, tMinC: 4, windGustKmh: 65 })]);
    const { alerts, notes } = structuredAlerts(s, workspace(), [], ASOF);
    expect(alerts.find((a) => a.title.startsWith('High'))).toMatchObject({ validFrom: '2026-11-01', validTo: '2026-11-02' });
    expect(alerts.find((a) => a.title.startsWith('High'))!.detail).toContain('41.5 °C forecast on 2026-11-02');
    expect(alerts.find((a) => a.title.startsWith('Low'))).toMatchObject({ validFrom: '2026-11-02', validTo: '2026-11-03' });
    expect(alerts.find((a) => a.title.startsWith('Strong wind'))).toMatchObject({ validFrom: '2026-11-03' });
    expect(notes.some((n) => n.startsWith('wind_gust'))).toBe(false);
    const none = structuredAlerts(snapshot([], { status: 'unavailable', reason: 'farm_coordinates_missing', issuedAt: null }), workspace(), [], ASOF);
    expect(none.alerts).toEqual([]);
    expect(none.notes).toContain('weather_checks_skipped:farm_coordinates_missing');
  });

  it('crop-threat windows come only from sourced seasonalRisks and are skipped (with a note) when absent', () => {
    const ws = workspace({ cycles: [{ id: 'c1', cropId: 'maize', sowingDate: '2026-10-01', stage: 'growing' }] });
    const research = { crops: [{ cropId: 'maize', seasonalRisks: [
      { id: 'faw', title: 'Fall armyworm scouting window', anchor: 'sowing', startDay: 25, endDay: 45, sourceRefs: [{ sourceId: 's1', locator: 'p. 3' }] },
      { id: 'late', title: 'Later window', anchor: 'sowing', startDay: 90, endDay: 100, sourceRefs: [{ sourceId: 's1', locator: 'p. 4' }] },
      { id: 'unsourced', title: 'No source', anchor: 'sowing', startDay: 25, endDay: 45, sourceRefs: [{ sourceId: 'missing', locator: 'x' }] },
    ] }], sources: [{ id: 's1', url: 'https://example.test/maize-guide', publisher: 'Example University', title: 'Maize guide', retrievedAt: '2026-10-20T00:00:00Z' }] };
    const { alerts } = structuredAlerts(snapshot([]), ws, [], ASOF, research);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'crop_threat', validFrom: '2026-10-26', validTo: '2026-11-15', source: { url: 'https://example.test/maize-guide', date: '2026-10-20' } });
    expect(alerts[0]!.detail).toContain('not an observed outbreak');
    expect(structuredAlerts(snapshot([]), ws, [], ASOF, { crops: [{ cropId: 'maize' }], sources: [] }).notes).toContain('crop_threat_windows_skipped:seasonal_risks_not_in_research');
  });
});

describe('price-move math', () => {
  const asOf = '2026-11-01';
  const quotes = (from: string, n: number, price: number | ((i: number) => number)) => Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), inrPerKg: typeof price === 'number' ? price : price(i) }));
  it('compares the median of the last 30 days with the 30 days before, using inclusive window edges', () => {
    // previous window 2026-09-03..2026-10-02; current 2026-10-03..2026-11-01
    expect(addDays(asOf, -29)).toBe('2026-10-03');
    const prev = quotes('2026-09-03', 6, (i) => [18, 20, 20, 22, 40, 10][i]!); // median 20
    const cur = quotes('2026-10-28', 5, 15); // median 15
    expect(priceMoveFromQuotes([...prev, ...cur, { date: '2026-09-02', inrPerKg: 1000 }, { date: '2026-11-02', inrPerKg: 1000 }], asOf)).toEqual({
      currentMedianInrPerKg: 15, previousMedianInrPerKg: 20, changePct: -25, currentDays: 5, previousDays: 6, lastObservedOn: '2026-11-01' });
    // Boundary days: 2026-10-02 belongs to the previous window, 2026-10-03 to the current one.
    const edge = priceMoveFromQuotes([...quotes('2026-09-28', 5, 10), ...quotes('2026-10-03', 5, 12.5)], asOf);
    expect(edge).toMatchObject({ previousDays: 5, currentDays: 5, changePct: 25 });
  });
  it('reports a missing reason instead of a number for thin windows and ignores non-positive quotes', () => {
    expect(priceMoveFromQuotes(quotes('2026-10-20', 4, 10), asOf)).toEqual({ missing: 'insufficient_current_window' });
    expect(priceMoveFromQuotes([...quotes('2026-10-20', 5, 10), ...quotes('2026-09-10', 5, 0)], asOf)).toEqual({ missing: 'insufficient_previous_window' });
  });
  it('alerts at <= -20% (watch) and >= +25% (info) only, on a weekly-anchored validity', () => {
    const move = (changePct: number): PriceMove => ({ productId: 'maize-grain', productName: 'Maize grain', stateName: 'Karnataka', currentMedianInrPerKg: 20, previousMedianInrPerKg: 25, changePct, currentDays: 10, previousDays: 12, lastObservedOn: '2026-10-31', source: { name: 'data.gov.in: mandi', url: 'https://api.data.gov.in/resource/x' } });
    const out = structuredAlerts(snapshot([]), workspace(), [move(-20), move(-19.9), move(24.9), move(25)], ASOF).alerts;
    expect(out.map((a) => [a.title, a.severity])).toEqual([['Maize grain: mandi prices down in Karnataka', 'watch'], ['Maize grain: mandi prices up in Karnataka', 'info']]);
    expect(out[0]).toMatchObject({ validFrom: '2026-10-26', validTo: '2026-11-01', source: { date: '2026-10-31' } });
    expect(out[0]!.detail).toContain('(-20%)');
    expect(out[0]!.detail).toContain('not a farm-gate price or a forecast');
  });
});

describe('citation gate for grounded alerts', () => {
  const base = { type: 'market_event', severity: 'watch', title: 'Mandi traders strike in Hassan', detail: 'Traders at the APMC yard announced a strike from 3 Nov.', sourceUrl: 'https://news.example.in/agri/2026/10/28/hassan-strike', sourceName: 'Example News', sourceDate: '2026-10-28', validFrom: '2026-11-03', validTo: '2026-11-05', suggestedStep: 'Confirm the yard schedule before transporting produce.' };
  const evidence = { citations: ['https://news.example.in/agri/2026/10/28/hassan-strike', 'https://prices.example.in/maize-outlook'], searchSources: ['https://www.agri.example.org/hassan-armyworm/?utm_source=feed', 'https://old.example.in/2026/08/01/report'] };
  const gate = (alerts: unknown[]) => gateGroundedAlerts({ alerts }, evidence, '2026-11-01');
  it('keeps cited and search-retrieved URLs, storing the retrieved URL spelling', () => {
    const r = gate([base, { ...base, type: 'crop_threat', title: 'Fall armyworm reported in Hassan maize', sourceUrl: 'http://agri.example.org/hassan-armyworm', sourceDate: '2026-10-25', validFrom: '2026-10-25', validTo: '2026-11-20' }]);
    expect(r.dropped).toEqual([]);
    expect(r.kept.map((a) => [a.type, a.origin, a.source.url])).toEqual([['market_event', 'grounded_review', base.sourceUrl], ['crop_threat', 'grounded_review', 'https://www.agri.example.org/hassan-armyworm/?utm_source=feed']]);
  });
  it('drops uncited, stale, future, date-mismatched, off-enum, schema-invalid, expired and price-prediction items', () => {
    const r = gate([
      { ...base, sourceUrl: 'https://invented.example.com/strike' },
      { ...base, sourceUrl: 'https://old.example.in/2026/08/01/report', sourceDate: '2026-08-01' },
      { ...base, sourceDate: '2026-11-05' },
      { ...base, sourceDate: '2026-10-10' },
      { ...base, type: 'rumour' },
      { ...base, title: 'x'.repeat(81) },
      { ...base, sourceDate: '2026-02-30' },
      { ...base, validFrom: '2026-10-01', validTo: '2026-10-20' },
      { ...base, type: 'price', sourceUrl: 'https://prices.example.in/maize-outlook', sourceDate: '2026-10-30', title: 'Maize prices in Karnataka', detail: 'Traders say maize prices are expected to rise next week.' },
      'not an object',
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(['uncited_url', 'source_date_stale', 'source_date_in_future', 'source_date_mismatch', 'type_not_allowed', 'schema_invalid', 'source_date_invalid', 'expired', 'price_prediction', 'schema_invalid']);
    expect(r.dropped[0]).toMatchObject({ type: 'market_event', sourceDomain: 'invented.example.com' });
  });
  it('never accepts a model alert typed satellite: that type belongs to the code rule on the field series', () => {
    const r = gate([{ ...base, type: 'satellite' }]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{ reason: 'type_not_allowed', type: 'satellite', sourceDomain: 'news.example.in' }]);
  });
  it('rejects a non-JSON envelope, collapses duplicates and caps at six alerts', () => {
    expect(gateGroundedAlerts(null, evidence, '2026-11-01').dropped).toEqual([{ reason: 'invalid_envelope', type: null, sourceDomain: null }]);
    const r = gate([base, { ...base, sourceUrl: `${base.sourceUrl}/#top` }, ...Array.from({ length: 7 }, (_, i) => ({ ...base, title: `Strike notice ${'abcdefg'[i]}` }))]);
    expect(r.kept).toHaveLength(6);
    expect(r.dropped.map((d) => d.reason)).toEqual(['duplicate', 'over_limit', 'over_limit']);
  });
  describe('lapsed recent weather (extended_recent_weather)', () => {
    // asOf 2026-11-01. Undated URL on purpose, so only the date rules under test apply.
    const weather = { ...base, type: 'weather', title: 'Heavy rain warning for Hassan', detail: 'A heavy-rain warning was issued for the district.', sourceUrl: 'https://prices.example.in/maize-outlook', sourceName: 'Example bulletin', sourceDate: '2026-10-29', validFrom: '2026-10-29', validTo: '2026-10-31' };
    it('keeps a weather item that lapsed but was published in the last 7 days, extends validTo to asOf + 2 days and logs it', () => {
      const r = gate([weather]);
      expect(r.dropped).toEqual([]);
      expect(r.kept).toHaveLength(1);
      expect(r.kept[0]).toMatchObject({ type: 'weather', origin: 'grounded_review', validFrom: '2026-10-29', validTo: '2026-11-03', source: { url: weather.sourceUrl, date: '2026-10-29' } });
      expect(r.adjusted).toEqual([{ reason: 'extended_recent_weather', type: 'weather', sourceDomain: 'prices.example.in' }]);
    });
    it('applies only at the 7-day boundary, only to weather, and never rescues an item that fails another check', () => {
      const r = gate([
        { ...weather, title: 'Seven days old', sourceDate: '2026-10-25' },
        { ...weather, title: 'Eight days old', sourceDate: '2026-10-24' },
        { ...weather, type: 'market_event', title: 'Lapsed strike notice' },
        { ...weather, type: 'crop_threat', title: 'Lapsed pest report' },
        { ...weather, title: 'Uncited lapsed warning', sourceUrl: 'https://invented.example.com/x' },
        { ...weather, title: 'Mismatched source date', sourceUrl: base.sourceUrl, sourceDate: '2026-10-20' },
        { ...weather, title: 'Still valid warning', validTo: '2026-11-04' },
      ]);
      expect(r.kept.map((a) => [a.title, a.validTo])).toEqual([['Seven days old', '2026-11-03'], ['Still valid warning', '2026-11-04']]);
      expect(r.dropped.map((d) => d.reason)).toEqual(['expired', 'expired', 'expired', 'uncited_url', 'source_date_mismatch']);
      expect(r.adjusted).toHaveLength(1);
    });
  });
});

describe('Meta request shape for built-in tool limits', () => {
  const params = { model: 'muse-spark-1.3', instructions: 'i', input: 'x', maxOutputTokens: 100 };
  const client = new MetaClient({ apiKey: 'test-key-not-real', baseUrl: 'https://api.meta.test/v1' });
  it('sends max_tool_calls only when set, and only as an integer of at least 1', () => {
    expect(client.buildBody({ ...params, webSearch: { searchContextSize: 'low' }, maxToolCalls: 3 })).toMatchObject({ max_tool_calls: 3, tools: [{ type: 'web_search', search_context_size: 'low' }] });
    expect(client.buildBody({ ...params, webSearch: { searchContextSize: 'low' } })).not.toHaveProperty('max_tool_calls');
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => client.buildBody({ ...params, maxToolCalls: bad })).toThrow(/maxToolCalls/);
  });
});

describe('grounded review prompt and limitations (ROUND2_SPEC.md 2.3)', () => {
  it('the weather bullet asks for IMD district warnings, nowcasts and bulletins; the IMD limitation names the daily search', () => {
    expect(INSTRUCTIONS).toContain('- weather: IMD district warnings, nowcasts and bulletins (mausam.imd.gov.in, state disaster management authorities), cyclone, flood, heavy-rain or heat bulletins for the district or state;');
    expect(INSTRUCTIONS).toContain('Give the real end date of a weather warning');
    expect(ALERT_LIMITATIONS).toContain('Direct IMD feed not connected (needs a key); official warnings are searched daily.');
    expect(ALERT_LIMITATIONS.join(' ')).not.toMatch(/IMD district warnings are not connected/);
  });
});

// ------------------------------------------------------------------------------------------------ satellite drop rule (pure)

/** Synthetic NDVI readings and series; none of these values is a satellite observation. */
const ndviStats = (mean: number | null, clearFraction = 0.95) => ({ mean, median: mean, p10: mean, p90: mean, clearPixels: 100, totalPixels: 121, clearFraction, cloudOrShadowFraction: 1 - clearFraction, b04P95: 1800, usable: mean !== null && clearFraction >= 0.6, rejection: null });
const s2Id = (date: string) => `S2B_MSIL2A_${date.replace(/-/g, '')}T052229_R062_T43PFQ_${date.replace(/-/g, '')}T090011`;
const ndviReading = (date: string, field: number | null, nb: number | null, clearFraction = 0.95): NdviReading => ({
  itemId: s2Id(date), date, acquiredAt: `${date}T05:22:29Z`, tileId: '43PFQ', baseline: '05.11', offsetApplied: true, sceneCloudPct: 4,
  usable: field !== null && clearFraction >= 0.6, field: ndviStats(field, clearFraction), neighbourhood: nb === null ? null : ndviStats(nb),
});
const ndviSeriesOf = (readings: NdviReading[], over: Partial<NdviSeries> = {}): NdviSeries => ({
  farmId: randomUUID(), status: 'available', reason: null, window: { from: '2026-07-01', to: '2026-11-01' }, polygonBasis: 'boundary', polygonPixels: 121, smallField: false, imageBbox: null,
  scenesListed: readings.length, scenesAnalysed: readings.length, scenesPending: 0, scenesFailed: 0, readings, latestUsable: [...readings].reverse().find((r) => r.usable) ?? null,
  method: { version: 'test', sclClassesKept: [4, 5, 6, 7], minClearFraction: 0.6, minClearPixels: 8, maxSceneCloudPct: 60 }, attribution: 'synthetic', limitations: [], ...over,
});
/** Synthetic 120-day calendar from 2026-07-15: harvest 2026-11-02 to 2026-11-12; its last 25 % starts 2026-10-13. */
const satTimeline = (anchor = '2026-07-15'): StageTimeline => ({
  cropId: 'testcrop', productId: null, establishmentMethod: null, anchorDate: anchor,
  stages: [{ id: 'vegetative', name: 'Vegetative', from: anchor, to: addDays(anchor, 60), basis: 'estimate' }, { id: 'late', name: 'Late season', from: addDays(anchor, 60), to: addDays(anchor, 120), basis: 'estimate' }],
  harvest: { earliest: addDays(anchor, 110), latest: addDays(anchor, 120) }, basis: { kind: 'duration', label: 'synthetic', sourceId: null, url: null, scope: null, note: null },
});
const stageOf = (phase: IndexStageReading['phase'], noise: number | null = 0.01): IndexStageReading => ({
  status: 'available', reason: null, index: 'ndvi', asOf: '2026-10-27', phase, greenUpDate: null, peakDate: null, peakValue: null, troughDate: null, troughValue: null, latestSmoothed: 0.5,
  change15d: 0, noise, changeThreshold: 0.03, readingsUsed: 8, window: null, calendarStage: null, agreement: 'no_calendar', summary: 'synthetic', limitations: [],
  basis: { kind: 'ndvi', label: 'synthetic', sourceId: null, url: null, scope: null, note: null },
});
// Field 0.72 -> 0.55 (down 0.17) while the neighbourhood holds (0.60 -> 0.59).
const dropReadings = () => [ndviReading('2026-10-02', 0.7, 0.6), ndviReading('2026-10-17', 0.72, 0.6), ndviReading('2026-10-22', null, null, 0.1), ndviReading('2026-10-27', 0.55, 0.59)];

describe('satellite drop rule (code only)', () => {
  it('fires one watch alert dated on the scene, with the STAC item as source and both readings in the detail', () => {
    const { alerts, notes } = satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('plateau'), satTimeline('2026-08-01'), ASOF);
    expect(notes).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      type: 'satellite', severity: 'watch', origin: 'rule', title: 'Field greenness fell since the last clear satellite image',
      detail: 'Field NDVI fell from 0.72 on 2026-10-17 to 0.55 on 2026-10-27 (down 0.17; threshold 0.10). The 1 km neighbourhood went from 0.60 to 0.59 (down 0.01), so most of the fall is the field\'s own. Code rule on two clear Sentinel-2 scenes; not an observation of crop damage.',
      source: { name: 'Copernicus Sentinel-2 L2A via Microsoft Planetary Computer', url: `https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items/${s2Id('2026-10-27')}`, date: '2026-10-27' },
      validFrom: '2026-10-27', validTo: '2026-11-06',
      suggestedStep: 'Walk the field: check for water stress, pest or disease damage, lodging or grazing, and compare with neighbouring fields.',
    });
    expect(alerts[0]!.title.length).toBeLessThanOrEqual(120);
  });

  it('needs a usable neighbourhood control on both scenes; without a stage calendar the detail says ripening cannot be ruled out', () => {
    const none = [ndviReading('2026-10-17', 0.72, null), ndviReading('2026-10-27', 0.55, null)];
    expect(satelliteAlerts(ndviSeriesOf(none), stageOf('plateau'), null, ASOF)).toEqual({ alerts: [], notes: ['satellite_check_skipped:no_neighbourhood_control'] });
    const oneSide = [ndviReading('2026-10-17', 0.72, 0.6), ndviReading('2026-10-27', 0.55, null)];
    expect(satelliteAlerts(ndviSeriesOf(oneSide), stageOf('plateau'), null, ASOF).notes).toEqual(['satellite_check_skipped:no_neighbourhood_control']);
    const { alerts } = satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('falling'), null, ASOF);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toContain('No stage calendar exists for this crop, so normal ripening cannot be ruled out.');
  });

  it('does not fire when the neighbourhood shares the fall', () => {
    const readings = [ndviReading('2026-10-17', 0.72, 0.62), ndviReading('2026-10-27', 0.55, 0.47)]; // field -0.17, area -0.15
    expect(satelliteAlerts(ndviSeriesOf(readings), stageOf('plateau'), satTimeline('2026-08-01'), ASOF)).toEqual({ alerts: [], notes: ['satellite_check_skipped:drop_shared_with_neighbourhood'] });
  });

  it('expected senescence comes from the calendar alone: the last 25 % of the cycle or near harvest, whatever the curve phase', () => {
    const late = (stage: IndexStageReading | null, t: StageTimeline) => satelliteAlerts(ndviSeriesOf(dropReadings()), stage, t, ASOF).notes;
    // 2026-10-27 is 104 days into a 120-day cycle from 2026-07-15 (in its last 25 %).
    for (const phase of ['falling', 'harvested', 'plateau', 'unknown'] as const) expect(late(stageOf(phase), satTimeline()), phase).toEqual(['satellite_check_skipped:expected_senescence']);
    // A late-season farm with too few scenes for a curve reading is skipped too.
    expect(late({ ...stageOf('unknown', null), status: 'insufficient', reason: 'too_few_clear_scenes' }, satTimeline())).toEqual(['satellite_check_skipped:expected_senescence']);
    expect(late(null, satTimeline())).toEqual(['satellite_check_skipped:expected_senescence']);
    // Within 21 days before the earliest harvest of a long cycle (not in its last 25 %): still expected.
    const long: StageTimeline = { ...satTimeline('2026-03-01'), harvest: { earliest: '2026-11-17', latest: '2027-02-01' } };
    expect(late(stageOf('plateau'), long)).toEqual(['satellite_check_skipped:expected_senescence']);
    expect(late(stageOf('plateau'), { ...long, harvest: { earliest: '2026-11-18', latest: '2027-02-01' } })).toEqual([]); // 22 days before: reported
    // Early in the cycle the same fall is reported, whatever the phase.
    expect(satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('falling'), satTimeline('2026-09-15'), ASOF).alerts).toHaveLength(1);
  });

  it('does not fire for a small field, a noisy series, a stale or isolated scene, or a low clear fraction', () => {
    const skipped = (series: NdviSeries, stage = stageOf('plateau'), asOf = ASOF) => satelliteAlerts(series, stage, satTimeline('2026-08-01'), asOf).notes;
    expect(skipped(ndviSeriesOf(dropReadings(), { smallField: true }))).toEqual(['satellite_check_skipped:small_field']);
    // A series noise of 0.09 raises the threshold to 0.18, above the 0.17 fall.
    expect(skipped(ndviSeriesOf(dropReadings()), stageOf('plateau', 0.09))).toEqual(['satellite_check_skipped:no_drop']);
    expect(skipped(ndviSeriesOf(dropReadings()), stageOf('plateau'), '2026-11-20T06:00:00Z')).toEqual(['satellite_check_skipped:latest_clear_scene_too_old']);
    expect(skipped(ndviSeriesOf([ndviReading('2026-09-01', 0.8, 0.6), ndviReading('2026-10-27', 0.55, 0.59)]))).toEqual(['satellite_check_skipped:no_previous_clear_scene_within_gap']);
    const hazy = [ndviReading('2026-10-17', 0.72, 0.6), { ...ndviReading('2026-10-27', 0.55, 0.59), field: { ...ndviStats(0.55, 0.5), usable: true } }];
    expect(skipped(ndviSeriesOf(hazy))).toEqual(['satellite_check_skipped:low_clear_fraction']);
    expect(skipped(ndviSeriesOf([], { status: 'unavailable', reason: 'live_mode_required' }))).toEqual(['satellite_check_skipped:live_mode_required']);
    expect(SATELLITE_DROP_RULE.dropFloor.text).toMatch(/design threshold/);
  });

  it('boundaries: a 45-day gap fires and 46 does not; the alert is offered through 10 days after the scene, not 11', () => {
    const gap = (days: number) => satelliteAlerts(ndviSeriesOf([ndviReading(addDays('2026-10-27', -days), 0.72, 0.6), ndviReading('2026-10-27', 0.55, 0.59)]), stageOf('plateau'), satTimeline('2026-08-01'), ASOF);
    expect(gap(SATELLITE_DROP_RULE.maxGapDays.value).alerts).toHaveLength(1);
    expect(gap(SATELLITE_DROP_RULE.maxGapDays.value + 1).notes).toEqual(['satellite_check_skipped:no_previous_clear_scene_within_gap']);
    const on = (isoInstant: string) => satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('plateau'), satTimeline('2026-08-01'), isoInstant);
    expect(on('2026-11-06T06:00:00Z').alerts[0]).toMatchObject({ validTo: '2026-11-06' }); // IST date = scene + 10
    expect(on('2026-11-07T06:00:00Z').notes).toEqual(['satellite_check_skipped:latest_clear_scene_too_old']);
  });

  it('one alert per scene: a repeat run has the same fingerprint, a newer scene a new one', () => {
    // Calendar from 2026-08-15: both scenes fall before its last 25 % and before the pre-harvest window.
    const first = satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('plateau'), satTimeline('2026-08-15'), ASOF).alerts[0]!;
    const again = satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('plateau'), satTimeline('2026-08-15'), '2026-11-02T06:00:00Z').alerts[0]!;
    expect(alertFingerprint(again)).toBe(alertFingerprint(first));
    const newer = satelliteAlerts(ndviSeriesOf([...dropReadings(), ndviReading('2026-11-01', 0.4, 0.58)]), stageOf('plateau'), satTimeline('2026-08-15'), ASOF).alerts[0]!;
    expect(newer.validFrom).toBe('2026-11-01');
    expect(alertFingerprint(newer)).not.toBe(alertFingerprint(first));
  });
});

// ------------------------------------------------------------------------------------------------ database tests

let h: Harness, owner: Client, stranger: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); }, 60_000);
afterAll(async () => h?.close());
const ownerOf = async (farmId: string) => (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0].owner_id as string;
const createFarm = async (c: Client = owner, body: Record<string, unknown> = {}) => (await c.call('POST', '/api/v1/farms', { payload: farmBody({ facts: {}, ...body }) })).json().data.id as string;
const maizeCycle = { expectedVersion: 0, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [{ id: 'c1', cropId: 'maize', sowingDate: '2026-09-15', stage: 'growing' }], rotationPlans: [] };
const ctx = { pool: undefined as never, heartbeat: async () => {}, isCancelled: async () => false };
const job = async (ownerId: string, farmId: string) => ({ id: (await enqueue(h.pool, 'farm.monitor', { farmId }, ownerId, `t-${randomUUID()}`)).job.id, owner_id: ownerId, type: 'farm.monitor', attempt: 1, max_attempts: 1, payload: { farmId } });
const recent = (n: number) => istDate(new Date(Date.now() - n * 86_400_000));

/** Meta Responses body in the documented web-search shape (synthetic content). */
function searchResponse(alerts: unknown[], cited: string[], retrieved: string[]) {
  return { id: `resp_${randomUUID().slice(0, 8)}`, model: 'muse-spark-1.3', status: 'completed', output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['maize Wayanad news', 'maize pest Kerala'], sources: retrieved.map((url) => ({ type: 'url', url })) }, results: retrieved.map((url) => ({ type: 'text_result', title: 'Result', url, snippet: 'Snippet text is evidence only.' })) },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ alerts }), annotations: cited.map((url) => ({ type: 'url_citation', url, title: 'Cited', start_index: 0, end_index: 5 })) }] },
  ], usage: { input_tokens: 5200, output_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 400 } } };
}
function fakeMeta(body: () => unknown) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body as string) : null });
    if (init.method === 'DELETE') return new Response(JSON.stringify({ object: 'response.deleted', deleted: true }), { status: 200 });
    return new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' } });
  });
  return { calls, fetchImpl, client: new MetaClient({ apiKey: 'test-key-not-real', baseUrl: 'https://api.meta.test/v1', fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 0 }) };
}
const liveConfig = (over: Record<string, unknown> = {}) => ({ ...h.config, RUNTIME_MODE: 'live' as const, ...over });
const strikeAlert = () => ({ type: 'market_event', severity: 'watch', title: 'Mandi traders strike announced', detail: 'Traders announced a two-day strike at the district APMC yard.', sourceUrl: `https://news.example.in/agri/${recent(3).replace(/-/g, '/')}/strike`, sourceName: 'Example News', sourceDate: recent(3), validFrom: recent(0), validTo: addDays(recent(0), 3), suggestedStep: 'Confirm yard opening before transporting produce.' });

describe('default-on monitoring', () => {
  it('creates an enabled 24 h monitor row due now at farm creation and schedules it', async () => {
    const id = await createFarm();
    const row = (await h.pool.query('SELECT enabled, meta_enabled, interval_hours, next_check_at <= now() AS due, disabled_by_farmer_at FROM farm_monitors WHERE farm_id=$1', [id])).rows[0];
    expect(row).toEqual({ enabled: true, meta_enabled: true, interval_hours: 24, due: true, disabled_by_farmer_at: null });
    const ownerId = await ownerOf(id);
    expect(await readMonitorSettings(h.pool, ownerId, id)).toMatchObject({ enabled: true, metaEnabled: true, intervalHours: 24, disabledByFarmerAt: null });
    await h.pool.query("UPDATE farm_monitors SET next_check_at=now()+interval '1 day' WHERE farm_id<>$1", [id]);
    expect(await enqueueDueMonitors(h.pool)).toBe(1);
    expect((await h.pool.query("SELECT 1 FROM jobs WHERE type='farm.monitor' AND payload->>'farmId'=$1", [id])).rowCount).toBe(1);
  });

  it("records the farmer's explicit disable; the migration backfill and the scheduler respect it", async () => {
    const disabled = await createFarm(), legacy = await createFarm(), missing = await createFarm();
    expect((await owner.call('PUT', `/api/v1/farms/${disabled}/monitoring`, { payload: { enabled: false } })).statusCode).toBe(200);
    expect((await h.pool.query('SELECT disabled_by_farmer_at IS NOT NULL AS d FROM farm_monitors WHERE farm_id=$1', [disabled])).rows[0].d).toBe(true);
    // A pre-0026 row that was simply never enabled, and a farm with no monitor row at all.
    await h.pool.query("UPDATE farm_monitors SET enabled=false, meta_enabled=false, next_check_at=now()+interval '3 days', session_id=(SELECT id FROM sessions LIMIT 1) WHERE farm_id=$1", [legacy]);
    await h.pool.query('DELETE FROM farm_monitors WHERE farm_id=$1', [missing]);
    // Run the exact backfill statements from the migration file.
    const sql = readFileSync(new URL('../../../db/migrations/0026_farm_alerts_default_monitoring.sql', import.meta.url), 'utf8');
    const backfill = [...sql.matchAll(/^(UPDATE farm_monitors[\s\S]*?;|INSERT INTO farm_monitors[\s\S]*?;)/gm)].map((m) => m[1]!);
    expect(backfill).toHaveLength(2);
    for (const stmt of backfill) await h.pool.query(stmt);
    const rows = Object.fromEntries((await h.pool.query('SELECT farm_id, enabled, meta_enabled, session_id, next_check_at <= now() AS due FROM farm_monitors WHERE farm_id = ANY($1::uuid[])', [[disabled, legacy, missing]])).rows.map((r) => [r.farm_id, r]));
    expect(rows[disabled]).toMatchObject({ enabled: false });
    expect(rows[legacy]).toMatchObject({ enabled: true, meta_enabled: true, session_id: null, due: true });
    expect(rows[missing]).toMatchObject({ enabled: true, meta_enabled: true, due: true });
    // Even if another path flips enabled back on, the farmer's disable keeps the scheduler away.
    await h.pool.query("UPDATE farm_monitors SET enabled=true, next_check_at=now()-interval '1 minute' WHERE farm_id=$1", [disabled]);
    await h.pool.query("UPDATE farm_monitors SET next_check_at=now()+interval '1 day' WHERE farm_id<>$1", [disabled]);
    expect(await enqueueDueMonitors(h.pool)).toBe(0);
    // Re-enabling clears the marker.
    await owner.call('PUT', `/api/v1/farms/${disabled}/monitoring`, { payload: { enabled: true } });
    expect((await readMonitorSettings(h.pool, await ownerOf(disabled), disabled)).disabledByFarmerAt).toBeNull();
  });
});

describe('alert persistence, listing and routes', () => {
  const draft = (over: Partial<AlertDraft> = {}): AlertDraft => ({ type: 'weather', severity: 'watch', origin: 'rule', title: 'Heavy rain in the forecast', detail: '62 mm forecast on 2026-11-03.', source: { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/', date: '2026-11-01' }, validFrom: '2026-11-03', validTo: '2026-11-03', suggestedStep: null, ...over });
  it('dedupes by fingerprint, updates in place, keeps dismissals and lists active alerts newest first', async () => {
    const id = await createFarm();
    const ownerId = await ownerOf(id);
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft(), draft({ validFrom: '2026-10-20', validTo: '2026-10-25', title: 'Old alert' })])).toEqual({ inserted: 2, updated: 0 });
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ detail: '64 mm forecast on 2026-11-03.', severity: 'warning' })])).toEqual({ inserted: 0, updated: 1 });
    expect(alertFingerprint(draft())).toBe(alertFingerprint(draft({ detail: 'different', source: { name: 'x', url: 'https://www.open-meteo.com/#a', date: '2026-11-02' } })));
    // Undated or unsourced drafts never reach the table.
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ title: 'No date', source: { name: 'x', url: 'https://example.test/', date: '' } })])).toEqual({ inserted: 0, updated: 0 });
    const listed = await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF);
    expect(FarmAlerts.parse(listed)).toBeTruthy();
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0]).toMatchObject({ severity: 'warning', detail: '64 mm forecast on 2026-11-03.', validTo: '2026-11-03' });
    expect(listed.imdStatus).toBe('not_connected');
    expect((await listAlerts(h.pool, ownerId, id, 'live', ASOF)).alerts).toEqual([]);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ title: 'Newer alert', validFrom: '2026-11-04', validTo: '2026-11-05' })]);
    expect((await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF)).alerts.map((a) => a.title)).toEqual(['Newer alert', 'Heavy rain in the forecast']);
    // Another owner cannot write into this farm.
    await expect(persistAlerts(h.pool, await ownerOf(await createFarm(stranger)), id, 'synthetic', [draft({ title: 'Intruder' })])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves GET alerts and an idempotent, owner-scoped dismiss through the route plugin', async () => {
    const app = await h.make();
    const call = (c: Client, method: string, url: string) => app.inject({ method: method as 'GET', url, headers: { cookie: c.cookie, origin: 'http://localhost:5173', 'x-csrf-token': c.csrf }, ...(method === 'POST' ? { payload: {} } : {}) });
    const id = await createFarm();
    const ownerId = await ownerOf(id);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ validFrom: recent(0), validTo: addDays(recent(0), 2) })]);
    const got = await call(owner, 'GET', `/api/v1/farms/${id}/alerts`);
    expect(got.statusCode).toBe(200);
    const alert = got.json().data.alerts[0];
    expect(got.json().data).toMatchObject({ imdStatus: 'not_connected', newsReview: { status: 'not_run' } });
    expect((await call(stranger, 'GET', `/api/v1/farms/${id}/alerts`)).statusCode).toBe(404);
    expect((await call(stranger, 'POST', `/api/v1/farms/${id}/alerts/${alert.id}/dismiss`)).statusCode).toBe(404);
    const strangerFarm = await createFarm(stranger);
    expect((await call(stranger, 'POST', `/api/v1/farms/${strangerFarm}/alerts/${alert.id}/dismiss`)).statusCode).toBe(404);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/farms/${id}/alerts/${alert.id}/dismiss`, headers: { cookie: owner.cookie, origin: 'http://localhost:5173' }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    const first = await call(owner, 'POST', `/api/v1/farms/${id}/alerts/${alert.id}/dismiss`);
    expect(first.statusCode).toBe(200);
    expect((await call(owner, 'POST', `/api/v1/farms/${id}/alerts/${alert.id}/dismiss`)).statusCode).toBe(200);
    expect((await call(owner, 'GET', `/api/v1/farms/${id}/alerts`)).json().data.alerts).toEqual([]);
  });

  it('loads a state price move from stored mandi observations and turns it into a dated price alert', async () => {
    const crop = (await h.pool.query("INSERT INTO crop_identities(slug) VALUES('qa-alert-maize') RETURNING id")).rows[0].id;
    const product = (await h.pool.query("INSERT INTO crop_products(crop_id,slug,name) VALUES($1,'qa-alert-maize-grain','Maize grain (test)') RETURNING id", [crop])).rows[0].id;
    const src = await ensureSource(h.pool, 'test-alert-mandi', { title: 'Synthetic mandi fixture', publisher: 'Fixture', url: 'https://example.test/mandi-fixture', licence: 'test' });
    const insert = (market: string, date: string, perKg: number, state = 'Karnataka') => h.pool.query(
      `INSERT INTO market_observations (market_id, product_id, observed_on, source_id, price_min, price_modal, price_max, unit, is_synthetic, mode, evidence_state, market_name, state_name, district_name, variety, grade, variety_key, grade_key,
         price_min_inr_per_kg, price_modal_inr_per_kg, price_max_inr_per_kg, available_at, validation_status)
       VALUES ($1,$2,$3,$4,$5,$5,$5,'INR/quintal',true,'synthetic','illustrative',$1,$6,'Synth',null,null,'','',$7,$7,$7,'2026-10-31T12:00:00Z','valid')`, [market, product, date, src, perKg * 100, state, perKg]);
    for (let i = 0; i < 6; i++) await insert('synth-alert-a', addDays('2026-09-05', i * 3), 20);
    for (let i = 0; i < 6; i++) await insert('synth-alert-a', addDays('2026-10-10', i * 3), 15);
    for (let i = 0; i < 6; i++) await insert('synth-alert-tn', addDays('2026-10-10', i * 3), 90, 'Tamil Nadu');
    const { moves, notes } = await loadPriceMoves(h.pool, { mode: 'synthetic', productIds: ['qa-alert-maize-grain', 'qa-unknown'], stateCode: 'IN-KA', asOf: ASOF });
    expect(notes).toEqual(['price_move_skipped:qa-unknown:product_unknown']);
    expect(moves).toEqual([expect.objectContaining({ productId: 'qa-alert-maize-grain', productName: 'Maize grain (test)', stateName: 'Karnataka', currentMedianInrPerKg: 15, previousMedianInrPerKg: 20, changePct: -25, lastObservedOn: '2026-10-25', source: { name: 'data.gov.in: Synthetic mandi fixture', url: 'https://example.test/mandi-fixture' } })]);
    expect((await loadPriceMoves(h.pool, { mode: 'live', productIds: ['qa-alert-maize-grain'], stateCode: 'IN-KA', asOf: ASOF })).moves).toEqual([]);
    expect((await loadPriceMoves(h.pool, { mode: 'synthetic', productIds: ['qa-alert-maize-grain'], stateCode: null, asOf: ASOF })).notes).toEqual(['price_checks_skipped:farm_state_unknown']);
  });
});

describe('grounded review (Meta transport injected, never live)', () => {
  it('sends one web-search request without coordinates, gates citations, settles the budget and deletes the response', async () => {
    const id = await createFarm(owner, { location: { districtName: 'Hassan', stateId: 'IN-KA', precision: 'approximate', lat: 13.0072, lon: 76.0962 } });
    const ownerId = await ownerOf(id);
    expect((await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: maizeCycle })).statusCode).toBe(200);
    const ws = (await owner.call('GET', `/api/v1/farms/${id}/workspace`)).json().data;
    const cited = strikeAlert();
    const meta = fakeMeta(() => searchResponse([cited, { ...cited, title: 'Invented item', sourceUrl: 'https://invented.example.com/x' }, { ...cited, title: 'Old item', sourceUrl: 'https://old.example.in/report', sourceDate: recent(60) }], [cited.sourceUrl], ['https://old.example.in/report']));
    const budget = Budget.fromConfig(h.pool, h.config);
    const r = await groundedReview({ pool: h.pool, config: liveConfig({ MODEL_API_KEY: 'test-key-not-real' }), budget, transport: meta.client }, { ownerId, farmId: id, sessionId: null, workspace: ws, asOf: new Date().toISOString() });
    expect(r).toMatchObject({ status: 'completed', reason: null, searchCalls: 1, searchQueries: 2, citations: 1, responseDeleted: true });
    expect(r.alerts.map((a) => [a.type, a.source.url])).toEqual([['market_event', cited.sourceUrl]]);
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(['source_date_stale', 'uncited_url']);
    // 5200 input * 1.25/M + 900 output * 4.25/M + 2 queries * 0.0025 = 0.0065 + 0.003825 + 0.005
    expect(r.settledUsd).toBeCloseTo(0.015325, 6);
    const [post, del] = meta.calls;
    expect(post!.method).toBe('POST');
    expect(post!.body).toMatchObject({ model: 'muse-spark-1.3', store: false, include: ['web_search_call.results'], reasoning: { effort: 'low' },
      tools: [{ type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', country: 'IN', region: 'Karnataka', timezone: 'Asia/Kolkata' } }],
      text: { format: { type: 'json_schema', name: 'farm_alert_review', strict: true } } });
    expect(post!.body!.tool_choice).toBeUndefined();
    // At most three built-in searches, capped in the request and asked for in the instructions; focused queries, official sources.
    expect(post!.body!.max_tool_calls).toBe(3);
    const instructions = String(post!.body!.instructions);
    expect(instructions).toMatch(/at most three times/);
    expect(instructions).toMatch(/last 14 days/);
    expect(instructions).toMatch(/Prefer official sources/);
    const input = String(post!.body!.input);
    expect(JSON.parse(input)).toMatchObject({ region: { district: 'Hassan', state: 'Karnataka', country: 'India' }, crops: [{ name: 'maize', status: 'growing' }] });
    expect(input).not.toMatch(/13\.0|76\.0|North plot|lat|lon/);
    expect(del).toMatchObject({ method: 'DELETE' });
    const reservation = (await h.pool.query("SELECT state, request_id, estimated_usd, settled_usd FROM usage_reservations WHERE request_id LIKE 'farm_alert_review:%' AND request_id LIKE $1", [`%${id}%`])).rows[0];
    expect(reservation).toMatchObject({ state: 'settled', settled_usd: '0.015325' });
    // The reservation covers three searches at the per-search input cost of the first live run (93,581 input tokens over
    // 11 searches), the full output allowance and three search fees; settlement above used the actual usage.
    const threeSearchWorstCase = (3 * Math.ceil(93_581 / 11) * 1.25 + 3000 * 4.25) / 1e6 + 3 * 0.0025;
    expect(r.estimateUsd!).toBeGreaterThanOrEqual(threeSearchWorstCase);
    expect(r.estimateUsd!).toBeLessThan(0.07);
    expect(Number(reservation.estimated_usd)).toBeCloseTo(r.estimateUsd!, 6);
    expect((await h.pool.query("SELECT purpose, status, model FROM ai_invocations WHERE owner_id=$1 AND purpose='farm_alert_review'", [ownerId])).rows).toEqual([{ purpose: 'farm_alert_review', status: 'succeeded', model: 'muse-spark-1.3' }]);
  });

  it('makes no network call in synthetic mode, without a key, without crops, or over the daily cap', async () => {
    const id = await createFarm(owner, { location: { districtName: 'Hassan', stateId: 'IN-KA', precision: 'district' } });
    const ownerId = await ownerOf(id);
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: maizeCycle });
    const ws = (await owner.call('GET', `/api/v1/farms/${id}/workspace`)).json().data;
    const meta = fakeMeta(() => searchResponse([], [], []));
    const budget = Budget.fromConfig(h.pool, h.config);
    const args = { ownerId, farmId: id, sessionId: null, workspace: ws, asOf: new Date().toISOString() };
    expect((await groundedReview({ pool: h.pool, config: h.config, budget, transport: meta.client }, args)).reason).toBe('live_mode_required');
    expect((await groundedReview({ pool: h.pool, config: liveConfig({ MODEL_API_KEY: undefined }), budget }, args)).reason).toBe('meta_key_missing');
    expect((await groundedReview({ pool: h.pool, config: liveConfig(), budget, transport: meta.client }, { ...args, workspace: { ...ws, cycles: [] } })).reason).toBe('no_tracked_crops');
    // Atomic cap check: the estimate (tokens + three searches) alone exceeds a 1 cent cap.
    expect((await groundedReview({ pool: h.pool, config: liveConfig({ MONITOR_META_DAILY_CAP_USD: 0.01 }), budget, transport: meta.client }, args))).toMatchObject({ status: 'skipped', reason: 'daily_cap_reached' });
    expect(meta.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('farm.monitor worker: alerts, daily guard and cap', () => {
  const forecast = JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json', import.meta.url), 'utf8'));
  const weatherFetch = () => vi.fn(async () => new Response(JSON.stringify(forecast.body), { status: 200 }));

  const hassan = { location: { districtName: 'Hassan', stateId: 'IN-KA', precision: 'approximate', lat: 12.97, lon: 76.09 } };
  it('runs the grounded review at most once per farm per 24 h, across overlapping and repeated jobs, with no session', async () => {
    const id = await createFarm(owner, hassan);
    const ownerId = await ownerOf(id);
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: maizeCycle });
    expect((await h.pool.query('SELECT session_id FROM farm_monitors WHERE farm_id=$1', [id])).rows[0].session_id).toBeNull();
    const createResponse = vi.fn(async () => ({ responseId: `resp_${randomUUID().slice(0, 8)}`, requestId: 'req', model: 'muse-spark-1.3', status: 'completed', outputText: JSON.stringify({ alerts: [strikeAlert()] }), functionCalls: [], refusal: null, usage: { inputTokens: 4000, outputTokens: 800, cachedInputTokens: 0, reasoningTokens: 300 }, latencyMs: 1, retries: 0, incompleteReason: null, citations: [{ url: strikeAlert().sourceUrl, title: null }], webSearchCalls: [{ id: 'ws', status: 'completed', queries: ['q'], sourceUrls: [], results: [] }] }));
    const deleteResponse = vi.fn(async () => ({ ok: true, code: null }));
    const transport: GroundedTransport = { createResponse, deleteResponse };
    const handler = createMonitorHandler({ config: liveConfig(), pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: weatherFetch() as unknown as typeof fetch, metaTransport: transport });
    const c = { ...ctx, pool: h.pool };
    // Store the forecast once first: concurrent first-time storage of one vintage is a known ingest race (weather_fc_vintage_uq).
    await monitoringSnapshot({ config: liveConfig(), pool: h.pool, fetchImpl: weatherFetch() }, ownerId, id);
    const results = await Promise.all([handler(await job(ownerId, id), c), handler(await job(ownerId, id), c)]) as { metaStatus: string }[];
    expect(results.map((r) => r.metaStatus).sort()).toEqual(['completed', 'daily_limit']);
    expect(await handler(await job(ownerId, id), c)).toMatchObject({ status: 'checked', metaStatus: 'daily_limit' });
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(deleteResponse).toHaveBeenCalledTimes(1);
    const listed = await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString());
    expect(listed.alerts.filter((a) => a.origin === 'grounded_review').map((a) => a.title)).toEqual(['Mandi traders strike announced']);
    expect(listed.newsReview).toMatchObject({ status: 'active' });
    expect((await readMonitorSettings(h.pool, ownerId, id, 'live')).metaReview).toMatchObject({ mode: 'live', kind: 'grounded_alert_review', status: 'completed', alertsKept: 1 });
    expect((await readMonitorSettings(h.pool, ownerId, id, 'synthetic')).metaReview).toBeNull();
  });

  it('skips the review with a recorded reason when the global daily cap is reached; structured checks still run', async () => {
    const id = await createFarm(owner, hassan);
    const ownerId = await ownerOf(id);
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: maizeCycle });
    const before = (await h.pool.query("SELECT COALESCE(SUM(CASE state WHEN 'released' THEN 0 WHEN 'settled' THEN settled_usd ELSE estimated_usd END),0) s FROM usage_reservations WHERE request_id LIKE 'farm_alert_review:%' AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')")).rows[0].s;
    const transport: GroundedTransport = { createResponse: vi.fn(), deleteResponse: vi.fn() };
    const fetchImpl = weatherFetch();
    const handler = createMonitorHandler({ config: liveConfig({ MONITOR_META_DAILY_CAP_USD: Number(before) }), pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: fetchImpl as unknown as typeof fetch, metaTransport: transport });
    const result = await handler(await job(ownerId, id), { ...ctx, pool: h.pool }) as { metaStatus: string; alerts: { notes: string[] } };
    expect(result).toMatchObject({ status: 'checked', metaStatus: 'daily_cap_reached' });
    expect(transport.createResponse).not.toHaveBeenCalled();
    // The weather/market snapshot and the structured checks still ran.
    expect(result.alerts.notes.some((n) => n.startsWith('wind_gust_check_skipped') || n.startsWith('weather_checks_skipped'))).toBe(true);
    expect((await h.pool.query('SELECT last_checked_at IS NOT NULL AS checked, snapshot->\'weather\'->>\'status\' AS weather FROM farm_monitors WHERE farm_id=$1', [id])).rows[0]).toMatchObject({ checked: true });
    expect((await h.pool.query('SELECT last_meta_attempt_at FROM farm_monitors WHERE farm_id=$1', [id])).rows[0].last_meta_attempt_at).toBeNull();
    expect((await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString())).newsReview).toMatchObject({ status: 'paused', reason: 'daily_cap_reached' });
  });

  it('synthetic mode makes no network call and records why the review did not run', async () => {
    const id = await createFarm();
    const ownerId = await ownerOf(id);
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: maizeCycle });
    const fetchImpl = vi.fn();
    const transport: GroundedTransport = { createResponse: vi.fn(), deleteResponse: vi.fn() };
    const handler = createMonitorHandler({ config: h.config, pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: fetchImpl as unknown as typeof fetch, metaTransport: transport });
    expect(await handler(await job(ownerId, id), { ...ctx, pool: h.pool })).toMatchObject({ status: 'checked', metaStatus: 'live_mode_required', climatology: 'not_live', outlookNote: 'live_mode_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transport.createResponse).not.toHaveBeenCalled();
    expect((await listAlerts(h.pool, ownerId, id, 'synthetic', new Date().toISOString())).newsReview).toMatchObject({ status: 'unavailable', reason: 'live_mode_required' });
  });
});

describe('satellite drop alert: storage and the daily monitor', () => {
  it('a repeat persist of the same scene updates in place (migration 0035 admits the satellite type)', async () => {
    const id = await createFarm();
    const ownerId = await ownerOf(id);
    const draft = satelliteAlerts(ndviSeriesOf(dropReadings()), stageOf('plateau'), satTimeline('2026-08-01'), ASOF).alerts;
    expect(draft).toHaveLength(1);
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', draft)).toEqual({ inserted: 1, updated: 0 });
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', draft)).toEqual({ inserted: 0, updated: 1 });
    const listed = FarmAlerts.parse(await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF)).alerts.filter((a) => a.type === 'satellite');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ origin: 'rule', validFrom: '2026-10-27', source: { url: `https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items/${s2Id('2026-10-27')}` } });
  });

  const weatherBody = () => JSON.stringify(JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json', import.meta.url), 'utf8')).body);
  async function satelliteFarm(lat: number, lon: number) {
    await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'");
    const id = await createFarm(owner, { location: { districtName: 'Hassan', stateId: 'IN-KA', precision: 'approximate', lat, lon } });
    const ownerId = await ownerOf(id);
    await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { ...maizeCycle, cycles: [{ id: 'c1', cropId: 'maize', sowingDate: recent(70), stage: 'growing' }] } });
    await h.pool.query('UPDATE farm_monitors SET meta_enabled=false WHERE farm_id=$1', [id]); // no news review in these tests
    return { id, ownerId };
  }

  it('the live monitor reads the field series, runs the reader and the rule, and stores one alert per scene', async () => {
    const { id, ownerId } = await satelliteFarm(13.31, 76.41);
    // Synthetic scenes relative to today: green-up, then a field-only fall on the latest clear scene.
    const at = (n: number, field: FakeScene['field'], neighbourhood?: FakeScene['neighbourhood']): FakeScene => ({ id: s2Id(recent(n)), datetime: `${recent(n)}T05:22:29Z`, field, ...(neighbourhood ? { neighbourhood } : {}) });
    const scenes = [at(52, { ndvi: 0.3 }, { ndvi: 0.5 }), at(42, { ndvi: 0.45 }, { ndvi: 0.55 }), at(32, { ndvi: 0.6 }, { ndvi: 0.58 }), at(22, { ndvi: 0.7 }, { ndvi: 0.6 }), at(12, { ndvi: 0.72 }, { ndvi: 0.6 }), at(7, 'cloudy', { ndvi: 0.6 }), at(2, { ndvi: 0.5 }, { ndvi: 0.59 })];
    const sat = fakePlanetary(scenes);
    const routed = vi.fn(async (url: string, init: RequestInit) => (String(url).startsWith(PC_ORIGIN) ? sat.fetchImpl(url, init as never) : new Response(weatherBody(), { status: 200 })));
    const handler = createMonitorHandler({ config: liveConfig(), pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: routed as unknown as typeof fetch });
    const run = async () => (await handler(await job(ownerId, id), { ...ctx, pool: h.pool })) as { status: string; alerts: { satellite: number; notes: string[] } };
    const first = await run();
    expect(first.status).toBe('checked');
    // Bound: one STAC list (uncached) plus field and neighbourhood reads for at most 4 new scenes.
    expect(sat.calls.length).toBeLessThanOrEqual(9);
    expect(sat.calls.filter((c) => c.path === '/api/data/v1/item/feature.npy').length).toBe(8);
    expect(first.alerts.notes.filter((n) => n.startsWith('satellite_'))).toEqual([]);
    expect(first.alerts.satellite).toBe(1);
    const callsAfterFirst = sat.calls.length;
    const second = await run(); // the next run analyses the remaining 3 scenes; the same latest scene updates in place
    expect(sat.calls.length - callsAfterFirst).toBe(6);
    expect(second.alerts.satellite).toBe(1);
    expect(second.alerts.notes.filter((n) => n.startsWith('satellite_'))).toEqual([]);
    const listed = (await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString())).alerts.filter((a) => a.type === 'satellite');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ origin: 'rule', severity: 'watch', validFrom: recent(2), validTo: addDays(recent(2), 10), source: { url: `https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items/${s2Id(recent(2))}`, date: recent(2) } });
    expect(listed[0]!.detail).toContain(`Field NDVI fell from 0.72 on ${recent(12)} to 0.50 on ${recent(2)}`);
  });

  it('a provider failure in the satellite step becomes a note and the job still succeeds', async () => {
    const { id, ownerId } = await satelliteFarm(13.41, 76.51);
    const routed = vi.fn(async (url: string) => {
      if (String(url).startsWith(PC_ORIGIN)) throw new Error('planetary computer down');
      return new Response(weatherBody(), { status: 200 });
    });
    const handler = createMonitorHandler({ config: liveConfig(), pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: routed as unknown as typeof fetch });
    const result = (await handler(await job(ownerId, id), { ...ctx, pool: h.pool })) as { status: string; alerts: { satellite: number; notes: string[] } };
    expect(result).toMatchObject({ status: 'checked', alerts: { satellite: 0 } });
    expect(result.alerts.notes).toContain('satellite_check_skipped:provider_unreachable');
    expect(routed.mock.calls.some(([url]) => String(url).startsWith(PC_ORIGIN))).toBe(true);
    expect((await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString())).alerts.filter((a) => a.type === 'satellite')).toEqual([]);
  });
});
