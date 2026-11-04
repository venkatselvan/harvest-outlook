import { FarmSummary as summarySchema, type FarmSummary } from '@harvest/contracts';
import { apiRequest, jsonInit } from '../../features/photo-region/http';
import { ApiError } from '../../lib/api';

export type SummaryEntry = {
  status: 'loading' | 'ready' | 'error';
  summary?: FarmSummary;
  busy?: boolean;
  error?: string;
  pollingStopped?: boolean;
};
export type SummaryLoads = Record<string, SummaryEntry>;
type Method = 'GET' | 'POST';
export type SummaryTransport = (id: string, method: Method, signal: AbortSignal) => Promise<unknown>;
export type SummaryScheduler = {
  set: (callback: () => void, delay: number) => unknown;
  clear: (handle: unknown) => void;
};
const scheduler: SummaryScheduler = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export async function requestFarmSummary(id: string, method: Method, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<unknown> {
  const init = method === 'POST' ? { ...jsonInit('POST', {}), signal } : { method, signal };
  return (await apiRequest<unknown>(`/api/v1/farms/${encodeURIComponent(id)}/summary`, init, fetchImpl)).data;
}
const transport: SummaryTransport = requestFarmSummary;

/** Known API categories become actionable messages; internal/provider details never appear in the farm card. */
export function summaryError(error: unknown, method: Method): string {
  if (error instanceof ApiError) {
    if (error.code === 'network_error') return 'Could not reach the server. Check your connection and retry.';
    if (error.status === 429) return 'The summary request limit has been reached. Try again later.';
    if (error.status === 401 || error.status === 403) return 'Your session needs refreshing. Reload this page and try again.';
    if (error.status === 404) return 'This farm is no longer available. Refresh your farm list.';
    if (error.status === 400 || error.status === 422) return 'The summary request was rejected. Refresh this page and retry.';
    if (error.status === 503) return 'The summary service is temporarily unavailable. Try again shortly.';
  }
  return method === 'POST' ? 'The AI summary could not be requested. Your farm records are still available.' : 'This farm summary could not load. Try again.';
}

/** One owner-scoped cohort. All reads, generation and polls share two request slots; selecting a farm reprioritizes the queue. */
export function createSummaryLoader(options: {
  ids: readonly string[];
  selected?: string;
  attempted?: Set<string>;
  current: () => boolean;
  publish: (id: string, entry: SummaryEntry) => void;
  request?: SummaryTransport;
  scheduler?: SummaryScheduler;
  now?: () => number;
}) {
  const ids = new Set(options.ids);
  const states = new Map<string, SummaryEntry>();
  const attempted = options.attempted ?? new Set<string>();
  const polls = new Map<string, number>();
  const timers = new Map<string, unknown>();
  const inFlight = new Map<string, AbortController>();
  const queue: { id: string; method: Method; manual: boolean }[] = options.ids.map(id => ({ id, method: 'GET', manual: false }));
  const read = options.request ?? transport, clock = options.scheduler ?? scheduler, now = options.now ?? Date.now;
  let selected = options.selected, running = 0, disposed = false;
  const current = () => !disposed && options.current();
  function publish(id: string, entry: SummaryEntry) {
    if (!current() || !ids.has(id)) return;
    states.set(id, entry);
    options.publish(id, entry);
  }
  function clearTimer(id: string) {
    if (timers.has(id)) clock.clear(timers.get(id));
    timers.delete(id);
  }
  function enqueue(id: string, method: Method, manual = false) {
    if (!current() || !ids.has(id) || queue.some(task => task.id === id) || inFlight.has(id)) return;
    clearTimer(id);
    queue.push({ id, method, manual });
    pump();
  }
  function poll(id: string, summary: FarmSummary) {
    if (summary.status !== 'pending') return;
    const attempts = polls.get(id) ?? 0;
    if (attempts >= 12) {
      publish(id, { status: 'ready', summary, pollingStopped: true });
      return;
    }
    const due = summary.retryAfter ? Date.parse(summary.retryAfter) - now() : 5_000;
    timers.set(id, clock.set(() => {
      timers.delete(id);
      polls.set(id, attempts + 1);
      enqueue(id, 'GET');
    }, Math.max(5_000, Math.min(30_000, Number.isFinite(due) ? due : 5_000))));
  }
  async function run(task: { id: string; method: Method; manual: boolean }) {
    const { id, method } = task;
    const controller = new AbortController();
    inFlight.set(id, controller);
    const previous = states.get(id)?.summary;
    publish(id, previous ? { status: 'ready', summary: previous, busy: true } : { status: 'loading' });
    let next: FarmSummary | undefined;
    try {
      next = summarySchema.parse(await read(id, method, controller.signal));
      if (next.farmId !== id || next.scope !== 'farm') throw Error('Farm summary mismatch');
      if (!current() || controller.signal.aborted) return;
      publish(id, { status: 'ready', summary: next });
    } catch (error) {
      if (current() && !controller.signal.aborted) publish(id, {
        status: 'error', ...(previous ? { summary: previous } : {}),
        error: summaryError(error, method),
      });
    } finally {
      inFlight.delete(id);
      running--;
    }
    if (!current()) return;
    if (next && states.get(id)?.status === 'ready') {
      if (next.status === 'pending') poll(id, next);
      else if (method === 'GET' && next.canGenerate && (!attempted.has(id) || task.manual)) {
        attempted.add(id);
        queue.unshift({ id, method: 'POST', manual: false });
      }
    }
    pump();
  }
  function pump() {
    if (!current()) return;
    while (running < 2 && queue.length) {
      const preferred = queue.findIndex(task => task.id === selected);
      const task = queue.splice(preferred < 0 ? 0 : preferred, 1)[0]!;
      running++;
      void run(task);
    }
  }
  for (const id of options.ids) publish(id, { status: 'loading' });
  pump();
  return {
    prioritize(id: string | undefined) { selected = id; pump(); },
    retry(id: string) { if (!inFlight.has(id)) { polls.set(id, 0); enqueue(id, 'GET', true); } },
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const handle of timers.values()) clock.clear(handle);
      timers.clear();
      for (const controller of inFlight.values()) controller.abort();
    },
  };
}
