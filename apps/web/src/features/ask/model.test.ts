import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { askErrorMessage, clarificationFollowUp, wasWithheld, type TurnResult } from "./model";

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
});

describe("clarification follow-up", () => {
  it("keeps the earlier question for a stateless server and stays within the 2000 character body limit", () => {
    expect(clarificationFollowUp("When to plant?", "Which district?", "Hassan")).toContain("When to plant?");
    expect(clarificationFollowUp("q".repeat(1990), "Which?", "x".repeat(50)).length).toBeLessThanOrEqual(2000);
  });
});
