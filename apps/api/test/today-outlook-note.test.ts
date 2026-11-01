import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {OutlookNote} from '@harvest/contracts';
import {setupHarness, login, type Harness, type Client} from './helpers';
import {Budget} from '../src/services/budget';
import type {TextModelProvider} from '../src/agent/provider';
import {PRICE_OUTLOOK_METHOD, type HarvestPriceOutlook, type PriceTrend} from '../src/services/price-series';
import {
  MAX_NOTE_WORDS, NOTE_MAX_OUTPUT_TOKENS, OUTLOOK_ENQUEUE_INTERVAL_MS, ensureOutlookNote, gateNote, numberTokens, outlookFacts, type OutlookFacts,
} from '../src/services/today/outlook-note';
import {OUTLOOK_NOTE_JOB_TYPE, createOutlookNoteHandler, refreshOutlookNote} from '../src/worker/handlers/outlook-note';
import type {JobRow} from '../src/worker/main';

/**
 * Every price, farm and model answer in this file is SYNTHETIC test data. The Meta provider is a fake; nothing reaches
 * the network.
 */
const HASSAN = {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'};
const NOW = new Date('2026-11-01T04:00:00Z');

function outlook(over: Partial<HarvestPriceOutlook> = {}): HarvestPriceOutlook {
  return {
    productId: 'maize-grain', status: 'available', missingReason: null,
    scope: {level: 'district', requestedLevel: 'district', stateName: 'Karnataka', districtName: 'Hassan', marketCount: 5, marketIds: [], fallbackNote: null},
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'synthetic test prices', limitations: [],
    method: PRICE_OUTLOOK_METHOD, harvestDate: '2027-01-04', harvestWeek: {year: 2027, week: 1}, asOf: '2026-11-01', weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [],
    p10: 19.1, p25: 21.4, p50: 24.6, p75: 27.2, p90: 30.05, annualMean: 22.8, annualWeeks: 150, weeksUsed: 15, observations: 412, marketsUsed: 4, residualCount: 140,
    ...over,
  };
}
const trend = (changePct: number | null): Pick<PriceTrend, 'yoy' | 'scope'> => ({
  scope: {level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 40, marketIds: [], fallbackNote: null},
  yoy: changePct === null ? null : {lastMonthsWithData: 12, priorMonthsWithData: 12, pairedMonths: 12, lastMean: 24, priorMean: 22, changePct},
});
const HARVEST = {earliest: '2026-12-20', latest: '2027-01-19'};
const factsFor = (over: Partial<HarvestPriceOutlook> = {}, yoy: number | null = 9.4) => outlookFacts({productId: 'maize-grain', productName: 'Maize grain', harvest: HARVEST, outlook: outlook(over), trend: trend(yoy)})!;

// ------------------------------------------------------------------ pure: facts, fallback, gate

describe('outlook facts and the code-written fallback', () => {
  it('builds short facts from the harvest-week reference, rounded like the price card, and a fallback sentence', () => {
    const f = factsFor();
    expect(f.harvestWeek).toBe('2027-W01');
    expect(f.productId).toBe('maize-grain');
    expect(f.facts).toEqual([
      'Product: Maize grain; expected harvest 20 Dec 2026 to 19 Jan 2027 (calendar estimate)',
      'Likely price in the harvest weeks: ₹21 to ₹28 per kg (middle half of past years), typical ₹25 per kg',
      'Harvest weeks usually run 8% above the yearly average price', // 24.6 / 22.8 - 1 = 7.9%
      'Prices in Karnataka over the last 12 months were 9% higher than the 12 months before',
      'Years used: 2023, 2024, 2025 (3 years)',
      'Market scope: Hassan district mandi prices (district pool, 4 markets)',
      'Observations: 412 mandi price quotes in those weeks',
      'Wholesale mandi modal prices, not farm-gate prices; a seasonal reference from past years, not a forecast',
    ]);
    expect(f.facts.every((x) => x.length <= 200)).toBe(true);
    expect(f.fallback).toBe('Prices for maize grain around the harvest weeks have ranged ₹21 to ₹28 per kg over the last 3 years in Hassan district.');
    expect(f.contextHash).toMatch(/^[0-9a-f]{64}$/);
    // The fallback itself passes the gate (every number comes from a fact).
    expect(gateNote({text: f.fallback}, f.facts)).toEqual({ok: true, text: f.fallback});
  });

  it('state scope, below-average harvest weeks, no year-on-year, low prices with one decimal', () => {
    const f = outlookFacts({productId: 'tomato-fresh', productName: 'Tomato', harvest: {earliest: '2027-02-01', latest: '2027-02-10'}, trend: null, outlook: outlook({
      productId: 'tomato-fresh', scope: {level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 46, marketIds: [], fallbackNote: null},
      p25: 6.42, p50: 7.9, p75: 9.31, annualMean: 9.4, yearsUsed: [2024, 2025], harvestWeek: {year: 2027, week: 6},
    })})!;
    expect(f.facts[0]).toBe('Product: Tomato; expected harvest 1 Feb to 10 Feb 2027 (calendar estimate)');
    expect(f.facts[1]).toBe('Likely price in the harvest weeks: ₹6.4 to ₹9.4 per kg (middle half of past years), typical ₹7.9 per kg');
    expect(f.facts[2]).toBe('Harvest weeks usually run 16% below the yearly average price');
    expect(f.facts.some((x) => x.includes('12 months'))).toBe(false);
    expect(f.fallback).toBe('Prices for tomato around the harvest weeks have ranged ₹6.4 to ₹9.4 per kg over the last 2 years in Karnataka.');
    expect(f.harvestWeek).toBe('2027-W06');
  });

  it('no facts without an available harvest-week range; the hash changes when any fact changes', () => {
    expect(outlookFacts({productId: 'x', productName: 'X', harvest: HARVEST, trend: null, outlook: outlook({status: 'insufficient', missingReason: 'price_history_insufficient', p25: null, p50: null, p75: null})})).toBeNull();
    expect(factsFor().contextHash).toBe(factsFor().contextHash);
    expect(factsFor({observations: 413}).contextHash).not.toBe(factsFor().contextHash);
    expect(factsFor({}, -3).contextHash).not.toBe(factsFor().contextHash);
  });
});

describe('the digit gate', () => {
  const f = factsFor();
  it('accepts numbers copied from the facts', () => {
    const text = 'Maize grain in Hassan has usually fetched ₹21 to ₹28 per kg around harvest, about 8% above the yearly average. Prices this year ran 9% higher.';
    expect(gateNote({text}, f.facts)).toEqual({ok: true, text});
    expect(gateNote({text: '  Over 2023, 2024 and 2025, harvest weeks ran   8% above average.  '}, f.facts)).toEqual({ok: true, text: 'Over 2023, 2024 and 2025, harvest weeks ran 8% above average.'});
    expect(gateNote({text: 'Harvest weeks usually run close to the yearly average.'}, ['no digits here'])).toMatchObject({ok: true});
  });
  it('rejects any number that is not in a fact: rounded, computed, re-formatted or another script', () => {
    for (const text of [
      'Prices usually run ₹21 to ₹27 per kg.', // 27 is not a fact number (28 is)
      'Expect about ₹24.6 per kg.', // the unrounded p50 is not in the facts
      'Harvest weeks run 8.0% above average.', // 8.0 is not 8
      'In 2026 prices rose 9%.', // checked against the facts without the harvest-window fact, the only one with 2026
      'Prices usually run ₹२१ to ₹28 per kg.', // Devanagari digits
    ]) {
      const r = gateNote({text}, text.includes('2026') ? f.facts.slice(1) : f.facts);
      expect(r, text).toEqual({ok: false, reason: 'digit_not_in_facts'});
    }
    expect(numberTokens('₹1,200 and 8.5 or 3')).toEqual(['1200', '8.5', '3']);
  });
  it('rejects more than two sentences, more than 45 words, links, empty text and schema mismatches', () => {
    expect(gateNote({text: 'One. Two. Three.'}, f.facts)).toEqual({ok: false, reason: 'too_many_sentences'});
    expect(gateNote({text: Array.from({length: MAX_NOTE_WORDS + 1}, () => 'word').join(' ')}, f.facts)).toEqual({ok: false, reason: 'too_many_words'});
    expect(gateNote({text: 'See www.example.test for prices.'}, f.facts)).toEqual({ok: false, reason: 'link_in_text'});
    expect(gateNote({text: '   '}, f.facts)).toEqual({ok: false, reason: 'empty'});
    expect(gateNote({text: 'x', extra: 1}, f.facts)).toEqual({ok: false, reason: 'schema_mismatch'});
    expect(gateNote('Prices ran ₹21.', f.facts)).toEqual({ok: false, reason: 'schema_mismatch'});
  });
});

// ------------------------------------------------------------------ storage, enqueue-once, handler

let h: Harness, owner: Client, stranger: Client;
let farmId: string, ownerId: string, strangerId: string;
const live = () => ({...h.config, RUNTIME_MODE: 'live' as const, MODEL_API_KEY: 'fixture-key'});
const ensureArgs = (facts: OutlookFacts, over: {ownerId?: string} = {}) => ({ownerId: over.ownerId ?? ownerId, farmId, facts, productName: 'Maize grain', districtName: 'Hassan', stateName: 'Karnataka'});
const rows = async () => (await h.pool.query<{id: string; status: string; text: string | null; job_id: string | null; context_hash: string; facts: string[]; invocation: Record<string, unknown> | null}>(
  'SELECT id,status,text,job_id,context_hash,facts,invocation FROM farm_outlook_notes WHERE farm_id=$1 ORDER BY created_at', [farmId])).rows;
const jobs = async () => (await h.pool.query<{id: string; idempotency_key: string; max_attempts: number; payload: {noteId: string; farmId: string}; state: string}>(
  'SELECT id,idempotency_key,max_attempts,payload,state FROM jobs WHERE type=$1 AND payload->>\'farmId\'=$2 ORDER BY created_at', [OUTLOOK_NOTE_JOB_TYPE, farmId])).rows;
const jobRow = async (id: string): Promise<JobRow> => (await h.pool.query<JobRow>('SELECT id,owner_id,type,attempt,max_attempts,payload FROM jobs WHERE id=$1', [id])).rows[0]!;
const ctx = () => ({heartbeat: async () => undefined, pool: h.pool, isCancelled: async () => false});

async function createFarm(client: Client, name: string) {
  const res = await client.call('POST', '/api/v1/farms', {payload: {name, location: HASSAN}});
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
const ownerOf = async (id: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0]!.owner_id;

function fakeMeta(answer: string | ((input: string) => string) | 'fail') {
  const calls: {input: string; store: unknown; effort: unknown; maxOutputTokens: number; schemaName: string | undefined; instructions: string}[] = [];
  const provider: TextModelProvider & {deleteResponse: ReturnType<typeof vi.fn>} = {
    kind: 'meta', provenance: 'meta_live', billable: false,
    call: vi.fn(async (req) => {
      calls.push({input: String(req.input), store: req.store, effort: req.reasoningEffort, maxOutputTokens: req.maxOutputTokens, schemaName: req.textFormat?.name, instructions: req.instructions});
      if (answer === 'fail') return {ok: false as const, error: {code: 'provider_error' as const, message: 'synthetic failure', retryable: false, outcomeUncertain: false, requestId: null, retries: 0}};
      const text = typeof answer === 'function' ? answer(String(req.input)) : answer;
      return {ok: true as const, result: {provenance: 'meta_live' as const, responseId: 'resp-note', requestId: 'req-note', model: 'fixture-received-model', outputText: JSON.stringify({text}), functionCalls: [], usage: {inputTokens: 300, outputTokens: 40, cachedInputTokens: 0}, latencyMs: 1, retries: 0}};
    }),
    deleteResponse: vi.fn(async () => ({ok: true, code: null})),
  };
  return {provider, calls};
}

beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  stranger = await login(h.app);
  farmId = await createFarm(owner, 'Outlook note farm');
  ownerId = await ownerOf(farmId);
  strangerId = await ownerOf(await createFarm(stranger, 'Stranger farm'));
}, 60_000);
afterAll(async () => h?.close());

describe('ensureOutlookNote: stored note, one enqueue per farm per hour', () => {
  it('synthetic and replay return the code sentence inline and write nothing', async () => {
    for (const mode of ['synthetic', 'replay'] as const) {
      const note = OutlookNote.parse(await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: mode}, now: () => NOW}, ensureArgs(factsFor())));
      expect(note).toMatchObject({status: 'ready', origin: 'deterministic', text: factsFor().fallback, modelInvocation: null});
    }
    expect(await rows()).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it('a foreign owner gets the code sentence and nothing is written for the farm', async () => {
    const note = await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => NOW}, ensureArgs(factsFor(), {ownerId: strangerId}));
    expect(note).toMatchObject({status: 'ready', origin: 'deterministic'});
    expect(await rows()).toEqual([]);
  });

  it('live: first read queues one job (dedupe key, max_attempts 1), repeats stay pending, other facts within the hour are not queued', async () => {
    const f = factsFor();
    const deps = {pool: h.pool, config: {RUNTIME_MODE: 'live' as const}, now: () => NOW};
    const first = OutlookNote.parse(await ensureOutlookNote(deps, ensureArgs(f)));
    expect(first).toEqual({status: 'pending', text: null, facts: f.facts, origin: null, generatedAt: null, modelInvocation: null});
    const [row] = await rows();
    expect(row).toMatchObject({status: 'pending', text: f.fallback, context_hash: f.contextHash, facts: f.facts});
    const [job] = await jobs();
    expect(job).toMatchObject({idempotency_key: `outlook:${farmId}:maize-grain:2027-W01:${f.contextHash}`, max_attempts: 1, payload: {noteId: row!.id, farmId}, state: 'queued'});
    expect(row!.job_id).toBe(job!.id);
    // Never coordinates in what is stored for the prompt.
    expect(JSON.stringify(row)).not.toMatch(/13\.25|76\.25/);

    // Same facts again (concurrently too): still pending, no second row or job.
    const again = await Promise.all([ensureOutlookNote(deps, ensureArgs(f)), ensureOutlookNote(deps, ensureArgs(f))]);
    expect(again.map((n) => n.status)).toEqual(['pending', 'pending']);
    expect(await rows()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);

    // New facts within the hour: the code sentence, stored with retryAfter one hour after the last enqueue; nothing queued.
    const changed = factsFor({observations: 999});
    const inline = await ensureOutlookNote({...deps, now: () => new Date(NOW.getTime() + 30 * 60_000)}, ensureArgs(changed));
    expect(inline).toMatchObject({status: 'ready', origin: 'deterministic', text: changed.fallback});
    expect(await rows()).toHaveLength(2);
    expect((await rows())[1]).toMatchObject({status: 'ready', job_id: null, text: changed.fallback, invocation: {origin: 'deterministic', failure: 'throttled', retryAfter: new Date(NOW.getTime() + OUTLOOK_ENQUEUE_INTERVAL_MS).toISOString()}});
    expect(await jobs()).toHaveLength(1);

    // After the hour a read re-queues those facts (hour-bucket key) and still returns the stored text.
    const laterAt = new Date(NOW.getTime() + OUTLOOK_ENQUEUE_INTERVAL_MS + 60_000);
    const later = await ensureOutlookNote({...deps, now: () => laterAt}, ensureArgs(changed));
    expect(later).toMatchObject({status: 'ready', origin: 'deterministic', text: changed.fallback});
    expect(await rows()).toHaveLength(2);
    expect((await jobs()).map((j) => j.idempotency_key)).toEqual([`outlook:${farmId}:maize-grain:2027-W01:${f.contextHash}`, `outlook:${farmId}:maize-grain:2027-W01:${changed.contextHash}:r${Math.floor(laterAt.getTime() / OUTLOOK_ENQUEUE_INTERVAL_MS)}`]);
  });

  it('a queued job that ended without writing the row falls back to the code sentence', async () => {
    const changed = factsFor({observations: 999});
    const row = (await rows()).find((r) => r.context_hash === changed.contextHash)!;
    await h.pool.query("UPDATE jobs SET state='failed' WHERE id=$1", [row.job_id]);
    const note = await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => new Date(NOW.getTime() + 2 * OUTLOOK_ENQUEUE_INTERVAL_MS)}, ensureArgs(changed));
    expect(note).toMatchObject({status: 'ready', origin: 'deterministic', text: changed.fallback});
  });
});

describe('today.outlook-note handler (fake Meta provider)', () => {
  it('writes the model sentence when it passes the gate: store false, low effort, the token cap, response deleted, district but no coordinates', async () => {
    const f = factsFor();
    const row = (await rows()).find((r) => r.context_hash === f.contextHash)!;
    const text = 'Maize grain in Hassan district has usually fetched ₹21 to ₹28 per kg around harvest, about 8% above the yearly average.';
    const meta = fakeMeta(text);
    const handler = createOutlookNoteHandler({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: meta.provider});
    const result = await handler(await jobRow(row.job_id!), ctx());
    expect(result).toEqual({status: 'ready', origin: 'model', failure: null});
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toMatchObject({store: false, effort: 'low', maxOutputTokens: NOTE_MAX_OUTPUT_TOKENS, schemaName: 'harvest_outlook_note'});
    const input = JSON.parse(meta.calls[0]!.input) as {product: string; district: string; state: string; facts: string[]};
    expect(input).toEqual({product: 'Maize grain', district: 'Hassan', state: 'Karnataka', facts: f.facts});
    expect(meta.calls[0]!.input).not.toMatch(/13\.25|76\.25|lat|lon/);
    expect(meta.provider.deleteResponse).toHaveBeenCalledWith('resp-note');
    const saved = (await rows()).find((r) => r.id === row.id)!;
    expect(saved).toMatchObject({status: 'ready', text, invocation: {origin: 'model', failure: null, dispatched: true, responseDeleted: true, model: 'fixture-received-model'}});

    // The stored note is now returned for the same facts; a second run of the job does nothing.
    const note = OutlookNote.parse(await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => NOW}, ensureArgs(f)));
    expect(note).toMatchObject({status: 'ready', origin: 'model', text, facts: f.facts});
    expect(await handler(await jobRow(row.job_id!), ctx())).toEqual({status: 'skipped'});
    expect(meta.calls).toHaveLength(1);
  });

  it('a sentence with a number not in the facts, a provider failure, or a missing key keeps the code sentence', async () => {
    const cases: {name: string; deps: (meta: ReturnType<typeof fakeMeta>) => Parameters<typeof createOutlookNoteHandler>[0]; meta: ReturnType<typeof fakeMeta>; failure: string}[] = [
      {name: 'digit', meta: fakeMeta('Expect around ₹27 per kg at harvest.'), deps: (m) => ({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: m.provider}), failure: 'gate_digit_not_in_facts'},
      {name: 'fail', meta: fakeMeta('fail'), deps: (m) => ({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: m.provider}), failure: 'provider_provider_error'},
      {name: 'nokey', meta: fakeMeta('unused'), deps: () => ({config: {...live(), MODEL_API_KEY: undefined}, pool: h.pool, budget: Budget.fromConfig(h.pool, live())}), failure: 'meta_key_missing'},
    ];
    for (const [i, c] of cases.entries()) {
      const f = factsFor({observations: 2000 + i});
      const at = new Date(NOW.getTime() + (10 + i * 2) * OUTLOOK_ENQUEUE_INTERVAL_MS);
      expect((await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => at}, ensureArgs(f))).status, c.name).toBe('pending');
      const row = (await rows()).find((r) => r.context_hash === f.contextHash)!;
      const result = await createOutlookNoteHandler(c.deps(c.meta))(await jobRow(row.job_id!), ctx());
      expect(result, c.name).toEqual({status: 'ready', origin: 'deterministic', failure: c.failure});
      const saved = (await rows()).find((r) => r.id === row.id)!;
      expect(saved, c.name).toMatchObject({status: 'ready', text: f.fallback, invocation: {origin: 'deterministic', failure: c.failure}});
      if (c.name === 'digit') expect(c.meta.provider.deleteResponse).toHaveBeenCalledWith('resp-note');
      if (c.name === 'nokey') expect(c.meta.calls).toHaveLength(0);
      const note = await ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => at}, ensureArgs(f));
      expect(note, c.name).toMatchObject({status: 'ready', origin: 'deterministic', text: f.fallback});
    }
  });

  it('a job for a foreign owner or a deleted farm is cancelled without a call', async () => {
    const meta = fakeMeta('unused');
    const handler = createOutlookNoteHandler({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: meta.provider});
    const row = (await rows())[0]!;
    expect(await handler({id: row.job_id!, owner_id: strangerId, type: OUTLOOK_NOTE_JOB_TYPE, attempt: 1, max_attempts: 1, payload: {noteId: row.id, farmId}}, ctx())).toEqual({status: 'cancelled'});
    expect(await handler({id: row.job_id!, owner_id: null, type: OUTLOOK_NOTE_JOB_TYPE, attempt: 1, max_attempts: 1, payload: {noteId: row.id, farmId}}, ctx())).toEqual({status: 'cancelled', reason: 'owner_missing'});
    expect(meta.calls).toHaveLength(0);
  });

  it('retry: a provider failure is re-asked after an hour while the stored text shows; a gate failure is final; the hourly rule holds', async () => {
    const h0 = (hours: number, minutes = 0) => new Date(NOW.getTime() + hours * OUTLOOK_ENQUEUE_INTERVAL_MS + minutes * 60_000);
    const ensureAt = (facts: OutlookFacts, at: Date) => ensureOutlookNote({pool: h.pool, config: {RUNTIME_MODE: 'live'}, now: () => at}, ensureArgs(facts));
    // Runs the handler, then marks the job finished as the worker loop would (no worker runs in tests).
    const run = async (meta: ReturnType<typeof fakeMeta>, at: Date, jobId: string) => {
      const result = await createOutlookNoteHandler({config: live(), pool: h.pool, budget: Budget.fromConfig(h.pool, live()), provider: meta.provider, now: () => at})(await jobRow(jobId), ctx());
      await h.pool.query("UPDATE jobs SET state='succeeded' WHERE id=$1", [jobId]);
      return result;
    };
    const rowOf = async (facts: OutlookFacts) => (await rows()).find((r) => r.context_hash === facts.contextHash)!;
    const keysFor = async (facts: OutlookFacts) => (await jobs()).map((j) => j.idempotency_key).filter((k) => k.includes(facts.contextHash));

    // 1. Provider failure -> code sentence with retryAfter = +1 h.
    const a = factsFor({observations: 3001});
    expect((await ensureAt(a, h0(30))).status).toBe('pending');
    expect(await run(fakeMeta('fail'), h0(30, 1), (await rowOf(a)).job_id!)).toEqual({status: 'ready', origin: 'deterministic', failure: 'provider_provider_error'});
    expect((await rowOf(a)).invocation).toMatchObject({retryAfter: h0(31, 1).toISOString(), retrying: false});
    // Before retryAfter: stored text, no new job. After: stored text, one retry job with an hour-bucket key.
    expect(await ensureAt(a, h0(30, 50))).toMatchObject({status: 'ready', origin: 'deterministic', text: a.fallback});
    expect(await keysFor(a)).toHaveLength(1);
    expect(await ensureAt(a, h0(31, 2))).toMatchObject({status: 'ready', origin: 'deterministic', text: a.fallback});
    const retryKey = `outlook:${farmId}:maize-grain:2027-W01:${a.contextHash}:r${Math.floor(h0(31, 2).getTime() / OUTLOOK_ENQUEUE_INTERVAL_MS)}`;
    expect(await keysFor(a)).toEqual([`outlook:${farmId}:maize-grain:2027-W01:${a.contextHash}`, retryKey]);
    expect((await rowOf(a)).invocation).toMatchObject({retrying: true, retryAfter: null});
    // A second read in the same hour does not queue again.
    await ensureAt(a, h0(31, 30));
    expect(await keysFor(a)).toHaveLength(2);
    // The retry job writes the model sentence; it is then final.
    const text = 'Maize grain in Hassan district has usually fetched ₹21 to ₹28 per kg around harvest.';
    expect(await run(fakeMeta(text), h0(31, 3), (await rowOf(a)).job_id!)).toEqual({status: 'ready', origin: 'model', failure: null});
    expect(await ensureAt(a, h0(40))).toMatchObject({status: 'ready', origin: 'model', text});
    expect(await keysFor(a)).toHaveLength(2);

    // 2. Gate failure (Meta answered, text rejected) is final for that hash.
    const b = factsFor({observations: 3002});
    expect((await ensureAt(b, h0(50))).status).toBe('pending');
    expect(await run(fakeMeta('Expect ₹27 per kg.'), h0(50, 1), (await rowOf(b)).job_id!)).toEqual({status: 'ready', origin: 'deterministic', failure: 'gate_digit_not_in_facts'});
    expect((await rowOf(b)).invocation).toMatchObject({retryAfter: null});
    expect(await ensureAt(b, h0(60))).toMatchObject({status: 'ready', origin: 'deterministic', text: b.fallback});
    expect(await keysFor(b)).toHaveLength(1);

    // 3. Throttle: a second product-week hash within the hour is stored with retryAfter = last enqueue + 1 h.
    const c = factsFor({observations: 3003}), d = factsFor({observations: 3004});
    expect((await ensureAt(c, h0(70))).status).toBe('pending');
    expect(await ensureAt(d, h0(70, 10))).toMatchObject({status: 'ready', origin: 'deterministic', text: d.fallback});
    expect((await rowOf(d)).invocation).toMatchObject({failure: 'throttled', retryAfter: h0(71).toISOString()});
    expect(await keysFor(d)).toEqual([]);
    expect(await ensureAt(d, h0(70, 59))).toMatchObject({text: d.fallback});
    expect(await keysFor(d)).toEqual([]);
    await ensureAt(d, h0(71, 1));
    expect(await keysFor(d)).toEqual([`outlook:${farmId}:maize-grain:2027-W01:${d.contextHash}:r${Math.floor(h0(71, 1).getTime() / OUTLOOK_ENQUEUE_INTERVAL_MS)}`]);
  });

  it('the monitor refresh hook is live-only and reports a missing price range without queueing', async () => {
    expect(await refreshOutlookNote({config: {...h.config, RUNTIME_MODE: 'synthetic'}, pool: h.pool}, ownerId, farmId, NOW.toISOString())).toBe('live_mode_required');
    // This farm has no crop cycle in the test database.
    expect(await refreshOutlookNote({config: live(), pool: h.pool}, ownerId, farmId, NOW.toISOString())).toBe('no_current_product');
    expect(await refreshOutlookNote({config: live(), pool: h.pool}, strangerId, farmId, NOW.toISOString())).toBe('farm_missing');
  });
});
