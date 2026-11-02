import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {TodayOverview, TodayView, type FarmAlert, type UpcomingStep, type WeatherPoint} from '@harvest/contracts';
import {setupHarness, login, type Harness, type Client} from './helpers';
import {Budget} from '../src/services/budget';
import type {TextModelProvider} from '../src/agent/provider';
import {OUTLOOK_ENQUEUE_INTERVAL_MS} from '../src/services/today/outlook-note';
import {
  MAX_FACTS, OVERVIEW_INSTRUCTIONS, OVERVIEW_MAX_OUTPUT_TOKENS, deterministicOverview, ensureTodayOverview, gateOverview, overviewFacts, type OverviewFactSet,
} from '../src/services/today/overview';
import {TODAY_OVERVIEW_JOB_TYPE, createTodayOverviewHandler} from '../src/worker/handlers/today-overview';
import type {JobRow} from '../src/worker/main';

/**
 * Today overview tests (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 9). Every farm, step, alert, forecast, price, profit and
 * model answer here is SYNTHETIC test data; the Meta provider is a fake and nothing reaches the network.
 */
const TODAY = '2026-11-01';
const NOW = new Date('2026-11-01T04:00:00Z');
const FARM = '11111111-1111-4111-8111-111111111111';
const ALERT_A = '22222222-2222-4222-8222-222222222222';
const ALERT_B = '33333333-3333-4333-8333-333333333333';
const ALERT_C = '44444444-4444-4444-8444-444444444444';

const step = (id: string, kind: UpcomingStep['kind'], title: string, dueFrom: string, dueTo: string, status: UpcomingStep['status']): UpcomingStep =>
  ({id, kind, title, detail: null, dueFrom, dueTo, status, careTask: null, alertId: null});
const alert = (id: string, severity: FarmAlert['severity'], title: string, validFrom: string, suggestedStep: string | null = null): FarmAlert => ({
  id, farmId: FARM, type: 'crop_threat', severity, origin: 'rule', title, detail: 'Synthetic alert.', source: {name: 'Synthetic', url: 'https://example.test/a', date: '2026-10-30'},
  validFrom, validTo: '2026-11-15', suggestedStep, createdAt: '2026-10-30T00:00:00.000Z',
});
const wx = (date: string, kind: WeatherPoint['kind'], rainMm: number | null, tMaxC: number | null): WeatherPoint => ({date, kind, rainMm, tMinC: 20, tMaxC, basis: {source: 'synthetic', issuedAt: null, years: null}});
const NEXT = step('care:top-dress', 'care_task', 'Top dress nitrogen', '2026-10-31', '2026-11-06', 'due');
const OVERDUE = step('care:weed', 'care_task', 'First weeding', '2026-10-20', '2026-10-25', 'overdue');
const TRANSITION = step('stage:c:mid', 'stage_transition', 'Mid season expected to start', '2026-11-10', '2026-11-10', 'upcoming');
const NUM = (central: number, low: number, high: number) => ({central, likely: {low, high}, possible: {low: low - 5000, high: high + 5000}});

/** A contract-valid synthetic Today view for a maize cycle in Hassan (numbers invented). */
function view(over: Partial<TodayView> = {}): TodayView {
  return TodayView.parse({
    farmId: FARM, asOf: NOW.toISOString(), today: TODAY,
    cycle: {id: 'cycle-maize', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', sowingDate: '2026-09-01', establishmentDate: '2026-09-01', establishmentMethod: 'direct_sowing', stage: 'growing'},
    product: {productId: 'maize-grain', productName: 'Maize grain', cropName: 'Maize'},
    timeline: {
      cropId: 'maize', productId: 'maize-grain', establishmentMethod: 'direct_sowing', anchorDate: '2026-09-01',
      stages: [
        {id: 'initial', name: 'Initial', from: '2026-09-01', to: '2026-09-20', basis: 'fao_generic'},
        {id: 'development', name: 'Development', from: '2026-09-21', to: '2026-11-09', basis: 'fao_generic'},
        {id: 'mid', name: 'Mid season', from: '2026-11-10', to: '2026-12-10', basis: 'fao_generic'},
      ],
      harvest: {earliest: '2026-12-15', latest: '2026-12-20'},
      basis: {kind: 'duration', label: 'synthetic', sourceId: null, url: null, scope: null, note: null},
    },
    slider: {from: '2026-09-01', to: '2026-12-20', todayProgress: 0.55}, daysToHarvest: {earliest: 44, latest: 49},
    scenes: [], ndvi: null,
    health: {date: '2026-10-27', ndviMean: 0.7, neighbourhoodMean: 0.55, typicalRange: null, verdict: 'above_typical', clearFraction: 1, basis: {kind: 'ndvi', label: 'synthetic', sourceId: null, url: null, scope: null, note: null}},
    priceTrack: [
      {date: '2026-10-19', kind: 'observed', p50: 21, range: null, unit: 'INR/kg'},
      {date: '2026-10-26', kind: 'observed', p50: 22.4, range: null, unit: 'INR/kg'},
      {date: '2026-11-02', kind: 'reference', p50: 30, range: null, unit: 'INR/kg'},
    ],
    harvestPrice: {p50: 25, range: {low: 21.4, high: 27.2}, status: 'available', reason: null, scopeLabel: 'synthetic'},
    weatherTrack: [wx('2026-11-01', 'forecast', 9, 33), wx('2026-11-02', 'forecast', 12, 31), wx('2026-11-03', 'forecast', 15.4, 30), wx('2026-11-04', 'forecast', 4.2, 29), wx('2026-11-05', 'forecast', 50, 35)],
    alerts: [alert(ALERT_A, 'info', 'Market fee notice', '2026-10-28'), alert(ALERT_B, 'warning', 'Fall armyworm scouting window', '2026-10-30', 'Scout 20 plants per acre for fresh whorl damage.'), alert(ALERT_C, 'watch', 'Heavy rain watch', '2026-11-02')],
    newsReview: null, imdStatus: 'not_connected',
    upcoming: [OVERDUE, NEXT, TRANSITION], nextAction: NEXT, outlookNote: null, indexStage: null,
    harvestEconomics: {
      status: 'available', reason: null, harvest: {earliest: '2026-12-15', latest: '2026-12-20'}, harvestDate: '2026-12-17', fieldAreaHa: 1.2,
      yieldKgPerHa: {low: 2900, high: 3200}, yieldBasis: 'state', yieldForFieldKg: {low: 3480, high: 3840}, keepFraction: 1,
      price: {status: 'available', unit: 'INR/kg', p50: 25, likely: {low: 21.4, high: 27.2}, scopeLabel: 'synthetic'}, cost: null,
      revenuePerHa: null, revenueForField: null, profitPerHa: NUM(23000, 15000, 31000), profitForField: NUM(27600, 18000, 37200), basis: [], limitations: [],
    },
    residueIncome: null, energyFootprint: null, carbonFootprint: null,
    monitoring: {enabled: true, lastCheckedAt: null, nextCheckAt: null}, limitations: [],
    ...over,
  });
}

// ------------------------------------------------------------------ facts

describe('overviewFacts', () => {
  it('builds the facts in the spec order with refs to the step, alert and card', () => {
    const set = overviewFacts(view())!;
    expect(set.facts.map((f) => f.id)).toEqual(['stage', 'harvest', 'next', 'overdue', 'stage_next', 'alert1', 'alert2', 'weather3', 'price', 'profit', 'health']);
    const by = Object.fromEntries(set.facts.map((f) => [f.id, f]));
    expect(by.stage).toEqual({id: 'stage', text: 'Day 62 of the season since establishment; stage today: Development (calendar estimate, not an observation)', ref: {kind: 'card', id: 'harvest'}});
    expect(by.harvest!.text).toBe('Harvest in 44 to 49 days, expected 15 Dec to 20 Dec (calendar estimate)');
    expect(by.next).toEqual({id: 'next', text: 'Next step: Top dress nitrogen, due 31 Oct to 6 Nov (due now)', ref: {kind: 'step', id: NEXT.id}});
    expect(by.overdue).toEqual({id: 'overdue', text: '1 step is overdue', ref: {kind: 'step', id: OVERDUE.id}});
    expect(by.stage_next!.ref).toEqual({kind: 'step', id: TRANSITION.id});
    // Highest severity first: warning, then watch; the info alert is not listed.
    expect(by.alert1).toMatchObject({ref: {kind: 'alert', id: ALERT_B}, text: 'Alert (warning): Fall armyworm scouting window, 30 Oct to 15 Nov; suggested: Scout 20 plants per acre for fresh whorl damage.'});
    expect(by.alert2!.ref).toEqual({kind: 'alert', id: ALERT_C});
    // Next three days = 2 to 4 Nov forecasts: 12 + 15.4 + 4.2 = 31.6 -> 32 mm; highest 31 °C (today and 5 Nov excluded).
    expect(by.weather3).toEqual({id: 'weather3', text: 'Rain 32 mm expected over the next 3 days, high 31°C (forecast)', ref: {kind: 'card', id: 'weather'}});
    expect(by.price!.text).toBe('Harvest-week price in past years: ₹21 to ₹28 per kg, typical ₹25 (mandi reference, not a forecast); the harvest-week reference is above the latest weekly price of ₹22 (week of 26 Oct)');
    expect(by.profit!.text).toBe('Expected profit for the field at harvest: about ₹27,600 (likely ₹18,000 to ₹37,200), from regional yield, price and cost references');
    expect(by.health!.text).toBe('Satellite image of 27 Oct: the field is greener than the surrounding area (NDVI 0.70 vs 0.55)');
    expect(set.facts.every((f) => f.text.length <= 240)).toBe(true);
    expect(set.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(overviewFacts(view())!.contextHash).toBe(set.contextHash);
    expect(overviewFacts(view({daysToHarvest: {earliest: 43, latest: 48}}))!.contextHash).not.toBe(set.contextHash);
  });

  it('each fact only when its input exists; at most 16; null without a crop', () => {
    const bare = overviewFacts(view({nextAction: null, upcoming: [], alerts: [], weatherTrack: [], harvestPrice: null, harvestEconomics: null, health: null}))!;
    expect(bare.facts.map((f) => f.id)).toEqual(['stage', 'harvest']);
    expect(overviewFacts(view())!.facts.length).toBeLessThanOrEqual(MAX_FACTS);
    expect(overviewFacts(view({cycle: null, product: null, timeline: null, daysToHarvest: null}))).toBeNull();
  });
});

// ------------------------------------------------------------------ code-written overview and the gate

describe('deterministic overview and gateOverview', () => {
  const set = overviewFacts(view())!;
  it('the code-written overview is built from the facts and passes the same gate', () => {
    const d = deterministicOverview(set);
    expect(d.headline).toBe('Maize, Development: harvest in 44 to 49 days.');
    expect(d.points.map((p) => [p.kind, p.factIds, p.ref])).toEqual([
      ['do_now', ['next'], {kind: 'step', id: NEXT.id}],
      ['watch', ['alert1'], {kind: 'alert', id: ALERT_B}],
      ['money', ['profit'], {kind: 'card', id: 'profit'}],
      ['later', ['stage_next'], {kind: 'step', id: TRANSITION.id}],
      ['good_news', ['health'], {kind: 'card', id: 'health'}],
    ]);
    expect(d.points[0]!.text).toBe('Do next: Top dress nitrogen, due 31 Oct to 6 Nov.');
    expect(gateOverview({headline: d.headline, points: d.points.map(({kind, text, factIds}) => ({kind, text, factIds}))}, set.facts)).toMatchObject({ok: true, headline: d.headline, points: d.points, dropped: 0});
    // Without an alert the watch point is the weather; without the profit the money point is the price.
    const alt = overviewFacts(view({alerts: [], harvestEconomics: null}))!;
    const a = deterministicOverview(alt);
    expect(a.points.map((p) => p.factIds[0])).toEqual(['next', 'weather3', 'price', 'stage_next', 'health']);
    expect(gateOverview({headline: a.headline, points: a.points.map(({kind, text, factIds}) => ({kind, text, factIds}))}, alt.facts).ok).toBe(true);
  });

  it('accepts a model answer whose numbers come from the cited facts; orders the points; ref = first cited fact', () => {
    const r = gateOverview({headline: 'Top dress before the rain: harvest in 44 to 49 days', points: [
      {kind: 'money', text: 'At about ₹27,600 for the field, a good top dressing protects your profit.', factIds: ['profit', 'next']},
      {kind: 'do_now', text: 'Top dress by 6 Nov; 32 mm of rain is due over the next 3 days, so do it before the rain washes it out.', factIds: ['next', 'weather3']},
    ]}, set.facts);
    expect(r).toMatchObject({ok: true, dropped: 0});
    if (!r.ok) return;
    expect(r.points.map((p) => p.kind)).toEqual(['do_now', 'money']);
    expect(r.points[0]!.ref).toEqual({kind: 'step', id: NEXT.id});
  });

  it('a number not in the cited facts rejects the answer; a bad factId drops the point; all dropped rejects', () => {
    // 32 is in weather3, not in the cited next fact.
    expect(gateOverview({headline: 'Today', points: [{kind: 'do_now', text: 'Top dress now; 32 mm of rain is coming.', factIds: ['next']}]}, set.facts)).toEqual({ok: false, reason: 'digit_not_in_facts'});
    expect(gateOverview({headline: 'Harvest in 45 days', points: [{kind: 'do_now', text: 'Top dress now.', factIds: ['next']}]}, set.facts)).toEqual({ok: false, reason: 'digit_not_in_facts'});
    expect(gateOverview({headline: 'Today', points: [{kind: 'do_now', text: 'Top dress by ६ Nov.', factIds: ['next']}]}, set.facts)).toEqual({ok: false, reason: 'digit_not_in_facts'});
    const dropped = gateOverview({headline: 'Today', points: [{kind: 'watch', text: 'Look out.', factIds: ['nope']}, {kind: 'do_now', text: 'Top dress now.', factIds: ['next', 'nope']}]}, set.facts);
    expect(dropped).toMatchObject({ok: true, dropped: 1, points: [{kind: 'do_now', factIds: ['next']}]});
    expect(gateOverview({headline: 'Today', points: [{kind: 'watch', text: 'Look out.', factIds: ['nope']}]}, set.facts)).toEqual({ok: false, reason: 'all_points_dropped'});
    expect(gateOverview({headline: 'Today', points: Array.from({length: 6}, () => ({kind: 'do_now', text: 'Top dress.', factIds: ['next']}))}, set.facts)).toEqual({ok: false, reason: 'too_many_points'});
    expect(gateOverview({headline: 'See www.example.test', points: [{kind: 'do_now', text: 'x', factIds: ['next']}]}, set.facts)).toEqual({ok: false, reason: 'link_in_text'});
    expect(gateOverview({headline: 'x', points: [], extra: 1}, set.facts)).toEqual({ok: false, reason: 'schema_mismatch'});
    expect(gateOverview({headline: 'x', points: [{kind: 'urgent', text: 'x', factIds: ['next']}]}, set.facts)).toEqual({ok: false, reason: 'schema_mismatch'});
  });

  it('the instructions carry the spec 9.1 item 3 rules', () => {
    for (const rule of [/"you" form/, /Lead with what to do today and why/, /consequence|what the fact means for the crop or for the money/, /do_now, watch, money, later, good_news/, /factIds/, /never add a date, price, product/i, /no links/]) expect(OVERVIEW_INSTRUCTIONS).toMatch(rule);
  });
});

// ------------------------------------------------------------------ storage, mode separation, the hourly rule, handler

let h: Harness, owner: Client;
let farmId: string, ownerId: string;
const live = () => ({...h.config, RUNTIME_MODE: 'live' as const, MODEL_API_KEY: 'fixture-key'});
const rows = async () => (await h.pool.query<{id: string; status: string; headline: string | null; points: unknown[]; job_id: string | null; context_hash: string; invocation: Record<string, unknown> | null}>(
  'SELECT id,status,headline,points,job_id,context_hash,invocation FROM farm_today_overviews WHERE farm_id=$1 ORDER BY created_at', [farmId])).rows;
const jobs = async () => (await h.pool.query<{id: string; idempotency_key: string; max_attempts: number; state: string}>(
  "SELECT id,idempotency_key,max_attempts,state FROM jobs WHERE type=$1 AND payload->>'farmId'=$2 ORDER BY created_at", [TODAY_OVERVIEW_JOB_TYPE, farmId])).rows;
const jobRow = async (id: string): Promise<JobRow> => (await h.pool.query<JobRow>('SELECT id,owner_id,type,attempt,max_attempts,payload FROM jobs WHERE id=$1', [id])).rows[0]!;
const ctx = () => ({heartbeat: async () => undefined, pool: h.pool, isCancelled: async () => false});
const setFor = (over: Partial<TodayView> = {}): OverviewFactSet => overviewFacts(view({...over, farmId}))!;
const args = (set: OverviewFactSet) => ({ownerId, farmId, set, districtName: 'Hassan', stateName: 'Karnataka'});

function fakeMeta(answer: unknown | 'fail') {
  const calls: {input: string; store: unknown; effort: unknown; maxOutputTokens: number; schemaName: string | undefined}[] = [];
  const provider: TextModelProvider & {deleteResponse: ReturnType<typeof vi.fn>} = {
    kind: 'meta', provenance: 'meta_live', billable: false,
    call: vi.fn(async (req) => {
      calls.push({input: String(req.input), store: req.store, effort: req.reasoningEffort, maxOutputTokens: req.maxOutputTokens, schemaName: req.textFormat?.name});
      if (answer === 'fail') return {ok: false as const, error: {code: 'provider_error' as const, message: 'synthetic failure', retryable: false, outcomeUncertain: false, requestId: null, retries: 0}};
      return {ok: true as const, result: {provenance: 'meta_live' as const, responseId: 'resp-ov', requestId: 'req-ov', model: 'fixture-received-model', outputText: JSON.stringify(answer), functionCalls: [], usage: {inputTokens: 600, outputTokens: 200, cachedInputTokens: 0}, latencyMs: 1, retries: 0}};
    }),
    deleteResponse: vi.fn(async () => ({ok: true, code: null})),
  };
  return {provider, calls};
}

beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  const res = await owner.call('POST', '/api/v1/farms', {payload: {name: 'Overview farm', location: {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'}}});
  expect(res.statusCode, res.body).toBe(201);
  farmId = res.json().data.id as string;
  ownerId = (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
}, 60_000);
afterAll(async () => h?.close());

describe('ensureTodayOverview: mode separation, the stored row, one enqueue per farm per hour', () => {
  it('synthetic and replay return the code-written overview inline, never enqueue and never call Meta', async () => {
    const meta = fakeMeta('unused');
    for (const mode of ['synthetic', 'replay'] as const) {
      const o = TodayOverview.parse(await ensureTodayOverview({pool: h.pool, config: {RUNTIME_MODE: mode}, now: () => NOW}, args(setFor())));
      expect(o).toMatchObject({status: 'ready', origin: 'deterministic', modelInvocation: null, headline: deterministicOverview(setFor()).headline});
      expect(o.points).toEqual(deterministicOverview(setFor()).points);
    }
    expect(await rows()).toEqual([]);
    expect(await jobs()).toEqual([]);
    expect(meta.calls).toHaveLength(0);
  });

  it('live: one pending row and one job; the same facts stay pending; changed facts within the hour are code-written and throttled', async () => {
    const deps = {pool: h.pool, config: {RUNTIME_MODE: 'live' as const}, now: () => NOW};
    const set = setFor();
    const first = TodayOverview.parse(await ensureTodayOverview(deps, args(set)));
    expect(first).toMatchObject({status: 'pending', origin: null, headline: deterministicOverview(set).headline});
    const [row] = await rows();
    expect(row).toMatchObject({status: 'pending', context_hash: set.contextHash, headline: deterministicOverview(set).headline});
    const [job] = await jobs();
    expect(job).toMatchObject({idempotency_key: `overview:${farmId}:${set.contextHash}`, max_attempts: 1, state: 'queued'});
    expect(JSON.stringify(row)).not.toMatch(/13\.25|76\.25/);
    const again = await Promise.all([ensureTodayOverview(deps, args(set)), ensureTodayOverview(deps, args(set))]);
    expect(again.map((o) => o.status)).toEqual(['pending', 'pending']);
    expect(await rows()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    const changed = setFor({daysToHarvest: {earliest: 43, latest: 48}});
    const inline = await ensureTodayOverview({...deps, now: () => new Date(NOW.getTime() + 30 * 60_000)}, args(changed));
    expect(inline).toMatchObject({status: 'ready', origin: 'deterministic'});
    expect((await rows())[1]).toMatchObject({status: 'ready', job_id: null, invocation: {failure: 'throttled', retryAfter: new Date(NOW.getTime() + OUTLOOK_ENQUEUE_INTERVAL_MS).toISOString()}});
    expect(await jobs()).toHaveLength(1);
  });

  it('the handler stores a passing model answer with origin model (store false, low effort, response deleted, no coordinates); the stored row is returned for the same hash', async () => {
    const set = setFor();
    const row = (await rows()).find((r) => r.context_hash === set.contextHash)!;
    const answer = {headline: 'Top dress before the rain: harvest in 44 to 49 days', points: [
      {kind: 'do_now', text: 'Top dress by 6 Nov; with 32 mm of rain due over the next 3 days, spread it before the rain so it is not washed out.', factIds: ['next', 'weather3']},
      {kind: 'watch', text: 'Scout 20 plants per acre for fall armyworm: catching whorl damage early protects the yield.', factIds: ['alert1']},
    ]};
    const meta = fakeMeta(answer);
    const handler = createTodayOverviewHandler({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: meta.provider});
    expect(await handler(await jobRow(row.job_id!), ctx())).toEqual({status: 'ready', origin: 'model', failure: null});
    expect(meta.calls[0]).toMatchObject({store: false, effort: 'low', maxOutputTokens: OVERVIEW_MAX_OUTPUT_TOKENS, schemaName: 'today_overview'});
    const input = JSON.parse(meta.calls[0]!.input) as {crop: string; product: string; district: string; state: string; facts: {id: string; text: string}[]};
    expect(input).toEqual({crop: 'Maize', product: 'Maize grain', district: 'Hassan', state: 'Karnataka', facts: set.facts.map((f) => ({id: f.id, text: f.text}))});
    expect(meta.calls[0]!.input).not.toMatch(/13\.25|76\.25|"lat|"lon|care:|stage:c|2222/);
    expect(meta.provider.deleteResponse).toHaveBeenCalledWith('resp-ov');
    const o = TodayOverview.parse(await ensureTodayOverview({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => NOW}, args(set)));
    expect(o).toMatchObject({status: 'ready', origin: 'model', headline: answer.headline});
    expect(o.points.map((p) => [p.kind, p.ref])).toEqual([['do_now', {kind: 'step', id: NEXT.id}], ['watch', {kind: 'alert', id: ALERT_B}]]);
    expect(await handler(await jobRow(row.job_id!), ctx())).toEqual({status: 'skipped'});
    expect(meta.calls).toHaveLength(1);
  });

  it('a rejected answer or a provider failure keeps the code-written overview', async () => {
    for (const [i, c] of [{answer: {headline: 'Harvest in 45 days', points: [{kind: 'do_now', text: 'Top dress.', factIds: ['next']}]}, failure: 'gate_digit_not_in_facts'}, {answer: 'fail', failure: 'provider_provider_error'}].entries()) {
      const set = setFor({daysToHarvest: {earliest: 30 + i, latest: 35 + i}});
      const at = new Date(NOW.getTime() + (10 + i * 2) * OUTLOOK_ENQUEUE_INTERVAL_MS);
      expect((await ensureTodayOverview({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => at}, args(set))).status).toBe('pending');
      const row = (await rows()).find((r) => r.context_hash === set.contextHash)!;
      const meta = fakeMeta(c.answer);
      expect(await createTodayOverviewHandler({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: meta.provider})(await jobRow(row.job_id!), ctx())).toEqual({status: 'ready', origin: 'deterministic', failure: c.failure});
      const o = await ensureTodayOverview({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => at}, args(set));
      expect(o).toMatchObject({status: 'ready', origin: 'deterministic', headline: deterministicOverview(set).headline});
    }
  });
});
