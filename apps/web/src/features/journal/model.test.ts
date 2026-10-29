import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  canSubmit,
  changeLines,
  clearDraft,
  draftIssues,
  draftToBody,
  economicLines,
  idempotencyKeyFor,
  initialProposal,
  isFinalProposal,
  loadCurrentDraft,
  newDraft,
  proposalReducer,
  saveDraft,
  type Draft,
  type ProposalEvent,
  type ProposalState,
} from "./model";

const TODAY = "2026-06-10";
const base = (over: Partial<Draft> = {}): Draft => ({ ...newDraft("farm-1", "entry-abc12345", TODAY), ...over });

describe("draft persistence", () => {
  it("survives a reload: a new store instance over the same backing data returns the draft", async () => {
    const backing = new Map<string, unknown>();
    await saveDraft(new MemoryStore(backing), base({ note: "water near rows", mediaIds: ["m1"], quantityValue: "40" }), 1000);
    const reloaded = await loadCurrentDraft(new MemoryStore(backing), "farm-1");
    expect(reloaded).toMatchObject({ clientEntryId: "entry-abc12345", note: "water near rows", mediaIds: ["m1"], quantityValue: "40", updatedAt: 1000 });
  });

  it("keeps drafts of different farms apart and ignores a damaged record", async () => {
    const store = new MemoryStore();
    await saveDraft(store, base());
    expect(await loadCurrentDraft(store, "farm-2")).toBeNull();
    await store.set("draft:entry-abc12345", { nonsense: true });
    expect(await loadCurrentDraft(store, "farm-1")).toBeNull();
  });

  it("is cleared only on request, and a later draft is not removed by clearing an older one", async () => {
    const store = new MemoryStore();
    const first = base();
    await saveDraft(store, first);
    const second = base({ clientEntryId: "entry-second99" });
    await saveDraft(store, second);
    await clearDraft(store, first);
    expect((await loadCurrentDraft(store, "farm-1"))?.clientEntryId).toBe("entry-second99");
    await clearDraft(store, second);
    expect(await loadCurrentDraft(store, "farm-1")).toBeNull();
  });

  it("the client entry id and Idempotency-Key stay the same across retries of the same draft", () => {
    const d = base();
    expect(draftToBody(d).clientEntryId).toBe(draftToBody({ ...d, note: "more" }).clientEntryId);
    expect(idempotencyKeyFor(d)).toBe(idempotencyKeyFor({ ...d }));
    expect(idempotencyKeyFor(d)).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
});

describe("draft validation and request body", () => {
  it("refuses an empty draft, a future date, a bad quantity and a bad expense", () => {
    expect(draftIssues(base(), TODAY).map((i) => i.field)).toEqual(["empty"]);
    expect(canSubmit(base({ note: "x" }), TODAY)).toBe(true);
    expect(draftIssues(base({ note: "x", observedOn: "2026-06-11" }), TODAY).map((i) => i.field)).toContain("observedOn");
    expect(draftIssues(base({ note: "x", quantityValue: "abc" }), TODAY).map((i) => i.field)).toContain("quantity");
    expect(draftIssues(base({ note: "x", quantityValue: "0" }), TODAY).map((i) => i.field)).toContain("quantity");
    for (const bad of ["12.345", "-5", "1e3", "₹5", "007"]) expect(draftIssues(base({ note: "x", expenseInr: bad }), TODAY).map((i) => i.field), bad).toContain("expense");
    expect(draftIssues(base({ expenseInr: "250.50" }), TODAY)).toEqual([]);
  });

  it("builds the server body with only what the farmer entered and keeps the money as text", () => {
    const body = draftToBody(base({ note: " Water near rows ", quantityValue: "40", quantityUnit: "L", expenseInr: "250", expenseCategory: "labour", mediaIds: ["m1"], stageId: "vegetative" }));
    expect(body).toEqual({
      clientEntryId: "entry-abc12345",
      farmId: "farm-1",
      observedOn: TODAY,
      language: "en",
      mediaIds: ["m1"],
      note: "Water near rows",
      activity: "observation",
      quantity: { value: 40, unit: "L" },
      expense: { amountInr: "250", category: "labour" },
      stageId: "vegetative",
    });
    const minimal = draftToBody(base({ note: "x" }));
    expect(minimal).not.toHaveProperty("quantity");
    expect(minimal).not.toHaveProperty("expense");
    expect(minimal).not.toHaveProperty("stageId");
  });
});

describe("proposal state machine", () => {
  const run = (events: ProposalEvent[], from: ProposalState = initialProposal) => events.reduce(proposalReducer, from);

  it("a plan-changing accept waits for an explicit confirmation and sends nothing before it", () => {
    const reviewing = run([{ type: "accept", planChanging: true }]);
    expect(reviewing.status).toBe("reviewing");
    // 'saved' without a request in flight is ignored: a proposal cannot confirm itself.
    expect(proposalReducer(reviewing, { type: "saved", decision: "accept" }).status).toBe("reviewing");
    expect(run([{ type: "cancel_review" }], reviewing).status).toBe("pending");
    const saving = proposalReducer(reviewing, { type: "confirm_plan_change" });
    expect(saving).toMatchObject({ status: "saving", decision: "accept" });
    expect(proposalReducer(saving, { type: "saved", decision: "accept" }).status).toBe("confirmed");
  });

  it("a routine accept and a reject send at once; reject is possible from the review step", () => {
    expect(run([{ type: "accept", planChanging: false }]).status).toBe("saving");
    expect(run([{ type: "reject" }]).status).toBe("saving");
    expect(run([{ type: "accept", planChanging: true }, { type: "reject" }]).status).toBe("saving");
    expect(run([{ type: "reject" }, { type: "saved", decision: "reject" }]).status).toBe("rejected");
  });

  it("decisions are final and cannot be reopened or repeated", () => {
    for (const s of [run([{ type: "accept", planChanging: false }, { type: "saved", decision: "accept" }]), run([{ type: "reject" }, { type: "saved", decision: "reject" }])]) {
      expect(isFinalProposal(s)).toBe(true);
      for (const e of [{ type: "accept", planChanging: true }, { type: "reject" }, { type: "confirm_plan_change" }, { type: "retry" }, { type: "cancel_review" }] as ProposalEvent[]) expect(proposalReducer(s, e)).toBe(s);
    }
  });

  it("a version conflict marks the proposal stale; other failures allow a retry", () => {
    const saving = run([{ type: "accept", planChanging: false }]);
    const stale = proposalReducer(saving, { type: "failed", code: "version_conflict", message: "changed" });
    expect(stale).toMatchObject({ status: "stale", error: "changed" });
    expect(proposalReducer(stale, { type: "retry" }).status).toBe("stale");
    const failed = proposalReducer(saving, { type: "failed", code: "network_error", message: "offline" });
    expect(failed.status).toBe("error");
    expect(proposalReducer(failed, { type: "retry" })).toEqual(initialProposal);
  });
});

describe("why this changed", () => {
  const input = (key: string, value: unknown, validFrom: string | null = null) => ({ key, value: { value, validFrom } });
  it("reads old and new values for each typed change from the engine summary", () => {
    const names = { vegetative: "Vegetative (synthetic)" };
    const lines = changeLines(
      [
        { type: "observed_stage", stageId: "vegetative", observedOn: "2026-06-10" },
        { type: "irrigation_category", category: "irrigated" },
        { type: "planting_date", date: "2026-05-20" },
      ],
      [input("irrigation_category", "rainfed"), input("planting_date", "2026-05-15")],
      [input("irrigation_category", "irrigated")],
      names,
    );
    expect(lines[0]).toEqual({ label: "Stage on 2026-06-10 (you confirmed)", from: "calendar estimate", to: "Vegetative (synthetic)" });
    expect(lines[1]).toEqual({ label: "Water", from: "Rain only", to: "Irrigated" });
    expect(lines[2]).toEqual({ label: "Planting date", from: "2026-05-15", to: "2026-05-20" });
  });

  it("formats money deltas only where the engine produced both values", () => {
    const lines = economicLines({
      economicDelta: [
        { priceSource: "forecast", scenario: "central", netCashReturnInrPerHa: { old: "100000.00", new: "90000.00", delta: "-10000.00" }, breakEvenPriceInrPerKg: { old: "10.00", new: "11.00", delta: "1.00" } },
        { priceSource: "none", scenario: "central", netCashReturnInrPerHa: { old: null, new: null, delta: null }, breakEvenPriceInrPerKg: { old: "10.00", new: "11.00", delta: "1.00" } },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1,00,000/);
  });
});

describe("plan-change confirm gate (M1)", () => {
  it("Confirm needs a computed preview: a failed preview must not enable it", async () => {
    const { canConfirmPlanChange } = await import("./model");
    expect(canConfirmPlanChange(null, null)).toBe(false); // still calculating
    expect(canConfirmPlanChange(null, "Could not prepare the preview.")).toBe(false); // the old code enabled this
    expect(canConfirmPlanChange({ changes: [] }, null)).toBe(true);
    expect(canConfirmPlanChange({ changes: [] }, "stale error")).toBe(false);
  });
});

describe("scoped draft store (M2)", () => {
  it("a draft written under one owner scope is unreachable under another", async () => {
    const { scopedStore } = await import("./model");
    const base = new MemoryStore();
    let scope = "a";
    const s = scopedStore(base, () => scope);
    await s.set("draft:x", { v: 1 });
    expect(await s.get("draft:x")).toEqual({ v: 1 });
    scope = "b";
    expect(await s.get("draft:x")).toBeUndefined();
    expect([...base.map.keys()]).toEqual(["s:a:draft:x"]);
  });
});
