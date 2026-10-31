import { z } from "zod";
import { BudgetValue, DateRange, FarmProfile, ProductBasis, SpatialLevel, SCHEMA_VERSION, SoilDrainage, SoilTexture, IrrigationCategory, LabourLevel, AreaValue, LocationValue, Id } from "@harvest/contracts";
import type { Alias, CropIdentity, CropProduct, Mode, ToolOutput } from "@harvest/contracts";
import { resolveCropIdentity } from "@harvest/domain";
import type { Pool } from "../../db/pool";
import { ApiError, notFound } from "../../services/errors";
import { getFarm } from "../../services/farms";
import { getWorkspace } from "../../services/workspace";
import { monitoringAt, monitoringReferences, type MonitoringSnapshot } from '../../services/monitoring';
import { getJob } from "../../services/jobs";
import type { ToolBindings, ToolContext, ToolHandler } from "./registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_BY_LANG_INDEX: Alias["kind"][] = ["common", "local"];
const ALIAS_KINDS: readonly Alias["kind"][] = ["common", "local", "market", "botanical", "trade", "transliteration"];

/**
 * L5: script-level normalisation applied to both the query and every alias before matching (the domain
 * resolver then applies NFKC, case folding and punctuation stripping). Removes zero-width joiners/non-joiners
 * and the Devanagari nukta, folds chandrabindu to anusvara (गेहूँ = गेहूं), and drops a word-final virama/pulli
 * so a stray trailing halant does not block a match. Nothing else is fuzzy: no prefix or edit-distance matching.
 */
export function canonicalCropText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u093C/g, "")
    .replace(/\u0901/g, "\u0902")
    .replace(/[\u094D\u0BCD](?=\s|$)/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
        // L5: the stored kind is honoured when it is a contract kind; otherwise first = common, rest = local.
        const stored = typeof item === "object" && item !== null ? (item as { kind?: unknown }).kind : undefined;
        const kind = ALIAS_KINDS.includes(stored as Alias["kind"]) ? (stored as Alias["kind"]) : KIND_BY_LANG_INDEX[Math.min(i, 1)]!;
        if (text && text.trim().length > 0 && text.length <= 200) out.push({ text: text.trim(), language: lang, kind, sourceIds: [] });
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
  const original = new Map<string, string>();
  const canon = (a: Alias): Alias => {
    const t = canonicalCropText(a.text) || a.text;
    if (!original.has(t)) original.set(t, a.text);
    return { ...a, text: t };
  };
  const cCrops = crops.map((c) => ({ ...c, commonNames: c.commonNames.map(canon), aliases: c.aliases.map(canon) }));
  const cProducts = products.map((p) => ({ ...p, aliases: p.aliases.map(canon) }));
  const r = resolveCropIdentity(canonicalCropText(input.text) || input.text, cCrops, cProducts, { language: input.language, allowPrefix: false });
  // Report the alias exactly as stored, not its canonical form.
  return { ...r, candidates: r.candidates.map((c) => ({ ...c, matchedAlias: original.get(c.matchedAlias) ?? c.matchedAlias })) };
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
    if (!f || f.basis === 'unknown') return unknown;
    const v = schema.safeParse(pick(f.value));
    if (!v.success) return unknown;
    return { value: v.data, basis: f.basis, confirmed: f.confirmed, source: { kind: SOURCE_KIND[f.basis], ref: f.source, recordedAt: f.recordedAt } };
  };
  const now = farm.updatedAt;
  // Current farmer-entered history is excluded from historical replay; precise boundary coordinates
  // stay private, just like the existing location point.
  const workspace = ctx.mode === 'replay' ? null : await getWorkspace(ctx.pool, ctx.ownerId, input.farmId);
  const storedMonitor = ctx.mode === 'replay' ? null : (await ctx.pool.query<{ snapshot: MonitoringSnapshot | null }>('SELECT snapshot FROM farm_monitors WHERE farm_id=$1', [farm.id])).rows[0]?.snapshot;
  const monitored = storedMonitor?.mode === ctx.mode ? monitoringAt(storedMonitor, ctx.asOf) : null;
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
    area: farm.areaHectares !== null ? { value: AreaValue.parse({ amount: farm.areaHectares, unit: "ha" }), basis: facts.area_hectares?.basis === 'derived' ? 'derived' : "farmer_reported", confirmed: false, source: { kind: facts.area_hectares?.basis === 'derived' ? 'calculation' : "farmer_form", ref: facts.area_hectares?.source ?? null, recordedAt: now } } : unknown,
    soil: {
      texture: known("soil_texture", SoilTexture),
      drainage: known("soil_drainage", SoilDrainage),
      ph: known("soil_ph", z.number().min(0).max(14)),
      availableWaterMmPerM: known("available_water_mm_per_m", z.number().positive()),
    },
    water: { category: known(facts.irrigation_category ? "irrigation_category" : "irrigation", IrrigationCategory), capacityMmPerWeek: known("water_capacity_mm_per_week", z.number().nonnegative()) },
    plantingWindow: known("planting_window", DateRange),
    budget: known("budget", BudgetValue),
    labour: known("labour", LabourLevel),
    experience: known("experience", z.string().min(1).max(500)),
    accessibleMarketIds: known("accessible_market_ids", z.array(Id)),
    excludedCropIds: known("excluded_crop_ids", z.array(Id)),
    ...(farm.facts.demo_prefilled?.value===true?{demo:{prefilledBoundary:true as const,source:String(farm.facts.demo_source?.value??'Demo field with a prefilled boundary')}}:farm.facts.demo_illustrative?.value===true?{demo:{illustrative:true as const,source:String(farm.facts.demo_source?.value??'Illustrative demo; not observed farm records')}}:{}),
    ...(workspace ? { history: {
      basis: farm.facts.demo_illustrative?.value===true?'illustrative' as const:'farmer_reported' as const, previousHarvest: workspace.previousHarvest,
      cycles: workspace.cycles.slice(-20), rotationPlans: workspace.rotationPlans.slice(0, 20),
      boundaryRecorded: workspace.boundary !== null, rotationAssessment: 'not_assessed' as const,
    } } : {}),
    ...(monitored ? { monitoring: { checkedAt: monitored.checkedAt, weatherStatus: monitored.weather.status, marketStatus: monitored.market.status, references: monitoringReferences(monitored),
      marketProducts: monitored.market.products.flatMap((p) => p.reference.state === 'historical_reference' ? [{ productId: p.productId, marketId: p.reference.marketId, date: p.reference.lastQuote.date, inrPerKg: p.reference.lastQuote.inrPerKg }] : []),
    } } : {}),
  };
  const parsed = FarmProfile.safeParse(profile);
  if (!parsed.success) throw new ApiError(500, "farm_context_invalid", "Farm context could not be assembled");
  // Proposed journal facts are owned by the journal slice; none are bound here yet.
  return { farm: parsed.data, proposedFacts: [] };
}

// ---------------------------------------------------------------- retrieve_evidence
export const EXCERPT_MAX = 600;

/**
 * Evidence statuses the assistant may cite (decision D28): `validated` (human reviewed) and `grounded`
 * (excerpt verified present on the cited page by the automated grounding check; human review of meaning
 * and scope pending). Each passage carries `validationStatus` so the gate and UI can label grounded rows
 * "machine-grounded excerpt; human review pending". `pending`, `rejected` and `unsupported` are never returned.
 */
export const CITABLE_EVIDENCE_STATUSES = ["validated", "grounded"] as const;
export type RetrieveEvidenceOutput = ToolOutput<"retrieve_evidence"> & { passages: (ToolOutput<"retrieve_evidence">["passages"][number] & { validationStatus: (typeof CITABLE_EVIDENCE_STATUSES)[number] })[] };

/**
 * L5: topic synonym groups. A requested topic matches a record topic when they are equal, or when any
 * underscore-separated word of either is in the same group as a word of the other ("water_management" ~
 * "irrigation"; "soil" ~ "climate_and_soil"). Groups are deliberately small; nothing else is fuzzy.
 */
export const TOPIC_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["water", "irrigation", "irrigated", "moisture", "rain", "rainfall", "rainfed", "drought", "watering", "mulching"],
  ["soil", "soils", "drainage", "waterlogging", "climate"],
  ["pest", "pests", "disease", "diseases", "rot", "protection"],
  ["harvest", "harvesting", "yield", "storage"],
  ["planting", "sowing", "season", "seasons", "seed", "spacing"],
  ["variety", "varieties", "hybrids", "strains"],
  ["nutrient", "nutrients", "manure", "manuring", "fertilizer", "fertiliser"],
];
const TOPIC_STOPWORDS = new Set(["and", "of", "for", "the", "management", "table", "requirement", "requirements"]);

/** Expands requested topics to the word set used by the tolerant matcher. Exported for tests. */
export function expandTopicWords(topics: readonly string[]): string[] {
  const words = new Set<string>();
  for (const t of topics) {
    const lower = t.toLowerCase();
    words.add(lower);
    for (const w of lower.split(/_+/)) {
      if (!w || TOPIC_STOPWORDS.has(w)) continue;
      words.add(w);
      for (const g of TOPIC_SYNONYM_GROUPS) if (g.includes(w)) for (const x of g) words.add(x);
    }
  }
  return [...words];
}

const DISTRICT_ID = /^IN-[A-Z]{2}-[a-z0-9-]+$/;

export async function retrieveEvidenceHandler(input: { cropIds?: string[] | undefined; regionIds?: string[] | undefined; topics?: string[] | undefined; availableBefore?: string | undefined; limit: number }, ctx: ToolContext): Promise<RetrieveEvidenceOutput> {
  const cutoff = input.availableBefore && input.availableBefore < ctx.asOf ? input.availableBefore : ctx.asOf;
  const modes = ctx.mode === "synthetic" ? ["synthetic"] : ctx.mode === "replay" ? ["replay", "live"] : ["live"];
  const strict = ctx.mode === "replay";
  // L5: evidence rows carry catalogue slugs ("ginger") while resolve_crop_identity returns crop UUIDs; accept either.
  let cropKeys: string[] | null = null;
  if (input.cropIds && input.cropIds.length > 0) {
    const ids = await ctx.pool.query<{ id: string; slug: string }>("SELECT id::text AS id, slug FROM crop_identities WHERE id::text = ANY($1::text[]) OR slug = ANY($1::text[])", [input.cropIds]);
    cropKeys = [...new Set([...input.cropIds, ...ids.rows.flatMap((r) => [r.id, r.slug])])];
  }
  // L5: geography falls back district -> state -> region -> national. A district id implies its state
  // (IN-KA-hassan -> IN-KA). Region rows match only when they list a requested id (no region membership table
  // exists, so no state is assumed to belong to a named region). Rows are ranked by specificity, so the most
  // specific level available fills the limit first; each passage reports its level in scope.level.
  let geo: string[] | null = null;
  if (input.regionIds && input.regionIds.length > 0) {
    const g = new Set(input.regionIds);
    for (const id of input.regionIds) {
      if (DISTRICT_ID.test(id)) g.add(id.split("-").slice(0, 2).join("-"));
      else if (/^[A-Z]{2}$/.test(id)) g.add(`IN-${id}`);
    }
    geo = [...g];
  }
  const topicWords = input.topics && input.topics.length > 0 ? expandTopicWords(input.topics) : null;
  const r = await ctx.pool.query<{ id: string; excerpt: string; effective_available_at: Date | null; geography_level: string; geography_ids: string[]; crop_ids: string[]; validation_status: "validated" | "grounded" }>(
    `SELECT e.id, e.excerpt, e.effective_available_at, e.geography_level, e.geography_ids, e.crop_ids, e.validation_status
       FROM evidence_records e
      WHERE e.validation_status IN ('validated','grounded') AND e.excerpt IS NOT NULL AND e.geography_level IS NOT NULL AND cardinality(e.geography_ids) > 0
        AND e.mode = ANY($1::text[])
        AND ($2::text[] IS NULL OR e.crop_ids && $2::text[])
        AND ($3::text[] IS NULL OR e.geography_level = 'national' OR e.geography_ids && $3::text[])
        AND ($4::text[] IS NULL OR e.topics && $4::text[] OR EXISTS (
              SELECT 1 FROM unnest(e.topics) t, unnest(string_to_array(lower(t), '_')) w WHERE w = ANY($4::text[])))
        AND ${strict ? "e.effective_available_at IS NOT NULL AND e.availability_basis IS DISTINCT FROM 'unverified' AND e.effective_available_at <= $5::timestamptz" : "COALESCE(e.effective_available_at, e.created_at) <= $5::timestamptz"}
      ORDER BY CASE e.geography_level WHEN 'district' THEN 0 WHEN 'farm' THEN 0 WHEN 'market' THEN 1 WHEN 'state' THEN 1 WHEN 'region' THEN 2 ELSE 3 END,
               e.effective_available_at DESC NULLS LAST, e.id
      LIMIT $6`,
    [modes, cropKeys, geo, topicWords, cutoff, input.limit],
  );
  // Passage crop ids are reported as catalogue crop UUIDs (what resolve_crop_identity returns and claims declare).
  const uuidBySlug = new Map<string, string>();
  const rowSlugs = [...new Set(r.rows.flatMap((x) => x.crop_ids))];
  if (rowSlugs.length > 0) for (const c of (await ctx.pool.query<{ id: string; slug: string }>("SELECT id::text AS id, slug FROM crop_identities WHERE slug = ANY($1::text[])", [rowSlugs])).rows) uuidBySlug.set(c.slug, c.id);
  const passages = r.rows.flatMap((row) => {
    const level = SpatialLevel.safeParse(row.geography_level);
    if (!level.success) return [];
    return [
      {
        evidenceId: row.id,
        excerpt: row.excerpt.length > EXCERPT_MAX ? `${row.excerpt.slice(0, EXCERPT_MAX)}…` : row.excerpt,
        effectiveAvailableAt: row.effective_available_at ? row.effective_available_at.toISOString() : null,
        scope: { level: level.data, ids: row.geography_ids },
        cropIds: [...new Set(row.crop_ids.map((c) => uuidBySlug.get(c) ?? c))],
        validationStatus: row.validation_status,
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
