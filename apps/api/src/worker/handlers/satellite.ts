import { z } from 'zod';
import { RetryableError, type JobHandler } from '../main';
import { getFarm } from '../../services/farms';
import { getWorkspace } from '../../services/workspace';
import { ndviSeries, sceneImage, type NdviImageDeps } from '../../services/today/ndvi';
import { satelliteDay } from '../../services/satellite-schedule';

const Payload = z.object({farmId: z.uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)});
export function createSatelliteRefreshHandler(deps: NdviImageDeps): JobHandler {
  return async (job, ctx) => {
    const {farmId} = Payload.parse(job.payload);
    if (deps.config.RUNTIME_MODE !== 'live' || !job.owner_id) return {skipped: true};
    const ownerId = job.owner_id;
    if (!await getFarm(deps.pool, ownerId, farmId)) return {skipped: true};
    const workspace = await getWorkspace(deps.pool, ownerId, farmId);
    const targets: (string | undefined)[] = [undefined, ...workspace.fields.map(f => f.id)];
    const to = satelliteDay(deps.now?.() ?? new Date());
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
    const results: {fieldId: string | null; latestPass: string | null; latestUsable: string | null}[] = [];
    let failed = false;
    for (const [index, fieldId] of targets.entries()) {
      if (await ctx.isCancelled()) return {cancelled: true};
      try {
        const series = await ndviSeries(deps, ownerId, farmId, {from, to, fieldId, maxScenes: 24, maxSceneCloudPct: 100, refreshCatalogue: true});
        // Invalid/coarse locations cannot be fetched; provider failures must be retried.
        if (series.scenesFailed || series.scenesPending || (series.reason && !/^(farm_location_|boundary_)/.test(series.reason))) failed = true;
        if (series.latestUsable) {
          for (const zoom of ['wide', 'field'] as const) {
            await sceneImage(deps, ownerId, farmId, series.latestUsable.itemId, 'visual', zoom, fieldId);
          }
        }
        results.push({fieldId: fieldId ?? null, latestPass: series.readings.at(-1)?.date ?? null, latestUsable: series.latestUsable?.date ?? null});
      } catch (error) {
        // A deleted field/farm is no longer eligible, including deletion during a provider request.
        if ((error as {statusCode?: number}).statusCode !== 404) failed = true;
      }
      await ctx.heartbeat((index + 1) / targets.length);
    }
    if (failed) throw new RetryableError('One or more satellite catalogue, statistics or image fetches failed; retrying.');
    return {checkedAt: new Date().toISOString(), fields: results};
  };
}
