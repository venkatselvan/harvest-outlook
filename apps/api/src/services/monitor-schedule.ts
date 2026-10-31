import { z } from 'zod';
import type { Pool } from '../db/pool';
import { withTransaction } from '../db/pool';
import { enqueue } from './jobs';
import { notFound } from './errors';
import { getFarm } from './farms';
import type { MonitoringSnapshot } from './monitoring';
import type { Config } from '../config';
import { payloadHash } from './hash';

export const MonitorSettings = z.object({ enabled: z.boolean(), intervalHours: z.number().int().min(6).max(168).default(6), metaEnabled: z.boolean().default(false) }).strict();
interface MonitorRow {
  enabled: boolean; meta_enabled: boolean; interval_hours: number; next_check_at: Date;
  last_checked_at: Date | null; last_attempt_at: Date | null; last_error: string | null; last_meta_at: Date | null;
  snapshot: MonitoringSnapshot | null; changes: { at: string; kind: string; message: string }[]; meta_review: unknown;
  market_refresh_reason: string | null;
}
export async function readMonitorSettings(pool: Pool, ownerId: string, farmId: string, mode?: Config['RUNTIME_MODE']) {
  if (!await getFarm(pool, ownerId, farmId)) throw notFound('Farm');
  const row = (await pool.query<MonitorRow>('SELECT * FROM farm_monitors WHERE farm_id=$1', [farmId])).rows[0];
  return { enabled: row?.enabled ?? false, metaEnabled: row?.meta_enabled ?? false, intervalHours: row?.interval_hours ?? 6,
    nextCheckAt: row?.enabled ? row.next_check_at.toISOString() : null, lastCheckedAt: row?.last_checked_at?.toISOString() ?? null,
    lastAttemptAt: row?.last_attempt_at?.toISOString() ?? null, lastError: row?.last_error ?? null,
    lastMetaAt: row?.last_meta_at?.toISOString() ?? null, changes: row?.changes ?? [], metaReview: mode && (row?.meta_review as { mode?: string } | null)?.mode === mode ? row!.meta_review : null,
    marketRefreshReason: row?.market_refresh_reason ?? null,
    runsWhen: 'background_worker_running' as const,
  };
}
export async function updateMonitorSettings(pool: Pool, ownerId: string, farmId: string, sessionId: string, settings: z.infer<typeof MonitorSettings>, mode?: Config['RUNTIME_MODE']) {
  await withTransaction(pool, async (c) => {
    const f = await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [farmId, ownerId]);
    if (!f.rows[0]) throw notFound('Farm');
    await c.query(`INSERT INTO farm_monitors(farm_id,session_id,enabled,meta_enabled,interval_hours) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(farm_id) DO UPDATE SET session_id=$2,enabled=$3,meta_enabled=$4,interval_hours=$5,next_check_at=now()`, [farmId, sessionId, settings.enabled, settings.metaEnabled, settings.intervalHours]);
  });
  return readMonitorSettings(pool, ownerId, farmId, mode);
}

/** Values and availability states only; a new retrieval timestamp alone is never a change. */
export function monitorFingerprint(s: MonitoringSnapshot) {
  return payloadHash({ mode: s.mode, weather: { status: s.weather.status, days: s.weather.days }, market: s.market });
}
export function monitorChanges(previous: MonitoringSnapshot | null, next: MonitoringSnapshot) {
  if (!previous || previous.mode !== next.mode) return [{ at: next.checkedAt, kind: 'monitor_started', message: 'Initial weather and mandi check recorded.' }];
  const changes: { at: string; kind: string; message: string }[] = [];
  if (payloadHash({ status: previous.weather.status, days: previous.weather.days }) !== payloadHash({ status: next.weather.status, days: next.weather.days })) changes.push({ at: next.checkedAt, kind: 'weather_changed', message: 'Forecast or weather availability changed. Review the dated forecast.' });
  if (payloadHash(previous.market) !== payloadHash(next.market)) changes.push({ at: next.checkedAt, kind: 'market_changed', message: 'Stored wholesale mandi references or their availability changed.' });
  return changes;
}

export async function saveMonitorSnapshot(pool: Pool, ownerId: string, snapshot: MonitoringSnapshot) {
  return withTransaction(pool, async (c) => {
    const farm = await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [snapshot.farmId, ownerId]);
    if (!farm.rows[0]) throw notFound('Farm');
    const prior = (await c.query<MonitorRow>('SELECT * FROM farm_monitors WHERE farm_id=$1 FOR UPDATE', [snapshot.farmId])).rows[0];
    const changes = monitorChanges(prior?.snapshot ?? null, snapshot);
    const history = [...changes, ...(prior?.changes ?? [])].slice(0, 50);
    await c.query(`INSERT INTO farm_monitors(farm_id,snapshot,last_checked_at,last_attempt_at,changes) VALUES($1,$2::jsonb,$3,$3,$4::jsonb)
      ON CONFLICT(farm_id) DO UPDATE SET snapshot=$2::jsonb,last_checked_at=$3,last_attempt_at=$3,last_error=NULL,changes=$4::jsonb`, [snapshot.farmId, JSON.stringify(snapshot), snapshot.checkedAt, JSON.stringify(history)]);
    return { changed: changes.length > 0, prior };
  });
}

/** Called once per minute by the worker. Parent-row and schedule locks keep multiple workers safe. */
export async function enqueueDueMonitors(pool: Pool): Promise<number> {
  return withTransaction(pool, async (c) => {
    const due = await c.query<{ farm_id: string; owner_id: string; interval_hours: number; next_check_at: Date }>(
      `SELECT m.farm_id,f.owner_id,m.interval_hours,m.next_check_at FROM farm_monitors m JOIN farms f ON f.id=m.farm_id
       JOIN owners o ON o.id=f.owner_id WHERE m.enabled AND m.next_check_at<=now() AND f.deleted_at IS NULL AND o.deleted_at IS NULL
       ORDER BY m.next_check_at LIMIT 10 FOR UPDATE OF m SKIP LOCKED`);
    for (const row of due.rows) {
      await enqueue(c, 'farm.monitor', { farmId: row.farm_id }, row.owner_id, `farm-monitor:${row.farm_id}:${row.next_check_at.toISOString()}`);
      await c.query('UPDATE farm_monitors SET next_check_at=now()+make_interval(hours=>interval_hours) WHERE farm_id=$1', [row.farm_id]);
    }
    return due.rows.length;
  });
}
