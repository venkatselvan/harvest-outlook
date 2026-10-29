import { apiRequest, jsonInit } from "../photo-region/http";
import { ApiError } from "../../lib/api";
import { idempotencyKeyFor, type ChangeSummaryLike, type Draft } from "./model";
import { draftToBody } from "./model";

export interface JournalFact {
  id: string;
  entryId: string;
  field: string;
  kind: "original" | "proposed" | "confirmed";
  source: "farmer" | "ai";
  status: "proposed" | "confirmed" | "rejected" | "recorded";
  value: unknown;
  unit: string | null;
  requiresConfirmation: boolean;
  evidenceState: "farmer_reported" | "derived" | "illustrative";
  confirmedAt: string | null;
  supersedesId: string | null;
  analysisId: string | null;
  planMapped: boolean;
  label: string | null;
}

export interface JournalAnalysis {
  id: string;
  jobId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "unavailable";
  errorCode: string | null;
  provenance: "meta_live" | "synthetic_fixture" | null;
  label: string;
  aiNarrative: { text: string; evidenceState: string; label: string } | null;
  visibleObservations: string[];
  competingInterpretations: { label: string; rationale: string }[];
  missingContext: string[];
  imageQualityIssues: string[];
  requestAnotherAngle: boolean;
}

export interface JournalEntry {
  id: string;
  farmId: string;
  planId: string | null;
  version: number;
  observedOn: string;
  media: { id: string; contentPath: string; label: string }[];
  note: string | null;
  activity: string | null;
  quantity: { value: number; unit: string } | null;
  expense: { amountInr: string; category: string } | null;
  processingStatus: "draft" | "submitted" | "processing" | "ready" | "failed";
  imageQuality: { issues: string[] } | null;
  facts: JournalFact[];
  analysis: JournalAnalysis | null;
  provenanceLabel: string;
}

export interface JournalRevision {
  id: string;
  entryId: string;
  fromPlanId: string;
  toPlanId: string;
  changes: ChangeSummaryLike["changes"];
  changeSummary: ChangeSummaryLike | null;
  createdAt: string;
}

export interface Timeline {
  farmId: string;
  currentPlan: { id: string; contentHash: string; cropId: string; stages: { stageId: string; name: string }[] } | null;
  entries: JournalEntry[];
  completedTasks: { taskId: string; completedOn: string; entryId: string }[];
  revisions: JournalRevision[];
}

export interface Preview {
  planChanging: boolean;
  changes: ChangeSummaryLike["changes"];
  recompute: string[];
  planContentHash: string | null;
  preview: { changeSummary: ChangeSummaryLike | null; note: string } | null;
}

export const loadTimeline = async (farmId: string): Promise<Timeline> => (await apiRequest<Timeline>(`/api/v1/farms/${farmId}/journal`)).data!;
export const loadEntry = async (id: string): Promise<JournalEntry> => (await apiRequest<{ entry: JournalEntry }>(`/api/v1/journal/${id}`)).data!.entry;

export async function submitDraft(d: Draft): Promise<JournalEntry> {
  const env = await apiRequest<{ entry: JournalEntry }>("/api/v1/journal", jsonInit("POST", draftToBody(d), { "idempotency-key": idempotencyKeyFor(d) }));
  return env.data!.entry;
}

export async function requestAnalysis(entryId: string): Promise<{ jobId: string | null; analysisId: string; state: string }> {
  return (await apiRequest<{ jobId: string | null; analysisId: string; state: string }>(`/api/v1/journal/${entryId}/analysis`, { method: "POST" })).data!;
}

interface JobView {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}

/** Polls the job until it ends. Resolves with the final state; rejects only on transport errors or timeout. */
export async function waitForJob(jobId: string, opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<JobView["state"]> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (opts.signal?.aborted) throw new ApiError("client_cancelled", "Cancelled", 0);
    const job = (await apiRequest<JobView>(`/api/v1/jobs/${jobId}`)).data!;
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") return job.state;
    if (Date.now() > deadline) throw new ApiError("timeout", "The analysis is taking longer than expected. It keeps running; check back in a moment.", 0);
    await sleep(interval);
  }
}

export const previewRevision = async (entryId: string, factIds: string[]): Promise<Preview> => (await apiRequest<Preview>(`/api/v1/journal/${entryId}/revision-preview`, jsonInit("POST", { factIds }))).data!;

export interface ConfirmResult {
  entry: JournalEntry;
  revision: (JournalRevision & { newContentHash: string }) | null;
}
export async function confirmFacts(entryId: string, body: { expectedVersion: number; accept?: string[]; reject?: string[]; expectedPlanContentHash?: string }): Promise<ConfirmResult> {
  return (await apiRequest<ConfirmResult>(`/api/v1/journal/${entryId}/confirmations`, jsonInit("POST", body))).data!;
}

export function analysisFailureMessage(code: string | null): string {
  switch (code) {
    case "provider_unavailable":
      return "AI analysis is not available right now. Your entry is saved exactly as you entered it.";
    case "budget_exceeded":
      return "The analysis allowance is used up for now. Your entry is saved; try again later.";
    case "capability_unavailable":
      return "Photo analysis is not available in this mode. Your entry is saved.";
    case "provider_bad_response":
      return "The AI answer could not be used, so nothing was proposed. Your entry is saved. You can try again.";
    default:
      return "The analysis did not finish. Your entry is saved. You can try again.";
  }
}
