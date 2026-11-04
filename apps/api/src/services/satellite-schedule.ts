import type { Config } from '../config';
import type { Pool } from '../db/pool';
import { withTransaction } from '../db/pool';
import { enqueue } from './jobs';

export const SATELLITE_REFRESH_JOB = 'satellite.refresh';
export const satelliteDay = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const satelliteRefreshKey = (farmId: string, day: string) => `satellite-daily:${farmId}:${day}`;

/** One catalogue refresh per IST day, including farms with no active crop. No model or monitoring budget required. */
export async function enqueueDueSatelliteRefreshes(pool: Pool, mode: Config['RUNTIME_MODE'], now = new Date()): Promise<number> {
  if (mode !== 'live') return 0;
  const day = satelliteDay(now);
  return withTransaction(pool, async c => {
    const due = await c.query<{id: string; owner_id: string}>(`
      SELECT f.id,f.owner_id FROM farms f JOIN owners o ON o.id=f.owner_id
      LEFT JOIN farm_workspaces w ON w.farm_id=f.id
      WHERE f.deleted_at IS NULL AND o.deleted_at IS NULL
        AND ((f.lat IS NOT NULL AND f.lon IS NOT NULL AND f.location_precision <> 'district')
          OR w.state->'boundary' IS NOT NULL AND w.state->'boundary' <> 'null'::jsonb
          OR jsonb_array_length(COALESCE(w.state->'fields','[]'::jsonb)) > 0)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.owner_id=f.owner_id
          AND j.idempotency_key='satellite-daily:' || f.id::text || ':' || $1)
      ORDER BY f.created_at LIMIT 10 FOR UPDATE OF f SKIP LOCKED`, [day]);
    for (const farm of due.rows) await enqueue(c, SATELLITE_REFRESH_JOB, {farmId: farm.id, day}, farm.owner_id, satelliteRefreshKey(farm.id, day));
    return due.rows.length;
  });
}
