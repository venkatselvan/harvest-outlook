import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget } from "../src/services/budget";
import { DEFAULT_PRICE_TABLE, estimateCost, loadPriceTable } from "../src/services/pricing";
import { TEST_DB } from "./helpers";

let pool: Pool;
let ownerId: string;
let sessionId: string;
const limits = (o: Partial<{ dev: number; session: number; day: number }> = {}) => ({
  totalUsd: 10,
  devAllocationUsd: o.dev ?? 1,
  demoReserveUsd: 1,
  perSessionUsd: o.session ?? 3,
  perOwnerDayUsd: o.day ?? 10,
});
const state = async () => (await pool.query("SELECT reserved_usd::float AS r, settled_usd::float AS s FROM budget_state WHERE id=1")).rows[0] as { r: number; s: number };

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  ownerId = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
  sessionId = (await pool.query("INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1,'h', now()+interval '1 day') RETURNING id", [ownerId])).rows[0].id;
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query("DELETE FROM usage_ledger; DELETE FROM usage_reservations; DELETE FROM budget_state");
});

const input = (estimate: number, sid: string | null = sessionId, oid: string | null = ownerId) => ({ ownerId: oid, sessionId: sid, provider: "meta", model: "muse-spark-1.3", estimate });

describe("budget reservations", () => {
  it("25 concurrent $0.10 reservations against a $1.00 allocation: exactly 10 succeed", async () => {
    const b = new Budget(pool, limits());
    await b.init();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => b.reserve(input(0.1))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(bad).toHaveLength(15);
    for (const f of bad) expect(f.reason).toMatchObject({ code: "budget_exceeded", statusCode: 429, details: { limit: "global" } });
    expect((await state()).r).toBeCloseTo(1.0, 6);
    expect(Number((await pool.query("SELECT count(*) FROM usage_reservations")).rows[0].count)).toBe(10);
  });

  it("settle moves estimate to settled at the actual cost and writes the ledger", async () => {
    const b = new Budget(pool, limits());
    await b.init();
    const a = await b.reserve(input(0.1));
    await b.reserve(input(0.1));
    await b.settle(a.reservationId, 0.04, "prov-req-1", { inputTokens: 100 });
    expect(await state()).toEqual({ r: 0.1, s: 0.04 });
    const led = (await pool.query("SELECT settled_usd::float AS s, estimated_usd::float AS e, provider_request_id, cost_basis FROM usage_ledger")).rows;
    expect(led).toEqual([{ s: 0.04, e: 0.1, provider_request_id: "prov-req-1", cost_basis: "estimated" }]);
    await b.settle(a.reservationId, 0.04, "prov-req-1"); // idempotent: no double count
    expect(await state()).toEqual({ r: 0.1, s: 0.04 });
    expect((await b.summary())!.remainingDevUsd).toBeCloseTo(0.86, 6);
  });

  it("release restores capacity; a released reservation cannot be settled", async () => {
    const b = new Budget(pool, limits({ dev: 0.2 }));
    await b.init();
    const a = await b.reserve(input(0.1));
    await b.reserve(input(0.1));
    await expect(b.reserve(input(0.1))).rejects.toMatchObject({ code: "budget_exceeded" });
    await b.release(a.reservationId);
    expect((await state()).r).toBeCloseTo(0.1, 6);
    await b.reserve(input(0.1)); // fits again
    await expect(b.settle(a.reservationId, 0.01, null)).rejects.toMatchObject({ code: "reservation_state_conflict" });
  });

  it("markUncertain keeps the reservation against the budget until released or settled", async () => {
    const b = new Budget(pool, limits({ dev: 0.1 }));
    await b.init();
    const a = await b.reserve(input(0.1));
    await b.markUncertain(a.reservationId);
    expect((await state()).r).toBeCloseTo(0.1, 6);
    await expect(b.reserve(input(0.05))).rejects.toMatchObject({ code: "budget_exceeded" });
    await b.settle(a.reservationId, 0.07, "late-1");
    expect(await state()).toEqual({ r: 0, s: 0.07 });
  });

  it("enforces the per-session cap and reports which limit", async () => {
    const b = new Budget(pool, limits({ session: 0.25, dev: 5 }));
    await b.init();
    await b.reserve(input(0.1));
    await b.reserve(input(0.1));
    await expect(b.reserve(input(0.1))).rejects.toMatchObject({ code: "budget_exceeded", details: { limit: "session" } });
    // a different session of another owner is unaffected
    const o2 = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
    const s2 = (await pool.query("INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1,'h2', now()+interval '1 day') RETURNING id", [o2])).rows[0].id;
    await b.reserve(input(0.1, s2, o2));
  });

  it("enforces the per-owner daily cap across sessions", async () => {
    const b = new Budget(pool, limits({ day: 0.25, dev: 5 }));
    await b.init();
    const s2 = (await pool.query("INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1,'h3', now()+interval '1 day') RETURNING id", [ownerId])).rows[0].id;
    await b.reserve(input(0.1));
    await b.reserve(input(0.1, s2));
    await expect(b.reserve(input(0.1, s2))).rejects.toMatchObject({ code: "budget_exceeded", details: { limit: "owner_day" } });
    // yesterday's spend does not count
    await pool.query("UPDATE usage_reservations SET created_at = now() - interval '2 days'");
    await b.reserve(input(0.1));
  });

  it("init re-syncs limits from config without resetting counters", async () => {
    const b = new Budget(pool, limits());
    await b.init();
    await b.reserve(input(0.3));
    await new Budget(pool, limits({ dev: 2 })).init();
    const row = (await pool.query("SELECT dev_allocation_usd::float AS d, reserved_usd::float AS r FROM budget_state")).rows[0];
    expect(row).toEqual({ d: 2, r: 0.3 });
  });
});

describe("price estimator", () => {
  it("computes token, image and speech estimates from the table", () => {
    const t = DEFAULT_PRICE_TABLE;
    expect(estimateCost(t, "meta", "muse-spark-1.3", { inputTokens: 1000, outputTokens: 500 }).usd).toBe(0.003375); // 1250 + 2125 micro-USD
    expect(estimateCost(t, "meta", "muse-wonder-1.0", { inputTokens: 10_000, outputTokens: 2_000 }).usd).toBeCloseTo(0.08, 9);
    expect(estimateCost(t, "meta", "muse-image-1.0", { images: 3 }).usd).toBeCloseTo(0.03, 9);
    expect(estimateCost(t, "meta", "sam-3.1", { images: 1 }).usd).toBe(0.0025);
    expect(estimateCost(t, "meta", "muse-voice-transcribe-1.0", { seconds: 60 }).usd).toBe(.003);
    expect(() => estimateCost(t, "elevenlabs", "any-model", { characters: 1200 })).toThrow(/No price configured/);
  });
  it("refuses unpriced models and bad inputs; the override table merges over defaults", () => {
    expect(() => estimateCost(DEFAULT_PRICE_TABLE, "meta", "mystery-9", { images: 1 })).toThrow(/No price configured/);
    expect(() => estimateCost(DEFAULT_PRICE_TABLE, "meta", "sam-3.1", { images: -1 })).toThrow();
    const t = loadPriceTable(JSON.stringify({ "sam-3.1": { kind: "image", perImageUsd: 0.5 } }));
    expect(estimateCost(t, "meta", "sam-3.1", { images: 2 }).usd).toBe(1);
    expect(t["muse-spark-1.3"]).toBeDefined();
    expect(() => loadPriceTable("{bad")).toThrow();
    expect(() => loadPriceTable(JSON.stringify({ x: { kind: "image", perImageUsd: -1 } }))).toThrow();
  });
});
