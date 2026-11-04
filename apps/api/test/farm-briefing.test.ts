import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, ToolSchemas, type FarmBriefing } from "@harvest/contracts";
import { bindFarmBriefing, composeFromToday, farmBriefing, guardSections, readOnlyPool, soilUnit, BRIEFING_MAX_CHARS, NEWS_SOURCE_PREFIX } from "../src/agent/bindings/briefing";
import { evaluateGate, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { DEFAULT_LIMITS, loadAgentLimits } from "../src/agent/limits";
import { runAgentTurn, type AgentTurnInput } from "../src/agent/loop";
import { unitAdjacent, numberTokens } from "../src/agent/numbers";
import { PROMPT_VERSION, SYNTHESIS_INSTRUCTIONS, TOOL_INSTRUCTIONS } from "../src/agent/prompts";
import type { ProviderOutcome, TextModelProvider, TextRequest, TextResult } from "../src/agent/provider";
import { implementedBindings, resolveCropIdentityHandler } from "../src/agent/tools/handlers";
import { ToolRegistry, type ToolContext } from "../src/agent/tools/registry";
import { UNIT_RECORD_OWNERS, unitAtPointer, unitRecordOwnerPatterns } from "../src/agent/tool-units";
import { loadCatalogueIntoDb, splitNameParts } from "../src/catalogue/load";
import { loadConfig } from "../src/config";
import { Budget } from "../src/services/budget";
import { persistAlerts } from "../src/services/today/alerts";
import { ndviSeries } from "../src/services/today/ndvi";
import { fakePlanetary } from "./fixtures/sentinel2/fake-provider";
import { ensureYearPlan, generateYearPlan } from "../src/services/year-plan/service";
import { farmBody, login, setupHarness, type Client, type Harness } from "./helpers";

/** 2026-11-02: get_farm_briefing, the server-initiated briefing per farm turn and the output-cap recovery (ASSISTANT_FARM_BRIEFING_SPEC.md section 4). */
let h: Harness;
let a: Client;
let budget: Budget;
beforeAll(async () => {
  h = await setupHarness();
  await loadCatalogueIntoDb(h.pool);
  a = await login(h.app);
  budget = new Budget(h.pool, { totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 });
  await budget.init();
}, 120_000);
afterAll(async () => h?.close());

const ownerOf = async (farmId: string) => (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM farms WHERE id=$1", [farmId])).rows[0]!.owner_id;
const sessionOf = async (ownerId: string) => (await h.pool.query<{ id: string }>("SELECT id FROM sessions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 1", [ownerId])).rows[0]!.id;
const runOf = async (ownerId: string, mode = "synthetic") => (await h.pool.query<{ id: string }>("INSERT INTO agent_runs (owner_id, mode, purpose, status) VALUES ($1,$2,'test','running') RETURNING id", [ownerId, mode])).rows[0]!.id;
const ctxFor = async (ownerId: string, mode: "live" | "synthetic" = "synthetic", over: Partial<ToolContext> = {}): Promise<ToolContext> => ({ ownerId, mode, requestId: "req-briefing", pool: h.pool, agentRunId: await runOf(ownerId, mode), asOf: new Date().toISOString(), ...over });
const briefingDeps = (over: Record<string, unknown> = {}) => ({ config: h.config, budget, ...over });
const counts = async () => {
  const r = await h.pool.query<{ jobs: string; notes: string; overviews: string; cache: string }>(
    "SELECT (SELECT count(*) FROM jobs) jobs, (SELECT count(*) FROM farm_outlook_notes) notes, (SELECT count(*) FROM farm_today_overviews) overviews, (SELECT count(*) FROM provider_cache) cache",
  ).catch(async () => h.pool.query<{ jobs: string; notes: string; overviews: string; cache: string }>("SELECT (SELECT count(*) FROM jobs) jobs, '0' notes, '0' overviews, '0' cache"));
  return r.rows[0]!;
};

/** Walks a briefing: every object that carries `unit` must sit at an owner pattern, and its numbers must resolve to that unit. */
function unitRecordPointers(doc: unknown, path: string[] = [], out: string[] = []): string[] {
  if (Array.isArray(doc)) doc.forEach((x, i) => unitRecordPointers(x, [...path, String(i)], out));
  else if (doc && typeof doc === "object") {
    if (Object.prototype.hasOwnProperty.call(doc, "unit")) out.push(`/${path.join("/")}`);
    for (const [k, v] of Object.entries(doc)) unitRecordPointers(v, [...path, k], out);
  }
  return out;
}
const matchesPattern = (pointer: string) =>
  unitRecordOwnerPatterns("get_farm_briefing").some((p) => {
    const ps = p.slice(1).split("/");
    const s = pointer.slice(1).split("/");
    return ps.length === s.length && ps.every((x, i) => x === "*" || x === s[i]);
  });
function assertUnitRecordsReferenceable(b: unknown) {
  const ptrs = unitRecordPointers(b);
  const outside = ptrs.filter((p) => !matchesPattern(p));
  expect(outside, "unit records outside UNIT_RECORD_OWNERS.get_farm_briefing").toEqual([]);
  for (const p of ptrs) {
    const rec = p.slice(1).split("/").reduce<any>((o, k) => o[k], b);
    const leaves = typeof rec.value === "number" ? [`${p}/value`] : Object.keys(rec.value).map((k) => `${p}/value/${k}`);
    for (const l of leaves) expect(unitAtPointer("get_farm_briefing", b, l)?.unit, l).toBe(rec.unit);
  }
  return ptrs;
}

const q = (value: number, unit: string) => ({ value, unit });
const rr = (low: number, high: number, unit: string, central?: number) => ({ value: { low, ...(central !== undefined ? { central } : {}), high }, unit });
const step = (id: string) => ({ id, kind: "care_task", title: "Weed the field", detail: "Hand weeding", dueFrom: "2026-11-03", dueTo: "2026-11-06", status: "upcoming" });
const day = (date: string) => ({ date, rainMm: q(4, "mm"), tMinC: q(20, "celsius"), tMaxC: q(29, "celsius") });
/** A briefing with every section present (hand-built; used by the drift test). */
const FULL: FarmBriefing = {
  asOf: "2026-11-02T10:00:00.000Z", today: "2026-11-02",
  farm: { districtId: "IN-KA-hassan", districtName: "Hassan", stateId: "IN-KA", stateName: "Karnataka", area: q(0.16, "ha") as never, waterCategory: "rainfed", labour: "family", budget: q(20000, "INR") as never },
  cycle: { cropId: "paddy", cropName: "Paddy", productId: "paddy-grain", productName: "Paddy grain", sowingDate: "2026-10-31", establishmentDate: "2026-10-31", establishmentMethod: "direct_seeded", workspaceStage: "sowed", dayOfSeason: q(2, "days") as never, stageToday: { id: "s1", name: "Establishment", from: "2026-10-31", to: "2026-11-20", basis: "sourced" }, nextStage: { id: "s2", name: "Tillering", from: "2026-11-21", to: "2026-12-20" }, harvestWindow: { earliest: "2027-02-20", latest: "2027-03-05" }, daysToHarvest: rr(110, 123, "days") as never, timelineBasis: "TNAU", satellitePhase: { status: "available", phase: "bare", asOf: "2026-10-30", agreement: "consistent", summary: "Bare soil" } },
  weather: { source: "Open-Meteo", issuedAt: "2026-11-02T00:00:00.000Z", observed: Array.from({ length: 7 }, (_, i) => day(`2026-10-2${6 + Math.min(i, 3)}`)) as never, forecast: Array.from({ length: 7 }, (_, i) => day(`2026-11-0${2 + i}`)) as never, rainLast7Days: q(28, "mm") as never, rainNext7Days: q(31.5, "mm") as never },
  satellite: { latestDate: "2026-10-30", ndvi: q(0.21, "index") as never, neighbourhoodNdvi: q(0.4, "index") as never, typicalRange: rr(0.2, 0.5, "index") as never, verdict: "near_typical", clearShare: q(96, "percent") as never, previous: { date: "2026-10-20", ndvi: q(0.18, "index") as never }, indices: ["EVI", "NDRE", "GNDVI", "SAVI", "NDMI", "LSWI", "NDWI"].map((name) => ({ name, mean: q(0.1, "index") })) as never, source: "Sentinel-2" },
  alerts: Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), type: "weather", severity: "watch", title: `Heavy rain ${i}`, detail: "x".repeat(300), validFrom: "2026-11-03", validTo: "2026-11-05", suggestedStep: "Open drains", source: "Open-Meteo forecast", sourceDate: "2026-11-02" })),
  steps: { nextAction: step("n"), upcoming: Array.from({ length: 8 }, (_, i) => step(`u${i}`)) },
  price: { status: "available", scopeLabel: "Karnataka mandis", harvestDate: "2027-02-27", harvestPrice: q(23.5, "INR/kg") as never, likelyRange: rr(21, 26, "INR/kg") as never, latestObserved: { date: "2026-10-28", median: q(22, "INR/kg") as never }, outlook: "Prices near harvest are usually close to now." },
  economics: {
    harvest: { status: "available", reason: null, yieldForField: rr(600, 900, "kg") as never, revenueForField: rr(14000, 21000, "INR", 17000) as never, costPerHa: q(60000, "INR/ha") as never, profitForField: rr(3000, 9000, "INR", 6000) as never, limitations: ["x"] },
    residue: { status: "available", reason: null, residueName: "paddy straw", surplusForField: rr(0.5, 0.9, "t") as never, options: [{ label: "Dry fodder", incomeForField: rr(500, 900, "INR") as never }], limitations: [] },
    energy: { status: "partial", reason: null, inputEnergyForField: rr(2, 3, "GJ") as never, residueEnergyForField: rr(8, 12, "GJ") as never, limitations: [] },
    carbon: { status: "available", reason: null, emissionsForField: rr(0.4, 0.9, "tCO2e") as never, largestTerm: { label: "Rice methane", amount: rr(0.3, 0.7, "tCO2e") as never }, limitations: [] },
  },
  soil: { status: "ready", samples: [{ reportDate: "2026-09-20", collectionDate: "2026-09-18", depth: rr(0, 15, "cm") as never }], readings: [["ph", "pH"], ["electrical_conductivity", "dS/m"], ["zinc", "ppm"], ["iron", "mg/kg"], ["organic_carbon", "percent"], ["nitrogen_available", "kg/ha"]].map(([p, u]) => ({ parameter: p!, label: p!, measured: q(1, u!) as never, rating: "medium", status: "rated", assumption: null })), facts: ["pH 6.4 is neutral."], narrative: ["Soil is neutral."], narrativeOrigin: "deterministic", ratedFor: { currentCrop: "Paddy", nextCrop: null } },
  plans: { status: "ready", stale: false, option: { label: "Balanced", chosen: true, slots: [{ cropName: "Paddy", productName: "Paddy grain", kind: "crop", fixed: true, sowing: "2026-10-31", harvest: { earliest: "2027-02-20", latest: "2027-03-05" }, yield: rr(3500, 5000, "kg/ha") as never, harvestPrice: q(23, "INR/kg") as never, cost: q(60000, "INR/ha") as never, margin: rr(10000, 40000, "INR/ha", 25000) as never }] }, savedSeasons: [{ year: 2027, season: "Summer", cropName: "Green gram", productName: null, kind: "crop", plannedSowingDate: "2027-03-15", plannedHarvestDate: "2027-05-30" }], previousHarvest: { status: "known", cropName: "Maize", harvestDate: "2026-09-30" } },
  cropFit: { generatedAt: "2026-11-01T00:00:00.000Z", picks: [{ rank: 1, cropId: "green-gram", cropName: "Green gram", productName: "Green gram whole seed", reason: "Short season after paddy" }] },
  journal: { entries: Array.from({ length: 8 }, (_, i) => ({ date: "2026-10-31", kind: i ? "sale" : "expense", text: "Sold maize", quantity: q(100, "kg") as never, expense: i ? null : (q(800, "INR") as never), sale: i ? (q(2200, "INR") as never) : null })), totalsSinceSowing: { from: "2026-10-31", sales: q(2200, "INR") as never, expenses: q(800, "INR") as never, entries: 2 } },
  limitations: ["one"],
};

describe("get_farm_briefing: shape, units and size", () => {
  it("drift: every unit record in a complete briefing is at a UNIT_RECORD_OWNERS pointer and resolves to its unit", () => {
    expect(ToolSchemas.get_farm_briefing.output.safeParse(FULL).success).toBe(true);
    const ptrs = assertUnitRecordsReferenceable(FULL);
    // every owner pattern is exercised by the fixture (no dead patterns)
    for (const pat of unitRecordOwnerPatterns("get_farm_briefing")) expect(ptrs.some((p) => matchesPattern(p) && new RegExp(`^${pat.replace(/\*/g, "[^/]+")}$`).test(p)), pat).toBe(true);
    expect(JSON.stringify(FULL).length).toBeLessThan(BRIEFING_MAX_CHARS);
  });
  it("a unit record outside the owner list has no derivable unit (refused by the gate)", () => {
    const doc = { ...FULL, extra: { value: 5, unit: "mm" } };
    expect(unitAtPointer("get_farm_briefing", doc, "/extra/value")).toBeNull();
    expect(unitAtPointer("get_farm_briefing", FULL, "/weather/forecast/0/rainMm/value")).toEqual({ unit: "mm", basis: "unit_record" });
    expect(UNIT_RECORD_OWNERS.get_farm_briefing).toBeDefined();
  });
  it("soil units map to contract units; anything else is passed without a value", () => {
    expect(soilUnit("-", "ph")).toBe("pH");
    expect(soilUnit("ds/m", "electrical_conductivity")).toBe("dS/m");
    expect(soilUnit("%", "organic_matter")).toBe("percent");
    expect(soilUnit("kg/ha", "nitrogen_unspecified")).toBe("kg/ha");
    expect(soilUnit("meq/100g", "cec")).toBeNull();
  });

  it("review fix 3: an over-long soil rating nulls only the soil section, with a limitation; every other section is intact", () => {
    const b = structuredClone(FULL);
    b.soil!.readings[0]!.rating = "x".repeat(31);
    expect(ToolSchemas.get_farm_briefing.output.safeParse(b).success).toBe(false);
    const lim: string[] = [];
    guardSections(b, lim);
    expect(b.soil).toBeNull();
    expect(lim).toEqual(["The soil readings and ratings could not be included: a stored value did not fit the briefing format."]);
    const { soil: _s, ...rest } = b;
    const { soil: _f, ...full } = FULL;
    expect(rest).toEqual(full);
    expect(ToolSchemas.get_farm_briefing.output.safeParse(b).success).toBe(true);
  });

  it("review fix 3: a bad alert, step or farm field is dropped alone; plan, previous-harvest and stage enums are checked too", () => {
    const b = structuredClone(FULL);
    b.alerts[1]!.severity = "x".repeat(11);
    b.steps.upcoming[2]!.status = "x".repeat(21);
    b.farm.stateId = "x".repeat(21);
    b.plans!.previousHarvest!.status = "x".repeat(21);
    b.cycle!.stageToday!.basis = "x".repeat(21);
    const lim: string[] = [];
    guardSections(b, lim);
    expect(b.alerts).toHaveLength(4);
    expect(b.steps.upcoming).toHaveLength(7);
    expect(b.steps.nextAction).toEqual(FULL.steps.nextAction);
    expect(b.farm.stateId).toBeNull();
    expect(b.farm.districtId).toBe(FULL.farm.districtId);
    expect(b.plans).toBeNull();
    expect(b.cycle).toBeNull();
    expect(b.weather).toEqual(FULL.weather);
    expect(lim.join(" ")).toMatch(/1 alert\(s\) could not be included.*1 upcoming step\(s\)/s);
    expect(lim.join(" ")).toMatch(/The year plan, saved seasons and previous harvest could not be included/);
    expect(lim.join(" ")).toMatch(/The crop cycle and stage could not be included/);
    expect(ToolSchemas.get_farm_briefing.output.safeParse(b).success).toBe(true);
  });

  it("review nits (b), (d) and fix 1: previous NDVI is relative to the health date; indices keep 3 significant figures; news alerts are marked", () => {
    const reading = (date: string, mean: number, indices: Record<string, { mean: number }> | null = null) => ({ date, usable: true, field: { mean, clearFraction: 0.9, indices }, neighbourhood: null });
    const alert = (origin: string) => ({ id: randomUUID(), farmId: randomUUID(), type: "crop_threat", severity: "watch", origin, title: "Pest report", detail: "Reported nearby.", source: { name: "The Hindu", url: "https://example.org/a", date: "2026-11-01" }, validFrom: "2026-11-01", validTo: "2026-11-08", suggestedStep: null, createdAt: "2026-11-01T00:00:00.000Z" });
    const v = {
      cycle: null, timeline: null, weatherTrack: [], upcoming: [], nextAction: null, priceTrack: [], harvestPrice: null, outlookNote: null,
      harvestEconomics: null, residueIncome: null, energyFootprint: null, carbonFootprint: null,
      alerts: [alert("rule"), alert("grounded_review")],
      health: { date: "2026-10-20", ndviMean: 0.6234, neighbourhoodMean: 0.5, typicalRange: { low: 0.0042, high: 0.71 }, verdict: "near_typical", clearFraction: 0.9 },
      ndvi: { readings: [reading("2026-10-10", 0.5), reading("2026-10-20", 0.6234), reading("2026-10-30", 0.0049, { evi: { mean: 0.00412 }, ndmi: { mean: 0.31234 } })], latestUsable: reading("2026-10-30", 0.0049, { evi: { mean: 0.00412 }, ndmi: { mean: 0.31234 } }) },
    };
    const b = structuredClone(FULL);
    composeFromToday(b, v as never, "2026-11-02", []);
    expect(b.satellite!.latestDate).toBe("2026-10-20");
    expect(b.satellite!.previous).toEqual({ date: "2026-10-10", ndvi: { value: 0.5, unit: "index" } });
    expect(b.satellite!.ndvi).toEqual({ value: 0.623, unit: "index" });
    expect(b.satellite!.typicalRange).toEqual({ value: { low: 0.0042, high: 0.71 }, unit: "index" });
    expect(b.satellite!.indices).toEqual([{ name: "EVI", mean: { value: 0.00412, unit: "index" } }, { name: "NDMI", mean: { value: 0.312, unit: "index" } }]);
    expect(b.alerts.map((a) => a.source)).toEqual(["The Hindu", `${NEWS_SOURCE_PREFIX}The Hindu`]);
    expect(ToolSchemas.get_farm_briefing.output.safeParse(b).success).toBe(true);
  });
});

describe("get_farm_briefing: composition on seeded farms (test DB, synthetic mode)", () => {
  it("full farm: cycle, alerts, steps, soil report, stored year plan, saved seasons and journal; read-only; no names or coordinates; under 16,000 characters", async () => {
    const res = await a.call("POST", "/api/v1/farms/demo", { payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const farmId = res.json().data.farm.id as string;
    const ownerId = await ownerOf(farmId);
    const sessionId = await sessionOf(ownerId);
    // soil report with a pH, EC and an unmapped unit
    const report = (await h.pool.query<{ id: string }>("INSERT INTO soil_reports(owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,'field_report','synthetic','confirmed','r.pdf','application/pdf',1,$3,'k') RETURNING id", [ownerId, farmId, randomUUID()])).rows[0]!;
    const sample = (await h.pool.query<{ id: string }>("INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,collection_date) VALUES($1,$2,$3,'s1',1,'2026-09-20') RETURNING id", [ownerId, farmId, report.id])).rows[0]!;
    for (const [i, [parameter, value, unit, label]] of ([["ph", 6.4, "pH", "pH"], ["electrical_conductivity", 0.21, "ds/m", "EC"], ["organic_matter", 1.2, "%", "OM"], ["unknown_other", 7, "meq/100g", "CEC"], ["zinc_available", 0.004, "ppm", "Zn"]] as const).entries())
      await h.pool.query("INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,$2,$3,$4,$5,$6,$7,'exact','soil',1,$4,'matched','high','[]'::jsonb,$7,$6)", [sample.id, `m-${i}`, parameter, label, String(value), unit, value]);
    // alerts
    const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await persistAlerts(h.pool, ownerId, farmId, "synthetic", [
      { type: "weather", severity: "info", origin: "rule", title: "Light rain", detail: "Light rain is forecast.", source: { name: "Open-Meteo", url: "https://open-meteo.com/", date: today }, validFrom: today, validTo: plus(2), suggestedStep: null },
      { type: "weather", severity: "warning", origin: "rule", title: "Heavy rain", detail: "Heavy rain is forecast.", source: { name: "Open-Meteo", url: "https://open-meteo.com/", date: today }, validFrom: plus(1), validTo: plus(3), suggestedStep: "Open the field drains." },
    ]);
    // stored year plan (synthetic generation, no model call)
    const yp = { pool: h.pool, config: h.config, budget };
    const pending = await ensureYearPlan(yp, { ownerId, sessionId }, farmId);
    if (pending.reviewId) await generateYearPlan(yp, pending.reviewId, ownerId);

    const before = await counts();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
    const out = await farmBriefing(briefingDeps(), farmId, await ctxFor(ownerId));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await counts()).toEqual(before);

    expect(ToolSchemas.get_farm_briefing.output.safeParse(out).success).toBe(true);
    expect(out.cycle).not.toBeNull();
    expect(out.cycle!.cropName.length).toBeGreaterThan(0);
    expect(out.alerts.map((x) => x.severity)).toEqual(["warning", "info"]);
    expect(out.steps.nextAction ?? out.steps.upcoming[0]).toBeDefined();
    expect(out.soil?.readings.find((r) => r.parameter === "ph")?.measured).toEqual({ value: 6.4, unit: "pH" });
    expect(out.soil?.readings.find((r) => r.parameter === "electrical_conductivity")?.measured).toEqual({ value: 0.21, unit: "dS/m" });
    expect(out.soil?.readings.find((r) => r.label === "CEC")?.measured ?? null).toBeNull();
    // review fix 1: a small soil reading keeps 3 significant figures (was rounded to 0 at 2 decimals)
    expect(out.soil?.readings.find((r) => r.label === "Zn")?.measured).toEqual({ value: 0.004, unit: "ppm" });
    expect(out.limitations.join(" ")).toMatch(/CEC \(meq\/100g\)/);
    expect(out.plans).not.toBeNull();
    expect(out.plans!.option).not.toBeNull();
    // The demo (seed v6) saves no future seasons; the saved-season shape is covered by the briefing unit fixture above.
    expect(out.plans!.savedSeasons).toEqual([]);
    expect(out.journal!.entries.length).toBeGreaterThan(0);
    expect(out.journal!.entries.length).toBeLessThanOrEqual(8);
    expect(out.journal!.totalsSinceSowing).not.toBeNull();
    // Field operations lines travel in their own `scouting` list (one line per field or the farm, <= 300 chars), not in limitations.
    expect(out.scouting?.length).toBeGreaterThan(0);
    expect(out.scouting!.every((l) => l.length <= 300 && /next field check due \d{4}-\d{2}-\d{2}/.test(l))).toBe(true);
    expect(out.limitations.some((l) => /next field check due/.test(l))).toBe(false);
    assertUnitRecordsReferenceable(out);
    const json = JSON.stringify(out);
    expect(json.length).toBeLessThan(BRIEFING_MAX_CHARS);
    expect(json).not.toContain("Arsikere demo farm");
    expect(json).not.toContain(ownerId);
    expect(json).not.toContain(sessionId);
    expect(json).not.toMatch(/"(lat|lon|point|coordinates|boundary)"/);
    expect(json).not.toMatch(/13\.25\b|76\.25\b/);
  }, 120_000);

  it("bare farm: absent sections with limitations; never a failed tool", async () => {
    const f = (await a.call("POST", "/api/v1/farms", { payload: farmBody({ name: `Bare ${randomUUID()}`, facts: {} }) })).json().data as { id: string };
    const ownerId = await ownerOf(f.id);
    const out = await farmBriefing(briefingDeps(), f.id, await ctxFor(ownerId));
    expect(ToolSchemas.get_farm_briefing.output.safeParse(out).success).toBe(true);
    expect(out.cycle).toBeNull();
    expect(out.soil).toBeNull();
    expect(out.cropFit).toBeNull();
    expect(out.alerts).toEqual([]);
    const lim = out.limitations.join(" ");
    expect(lim).toMatch(/no current crop cycle/);
    expect(lim).toMatch(/No confirmed soil report/);
    expect(lim).toMatch(/journal has no entries/);
  });

  it("a failing section degrades to a limitation; a timeout returns what finished; foreign farms are 404", async () => {
    const f = (await a.call("POST", "/api/v1/farms", { payload: farmBody({ name: `Degrade ${randomUUID()}`, facts: {} }) })).json().data as { id: string };
    const ownerId = await ownerOf(f.id);
    const throwing = { get ndviSeries(): never { throw new Error("boom"); } };
    const out = await farmBriefing(briefingDeps({ today: { providers: throwing } }), f.id, await ctxFor(ownerId));
    expect(out.limitations.join(" ")).toMatch(/The Today view .* could not be included/);
    expect(out.farm.area?.unit ?? "ha").toBe("ha");
    const slow = await farmBriefing(briefingDeps({ timeoutMs: 0 }), f.id, await ctxFor(ownerId));
    expect(slow.limitations.join(" ")).toMatch(/did not finish within 0 s/);
    const other = await login(h.app);
    const foreign = (await other.call("POST", "/api/v1/farms", { payload: farmBody({ name: `Other ${randomUUID()}`, facts: {} }) })).json().data as { id: string };
    await expect(farmBriefing(briefingDeps(), foreign.id, await ctxFor(ownerId))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("live mode: queues no job, writes nothing and reaches no network (writes refused by the read-only pool)", async () => {
    const res = await (await login(h.app)).call("POST", "/api/v1/farms/demo", { payload: {} });
    const farmId = res.json().data.farm.id as string;
    const ownerId = await ownerOf(farmId);
    const before = await counts();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
    const out = await farmBriefing({ config: { ...h.config, RUNTIME_MODE: "live", MODEL_API_KEY: "test-key" }, budget }, farmId, await ctxFor(ownerId, "live"));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await counts()).toEqual(before);
    expect(ToolSchemas.get_farm_briefing.output.safeParse(out).success).toBe(true);
    // review fix 4: guard lines caused by the read-only wrapper itself do not reach the briefing's limitations
    const lim = out.limitations.join(" ");
    expect(lim).not.toMatch(/internal_error|provider_unreachable|briefing_no_network|will be retried|could not be read from the provider/);
    expect(lim).not.toMatch(/The harvest outlook note could not be read now/);
    // review fix 4: a stored ready outlook note is read directly (plain SELECT) when the Today view cannot return it
    expect(out.cycle?.productId).toBeTruthy();
    expect(out.price, "the demo farm has a price section in live mode").not.toBeNull();
    await h.pool.query(
      "INSERT INTO farm_outlook_notes(owner_id,farm_id,mode,product_id,harvest_week,context_hash,status,text,facts,updated_at) VALUES($1,$2,'live',$3,'2027-W09','h-old','ready','Older stored outlook sentence.','[]'::jsonb,now() - interval '1 day'),($1,$2,'live',$3,'2027-W10','h-new','ready','Stored outlook sentence for the briefing.','[]'::jsonb,now()),($1,$2,'synthetic',$3,'2027-W11','h-syn','ready','Synthetic sentence.','[]'::jsonb,now() + interval '1 minute')",
      [ownerId, farmId, out.cycle!.productId],
    );
    const again = await farmBriefing({ config: { ...h.config, RUNTIME_MODE: "live", MODEL_API_KEY: "test-key" }, budget }, farmId, await ctxFor(ownerId, "live"));
    expect(again.price?.outlook).toBe("Stored outlook sentence for the briefing.");
    expect(again.limitations.join(" ")).toMatch(/harvest outlook sentence is the latest stored one/);
  }, 60_000);

  it("live mode with a stale stored scene: no automatic predicted-look request, no fake limitation, nothing written", async () => {
    // SYNTHETIC farm and scenes; the injected fake Planetary Computer only primes the stored readings through the writable pool.
    const f = (await a.call("POST", "/api/v1/farms", { payload: farmBody({ name: `Stale ${randomUUID()}`, facts: {} }) })).json().data as { id: string };
    const ownerId = await ownerOf(f.id);
    const ring = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];
    const put = await a.call("PUT", `/api/v1/farms/${f.id}/workspace`, { payload: { expectedVersion: 0, boundary: { type: "Polygon", coordinates: [ring] }, previousHarvest: { status: "unknown" }, cycles: [{ id: "cycle-1", cropId: "maize", cropName: "Maize", sowingDate: "2026-09-20", stage: "growing" }], rotationPlans: [] } });
    expect(put.statusCode, put.body).toBe(200);
    const id = "S2A_MSIL2A_20261027T052231_R062_T43PFQ_20261027T101714";
    const fake = fakePlanetary([{ id, datetime: "2026-10-27T05:22:31.024Z", field: { ndvi: 0.63 }, neighbourhood: { ndvi: 0.63 } }]);
    const asOf = "2026-11-04T04:00:00.000Z"; // the newest scene is 8 days old
    const requestFutureLook = vi.fn(async () => { throw new Error("must not be called"); });
    const pendingGapLooks = vi.fn(async () => 0);
    const today = { providers: { requestFutureLook: requestFutureLook as never, pendingGapLooks: pendingGapLooks as never, ndviSeries: ((d: Parameters<typeof ndviSeries>[0], ...r: unknown[]) => (ndviSeries as (...x: unknown[]) => unknown)({ ...d, pool: h.pool, fetchImpl: fake.fetchImpl }, ...r)) as never } };
    const before = await h.pool.query("SELECT (SELECT count(*) FROM future_look_assets) a, (SELECT count(*) FROM jobs) j");
    const out = await farmBriefing(briefingDeps({ config: { ...h.config, RUNTIME_MODE: "live", MODEL_API_KEY: "test-key" }, today }), f.id, await ctxFor(ownerId, "live", { asOf }));
    expect(out.today).toBe("2026-11-04");
    expect(requestFutureLook).not.toHaveBeenCalled();
    expect(pendingGapLooks).not.toHaveBeenCalled();
    expect(out.limitations.join(" ")).not.toMatch(/predicted look|internal_error|being made with AI/i);
    expect(await h.pool.query("SELECT (SELECT count(*) FROM future_look_assets) a, (SELECT count(*) FROM jobs) j")).toMatchObject({ rows: before.rows });
  }, 60_000);

  it("readOnlyPool refuses writes and transactions, runs reads", async () => {
    const ro = readOnlyPool(h.pool);
    await expect(ro.query("SELECT 1 AS x")).resolves.toMatchObject({ rows: [{ x: 1 }] });
    await expect(ro.query("INSERT INTO jobs(type) VALUES ('x')")).rejects.toMatchObject({ code: "read_only_briefing" });
    await expect(ro.query("  update farms set name='x'")).rejects.toMatchObject({ code: "read_only_briefing" });
    await expect(ro.query("SELECT id FROM farms FOR UPDATE")).rejects.toMatchObject({ code: "read_only_briefing" });
    await expect(ro.query("WITH x AS (DELETE FROM jobs RETURNING id) SELECT * FROM x")).rejects.toMatchObject({ code: "read_only_briefing" });
    await expect(ro.connect()).rejects.toMatchObject({ code: "read_only_briefing" });
  });

  it("replay excludes the tool; it is bound only with deps and advertised in live and synthetic", () => {
    const reg = new ToolRegistry(implementedBindings(briefingDeps()));
    expect(reg.isAllowed("get_farm_briefing", "replay")).toBe(false);
    expect(reg.advertisedFor("replay").some((t) => t.name === "get_farm_briefing")).toBe(false);
    expect(reg.advertisedFor("live").some((t) => t.name === "get_farm_briefing")).toBe(true);
    expect(reg.advertisedFor("synthetic").find((t) => t.name === "get_farm_briefing")!.description).toMatch(/do not call it again/);
    expect(new ToolRegistry(implementedBindings()).advertisedFor("live").some((t) => t.name === "get_farm_briefing")).toBe(false);
    expect(typeof bindFarmBriefing(briefingDeps())).toBe("function");
  });
});

// ---------------------------------------------------------------- loop
let seq = 0;
const result = (over: Partial<TextResult> = {}): TextResult => ({ provenance: "meta_live", responseId: `resp_${++seq}`, requestId: `rq_${seq}`, model: "muse-spark-1.3", outputText: null, functionCalls: [], usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }, latencyMs: 1, retries: 0, ...over });
const profileJson = (intent: string) => JSON.stringify({ intent, language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null });
const answerJson = () => JSON.stringify({ schemaVersion: "1.0", intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "text", text: "Your next step is listed in the farm schedule.", numericRefIds: [], claimIds: [] }], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [] });
const overflow = (): ProviderOutcome => ({ ok: false, error: { code: "provider_error", message: "Provider response incomplete: max_output_tokens", retryable: false, outcomeUncertain: true, requestId: "rq_x", retries: 0, incompleteReason: "max_output_tokens" } });
class Scripted implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly billable = false;
  readonly requests: TextRequest[] = [];
  constructor(private readonly script: (req: TextRequest, n: number) => TextResult | ProviderOutcome) {}
  async call(req: TextRequest): Promise<ProviderOutcome> {
    this.requests.push(req);
    const out = this.script(req, this.requests.length);
    return "ok" in out ? out : { ok: true, result: out };
  }
}
const loopDeps = (provider: TextModelProvider, withBriefing = true) => ({ pool: h.pool, budget, provider, registry: new ToolRegistry(implementedBindings(withBriefing ? briefingDeps() : undefined)), limits: { ...DEFAULT_LIMITS }, models: { text: "muse-spark-1.3", escalation: "muse-wonder-1.0" } });
const bareFarm = async () => {
  const f = (await a.call("POST", "/api/v1/farms", { payload: farmBody({ name: `Loop ${randomUUID()}`, facts: {} }) })).json().data as { id: string };
  return { id: f.id, ownerId: await ownerOf(f.id) };
};
const turn = (ownerId: string, over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({ ownerId, sessionId: null, mode: "synthetic", requestId: "req-loop", language: "en", text: "How to take care of my crop in next 15 days?", ...over });

describe("loop: server-initiated farm briefing", () => {
  it("calls it once per farm turn before the first tool round; request_context carries its id; trace says farm_selected", async () => {
    const f = await bareFarm();
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson("plan_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() })));
    const r = await runAgentTurn(loopDeps(p), turn(f.ownerId, { farmId: f.id }));
    expect(r.status).toBe("approved");
    expect(r.serverInitiatedTools).toEqual(["get_farm_briefing"]);
    const stored = await h.pool.query<{ id: string; tool_name: string; status: string; call_id: string }>("SELECT id, tool_name, status, call_id FROM tool_results WHERE agent_run_id=$1 ORDER BY ordinal", [r.runId]);
    expect(stored.rows.map((x) => `${x.tool_name}:${x.status}:${x.call_id}`)).toEqual(["get_farm_briefing:ok:server_get_farm_briefing_1"]);
    const step = r.trace.toJSON().steps.find((s) => s.kind === "server_initiated_tool");
    expect(step?.detail).toMatchObject({ tool: "get_farm_briefing", reason: "farm_selected", toolResultId: stored.rows[0]!.id });
    const firstRound = JSON.stringify(p.requests.find((q) => q.pass === "tool_round")!.input);
    expect(firstRound).toContain('server_initiated_tool_result tool=\\"get_farm_briefing\\"');
    expect(firstRound).toContain(`\\"briefingToolResultId\\":\\"${stored.rows[0]!.id}\\"`);
    expect(r.toolCalls).toBe(0); // not counted against the model's tool-call allowance
  });

  it("review nit (c): a repeat get_farm_briefing call gets the stored view (same toolResultId), runs nothing and is not counted", async () => {
    const f = await bareFarm();
    let rounds = 0;
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson("plan_question") });
      if (req.pass === "tool_round") return ++rounds === 1 ? result({ functionCalls: [{ callId: "c1", name: "get_farm_briefing", arguments: JSON.stringify({ farmId: f.id }) }] }) : result({ outputText: "done" });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(loopDeps(p), turn(f.ownerId, { farmId: f.id }));
    expect(r.status).toBe("approved");
    expect(r.toolCalls).toBe(0);
    const stored = await h.pool.query<{ id: string; call_id: string }>("SELECT id, call_id FROM tool_results WHERE agent_run_id=$1 ORDER BY ordinal", [r.runId]);
    expect(stored.rows.map((x) => x.call_id)).toEqual(["server_get_farm_briefing_1"]);
    const second = p.requests.filter((q) => q.pass === "tool_round")[1]!;
    const delivered = (second.input as { type?: string; call_id?: string; output?: string }[]).find((i) => i.type === "function_call_output" && i.call_id === "c1")!;
    expect(JSON.parse(delivered.output!).toolResultId).toBe(stored.rows[0]!.id);
    expect(r.trace.toJSON().steps.find((s) => s.kind === "tool_call" && (s.detail as { status?: string }).status === "reused")?.detail).toMatchObject({ tool: "get_farm_briefing", callId: "c1", toolResultId: stored.rows[0]!.id });
  });

  it("never without a farm, never in replay", async () => {
    const f = await bareFarm();
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson("plan_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() })));
    expect((await runAgentTurn(loopDeps(p), turn(f.ownerId))).serverInitiatedTools).toBeUndefined();
    const replay = await runAgentTurn(loopDeps(p), turn(f.ownerId, { farmId: f.id, mode: "replay", asOf: new Date().toISOString() }));
    expect(replay.serverInitiatedTools).toBeUndefined();
  });

  it("synthesis input carries the briefing when tools are skipped", async () => {
    const f = await bareFarm();
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson("out_of_scope") }) : result({ outputText: answerJson() })));
    const r = await runAgentTurn(loopDeps(p), turn(f.ownerId, { farmId: f.id }));
    expect(r.serverInitiatedTools).toEqual(["get_farm_briefing"]);
    expect(p.requests.some((q) => q.pass === "tool_round")).toBe(false);
    const synth = JSON.stringify(p.requests.find((q) => q.pass === "synthesis")!.input);
    expect(synth).toContain('server_initiated_tool_result tool=\\"get_farm_briefing\\"');
  });
});

describe("loop: output-cap recovery", () => {
  it("one overflow: the same request is re-sent once with the cap doubled, then succeeds", async () => {
    let synth = 0;
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson("plan_question") });
      if (req.pass === "tool_round") return result({ outputText: "done" });
      return ++synth === 1 ? overflow() : result({ outputText: answerJson() });
    });
    const f = await bareFarm();
    const r = await runAgentTurn(loopDeps(p, false), turn(f.ownerId));
    expect(r.status).toBe("approved");
    const synths = p.requests.filter((q) => q.pass === "synthesis");
    expect(synths.map((q) => q.maxOutputTokens)).toEqual([6000, 12000]);
    expect(synths[1]!.previousResponseId).toBe(synths[0]!.previousResponseId);
    expect(JSON.stringify(synths[1]!.input)).toBe(JSON.stringify(synths[0]!.input));
    expect(r.trace.toJSON().steps.find((s) => s.kind === "cap_recovery")?.detail).toMatchObject({ pass: "synthesis", fromTokens: 6000, toTokens: 12000 });
  });

  it("two overflows fail the run with reason max_output_tokens; the ceiling caps the retry", async () => {
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson("plan_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : overflow()));
    const f = await bareFarm();
    const r = await runAgentTurn({ ...loopDeps(p, false), limits: { ...DEFAULT_LIMITS, maxOutputTokensCeiling: 9000 } }, turn(f.ownerId));
    expect(r.status).toBe("failed");
    expect(r.incomplete?.reasons).toContain("max_output_tokens");
    expect(r.error?.code).toBe("max_output_tokens");
    expect(p.requests.filter((q) => q.pass === "synthesis").map((q) => q.maxOutputTokens)).toEqual([6000, 9000]);
    expect(r.trace.toJSON().steps.filter((s) => s.kind === "cap_recovery")).toHaveLength(1);
  });

  it("defaults 6000/2000 and ceiling 16000, configurable through AGENT_MAX_OUTPUT_TOKENS_CEILING", () => {
    expect(DEFAULT_LIMITS).toMatchObject({ maxOutputTokens: 6000, interpretationMaxOutputTokens: 2000, maxOutputTokensCeiling: 16000 });
    expect(loadAgentLimits({ AGENT_MAX_OUTPUT_TOKENS_CEILING: "12000" }).maxOutputTokensCeiling).toBe(12000);
    const c = loadConfig({ DATABASE_URL: "postgres://localhost/x", SESSION_SECRET: "t".repeat(40), ALLOWED_ORIGINS: "http://localhost:5173" });
    expect([c.AGENT_MAX_OUTPUT_TOKENS, c.AGENT_INTERPRETATION_MAX_OUTPUT_TOKENS, c.AGENT_MAX_OUTPUT_TOKENS_CEILING]).toEqual([6000, 2000, 16000]);
  });
});

describe("prompts", () => {
  it("version bumped; briefing rules present; existing rules kept", () => {
    expect(PROMPT_VERSION).toBe("2026-11-02.2");
    // review nit (d): rule alerts and steps are guidance; a news-review alert is a reported item
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/rule alerts and steps are the application's own dated guidance/);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/a news-review alert \(origin grounded_review, or a source that begins "News review:"\) is a reported item, not guidance/);
    expect(SYNTHESIS_INSTRUCTIONS).not.toMatch(/Its steps and alerts are the application's own dated guidance/);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/primary source for any question about the current crop or farm/);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/short dated plan: the next action, then the alerts, then the forecast, then what to watch/);
    expect(TOOL_INSTRUCTIONS).toMatch(/Do not call get_farm_briefing again; it is already in the context\./);
    expect(TOOL_INSTRUCTIONS).toMatch(/MUST call screen_crops with contextId = request_context.farmId/);
  });
});

// ---------------------------------------------------------------- gate
describe("gate: briefing refs and units", () => {
  const OWNER = "o";
  const RUN = "r";
  const gctx = (): GateContext => ({ ownerId: OWNER, mode: "synthetic", agentRunId: RUN, asOf: "2026-11-02T06:00:00Z", language: "en", claimScope: { geographyIds: [], districtIds: ["IN-KA-hassan"], stateIds: ["IN-KA"], regionIds: [], cropIds: [] }, userText: "", rainHorizonDays: 7 });
  const stored = (result: unknown): StoredToolResult => ({ id: "t1", ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName: "get_farm_briefing", status: "ok", result });
  const facts = (result: unknown = FULL): GateFacts => ({ toolResults: new Map([["t1", stored(result)]]), evidence: new Map(), knownCropIds: new Set(), productForms: new Map(), cropNames: new Map() });
  const ref = (p: string, unit: string, digits = 1) => ({ id: "n1", toolResultId: "t1", jsonPointer: p, presentation: { unit, sourceUnit: unit, rounding: { mode: "decimals", digits }, intervalLabel: "none" } });
  const out = (text: string, r: ReturnType<typeof ref>) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "numeric", text, numericRefIds: ["n1"], claimIds: [] }], numericRefs: [r], claimEvidenceRefs: [], limitations: [] });
  const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);

  it("a ref into /weather/forecast/0/rainMm/value is forecast-backed; observed weather is not", () => {
    expect(evaluateGate(out("Forecast rain this week will be 4 mm.", ref("/weather/forecast/0/rainMm/value", "mm")), gctx(), facts()).status).toBe("approved");
    const next7 = evaluateGate(out("Forecast rain this week will be 32 mm in total.", ref("/weather/rainNext7Days/value", "mm", 0)), gctx(), facts());
    expect(next7.status, JSON.stringify(next7.issues)).toBe("approved");
    expect(codes(evaluateGate(out("Forecast rain this week will be 4 mm.", ref("/weather/observed/0/rainMm/value", "mm")), gctx(), facts()))).toContain("future_rain_unsourced");
  });
  it("review fix 2: a briefing forecast ref backs only 7-day, non-seasonal rain sentences", () => {
    const next7 = () => ref("/weather/rainNext7Days/value", "mm", 0);
    for (const text of [
      "This monsoon season will bring 32 mm.",
      "Rain this year will be 32 mm.",
      "The Kharif rain will be 32 mm.",
      "Rain next month will be 32 mm.",
      "Forecast rain this week will be 32 mm. The monsoon will fail this year.",
      "इस साल बारिश 32 mm होगी।",
    ]) {
      const r = evaluateGate(out(text, next7()), { ...gctx(), ...(/[^\x00-\x7F]/.test(text) ? { language: "hi" } : {}) }, facts());
      expect(r.status, text).not.toBe("approved");
      expect(codes(r), text).toContain("future_rain_unsourced");
    }
    expect(evaluateGate(out("Forecast rain this week will be 32 mm in total.", next7()), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("Rain over the coming days will be 32 mm.", next7()), gctx(), facts()).status).toBe("approved");
    expect(codes(evaluateGate(out("Rain in 20 days will be 32 mm.", next7()), gctx(), facts()))).toContain("future_daily_rain_beyond_horizon");
    // other tools keep the block-level rule
    const wb = { ...stored({ result: { runs: [{ effectiveRainFromForecastMm: 32 }] } }), toolName: "calculate_water_balance" };
    const wbFacts: GateFacts = { ...facts(), toolResults: new Map([["t1", wb]]) };
    const wbr = evaluateGate(out("This monsoon season will bring 32 mm.", ref("/result/runs/0/effectiveRainFromForecastMm", "mm", 0)), gctx(), wbFacts);
    expect(wbr.status, JSON.stringify(wbr.issues)).toBe("approved");
  });
  it("review fix 1: a non-zero soil reading or index may not be shown as 0", () => {
    const doc = structuredClone(FULL);
    doc.soil!.readings[2]!.measured = { value: 0.004, unit: "ppm" } as never;
    const zn = (digits: number, mode: "decimals" | "significant" = "decimals") => ({ ...ref("/soil/readings/2/measured/value", "ppm", digits), presentation: { ...ref("/soil/readings/2/measured/value", "ppm", digits).presentation, rounding: { mode, digits } } });
    const zero = evaluateGate(out("Zinc is 0 ppm.", zn(2)), gctx(), facts(doc));
    expect(zero.status).not.toBe("approved");
    expect(codes(zero)).toContain("numeric_ref_rounds_to_zero");
    expect(evaluateGate(out("Zinc is 0.004 ppm.", zn(1, "significant")), gctx(), facts(doc)).status).toBe("approved");
    expect(evaluateGate(out("Zinc is 0.004 ppm.", zn(3)), gctx(), facts(doc)).status).toBe("approved");
  });
  it("refuses a unit record at a pointer outside the owner list", () => {
    const doc = { ...FULL, extra: { value: 4, unit: "mm" } };
    expect(codes(evaluateGate(out("The field got 4 mm.", ref("/extra/value", "mm")), gctx(), facts(doc)))).toContain("numeric_ref_unit_unknown");
  });
  it("index, pH, dS/m, GJ and tCO2e are recognised next to the number", () => {
    expect(evaluateGate(out("The field NDVI is 0.2 now.", ref("/satellite/ndvi/value", "index")), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("Soil pH 1 was measured.", ref("/soil/readings/0/measured/value", "pH")), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("Salinity is 1 dS/m.", ref("/soil/readings/1/measured/value", "dS/m")), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("Growing it uses up to 3 GJ.", { ...ref("/economics/energy/inputEnergyForField/value/high", "GJ") }), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("The season emits up to 0.9 tCO2e.", ref("/economics/carbon/emissionsForField/value/high", "tCO2e")), gctx(), facts()).status).toBe("approved");
    expect(evaluateGate(out("The field NDVI is 0.2.", ref("/satellite/ndvi/value", "index")), gctx(), facts()).status).toBe("approved");
    expect(codes(evaluateGate(out("The field is 0.2 now.", ref("/satellite/ndvi/value", "index")), gctx(), facts()))).toContain("unit_missing_in_prose");
    const t = numberTokens("NDVI of 0.62", { englishDates: true }).tokens[0]!;
    expect(unitAdjacent(t, "index")).toBe(true);
    // review nit (a): only a named index stands before the number; the bare word "index" only after it
    const idx = (text: string) => unitAdjacent(numberTokens(text, { englishDates: true }).tokens[0]!, "index");
    expect(idx("forecast index of 3")).toBe(false);
    expect(idx("the indices are 3")).toBe(false);
    expect(idx("NDVI index of 0.62")).toBe(true);
    expect(idx("EVI 0.31")).toBe(true);
    expect(idx("a reading of 0.62 index")).toBe(true);
    expect(codes(evaluateGate(out("The forecast index of 0.2 is fine.", ref("/satellite/ndvi/value", "index")), gctx(), facts()))).toContain("unit_missing_in_prose");
    expect(numberTokens("about 0.9 tCO2e", { englishDates: true }).tokens.map((x) => x.value.toNumber())).toEqual([0.9]);
  });
});

// ---------------------------------------------------------------- resolver alias split
describe("resolver: combined names are split", () => {
  it("splitNameParts keeps the original and adds each part once", () => {
    expect(splitNameParts([{ text: "Paddy / rice", kind: "common" }, { text: "rice", kind: "local" }]).map((x) => x.text)).toEqual(["Paddy / rice", "Paddy", "rice"]);
    expect(splitNameParts([{ text: "Tur, arhar" }]).map((x) => x.text)).toEqual(["Tur, arhar", "Tur", "arhar"]);
  });
  it('"paddy", "rice" and "Paddy / rice" resolve to the paddy crop after the catalogue load', async () => {
    const ownerId = await ownerOf((await bareFarm()).id);
    const ctx = await ctxFor(ownerId);
    const paddy = (await h.pool.query<{ id: string; names: { en: { text: string }[] } }>("SELECT id, names FROM crop_identities WHERE slug='paddy'")).rows[0]!;
    expect(paddy.names.en.map((n) => n.text)).toEqual(expect.arrayContaining(["Paddy / rice", "Paddy", "rice"]));
    for (const text of ["paddy", "rice", "Paddy / rice", "Rice"]) {
      const r = await resolveCropIdentityHandler({ text, language: "en" }, ctx);
      expect(r.candidates.map((c) => c.cropId), text).toContain(paddy.id);
      expect(r.unresolvedReason === null || r.unresolvedReason === "product_basis_unresolved", text).toBe(true);
    }
    // rows stored before the split (only the combined label) still resolve by part
    await h.pool.query("UPDATE crop_identities SET names=$2::jsonb WHERE id=$1", [paddy.id, JSON.stringify({ en: [{ text: "Paddy / rice", kind: "common" }] })]);
    expect((await resolveCropIdentityHandler({ text: "rice", language: "en" }, ctx)).candidates.map((c) => c.cropId)).toContain(paddy.id);
    await loadCatalogueIntoDb(h.pool);
  });
});
