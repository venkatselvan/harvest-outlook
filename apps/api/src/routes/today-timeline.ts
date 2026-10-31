import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {StageTimeline} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {FetchLike} from '../ingest/http';
import type {CatalogueSnapshot} from '../catalogue/snapshot';
import type {ProviderConfig} from '../providers/config';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema, uuidParam} from './schemas/common';
import {ApiError, notFound} from '../services/errors';
import {getFarm} from '../services/farms';
import {boundaryMetrics, getWorkspace} from '../services/workspace';
import {stageTimeline} from '../services/today/stage-timeline';
import {MAX_TRACK_DAYS, WeatherTrack, unavailableTrack, weatherTrack} from '../services/today/weather-track';

export interface TodayTimelineDeps {
  config: Config;
  pool: Pool;
  now?: (() => Date) | undefined;
  fetchImpl?: FetchLike | undefined;
  providerConfig?: ProviderConfig | undefined;
  snapshot?: Pick<CatalogueSnapshot, 'stages'> | undefined;
}

export const FarmStageTimeline = z.object({
  farmId: z.uuid(),
  /** The cycle the timeline was built for; null when the farm has no current cycle. */
  cycleId: z.string().nullable(),
  timeline: StageTimeline.nullable(),
  limitations: z.array(z.string()),
}).strict();
export type FarmStageTimeline = z.infer<typeof FarmStageTimeline>;

export const FarmWeatherTrack = z.object({
  farmId: z.uuid(),
  pointBasis: z.enum(['boundary_centroid', 'farm_point', 'none']),
  ...WeatherTrack.shape,
}).strict();
export type FarmWeatherTrack = z.infer<typeof FarmWeatherTrack>;

const today = (now: Date) => new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
const daySpan = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * Owner-scoped: the farm is resolved through `getFarm(pool, ownerId, id)` first, so a foreign or deleted farm is a 404 in
 * every mode. With `cycleId` the named cycle (404 when absent, harvested cycles allowed); without it the most recently
 * established cycle that is not harvested, or `timeline: null` when there is none.
 */
export async function farmStageTimeline(deps: TodayTimelineDeps, ownerId: string, farmId: string, cycleId?: string): Promise<FarmStageTimeline> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const anchorOf = (c: (typeof workspace.cycles)[number]) => c.establishmentDate ?? c.sowingDate;
  const cycle = cycleId !== undefined
    ? workspace.cycles.find((c) => c.id === cycleId)
    : [...workspace.cycles].filter((c) => c.stage !== 'harvested').sort((a, b) => anchorOf(b).localeCompare(anchorOf(a)))[0];
  if (cycleId !== undefined && !cycle) throw notFound('Crop cycle');
  const limitations = ['Stage dates are a calendar estimate from the recorded establishment date. A stage is never marked reached by an observation.'];
  if (!cycle) return {farmId, cycleId: null, timeline: null, limitations: [...limitations, 'This farm has no current crop cycle.']};
  if (!cycle.establishmentMethod) limitations.push('The establishment method was not recorded, so durations for every method were considered.');
  const timeline = stageTimeline({
    cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: anchorOf(cycle),
    stateId: farm.location.stateCode, districtId: farm.location.districtId, snapshot: deps.snapshot,
  });
  return {farmId, cycleId: cycle.id, timeline, limitations};
}

/** Field boundary centroid when a boundary is drawn, else the farm point; with neither, every day is `unavailable`. */
export async function farmWeatherTrack(deps: TodayTimelineDeps, ownerId: string, farmId: string, range: {from: string; to: string}): Promise<FarmWeatherTrack> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  if (range.from > range.to) throw new ApiError(400, 'validation_error', 'from must be on or before to');
  if (daySpan(range.from, range.to) > MAX_TRACK_DAYS) throw new ApiError(400, 'validation_error', `The weather track covers at most ${MAX_TRACK_DAYS} days`);
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  let point: {lat: number; lon: number} | null = null;
  let pointBasis: FarmWeatherTrack['pointBasis'] = 'none';
  if (workspace.boundary) {
    const m = boundaryMetrics(workspace.boundary);
    point = {lat: m.lat, lon: m.lon};
    pointBasis = 'boundary_centroid';
  } else if (farm.location.lat !== null && farm.location.lon !== null) {
    point = {lat: farm.location.lat, lon: farm.location.lon};
    pointBasis = 'farm_point';
  }
  if (!point) return {farmId, pointBasis, ...unavailableTrack(range.from, range.to, 'No field boundary or farm point is recorded, so no weather can be located.')};
  const mode = deps.config.RUNTIME_MODE;
  const track = await weatherTrack(
    {pool: deps.pool, autoIngest: mode === 'live', fetchImpl: deps.fetchImpl, providerConfig: deps.providerConfig, now: deps.now},
    {point, from: range.from, to: range.to, asOf: (deps.now?.() ?? new Date()).toISOString(), mode, farmId},
  );
  return {farmId, pointBasis, ...track};
}

/** Owner-private stage timeline and weather track for the Today slider. Registered in routes/index.ts. */
export async function todayTimelineRoutes(app: FastifyInstance, deps: TodayTimelineDeps) {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/stage-timeline', {
    schema: {tags: ['farms'], params: uuidParam, querystring: z.object({cycleId: z.string().min(1).max(120).optional()}).strict(), response: {200: envelopeSchema(FarmStageTimeline)}},
  }, async (req) => envelope(req.id, config.RUNTIME_MODE, await farmStageTimeline(deps, requireAuth(req).ownerId, req.params.id, req.query.cycleId)));
  r.get('/api/v1/farms/:id/weather-track', {
    // A cold read in live mode can reach the weather provider once (bounded), so keep the rate low.
    config: {rateLimit: {max: 30, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: uuidParam, querystring: z.object({from: z.iso.date(), to: z.iso.date()}).strict(), response: {200: envelopeSchema(FarmWeatherTrack)}},
  }, async (req) => envelope(req.id, config.RUNTIME_MODE, await farmWeatherTrack(deps, requireAuth(req).ownerId, req.params.id, {from: req.query.from, to: req.query.to})));
}
