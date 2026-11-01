import {z} from 'zod';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {Budget} from '../../services/budget';
import type {TextModelProvider} from '../../agent/provider';
import {getFarm} from '../../services/farms';
import {getWorkspace} from '../../services/workspace';
import {harvestPriceOutlook, priceTrend, resolveStateName} from '../../services/price-series';
import {stageTimeline} from '../../services/today/stage-timeline';
import {currentCycle, harvestMidpoint, productIdentity} from '../../services/today/view';
import {OUTLOOK_NOTE_JOB_TYPE, OUTLOOK_TREND_MONTHS, ensureOutlookNote, outlookFacts, writeOutlookNote} from '../../services/today/outlook-note';
import type {JobHandler} from '../main';

/** Job type for the harvest outlook note (ROUND2_SPEC.md 2.2). Registered by worker/handlers/index.ts (orchestrator). */
export {OUTLOOK_NOTE_JOB_TYPE};

export interface OutlookNoteHandlerDeps {
  config: Config;
  pool: Pool;
  budget: Budget;
  /** Tests inject a fake Meta provider; production builds a MetaProvider. */
  provider?: TextModelProvider | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Clock for the stored retryAfter (tests); default now. */
  now?: (() => Date) | undefined;
}

/** today.outlook-note (max_attempts 1): writes one pending farm_outlook_notes row. */
export const createOutlookNoteHandler = (deps: OutlookNoteHandlerDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return {status: 'cancelled', reason: 'owner_missing'};
  const {noteId} = z.object({noteId: z.uuid(), farmId: z.uuid()}).parse(job.payload);
  return writeOutlookNote(deps, noteId, job.owner_id, job.id, ctx.isCancelled);
};

/**
 * Daily monitor hook: rebuilds the outlook facts for the farm's current cycle from stored prices (no network) and
 * ensures a note for them (enqueues the job when the facts changed, within the hourly rule). Returns a short status for
 * the monitor result; never throws.
 */
export async function refreshOutlookNote(deps: {config: Config; pool: Pool}, ownerId: string, farmId: string, asOf: string): Promise<string> {
  try {
    const mode = deps.config.RUNTIME_MODE;
    if (mode !== 'live') return 'live_mode_required';
    const farm = await getFarm(deps.pool, ownerId, farmId);
    if (!farm) return 'farm_missing';
    const workspace = await getWorkspace(deps.pool, ownerId, farmId);
    const cycle = currentCycle(workspace);
    if (!cycle?.productId) return 'no_current_product';
    const stateName = resolveStateName(farm.location.stateCode);
    if (!stateName) return 'farm_state_unknown';
    const today = new Date(Date.parse(asOf) + 19_800_000).toISOString().slice(0, 10);
    const timeline = stageTimeline({
      cropId: cycle.cropId, productId: cycle.productId, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: cycle.establishmentDate ?? cycle.sowingDate,
      stateId: farm.location.stateCode, districtId: farm.location.districtId,
    });
    if (!timeline.harvest) return 'harvest_window_unknown';
    const product = await productIdentity(deps.pool, cycle);
    const productName = product?.productName ?? cycle.productName ?? cycle.productId;
    const outlook = await harvestPriceOutlook(deps.pool, mode, {productId: cycle.productId, stateName, districtName: farm.location.districtName, harvestDate: harvestMidpoint(timeline.harvest), asOf: today});
    const district = outlook.scope.level === 'district' ? farm.location.districtName : null;
    const trend = outlook.status === 'available' ? await priceTrend(deps.pool, mode, {productId: cycle.productId, stateName, districtName: district, months: OUTLOOK_TREND_MONTHS, asOf: today}).catch(() => null) : null;
    const facts = outlookFacts({productId: cycle.productId, productName, harvest: timeline.harvest, outlook, trend});
    if (!facts) return 'price_range_unavailable';
    const note = await ensureOutlookNote({pool: deps.pool, config: deps.config, now: () => new Date(asOf)}, {ownerId, farmId, facts, productName, districtName: farm.location.districtName, stateName});
    return note.status === 'pending' ? 'queued' : `ready_${note.origin ?? 'unknown'}`;
  } catch {
    return 'refresh_failed';
  }
}
