import { z } from "zod";
import { BudgetValue, DateRange, FarmProfile, ProductBasis, SpatialLevel, SCHEMA_VERSION, SoilDrainage, SoilTexture, IrrigationCategory, LabourLevel, AreaValue, LocationValue, Id } from "@harvest/contracts";
import type { Alias, CropIdentity, CropProduct, Mode, ToolOutput } from "@harvest/contracts";
import { resolveCropIdentity } from "@harvest/domain";
import type { Pool } from "../../db/pool";
import { ApiError, notFound } from "../../services/errors";
import { getFarm } from "../../services/farms";
import { getJob } from "../../services/jobs";
import type { ToolBindings, ToolContext, ToolHandler } from "./registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_BY_LANG_INDEX: Alias["kind"][] = ["common", "local"];

// ---------------------------------------------------------------- resolve_crop_identity
interface CropRow { id: string; slug: string; scientific_name: string | null; names: unknown }
interface ProductRow { id: string; crop_id: string; slug: string; name: string; form: string | null; grade: string | null }

/**
 * `crop_identities.names` is read as `{ "<bcp47>": string | string[] | {text, kind?}[] }`.
 * Entries that do not fit are skipped, never guessed.
 */
export function aliasesFromNames(names: unknown, slug: string): Alias[] {
  const out: Alias[] = [];
  if (typeof names === "object" && names !== null && !Array.isArray(names)) {
    for (const [lang, v] of Object.entries(names as Record<string, unknown>)) {
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) continue;
      const list = Array.isArray(v) ? v : [v];
      list.forEach((item, i) => {
        const text = typeof item === "string" ? item : typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : null;
        if (text && text.trim().length > 0 && text.length <= 200) out.push({ text: text.trim(), language: lang, kind: KIND_BY_LANG_INDEX[Math.min(i, 1)]!, sourceIds: [] });
      });
    }
  }
  if (out.length === 0) out.push({ text: slug.replace(/[-_]+/g, " "), language: "en", kind: "common", sourceIds: [] });
  return out;
}

const basisOf = (form: string | null): z.infer<typeof ProductBasis> => {
  const r = ProductBasis.safeParse(form);
  return r.success ? r.data : "other";
};

export async function loadCatalogue(pool: Pool, mode: Mode): Promise<{ crops: CropIdentity[]; products: CropProduct[] }> {
  const [c, p] = await Promise.all([
    pool.query<CropRow>("SELECT id, slug, scientific_name, names FROM crop_identities ORDER BY slug"),
    pool.query<ProductRow>("SELECT id, crop_id, slug, name, form, grade FROM crop_products ORDER BY slug"),
  ]);
  const productsByCrop = new Map<string, string[]>();
  const products: CropProduct[] = p.rows.map((r) => {
    const list = productsByCrop.get(r.crop_id) ?? [];
    list.push(r.id);
    productsByCrop.set(r.crop_id, list);
    return { schemaVersion: SCHEMA_VERSION, id: r.id, cropId: r.crop_id, name: r.name, productBasis: basisOf(r.form), grade: r.grade, aliases: [], massUnit: "kg", priceUnit: "INR/kg", sourceMappings: [], mode };
  });
  const crops: CropIdentity[] = c.rows.map((r) => {
    const aliases = aliasesFromNames(r.names, r.slug);
    const firstPerLang = new Map<string, Alias>();
    for (const a of aliases) if (!firstPerLang.has(a.language)) firstPerLang.set(a.language, a);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: r.id,
      botanicalName: r.scientific_name,
      commonNames: [...firstPerLang.values()],
      aliases,
      varieties: [],
      productIds: productsByCrop.get(r.id) ?? [],
      sourceMappings: [],
      mode,
    };
  });
  return { crops, products };
}

export async function resolveCropIdentityHandler(input: { text: string; language: string }, ctx: ToolContext): Promise<ToolOutput<"resolve_crop_identity">> {
  const { crops, products } = await loadCatalogue(ctx.pool, ctx.mode);
  return resolveCropIdentity(input.text, crops, products, { language: input.language, allowPrefix: false });
}

// ---------------------------------------------------------------- get_farm_context
const SOURCE_KIND = { farmer_reported: "farmer_form", lab_test: "lab_report", district_proxy: "public_dataset", derived: "calculation", unknown: "farmer_form" } as const;
type Fact = { factId: string; value: unknown; unit: string | null; basis: keyof typeof SOURCE_KIND; confirmed: boolean; source: string | null; recordedAt: string };

export async function getFarmContextHandler(input: { farmId: string }, ctx: ToolContext): Promise<ToolOutput<"get_farm_context">> {
  if (!UUID.test(input.farmId)) throw notFound("Farm");
  const farm = await getFarm(ctx.pool, ctx.ownerId, input.farmId);
  if (!farm) throw notFound("Farm"); // identical for missing and foreign farms: no existence leak
  const facts = farm.facts as Record<string, Fact | undefined>;
  const unknown = { value: null, basis: "unknown" as const, confirmed: false };
  const known = <S extends z.ZodType>(key: string, schema: S, pick: (v: unknown) => unknown = (v) => v) => {
    const f = facts[key];
    if (!f) return unknown;
    const v = schema.safeParse(pick(f.value));
    if (!v.success) return unknown;
    return { value: v.data, basis: f.basis, confirmed: f.confirmed, source: { kind: SOURCE_KIND[f.basis], ref: f.source, recordedAt: f.recordedAt } };
  };
  const now = farm.updatedAt;
  const profile = {
    schemaVersion: SCHEMA_VERSION,
    id: farm.id,
    ownerId: ctx.ownerId,
    mode: ctx.mode,
    version: farm.version,
    updatedAt: farm.updatedAt,
    // Precise coordinates are never exposed to the model: district-level location only.
    location:
      farm.location.districtId || farm.location.stateCode
        ? { value: LocationValue.parse({ districtId: farm.location.districtId, stateId: farm.location.stateCode, precision: "district", point: null }), basis: "farmer_reported", confirmed: false, source: { kind: "farmer_form", ref: null, recordedAt: now } }
        : unknown,
    area: farm.areaHectares !== null ? { value: AreaValue.parse({ amount: farm.areaHectares, unit: "ha" }), basis: "farmer_reported", confirmed: false, source: { kind: "farmer_form", ref: null, recordedAt: now } } : unknown,
    soil: {
      texture: known("soil_texture", SoilTexture),
      drainage: known("soil_drainage", SoilDrainage),
      ph: known("soil_ph", z.number().min(0).max(14)),
      availableWaterMmPerM: known("available_water_mm_per_m", z.number().positive()),
    },
    water: { category: known("irrigation", IrrigationCategory), capacityMmPerWeek: known("water_capacity_mm_per_week", z.number().nonnegative()) },
    plantingWindow: known("planting_window", DateRange),
    budget: known("budget", BudgetValue),
    labour: known("labour", LabourLevel),
    experience: known("experience", z.string().min(1).max(500)),
    accessibleMarketIds: known("accessible_market_ids", z.array(Id)),
    excludedCropIds: known("excluded_crop_ids", z.array(Id)),
  };
  const parsed = FarmProfile.safeParse(profile);
  if (!parsed.success) throw new ApiError(500, "farm_context_invalid", "Farm context could not be assembled");
  // Proposed journal facts are owned by the journal slice; none are bound here yet.
  return { farm: parsed.data, proposedFacts: [] };
}

// ---------------------------------------------------------------- retrieve_evidence
export const EXCERPT_MAX = 600;

export async function retrieveEvidenceHandler(input: { cropIds?: string[] | undefined; regionIds?: string[] | undefined; topics?: string[] | undefined; availableBefore?: string | undefined; limit: number }, ctx: ToolContext): Promise<ToolOutput<"retrieve_evidence">> {
  const cutoff = input.availableBefore && input.availableBefore < ctx.asOf ? input.availableBefore : ctx.asOf;
  const modes = ctx.mode === "synthetic" ? ["synthetic"] : ctx.mode === "replay" ? ["replay", "live"] : ["live"];
  const strict = ctx.mode === "replay";
  const r = await ctx.pool.query<{ id: string; excerpt: string; effective_available_at: Date | null; geography_level: string; geography_ids: string[]; crop_ids: string[] }>(
    `SELECT e.id, e.excerpt, e.effective_available_at, e.geography_level, e.geography_ids, e.crop_ids
       FROM evidence_records e
      WHERE e.validation_status = 'validated' AND e.excerpt IS NOT NULL AND e.geography_level IS NOT NULL AND cardinality(e.geography_ids) > 0
        AND e.mode = ANY($1::text[])
        AND ($2::text[] IS NULL OR e.crop_ids && $2::text[])
        AND ($3::text[] IS NULL OR e.geography_level = 'national' OR e.geography_ids && $3::text[])
        AND ($4::text[] IS NULL OR e.topics && $4::text[])
        AND ${strict ? "e.effective_available_at IS NOT NULL AND e.availability_basis IS DISTINCT FROM 'unverified' AND e.effective_available_at <= $5::timestamptz" : "COALESCE(e.effective_available_at, e.created_at) <= $5::timestamptz"}
      ORDER BY e.effective_available_at DESC NULLS LAST, e.id
      LIMIT $6`,
    [modes, input.cropIds ?? null, input.regionIds ?? null, input.topics ?? null, cutoff, input.limit],
  );
  const passages = r.rows.flatMap((row) => {
    const level = SpatialLevel.safeParse(row.geography_level);
    if (!level.success) return [];
    return [
      {
        evidenceId: row.id,
        excerpt: row.excerpt.length > EXCERPT_MAX ? `${row.excerpt.slice(0, EXCERPT_MAX)}…` : row.excerpt,
        effectiveAvailableAt: row.effective_available_at ? row.effective_available_at.toISOString() : null,
        scope: { level: level.data, ids: row.geography_ids },
        cropIds: row.crop_ids,
      },
    ];
  });
  return { passages };
}

// ---------------------------------------------------------------- get_job_status
export async function getJobStatusHandler(input: { jobId: string }, ctx: ToolContext): Promise<ToolOutput<"get_job_status">> {
  if (!UUID.test(input.jobId)) throw notFound("Job");
  const job = await getJob(ctx.pool, ctx.ownerId, input.jobId);
  if (!job) throw notFound("Job");
  const res = job.result as { resultIds?: unknown; outputRefs?: unknown } | null;
  const ids = Array.isArray(res?.resultIds) ? res!.resultIds : Array.isArray(res?.outputRefs) ? res!.outputRefs : [];
  const raw = job.error?.code ?? null;
  return {
    jobId: job.id,
    state: job.state,
    progress: Math.min(1, Math.max(0, job.progress)),
    resultIds: ids.filter((x): x is string => typeof x === "string" && Id.safeParse(x).success),
    errorCode: raw,
  };
}

/** The four tools implemented in T09. The rest are bound by their owning tasks. */
export const implementedBindings = (): ToolBindings => ({
  resolve_crop_identity: resolveCropIdentityHandler as ToolHandler<"resolve_crop_identity">,
  get_farm_context: getFarmContextHandler,
  retrieve_evidence: retrieveEvidenceHandler as ToolHandler<"retrieve_evidence">,
  get_job_status: getJobStatusHandler,
});
