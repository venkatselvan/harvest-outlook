import { z } from "zod";

const factOut = z.object({
  id: z.string(),
  entryId: z.string(),
  field: z.string(),
  kind: z.enum(["original", "proposed", "confirmed"]),
  source: z.enum(["farmer", "ai"]),
  status: z.enum(["proposed", "confirmed", "rejected", "recorded"]),
  value: z.unknown(),
  unit: z.string().nullable(),
  requiresConfirmation: z.boolean(),
  evidenceState: z.enum(["farmer_reported", "derived", "illustrative"]),
  confirmedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  supersedesId: z.string().nullable(),
  analysisId: z.string().nullable(),
  planMapped: z.boolean(),
  label: z.string().nullable(),
});

const analysisOut = z.object({
  id: z.string(),
  jobId: z.string().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed", "unavailable"]),
  errorCode: z.string().nullable(),
  provenance: z.enum(["meta_live", "synthetic_fixture"]).nullable(),
  model: z.string().nullable(),
  label: z.string(),
  aiNarrative: z.object({ text: z.string(), evidenceState: z.enum(["derived", "illustrative"]), label: z.string() }).nullable(),
  visibleObservations: z.array(z.string()),
  competingInterpretations: z.array(z.object({ label: z.string(), rationale: z.string() })),
  missingContext: z.array(z.string()),
  imageQualityIssues: z.array(z.string()),
  requestAnotherAngle: z.boolean(),
  gateIssues: z.array(z.object({ code: z.string(), detail: z.string() })),
  createdAt: z.string(),
});

export const entryOutSchema = z.object({
  id: z.string(),
  clientEntryId: z.string().nullable(),
  farmId: z.string(),
  planId: z.string().nullable(),
  mode: z.enum(["live", "replay", "synthetic"]),
  version: z.number().int(),
  status: z.enum(["draft", "final"]),
  observedOn: z.string(),
  observedAt: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  mediaIds: z.array(z.string()),
  media: z.array(z.object({ id: z.string(), contentPath: z.string(), label: z.string() })),
  note: z.string().nullable(),
  language: z.string().nullable(),
  activity: z.string().nullable(),
  quantity: z.object({ value: z.number(), unit: z.string() }).nullable(),
  expense: z.object({ amountInr: z.string(), category: z.string() }).nullable(),
  processingStatus: z.enum(["draft", "submitted", "processing", "ready", "failed"]),
  imageQuality: z.unknown(),
  facts: z.array(factOut),
  analysis: analysisOut.nullable(),
  provenanceLabel: z.string(),
});

const revisionOut = z.object({
  id: z.string(),
  entryId: z.string(),
  fromPlanId: z.string(),
  toPlanId: z.string(),
  factIds: z.array(z.string()),
  changes: z.array(z.unknown()),
  changeSummary: z.unknown(),
  createdAt: z.string(),
});

export const createEntryOut = z.object({ entry: entryOutSchema });
export const analysisQueuedOut = z.object({ jobId: z.string().nullable(), analysisId: z.string(), state: z.string(), deduplicated: z.boolean() });
export const confirmOut = z.object({
  entry: entryOutSchema,
  revision: revisionOut.extend({ newContentHash: z.string(), snapshot: z.unknown() }).nullable(),
});
export const previewOut = z.object({
  planChanging: z.boolean(),
  changes: z.array(z.unknown()),
  recompute: z.array(z.string()),
  planContentHash: z.string().nullable(),
  preview: z.object({ changeSummary: z.unknown(), note: z.string() }).nullable(),
});
export const timelineOut = z.object({
  farmId: z.string(),
  currentPlan: z.object({ id: z.string(), contentHash: z.string(), cropId: z.string(), stages: z.array(z.object({ stageId: z.string(), name: z.string() })) }).nullable(),
  entries: z.array(entryOutSchema),
  completedTasks: z.array(z.object({ taskId: z.string(), completedOn: z.string(), entryId: z.string(), planId: z.string() })),
  revisions: z.array(revisionOut),
});
export const taskCompletionOut = z.object({ taskId: z.string(), completedOn: z.string(), entryId: z.string(), planId: z.string() });
