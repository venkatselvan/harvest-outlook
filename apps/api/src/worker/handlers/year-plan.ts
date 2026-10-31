import { z } from 'zod';
import { generateYearPlan, type YearPlanDeps } from '../../services/year-plan/service';
import type { JobHandler } from '../main';

/** Job type farm.year-plan (max_attempts 1). Not registered here; worker/handlers/index.ts owns registration. */
export const createYearPlanHandler = (deps: YearPlanDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return { status: 'cancelled', reason: 'owner_missing' };
  const { reviewId } = z.object({ reviewId: z.uuid() }).parse(job.payload);
  return generateYearPlan(deps, reviewId, job.owner_id, ctx.isCancelled);
};
