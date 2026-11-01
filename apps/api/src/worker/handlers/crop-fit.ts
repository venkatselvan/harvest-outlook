import { z } from 'zod';
import { generateCropFit, type CropFitDeps } from '../../services/crop-fit/service';
import { CROP_FIT_JOB_TYPE } from '../../services/crop-fit/types';
import type { JobHandler } from '../main';

export { CROP_FIT_JOB_TYPE };

/** Job type farm.crop-fit (max_attempts 1). Not registered here; worker/handlers/index.ts owns registration. */
export const createCropFitHandler = (deps: CropFitDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return { status: 'cancelled', reason: 'owner_missing' };
  const { reviewId } = z.object({ reviewId: z.uuid() }).parse(job.payload);
  return generateCropFit(deps, reviewId, job.owner_id, ctx.isCancelled);
};
