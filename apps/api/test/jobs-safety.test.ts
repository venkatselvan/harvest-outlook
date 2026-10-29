import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { enqueue } from "../src/services/jobs";
import { claimJob, handlers, pollOnce, runJob } from "../src/worker/main";
import { TEST_DB } from "./helpers";

let pool: Pool;
beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => {
  delete handlers.f2_slow;
  delete handlers.f2_crash;
  await pool.end();
});
beforeEach(async () => {
  await pool.query("DELETE FROM jobs");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M5: null-owner job dedupe", () => {
  it("enqueueing twice with a null owner and the same key yields one row", async () => {
    const a = await enqueue(pool, "noop", { x: 1 }, null, "sys:key-1");
    const b = await enqueue(pool, "noop", { x: 1 }, null, "sys:key-1");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(Number((await pool.query("SELECT count(*) FROM jobs WHERE idempotency_key='sys:key-1'")).rows[0].count)).toBe(1);
    await expect(enqueue(pool, "noop", { x: 2 }, null, "sys:key-1")).rejects.toMatchObject({ code: "idempotency_payload_mismatch" });
  });
});

describe("M6: lease safety", () => {
  it("a handler that outlives the lease keeps it via heartbeat and is not reclaimed or executed twice", async () => {
    let runs = 0;
    handlers.f2_slow = async () => {
      runs++;
      await sleep(1500); // 2.5x the 0.6 s lease
      return { done: true };
    };
    const { job } = await enqueue(pool, "f2_slow", {}, null);
    const claimed = (await claimJob(pool, "w1", 0.6))!;
    expect(claimed.id).toBe(job.id);
    const running = runJob(pool, claimed, "w1", 0.6);
    let reclaimed = 0;
    for (let i = 0; i < 6; i++) {
      await sleep(250);
      if (await claimJob(pool, "w2", 0.6)) reclaimed++;
    }
    expect(reclaimed).toBe(0);
    expect(await running).toBe("succeeded");
    expect(runs).toBe(1);
  });

  it("without heartbeat an expired lease is reclaimed (control), up to max_attempts, then the job fails lease_expired_max_attempts", async () => {
    const { job } = await enqueue(pool, "noop", {}, null);
    await pool.query("UPDATE jobs SET max_attempts = 2 WHERE id = $1", [job.id]);
    const expire = () => pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [job.id]);
    expect((await claimJob(pool, "a", 30))?.attempt).toBe(1);
    await expire();
    expect((await claimJob(pool, "b", 30))?.attempt).toBe(2);
    await expire();
    expect(await claimJob(pool, "c", 30)).toBeNull();
    const row = (await pool.query("SELECT state, error, retryable FROM jobs WHERE id=$1", [job.id])).rows[0];
    expect(row.state).toBe("failed");
    expect(row.error.code).toBe("lease_expired_max_attempts");
    expect(row.retryable).toBe(false);
  });

  it("a crashing handler stops after max_attempts (hard crash simulated by lost lease each time)", async () => {
    let calls = 0;
    handlers.f2_crash = async () => {
      calls++;
      // Simulates a process that dies mid-job: the lease is left to expire and the handler never reports back.
      await pool.query("UPDATE jobs SET lease_owner = 'dead', lease_expires_at = now() - interval '1 second' WHERE type='f2_crash'");
      return null;
    };
    const { job } = await enqueue(pool, "f2_crash", {}, null);
    await pool.query("UPDATE jobs SET max_attempts = 3 WHERE id = $1", [job.id]);
    for (let i = 0; i < 10; i++) await pollOnce(pool, "w", 30);
    expect(calls).toBe(3);
    const row = (await pool.query("SELECT state, attempt, error FROM jobs WHERE id=$1", [job.id])).rows[0];
    expect(row).toMatchObject({ state: "failed", attempt: 3 });
    expect(row.error.code).toBe("lease_expired_max_attempts");
  });
});
