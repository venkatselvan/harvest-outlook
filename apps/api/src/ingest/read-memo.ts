/**
 * Short-lived, in-process memo for expensive read-only queries over ingested data (2026-11-05 latency pass).
 *
 * Why: one Today view asked for the same mandi rows up to eight times (one seasonal reference per future week), and
 * Today, monitoring, the market timeline and the assistant briefing of one page load all read the same product
 * history again. Each read moved tens of thousands of rows through Postgres and the single Node thread.
 *
 * Contract:
 * - Concurrent identical reads share one query (in-flight dedupe); a failed read is never kept.
 * - An entry is served for at most `ttlMs` after its query started. Rows ingested by another process (the worker)
 *   therefore become visible within `ttlMs`; an in-process write calls `clear()` and is visible at once.
 * - Callers receive a fresh array; the rows themselves are frozen, so a caller that tried to modify a shared row
 *   would throw instead of corrupting another request's data.
 * - Bounded memory: entries are weighed (row count) and the oldest are evicted above `maxWeight`.
 * - Optional `window` match (non-replay availability cutoffs): an entry made with cutoff c0 also answers a cutoff c
 *   with c0 <= c <= c0 + ttlMs. That is the same staleness bound as the TTL. Replay callers must not use it (their
 *   cutoff is part of the key and must match exactly).
 */
export interface ReadMemoOptions {
  ttlMs: number;
  /** Sum of entry weights kept (rows). */
  maxWeight: number;
  now?: () => number;
}

interface Entry<T> {
  startedAt: number;
  window: number | null;
  weight: number;
  value: Promise<readonly T[]>;
}

export class ReadMemo<T extends object> {
  private readonly entries = new Map<string, Entry<T>>();
  private weight = 0;
  private generation = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly o: ReadMemoOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private usable(e: Entry<T>, at: number, window: number | null): boolean {
    if (at - e.startedAt > this.o.ttlMs) return false;
    if (window === null || e.window === null) return window === e.window;
    return e.window <= window && window - e.window <= this.o.ttlMs;
  }

  private drop(key: string, e: Entry<T>) {
    if (this.entries.get(key) !== e) return;
    this.entries.delete(key);
    this.weight -= e.weight;
  }

  /** Rows for `key`, from the memo or from `load`. `window` is the availability cutoff in ms for window matching, else null. */
  async get(key: string, load: () => Promise<readonly T[]>, window: number | null = null): Promise<T[]> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit && this.usable(hit, at, window)) {
      this.hits++;
      return [...(await hit.value)];
    }
    this.misses++;
    if (hit) this.drop(key, hit);
    const generation = this.generation;
    const entry: Entry<T> = { startedAt: at, window, weight: 0, value: Promise.resolve([]) };
    entry.value = load().then(
      (rows) => {
        for (const r of rows) Object.freeze(r);
        // A clear() while the query ran means a write may have landed after the query's snapshot: do not keep it.
        if (generation !== this.generation) this.drop(key, entry);
        else if (this.entries.get(key) === entry) {
          entry.weight = Math.max(1, rows.length);
          this.weight += entry.weight;
          this.evict();
        }
        return rows;
      },
      (e: unknown) => {
        this.drop(key, entry);
        throw e;
      },
    );
    this.entries.set(key, entry);
    return [...(await entry.value)];
  }

  private evict() {
    // Map iteration order is insertion order: the first entries are the oldest.
    for (const [key, e] of this.entries) {
      if (this.weight <= this.o.maxWeight) break;
      if (e.weight === 0) continue; // still loading
      this.drop(key, e);
    }
  }

  /** Forget everything (an in-process write to the underlying table). Reads already running are not kept. */
  clear() {
    this.generation++;
    this.entries.clear();
    this.weight = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Stable identity of the database behind a pool (a read-only proxy of the same pool shares it); falls back to object identity. */
const anonymous = new WeakMap<object, string>();
let anonymousSeq = 0;
export function databaseKey(pool: object): string {
  const url = (pool as { options?: { connectionString?: unknown } }).options?.connectionString;
  if (typeof url === "string" && url) return url;
  let k = anonymous.get(pool);
  if (!k) {
    k = `pool#${++anonymousSeq}`;
    anonymous.set(pool, k);
  }
  return k;
}
