import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CoverageRecord, CropIdentity, CropProduct, CropRule, EvidenceRecord, StageDefinition } from "@harvest/contracts";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");

const Ids = z.array(z.string().min(1));
const Month = z.number().int().min(1).max(12);

export const RegionalContext = z
  .object({
    contextId: z.string().min(1),
    geography: z.object({ level: z.enum(["state", "region", "national"]), ids: z.array(z.string().min(1)).min(1) }).strict(),
    stateId: z.string().nullable(),
    districtIds: z.array(z.string()).nullable(),
    season: z.enum(["kharif", "rabi", "zaid", "perennial"]),
    plantingWindow: z.object({ fromMonth: Month, toMonth: Month, evidenceIds: Ids }).strict(),
    durationDays: z.object({ min: z.number().nullable(), max: z.number().nullable(), evidenceIds: Ids }).strict().nullable(),
    irrigation: z.enum(["rainfed", "supplemental", "irrigated", "any", "unspecified"]),
    irrigationEvidenceIds: Ids,
    waterNeedClass: z.object({ class: z.enum(["low", "medium", "high"]), evidenceIds: Ids }).strict().nullable(),
    soilNotes: z.object({ text: z.string(), evidenceIds: Ids }).strict().nullable(),
    yieldReference: z.object({ min: z.number(), max: z.number(), unit: z.literal("kg/ha"), basis: z.literal("regional_reference"), productId: z.string(), evidenceIds: Ids }).strict().nullable(),
    labourClass: z.enum(["low", "medium", "high"]).nullable(),
    harvestPattern: z.enum(["single", "repeated_picking", "staggered"]),
    notes: z.string(),
  })
  .strict();
export type RegionalContext = z.infer<typeof RegionalContext>;

export const CropProfile = z
  .object({
    cropId: z.string().min(1),
    identityRef: z.string().min(1),
    group: z.string().min(1),
    products: z.array(z.object({ productId: z.string(), name: z.string(), productBasis: z.string() }).strict()).min(1),
    regionalContexts: z.array(RegionalContext),
    exclusionsOrCautions: z.array(z.object({ text: z.string(), evidenceIds: Ids }).strict()),
    marketCoverageStatus: z.literal("unavailable_pending_price_access"),
    evidenceIds: Ids,
    qualification: z
      .object({ identityResolved: z.boolean(), hasRegionalContext: z.boolean(), hasSourcedRequirements: z.boolean(), hasSeasonInfo: z.boolean(), marketStatusExplicit: z.boolean(), qualified: z.boolean(), missing: z.array(z.string()) })
      .strict(),
  })
  .strict();
export type CropProfile = z.infer<typeof CropProfile>;

export const AreaRecord = z
  .object({
    id: z.string(),
    level: z.enum(["national", "region", "state", "district"]),
    stateId: z.string().nullable(),
    names: z.object({ en: z.string(), ta: z.string().optional(), hi: z.string().optional() }),
    source: z.union([z.string(), z.object({ sourceId: z.string(), sourceUrl: z.string(), publisher: z.string(), contentHash: z.string(), fetchedAt: z.string() })]),
    note: z.string().optional(),
    validationStatus: z.enum(["validated", "unsupported", "pending", "rejected"]),
  })
  .passthrough();
export type AreaRecord = z.infer<typeof AreaRecord>;

export interface RuleSet {
  file: string;
  sourceId: string;
  rules: CropRule[];
  reviewers: Record<string, string | null>;
}
export interface CatalogueFiles {
  identities: CropIdentity[];
  products: CropProduct[];
  profiles: CropProfile[];
  evidence: { record: EvidenceRecord; file: string; sourceId: string }[];
  stages: StageDefinition[];
  ruleSets: RuleSet[];
  coverage: CoverageRecord[];
  areas: AreaRecord[];
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
function parseAll<T>(schema: z.ZodType<T>, items: unknown[], what: string): T[] {
  return items.map((x, i) => {
    const r = schema.safeParse(x);
    if (!r.success) throw new Error(`${what}[${i}] invalid: ${r.error.message.slice(0, 300)}`);
    return r.data;
  });
}

/** Reads and validates every catalogue data file. Ginger candidates file is deliberately not read (reviewed rules only). */
export function readCatalogueFiles(root = REPO_ROOT): CatalogueFiles {
  const cur = join(root, "data", "curated");
  const manifest = readJson(join(root, "data", "manifests", "crop-identities.json")) as { identities: unknown[]; products: unknown[] };
  const identities = parseAll(CropIdentity, manifest.identities, "identity");
  const products = parseAll(CropProduct, manifest.products, "product");
  const profiles = readdirSync(join(cur, "crops")).filter((f) => f.endsWith(".json")).sort().map((f) => CropProfile.parse(readJson(join(cur, "crops", f))));
  const evidence: CatalogueFiles["evidence"] = [];
  for (const f of readdirSync(join(cur, "crop-evidence")).filter((x) => x.endsWith(".json")).sort())
    for (const r of parseAll(EvidenceRecord, readJson(join(cur, "crop-evidence", f)) as unknown[], `evidence ${f}`)) evidence.push({ record: r, file: `crop-evidence/${f}`, sourceId: "catalogue:T06a" });
  for (const f of readdirSync(join(cur, "evidence")).filter((x) => x.endsWith(".evidence.json")).sort())
    for (const r of parseAll(EvidenceRecord, readJson(join(cur, "evidence", f)) as unknown[], `evidence ${f}`)) evidence.push({ record: r, file: `evidence/${f}`, sourceId: "T05b:" + f });
  const stages: StageDefinition[] = [];
  for (const f of readdirSync(join(cur, "stages")).filter((x) => x.endsWith(".stages.json")).sort()) stages.push(...parseAll(StageDefinition, readJson(join(cur, "stages", f)) as unknown[], `stages ${f}`));
  const ruleSets: RuleSet[] = [];
  for (const f of readdirSync(join(cur, "rules")).filter((x) => x.endsWith(".rules.json")).sort()) {
    const raw = readJson(join(cur, "rules", f)) as unknown;
    const wrapped = !Array.isArray(raw);
    const list = wrapped ? (raw as { rules: unknown[] }).rules : (raw as unknown[]);
    const prov = wrapped ? ((raw as { provenance?: Record<string, { reviewer: string | null }> }).provenance ?? {}) : {};
    ruleSets.push({
      file: `rules/${f}`,
      sourceId: wrapped ? "T06b:derive-rules" : "T05b:" + f,
      rules: parseAll(CropRule, list, `rules ${f}`),
      reviewers: Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, v.reviewer])),
    });
  }
  const coverage = parseAll(CoverageRecord, (readJson(join(root, "data", "manifests", "coverage.json")) as { records: unknown[] }).records, "coverage");
  const areasFile = join(cur, "districts.json");
  const areas = existsSync(areasFile) ? parseAll(AreaRecord, (readJson(areasFile) as { areas: unknown[] }).areas, "area") : [];
  return { identities, products, profiles, evidence, stages, ruleSets, coverage, areas };
}
