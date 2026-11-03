import { CATEGORIES, CATEGORY_LABEL, MAX_PHOTOS, withIssueParam, type IssuePrefill } from "../../workspace/scouting/scoutingModel";
import type { JournalEntry, JournalFact } from "./api";

/*
 * "Log as an issue" (FIELD_OPERATIONS_SPEC.md 5.5, packet O2b): a journal entry whose AI-suggested `observed_issue` the
 * farmer has confirmed can open the issue form with what was confirmed already filled in. Pure functions; the components
 * only render what these return. The category and note are the farmer's confirmed observation, never a diagnosis.
 */

export const OBSERVED_ISSUE = "observed_issue";
export const OBSERVED_ISSUE_NOTE = "observed_issue_note";

export type IssueCategoryValue = (typeof CATEGORIES)[number];

/** One short observation line per category, used as the title of the prefilled issue (the farmer can edit it). */
export const ISSUE_TITLE: Record<IssueCategoryValue, string> = {
  pest: "Pest damage seen",
  disease: "Disease signs seen",
  weed: "Weeds seen",
  water_stress: "Water stress seen",
  nutrient: "Nutrient stress signs seen",
  weather_damage: "Weather damage seen",
  animal_damage: "Animal damage seen",
  other: "Issue seen",
};

export const ISSUE_PROPOSAL_LABEL = "AI suggestion — confirm before logging an issue";

export const isIssueField = (field: string) => field === OBSERVED_ISSUE || field === OBSERVED_ISSUE_NOTE;

/** The label above a proposal: the issue facts say what confirming does (it logs nothing by itself); plan facts keep theirs. */
export function proposalLabel(fact: Pick<JournalFact, "field" | "source" | "label">, fallback = "AI proposal — confirm before it changes your plan"): string {
  if (fact.source === "ai" && isIssueField(fact.field)) return ISSUE_PROPOSAL_LABEL;
  return fact.label ?? fallback;
}

/** What the proposal row shows for an issue fact: the category by name rather than its stored word. */
export function issueValueLabel(fact: Pick<JournalFact, "field" | "value">): string | null {
  if (fact.field === OBSERVED_ISSUE && typeof fact.value === "string") return CATEGORY_LABEL[fact.value as IssueCategoryValue] ?? fact.value;
  return null;
}

const isCategory = (value: unknown): value is IssueCategoryValue => typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
/** A fact the farmer accepted: the confirmed copy the server writes (kind "confirmed"), or an accepted proposal row. Pending, rejected and original facts do not count. */
const isAccepted = (f: JournalFact) => f.status === "confirmed" && (f.kind === "confirmed" || f.kind === "proposed");

/**
 * The prefill for the issue form from an entry, or null when no `observed_issue` was confirmed (so the button is not shown
 * for a pending or rejected suggestion, nor for an unknown category). The note is used only when it was confirmed too.
 * Photos are the entry's, at most four. The confirmed copy is preferred as the source fact; an accepted proposal is the fallback.
 */
export function issueFromFacts(entry: Pick<JournalEntry, "facts" | "media" | "observedOn">): IssuePrefill | null {
  const accepted = entry.facts.filter(isAccepted);
  const pick = (field: string) => accepted.find((f) => f.field === field && f.kind === "confirmed") ?? accepted.find((f) => f.field === field);
  const issue = pick(OBSERVED_ISSUE);
  if (!issue || !isCategory(issue.value)) return null;
  const note = pick(OBSERVED_ISSUE_NOTE);
  const detail = note && typeof note.value === "string" ? note.value.trim() : "";
  return {
    category: issue.value,
    title: ISSUE_TITLE[issue.value],
    ...(detail ? { detail } : {}),
    mediaIds: entry.media.slice(0, MAX_PHOTOS).map((m) => m.id),
    fromFactId: issue.id,
    observedOn: entry.observedOn,
  };
}

/** Today's issue sheet for one issue: the deep link the Today tab opens (`?issue=<id>`). */
export const issueHref = (issueId: string): string => withIssueParam("/farm", "?tab=today", issueId);
