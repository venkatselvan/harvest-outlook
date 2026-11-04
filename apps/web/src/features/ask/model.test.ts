import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { evaraTreeFixture } from "../../workspace/evara/fixtures";
import { ASSISTANT_PROMPTS, askErrorMessage, assistantWelcomeText, clarificationFollowUp, turnAnswerText, turnUi, wasWithheld, type TurnResult } from "./model";

const base: TurnResult = {
  status: "approved", provenance: "synthetic_fixture", traceId: "t", intent: null, language: "en", gateStatus: "approved", answerBlocks: [], numericRefs: [], claimEvidenceRefs: [],
  clarifications: [], approvedText: null, approvedTextHash: null, limitations: [], incomplete: null,
  costEstimate: { estimatedUsd: 0, settledUsd: 0, providerCalls: 0, billable: false, basis: "estimated_not_billed" },
};

describe("withheld notice", () => {
  it("shows for every gate outcome that removed or corrected content, not for a clean approval", () => {
    expect(wasWithheld(base)).toBe(false);
    for (const g of ["partial", "correction_requested", "unverified"] as const) expect(wasWithheld({ ...base, gateStatus: g })).toBe(true);
    expect(wasWithheld({ ...base, status: "incomplete" })).toBe(true);
    expect(wasWithheld({ ...base, incomplete: { reasons: ["unsupported number"] } })).toBe(true);
  });
});

describe("error messages", () => {
  it("maps provider unavailability (424 or 503) to the Explore pointer and never offers a retry", () => {
    for (const status of [424, 503]) {
      const m = askErrorMessage(new ApiError("provider_unavailable", "x", status));
      expect(m.message).toBe("Assistant unavailable in this mode; browse Explore.");
      expect(m.retryable).toBe(false);
    }
  });
  it("distinguishes budget_exceeded (carries the server's limit text, no retry) from a rate limit (retry)", () => {
    const b = askErrorMessage(new ApiError("budget_exceeded", "The spending limit would be exceeded", 429));
    expect(b.message).toContain("spending limit");
    expect(b.retryable).toBe(false);
    expect(askErrorMessage(new ApiError("rate_limited", "x", 429)).retryable).toBe(true);
  });
  it.each(["", "per-session ", "per-owner daily ", "per-network daily ", "global development "])("names the %sbudget cap once without claiming no calls were made or that waiting will reset it", (scope) => {
    const reason = `The ${scope}spending limit would be exceeded`;
    for (const ending of ["", "."]) {
      const result = askErrorMessage(new ApiError("budget_exceeded", reason + ending, 429));
      expect(result.message).toBe(`${reason}. Evara stopped before completing this answer. You can still browse Explore.`);
      expect(result.retryable).toBe(false);
    }
  });
});

describe("clarification follow-up", () => {
  it("keeps the earlier question for a stateless server and stays within the 2000 character body limit", () => {
    expect(clarificationFollowUp("When to plant?", "Which district?", "Hassan")).toContain("When to plant?");
    expect(clarificationFollowUp("q".repeat(1990), "Which?", "x".repeat(50)).length).toBeLessThanOrEqual(2000);
  });
});

describe("Evara panel copy", () => {
  it("welcome names the farm and what Evara will check, without claiming it can see it; without a farm it keeps the boundary text", () => {
    const withFarm = assistantWelcomeText("Green Acre");
    expect(withFarm).toContain("Green Acre");
    for (const part of ["crop and stage", "weather", "satellite greenness", "alerts", "upcoming steps", "prices and expected returns", "soil report", "plans and journal"]) expect(withFarm).toContain(part);
    expect(withFarm).toContain("wherever they are recorded");
    expect(withFarm).not.toMatch(/I can see|farm boundary/);
    for (const none of [null, undefined, "  "]) expect(assistantWelcomeText(none)).toMatch(/^Finish your farm boundary/);
  });
  it("lists the 15-day care prompt first", () => {
    expect(ASSISTANT_PROMPTS[0]).toBe("How should I care for my crop in the next 15 days?");
    expect(ASSISTANT_PROMPTS.length).toBe(5);
  });
  it("offers the ginger growth journey as the last welcome prompt", () => {
    expect(ASSISTANT_PROMPTS[4]).toBe("Show me how ginger would grow here");
  });
  it("a failed empty turn shows the reference, with the ran-out-of-room sentence only for max_output_tokens", () => {
    const failed: TurnResult = { ...base, status: "failed", traceId: "tr_9", gateStatus: null, incomplete: { reasons: ["provider_error"] } };
    expect(turnAnswerText(failed)).toBe("I couldn't finish writing that answer (reference tr_9). Please ask again.");
    expect(turnAnswerText({ ...failed, incomplete: { reasons: ["max_output_tokens"] } })).toBe("I couldn't finish writing that answer (reference tr_9). Please ask again. The answer ran out of room.");
    expect(turnAnswerText({ ...failed, incomplete: null })).toBe("I couldn't finish writing that answer (reference tr_9). Please ask again.");
  });
  it("keeps the generic line for other empty results, and prefers blocks and clarifications over the failure line", () => {
    expect(turnAnswerText({ ...base, status: "incomplete" })).toBe("I couldn't produce a checked answer from the available information.");
    const clar = { id: "c", question: "Which plot?", field: null, options: [] };
    expect(turnAnswerText({ ...base, status: "failed", clarifications: [clar] })).toBe("Which plot?");
    const block = { text: "Irrigate lightly." } as TurnResult["answerBlocks"][number];
    expect(turnAnswerText({ ...base, status: "failed", answerBlocks: [block], clarifications: [clar] })).toBe("Irrigate lightly.");
  });
});

describe("the turn's UI tree", () => {
  it("passes a tree the kit contract accepts, and reads null for a turn without one (older server, stored message, error)", () => {
    const ui = evaraTreeFixture();
    expect(turnUi(ui)).toEqual(ui);
    expect(turnUi(null)).toBeNull();
    expect(turnUi(undefined)).toBeNull();
  });
  it("drops a malformed or stale tree instead of letting the renderer meet it: an unknown node, a wrong version, a prose-free text node", () => {
    const ui = evaraTreeFixture();
    expect(turnUi({ ...ui, version: "2" })).toBeNull();
    expect(turnUi({ ...ui, root: { type: "carousel", children: [] } })).toBeNull();
    expect(turnUi({ ...ui, root: { type: "text", blockId: "b", kind: "text", text: "" } })).toBeNull();
    expect(turnUi("<script>")).toBeNull();
  });
  it("leaves the text path alone: a turn with a tree still has its answer text for speech, storage and the next question's context", () => {
    const withUi: TurnResult = { ...base, ui: evaraTreeFixture(), answerBlocks: [{ id: "b1", kind: "text", text: "Three crops could follow paddy.", numericRefIds: [], claimIds: [] }] };
    expect(turnAnswerText(withUi)).toBe("Three crops could follow paddy.");
    expect(turnAnswerText({ ...withUi, ui: null })).toBe("Three crops could follow paddy.");
  });
});
