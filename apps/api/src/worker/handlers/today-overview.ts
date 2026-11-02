import {z} from 'zod';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {Budget} from '../../services/budget';
import type {TextModelProvider} from '../../agent/provider';
import {TODAY_OVERVIEW_JOB_TYPE, writeTodayOverview} from '../../services/today/overview';
import type {JobHandler} from '../main';

/** Job type for the Today overview (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 9). Registered by worker/handlers/index.ts. */
export {TODAY_OVERVIEW_JOB_TYPE};

export interface TodayOverviewHandlerDeps {
  config: Config;
  pool: Pool;
  budget: Budget;
  /** Tests inject a fake Meta provider; production builds a MetaProvider. */
  provider?: TextModelProvider | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}

/** today.overview (max_attempts 1): writes one pending farm_today_overviews row. */
export const createTodayOverviewHandler = (deps: TodayOverviewHandlerDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return {status: 'cancelled', reason: 'owner_missing'};
  const {overviewId} = z.object({overviewId: z.uuid(), farmId: z.uuid()}).parse(job.payload);
  return writeTodayOverview(deps, overviewId, job.owner_id, job.id, ctx.isCancelled);
};
