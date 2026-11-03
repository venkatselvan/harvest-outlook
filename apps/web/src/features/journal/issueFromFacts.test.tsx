import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { ISSUE_PROPOSAL_LABEL, ISSUE_TITLE, issueFromFacts, issueHref, proposalLabel } from "./issueFromFacts";
import { CATEGORIES, newIssueDraft } from "../../workspace/scouting/scoutingModel";
import { EntryCard } from "./EntryCard";
import { ProposalItem } from "./ProposalItem";
import type { JournalEntry, JournalFact } from "./api";

/** "Log as an issue" (packet O2b): when the button shows and what it prefills. Invented ids and values. */
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fact = (over: Partial<JournalFact> & { id: string; field: string; value: unknown }): JournalFact => ({
  entryId: U(1),
  kind: "confirmed",
  source: "ai",
  status: "confirmed",
  unit: null,
  requiresConfirmation: false,
  evidenceState: "farmer_reported",
  confirmedAt: "2026-11-02T08:00:00Z",
  supersedesId: null,
  analysisId: U(9),
  planMapped: false,
  label: null,
  ...over,
});
const media = (n: number) => Array.from({ length: n }, (_, i) => ({ id: U(100 + i), contentPath: `/m/${i}`, label: `Photo ${i + 1}` }));
const entry = (facts: JournalFact[], over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: U(1),
  farmId: U(2),
  planId: null,
  version: 3,
  observedOn: "2026-10-30",
  media: media(2),
  note: null,
  activity: "observation",
  quantity: null,
  expense: null,
  processingStatus: "ready",
  imageQuality: null,
  facts,
  analysis: null,
  provenanceLabel: "Recorded by you",
  ...over,
});
const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const card = (e: JournalEntry, withCallback = true) =>
  html(() => <EntryCard entry={e} revisions={[]} plan={null} stageNames={{}} onEntry={() => undefined} onResult={() => undefined} onReload={() => undefined} onLogIssue={withCallback ? () => undefined : undefined} />);

describe("issueFromFacts", () => {
  it("prefills category, title, note, photos, date and the confirmed fact id", () => {
    const issue = fact({ id: U(10), field: "observed_issue", value: "pest" });
    const note = fact({ id: U(11), field: "observed_issue_note", value: "  Chewed leaf edges on several plants  " });
    expect(issueFromFacts(entry([issue, note]))).toEqual({
      category: "pest",
      title: "Pest damage seen",
      detail: "Chewed leaf edges on several plants",
      mediaIds: [U(100), U(101)],
      fromFactId: U(10),
      observedOn: "2026-10-30",
    });
  });

  it("is null for pending, rejected or absent issue facts, and for an unknown category", () => {
    const pending = fact({ id: U(10), field: "observed_issue", value: "pest", kind: "proposed", status: "proposed" });
    const rejected = fact({ id: U(10), field: "observed_issue", value: "pest", kind: "proposed", status: "rejected" });
    const original = fact({ id: U(10), field: "observed_issue", value: "pest", kind: "original", status: "recorded", source: "farmer" });
    expect(issueFromFacts(entry([pending]))).toBeNull();
    expect(issueFromFacts(entry([rejected]))).toBeNull();
    expect(issueFromFacts(entry([original]))).toBeNull();
    expect(issueFromFacts(entry([]))).toBeNull();
    expect(issueFromFacts(entry([fact({ id: U(10), field: "observed_issue", value: "locusts" })]))).toBeNull();
    expect(issueFromFacts(entry([fact({ id: U(11), field: "observed_stage", value: "flowering" })]))).toBeNull();
  });

  it("leaves the note out unless it was confirmed too", () => {
    const issue = fact({ id: U(10), field: "observed_issue", value: "weed" });
    const pendingNote = fact({ id: U(11), field: "observed_issue_note", value: "Weeds between rows", kind: "proposed", status: "proposed" });
    const rejectedNote = fact({ id: U(12), field: "observed_issue_note", value: "Weeds between rows", kind: "proposed", status: "rejected" });
    expect(issueFromFacts(entry([issue, pendingNote]))).not.toHaveProperty("detail");
    expect(issueFromFacts(entry([issue, rejectedNote]))).not.toHaveProperty("detail");
    expect(issueFromFacts(entry([issue, fact({ id: U(13), field: "observed_issue_note", value: "   " })]))).not.toHaveProperty("detail");
  });

  it("takes at most four photos and prefers the confirmed copy over the accepted proposal row", () => {
    const proposalRow = fact({ id: U(20), field: "observed_issue", value: "disease", kind: "proposed", status: "confirmed" });
    const copy = fact({ id: U(21), field: "observed_issue", value: "disease", supersedesId: U(20) });
    const prefill = issueFromFacts(entry([proposalRow, copy], { media: media(6) }));
    expect(prefill?.fromFactId).toBe(U(21));
    expect(prefill?.mediaIds).toEqual([U(100), U(101), U(102), U(103)]);
  });

  it("has a title for every category and the form draft takes the prefill (date capped at today)", () => {
    for (const c of CATEGORIES) expect(ISSUE_TITLE[c].length).toBeGreaterThan(0);
    const prefill = issueFromFacts(entry([fact({ id: U(10), field: "observed_issue", value: "water_stress" })]))!;
    const draft = newIssueDraft(U(2), "client-1", "2026-11-03", null, prefill);
    expect(draft).toMatchObject({ category: "water_stress", title: "Water stress seen", observedOn: "2026-10-30", fromFactId: U(10), mediaIds: [U(100), U(101)], severity: "" });
    expect(newIssueDraft(U(2), "client-1", "2026-10-01", null, prefill).observedOn).toBe("2026-10-01");
  });

  it("links to the Today issue sheet", () => {
    expect(issueHref(U(5))).toBe(`/farm?tab=today&issue=${U(5)}`);
  });
});

describe("proposal wording", () => {
  it("uses the issue wording for the two issue facts only", () => {
    const plan = "AI proposal — confirm before it changes your plan";
    expect(proposalLabel({ field: "observed_issue", source: "ai", label: plan })).toBe(ISSUE_PROPOSAL_LABEL);
    expect(proposalLabel({ field: "observed_issue_note", source: "ai", label: plan })).toBe(ISSUE_PROPOSAL_LABEL);
    expect(proposalLabel({ field: "observed_stage", source: "ai", label: plan })).toBe(plan);
    expect(proposalLabel({ field: "observed_stage", source: "farmer", label: "Your selection — confirm before it changes your plan" })).toBe("Your selection — confirm before it changes your plan");
  });

  it("renders it on the proposal row, and the plan wording on a plan fact", () => {
    const render = (f: JournalFact) =>
      html(() => <ProposalItem fact={f} entry={entry([f])} plan={null} stageNames={{}} onResult={() => undefined} onReload={() => undefined} />);
    const issue = render(fact({ id: U(10), field: "observed_issue", value: "water_stress", kind: "proposed", status: "proposed", label: "AI proposal — confirm before it changes your plan" }));
    expect(issue).toContain("AI suggestion — confirm before logging an issue");
    expect(issue).not.toContain("changes your plan");
    expect(issue).toContain("Water stress");
    const stage = render(fact({ id: U(11), field: "observed_stage", value: "flowering", kind: "proposed", status: "proposed", label: "AI proposal — confirm before it changes your plan" }));
    expect(stage).toContain("AI proposal — confirm before it changes your plan");
  });
});

describe("EntryCard button", () => {
  const issue = fact({ id: U(10), field: "observed_issue", value: "pest" });
  it("shows Log as an issue for a confirmed observed_issue", () => {
    expect(card(entry([issue]))).toContain("Log as an issue");
  });
  it("does not show it for a pending or rejected suggestion, or without the callback", () => {
    expect(card(entry([fact({ ...issue, kind: "proposed", status: "proposed" })]))).not.toContain("Log as an issue");
    expect(card(entry([fact({ ...issue, kind: "proposed", status: "rejected" })]))).not.toContain("Log as an issue");
    expect(card(entry([issue]), false)).not.toContain("Log as an issue");
  });
});
