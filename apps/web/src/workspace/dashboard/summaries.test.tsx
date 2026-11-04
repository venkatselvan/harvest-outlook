import { describe, it, expect } from 'vitest';
import { renderToString } from 'solid-js/web';
import type { FarmSummary } from '@harvest/contracts';
import { createSummaryLoader, requestFarmSummary, summaryError, type SummaryEntry, type SummaryScheduler } from './summaries';
import { FarmSummaryHeadline, FarmSummaryPanel, showDeferredRefresh } from './FarmSummary';
import { ApiError } from '../../lib/api';
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const summary = (id = ids[0]!, over: Partial<FarmSummary> = {}): FarmSummary => ({ farmId: id, scope: 'farm', status: 'ready', origin: 'deterministic', headline: 'One saved crop needs a recorded field check.', points: [{ kind: 'do_now', text: 'Review the saved field check.', factIds: ['check'], ref: null }], facts: [{ id: 'check', text: 'One field check is due in the saved schedule.', ref: null }], asOf: '2026-11-03T04:30:00Z', generatedAt: null, canGenerate: false, retryAfter: null, ...over });
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function clock() {
  const jobs = new Map<number, () => void>(); let id = 0;
  const scheduler: SummaryScheduler = { set(callback) { jobs.set(++id, callback); return id; }, clear(handle) { jobs.delete(handle as number); } };
  return { jobs, scheduler, tick() { const first = jobs.entries().next().value; if (first) { jobs.delete(first[0]); first[1](); } } };
}
describe('farm summary request lifecycle', () => {
  it('loads the selected farm first, bounds concurrency to two, and reprioritizes without discarding other farm data', async () => {
    const calls: string[] = [], releases = new Map<string, () => void>(); let active = 0, max = 0;
    const states: Record<string, SummaryEntry> = {};
    const loader = createSummaryLoader({ ids, selected: ids[2]!, current: () => true, publish: (id, state) => { states[id] = state; }, request: async id => {
      calls.push(id); active++; max = Math.max(max, active);
      await new Promise<void>(resolve => releases.set(id, resolve)); active--; return summary(id);
    } });
    expect(calls).toEqual([ids[2], ids[0]]);
    loader.prioritize(ids[3]); releases.get(ids[2]!)!(); await flush();
    expect(calls[2]).toBe(ids[3]);
    expect(states[ids[2]!]!.summary?.farmId).toBe(ids[2]);
    releases.get(ids[0]!)!(); await flush(); releases.get(ids[3]!)!(); releases.get(ids[1]!)!(); await flush();
    expect(max).toBe(2); expect(Object.values(states).every(state => state.status === 'ready')).toBe(true);
    loader.dispose();
  });
  it('drops old session responses, aborts disposal and stops dispatching queued owner reads', async () => {
    let current = true; const published: SummaryEntry[] = [], signals: AbortSignal[] = [], release: (() => void)[] = [];
    const loader = createSummaryLoader({ ids, current: () => current, publish: (_id, state) => published.push(state), request: async (id, _method, signal) => {
      signals.push(signal); await new Promise<void>(resolve => release.push(resolve)); return summary(id);
    } });
    published.length = 0; current = false; loader.dispose(); for (const resolve of release) resolve(); await flush();
    expect(published).toEqual([]); expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it('rejects a mismatched farm response rather than putting it in another farm row', async () => {
    let latest: SummaryEntry | undefined;
    const loader = createSummaryLoader({ ids: [ids[0]!], current: () => true, publish: (_id, state) => { latest = state; }, request: async () => summary(ids[1]) });
    await flush(); expect(latest?.status).toBe('error'); expect(latest?.summary).toBeUndefined(); loader.dispose();
  });
  it('automatically requests at most once per farm mount and polls only while pending', async () => {
    const time = clock(), methods: string[] = []; let latest: SummaryEntry | undefined, gets = 0;
    const loader = createSummaryLoader({ ids: [ids[0]!], current: () => true, scheduler: time.scheduler, publish: (_id, state) => { latest = state; }, request: async (id, method) => {
      methods.push(method);
      if (method === 'POST') return summary(id, { status: 'pending' });
      return summary(id, ++gets === 1 ? { canGenerate: true } : { origin: 'model', generatedAt: '2026-11-03T04:31:00Z', canGenerate: true });
    } });
    await flush(); expect(methods).toEqual(['GET', 'POST']); expect(latest?.summary?.status).toBe('pending');
    time.tick(); await flush(); expect(methods).toEqual(['GET', 'POST', 'GET']); expect(latest?.summary?.origin).toBe('model');
    expect(time.jobs.size).toBe(0); loader.dispose();
  });
  it('does not auto-generate again when the farm cohort changes within the same mount', async () => {
    const attempted = new Set<string>(); const methods: string[] = [];
    const options = { ids: [ids[0]!], attempted, current: () => true, publish: () => undefined, request: async (id: string, method: 'GET' | 'POST') => { methods.push(method); return summary(id, { canGenerate: true }); } };
    const first = createSummaryLoader(options); await flush(); first.dispose();
    const next = createSummaryLoader({ ...options, ids: [ids[0]!, ids[1]!] }); await flush();
    expect(methods.filter(method => method === 'POST')).toHaveLength(2); // once for each of the two distinct farms
    next.dispose();
  });
  it('keeps record fallback on generation failure, retries explicitly, and never loops deferred generation', async () => {
    const time = clock(), methods: string[] = []; let latest: SummaryEntry | undefined, reads = 0;
    const loader = createSummaryLoader({ ids: [ids[0]!], current: () => true, scheduler: time.scheduler, publish: (_id, state) => { latest = state; }, request: async (id, method) => {
      methods.push(method); if (method === 'POST') throw Error('offline');
      return summary(id, { canGenerate: ++reads === 1, retryAfter: '2026-11-03T05:30:00Z' });
    } });
    await flush(); expect(latest?.status).toBe('error'); expect(latest?.summary?.headline).toContain('saved crop'); expect(time.jobs.size).toBe(0);
    loader.retry(ids[0]!); await flush(); expect(latest?.status).toBe('ready'); expect(methods).toEqual(['GET', 'POST', 'GET']); expect(time.jobs.size).toBe(0); loader.dispose();
  });
  it('bounds pending polls and cleans up scheduled polling', async () => {
    const time = clock(); let latest: SummaryEntry | undefined, reads = 0;
    const loader = createSummaryLoader({ ids: [ids[0]!], current: () => true, scheduler: time.scheduler, publish: (_id, state) => { latest = state; }, request: async id => { reads++; return summary(id, { status: 'pending' }); } });
    await flush(); for (let n = 0; n < 15; n++) { time.tick(); await flush(); }
    expect(reads).toBe(13); expect(latest?.pollingStopped).toBe(true); expect(time.jobs.size).toBe(0);
    loader.retry(ids[0]!); await flush(); expect(time.jobs.size).toBe(1); loader.dispose(); expect(time.jobs.size).toBe(0);
  });
});
describe('farm summary presentation', () => {
  const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  it('distinguishes loading, unavailable records and model origin without pretending a fallback is AI', () => {
    expect(text(renderToString(() => <FarmSummaryHeadline entry={{ status: 'loading' }} />))).toContain('Reading farm summary');
    const records = renderToString(() => <FarmSummaryPanel entry={{ status: 'ready', summary: summary() }} onRetry={() => undefined} onActions={() => undefined} />);
    expect(text(records)).toContain('Farm records'); expect(text(records)).not.toContain('AI summary');
    expect(records).toMatch(/<details[^>]*class="af-summary-facts"/); expect(text(records)).toContain('One field check is due');
    const ai = text(renderToString(() => <FarmSummaryPanel entry={{ status: 'ready', summary: summary(ids[0], { origin: 'model', generatedAt: '2026-11-03T04:31:00Z' }) }} onRetry={() => undefined} onActions={() => undefined} />));
    expect(ai).toContain('AI summary'); expect(ai).toContain('Generated');
    const failed = text(renderToString(() => <FarmSummaryPanel entry={{ status: 'error', error: 'Read failed' }} onRetry={() => undefined} onActions={() => undefined} />));
    expect(failed).toContain('Retry summary'); expect(failed).toContain('unavailable');
  });  it('does not label a successfully generated model summary as deferred', () => {
    const ready = summary(ids[0], { origin: 'model', generatedAt: '2026-11-03T04:31:00Z', retryAfter: '2026-11-03T05:30:00Z' });
    expect(showDeferredRefresh(ready)).toBe(false);
    expect(showDeferredRefresh({ ...ready, origin: 'deterministic' })).toBe(true);
    expect(showDeferredRefresh({ ...ready, status: 'unavailable' })).toBe(true);
    expect(showDeferredRefresh({ ...ready, status: 'pending' })).toBe(false);
    const html = text(renderToString(() => <FarmSummaryPanel entry={{ status: 'ready', summary: ready }} onRetry={() => undefined} onActions={() => undefined} />));
    expect(html).toContain('Generated'); expect(html).not.toContain('AI refresh deferred');
  });
  it('shows deferred refresh timing without implying the underlying records were updated', () => {
    const html = text(renderToString(() => <FarmSummaryPanel entry={{ status: 'ready', summary: summary(ids[0], { status: 'unavailable', retryAfter: '2026-11-03T05:30:00Z' }) }} onRetry={() => undefined} onActions={() => undefined} />));
    expect(html).toContain('AI refresh deferred until'); expect(html).toContain('Records checked'); expect(html).not.toContain('Records updated');
  });

});


describe('summary HTTP transport', () => {
  it('POSTs an explicit JSON object and keeps the supplied abort signal; GET stays body-free', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/session') return new Response(JSON.stringify({ data: { authenticated: true, csrfToken: 'summary-test' } }), { status: 200 });
      calls.push({ url, init });
      return new Response(JSON.stringify({ requestId: 'summary-test', mode: 'synthetic', asOf: '2026-11-03T04:30:00Z', data: summary(), warnings: [], error: null }), { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    await requestFarmSummary(ids[0]!, 'POST', controller.signal, fetchImpl);
    await requestFarmSummary(ids[0]!, 'GET', controller.signal, fetchImpl);
    expect(calls[0]!.url).toBe(`/api/v1/farms/${ids[0]}/summary`);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{}', signal: controller.signal });
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json');
    expect(calls[1]!.init?.method).toBe('GET'); expect(calls[1]!.init?.body).toBeUndefined();
  });
  it('explains useful API failures without echoing internal server details', () => {
    expect(summaryError(new ApiError('rate_limited', 'private SQL or provider detail', 429), 'POST')).toContain('request limit');
    expect(summaryError(new ApiError('network_error', 'private detail', 0), 'GET')).toContain('Check your connection');
    expect(summaryError(new ApiError('validation_error', 'private detail', 400), 'POST')).toContain('request was rejected');
    expect(summaryError(new ApiError('internal_error', 'private detail', 500), 'POST')).not.toContain('private');
  });
});
