import { z } from 'zod';
import type { OverviewWriteDeps } from '../../services/today/overview';
import { FARM_SUMMARY_JOB, writeFarmSummary } from '../../services/farm-summary';
import type { JobHandler } from '../main';
export { FARM_SUMMARY_JOB };
export const createFarmSummaryHandler = (deps: OverviewWriteDeps): JobHandler => async (job, ctx) => {
  if (!job.owner_id) return {
    status: 'cancelled'
  };
  const {
    summaryId
  } = z.object({
    summaryId: z.uuid(),
    farmId: z.uuid()
  }).strict().parse(job.payload);
  return writeFarmSummary(deps, summaryId, job.owner_id, job.id, ctx.isCancelled);
};
