import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FarmAlerts, type FarmWorkspace } from '@harvest/contracts';
import { setupHarness, login, farmBody, type Harness, type Client } from './helpers';
import {
  ALERT_LIMITATIONS, INSTRUCTIONS, addDays, alertFingerprint, gateGroundedAlerts, groundedReview, istDate, listAlerts, loadPriceMoves, persistAlerts, priceMoveFromQuotes,
  structuredAlerts, type AlertDraft, type GroundedTransport, type PriceMove,
} from '../src/services/today/alerts';
import { monitoringSnapshot, type MonitoringSnapshot } from '../src/services/monitoring';
import { enqueueDueMonitors, readMonitorSettings } from '../src/services/monitor-schedule';
import { createMonitorHandler } from '../src/worker/handlers/monitoring';
import { MetaClient } from '../src/providers/meta/client';
import { Budget } from '../src/services/budget';
import { enqueue } from '../src/services/jobs';
import { ensureSource } from '../src/ingest/sources';

/** All farms, quotes, forecasts and provider responses in this file are synthetic test data. */
const ASOF = '2026-11-01T06:00:00Z'; // 11:30 IST, calendar date 2026-11-01
const workspace = (over: Partial<FarmWorkspace> = {}): FarmWorkspace => ({ farmId: randomUUID(), version: 1, updatedAt: null, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [], ...over });
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
