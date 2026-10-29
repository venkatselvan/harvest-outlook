import type { CoverageRecord, CropIdentity, CropProduct, CropRule, EvidenceRecord, StageDefinition } from "@harvest/contracts";
import type { QueryResultRow } from "pg";
import type { Pool } from "../db/pool";
import { readCatalogueFiles, type AreaRecord, type CatalogueFiles, type CropProfile } from "./files";

export interface RuleEntry {
  rule: CropRule;
  reviewer: string | null;
  sourceId: string;
}
/** Read-only in-memory view of the catalogue used by screening and the routes. */
export interface CatalogueSnapshot {
  identities: CropIdentity[];
  products: CropProduct[];
  profiles: CropProfile[];
  evidence: Map<string, EvidenceRecord>;
  rules: RuleEntry[];
  stages: StageDefinition[];
  coverage: CoverageRecord[];
  areas: AreaRecord[];
}

export function snapshotFromFiles(files: CatalogueFiles = readCatalogueFiles()): CatalogueSnapshot {
  return {
    identities: files.identities,
    products: files.products,
    profiles: files.profiles,
    evidence: new Map(files.evidence.map((e) => [e.record.id, e.record])),
    rules: files.ruleSets.flatMap((s) => s.rules.map((rule) => ({ rule, reviewer: s.reviewers[rule.id] ?? null, sourceId: s.sourceId }))),
    stages: files.stages,
    coverage: files.coverage,
    areas: files.areas,
  };
}

export class CatalogueNotLoadedError extends Error {}

/** Reads the catalogue from the database tables written by loadCatalogueIntoDb. */
export async function snapshotFromDb(pool: Pool): Promise<CatalogueSnapshot> {
  const q = <T extends QueryResultRow>(sql: string) => pool.query<T>(sql).then((r) => r.rows);
  const [ids, prods, profiles, ev, rules, stages, cov, areas] = await Promise.all([
    q<{ record: CropIdentity }>("SELECT record FROM crop_identities WHERE record IS NOT NULL ORDER BY slug"),
    q<{ record: CropProduct }>("SELECT record FROM crop_products WHERE record IS NOT NULL ORDER BY slug"),
    q<{ record: CropProfile }>("SELECT p.record FROM crop_profiles p JOIN crop_identities i ON i.id=p.crop_id ORDER BY i.slug"),
    q<{ record: EvidenceRecord }>("SELECT record FROM evidence_records WHERE record IS NOT NULL AND evidence_key IS NOT NULL ORDER BY evidence_key"),
    q<{ rule: CropRule; reviewer: string | null; source_id: string; review_status: string }>("SELECT rule, reviewer, source_id, review_status FROM crop_rules WHERE rule_key IS NOT NULL ORDER BY rule_key"),
    q<{ definition: StageDefinition }>("SELECT definition FROM stage_definitions WHERE record_key IS NOT NULL ORDER BY record_key"),
    q<{ record: CoverageRecord }>("SELECT record FROM coverage_records WHERE record_key IS NOT NULL ORDER BY record_key"),
    q<{ id: string; level: AreaRecord["level"]; state_id: string | null; names: AreaRecord["names"]; source: AreaRecord["source"]; validation_status: AreaRecord["validationStatus"] }>("SELECT id, level, state_id, names, source, validation_status FROM districts ORDER BY id"),
  ]);
  if (ids.length === 0 || profiles.length === 0) throw new CatalogueNotLoadedError("catalogue tables are empty; run pnpm db:seed");
  return {
    identities: ids.map((r) => r.record),
    products: prods.map((r) => r.record),
    profiles: profiles.map((r) => r.record),
    evidence: new Map(ev.map((r) => [r.record.id, r.record])),
    // review_status column is authoritative (the JSON copy carries the same value).
    rules: rules.map((r) => ({ rule: { ...r.rule, reviewStatus: r.review_status as CropRule["reviewStatus"] }, reviewer: r.reviewer, sourceId: r.source_id })),
    stages: stages.map((r) => r.definition),
    coverage: cov.map((r) => r.record),
    areas: areas.map((r) => ({ id: r.id, level: r.level, stateId: r.state_id, names: r.names, source: r.source, validationStatus: r.validation_status })),
  };
}

/** Per-process cache with a short TTL so a reseed shows up without a restart. */
export class CatalogueStore {
  private cached: { at: number; snap: CatalogueSnapshot } | null = null;
  constructor(private readonly pool: Pool, private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}
  async get(): Promise<CatalogueSnapshot> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.snap;
    const snap = await snapshotFromDb(this.pool);
    this.cached = { at: this.now(), snap };
    return snap;
  }
  invalidate(): void {
    this.cached = null;
  }
}
