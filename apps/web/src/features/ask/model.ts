import { ApiError } from "../../lib/api";

/**
 * Request/response shapes mirror apps/api/src/routes/schemas/assistant.ts (turnBody/turnOut) as read during INT3.
 * If F5 renames fields, update this file and docs/ASK_UI.md together.
 */
export type AskLanguage = "en" | "ta" | "hi";
export interface TurnRequest {
  text: string;
  language: AskLanguage;
  farmId?: string;
  planId?: string;
  selectedDate?: string;
}
export interface AnswerBlock {
  id: string;
  kind: "text" | "numeric" | "warning" | "limitation" | "evidence";
  text: string;
  numericRefIds: string[];
  claimIds: string[];
}
export interface NumericRefView {
  id: string;
  toolResultId: string;
  jsonPointer: string;
  presentation: { unit: string };
}
export interface TurnResult {
  status: "approved" | "partial" | "incomplete" | "provider_unavailable" | "budget_exceeded" | "cancelled" | "failed";
  provenance: "meta_live" | "synthetic_fixture";
  traceId: string;
  intent: string | null;
  language: string;
  gateStatus: "approved" | "partial" | "correction_requested" | "unverified" | null;
  answerBlocks: AnswerBlock[];
  numericRefs: NumericRefView[];
  claimEvidenceRefs: { claimId: string; text: string; evidenceIds: string[] }[];
  clarifications: { id: string; question: string; field: string | null; options: string[] }[];
  approvedText: string | null;
  approvedTextHash: string | null;
  limitations: string[];
  incomplete: { reasons: string[] } | null;
  costEstimate: { estimatedUsd: number; settledUsd: number; providerCalls: number; billable: boolean; basis: "estimated_not_billed" };
}

export const provenanceLabel = (p: TurnResult["provenance"]): string =>
  p === "synthetic_fixture" ? "Synthetic fixture: recorded example, not a live model" : "Meta model, live";

/** True when the output gate removed or corrected anything: the farmer must be told the shown answer is partial. */
export function wasWithheld(t: TurnResult): boolean {
  return t.gateStatus === "partial" || t.gateStatus === "correction_requested" || t.gateStatus === "unverified" || t.status === "partial" || t.status === "incomplete" || (t.incomplete?.reasons.length ?? 0) > 0;
}

export const WITHHELD_NOTICE = "Part of this answer was withheld or corrected because it could not be checked against the app's data. Only checked statements are shown.";

export function costLabel(c: TurnResult["costEstimate"]): string {
  return `Cost estimate: about $${c.estimatedUsd.toFixed(4)} (estimated, not billed)`;
}

/** Plain-language message and whether the farmer can retry, for each failure the assistant route can return. */
export function askErrorMessage(e: unknown): { message: string; retryable: boolean } {
  if (e instanceof ApiError) {
    if (e.status === 424 || e.status === 503 || e.code === "provider_unavailable") return { message: "Assistant unavailable in this mode; browse Explore.", retryable: false };
    if (e.status === 429 && e.code === "budget_exceeded") return { message: `The spending limit would be exceeded, so this question was not sent. ${e.message}. Try again later, or browse Explore.`, retryable: false };
    if (e.status === 429) return { message: "Too many questions in a short time. Wait a minute and try again.", retryable: true };
    if (e.status === 404) return { message: "Your saved farm or plan was not found. Turn off the context option and ask again.", retryable: false };
    if (e.status === 0 || e.code === "network_error") return { message: "Could not reach the server. Check your connection and try again.", retryable: true };
    return { message: `The assistant could not answer (${e.message}).`, retryable: e.status >= 500 };
  }
  return { message: "Something went wrong. Try again.", retryable: true };
}

/** Text for a follow-up turn after a clarification: keeps the original question so a stateless server can interpret the reply. */
export function clarificationFollowUp(original: string, question: string, reply: string): string {
  const text = `Earlier question: ${original}\nClarification asked: ${question}\nMy answer: ${reply}`;
  return text.length <= 2000 ? text : reply.slice(0, 2000);
}
