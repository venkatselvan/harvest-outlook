import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ForecastArtifact, Mode } from "@harvest/contracts";
import { addDays, verifyPlanSnapshot } from "@harvest/domain";
import { loadConfig } from "../src/config";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { errorEnvelope } from "../src/envelope";
import { ApiError } from "../src/services/errors";
import {
  PlanService,
  registerPlanRoutes,
  type ClimatologyBundle,
  type DailyWeather,
  type ForecastBundle,
  type MarketOutlookSource,
  type PlanSources,
  type VisualAssetRef,
  type WeatherSource,
} from "../src/plans";
import { unavailableOutlookSource, noTaskCompletions } from "../src/plans/sources";

/*
 * T08 plan engine tests. All inputs are SYNTHETIC fixtures (data/fixtures/synthetic/plan-*.json);
 * the weather and outlook sources are in-memory test doubles. No network or LLM is involved.
 */

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_test";
const FIX = resolve(__dirname, "../../../data/fixtures/synthetic");
const ginger = JSON.parse(readFileSync(resolve(FIX, "plan-ginger-basic.json"), "utf8"));
const picking = JSON.parse(readFileSync(resolve(FIX, "plan-repeated-picking.json"), "utf8"));

let pool: Pool;
let available = false;
const ifDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });

// ---------------------------------------------------------------- synthetic sources

const NOW = new Date("2026-06-10T06:00:00Z"); // 11:30 IST -> as-of date 2026-06-10
const DEFAULT_GAPS = ["2026-05-25", "2026-05-26"];

function synthDay(date: string, sourceId: string, rain: number): DailyWeather {
  return { date, rainMm: rain, et0Mm: 4, tMaxC: 30, tMinC: 22, sourceId };
}

class SyntheticWeather implements WeatherSource {
  readonly modes: readonly Mode[];
  calls = { obs: 0, forecast: 0, clim: 0, version: 0 };
  version = 1;
  forecastIssuedAt = "2026-06-10T00:00:00+05:30";
  heavyRainOn = "2026-06-12";
  gaps = new Set(DEFAULT_GAPS);
  constructor(modes: readonly Mode[] = ["synthetic"]) {
    this.modes = modes;
  }
  reset() {
    this.calls = { obs: 0, forecast: 0, clim: 0, version: 0 };
  }
  async getDailyObservations(_s: unknown, range: { start: string; end: string }): Promise<DailyWeather[]> {
    this.calls.obs++;
    const out: DailyWeather[] = [];
    // Observations exist for every past day except the gap days (including some "future" rows that must be ignored).
    for (let d = range.start; d <= range.end && d <= "2026-06-20"; d = addDays(d, 1)) if (!this.gaps.has(d)) out.push(synthDay(d, "synthetic-obs", 2));
    return out;
  }
  async getForecast(): Promise<ForecastBundle | null> {
    this.calls.forecast++;
    const days: DailyWeather[] = [];
    for (let i = 0; i < 10; i++) {
      const d = addDays("2026-06-10", i);
      days.push(synthDay(d, "synthetic-fc", d === this.heavyRainOn ? 80 : 5));
    }
    return { issuedAt: this.forecastIssuedAt, sourceId: "synthetic-fc", days };
  }
  climOpts: Array<{ availableBy?: string } | undefined> = [];
  async getClimatology(_s: unknown, range: { start: string; end: string }, opts?: { availableBy?: string }): Promise<ClimatologyBundle | null> {
    this.calls.clim++;
    this.climOpts.push(opts);
    const days: DailyWeather[] = [];
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(synthDay(d, "synthetic-clim", 6));
    return { years: { from: 1991, to: 2020 }, sourceId: "synthetic-clim", days };
  }
  async dataVersion() {
    this.calls.version++;
    return `synthetic-v${this.version}`;
  }
}

class Visuals {
  assets: VisualAssetRef[] = [];
  async getAssets() {
    return this.assets;
  }
  async version() {
    return `v${this.assets.length}`;
  }
}

function artifact(over: Partial<ForecastArtifact> = {}): ForecastArtifact {
  return {
    schemaVersion: "1.0",
    id: "synthetic-artifact-1",
    mode: "synthetic",
    evidenceState: "forecast",
    productId: "ginger-fresh",
    marketIds: ["synthetic-market-1"],
    target: { statistic: "weekly_median_modal", definition: "synthetic", unit: "INR/kg" },
    issuedAt: "2026-06-01T00:00:00+05:30",
    trainingCutoff: "2026-05-31T00:00:00+05:30",
    horizonDays: 300,
    modelId: "synthetic-baseline",
    modelKind: "baseline_seasonal",
    baselineIds: [],
    predictions: [
      { period: { start: "2026-11-01", end: "2027-03-31" }, quantiles: [{ level: 0.1, value: 30 }, { level: 0.5, value: 45 }, { level: 0.9, value: 60 }], negativeQuantilesReported: false },
    ],
    evaluation: null,
    featureVersions: [],
    missingness: { fractionMissingWeeks: 0, notes: [] },
    ...over,
  };
}

function sources(mode: Mode = "synthetic", outlook: MarketOutlookSource = unavailableOutlookSource()) {
  const weather = new SyntheticWeather([mode]);
  const visuals = new Visuals();
  const s: PlanSources = { weather, outlook, visuals, completions: noTaskCompletions };
  return { s, weather, visuals };
}

let idSeq = 0;
function service(mode: Mode, s: PlanSources, now = NOW) {
  return new PlanService({ pool, mode, sources: s, clock: () => now });
}

// ---------------------------------------------------------------- db fixtures

async function newOwner(): Promise<string> {
  return (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id;
}
async function newFarm(owner: string): Promise<string> {
  return (await pool.query("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,$2,'IN-KA-HAS','KA') RETURNING id", [owner, `farm-${++idSeq}`])).rows[0].id;
}

function createArgs(fx: typeof ginger, owner: string, farm: string, mode: Mode = "synthetic", over: Record<string, unknown> = {}) {
  return {
    ownerId: owner,
    farmId: farm,
    cropId: fx.cropId,
    productId: fx.productId,
    mode,
    confirmedInputs: structuredClone(fx.confirmedInputs),
    assumptions: structuredClone(fx.assumptions),
    ruleVersions: structuredClone(fx.ruleVersions),
    stageDefinitions: structuredClone(fx.stageDefinitions),
    parameters: structuredClone(fx.parameters),
    sourceSnapshotId: "synthetic-fixtures-v1",
    ...over,
  };
}

const outputOf = <T = any>(view: { outputs: { kind: string; output: unknown }[] }, kind: string) => view.outputs.find((o) => o.kind === kind)!.output as T;

beforeAll(async () => {
  pool = createPool(TEST_DB);
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    if (process.env.CI) throw new Error("test database required in CI");
    console.warn("test database unavailable; plan DB tests skipped");
    return;
  }
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  const g = (await pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'ginger-fresh','Fresh ginger (synthetic test row)')", [g]);
  const p = (await pool.query("INSERT INTO crop_identities (slug) VALUES ('synthetic-picking-crop') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'synthetic-picking-crop-fresh','Synthetic picking crop')", [p]);
});
afterAll(async () => pool?.end());

// ---------------------------------------------------------------- tests

describe("plan snapshots", () => {
  ifDb("archives a demo snapshot reversibly and rebuilds identical inputs without resurrecting it",async()=>{
    const owner=await newOwner(),farm=await newFarm(owner);const {s}=sources();const svc=service("synthetic",s);
    const original=await svc.createPlan(createArgs(ginger,owner,farm));
    await pool.query("INSERT INTO archived_plans(plan_id,owner_id,farm_id,reason) VALUES($1,$2,$3,'retired demo seed')",[original.snapshot.id,owner,farm]);
    await expect(svc.getPlan(owner,original.snapshot.id)).rejects.toMatchObject({statusCode:404});
    const fresh=await svc.createPlan(createArgs(ginger,owner,farm));expect(fresh.snapshot.id).not.toBe(original.snapshot.id);
    const repeated=await svc.createPlan(createArgs(ginger,owner,farm));expect(repeated.snapshot.id).toBe(fresh.snapshot.id);
    expect((await pool.query('SELECT count(*)::int count FROM plans WHERE id=$1',[original.snapshot.id])).rows[0].count).toBe(1);
  });

  ifDb("identical inputs yield the same contentHash; plans and outputs reject SQL UPDATE", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s } = sources();
    const svc = service("synthetic", s);
    const a = await svc.createPlan(createArgs(ginger, owner, farm));
    const b = await svc.createPlan(createArgs(ginger, owner, farm));
    expect(verifyPlanSnapshot(a.snapshot)).toBe(true);
    expect(b.snapshot.contentHash).toBe(a.snapshot.contentHash);
    expect(b.snapshot.id).toBe(a.snapshot.id);
    expect(b.deduplicated).toBe(true);
    expect(a.snapshot.mode).toBe("synthetic");
    expect(Object.isFrozen(a.snapshot)).toBe(true);
    expect(a.outputs.map((o) => o.kind).sort()).toEqual(["economics", "harvest_windows", "inputs", "market_outlook", "stage_windows", "tasks", "water"]);
    await expect(pool.query("UPDATE plans SET content_hash='x' WHERE id=$1", [a.snapshot.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE plan_outputs SET output='{}' WHERE plan_id=$1", [a.snapshot.id])).rejects.toThrow(/immutable/);
    // The inputs bundle hash is pinned in the snapshot.
    const bundle = a.outputs.find((o) => o.kind === "inputs")!;
    expect(a.snapshot.modelVersions.find((m) => m.id === "plan-inputs")!.version).toBe(bundle.contentHash);
    // Tasks are bound to this snapshot.
    const tasks = outputOf(a, "tasks").tasks;
    expect(tasks.every((t: any) => t.task.planId === a.snapshot.id && t.task.planContentHash === a.snapshot.contentHash && t.task.state === "pending")).toBe(true);
    expect(tasks.every((t: any) => t.task.amount === null)).toBe(true);
  });

  ifDb("rejects mode mismatch, client-supplied synthetic stages in live mode, and missing planting date", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s } = sources("live");
    const live = service("live", s);
    await expect(live.createPlan(createArgs(ginger, owner, farm, "synthetic"))).rejects.toMatchObject({ code: "mode_mismatch" });
    await expect(live.createPlan(createArgs(ginger, owner, farm, "live"))).rejects.toMatchObject({ code: "mode_mismatch" });
    const syn = service("synthetic", sources().s);
    const noDate = createArgs(ginger, owner, farm);
    noDate.confirmedInputs = noDate.confirmedInputs.filter((i: any) => i.key !== "planting_date");
    await expect(syn.createPlan(noDate)).rejects.toMatchObject({ statusCode: 422 });
  });

  ifDb("a synthetic weather source cannot feed a live plan", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s } = sources("synthetic");
    const live = service("live", s);
    const fx = structuredClone(ginger);
    for (const d of fx.stageDefinitions) { d.mode = "live"; d.reviewStatus = "candidate"; d.evidenceIds = ["evidence-x"]; d.id = d.id.replace("synthetic-", "live-"); }
    for (const t of fx.parameters.taskTemplates) t.evidenceIds = [];
    await expect(live.createPlan(createArgs(fx, owner, farm, "live"))).rejects.toMatchObject({ code: "mode_mismatch" });
  });
});

describe("revisions", () => {
  ifDb("wrong parent hash -> version_conflict; stale parent -> version_conflict", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const svc = service("synthetic", sources().s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    await expect(
      svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: "0".repeat(64), changes: [{ type: "area", amount: 1, unit: "ha" }] }),
    ).rejects.toMatchObject({ statusCode: 409, code: "version_conflict" });
    await svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: p.snapshot.contentHash, changes: [{ type: "area", amount: 1, unit: "ha" }] });
    // Revising the old version again (an offline draft) cannot fork history.
    await expect(
      svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: p.snapshot.contentHash, changes: [{ type: "area", amount: 2, unit: "ha" }] }),
    ).rejects.toMatchObject({ statusCode: 409, code: "version_conflict" });
  });

  ifDb("planting date change shifts stage and task windows; changeSummary lists tasks; old outputs stay readable", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s, weather } = sources();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    weather.reset();
    const r = await svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: p.snapshot.contentHash, changes: [{ type: "planting_date", date: "2026-05-25" }] });
    expect(r.snapshot.parentId).toBe(p.snapshot.id);
    expect(r.snapshot.parentContentHash).toBe(p.snapshot.contentHash);
    expect(weather.calls.obs).toBe(1); // water recomputed once with one fetch

    const oldW = outputOf(p, "stage_windows").windows;
    const newW = outputOf(r, "stage_windows").windows;
    for (const w of oldW) {
      const n = newW.find((x: any) => x.stageId === w.stageId && x.occurrence === w.occurrence);
      expect(n.earliestStart).toBe(addDays(w.earliestStart, 10));
      expect(n.latestEnd).toBe(addDays(w.latestEnd, 10));
    }
    const oldT = outputOf(p, "tasks").tasks;
    const newT = outputOf(r, "tasks").tasks;
    for (const t of oldT) {
      const n = newT.find((x: any) => x.task.id === t.task.id);
      expect(n.task.timing.window.start).toBe(addDays(t.task.timing.window.start, 10));
    }
    const summary = outputOf(r, "change_summary");
    expect(summary.changedTaskIds).toEqual(oldT.map((t: any) => t.task.id).sort());
    expect(summary.oldAssumptions.confirmedInputs.find((i: any) => i.key === "planting_date").value.value).toBe("2026-05-15");
    expect(summary.newAssumptions.confirmedInputs.find((i: any) => i.key === "planting_date").value.value).toBe("2026-05-25");
    expect(summary.recomputedOutputs).toEqual(expect.arrayContaining(["stage_windows", "tasks", "water", "economics"]));

    // Old plan and outputs are unchanged and readable.
    const again = await svc.getPlan(owner, p.snapshot.id);
    expect(again.snapshot.contentHash).toBe(p.snapshot.contentHash);
    expect(outputOf(again, "stage_windows")).toEqual(outputOf(p, "stage_windows"));
    expect(again.lineage.childIds).toEqual([r.snapshot.id]);
  });

  ifDb("cost override recomputes economics only and reuses stage/water outputs without fetching weather", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s, weather } = sources();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    weather.reset();
    const r = await svc.revisePlan({
      ownerId: owner,
      planId: p.snapshot.id,
      expectedParentContentHash: p.snapshot.contentHash,
      changes: [{ type: "cost_override", line: "cashProduction", cost: { basis: "per_ha", amountInr: { low: "350000", central: "400000", high: "450000" }, evidenceIds: [], definition: "farmer-stated cash cost" } }],
    });
    expect(weather.calls).toEqual({ obs: 0, forecast: 0, clim: 0, version: 0 });
    const sw = (v: typeof p) => v.outputs.find((o) => o.kind === "stage_windows")!.id;
    expect(sw(r)).toBe(sw(p));
    expect(r.outputs.find((o) => o.kind === "water")!.id).toBe(p.outputs.find((o) => o.kind === "water")!.id);
    expect(r.outputs.find((o) => o.kind === "economics")!.id).not.toBe(p.outputs.find((o) => o.kind === "economics")!.id);
    const summary = outputOf(r, "change_summary");
    expect(summary.changedTaskIds).toEqual([]);
    expect(summary.reusedOutputs).toEqual(expect.arrayContaining(["stage_windows", "harvest_windows", "water", "market_outlook"]));
    const central = summary.economicDelta.find((d: any) => d.priceSource === "none" && d.scenario === "central");
    expect(Number(central.breakEvenPriceInrPerKg.delta)).toBeGreaterThan(0);
  });

  ifDb("confirmed observed stage re-anchors that stage and its successors", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const svc = service("synthetic", sources().s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    const r = await svc.revisePlan({
      ownerId: owner,
      planId: p.snapshot.id,
      expectedParentContentHash: p.snapshot.contentHash,
      changes: [{ type: "observed_stage", stageId: "vegetative", observedOn: "2026-06-20", journalEntryId: null, basis: "farmer_reported" }],
    });
    const st = outputOf(r, "stage_windows");
    const veg = st.windows.find((w: any) => w.stageId === "vegetative");
    expect(veg.earliestStart).toBe("2026-06-20");
    expect(veg.latestStart).toBe("2026-06-20");
    expect(st.windows.find((w: any) => w.stageId === "sprouting")).toEqual(outputOf(p, "stage_windows").windows.find((w: any) => w.stageId === "sprouting"));
    expect(st.overrides[0].affectedStageIds).toEqual(["maturity_harvest", "rhizome_bulking", "vegetative"]);
  });
});

describe("timeline", () => {
  ifDb("horizon semantics: past observed, past gap unavailable, forecast within horizon, scenario beyond; visuals honest", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s, weather, visuals } = sources();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    visuals.assets = [
      { assetId: "photo-1", kind: "observed_photo", date: "2026-05-20", stageId: null },
      { assetId: "illus-veg", kind: "illustrative", date: null, stageId: "vegetative" },
    ];
    weather.reset();
    const t = await svc.getTimeline(owner, p.snapshot.id, {});
    const day = (d: string) => t.days.find((x) => x.calendarDate === d)!;
    expect(t.asOfDate).toBe("2026-06-10");
    expect(day("2026-05-20").weather.state).toBe("observed");
    expect(day("2026-05-25").weather).toMatchObject({ state: "unavailable", values: null, missingReason: "no_observation" });
    expect(day("2026-06-12").weather).toMatchObject({ state: "forecast", issuedAt: weather.forecastIssuedAt, horizonDays: 2 });
    expect(day("2026-07-15").weather).toMatchObject({ state: "scenario", assumptionId: "climatology_1991-2020", issuedAt: null });
    // Observation rows dated on/after the as-of date are ignored (future relative to the decision).
    expect(day("2026-06-15").weather.state).toBe("forecast");
    // Stages are inferred; days after planting counted from planting date.
    expect(day("2026-05-15")).toMatchObject({ daysAfterPlanting: 0, markers: { planting: true } });
    expect(day("2026-07-15").expectedStage).toMatchObject({ stageId: "vegetative", inferred: true });
    // Visuals: photo only where dated photo exists; past without photo -> none; future -> illustrative or schematic.
    expect(day("2026-05-20").visual).toEqual({ assetId: "photo-1", state: "observed_photo" });
    expect(day("2026-05-21").visual).toEqual({ assetId: null, state: "none" });
    expect(day("2026-07-15").visual).toEqual({ assetId: "illus-veg", state: "illustrative" });
    expect(day("2026-09-01").expectedStage?.stageId).toBe("rhizome_bulking");
    expect(day("2026-09-01").visual).toEqual({ assetId: null, state: "schematic" }); // no illustration for this stage
    // Rain-conditioned drainage task flagged only on forecast heavy-rain day within its window.
    const flagged = t.days.filter((d) => d.tasks.conditionFlags.length > 0).map((d) => d.calendarDate);
    expect(flagged.every((d) => d === weather.heavyRainOn)).toBe(true);
    // Overdue only on/before as-of date.
    expect(t.days.filter((d) => d.calendarDate > t.asOfDate).every((d) => d.tasks.overdue.length === 0)).toBe(true);
    expect(day("2026-06-10").tasks.overdue).toContain("plant:1");
    // Price: no outlook -> unavailable with reason.
    const harvestDay = t.days.find((d) => d.outlook.harvestPeriodId !== null)!;
    expect(harvestDay.outlook).toMatchObject({ state: "unavailable", missingReason: "price_access_key_gated" });
    // Water output is incomplete because past observations have gaps (never filled).
    expect(day("2026-06-12").water.state).toBe("unavailable");
  });

  ifDb("weather source is called once per computation and the cache serves the second request", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s, weather } = sources();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    weather.reset();
    const t1 = await svc.getTimeline(owner, p.snapshot.id, {});
    expect(t1.cached).toBe(false);
    expect([weather.calls.obs, weather.calls.forecast, weather.calls.clim]).toEqual([1, 1, 1]);
    const t2 = await svc.getTimeline(owner, p.snapshot.id, { from: "2026-06-01", to: "2026-06-30" });
    expect(t2.cached).toBe(true);
    expect([weather.calls.obs, weather.calls.forecast, weather.calls.clim]).toEqual([1, 1, 1]);
    expect(t2.days).toHaveLength(30);
    expect(t2.dataVersion).toBe(t1.dataVersion);
    // New data version -> one recomputation.
    weather.version = 2;
    const t3 = await svc.getTimeline(owner, p.snapshot.id, {});
    expect(t3.cached).toBe(false);
    expect([weather.calls.obs, weather.calls.forecast, weather.calls.clim]).toEqual([2, 2, 2]);
    // A different scenario is cached separately.
    const late = await svc.getTimeline(owner, p.snapshot.id, { scenarioId: "late" });
    expect(late.scenarioId).toBe("late");
    expect(late.cached).toBe(false);
    const rows = (await pool.query("SELECT count(*)::int AS n FROM plan_timelines WHERE plan_id=$1", [p.snapshot.id])).rows[0].n;
    expect(rows).toBe(3);
  });
});

describe("water", () => {
  ifDb("complete weather: water scenarios computed (TAW unknown), horizon labelled, rainfed skips irrigation tasks", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s, weather } = sources();
    weather.gaps = new Set();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    const w = outputOf(p, "water");
    expect(w.status).toBe("computed");
    expect(w.interpretation).toBe("irrigation_requirement");
    expect(w.weather.counts.unavailable).toBe(0);
    expect(w.weather.counts.observed).toBeGreaterThan(0);
    expect(w.weather.counts.forecast).toBe(10);
    expect(w.weather.climatologyAssumptionId).toBe("climatology_1991-2020");
    const early = w.byTiming.early;
    expect(early.status).toBe("incomplete"); // TAW unknown is reported as a missing input
    expect(early.evidenceState).toBe("scenario");
    expect(early.permittedPrecision).toBe("range_only");
    expect(early.runs.map((r: any) => r.label)).toEqual(["taw_scenario_60mm", "taw_scenario_120mm", "no_soil_storage"]);
    expect(early.runs[0].grossLitresTotal).not.toBeNull(); // confirmed area 0.5 ha
    expect(p.snapshot.assumptions.map((a) => a.id)).toContain("climatology_1991-2020");
    const t = await svc.getTimeline(owner, p.snapshot.id, {});
    expect(t.days.find((d) => d.calendarDate === "2026-07-15")!.water.state).toBe("scenario");

    const r = await svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: p.snapshot.contentHash, changes: [{ type: "irrigation_category", category: "rainfed" }] });
    expect(outputOf(r, "water").interpretation).toBe("deficit_indicator_rainfed");
    const tasks = outputOf(r, "tasks");
    expect(tasks.tasks.some((x: any) => x.templateId === "check_moisture")).toBe(false);
    expect(tasks.skipped).toEqual([{ templateId: "check_moisture", reason: "not_applicable_rainfed" }]);
    expect(outputOf(r, "change_summary").removedTaskIds).toEqual(["check_moisture:1"]);
  });
});

describe("economics and harvest", () => {
  ifDb("outlook unavailable: no price numbers, only price-independent figures", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const svc = service("synthetic", sources().s);
    const fx = structuredClone(ginger);
    const p = await svc.createPlan(createArgs(fx, owner, farm));
    const e = outputOf(p, "economics");
    expect(e.price).toEqual({ state: "unavailable", sources: [], missingReason: "price_access_key_gated" });
    expect(e.variants).toEqual([]);
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/grossRevenueInr|netCashReturnInr|economicReturnInr/);
    const central = e.priceIndependent.scenarios.find((x: any) => x.name === "central");
    // Synthetic check: 15000 kg/ha * 0.85 = 12750 kg; break-even = 350000/12750 + 3 + 1.5 = 31.95 INR/kg.
    expect(central.perHa.marketableKgTotal).toBe("12750.000");
    expect(central.perHa.breakEvenPriceInrPerKg).toBe("31.95");
    expect(outputOf(p, "market_outlook")).toMatchObject({ state: "unavailable", artifactId: null });
  });

  ifDb("farmer-assumed price computes scenarios labelled farmer_reported", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const { s } = sources();
    const svc = service("synthetic", s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    const r = await svc.revisePlan({ ownerId: owner, planId: p.snapshot.id, expectedParentContentHash: p.snapshot.contentHash, changes: [{ type: "assumed_price", price: { unit: "INR/kg", low: 40, high: 50 } }] });
    const e = outputOf(r, "economics");
    expect(e.price.state).toBe("farmer_reported");
    expect(e.variants).toHaveLength(1);
    const v = e.variants[0];
    expect(v.priceSource).toBe("farmer_reported");
    expect(v.result.status).toBe("complete");
    const central = v.result.scenarios.find((x: any) => x.name === "central");
    // 12750 kg * 45 INR/kg = 573750 gross per ha (synthetic arithmetic check).
    expect(central.perHa.grossRevenueInr).toBe("573750.00");
    expect(r.snapshot.assumptions.map((a) => a.id)).toContain("assumed_price_central_midpoint");
    const assumed = r.snapshot.confirmedInputs.find((i) => i.key === "assumed_price")!;
    expect(assumed.value.evidenceState).toBe("farmer_reported");
    const t = await svc.getTimeline(owner, r.snapshot.id, {});
    expect(t.days.find((d) => d.outlook.harvestPeriodId !== null)!.outlook.state).toBe("farmer_reported");
  });

  ifDb("forecast outlook artifact feeds forecast-labelled prices", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const outlook: MarketOutlookSource = { modes: ["synthetic"], getOutlook: async () => artifact() };
    const svc = service("synthetic", sources("synthetic", outlook).s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    const e = outputOf(p, "economics");
    expect(e.price.state).toBe("forecast");
    expect(e.variants[0].priceSource).toBe("forecast");
    expect(e.variants[0].priceEvidenceIds).toEqual(["synthetic-artifact-1"]);
    expect(p.snapshot.modelVersions.some((m) => m.id === "synthetic-artifact-1")).toBe(true);
  });

  ifDb("historical price reference feeds a reference scenario labelled historical_reference, never forecast (L3)", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    // Synthetic reference built from the harvest windows the engine asks for: weekly medians 40/50/60 INR/kg.
    const outlook: MarketOutlookSource = {
      modes: ["synthetic"],
      getOutlook: async (productId, _m, windows, issueDate) => {
        const rec = (value: string | null, extra: object = {}) => ({ schemaVersion: "1.0" as const, kind: "quantity" as const, unit: "INR/kg" as const, value, evidenceState: value ? ("derived" as const) : ("unavailable" as const), scope: { level: "market" as const, ids: ["synth-m"] }, validFrom: null, validTo: null, issuedAt: null, evidenceIds: ["synth-source-doc"], assumptionIds: [], methodVersion: "t", validationStatus: "pending" as const, missingReason: value ? null : "x", ...extra });
        return {
          kind: "historical_reference" as const, mode: "synthetic" as const, productId, issueDate: issueDate.slice(0, 10), label: "Mandi reference (wholesale), not a farm-gate price", notForecast: true as const, methodVersion: "t",
          primaryMarketId: "synth-m", fallback: null, skippedMarkets: [],
          markets: [{
            marketId: "synth-m", marketName: "synth-m", stateName: null, districtName: null, lastQuote: rec("45.00"), lastQuoteMeta: { date: "2026-01-01", marketName: "synth-m", variety: null, grade: null, rowsOnDate: 1 },
            weeklyRange: { ...rec(null), kind: "range" as const, value: { low: "40.00", high: "60.00" }, evidenceState: "derived" as const, missingReason: null }, weeklyRangeLabel: "x", weeksInRange: 10, validDaysLast365: 30,
            seasonal: windows.map((w) => ({ window: w, reference: rec("50.00"), yearsUsed: [2024, 2025], weeklyMedianRange: { low: "40.00", high: "60.00" } })),
          }],
        };
      },
    };
    const svc = service("synthetic", sources("synthetic", outlook).s);
    const p = await svc.createPlan(createArgs(ginger, owner, farm));
    const e = outputOf(p, "economics");
    expect(e.price).toMatchObject({ state: "historical_reference", sources: ["historical_reference"], missingReason: null });
    expect(e.variants).toHaveLength(1);
    expect(e.variants[0].priceSource).toBe("historical_reference");
    expect(e.variants[0].assumptions.join(" ")).toMatch(/not a forecast/i);
    const central = e.variants[0].result.scenarios.find((x: any) => x.name === "central");
    // 12750 kg marketable per ha * 50 INR/kg = 637500 gross per ha (synthetic arithmetic check).
    expect(central.perHa.grossRevenueInr).toBe("637500.00");
    const ol = outputOf(p, "market_outlook");
    expect(ol).toMatchObject({ state: "historical_reference", artifactId: null });
    expect(JSON.stringify(e)).not.toMatch(/"priceSource":"forecast"/);
    expect(p.snapshot.modelVersions.some((m) => m.id === "synth-source-doc")).toBe(false);
    const t = await svc.getTimeline(owner, p.snapshot.id, {});
    const day = t.days.find((d) => d.outlook.harvestPeriodId !== null)!;
    expect(day.outlook).toMatchObject({ state: "unavailable", missingReason: "historical_reference_only_no_forecast" });
  });

  ifDb("repeated picking yields one harvest window per occurrence with equal-share assumption", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const svc = service("synthetic", sources().s);
    const p = await svc.createPlan(createArgs(picking, owner, farm));
    const h = outputOf(p, "harvest_windows");
    expect(h.repeated).toBe(true);
    expect(h.periods).toHaveLength(4);
    // Picking starts 55..70 days after 2026-07-01; occurrence k shifts by (k-1)*[10,14].
    expect(h.periods[0].earliestStart).toBe("2026-08-25");
    expect(h.periods[1].earliestStart).toBe("2026-09-04");
    expect(h.periods[3].latestStart).toBe(addDays("2026-07-01", 70 + 3 * 14));
    const e = outputOf(p, "economics");
    expect(e.harvestShares.map((x: any) => x.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(e.equalSharesAssumed).toBe(true);
    expect(p.snapshot.assumptions.map((a) => a.id)).toContain("equal_harvest_shares");
    const pickTasks = outputOf(p, "tasks").tasks.filter((t: any) => t.templateId === "pick").map((t: any) => t.task.id);
    expect(pickTasks).toEqual(["pick:1", "pick:2", "pick:3", "pick:4"]);
    // Days between pickings still map to the picking stage, and the water balance has a Kc for them.
    const t = await svc.getTimeline(owner, p.snapshot.id, { scenarioId: "early" });
    const gapDay = t.days.find((d) => d.calendarDate === "2026-09-02")!; // after pick 1 (08-25..09-01), before pick 2 (09-04)
    expect(gapDay.expectedStage).toMatchObject({ stageId: "picking", occurrence: 1 });
    const w = outputOf(p, "water").byTiming.early;
    expect(w.missingInputs.filter((m: string) => m.startsWith("kc:"))).toEqual([]);
  });
});

describe("replay mode", () => {
  ifDb("requires a decision cutoff and forbids forecasts issued after it", async () => {
    const owner = await newOwner();
    const farm = await newFarm(owner);
    const fx = structuredClone(ginger);
    for (const d of fx.stageDefinitions) { d.mode = "replay"; d.reviewStatus = "candidate"; d.evidenceIds = ["evidence-replay-1"]; d.id = d.id.replace("synthetic-", "replay-"); }
    for (const t of fx.parameters.taskTemplates) t.evidenceIds = [];
    const { s, weather } = sources("replay");
    const svc = service("replay", s);
    await expect(svc.createPlan(createArgs(fx, owner, farm, "replay"))).rejects.toMatchObject({ statusCode: 422 });
    // Forecast issued 2026-06-10 but cutoff 2026-06-05 -> leakage.
    await expect(svc.createPlan(createArgs(fx, owner, farm, "replay", { decisionCutoff: "2026-06-05T00:00:00+05:30" }))).rejects.toMatchObject({ code: "replay_leakage" });
    weather.forecastIssuedAt = "2026-06-04T12:00:00+05:30";
    const ok = await svc.createPlan(createArgs(fx, owner, farm, "replay", { decisionCutoff: "2026-06-05T00:00:00+05:30" }));
    expect(ok.snapshot.decidedAt).toBe(new Date("2026-06-05T00:00:00+05:30").toISOString());
    expect(ok.snapshot.mode).toBe("replay");
    // D31: replay climatology is requested with the decision cutoff as its availability bound.
    expect(weather.climOpts.length).toBeGreaterThan(0);
    for (const o of weather.climOpts) expect(o?.availableBy).toBe(new Date("2026-06-05T00:00:00+05:30").toISOString());
    const t = await svc.getTimeline(owner, ok.snapshot.id, {});
    expect(t.asOfDate).toBe("2026-06-05");
    // Synthetic-mode-only decisionCutoff is refused outside replay.
    const syn = service("synthetic", sources().s);
    await expect(syn.createPlan(createArgs(ginger, owner, farm, "synthetic", { decisionCutoff: "2026-06-05T00:00:00+05:30" }))).rejects.toMatchObject({ code: "mode_mismatch" });
  });
});

describe("plan routes", () => {
  let app: FastifyInstance;
  let weather: SyntheticWeather;
  beforeAll(async () => {
    if (!available) return;
    const config = loadConfig({ DATABASE_URL: TEST_DB, SESSION_SECRET: "t".repeat(40), LOG_LEVEL: "silent", RUNTIME_MODE: "synthetic" });
    const src = sources();
    weather = src.weather;
    const svc = service("synthetic", src.s);
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
      if (err instanceof ApiError) return reply.code(err.statusCode).send(errorEnvelope(req.id, "synthetic", { code: err.code, message: err.message }));
      const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
      return reply.code(status).send(errorEnvelope(req.id, "synthetic", { code: status === 400 ? "validation_error" : "internal_error", message: status >= 500 ? "Internal server error" : err.message }));
    });
    const keys = new Map<string, { status: number; body: unknown }>();
    await registerPlanRoutes(app, {
      config,
      service: svc,
      resolveOwner: (req) => {
        const o = req.headers["x-test-owner"];
        if (typeof o !== "string") throw new ApiError(401, "unauthenticated", "no session");
        return o;
      },
      idempotency: {
        run: async (o, exec) => {
          const k = `${o.ownerId}:${o.key}`;
          if (o.key && keys.has(k)) return { ...keys.get(k)!, replay: true };
          const out = await exec();
          if (o.key) keys.set(k, out);
          return { ...out, replay: false };
        },
      },
    });
    await app.ready();
  });
  afterAll(async () => app?.close());

  const body = (farmId: string) => {
    const { ownerId: _o, mode: _m, ...rest } = createArgs(ginger, "x", farmId);
    return rest;
  };

  ifDb("create, read, revise, timeline; cross-owner 404; 409 on conflict; mode not accepted from body", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const farm = await newFarm(a);
    const H = (o: string, extra: Record<string, string> = {}) => ({ "x-test-owner": o, ...extra });

    const withMode = await app.inject({ method: "POST", url: "/api/v1/plans", headers: H(a), payload: { ...body(farm), mode: "live" } });
    expect(withMode.statusCode).toBe(400);

    const c1 = await app.inject({ method: "POST", url: "/api/v1/plans", headers: H(a, { "idempotency-key": "plan-key-0001" }), payload: body(farm) });
    expect(c1.statusCode).toBe(201);
    const env = c1.json();
    expect(env.mode).toBe("synthetic");
    const id = env.data.snapshot.id;
    const hash = env.data.snapshot.contentHash;
    const replay = await app.inject({ method: "POST", url: "/api/v1/plans", headers: H(a, { "idempotency-key": "plan-key-0001" }), payload: body(farm) });
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json().data.snapshot.id).toBe(id);

    // Another owner's farm -> 404.
    const foreign = await app.inject({ method: "POST", url: "/api/v1/plans", headers: H(b), payload: body(farm) });
    expect(foreign.statusCode).toBe(404);

    expect((await app.inject({ method: "GET", url: `/api/v1/plans/${id}`, headers: H(a) })).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ["GET", `/api/v1/plans/${id}`, undefined],
      ["GET", `/api/v1/plans/${id}/timeline`, undefined],
      ["POST", `/api/v1/plans/${id}/revisions`, { expectedParentContentHash: hash, changes: [{ type: "area", amount: 2, unit: "ha" }] }],
    ] as const) {
      const res = await app.inject({ method, url, headers: H(b), ...(payload ? { payload } : {}) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }

    const bad = await app.inject({ method: "POST", url: `/api/v1/plans/${id}/revisions`, headers: H(a), payload: { expectedParentContentHash: "a".repeat(64), changes: [{ type: "area", amount: 2, unit: "ha" }] } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_conflict");

    const rev = await app.inject({ method: "POST", url: `/api/v1/plans/${id}/revisions`, headers: H(a), payload: { expectedParentContentHash: hash, changes: [{ type: "area", amount: 2, unit: "ha" }] } });
    expect(rev.statusCode).toBe(201);
    expect(rev.json().data.snapshot.parentId).toBe(id);

    weather.reset();
    const tl = await app.inject({ method: "GET", url: `/api/v1/plans/${id}/timeline?from=2026-06-01&to=2026-06-07`, headers: H(a) });
    expect(tl.statusCode).toBe(200);
    expect(tl.json().data.days).toHaveLength(7);
    const tl2 = await app.inject({ method: "GET", url: `/api/v1/plans/${id}/timeline?from=2026-06-08&to=2026-06-09`, headers: H(a) });
    expect(tl2.json().data.cached).toBe(true);
    expect(weather.calls.obs).toBe(1);

    expect((await app.inject({ method: "GET", url: `/api/v1/plans/not-a-uuid`, headers: H(a) })).statusCode).toBe(400);
  });
});
