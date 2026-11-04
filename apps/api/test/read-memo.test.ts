import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "../src/db/pool";
import { ReadMemo } from "../src/ingest/read-memo";
import { clearSharedMarketReads, MARKET_PRICE_COLUMNS, MARKET_READ_TTL_MS, scopedQuery } from "../src/ingest/scope";

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

describe("ReadMemo", () => {
  it("shares one in-flight load between concurrent identical reads", async () => {
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 100 });
    const d = deferred<{ v: number }[]>();
    let loads = 0;
    const load = () => { loads++; return d.promise; };
    const a = memo.get("k", load), b = memo.get("k", load);
    d.resolve([{ v: 1 }]);
    expect(await a).toEqual([{ v: 1 }]);
    expect(await b).toEqual([{ v: 1 }]);
    expect(loads).toBe(1);
  });

  it("expires entries after the TTL", async () => {
    let now = 0;
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 100, now: () => now });
    let loads = 0;
    const load = async () => [{ v: ++loads }];
    expect(await memo.get("k", load)).toEqual([{ v: 1 }]);
    now = 1000;
    expect(await memo.get("k", load)).toEqual([{ v: 1 }]);
    now = 1001;
    expect(await memo.get("k", load)).toEqual([{ v: 2 }]);
  });

  it("freezes shared rows and hands every caller its own array", async () => {
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 100 });
    const first = await memo.get("k", async () => [{ v: 1 }, { v: 2 }]);
    first.reverse();
    const second = await memo.get("k", async () => []);
    expect(second.map((r) => r.v)).toEqual([1, 2]);
    expect(Object.isFrozen(second[0])).toBe(true);
    expect(() => { (second[0] as { v: number }).v = 9; }).toThrow(TypeError);
  });

  it("does not keep a failed load or a load that a clear() overtook", async () => {
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 100 });
    await expect(memo.get("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(memo.size).toBe(0);
    const d = deferred<{ v: number }[]>();
    const running = memo.get("k", () => d.promise);
    memo.clear();
    d.resolve([{ v: 1 }]);
    await running;
    expect(await memo.get("k", async () => [{ v: 2 }])).toEqual([{ v: 2 }]);
  });

  it("matches a window (non-replay cutoff) only within [c0, c0 + ttl]", async () => {
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 100 });
    let loads = 0;
    const load = async () => [{ v: ++loads }];
    await memo.get("k", load, 5000);
    expect(await memo.get("k", load, 5500)).toEqual([{ v: 1 }]);
    expect(await memo.get("k", load, 4999)).toEqual([{ v: 2 }]); // an earlier cutoff never reuses a later read
    expect(await memo.get("k", load, null)).toEqual([{ v: 3 }]); // "no cutoff" never shares with a cutoff read
  });

  it("evicts the oldest entries above the weight bound", async () => {
    const memo = new ReadMemo<{ v: number }>({ ttlMs: 1000, maxWeight: 3 });
    await memo.get("a", async () => [{ v: 1 }, { v: 2 }]);
    await memo.get("b", async () => [{ v: 3 }, { v: 4 }]);
    expect(memo.size).toBe(1);
    let loads = 0;
    await memo.get("a", async () => { loads++; return []; });
    expect(loads).toBe(1);
  });
});

describe("scopedQuery shared market reads", () => {
  afterEach(() => clearSharedMarketReads());

  function fakePool() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ market_id: "m", observed_on: "2026-01-01", n: calls.length }] };
      },
    } as unknown as Pool;
    return { pool, calls };
  }

  it("narrows the select list and leaves vintage selection and order unchanged", async () => {
    const { pool, calls } = fakePool();
    await scopedQuery("live").marketObservations(pool, { productId: "p", from: "2025-01-01", to: "2025-12-31", columns: MARKET_PRICE_COLUMNS });
    const sql = calls[0]!.sql;
    expect(sql).not.toMatch(/DISTINCT ON \([^)]*\) \*/);
    expect(sql).not.toMatch(/\braw\b|\bflags\b/);
    expect(sql).toMatch(/price_modal_inr_per_kg/);
    expect(sql).toMatch(/available_at DESC NULLS LAST, vintage_seq DESC/);
    expect(sql).toMatch(/WHERE validation_status = 'valid' ORDER BY observed_on, market_id$/);
    await expect(scopedQuery("live").marketObservations(pool, { columns: ["raw; DROP TABLE x" as never] })).rejects.toThrow(/Unknown/);
  });

  it("reuses identical live reads and keeps replay cutoffs exact", async () => {
    const { pool, calls } = fakePool();
    const f = { productId: "p", from: "2025-01-01", to: "2025-12-31", columns: MARKET_PRICE_COLUMNS, shared: true };
    await Promise.all([scopedQuery("live").marketObservations(pool, f), scopedQuery("live").marketObservations(pool, f)]);
    expect(calls).toHaveLength(1);

    const replay = scopedQuery("replay");
    const c1 = new Date("2025-06-01T00:00:00Z");
    await replay.marketObservations(pool, { ...f, availableBy: c1 });
    await replay.marketObservations(pool, { ...f, availableBy: new Date(c1) });
    expect(calls).toHaveLength(2);
    // One millisecond later is a different replay cutoff: never served from the earlier read.
    await replay.marketObservations(pool, { ...f, availableBy: new Date(c1.getTime() + 1) });
    expect(calls).toHaveLength(3);
    // Replay still fails closed without a cutoff, before the memo is consulted.
    await expect(replay.marketObservations(pool, f)).rejects.toThrow();

    // Live "now" cutoffs within the TTL share; an unshared read always queries.
    const now = Date.now();
    await scopedQuery("live").marketObservations(pool, { ...f, availableBy: new Date(now) });
    await scopedQuery("live").marketObservations(pool, { ...f, availableBy: new Date(now + MARKET_READ_TTL_MS / 2) });
    expect(calls).toHaveLength(4);
    await scopedQuery("live").marketObservations(pool, { ...f, shared: false });
    expect(calls).toHaveLength(5);
    clearSharedMarketReads();
    await scopedQuery("live").marketObservations(pool, f);
    expect(calls).toHaveLength(6);
  });
});
