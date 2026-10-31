import { ToolSchemas, type ToolInput, type ToolOutput, type ValueRecord } from "@harvest/contracts";
import { screenCrop } from "@harvest/domain";
import type { Config } from "../../config";
import type { Pool } from "../../db/pool";
import { buildRuleContext, compareCrops, executableRules, type ComparisonInput, type DimensionKey } from "../../catalogue/compare";
import type { CatalogueStore } from "../../catalogue/snapshot";
import { getFarm } from "../../services/farms";
import { ApiError, notFound } from "../../services/errors";
import { enqueue, getJob, type JobRecord } from "../../services/jobs";
import type { Budget } from "../../services/budget";
import { buildContext } from "../../visuals/context";
import { loadBriefs, type VisualBrief } from "../../visuals/brief";
import { VISUAL_JOB_TYPE } from "../../visuals/labels";
import type { ToolHandler } from "../tools/registry";
import { MANDI_LABEL, MARKET_REFERENCE_METHOD, missingReasonText, noRowsReason, referenceRecords, type PriceDeps } from "../../plans/adapters/market-outlook";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Int2Deps {
  pool: Pool;
  config: Config;
  budget: Budget;
  catalogue: Pick<CatalogueStore, "get">;
  briefs?: Map<string, VisualBrief>;
  /** Historical price reference wiring (L3). Absent: tools report the key-gated reason. */
  prices?: PriceDeps;
}

const DIM_NAME: Partial<Record<DimensionKey, ToolOutput<"screen_crops">["results"][number]["dimensions"][number]["dimension"]>> = {
  waterFit: "water_fit",
  timeToFirstIncome: "time_to_first_income",
  marketAccess: "market_access",
  evidenceQuality: "evidence_quality",
  economics: "economic_scenario",
};

const safeId = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(s) && s.length <= 200;

function dimValue(farmId: string, text: string, evidenceIds: string[]): ValueRecord {
  return {
    schemaVersion: "1.0", kind: "category", value: text.slice(0, 500), unit: null, evidenceState: "derived",
    scope: { level: "farm", ids: [farmId] }, validFrom: null, validTo: null, issuedAt: null,
    evidenceIds: evidenceIds.filter(safeId), assumptionIds: [], methodVersion: "catalogue-compare-1", validationStatus: "pending", missingReason: null,
  } as ValueRecord;
}

/**
 * `screen_crops`: contextId is the id of an OWNED farm (the id get_farm_context returns). Foreign and missing farms are both 404.
 * The context has no anonymous form in this contract: an anonymous caller uses POST /crop-comparisons instead.
 * Crops the farmer excluded are omitted (the contract outcome has no `excluded_by_farmer` value).
 */
export function bindScreenCrops(deps: Int2Deps): ToolHandler<"screen_crops"> {
  return async (input: ToolInput<"screen_crops">, ctx): Promise<ToolOutput<"screen_crops">> => {
    if (!UUID.test(input.contextId)) throw notFound("Farm");
    const farm = await getFarm(deps.pool, ctx.ownerId, input.contextId);
    if (!farm) throw notFound("Farm");
    const facts = farm.facts as Record<string, { value?: unknown } | undefined>;
    const sc = farm.location.stateCode;
    const asOf = new Date(ctx.asOf);
    const win = facts.planting_window?.value as { start?: string } | undefined;
    const month = win?.start && /^\d{4}-\d{2}/.test(win.start) ? Number(win.start.slice(5, 7)) : asOf.getUTCMonth() + 1;
    const irr = facts.irrigation?.value;
    const drain = facts.soil_drainage?.value;
    const excluded = facts.excluded_crop_ids?.value;
    const snap = await deps.catalogue.get();
    const cmp: ComparisonInput = {
      location: { stateId: sc ? (sc.startsWith("IN-") ? sc : `IN-${sc.toUpperCase()}`) : null, districtId: farm.location.districtId },
      planting: { month, date: null },
      irrigation: irr === "rainfed" || irr === "supplemental" || irr === "irrigated" ? irr : "unknown",
      soil: drain === "poor" || drain === "moderate" || drain === "good" ? { drainage: drain } : undefined,
      area: farm.areaHectares ? { amount: farm.areaHectares, unit: "ha" } : null,
      excludedCropIds: Array.isArray(excluded) ? (excluded as string[]) : [],
      cropIds: input.cropIds,
    };
    const out = compareCrops(snap, cmp, { mode: ctx.mode, now: asOf, priceMissingReason: noRowsReason(deps.prices?.keyConfigured ?? false) });
    const ruleCtx = buildRuleContext(cmp);
    const { rules } = executableRules(snap.rules, ctx.mode);
    // One result per (crop, product): outcomes, rules and dimensions differ by product form, so a crop-level entry
    // would report the first product's outcome for the others.
    const results = out.items.filter((it) => it.outcome !== "excluded_by_farmer").map((it) => {
      const cropId = it.cropId;
      const cropRules = rules.filter((r) => r.cropId === cropId);
      const ruleResults = screenCrop(cropId, cropRules, ruleCtx, { mode: ctx.mode, productId: it.productId }).results.filter((r) => r.effect !== "not_applicable");
      const dimensions = (Object.keys(DIM_NAME) as DimensionKey[]).flatMap((k) => {
        const d = it.dimensions[k];
        if (!d || d.status !== "known") return [];
        const text = typeof d.value === "string" ? d.value : JSON.stringify(d.value);
        return [{ dimension: DIM_NAME[k]!, value: dimValue(farm.id, text, d.evidenceIds) }];
      });
      return {
        cropId,
        productIds: [it.productId],
        outcome: it.outcome as "eligible" | "ineligible" | "requires_review" | "unknown",
        ruleResults,
        unknownFields: it.screening.unknownFields,
        coverage: snap.coverage.filter((c) => c.cropId === cropId),
        dimensions,
      };
    });
    return ToolSchemas.screen_crops.output.parse({ results });
  };
}

/**
 * Historical mandi reference, never a forecast: `forecasts` is always empty. `references` are ValueRecords (INR/kg; the last
 * quote is observed, the weekly-median range and corresponding-season references are derived) followed by one text record
 * carrying the label, so numeric references resolve their unit and the label is citable. Reasons are the real cause (L3).
 */
export function bindMarketOutlook(deps?: Pick<Int2Deps, "prices">): ToolHandler<"get_market_outlook"> {
  return async (input, ctx) => {
    const keyConfigured = deps?.prices?.keyConfigured ?? false;
    const gone = (reason: string) => ({ forecasts: [], references: [], missing: input.marketIds.map((marketId) => ({ marketId, reason: `${reason}: ${missingReasonText(reason)}` })) });
    if (!deps?.prices) return gone(noRowsReason(keyConfigured));
    const res = await deps.prices.source.getOutlook(input.productId, input.marketIds, input.harvestWindows, input.issueDate);
    if ("state" in res) return gone(res.missingReason);
    if (!("kind" in res) || res.kind !== "historical_reference") return gone(noRowsReason(keyConfigured));
    const label: ValueRecord = {
      schemaVersion: "1.0", kind: "text", unit: null, value: `Historical reference from stored quotes, not a forecast. ${MANDI_LABEL}. The weekly-median range is not a prediction interval.`,
      evidenceState: "derived", scope: { level: "market", ids: [res.primaryMarketId] }, validFrom: null, validTo: null, issuedAt: null, evidenceIds: [], assumptionIds: [],
      methodVersion: MARKET_REFERENCE_METHOD, validationStatus: "pending", missingReason: null,
    };
    const shown = new Set(res.markets.map((m) => m.marketId));
    const missing = input.marketIds.filter((m) => !shown.has(m)).map((marketId) => {
      const reason = res.fallback ? "market_not_in_history" : res.skippedMarkets.some((s) => s.marketId === marketId) ? "price_history_insufficient" : "market_not_in_history";
      return { marketId, reason: `${reason}: ${missingReasonText(reason, res.fallback?.stateName)}` };
    });
    void ctx;
    return { forecasts: [], references: [...referenceRecords(res), label], missing };
  };
}

/** Same enqueue path as POST /plans/:id/visuals (content-derived key). The photo is the plan farm's newest photo with a confirmed region. */
export function bindVisualKeyframes(deps: Int2Deps): ToolHandler<"request_visual_keyframes"> {
  return async (input, ctx) => {
    if(ctx.mode!=="synthetic")throw new ApiError(422,"observed_media_only","Current field views use dated owner photos. Generated field scenes are unavailable.");
    if (!UUID.test(input.planId)) throw notFound("Plan");
    const briefs = deps.briefs ?? (await loadBriefs());
    const plan = await deps.pool.query<{ farm_id: string }>("SELECT farm_id FROM plans WHERE id=$1 AND owner_id=$2", [input.planId, ctx.ownerId]);
    if (!plan.rows[0]) throw notFound("Plan");
    const med = await deps.pool.query<{ id: string; region_version: number }>(
      `SELECT id, region_version FROM media_objects WHERE owner_id=$1 AND farm_id=$2 AND kind='image' AND region_polygon IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [ctx.ownerId, plan.rows[0].farm_id],
    );
    if (!med.rows[0]) throw new ApiError(422, "region_required", "Upload a photo and confirm the planting region before requesting a visual journey");
    const v = await buildContext({ pool: deps.pool, config: deps.config, briefs }, ctx.ownerId, { planId: input.planId, mediaId: med.rows[0].id, regionVersion: med.rows[0].region_version, stageIds: input.stageIds });
    if (input.briefId !== v.cropId && input.briefId !== v.brief?.briefHash) throw new ApiError(422, "brief_mismatch", "briefId does not match the plan's crop brief");
    const summary = await deps.budget.summary().catch(() => null);
    if (summary?.exhausted) return { jobId: null, deduplicated: false, allowedStageCount: v.selected.length, budgetGate: "denied" as const };
    const payload = { planId: input.planId, mediaId: med.rows[0].id, regionVersion: med.rows[0].region_version, stageIds: input.stageIds, sessionId: null };
    const base = `vk:${v.jobKey.slice(0, 48)}`;
    const reusable = (j: JobRecord) => j.state !== "failed" && j.state !== "cancelled";
    const one = async (key: string) => {
      try {
        return await enqueue(deps.pool, VISUAL_JOB_TYPE, payload, ctx.ownerId, key);
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "idempotency_payload_mismatch") throw e;
        const ex = await deps.pool.query<{ id: string }>("SELECT id FROM jobs WHERE owner_id=$1 AND idempotency_key=$2", [ctx.ownerId, key]);
        const job = ex.rows[0] ? await getJob(deps.pool, ctx.ownerId, ex.rows[0].id) : null;
        if (!job) throw e;
        return { job, created: false };
      }
    };
    let out = await one(base);
    for (let n = 1; !out.created && !reusable(out.job) && n <= 20; n++) out = await one(`${base}:r${n}`);
    return { jobId: out.job.id, deduplicated: !out.created, allowedStageCount: v.selected.length, budgetGate: "checked" as const };
  };
}
