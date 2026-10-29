import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget, hashClientIp } from "../src/services/budget";
import { TEST_DB } from "./helpers";

let pool: Pool;
const limits = (o: Partial<{ dev: number; ip: number }> = {}) => ({
  totalUsd: 10,
  devAllocationUsd: o.dev ?? 1,
  demoReserveUsd: 1,
  perSessionUsd: 5,
  perOwnerDayUsd: 5,
  perIpDayUsd: o.ip ?? 15,
});
const mk = async (ip: string | null) => {
  const owner = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id as string;
  const session = (
    await pool.query("INSERT INTO sessions (owner_id, token_hash, expires_at, ip_hash) VALUES ($1, gen_random_uuid()::text, now()+interval '1 day', $2) RETURNING id", [
      owner,
      ip ? hashClientIp(ip, "s".repeat(32)) : null,
    ])
  ).rows[0].id as string;
  return { owner, session };
};
const req = (who: { owner: string; session: string }, estimate: number) => ({ ownerId: who.owner, sessionId: who.session, provider: "meta", model: "m", estimate });

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query("DELETE FROM usage_ledger; DELETE FROM usage_reservations; DELETE FROM budget_state");
});

describe("M4: settle overrun", () => {
  it("reserve 0.50, settle 5.00 against a 1.00 allocation is recorded, warned, and marks the budget exhausted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = new Budget(pool, limits({ dev: 1 }));
    await b.init();
    const who = await mk(null);
    const { reservationId } = await b.reserve(req(who, 0.5));
    expect((await b.summary())!.exhausted).toBe(false);
    await b.settle(reservationId, 5, null);
    const s = (await b.summary())!;
    expect(s.exhausted).toBe(true);
    expect(s.remainingDevUsd).toBe(0);
    expect(s).toMatchObject({ overrunCount: 1, overrunUsd: 4.5 });
    expect(Number((await pool.query("SELECT overrun_usd FROM usage_reservations WHERE id=$1", [reservationId])).rows[0].overrun_usd)).toBe(4.5);
    expect(Number((await pool.query("SELECT overrun_usd FROM usage_ledger WHERE reservation_id=$1", [reservationId])).rows[0].overrun_usd)).toBe(4.5);
    expect(warn).toHaveBeenCalled();
    await expect(b.reserve(req(who, 0.01))).rejects.toMatchObject({ code: "budget_exceeded" });
    warn.mockRestore();
  });

  it("a settlement at or below the estimate records no overrun", async () => {
    const b = new Budget(pool, limits({ dev: 5 }));
    await b.init();
    const who = await mk(null);
    const { reservationId } = await b.reserve(req(who, 0.5));
    await b.settle(reservationId, 0.5, null);
    expect(await b.summary()).toMatchObject({ overrunCount: 0, overrunUsd: 0 });
  });
});

describe("M4: per-IP-day cap", () => {
  it("many guest sessions from one IP share one cap; another IP is unaffected; no raw IP is stored", async () => {
    const b = new Budget(pool, limits({ dev: 100, ip: 0.25 }));
    await b.init();
    const s1 = await mk("203.0.113.9");
    const s2 = await mk("203.0.113.9"); // a brand-new guest owner/session, same IP
    const s3 = await mk("198.51.100.4");
    await b.reserve(req(s1, 0.1));
    await b.reserve(req(s2, 0.1));
    await expect(b.reserve(req(s2, 0.1))).rejects.toMatchObject({ code: "budget_exceeded", details: { limit: "ip_day" } });
    await expect(b.reserve(req(await mk("203.0.113.9"), 0.1))).rejects.toMatchObject({ details: { limit: "ip_day" } });
    await b.reserve(req(s3, 0.1)); // different IP still has headroom
    const stored = JSON.stringify((await pool.query("SELECT ip_hash FROM sessions")).rows);
    expect(stored).not.toContain("203.0.113.9");
    expect(stored).toContain(hashClientIp("203.0.113.9", "s".repeat(32))!);
  });

  it("released spend does not count against the IP cap", async () => {
    const b = new Budget(pool, limits({ dev: 100, ip: 0.15 }));
    await b.init();
    const s = await mk("192.0.2.1");
    const r = await b.reserve(req(s, 0.1));
    await b.release(r.reservationId);
    await b.reserve(req(s, 0.15));
  });
});
