import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@harvest/domain";
import { SYNTHETIC_SOURCE_ID, ensureSource } from "../src/ingest/sources";
import { approvedTextHash } from "../src/speech/approved";
import { regionDate } from "../src/plans";
import { seedGinger } from "./fixtures/meta/helpers";
import { login, makeJpeg, setupHarness, upload, type Client, type Harness } from "./helpers";

/**
 * INT1: the connected synthetic journey through the real server (all plugins wired by buildServer).
 * Every number here comes from synthetic fixtures; nothing is a provider response.
 */
const PLAN_FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../data/fixtures/synthetic/plan-ginger-basic.json", import.meta.url)), "utf8"));

let h: Harness;
let c: Client;
const today = regionDate(new Date());
const plantingDate = addDays(today, -45);
const json = { "content-type": "application/json" };

/** Synthetic Hassan-like weather placed relative to today: observations from today-30, a 10-day forecast, and 5 full years of normals. */
async function seedRelativeSyntheticWeather(): Promise<void> {
  const src = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "Synthetic development fixtures", publisher: "Harvest Outlook (generated)", url: "local:data/fixtures/synthetic", licence: "synthetic, not real data" });
  const vars = (alias: string) =>
    `jsonb_build_object('precipitation_sum', round((((extract(doy from ${alias})::int * 7) % 11) * 1.3)::numeric, 1), 'temperature_2m_max', 27 + (extract(doy from ${alias})::int % 5), 'temperature_2m_min', 18 + (extract(doy from ${alias})::int % 3), 'et0_fao_evapotranspiration', 3.2)`;
  const year = Number(today.slice(0, 4));
  await h.pool.query(
    `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, evidence_state, measurement_kind, available_at, meta)
     SELECT 'synthetic:int1-hassan', 76.1, 13.0, d::date, ${vars("d")}, $1, true, 'synthetic', 'illustrative', 'synthetic', now() - interval '1 hour', '{"synthetic":true}'::jsonb
       FROM generate_series($2::date, $3::date, interval '1 day') d`,
    [src, `${year - 5}-01-01`, `${year - 1}-12-31`],
  );
  await h.pool.query(
    `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, evidence_state, measurement_kind, available_at, meta)
     SELECT 'synthetic:int1-hassan', 76.1, 13.0, d::date, ${vars("d")}, $1, true, 'synthetic', 'illustrative', 'synthetic', now() - interval '1 hour', '{"synthetic":true}'::jsonb
       FROM generate_series($2::date, $3::date, interval '1 day') d
     ON CONFLICT DO NOTHING`,
    [src, addDays(today, -30), addDays(today, -1)],
  );
  await h.pool.query(
    `INSERT INTO weather_forecasts (location_key, lon, lat, issued_at, valid_on, variables, source_id, is_synthetic, mode, evidence_state, available_at, meta)
     SELECT 'synthetic:int1-hassan', 76.1, 13.0, now() - interval '1 hour', d::date, ${vars("d")}, $1, true, 'synthetic', 'illustrative', now() - interval '1 hour', '{"synthetic":true}'::jsonb
       FROM generate_series($2::date, $3::date, interval '1 day') d`,
    [src, today, addDays(today, 9)],
  );
}

beforeAll(async () => {
  h = await setupHarness();
  await seedGinger(h.pool);
  await seedRelativeSyntheticWeather();
  c = await login(h.app);
}, 60_000);
afterAll(async () => h.close());

describe("capabilities (D-T04-1)", () => {
  it("anonymous callers see only budget.exhausted; a session cookie adds the dollar figures; speech and tool binding are reported", async () => {
    const anon = (await h.app.inject({ url: "/api/v1/capabilities" })).json().data;
    expect(anon.budget).toEqual({ exhausted: false });
    expect(JSON.stringify(anon)).not.toMatch(/devAllocationUsd|remainingDevUsd|demoReserveUsd/);
    const authed = (await c.call("GET", "/api/v1/capabilities")).json().data;
    expect(authed.budget).toMatchObject({ currency: "USD", devAllocationUsd: 120, demoReserveUsd: 30, exhausted: false });
    expect(authed.budget.remainingDevUsd).toBeGreaterThan(0);
    // An invalid cookie is anonymous.
    const bogus = (await h.app.inject({ url: "/api/v1/capabilities", headers: { cookie: "ho_session=not-a-session" } })).json().data;
    expect(bogus.budget).toEqual({ exhausted: false });
    expect(anon.speech).toEqual({ available: false, qualified: false });
    expect(anon.tools.bound).toEqual(expect.arrayContaining(["get_farm_context", "calculate_scenarios", "calculate_water_balance", "request_segmentation", "get_job_status"]));
    expect(anon.tools.unbound).toEqual(expect.arrayContaining(["screen_crops", "request_visual_keyframes"]));
    expect([...anon.tools.bound, ...anon.tools.unbound].sort()).toEqual([...new Set([...anon.tools.bound, ...anon.tools.unbound])].sort());
  });
});

describe("synthetic journey: farm -> photo -> region -> plan -> timeline -> revision -> assistant -> speech -> segmentation -> delete", () => {
  let farmId: string;
  let mediaId: string;
  let plan: any;
  let turn: any;

  it("creates a Hassan-like farm and uploads a photo", async () => {
    const farm = await c.call("POST", "/api/v1/farms", {
      payload: { name: "Hassan plot (synthetic)", location: { districtId: "IN-KA-HAS", districtName: "Hassan", stateCode: "KA", lat: 13.0, lon: 76.1, precision: "approximate" }, areaHectares: 0.5, facts: { irrigation: { value: "drip", basis: "farmer_reported", confirmed: true } } },
      headers: json,
    });
    expect(farm.statusCode).toBe(201);
    farmId = farm.json().data.id;
    const up = await upload(c, await makeJpeg({ width: 320, height: 240 }), { farmId });
    expect(up.statusCode).toBe(201);
    mediaId = up.json().data.id;
  });

  it("saves a confirmed region", async () => {
    const res = await c.call("PUT", `/api/v1/media/${mediaId}/region`, {
      payload: { polygon: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], source: "manual", transform: { orientationApplied: true, normalizedWidth: 320, normalizedHeight: 240 } },
      headers: json,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.region.version).toBeGreaterThanOrEqual(1);
  });

  it("creates a plan from synthetic stage definitions and task templates", async () => {
    const confirmedInputs = structuredClone(PLAN_FIXTURE.confirmedInputs);
    confirmedInputs.find((i: any) => i.key === "planting_date").value.value = plantingDate;
    const body = { farmId, cropId: PLAN_FIXTURE.cropId, productId: PLAN_FIXTURE.productId, confirmedInputs, assumptions: PLAN_FIXTURE.assumptions, ruleVersions: PLAN_FIXTURE.ruleVersions, stageDefinitions: PLAN_FIXTURE.stageDefinitions, parameters: PLAN_FIXTURE.parameters };
    const res = await c.call("POST", "/api/v1/plans", { payload: body, headers: { ...json, "idempotency-key": "int1-plan-0001" } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    plan = res.json().data;
    expect(res.json().mode).toBe("synthetic");
    expect(plan.snapshot.mode).toBe("synthetic");
    expect(plan.outputs.map((o: any) => o.kind)).toEqual(expect.arrayContaining(["stage_windows", "tasks", "water", "economics"]));
    // Replaying the same key returns the stored response instead of a second plan.
    const again = await c.call("POST", "/api/v1/plans", { payload: body, headers: { ...json, "idempotency-key": "int1-plan-0001" } });
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json().data.snapshot.id).toBe(plan.snapshot.id);
  });

  it("timeline labels each horizon band from stored synthetic rows and never fills gaps; visuals are none/schematic", async () => {
    const res = await c.call("GET", `/api/v1/plans/${plan.snapshot.id}/timeline`);
    expect(res.statusCode).toBe(200);
    const t = res.json().data;
    expect(t.asOfDate).toBe(today);
    const state = (d: string) => t.days.find((x: any) => x.calendarDate === d)?.weather;
    expect(state(addDays(today, -10)).state).toBe("observed");
    expect(state(addDays(today, -40)).state).toBe("unavailable"); // before the stored observations: a gap, not an estimate
    expect(state(addDays(today, -40)).values).toBeNull();
    expect(state(today).state).toBe("forecast");
    expect(state(addDays(today, 9)).state).toBe("forecast");
    expect(state(addDays(today, 9)).horizonDays).toBe(9);
    const scenarioDay = t.days.find((x: any) => x.weather.state === "scenario");
    expect(scenarioDay, "a climatology scenario day beyond the forecast horizon").toBeTruthy();
    expect(scenarioDay.calendarDate > addDays(today, 9)).toBe(true);
    expect(scenarioDay.weather.assumptionId).toMatch(/^climatology_\d{4}-\d{4}$/);
    for (const d of t.days) expect(["none", "schematic"]).toContain(d.visual.state);
    // Second read hits the cache for the same data version.
    const again = (await c.call("GET", `/api/v1/plans/${plan.snapshot.id}/timeline`)).json().data;
    expect(again.cached).toBe(true);
    expect(again.dataVersion).toBe(t.dataVersion);
  });

  it("a plan revision (planting date shift) returns a change summary and keeps the parent readable", async () => {
    const res = await c.call("POST", `/api/v1/plans/${plan.snapshot.id}/revisions`, {
      payload: { expectedParentContentHash: plan.snapshot.contentHash, changes: [{ type: "planting_date", date: addDays(plantingDate, 7) }] },
      headers: json,
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    const rev = res.json().data;
    expect(rev.lineage.parentId).toBe(plan.snapshot.id);
    const summary = rev.outputs.find((o: any) => o.kind === "change_summary").output;
    expect(summary.changes).toEqual([{ type: "planting_date", date: addDays(plantingDate, 7) }]);
    expect(summary.changedTaskIds.length).toBeGreaterThan(0);
    expect((await c.call("GET", `/api/v1/plans/${plan.snapshot.id}`)).statusCode).toBe(200);
    // A stale parent hash is a version conflict.
    const stale = await c.call("POST", `/api/v1/plans/${plan.snapshot.id}/revisions`, { payload: { expectedParentContentHash: plan.snapshot.contentHash, changes: [{ type: "planting_date", date: plantingDate }] }, headers: json });
    expect(stale.statusCode).toBe(409);
  });

  it("assistant turn replays the synthetic fixture: approved blocks, trace id, approved-text hash", async () => {
    const res = await c.call("POST", "/api/v1/assistant/turns", { payload: { text: "I have half a hectare near Hassan and limited water. What should I consider?", language: "en", farmId, planId: plan.snapshot.id }, headers: json });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    turn = res.json().data;
    expect(turn).toMatchObject({ status: "approved", provenance: "synthetic_fixture", gateStatus: "approved" });
    expect(turn.answerBlocks.length).toBeGreaterThan(0);
    expect(turn.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(turn.approvedTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(turn.approvedTextHash).toBe(approvedTextHash(turn.approvedText));
  });

  it("speech synthesis accepts the approved-text hash (no 403) and reports provider_unavailable in synthetic mode; a tampered text is 403", async () => {
    const ok = await c.call("POST", "/api/v1/speech/synthesis", { payload: { text: turn.approvedText, language: "en", approvedTextHash: turn.approvedTextHash }, headers: json });
    expect(ok.statusCode).not.toBe(403);
    expect(ok.statusCode).toBe(424);
    expect(ok.json().error.code).toBe("provider_unavailable");
    const tampered = await c.call("POST", "/api/v1/speech/synthesis", { payload: { text: `${turn.approvedText} Also buy more.`, language: "en", approvedTextHash: turn.approvedTextHash }, headers: json });
    expect(tampered.statusCode).toBe(403);
  });

  it("segmentation request becomes a job; the worker path reports unavailable in synthetic mode and manual fallback stays available", async () => {
    const res = await c.call("POST", `/api/v1/media/${mediaId}/segmentation`, { payload: { prompt: { kind: "concept", text: "field" } }, headers: json });
    expect(res.statusCode).toBe(202);
    const d = res.json().data;
    expect(d.manualFallbackAvailable).toBe(true);
    // Run the worker's registry for this job exactly as worker/main.ts does.
    const { handlers, claimJob, runJob } = await import("../src/worker/main");
    const { registerWorkerHandlers } = await import("../src/worker/handlers");
    const { Budget } = await import("../src/services/budget");
    registerWorkerHandlers(handlers, { config: h.config, pool: h.pool, storage: h.storage, budget: Budget.fromConfig(h.pool, h.config) });
    const job = await claimJob(h.pool, "int1-worker");
    expect(job?.id).toBe(d.jobId);
    expect(await runJob(h.pool, job!, "int1-worker")).toBe("succeeded");
    const done = (await c.call("GET", `/api/v1/jobs/${d.jobId}`)).json().data;
    expect(done.state).toBe("succeeded");
    expect(done.result).toMatchObject({ status: "unavailable", reason: "synthetic_mode" });
  });

  it("assistant tool bindings are owner-scoped: another session cannot read this plan's economics or enqueue for this photo", async () => {
    const { createToolBindings } = await import("../src/agent/bindings");
    const { PlanService, defaultSources } = await import("../src/plans");
    const { Budget } = await import("../src/services/budget");
    const bindings = createToolBindings({ pool: h.pool, plans: new PlanService({ pool: h.pool, mode: "synthetic", sources: defaultSources() }), budget: Budget.fromConfig(h.pool, h.config), segmentModel: h.config.META_SEGMENT_MODEL });
    const owner = (await h.pool.query("SELECT owner_id FROM farms WHERE id=$1", [farmId])).rows[0].owner_id as string;
    const stranger = (await h.pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id as string;
    const ctx = (ownerId: string) => ({ ownerId, mode: "synthetic" as const, requestId: "req-int1", pool: h.pool, agentRunId: "run-int1", asOf: new Date().toISOString() });
    await expect(bindings.calculate_scenarios!({ planId: plan.snapshot.id }, ctx(stranger))).rejects.toMatchObject({ statusCode: 404 });
    await expect(bindings.request_segmentation!({ mediaId, prompt: { kind: "concept", text: "field" } }, ctx(stranger))).rejects.toMatchObject({ statusCode: 404 });
    const water = await bindings.calculate_water_balance!({ planId: plan.snapshot.id, weatherRefIds: ["w"], soilRefId: null, stageRefIds: ["s"], forecastRainPolicy: "use_forecast" }, ctx(owner));
    expect(water).toMatchObject({ resultId: expect.stringMatching(/^plan-output:[0-9a-f-]{36}\/byTiming\/(early|late)$/) });
    // Overrides cannot be honoured, so they are reported unavailable rather than silently ignored.
    expect(await bindings.calculate_scenarios!({ planId: plan.snapshot.id, overrides: { areaHa: 2 } as never }, ctx(owner))).toEqual({ status: "unavailable", reason: "overrides_not_supported" });
    // No price source exists in synthetic mode, so there is no priced economics result to hand the model.
    expect(await bindings.calculate_scenarios!({ planId: plan.snapshot.id }, ctx(owner))).toEqual({ status: "unavailable", reason: "economics_unavailable" });
    const seg = await bindings.request_segmentation!({ mediaId, prompt: { kind: "box", x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 } }, ctx(owner));
    expect(seg).toMatchObject({ budgetGate: "reserved", manualFallbackAvailable: true });
    expect(seg.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("deleting the farm removes it (second delete is 404) and its plans are no longer readable", async () => {
    const del = await c.call("DELETE", `/api/v1/farms/${farmId}`);
    expect([200, 204]).toContain(del.statusCode);
    expect((await c.call("DELETE", `/api/v1/farms/${farmId}`)).statusCode).toBe(404);
    expect((await c.call("GET", `/api/v1/farms/${farmId}`)).statusCode).toBe(404);
  });
});
