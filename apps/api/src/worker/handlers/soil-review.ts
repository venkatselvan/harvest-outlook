import { z } from 'zod';
import { generateSoilReview, SOIL_REVIEW_JOB_TYPE, type SoilReviewDeps } from '../../services/soil-review';
import type { JobHandler } from '../main';

export { SOIL_REVIEW_JOB_TYPE };

/** Job type farm.soil-review (max_attempts 1). Not registered here; worker/handlers/index.ts owns registration. */
export const createSoilReviewHandler = (deps: SoilReviewDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return { status: 'cancelled', reason: 'owner_missing' };
  const { reviewId } = z.object({ reviewId: z.uuid() }).passthrough().parse(job.payload);
  return generateSoilReview(deps, reviewId, job.owner_id, ctx.isCancelled);
};
