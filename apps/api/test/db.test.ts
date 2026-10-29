import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { claimJob, pollOnce, runJob, handlers } from "../src/worker/main";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_test";
let pool: Pool;
let available = false;

beforeAll(async () => {
  pool = createPool(url);
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    if (process.env.CI) throw new Error("test database required in CI");
    console.warn("test database unavailable; DB tests skipped");
    return;
  }
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => pool.end());

const ifDb = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!available) return ctx.skip(); await fn(); });

describe("migrations", () => {
  ifDb("creates every spec table and is idempotent", async () => {
    const expected = "owners sessions farms farm_facts crop_identities crop_products source_documents evidence_records crop_rules stage_definitions coverage_records market_observations weather_observations weather_forecasts regional_production feature_artifacts forecast_models forecast_artifacts plans plan_outputs journal_entries journal_facts actions media_objects visual_assets agent_runs tool_results jobs usage_reservations usage_ledger schema_migrations".split(" ");
    const r = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const have = new Set(r.rows.map((x) => x.table_name));
    expect(expected.filter((t) => !have.has(t))).toEqual([]);
    expect(await migrate(pool, undefined, () => undefined)).toEqual([]);
  });

  ifDb("enforces mode check, market dedup and plan immutability", async () => {
    const owner = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
    const farm = (await pool.query("INSERT INTO farms (owner_id, name) VALUES ($1,'f') RETURNING id", [owner])).rows[0].id;
    const crop = (await pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
    await expect(pool.query("INSERT INTO plans (owner_id,farm_id,crop_id,mode,content_hash,snapshot) VALUES ($1,$2,$3,'bogus','h','{}')", [owner, farm, crop])).rejects.toThrow(/check/);
    const plan = (await pool.query("INSERT INTO plans (owner_id,farm_id,crop_id,mode,content_hash,snapshot) VALUES ($1,$2,$3,'synthetic','h1','{}') RETURNING id", [owner, farm, crop])).rows[0].id;
    await expect(pool.query("UPDATE plans SET snapshot='{\"x\":1}' WHERE id=$1", [plan])).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM plans WHERE id=$1", [plan])).rejects.toThrow(/immutable/);

    const prod = (await pool.query("INSERT INTO crop_products (crop_id,slug,name) VALUES ($1,'ginger-dry','Dry ginger') RETURNING id", [crop])).rows[0].id;
    const src = (await pool.query("INSERT INTO source_documents (content_hash) VALUES ('abc') RETURNING id")).rows[0].id;
    const ins = () => pool.query("INSERT INTO market_observations (market_id,product_id,observed_on,source_id,price_modal) VALUES ('m1',$1,'2026-01-01',$2,100)", [prod, src]);
    await ins();
    await expect(ins()).rejects.toThrow(/unique/);
    await expect(pool.query("INSERT INTO source_documents (content_hash) VALUES ('abc')")).rejects.toThrow(/unique/);
  });

  ifDb("job idempotency keys are unique per owner, not globally", async () => {
    const o1 = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
    const o2 = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
    const q = (o: string) => pool.query("INSERT INTO jobs (owner_id,type,idempotency_key) VALUES ($1,'noop','k1')", [o]);
    await q(o1);
    await q(o2);
    await expect(q(o1)).rejects.toThrow(/unique/);
  });
});

describe("worker", () => {
  ifDb("concurrent claimers never receive the same job", async () => {
    await pool.query("DELETE FROM jobs");
    for (let i = 0; i < 6; i++) await pool.query("INSERT INTO jobs (type) VALUES ('noop')");
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimJob(pool, `w${i}`)));
    const ids = claims.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  ifDb("noop job runs queued -> running -> succeeded", async () => {
    await pool.query("DELETE FROM jobs");
    const id = (await pool.query("INSERT INTO jobs (type) VALUES ('noop') RETURNING id")).rows[0].id;
    expect(await pollOnce(pool, "w")).toBe(true);
    const row = (await pool.query("SELECT state, attempt, result, progress FROM jobs WHERE id=$1", [id])).rows[0];
    expect(row).toMatchObject({ state: "succeeded", attempt: 1, result: { ok: true } });
    expect(Number(row.progress)).toBe(1);
    expect(await pollOnce(pool, "w")).toBe(false);
  });

  ifDb("an abandoned job is reclaimed after lease expiry, and a stale worker cannot overwrite it", async () => {
    await pool.query("DELETE FROM jobs");
    const id = (await pool.query("INSERT INTO jobs (type) VALUES ('noop') RETURNING id")).rows[0].id;
    const first = await claimJob(pool, "dead-worker", 30);
    expect(first?.id).toBe(id);
    expect(await claimJob(pool, "other", 30)).toBeNull(); // lease still valid
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);
    const second = await claimJob(pool, "live-worker", 30);
    expect(second).toMatchObject({ id, attempt: 2 });
    await runJob(pool, first!, "dead-worker"); // stale: lease_owner mismatch, must not change state
    expect((await pool.query("SELECT state, lease_owner FROM jobs WHERE id=$1", [id])).rows[0]).toMatchObject({ state: "running", lease_owner: "live-worker" });
  });

  ifDb("unknown job types fail non-retryably; retryable errors requeue until max_attempts", async () => {
    await pool.query("DELETE FROM jobs");
    const bad = (await pool.query("INSERT INTO jobs (type) VALUES ('nonexistent') RETURNING id")).rows[0].id;
    await pollOnce(pool, "w");
    expect((await pool.query("SELECT state, retryable FROM jobs WHERE id=$1", [bad])).rows[0]).toMatchObject({ state: "failed", retryable: false });

    handlers.flaky = async () => { throw Object.assign(new Error("transient"), { retryable: true }); };
    const fl = (await pool.query("INSERT INTO jobs (type,max_attempts) VALUES ('flaky',2) RETURNING id")).rows[0].id;
    await pollOnce(pool, "w");
    expect((await pool.query("SELECT state FROM jobs WHERE id=$1", [fl])).rows[0].state).toBe("queued");
    await pool.query("UPDATE jobs SET run_after=now() WHERE id=$1", [fl]);
    await pollOnce(pool, "w");
    expect((await pool.query("SELECT state, attempt FROM jobs WHERE id=$1", [fl])).rows[0]).toMatchObject({ state: "failed", attempt: 2 });
    delete handlers.flaky;
  });

  ifDb("a cancel-requested queued job is cancelled instead of run", async () => {
    await pool.query("DELETE FROM jobs");
    const id = (await pool.query("INSERT INTO jobs (type,cancel_requested) VALUES ('noop',true) RETURNING id")).rows[0].id;
    await pollOnce(pool, "w");
    expect((await pool.query("SELECT state FROM jobs WHERE id=$1", [id])).rows[0].state).toBe("cancelled");
  });
});
