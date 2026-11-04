import { z } from 'zod';
import { OverviewFact, OverviewPoint } from './today';
export const FarmSummary = z.object({
  farmId: z.uuid(),
  scope: z.literal('farm'),
  status: z.enum(['ready', 'pending', 'unavailable']),
  origin: z.enum(['model', 'deterministic']),
  headline: z.string().max(160),
  points: z.array(OverviewPoint).max(3),
  facts: z.array(OverviewFact).max(16),
  asOf: z.iso.datetime(),
  generatedAt: z.iso.datetime().nullable(),
  canGenerate: z.boolean(),
  retryAfter: z.iso.datetime().nullable()
}).strict();
export type FarmSummary = z.infer<typeof FarmSummary>;
