import { ApiError } from "../../lib/api";
import type { Pt } from "../../lib/geometry";
import { MAX_POINTS, MIN_POINTS } from "../../lib/geometry";
import { apiRequest, jsonInit } from "./http";

export type SegmentPrompt = { kind: "concept"; text: string } | { kind: "box"; x0: number; y0: number; x1: number; y1: number } | { kind: "points"; points: { x: number; y: number; positive?: boolean }[] };

export interface JobView {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result: unknown;
}

export type SuggestionOutcome =
  | { kind: "proposal"; polygon: Pt[]; score: number | null; extra: number }
  | { kind: "unavailable"; reason: string; message: string }
  | { kind: "no_match"; message: string }
  | { kind: "failed"; message: string };

const UNAVAILABLE_TEXT: Record<string, string> = {
  synthetic_mode: "AI suggestion is turned off in synthetic mode.",
  replay_mode: "AI suggestion is turned off in replay mode.",
  provider_not_configured: "AI suggestion is not set up on this server.",
  budget_exceeded: "The AI suggestion allowance is used up for now.",
};

/** Turns a finished job into something the UI can show. Never invents a polygon. */
export function interpretJob(job: JobView): SuggestionOutcome {
  if (job.state === "failed" || job.state === "cancelled") return { kind: "failed", message: "The AI suggestion could not be completed." };
  const r = job.result as { status?: unknown; reason?: unknown; polygon?: unknown; segmentationScore?: unknown; proposals?: unknown } | null;
  if (!r || typeof r !== "object") return { kind: "failed", message: "The AI suggestion returned nothing usable." };
  if (r.status === "unavailable") {
    const reason = typeof r.reason === "string" ? r.reason : "unknown";
    return { kind: "unavailable", reason, message: UNAVAILABLE_TEXT[reason] ?? "AI suggestion is not available right now." };
  }
  if (r.status === "no_match") return { kind: "no_match", message: "The AI did not find a usable area in this photo." };
  if (r.status === "ok" && validPolygon(r.polygon)) {
    const score = typeof r.segmentationScore === "number" && r.segmentationScore >= 0 && r.segmentationScore <= 1 ? r.segmentationScore : null;
    return { kind: "proposal", polygon: (r.polygon as Pt[]).map(([x, y]) => [x, y] as Pt), score, extra: Array.isArray(r.proposals) ? Math.max(0, r.proposals.length - 1) : 0 };
  }
  return { kind: "failed", message: "The AI suggestion returned nothing usable." };
}

function validPolygon(p: unknown): p is Pt[] {
  return (
    Array.isArray(p) &&
    p.length >= MIN_POINTS &&
    p.length <= MAX_POINTS &&
    p.every((q) => Array.isArray(q) && q.length === 2 && q.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1))
  );
}

export async function requestSegmentation(mediaId: string, prompt: SegmentPrompt): Promise<{ jobId: string }> {
  const env = await apiRequest<{ jobId: string }>(`/api/v1/media/${mediaId}/segmentation`, jsonInit("POST", { prompt }));
  return { jobId: env.data!.jobId };
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchJob?: (jobId: string) => Promise<JobView>;
}

export async function fetchJob(jobId: string): Promise<JobView> {
  const env = await apiRequest<JobView>(`/api/v1/jobs/${jobId}`);
  return env.data!;
}

/** Polls GET /jobs/:id with gentle backoff until it finishes, is aborted, or times out (reported as failed). */
export async function pollSuggestion(jobId: string, o: PollOptions = {}): Promise<SuggestionOutcome | { kind: "aborted" }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const get = o.fetchJob ?? fetchJob;
  const deadline = now() + (o.timeoutMs ?? 60_000);
  let wait = o.intervalMs ?? 1000;
  let misses = 0;
  for (;;) {
    if (o.signal?.aborted) return { kind: "aborted" };
    try {
      const job = await get(jobId);
      misses = 0;
      if (job.state === "queued" || job.state === "running") {
        /* keep waiting */
      } else return interpretJob(job);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return { kind: "failed", message: "The AI suggestion could not be found." };
      if (++misses >= 3) return { kind: "failed", message: "Lost contact with the server while waiting for the AI suggestion." };
    }
    if (now() >= deadline) {
      return { kind: "failed", message: "The AI suggestion is taking too long. The background worker may not be running." };
    }
    await sleep(wait);
    wait = Math.min(wait * 1.5, 4000);
  }
}

export async function cancelSuggestion(jobId: string): Promise<void> {
  try {
    await apiRequest(`/api/v1/jobs/${jobId}/cancel`, { method: "POST" });
  } catch {
    /* already finished or unreachable: the UI has already stopped waiting */
  }
}
