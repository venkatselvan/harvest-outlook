import { z } from "zod";
import { StageDefinition, type Assumption, type IrrigationCategory, type Mode } from "@harvest/contracts";
import { contentHash } from "@harvest/domain";
import type { Pool } from "../db/pool";
import { invalidPlanInput, PlanError } from "./errors";
import { valueRecord } from "./compute";
import { loadTaskTemplateSet, regionKeyOfScopeId, type TaskTemplateSet } from "./task-templates";
import { INPUT_KEYS, type CreatePlanArgs, type PlanParameters } from "./types";
import { isUuid, findFarm } from "./repository";

/**
 * Server-side resolution of stage definitions, task templates and rule versions for POST /plans (T12).
 * The client names a crop, product and planting date; it never supplies agronomy. Stage sets come from
 * `stage_definitions` (loaded by the catalogue loader from data/curated/stages) and the most specific scope
 * that matches the farm wins: district > state > region > national.
 */

export const SCOPE_RANK = { national: 1, region: 2, state: 3, district: 4 } as const;
type Level = keyof typeof SCOPE_RANK;
type StageDef = z.infer<typeof StageDefinition>;

export interface FarmLocation {
  stateCode: string | null;
  districtCode: string | null;
}

/** Canonical lower-case state id (`in-ka`) from `KA`, `IN-KA` or null. */
function stateKey(code: string | null): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  return c.startsWith("in-") ? c : `in-${c}`;
}

/**
 * Canonical lower-case district id (`in-ka-hassan`). Accepts the registry id (`IN-KA-hassan`) and the typed
 * form the farm form stores (`typed:KA:hassan`). Anything else is compared as given.
 */
export function districtKey(code: string | null, stateCode: string | null): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  const typed = /^typed:([a-z]{2}):(.+)$/.exec(c);
  if (typed) return `in-${typed[1]}-${typed[2]}`;
  if (c.startsWith("in-")) return c;
  const s = stateKey(stateCode);
  return s ? `${s}-${c}` : c;
}

export function scopeMatches(def: Pick<StageDef, "scope">, farm: FarmLocation): boolean {
  const ids = def.scope.ids.map((i) => i.toLowerCase());
  switch (def.scope.level as string) {
    case "district": {
      const d = districtKey(farm.districtCode, farm.stateCode);
      return d !== null && ids.includes(d);
    }
    case "state": {
      const s = stateKey(farm.stateCode);
      return s !== null && ids.includes(s);
    }
    case "national":
      return ids.includes("in");
    default:
      // Agro-region scopes cannot be matched: no district-to-region mapping is curated yet (docs/CATALOGUE_API.md).
      return false;
  }
}

export interface PickedStageSet {
  level: Level;
  scopeIds: string[];
  defs: StageDef[];
}

/** Groups stage definitions by scope and returns the most specific group whose scope matches the farm. Pure. */
export function pickStageSet(all: readonly StageDef[], farm: FarmLocation): PickedStageSet | null {
  const groups = new Map<string, StageDef[]>();
  for (const d of all) {
    if (d.reviewStatus === "disabled") continue;
    if (!scopeMatches(d, farm)) continue;
    const key = `${d.scope.level}|${[...d.scope.ids].sort().join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  let best: { rank: number; key: string; defs: StageDef[] } | null = null;
  for (const [key, defs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const rank = SCOPE_RANK[defs[0]!.scope.level as Level] ?? 0;
    if (!best || rank > best.rank) best = { rank, key, defs };
  }
  if (!best) return null;
  const first = best.defs[0]!;
  return { level: first.scope.level as Level, scopeIds: [...first.scope.ids], defs: [...best.defs].sort((a, b) => a.order - b.order) };
}

export interface ResolveRequest {
  ownerId: string;
  farmId: string;
  cropId: string;
  productId: string;
  plantingDate: string;
  areaHa?: number | undefined;
  irrigationCategory?: IrrigationCategory | undefined;
  assumedPriceInrPerKg?: number | undefined;
  decisionCutoff?: string | undefined;
}

export interface Resolution {
  args: Omit<CreatePlanArgs, "mode" | "ownerId">;
  info: { cropSlug: string; scopeLevel: Level; scopeIds: string[]; stageCount: number; taskTemplateCount: number; taskTemplateSet: string | null; ruleCount: number; sourceSnapshotId: string; limitations: string[] };
}

interface FarmFull {
  area: number | null;
  irrigation: IrrigationCategory | null;
  state: string | null;
  district: string | null;
}

async function farmDetails(pool: Pool, ownerId: string, farmId: string): Promise<FarmFull | null> {
  const f = await findFarm(pool, ownerId, farmId);
  if (!f) return null;
  const a = await pool.query<{ area_hectares: string | null }>("SELECT area_hectares FROM farms WHERE id=$1", [farmId]);
  const fact = await pool.query<{ value: unknown }>("SELECT value FROM farm_facts WHERE farm_id=$1 AND fact_key='irrigation_category' AND superseded_by IS NULL LIMIT 1", [farmId]);
  const irr = z.enum(["rainfed", "supplemental", "irrigated"]).safeParse(fact.rows[0]?.value);
  return { area: a.rows[0]?.area_hectares ? Number(a.rows[0].area_hectares) : null, irrigation: irr.success ? irr.data : null, state: f.state_code, district: f.district_code };
}

/** Crops that have at least one stage set (for the honest 422). */
export async function cropsWithStageSets(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ slug: string }>("SELECT DISTINCT c.slug FROM stage_definitions sd JOIN crop_identities c ON c.id=sd.crop_id ORDER BY c.slug");
  return r.rows.map((x) => x.slug);
}

/** Synthetic-mode only. Every value is invented for UI and engine exercise; labelled scenario/synthetic. Live and replay use null (no sourced Kc or cost data exists). */
function syntheticParameters(stageIds: string[], productBasis: "fresh" | "dry" | "other"): Pick<PlanParameters, "water" | "economics"> {
  const dec = (low: string, central: string, high: string) => ({ low, central, high });
  return {
    water: {
      kcByStage: stageIds.map((stageId) => ({ stageId, kc: 0.8, kcSource: "synthetic placeholder (not FAO-56 table values)" })),
      rootZone: { totalAvailableWaterMm: null, depletionFraction: 0.5, initialDepletionMm: 0, basis: "synthetic: soil capacity unknown" },
      effectiveRain: { method: "fixed_fraction", fraction: 0.8 },
      forecastRainPolicy: "use_forecast",
      irrigationEfficiency: 0.75,
      tawScenariosMm: [60, 120],
    } as PlanParameters["water"],
    economics: {
      marketIds: ["synthetic-market-1"],
      priceProductBasis: productBasis === "dry" ? "dry" : "fresh",
      yield: { productBasis: productBasis === "dry" ? "dry" : "fresh", unit: "kg/ha", amount: { low: 10000, central: 15000, high: 20000 }, evidenceState: "scenario", evidenceIds: [] },
      marketableFraction: { low: 0.8, central: 0.85, high: 0.9 },
      harvestShares: null,
      conversion: null,
      costs: {
        cashProduction: { basis: "per_ha", amountInr: dec("300000", "350000", "400000"), evidenceIds: [], definition: "synthetic cash cost placeholder, not a sourced cost" },
        harvest: { basis: "per_kg_marketable", amountInr: dec("2", "3", "4"), evidenceIds: [], definition: "synthetic harvest cost per kg, placeholder" },
        saleAndTransport: { basis: "per_kg_marketable", amountInr: dec("1", "1.5", "2"), evidenceIds: [], definition: "synthetic sale and transport per kg, placeholder" },
        fullEconomic: null,
      },
      unpricedItems: ["family_labour"],
    } as PlanParameters["economics"],
  };
}

export async function resolvePlanInputs(pool: Pool, mode: Mode, req: ResolveRequest, root?: string): Promise<Resolution> {
  const farm = await farmDetails(pool, req.ownerId, req.farmId);
  if (!farm) throw new PlanError(404, "not_found", "Farm not found");
  const crop = await pool.query<{ id: string; slug: string }>("SELECT id, slug FROM crop_identities WHERE slug=$1 OR ($2 AND id::text=$1)", [req.cropId, isUuid(req.cropId)]);
  if (!crop.rows[0]) throw invalidPlanInput(`unknown crop ${req.cropId}`);
  const { id: cropUuid, slug } = crop.rows[0];
  const prod = await pool.query("SELECT 1 FROM crop_products WHERE crop_id=$1 AND (slug=$2 OR ($3 AND id::text=$2))", [cropUuid, req.productId, isUuid(req.productId)]);
  if (!prod.rowCount) throw invalidPlanInput(`product ${req.productId} is not a product of crop ${req.cropId}`);

  const rows = await pool.query<{ definition: unknown }>("SELECT definition FROM stage_definitions WHERE crop_id=$1", [cropUuid]);
  const defs = rows.rows.map((r) => StageDefinition.parse(r.definition));
  const picked = pickStageSet(defs, { stateCode: farm.state, districtCode: farm.district });
  if (!picked) {
    const supported = await cropsWithStageSets(pool);
    throw new PlanError(422, "stage_definitions_unavailable", `No source-backed stage definitions exist for ${slug} at this farm's location, so a season plan cannot be built. Crops with stage definitions: ${supported.join(", ") || "none"}.`, {
      cropId: slug,
      supportedCrops: supported,
      location: { stateCode: farm.state, districtCode: farm.district },
    });
  }

  const regionKey = regionKeyOfScopeId(picked.scopeIds[0]!);
  const tasks: TaskTemplateSet | null = loadTaskTemplateSet(slug, regionKey, root);
  const limitations: string[] = [];
  if (!tasks) limitations.push(`No curated task templates exist for ${slug} in ${picked.scopeIds.join(", ")}; the plan has stage windows only.`);

  const stageDefinitions: StageDef[] =
    mode === "synthetic"
      ? picked.defs.map((d) => ({ ...d, mode: "synthetic" as const, reviewStatus: "synthetic" as const }))
      : picked.defs;

  const ruleRows = await pool.query<{ rule_key: string; version: number }>("SELECT rule_key, version FROM crop_rules WHERE crop_id=$1 AND review_status='approved' ORDER BY rule_key", [cropUuid]);
  const ruleVersions = ruleRows.rows.map((r) => ({ id: r.rule_key, version: r.version }));

  const scope = { level: "farm" as const, ids: [req.farmId] };
  const confirmedInputs: { key: string; value: ReturnType<typeof valueRecord> }[] = [
    { key: INPUT_KEYS.plantingDate, value: valueRecord({ kind: "text", value: req.plantingDate, unit: null, evidenceState: "farmer_reported", scope }) },
  ];
  const areaHa = req.areaHa ?? farm.area;
  if (areaHa && areaHa > 0) confirmedInputs.push({ key: INPUT_KEYS.area, value: valueRecord({ kind: "quantity", value: areaHa, unit: "ha", evidenceState: "farmer_reported", scope }) });
  const irrigation = req.irrigationCategory ?? farm.irrigation;
  if (irrigation) confirmedInputs.push({ key: INPUT_KEYS.irrigationCategory, value: valueRecord({ kind: "category", value: irrigation, unit: null, evidenceState: "farmer_reported", scope }) });
  if (req.assumedPriceInrPerKg !== undefined) confirmedInputs.push({ key: INPUT_KEYS.assumedPrice, value: valueRecord({ kind: "quantity", value: req.assumedPriceInrPerKg, unit: "INR/kg", evidenceState: "farmer_reported", scope }) });

  const assumptions: z.infer<typeof Assumption>[] = [...(tasks?.assumptions ?? [])];
  if (mode === "synthetic") {
    assumptions.push({
      id: "synthetic_mode_resolution",
      description: "Synthetic mode: the curated stage durations are used but stamped synthetic, and water and cost parameters are invented placeholders. Nothing here is a source claim.",
      value: null,
      evidenceIds: [],
    });
  } else {
    limitations.push("No sourced crop coefficients or cost data exist for this crop and region, so water balance and economics are not computed.");
  }
  const syn = mode === "synthetic" ? syntheticParameters(stageDefinitions.map((d) => d.stageId), "fresh") : { water: null, economics: null };
  const templateSet = tasks?.templateSet ?? { id: `task-templates.${slug}.${regionKey}`, version: 0 };
  const parameters: PlanParameters = {
    schemaVersion: "1.0",
    taskTemplateSet: templateSet,
    taskTemplates: tasks?.taskTemplates ?? [],
    water: syn.water,
    economics: syn.economics,
  };

  const sourceSnapshotId = `catalogue-${contentHash({ stages: stageDefinitions, templates: tasks?.taskTemplates ?? [], templateSet, assumptions, rules: ruleVersions, mode }).slice(0, 40)}`;
  return {
    args: {
      farmId: req.farmId,
      cropId: slug,
      productId: req.productId,
      confirmedInputs,
      assumptions,
      ruleVersions,
      stageDefinitions,
      parameters,
      sourceSnapshotId,
      decisionCutoff: req.decisionCutoff ?? null,
    },
    info: { cropSlug: slug, scopeLevel: picked.level, scopeIds: picked.scopeIds, stageCount: stageDefinitions.length, taskTemplateCount: parameters.taskTemplates.length, taskTemplateSet: tasks ? `${templateSet.id}@${templateSet.version}` : null, ruleCount: ruleVersions.length, sourceSnapshotId, limitations },
  };
}
