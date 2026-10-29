import type { Pool } from "../db/pool";
import type { PoolClient } from "pg";
import { payloadHash } from "../services/hash";
import type { VisualAssetRef, VisualAssetSource } from "../plans/sources";
import { ILLUSTRATIVE_LABEL, QA_FLAG_LABEL, SCHEMATIC_LABEL, type AssetState } from "./labels";
import type { QaResult } from "./qa";

type Db = Pool | PoolClient;

export interface AssetRow {
  id: string;
  owner_id: string;
  plan_id: string;
  source_media_id: string | null;
  mode: "live" | "replay" | "synthetic";
  stage_key: string | null;
  cache_key: string;
  model: string | null;
  kind: "illustrative" | "schematic";
  status: AssetState;
  label: string;
  provider: string | null;
  provider_request_id: string | null;
  prompt_version: string | null;
  prompt_template_hash: string | null;
  brief_hash: string | null;
  qa: QaResult | null;
  storage_key: string | null;
  region_version: number | null;
  width: number | null;
  height: number | null;
  failure_reason: string | null;
  job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, owner_id, plan_id, source_media_id, mode, stage_key, cache_key, model, kind, status, label, provider, provider_request_id,
  prompt_version, prompt_template_hash, brief_hash, qa, storage_key, region_version, width, height, failure_reason, job_id, created_at, updated_at`;

export interface VisualAssetOut {
  assetId: string;
  planId: string;
  stageId: string | null;
  state: AssetState;
  kind: "illustrative" | "schematic";
  /** Always true; a generated or schematic image is never an observation. */
  illustrative: true;
  evidenceState: "illustrative";
  label: string;
  reason: string | null;
  qa: { passed: boolean; reasons: string[] } | null;
  /** Shown by the UI when scene QA flagged the generated image. */
  qaWarning: string | null;
  contentPath: string | null;
  provider: string | null;
  model: string | null;
  sourceMediaId: string | null;
  regionVersion: number | null;
  mode: "live" | "replay" | "synthetic";
  createdAt: string;
}

export function toOut(r: AssetRow): VisualAssetOut {
  const flagged = r.qa !== null && r.qa.passed === false;
  return {
    assetId: r.id,
    planId: r.plan_id,
    stageId: r.stage_key,
    state: r.status,
    kind: r.kind,
    illustrative: true,
    evidenceState: "illustrative",
    label: r.status === "ready" ? ILLUSTRATIVE_LABEL : SCHEMATIC_LABEL,
    reason: r.failure_reason,
    qa: r.qa ? { passed: r.qa.passed, reasons: r.qa.reasons } : null,
    qaWarning: flagged ? QA_FLAG_LABEL : null,
    contentPath: r.status === "ready" ? `/api/v1/visuals/${r.id}/content` : null,
    provider: r.provider,
    model: r.model,
    sourceMediaId: r.source_media_id,
    regionVersion: r.region_version,
    mode: r.mode,
    createdAt: r.created_at.toISOString(),
  };
}

/** Rows of THIS plan for the given cache keys. */
export async function findByCacheKeys(db: Db, ownerId: string, planId: string, keys: string[]): Promise<AssetRow[]> {
  if (keys.length === 0) return [];
  const r = await db.query<AssetRow>(`SELECT ${COLS} FROM visual_assets WHERE owner_id=$1 AND plan_id=$2 AND cache_key = ANY($3::text[])`, [ownerId, planId, keys]);
  return r.rows;
}

/**
 * Adopts ready keyframes the same owner already generated under another plan (same cache key = same photo, region,
 * crop, stage definitions, brief, model and mode). Creates a row for this plan that shares the stored object; no provider
 * call and no cost. Replaces only failed/schematic rows of this plan. Returns the number of rows adopted.
 */
export async function adoptReusable(db: Db, ownerId: string, planId: string, keys: string[], jobId: string | null): Promise<number> {
  if (keys.length === 0) return 0;
  const r = await db.query(
    `INSERT INTO visual_assets (id, owner_id, plan_id, source_media_id, mode, stage_key, cache_key, crop_id, model, kind, status, label, provider, provider_request_id,
        prompt_version, prompt_template_hash, brief_hash, qa, storage_key, region_version, width, height, failure_reason, job_id, reused_from)
     SELECT gen_random_uuid(), s.owner_id, $2, s.source_media_id, s.mode, s.stage_key, s.cache_key, s.crop_id, s.model, s.kind, s.status, s.label, s.provider, s.provider_request_id,
        s.prompt_version, s.prompt_template_hash, s.brief_hash, s.qa, s.storage_key, s.region_version, s.width, s.height, s.failure_reason, $4, s.id
     FROM (SELECT DISTINCT ON (cache_key) * FROM visual_assets WHERE owner_id=$1 AND cache_key = ANY($3::text[]) AND status='ready' AND plan_id <> $2
           ORDER BY cache_key, updated_at DESC, id) s
     ON CONFLICT (owner_id, plan_id, cache_key) DO UPDATE SET status=EXCLUDED.status, kind=EXCLUDED.kind, label=EXCLUDED.label, provider=EXCLUDED.provider,
        provider_request_id=EXCLUDED.provider_request_id, qa=EXCLUDED.qa, storage_key=EXCLUDED.storage_key, width=EXCLUDED.width, height=EXCLUDED.height,
        failure_reason=NULL, job_id=EXCLUDED.job_id, reused_from=EXCLUDED.reused_from
        WHERE visual_assets.status <> 'ready'`,
    [ownerId, planId, keys, jobId],
  );
  return r.rowCount ?? 0;
}

export interface UpsertAsset {
  id: string;
  ownerId: string;
  planId: string;
  sourceMediaId: string;
  mode: "live" | "replay" | "synthetic";
  stageId: string;
  cacheKey: string;
  cropId: string;
  model: string;
  kind: "illustrative" | "schematic";
  status: Exclude<AssetState, "queued">;
  provider: string | null;
  providerRequestId: string | null;
  promptVersion: string | null;
  promptTemplateHash: string | null;
  briefHash: string | null;
  qa: QaResult | null;
  storageKey: string | null;
  regionVersion: number;
  width: number | null;
  height: number | null;
  failureReason: string | null;
  jobId: string | null;
}

/**
 * Inserts the asset or replaces a previous failed/schematic row for the same cache key. A `ready` row is never
 * overwritten (returns null), so a concurrent duplicate job cannot clobber a stored keyframe.
 */
export async function upsertAsset(db: Db, a: UpsertAsset): Promise<AssetRow | null> {
  const r = await db.query<AssetRow>(
    `INSERT INTO visual_assets (id, owner_id, plan_id, source_media_id, mode, stage_key, cache_key, crop_id, model, kind, status, label, provider, provider_request_id,
        prompt_version, prompt_template_hash, brief_hash, qa, storage_key, region_version, width, height, failure_reason, job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (owner_id, plan_id, cache_key) DO UPDATE SET status=EXCLUDED.status, kind=EXCLUDED.kind, label=EXCLUDED.label, provider=EXCLUDED.provider,
        provider_request_id=EXCLUDED.provider_request_id, prompt_version=EXCLUDED.prompt_version, prompt_template_hash=EXCLUDED.prompt_template_hash,
        brief_hash=EXCLUDED.brief_hash, qa=EXCLUDED.qa, storage_key=EXCLUDED.storage_key, width=EXCLUDED.width, height=EXCLUDED.height,
        failure_reason=EXCLUDED.failure_reason, job_id=EXCLUDED.job_id, model=EXCLUDED.model
        WHERE visual_assets.status <> 'ready'
     RETURNING ${COLS}`,
    [
      a.id, a.ownerId, a.planId, a.sourceMediaId, a.mode, a.stageId, a.cacheKey, a.cropId, a.model, a.kind, a.status, a.kind === "schematic" || a.status !== "ready" ? "schematic" : "illustrative",
      a.provider, a.providerRequestId, a.promptVersion, a.promptTemplateHash, a.briefHash, a.qa ? JSON.stringify(a.qa) : null, a.storageKey, a.regionVersion, a.width, a.height, a.failureReason, a.jobId,
    ],
  );
  return r.rows[0] ?? null;
}

/** Latest row per stage for a plan (one region/photo may have been replaced by a newer one). */
export async function listLatestPerStage(db: Db, ownerId: string, planId: string): Promise<AssetRow[]> {
  const r = await db.query<AssetRow>(
    `SELECT DISTINCT ON (stage_key) ${COLS} FROM visual_assets WHERE owner_id=$1 AND plan_id=$2 AND stage_key IS NOT NULL
     ORDER BY stage_key, updated_at DESC, id`,
    [ownerId, planId],
  );
  return r.rows;
}

export async function getOwned(db: Db, ownerId: string, assetId: string): Promise<AssetRow | null> {
  const r = await db.query<AssetRow>(`SELECT ${COLS} FROM visual_assets WHERE id=$1 AND owner_id=$2`, [assetId, ownerId]);
  return r.rows[0] ?? null;
}

/** T08 timeline binding: bind as `sources.visuals`. Only ready generated keyframes are returned; schematic/failed stages stay "schematic" in the timeline. */
export class PgVisualAssetSource implements VisualAssetSource {
  constructor(private readonly pool: Pool) {}

  private async ready(ownerId: string, planId: string): Promise<AssetRow[]> {
    return (await listLatestPerStage(this.pool, ownerId, planId)).filter((r) => r.status === "ready");
  }

  /** Journal photos of the plan's farm as dated observed assets (one per media object, oldest first). Drafts are excluded (only final, non-draft entries). */
  private async journalPhotos(ownerId: string, planId: string): Promise<{ mediaId: string; date: string }[]> {
    const r = await this.pool.query<{ media_id: string; entry_date: string }>(
      `SELECT m.media_id::text AS media_id, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date
         FROM plans p
         JOIN journal_entries e ON e.owner_id = p.owner_id AND e.farm_id = p.farm_id AND e.status = 'final' AND e.processing_status <> 'draft'
         CROSS JOIN LATERAL unnest(e.media_ids) AS m(media_id)
        WHERE p.id = $1 AND p.owner_id = $2
        ORDER BY e.entry_date, m.media_id`,
      [planId, ownerId],
    );
    return r.rows.map((x) => ({ mediaId: x.media_id, date: x.entry_date }));
  }

  async getAssets(ownerId: string, planId: string): Promise<VisualAssetRef[]> {
    const generated = (await this.ready(ownerId, planId)).map((r) => ({ assetId: r.id, kind: "illustrative" as const, date: null, stageId: r.stage_key }));
    const photos = (await this.journalPhotos(ownerId, planId)).map((p) => ({ assetId: p.mediaId, kind: "observed_photo" as const, date: p.date, stageId: null }));
    return [...generated, ...photos];
  }

  async version(ownerId: string, planId: string): Promise<string> {
    const rows = await this.ready(ownerId, planId);
    const photos = await this.journalPhotos(ownerId, planId);
    if (rows.length === 0 && photos.length === 0) return "none";
    return payloadHash([...rows.map((r) => [r.id, r.updated_at.toISOString(), r.qa?.passed ?? null]), ...photos.map((p) => ["photo", p.mediaId, p.date])].sort()).slice(0, 32);
  }
}
