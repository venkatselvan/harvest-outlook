import { createHash } from "node:crypto";
import type { Pool } from "../db/pool";
import { withTransaction } from "../db/pool";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownInHardRule } from "@harvest/domain";
import { readCatalogueFiles, REPO_ROOT, type CatalogueFiles } from "./files";

/** Same normalisation as scripts/catalogue/common.ts normaliseForMatch (excerpt-in-source check). */
export function normaliseForMatch(s: string): string {
  return s
    .replace(/[\u00a0\u2007\u202f\u200b]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type Grounder = (e: { sourceUrl: string; contentHash: string; locator: { page?: number | undefined }; content: { kind: string; text?: string } }) => boolean;

/**
 * D28: 'grounded' = the excerpt is machine-verified present in the saved source text (catalogue: whole saved page text from data/raw/crops;
 * ginger: the cited PDF page from data/raw/extract-cache) and <= 60 words. Meaning/scope review is still pending. Never produces 'validated'.
 */
export function makeGrounder(root = REPO_ROOT): Grounder {
  const byUrl = new Map<string, string>();
  const cropsDir = join(root, "data", "raw", "crops");
  if (existsSync(cropsDir)) {
    for (const f of readdirSync(cropsDir).filter((x) => x.endsWith(".meta.json"))) {
      const meta = JSON.parse(readFileSync(join(cropsDir, f), "utf8")) as { key: string; url: string };
      const txt = join(cropsDir, `${meta.key}.txt`);
      if (existsSync(txt)) byUrl.set(meta.url, normaliseForMatch(readFileSync(txt, "utf8")));
    }
  }
  const cacheDir = join(root, "data", "raw", "extract-cache");
  const pagesByHash = new Map<string, Map<number, string>>();
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir).filter((x) => x.endsWith(".json"))) {
      const d = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as { sha256: string; pages: { page: number; text: string }[] };
      pagesByHash.set(d.sha256, new Map(d.pages.map((p) => [p.page, normaliseForMatch(p.text)])));
    }
  }
  return (e) => {
    if (e.content.kind !== "excerpt" || !e.content.text) return false;
    const words = e.content.text.trim().split(/\s+/).length;
    if (words > 60) return false;
    const needle = normaliseForMatch(e.content.text);
    const pages = pagesByHash.get(e.contentHash);
    if (pages) return e.locator.page !== undefined && (pages.get(e.locator.page)?.includes(needle) ?? false);
    const page = byUrl.get(e.sourceUrl);
    return page !== undefined && page.includes(needle);
  };
}

/**
 * 2026-11-02 (ASSISTANT_FARM_BRIEFING_SPEC.md 2.5): a name written as a combined label ("Paddy / rice", "Tur, arhar") also
 * yields each part as an alias of the same language and kind, after the original, so "paddy" and "rice" resolve exactly.
 * Case-insensitive duplicates are dropped. The resolver applies the same split to stored names (handlers.ts aliasesFromNames).
 */
export function splitNameParts<T extends { text: string }>(names: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (n: T) => {
    const key = n.text.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const n of names) {
    add(n);
    if (/ \/ |, /.test(n.text)) for (const part of n.text.split(/ \/ |, /)) add({ ...n, text: part.trim() });
  }
  return out;
}

/** Deterministic UUID (v5-style, fixed namespace) so evidence ids are stable across reloads and databases. */
const NS = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
export function uuidFromKey(key: string): string {
  const h = createHash("sha1").update(NS).update(key).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** `ginger.fresh` (T05b) -> `ginger-fresh` (catalogue product id). Unknown product ids are dropped, never guessed. */
export function normaliseProductIds(ids: string[], known: Set<string>): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) {
    const alt = id.replace(".", "-");
    if (known.has(id)) kept.push(id);
    else if (known.has(alt)) kept.push(alt);
    else dropped.push(id);
  }
  return { kept: [...new Set(kept)], dropped };
}

export const topicOf = (section: string | undefined): string[] => {
  const t = (section ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return /^[a-z][a-z0-9_]{1,80}$/.test(t) ? [t] : [];
};

const locatorText = (l: { page?: number | undefined; section?: string | undefined }) => [l.page !== undefined ? `p${l.page}` : null, l.section ?? null].filter(Boolean).join(" | ") || null;

export interface LoadCounts {
  identities: number;
  products: number;
  profiles: number;
  qualifiedProfiles: number;
  sourceDocuments: number;
  evidence: number;
  evidenceValidated: number;
  evidenceGrounded: number;
  evidencePending: number;
  droppedProductRefs: number;
  stages: number;
  rules: number;
  rulesByStatus: Record<string, number>;
  coverage: number;
  districts: number;
  states: number;
}

export interface CatalogueValidation {
  /** Rule/stage/coverage region ids that are not in the district registry (districts.json) and are not `IN`. */
  unknownRegionIds: { where: string; id: string }[];
  /** Rules that can produce a HARD effect (eligible/ineligible) and use the `known` operator. */
  knownInHardRules: string[];
}

export class CatalogueValidationError extends Error {
  constructor(public readonly validation: CatalogueValidation) {
    const parts = [
      ...validation.unknownRegionIds.slice(0, 20).map((u) => `${u.where}: unknown region id ${u.id}`),
      ...validation.knownInHardRules.slice(0, 20).map((r) => `${r}: the known operator is not allowed in a rule with a HARD effect`),
    ];
    super(`catalogue validation failed (${validation.unknownRegionIds.length} unknown region ids, ${validation.knownInHardRules.length} HARD rules using known): ${parts.join("; ")}`);
  }
}

/**
 * Load-time rule checks (F8, review R3a #9/#10). Region ids are compared exactly against the registry
 * (`IN` = national); a different spelling of a registry id (e.g. `IN-KA-HAS` for `IN-KA-hassan`, or a
 * case difference) is reported, never silently mapped. Without a registry every non-`IN` id is unknown.
 */
export function validateCatalogue(files: Pick<CatalogueFiles, "ruleSets" | "stages" | "coverage" | "areas">): CatalogueValidation {
  const registry = new Set(files.areas.map((a) => a.id));
  const unknownRegionIds: CatalogueValidation["unknownRegionIds"] = [];
  const check = (where: string, id: string) => {
    if (id !== "IN" && !registry.has(id)) unknownRegionIds.push({ where, id });
  };
  for (const set of files.ruleSets) for (const r of set.rules) for (const id of r.scope.regionIds) check(`${set.file}#${r.id}`, id);
  for (const st of files.stages) if (st.scope.level !== "farm") for (const id of st.scope.ids) check(`stage ${st.id}`, id);
  for (const c of files.coverage) if (c.region.level !== "farm") for (const id of c.region.ids) check(`coverage ${c.id}`, id);
  const knownInHardRules = files.ruleSets.flatMap((set) => set.rules.flatMap((r) => knownInHardRule(r).map((x) => `${set.file}#${x}`)));
  return { unknownRegionIds, knownInHardRules };
}

/** Idempotent upsert of the whole catalogue. Public reference data: mode-agnostic, no farmer data. */
export async function loadCatalogueIntoDb(pool: Pool, files: CatalogueFiles = readCatalogueFiles(), rawRoot: string = REPO_ROOT): Promise<LoadCounts> {
  // Fail loudly before writing anything.
  const validation = validateCatalogue(files);
  if (validation.unknownRegionIds.length > 0 || validation.knownInHardRules.length > 0) throw new CatalogueValidationError(validation);
  const knownProducts = new Set(files.products.map((p) => p.id));
  return withTransaction(pool, async (db) => {
    const cropUuid = new Map<string, string>();
    const profileByCrop = new Map(files.profiles.map((p) => [p.cropId, p]));
    for (const i of files.identities) {
      const names = {
        en: splitNameParts([
          ...i.commonNames.filter((n) => n.language === "en").map((n) => ({ text: n.text, kind: n.kind })),
          ...i.aliases.filter((n) => n.language === "en").map((n) => ({ text: n.text, kind: n.kind })),
        ]),
        ...Object.fromEntries(
          ["ta", "hi"].flatMap((l) => {
            const t = splitNameParts([...i.commonNames, ...i.aliases].filter((n) => n.language === l).map((n) => ({ text: n.text, kind: n.kind })));
            return t.length ? [[l, t]] : [];
          }),
        ),
      };
      const r = await db.query<{ id: string }>(
        `INSERT INTO crop_identities (slug, scientific_name, names, category, record, source_id, validation_status)
         VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,'catalogue:T06a','pending')
         ON CONFLICT (slug) DO UPDATE SET scientific_name=EXCLUDED.scientific_name, names=EXCLUDED.names, category=EXCLUDED.category,
           record=EXCLUDED.record, source_id=EXCLUDED.source_id, updated_at=now() RETURNING id`,
        [i.id, i.botanicalName, JSON.stringify(names), profileByCrop.get(i.id)?.group ?? null, JSON.stringify(i)],
      );
      cropUuid.set(i.id, r.rows[0]!.id);
    }
    for (const p of files.products) {
      await db.query(
        `INSERT INTO crop_products (crop_id, slug, name, form, grade, unit, record, source_id, validation_status)
         VALUES ($1,$2,$3,$4,$5,'kg',$6::jsonb,'catalogue:T06a','pending')
         ON CONFLICT (slug) DO UPDATE SET crop_id=EXCLUDED.crop_id, name=EXCLUDED.name, form=EXCLUDED.form, grade=EXCLUDED.grade,
           unit=EXCLUDED.unit, record=EXCLUDED.record, updated_at=now()`,
        [cropUuid.get(p.cropId)!, p.id, p.name, p.productBasis, p.grade, JSON.stringify(p)],
      );
    }
    let qualified = 0;
    for (const p of files.profiles) {
      if (p.qualification.qualified) qualified++;
      await db.query(
        `INSERT INTO crop_profiles (crop_id, record, qualified, source_id, validation_status) VALUES ($1,$2::jsonb,$3,'catalogue:T06a','pending')
         ON CONFLICT (crop_id) DO UPDATE SET record=EXCLUDED.record, qualified=EXCLUDED.qualified, updated_at=now()`,
        [cropUuid.get(p.cropId)!, JSON.stringify(p), p.qualification.qualified],
      );
    }

    const docs = new Set<string>();
    let dropped = 0;
    let validated = 0;
    let grounded = 0;
    const grounder = makeGrounder(rawRoot);
    for (const { record: e, sourceId } of files.evidence) {
      const doc = await db.query<{ id: string }>(
        `INSERT INTO source_documents (content_hash, title, publisher, url, licence, access_class, retrieved_at, metadata)
         VALUES ($1,$2,$3,$4,$5,'public',$6,$7::jsonb)
         ON CONFLICT (content_hash) DO UPDATE SET title=EXCLUDED.title, publisher=EXCLUDED.publisher, url=EXCLUDED.url, licence=EXCLUDED.licence, updated_at=now()
         RETURNING id`,
        [e.contentHash, e.documentTitle, e.publisher, e.sourceUrl, e.licence.licence, e.ingestedAt, JSON.stringify({ documentVersion: e.documentVersion, redistributable: e.licence.redistributable })],
      );
      docs.add(doc.rows[0]!.id);
      const prod = normaliseProductIds(e.productIds, knownProducts);
      dropped += prod.dropped.length;
      // Human-validated stays validated; a pending record whose excerpt passes the machine check becomes grounded.
      const status = e.validationStatus === "pending" && grounder(e) ? "grounded" : e.validationStatus;
      if (status === "validated") validated++;
      if (status === "grounded") grounded++;
      await db.query(
        `INSERT INTO evidence_records (id, evidence_key, source_id, locator, excerpt, claim, mode, geography_level, geography_ids, crop_ids, product_ids, topics,
           effective_available_at, availability_basis, validation_status, record, catalogue_source_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
         ON CONFLICT (evidence_key) DO UPDATE SET source_id=EXCLUDED.source_id, locator=EXCLUDED.locator, excerpt=EXCLUDED.excerpt, claim=EXCLUDED.claim,
           mode=EXCLUDED.mode, geography_level=EXCLUDED.geography_level, geography_ids=EXCLUDED.geography_ids, crop_ids=EXCLUDED.crop_ids,
           product_ids=EXCLUDED.product_ids, topics=EXCLUDED.topics, effective_available_at=EXCLUDED.effective_available_at,
           availability_basis=EXCLUDED.availability_basis, validation_status=EXCLUDED.validation_status, record=EXCLUDED.record,
           catalogue_source_id=EXCLUDED.catalogue_source_id, updated_at=now()`,
        [
          uuidFromKey(e.id), e.id, doc.rows[0]!.id, locatorText(e.locator), e.content.kind === "excerpt" ? e.content.text : null,
          JSON.stringify({ units: e.units, sourceUnits: e.sourceUnits, droppedProductIds: prod.dropped }),
          e.mode, e.geography.level, e.geography.ids, e.cropIds, prod.kept, topicOf(e.locator.section),
          e.availability.effectiveAvailableAt, e.availability.basis, status, JSON.stringify(e), sourceId,
        ],
      );
    }

    const rulesByStatus: Record<string, number> = {};
    let ruleCount = 0;
    for (const set of files.ruleSets) {
      for (const r of set.rules) {
        const crop = cropUuid.get(r.cropId);
        if (!crop) throw new Error(`rule ${r.id}: unknown crop ${r.cropId}`);
        const firstEv = r.evidenceIds[0];
        await db.query(
          `INSERT INTO crop_rules (crop_id, region_code, rule_kind, version, rule, evidence_id, rule_key, review_status, reviewer, rule_mode, source_id, validation_status, evidence_keys)
           VALUES ($1,$2,$3,$4,$5::jsonb,(SELECT id FROM evidence_records WHERE evidence_key=$6),$7,$8,$9,$10,$11,'pending',$12)
           ON CONFLICT (rule_key) DO UPDATE SET crop_id=EXCLUDED.crop_id, region_code=EXCLUDED.region_code, rule_kind=EXCLUDED.rule_kind, version=EXCLUDED.version,
             rule=EXCLUDED.rule, evidence_id=EXCLUDED.evidence_id, review_status=EXCLUDED.review_status, reviewer=EXCLUDED.reviewer,
             rule_mode=EXCLUDED.rule_mode, source_id=EXCLUDED.source_id, evidence_keys=EXCLUDED.evidence_keys, updated_at=now()`,
          [crop, r.scope.regionIds.join(","), r.id, r.version, JSON.stringify(r), firstEv ?? null, r.id, r.reviewStatus, set.reviewers[r.id] ?? null, r.mode, set.sourceId, r.evidenceIds],
        );
        ruleCount++;
        rulesByStatus[r.reviewStatus] = (rulesByStatus[r.reviewStatus] ?? 0) + 1;
      }
    }
    for (const s of files.stages) {
      const crop = cropUuid.get(s.cropId);
      if (!crop) throw new Error(`stage ${s.id}: unknown crop`);
      await db.query(
        `INSERT INTO stage_definitions (crop_id, region_code, stage_key, ordinal, typical_days_min, typical_days_max, definition, evidence_id, version, record_key, review_status, source_id, validation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,(SELECT id FROM evidence_records WHERE evidence_key=$8),1,$9,$10,'T05b:ginger.hassan-kharif.stages.json','pending')
         ON CONFLICT (record_key) DO UPDATE SET region_code=EXCLUDED.region_code, stage_key=EXCLUDED.stage_key, ordinal=EXCLUDED.ordinal,
           typical_days_min=EXCLUDED.typical_days_min, typical_days_max=EXCLUDED.typical_days_max, definition=EXCLUDED.definition,
           evidence_id=EXCLUDED.evidence_id, review_status=EXCLUDED.review_status, updated_at=now()`,
        [crop, s.scope.ids.join(","), s.stageId, s.order, s.durationDays.min, s.durationDays.max, JSON.stringify(s), s.evidenceIds[0] ?? null, s.id, s.reviewStatus],
      );
    }
    for (const c of files.coverage) {
      const crop = cropUuid.get(c.cropId);
      if (!crop) throw new Error(`coverage ${c.id}: unknown crop`);
      await db.query(
        `INSERT INTO coverage_records (crop_id, region_code, capability, status, detail, record_key, record, source_id, validation_status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,'catalogue:T06a','pending')
         ON CONFLICT (record_key) DO UPDATE SET crop_id=EXCLUDED.crop_id, region_code=EXCLUDED.region_code, capability=EXCLUDED.capability, status=EXCLUDED.status,
           detail=EXCLUDED.detail, record=EXCLUDED.record, updated_at=now()`,
        [crop, c.region.ids.join(","), c.capability, c.supportStatus, JSON.stringify({ season: c.season, irrigation: c.irrigation, productId: c.productId, missingReason: c.missingReason }), c.id, JSON.stringify(c)],
      );
    }
    for (const a of files.areas) {
      await db.query(
        `INSERT INTO districts (id, level, state_id, names, source_id, source, validation_status)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)
         ON CONFLICT (id) DO UPDATE SET level=EXCLUDED.level, state_id=EXCLUDED.state_id, names=EXCLUDED.names, source_id=EXCLUDED.source_id,
           source=EXCLUDED.source, validation_status=EXCLUDED.validation_status, updated_at=now()`,
        [a.id, a.level, a.stateId, JSON.stringify(a.names), typeof a.source === "string" ? a.source : a.source.sourceId, JSON.stringify(a.source), a.validationStatus],
      );
    }
    return {
      identities: files.identities.length,
      products: files.products.length,
      profiles: files.profiles.length,
      qualifiedProfiles: qualified,
      sourceDocuments: docs.size,
      evidence: files.evidence.length,
      evidenceValidated: validated,
      evidenceGrounded: grounded,
      evidencePending: files.evidence.length - validated - grounded,
      droppedProductRefs: dropped,
      stages: files.stages.length,
      rules: ruleCount,
      rulesByStatus,
      coverage: files.coverage.length,
      districts: files.areas.filter((a) => a.level === "district").length,
      states: files.areas.filter((a) => a.level === "state").length,
    };
  });
}
