import { EvaraUi as evaraUiSchema, type EvaraUi } from "@harvest/contracts";
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
  /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.5): the field selected in the shell; the server needs farmId with it. */
  fieldId?: string;
  planId?: string;
  selectedDate?: string;
}

/**
 * The Evara panel's turn body: the farm, the field selected in the shell (only together with the farm, which the server
 * requires) and the plan open on screen.
 */
export function assistantTurnBody(input: {
  text: string;
  language: AskLanguage;
  farmId?: string | null | undefined;
  fieldId?: string | null | undefined;
  planId?: string | null | undefined;
}): TurnRequest {
  return {
    text: input.text,
    language: input.language,
    ...(input.farmId ? { farmId: input.farmId } : {}),
    ...(input.farmId && input.fieldId ? { fieldId: input.fieldId } : {}),
    ...(input.planId ? { planId: input.planId } : {}),
  };
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
  /**
   * 2026-11-04 (docs/research/EVARA_ACTIONS_SPEC.md 2.1): the resolved Evara UI tree the panel renders beside the text. Null or
   * absent (older servers, stored messages, errors) = the panel shows the answer text.
   */
  ui?: EvaraUi | null;
}

/** The turn's UI tree when it is valid for the kit, else null: a malformed or stale tree never reaches the renderer, the text shows instead. */
export function turnUi(value: unknown): EvaraUi | null {
  if (value === null || value === undefined) return null;
  const parsed = evaraUiSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const provenanceLabel = (p: TurnResult["provenance"]): string =>
  p === "synthetic_fixture" ? "Synthetic fixture: recorded example, not a live model" : "Meta model, live";

/** True when the output gate removed or corrected anything: the farmer must be told the shown answer is partial. */
export function wasWithheld(t: TurnResult): boolean {
  return t.gateStatus === "partial" || t.gateStatus === "correction_requested" || t.gateStatus === "unverified" || t.status === "partial" || t.status === "incomplete" || (t.incomplete?.reasons.length ?? 0) > 0;
}

/** Welcome paragraph of the Evara panel: with a farm it names the farm and what Evara will check, wherever recorded (a bare farm may have none of it, and in replay mode no briefing is composed). */
export function assistantWelcomeText(farmName: string | null | undefined, fieldName?: string | null): string {
  const name = farmName?.trim();
  if (!name) return "Finish your farm boundary and I'll help prefill its location, name, and area. Review my suggestions, then let's plan what comes next.";
  const field = fieldName?.trim();
  return `I'm looking at ${name}${field ? `, about ${field}` : ""}. I'll check its crop and stage, weather, satellite greenness, alerts, upcoming steps, prices and expected returns, soil report, plans and journal, wherever they are recorded. What would you like to know?`;
}

export const ASSISTANT_PROMPTS = [
  "How should I care for my crop in the next 15 days?",
  "What should I plant next?",
  "Review my farm's weather and market outlook",
  "Help me compare crops for this season",
  "Show me how ginger would grow here",
] as const;

const NO_CHECKED_ANSWER = "I couldn't produce a checked answer from the available information.";

/** Text shown for an assistant turn: approved blocks, else clarification questions, else a failed-turn or generic line. */
export function turnAnswerText(t: TurnResult): string {
  const blocks = t.answerBlocks.map((b) => b.text).join("\n\n");
  if (blocks) return blocks;
  const questions = t.clarifications.map((c) => c.question).join("\n");
  if (questions) return questions;
  if (t.status === "failed") {
    const base = `I couldn't finish writing that answer (reference ${t.traceId}). Please ask again.`;
    return t.incomplete?.reasons.includes("max_output_tokens") ? `${base} The answer ran out of room.` : base;
  }
  return NO_CHECKED_ANSWER;
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
