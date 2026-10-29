import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mode } from "@harvest/contracts";
import { StageDefinition } from "@harvest/contracts";
import { loadConfig } from "../src/config";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { loadCatalogueIntoDb } from "../src/catalogue/load";
import { errorEnvelope } from "../src/envelope";
import { ApiError } from "../src/services/errors";
import { PlanService, registerPlanRoutes, defaultSources } from "../src/plans";
import { pickStageSet, districtKey } from "../src/plans/catalogue-resolver";
import { parseTaskTemplateSet, loadTaskTemplateSet, TaskTemplateError } from "../src/plans/task-templates";

/*
 * T12: server-side stage/task resolution for POST /plans. Stage sets come from the catalogue loaded into the database
 * from data/curated; the tests below read the real curated ginger files, not synthetic stand-ins, except where noted.
 */

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_t12_test";
const ROOT = resolve(__dirname, "../../..");
const gingerStages = JSON.parse(readFileSync(resolve(ROOT, "data/curated/stages/ginger.hassan-kharif.stages.json"), "utf8")).map((s: unknown) => StageDefinition.parse(s));

let pool: Pool;
let available = false;
const ifDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });

const withScope = (level: "district" | "state" | "national" | "region", ids: string[], tag: string) =>
  gingerStages.map((d: any) => ({ ...d, id: `${d.id}.${tag}`, scope: { level, ids } }));

describe("pickStageSet (pure)", () => {
  const farm = { stateCode: "KA", districtCode: "typed:KA:hassan" };
  it("normalises typed and registry district ids", () => {
    expect(districtKey("typed:KA:hassan", "KA")).toBe("in-ka-hassan");
    expect(districtKey("IN-KA-hassan", "KA")).toBe("in-ka-hassan");
  });
  it("prefers district over state over national, and ignores sets for other places", () => {
    const national = withScope("national", ["IN"], "n");
    const state = withScope("state", ["IN-KA"], "s");
    const district = withScope("district", ["IN-KA-hassan"], "d");
    const otherDistrict = withScope("district", ["IN-KA-mysuru"], "o");
    const otherState = withScope("state", ["IN-TN"], "t");
    expect(pickStageSet([...national, ...state, ...district, ...otherDistrict, ...otherState], farm)!.level).toBe("district");
    expect(pickStageSet([...national, ...state, ...otherDistrict], farm)!.level).toBe("state");
    expect(pickStageSet([...national, ...otherState, ...otherDistrict], farm)!.level).toBe("national");
    expect(pickStageSet([...otherState, ...otherDistrict], farm)).toBeNull();
    // Region scopes cannot be matched (no curated district-to-region map): never guessed.
    expect(pickStageSet(withScope("region", ["IN-region-west-coast"], "r"), farm)).toBeNull();
    // The chosen set is whole and ordered.
    const picked = pickStageSet([...national, ...district], farm)!;
    expect(picked.defs.map((d) => d.order)).toEqual([0, 1, 2, 3, 4]);
    expect(picked.defs.every((d) => d.id.endsWith(".d"))).toBe(true);
  });
  it("skips disabled definitions", () => {
    const d = withScope("district", ["IN-KA-hassan"], "d").map((x: any) => ({ ...x, reviewStatus: "disabled" }));
    expect(pickStageSet(d, farm)).toBeNull();
  });
});

describe("task template loader", () => {
  const known = new Set(["ev.a", "ev.b"]);
  const tpl = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    stageId: "s1",
    taskType: "scout",
    description: "Look at the field.",
    anchor: "stage_start",
    startOffsetDays: 0,
    endOffsetDays: 3,
    offsetBasis: { kind: "assumption", assumptionId: "offsets" },
    reasonCode: "scout_field",
    evidenceIds: ["ev.a"],
    dependsOn: [],
    irrigation: [],
    amount: null,
    trigger: null,
    ...over,
  });
  const file = (templates: unknown[], assumptions: unknown[] = [{ id: "offsets", description: "planning offsets", value: null, evidenceIds: [] }]) => ({
    schemaVersion: "1.0",
    cropId: "x",
    regionKey: "y",
    templateSet: { id: "set", version: 1 },
    assumptions,
    taskTemplates: templates,
  });

  it("accepts a valid file", () => {
    expect(parseTaskTemplateSet(file([tpl()]), known).taskTemplates).toHaveLength(1);
  });
  it("rejects an evidence id that is not in the evidence file", () => {
    expect(() => parseTaskTemplateSet(file([tpl({ evidenceIds: ["ev.a", "ev.missing"] })]), known)).toThrow(/unknown evidence id ev\.missing/);
    expect(() => parseTaskTemplateSet(file([tpl()], [{ id: "offsets", description: "d", value: null, evidenceIds: ["ev.nope"] }]), known)).toThrow(/unknown evidence id ev\.nope/);
  });
  it("rejects any numeric amount, even a sourced one", () => {
    const amount = { schemaVersion: "1.0", kind: "quantity", value: 7.5, unit: "kg", evidenceState: "observed", scope: { level: "national", ids: ["IN"] }, validFrom: null, validTo: null, issuedAt: null, evidenceIds: ["ev.a"], assumptionIds: [], methodVersion: null, validationStatus: "pending", missingReason: null };
    expect(() => parseTaskTemplateSet(file([tpl({ amount })]), known)).toThrow(TaskTemplateError);
    expect(() => parseTaskTemplateSet(file([tpl({ amount })]), known)).toThrow(/amount must be null/);
  });
  it("rejects undeclared offset or trigger assumptions, a missing dependency and evidence-free agronomic tasks", () => {
    expect(() => parseTaskTemplateSet(file([tpl({ offsetBasis: { kind: "assumption", assumptionId: "ghost" } })]), known)).toThrow(/not declared/);
    expect(() => parseTaskTemplateSet(file([tpl({ trigger: { type: "daily_rain_gte", thresholdAssumptionId: "ghost" } })]), known)).toThrow(/not declared/);
    expect(() => parseTaskTemplateSet(file([tpl({ dependsOn: ["nope"] })]), known)).toThrow(/dependsOn unknown/);
    expect(() => parseTaskTemplateSet(file([tpl({ evidenceIds: [] })]), known)).toThrow(/evidenceIds required/);
    expect(parseTaskTemplateSet(file([tpl({ evidenceIds: [], taskType: "record_observation" })]), known).taskTemplates).toHaveLength(1);
  });
  it("the curated ginger/hassan file loads: every evidence id exists, amounts are null, rain tasks use a named assumption and no chemical is prescribed", () => {
    const set = loadTaskTemplateSet("ginger", "hassan")!;
    expect(set.taskTemplates.length).toBeGreaterThanOrEqual(10);
    expect(set.taskTemplates.every((t) => t.amount === null)).toBe(true);
    const drainage = set.taskTemplates.filter((t) => t.trigger);
    expect(drainage.length).toBeGreaterThanOrEqual(3);
    const th = set.assumptions.find((a) => a.id === drainage[0]!.trigger!.thresholdAssumptionId)!;
    expect(th.value).toMatchObject({ kind: "quantity", unit: "mm", evidenceState: "scenario" });
    expect(th.evidenceIds).toEqual([]); // the threshold is an assumption, not a sourced value
    const text = JSON.stringify(set.taskTemplates).toLowerCase();
    for (const w of ["fungicide", "pesticide", "insecticide", "spray", "mancozeb", "copper", "dose"]) expect(text).not.toContain(w);
    expect(loadTaskTemplateSet("turmeric", "hassan")).toBeNull();
  });
});

// ---------------------------------------------------------------- routes

const OWNER = "";
let owners: { id: string }[] = [];
async function newOwner(): Promise<string> {
  const id = (await pool.query("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0].id as string;
  owners.push({ id });
  return id;
}
async function newFarm(owner: string, state: string | null, district: string | null, extra: { area?: number; irrigation?: string } = {}): Promise<string> {
  const id = (await pool.query("INSERT INTO farms (owner_id, name, state_code, district_code, area_hectares) VALUES ($1,'t12 farm',$2,$3,$4) RETURNING id", [owner, state, district, extra.area ?? null])).rows[0].id as string;
  if (extra.irrigation) await pool.query("INSERT INTO farm_facts (owner_id, farm_id, fact_key, value, provenance, basis, confirmed) VALUES ($1,$2,'irrigation_category',$3::jsonb,'user_entered','farmer_reported',true)", [owner, id, JSON.stringify(extra.irrigation)]);
  return id;
}

async function appFor(mode: Mode): Promise<FastifyInstance> {
  const config = loadConfig({ DATABASE_URL: TEST_DB, SESSION_SECRET: "t".repeat(40), LOG_LEVEL: "silent", RUNTIME_MODE: mode });
  const service = new PlanService({ pool, mode, sources: defaultSources(), clock: () => new Date("2026-06-10T06:00:00Z") });
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; details?: unknown }, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send(errorEnvelope(req.id, mode, { code: err.code, message: err.message, details: err.details }));
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send(errorEnvelope(req.id, mode, { code: status === 400 ? "validation_error" : "internal_error", message: err.message }));
  });
  await registerPlanRoutes(app, {
    config,
    service,
    resolveOwner: (req) => {
      const o = req.headers["x-test-owner"];
      if (typeof o !== "string") throw new ApiError(401, "unauthenticated", "no session");
      return o;
    },
  });
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, owner: string, body: unknown) => app.inject({ method: "POST", url: "/api/v1/plans", headers: { "x-test-owner": owner }, payload: body as object });

beforeAll(async () => {
  pool = createPool(TEST_DB);
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
  await loadCatalogueIntoDb(pool);
});
afterAll(async () => pool?.end());

const dataOf = (res: { json: () => any }) => res.json().data;
const out = (view: any, kind: string) => view.outputs.find((o: any) => o.kind === kind)?.output;

describe("POST /plans resolves stage definitions and task templates on the server", () => {
  ifDb("synthetic mode: a Hassan farm gets the curated ginger stage set and task set; the client sent only crop, product, date", async () => {
    const app = await appFor("synthetic");
    const owner = await newOwner();
    const farm = await newFarm(owner, "KA", "typed:KA:hassan", { area: 1.5, irrigation: "supplemental" });
    const res = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" });
    expect(res.statusCode).toBe(201);
    const view = dataOf(res);
    expect(view.snapshot.sourceSnapshotId).toMatch(/^catalogue-[0-9a-f]{40}$/);
    const windows = out(view, "stage_windows").windows;
    expect(windows.map((w: any) => w.stageId)).toEqual(["sprouting_vegetative", "rhizome_initiation", "rhizome_development", "maturation", "harvest_full_maturity"]);
    expect(windows[0]).toMatchObject({ earliestStart: "2026-06-01", earliestEnd: "2026-08-30" }); // 90 curated days
    const tasks = out(view, "tasks").tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(12); // irrigation tasks included because supplemental
    expect(tasks.every((t: any) => t.task.amount === null)).toBe(true);
    const evidenceIds = new Set<string>(tasks.flatMap((t: any) => t.task.evidenceIds));
    expect([...evidenceIds].every((e) => e.startsWith("ev.ginger."))).toBe(true);
    const drainage = tasks.find((t: any) => t.templateId === "inspect_drainage_vegetative");
    expect(drainage.trigger).toMatchObject({ type: "daily_rain_gte", thresholdMm: 50, thresholdBasis: "assumption" });
    // Same inputs resolve to the same snapshot id (hash of resolved versions), regardless of call order.
    const again = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" });
    expect(dataOf(again).snapshot.sourceSnapshotId).toBe(view.snapshot.sourceSnapshotId);
    await app.close();
  });

  ifDb("irrigation tasks are skipped, not guessed, when the farm's water category is unknown", async () => {
    const app = await appFor("synthetic");
    const owner = await newOwner();
    const farm = await newFarm(owner, "KA", "typed:KA:hassan");
    const view = dataOf(await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" }));
    const t = out(view, "tasks");
    expect(t.tasks.some((x: any) => x.task.taskType === "irrigate")).toBe(false);
    expect(t.skipped.some((s: any) => s.reason === "irrigation_category_unknown")).toBe(true);
    await app.close();
  });

  ifDb("a crop without stage definitions gets 422 stage_definitions_unavailable listing the crops that have them", async () => {
    const app = await appFor("synthetic");
    const owner = await newOwner();
    const farm = await newFarm(owner, "KA", "typed:KA:hassan");
    const p = await pool.query("SELECT slug FROM crop_products WHERE slug LIKE 'turmeric%' LIMIT 1");
    expect(p.rowCount).toBeGreaterThan(0);
    const res2 = await post(app, owner, { farmId: farm, cropId: "turmeric", productId: p.rows[0].slug, plantingDate: "2026-06-01" });
    const body = res2.json();
    expect(res2.statusCode).toBe(422);
    expect(body.error.code).toBe("bad_request"); // code outside the contract list is normalised; the original is preserved
    expect(body.error.details.originalCode).toBe("stage_definitions_unavailable");
    expect(body.error.message).toMatch(/ginger/);
    expect(body.error.details.supportedCrops).toEqual(["ginger"]);
    await app.close();
  });

  ifDb("ginger at a farm outside Karnataka has no matching scope: 422, nothing borrowed from Hassan", async () => {
    const app = await appFor("synthetic");
    const owner = await newOwner();
    const farm = await newFarm(owner, "MH", "typed:MH:pune");
    const res = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.supportedCrops).toContain("ginger");
    await app.close();
  });

  ifDb("the resolver picks the most specific stored scope: district > state > national", async () => {
    const crop = (await pool.query("SELECT id FROM crop_identities WHERE slug='ginger'")).rows[0].id as string;
    const insert = async (tag: string, level: string, ids: string[], days: number) => {
      for (const d of gingerStages as any[]) {
        const def = { ...d, id: `${d.id}.${tag}`, scope: { level, ids }, durationDays: { min: d.isHarvest ? 0 : days, max: d.isHarvest ? 0 : days } };
        await pool.query(
          "INSERT INTO stage_definitions (crop_id, region_code, stage_key, ordinal, typical_days_min, typical_days_max, definition, version, record_key, review_status) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8,'candidate')",
          [crop, ids.join(","), d.stageId, d.order, def.durationDays.min, def.durationDays.max, JSON.stringify(def), def.id],
        );
      }
    };
    await insert("t12.national", "national", ["IN"], 10);
    await insert("t12.state-up", "state", ["IN-UP"], 20);
    const app = await appFor("synthetic");
    const owner = await newOwner();
    // Farm in UP: state set (20-day stages), not national.
    const up = await newFarm(owner, "UP", "typed:UP:lucknow");
    const upView = dataOf(await post(app, owner, { farmId: up, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" }));
    expect(out(upView, "stage_windows").windows[0].earliestEnd).toBe("2026-06-21");
    // Farm in Maharashtra: only the national set applies (10-day stages).
    const mh = await newFarm(owner, "MH", "typed:MH:pune");
    const mhView = dataOf(await post(app, owner, { farmId: mh, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" }));
    expect(out(mhView, "stage_windows").windows[0].earliestEnd).toBe("2026-06-11");
    // The task set is keyed by the picked scope's region; the national set has no curated task file, so no tasks and a warning.
    expect(out(mhView, "tasks").tasks).toHaveLength(0);
    // Hassan still uses the district set (90-day first stage), although national and other sets exist.
    const hs = await newFarm(owner, "KA", "typed:KA:hassan");
    const hsView = dataOf(await post(app, owner, { farmId: hs, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" }));
    expect(out(hsView, "stage_windows").windows[0].earliestEnd).toBe("2026-08-30");
    await app.close();
  });

  ifDb("live mode rejects client-supplied stage definitions and resolves the same sets itself (water and economics stay unavailable)", async () => {
    const app = await appFor("live");
    const owner = await newOwner();
    const farm = await newFarm(owner, "KA", "typed:KA:hassan", { irrigation: "rainfed" });
    const legacy = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", confirmedInputs: [], stageDefinitions: gingerStages, parameters: { schemaVersion: "1.0", taskTemplateSet: { id: "x", version: 1 }, taskTemplates: [], water: null, economics: null } });
    expect(legacy.statusCode).toBe(422);
    expect(legacy.json().error.message).toMatch(/resolved on the server/);
    // Mixed shapes are rejected by validation as well.
    const mixed = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01", stageDefinitions: gingerStages });
    expect(mixed.statusCode).toBe(400);
    const ok = await post(app, owner, { farmId: farm, cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" });
    expect(ok.statusCode).toBe(201);
    const view = dataOf(ok);
    expect(view.snapshot.mode).toBe("live");
    expect(out(view, "water").status).toBe("unavailable");
    expect(out(view, "economics").status).toBe("unavailable");
    expect(out(view, "tasks").tasks.some((t: any) => t.task.taskType === "irrigate")).toBe(false); // rainfed
    expect(ok.json().warnings.map((w: any) => (typeof w === "string" ? w : w.message)).join(" ")).toMatch(/crop coefficients/);
    await app.close();
  });

  ifDb("the legacy body shape still works in synthetic mode (engine tests) and an unknown farm is 404", async () => {
    const app = await appFor("synthetic");
    const owner = await newOwner();
    const fx = JSON.parse(readFileSync(resolve(ROOT, "data/fixtures/synthetic/plan-ginger-basic.json"), "utf8"));
    const farm = await newFarm(owner, "KA", "typed:KA:hassan");
    const { _note, ...body } = fx;
    const legacy = await post(app, owner, { ...body, farmId: farm });
    expect(legacy.statusCode).toBe(201);
    expect(out(dataOf(legacy), "stage_windows").windows[0].stageId).toBe("sprouting");
    const res = await post(app, owner, { farmId: "00000000-0000-4000-8000-000000000000", cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-06-01" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
void OWNER;
