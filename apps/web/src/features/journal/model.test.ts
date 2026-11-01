import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  POST_HARVEST_WINDOW_DAYS,
  amountsOutsideCycles,
  canSubmit,
  changeLines,
  clearDraft,
  draftIssues,
  draftToBody,
  economicLines,
  formatKg,
  formatRupees,
  idempotencyKeyFor,
  initialProposal,
  isFinalProposal,
  loadCurrentDraft,
  newDraft,
  proposalReducer,
  saveDraft,
  seasonTotals,
  toPaise,
  type Draft,
  type SeasonCycle,
  type SeasonEntry,
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

describe("sale amount on a draft", () => {
  it("is sent only for a sale entry, as text, with the optional buyer note trimmed", () => {
    const sale = base({ activity: "sale", saleInr: " 4200.50 ", saleNote: "  Hassan mandi  " });
    expect(draftToBody(sale).sale).toEqual({ amountInr: "4200.50", note: "Hassan mandi" });
    expect(draftToBody({ ...sale, saleNote: "   " }).sale).toEqual({ amountInr: "4200.50" });
    // Typed and then the activity was changed: hidden fields never leak into the request.
    for (const activity of ["harvest", "expense", "observation", "other", ""] as const) expect("sale" in draftToBody({ ...sale, activity, note: "x" })).toBe(false);
    // Nothing typed, nothing sent; and a malformed amount is never sent (the form refuses it first).
    expect("sale" in draftToBody(base({ activity: "sale", note: "x" }))).toBe(false);
    expect("sale" in draftToBody({ ...sale, saleInr: "12.345" })).toBe(false);
    expect(draftToBody({ ...sale, saleNote: "x".repeat(300) }).sale).toEqual({ amountInr: "4200.50", note: "x".repeat(120) });
  });

  it("refuses an amount that is not a non-negative rupee amount, only while the activity is sale", () => {
    for (const bad of ["abc", "-5", "12.345", "1e3", "₹5", "007"]) {
      expect(draftIssues(base({ activity: "sale", saleInr: bad }), TODAY).map((i) => i.field), bad).toContain("sale");
      expect(draftIssues(base({ activity: "harvest", note: "x", saleInr: bad }), TODAY).map((i) => i.field), `${bad} hidden`).not.toContain("sale");
    }
    for (const ok of ["0", "4200", "4200.5", "4200.50"]) expect(draftIssues(base({ activity: "sale", saleInr: ok }), TODAY)).toEqual([]);
    // A sale entry without an amount is still allowed (a note or the activity alone is a record).
    expect(canSubmit(base({ activity: "sale", note: "sold at the gate" }), TODAY)).toBe(true);
  });

  it("an unsent draft saved before the sale fields existed loads with empty sale fields", async () => {
    const store = new MemoryStore();
    const { saleInr: _a, saleNote: _b, ...old } = base({ note: "old draft", mediaIds: ["m1"] });
    await store.set("draft:entry-abc12345", old);
    await store.set("current:farm-1", "entry-abc12345");
    const d = await loadCurrentDraft(store, "farm-1");
    expect(d).toMatchObject({ note: "old draft", saleInr: "", saleNote: "" });
    expect(canSubmit(d!, TODAY)).toBe(true);
    expect(draftToBody(d!).sale).toBeUndefined();
  });
});

describe("season totals", () => {
  const TODAY2 = "2026-11-01";
  const cycle = (over: Partial<SeasonCycle> & { id: string }): SeasonCycle => ({ cropId: "ginger", sowingDate: "2026-05-01", stage: "growing", ...over });
  const entry = (observedOn: string, over: Partial<SeasonEntry> = {}): SeasonEntry => ({ observedOn, activity: "observation", quantity: null, expense: null, sale: null, ...over });
  const only = (entries: SeasonEntry[], cycles: SeasonCycle[]) => seasonTotals(entries, cycles, TODAY2);

  it("returns nothing without cycles, and zeroed rows with a null harvest when a cycle has no entries", () => {
    expect(only([entry("2026-06-01")], [])).toEqual([]);
    const [row] = only([], [cycle({ id: "c1", cropName: "Ginger" })]);
    expect(row).toMatchObject({ cycleId: "c1", cropName: "Ginger", from: "2026-05-01", to: TODAY2, ongoing: true, entries: 0, expenseInr: 0, saleInr: 0, netInr: 0, harvestKg: null, harvestUnitsSkipped: 0, overlapping: 0 });
  });

  it("counts an entry in the cycle whose dates contain it, inclusive of the first day, and leaves earlier ones out", () => {
    const c1 = cycle({ id: "c1", sowingDate: "2026-05-01", harvestDate: "2026-08-31", stage: "harvested" });
    const rows = only(
      [entry("2026-04-30", { expense: { amountInr: "999" } }), entry("2026-05-01", { expense: { amountInr: "100" } }), entry("2026-08-31", { sale: { amountInr: "300" }, activity: "sale" })],
      [c1],
    );
    expect(rows[0]).toMatchObject({ entries: 2, expenseInr: 100, saleInr: 300, netInr: 200, from: "2026-05-01", to: "2026-08-31", ongoing: false });
  });

  it("a harvested crop also takes entries for 90 days after the harvest date, inclusive of the last day, and not the day after", () => {
    expect(POST_HARVEST_WINDOW_DAYS).toBe(90);
    const c1 = cycle({ id: "c1", sowingDate: "2026-05-01", harvestDate: "2026-08-31", stage: "harvested" });
    const sale = (d: string, amountInr: string) => entry(d, { activity: "sale", sale: { amountInr } });
    const [row] = only([sale("2026-09-01", "1000"), sale("2026-11-29", "2000"), sale("2026-11-30", "5000"), sale("2026-04-30", "7000")], [c1]);
    expect(row).toMatchObject({ to: "2026-08-31", windowTo: "2026-11-29", entries: 2, saleInr: 3000 });
    expect(amountsOutsideCycles([sale("2026-09-01", "1000"), sale("2026-11-29", "2000"), sale("2026-11-30", "5000"), sale("2026-04-30", "7000")], [c1], TODAY2)).toBe(2);
  });

  it("the post-harvest window stops the day before the next crop starts, and never goes below the harvest date", () => {
    const harvested = cycle({ id: "h", cropId: "maize", sowingDate: "2026-02-01", harvestDate: "2026-06-30", stage: "harvested" });
    const next = cycle({ id: "n", cropId: "ginger", sowingDate: "2026-08-01", stage: "growing" });
    const sale = (d: string) => entry(d, { activity: "sale", sale: { amountInr: "100" } });
    const rows = only([sale("2026-07-31"), sale("2026-08-01")], [harvested, next]);
    const h = rows.find((r) => r.cycleId === "h")!;
    const n = rows.find((r) => r.cycleId === "n")!;
    expect(h).toMatchObject({ to: "2026-06-30", windowTo: "2026-07-31", entries: 1 });
    expect(n).toMatchObject({ windowTo: TODAY2, entries: 1, overlapping: 0 });
    // The next crop starts the day after harvest: the window is the harvest date itself, so no extension is shown.
    expect(only([], [harvested, { ...next, sowingDate: "2026-07-01" }]).find((r) => r.cycleId === "h")).toMatchObject({ windowTo: "2026-06-30" });
    // A crop that started before the harvest (or on the harvest day) does not shorten the window.
    expect(only([], [harvested, { ...next, sowingDate: "2026-06-30" }]).find((r) => r.cycleId === "h")).toMatchObject({ windowTo: "2026-09-28" });
    expect(only([], [harvested, { ...next, sowingDate: "2026-05-01" }]).find((r) => r.cycleId === "h")).toMatchObject({ windowTo: "2026-09-28" });
    // The earliest later start decides when several crops follow.
    const later = cycle({ id: "l", sowingDate: "2026-09-10", stage: "growing" });
    expect(only([], [harvested, later, next]).find((r) => r.cycleId === "h")).toMatchObject({ windowTo: "2026-07-31" });
  });

  it("an entry in a post-harvest window that is also inside an overlapping crop goes to the crop that started last", () => {
    const harvested = cycle({ id: "h", sowingDate: "2026-02-01", harvestDate: "2026-06-30", stage: "harvested" });
    const overlapping = cycle({ id: "o", cropId: "beans", sowingDate: "2026-06-15", stage: "growing" });
    const rows = only([entry("2026-07-10", { activity: "sale", sale: { amountInr: "500" } })], [harvested, overlapping]);
    expect(rows.find((r) => r.cycleId === "o")).toMatchObject({ entries: 1, saleInr: 500, overlapping: 1 });
    expect(rows.find((r) => r.cycleId === "h")).toMatchObject({ entries: 0, saleInr: 0 });
  });

  it("a crop still in the field gets no extension: its window is simply to today", () => {
    expect(only([], [cycle({ id: "a" })])[0]).toMatchObject({ to: TODAY2, windowTo: TODAY2, ongoing: true });
  });

  it("starts at the establishment date when there is one, and runs to today for a crop still in the field", () => {
    const c = cycle({ id: "c1", sowingDate: "2026-05-01", establishmentDate: "2026-05-20" });
    const [row] = only([entry("2026-05-10", { expense: { amountInr: "50" } }), entry("2026-05-20", { expense: { amountInr: "70" } }), entry("2026-11-01", { expense: { amountInr: "30" } })], [c]);
    expect(row).toMatchObject({ from: "2026-05-20", sowingDate: "2026-05-01", to: TODAY2, entries: 2, expenseInr: 100 });
  });

  it("an entry inside two cycles goes to the one that started later and is flagged as overlapping there", () => {
    const early = cycle({ id: "early", cropId: "maize", sowingDate: "2026-03-01", stage: "growing" });
    const late = cycle({ id: "late", cropId: "beans", sowingDate: "2026-06-01", stage: "growing" });
    const rows = only([entry("2026-04-10", { expense: { amountInr: "10" } }), entry("2026-07-01", { expense: { amountInr: "20" } }), entry("2026-07-02", { expense: { amountInr: "40" } })], [early, late]);
    const byId = Object.fromEntries(rows.map((r) => [r.cycleId, r]));
    expect(byId.early).toMatchObject({ entries: 1, expenseInr: 10, overlapping: 0 });
    expect(byId.late).toMatchObject({ entries: 2, expenseInr: 60, overlapping: 2 });
    // Nothing is counted twice.
    expect(rows.reduce((n, r) => n + r.entries, 0)).toBe(3);
  });

  it("on identical start dates the first listed cycle takes the entry, deterministically", () => {
    const a = cycle({ id: "a" });
    const b = cycle({ id: "b" });
    const one = only([entry("2026-06-01")], [a, b]);
    const two = only([entry("2026-06-01")], [b, a]);
    expect(one.find((r) => r.entries === 1)?.cycleId).toBe("a");
    expect(two.find((r) => r.entries === 1)?.cycleId).toBe("a");
    expect(one.find((r) => r.cycleId === "a")?.overlapping).toBe(1);
  });

  it("sorts crops still in the field first, then by sowing date, newest first", () => {
    const rows = only([], [
      cycle({ id: "old-done", sowingDate: "2026-01-01", stage: "harvested", harvestDate: "2026-04-01" }),
      cycle({ id: "new-done", sowingDate: "2026-06-01", stage: "harvested", harvestDate: "2026-09-01" }),
      cycle({ id: "old-active", sowingDate: "2026-02-01" }),
      cycle({ id: "new-active", sowingDate: "2026-10-01" }),
    ]);
    expect(rows.map((r) => r.cycleId)).toEqual(["new-active", "old-active", "new-done", "old-done"]);
  });

  it("adds money in whole paise: no floating-point drift, and net can be negative", () => {
    const c = cycle({ id: "c1" });
    const amounts = Array.from({ length: 10 }, () => entry("2026-06-01", { expense: { amountInr: "0.10" } }));
    const [row] = only([...amounts, entry("2026-06-02", { sale: { amountInr: "0.30" }, activity: "sale" }), entry("2026-06-03", { expense: { amountInr: "4199.5" } })], [c]);
    expect(row!.expenseInr).toBe(4200.5);
    expect(row!.saleInr).toBe(0.3);
    expect(row!.netInr).toBe(-4200.2);
    // 0.1 + 0.2 style sums stay exact.
    const [x] = only([entry("2026-06-01", { sale: { amountInr: "0.1" } }), entry("2026-06-01", { sale: { amountInr: "0.2" } })], [c]);
    expect(x!.saleInr).toBe(0.3);
    expect(toPaise("12500.5")).toBe(1250050n);
    expect(toPaise("0")).toBe(0n);
    expect(toPaise("1e3")).toBeNull();
    expect(toPaise("-1")).toBeNull();
    expect(toPaise(null)).toBeNull();
  });

  it("sums harvest quantities in kilograms from kg, quintal and t, and counts other units as skipped", () => {
    const c = cycle({ id: "c1" });
    const h = (value: number, unit: string) => entry("2026-10-01", { activity: "harvest", quantity: { value, unit } });
    const [row] = only([h(120.5, "kg"), h(2, "quintal"), h(0.25, "t"), h(40, "L"), h(3, "acre"), entry("2026-10-02", { activity: "irrigation", quantity: { value: 900, unit: "kg" } })], [c]);
    expect(row!.harvestKg).toBe(120.5 + 200 + 250);
    expect(row!.harvestUnitsSkipped).toBe(2);
    // 0.1 kg three times is exactly 0.3 kg.
    const [y] = only([h(0.1, "kg"), h(0.1, "kg"), h(0.1, "kg")], [c]);
    expect(y!.harvestKg).toBe(0.3);
  });

  it("harvestKg is null when no harvest entry has a convertible quantity; skipped units are still reported", () => {
    const c = cycle({ id: "c1" });
    expect(only([entry("2026-10-01", { activity: "harvest" })], [c])[0]).toMatchObject({ harvestKg: null, harvestUnitsSkipped: 0, entries: 1 });
    expect(only([entry("2026-10-01", { activity: "harvest", quantity: { value: 5, unit: "L" } })], [c])[0]).toMatchObject({ harvestKg: null, harvestUnitsSkipped: 1 });
    expect(only([entry("2026-10-01", { activity: "sale", quantity: { value: 5, unit: "kg" } })], [c])[0]!.harvestKg).toBeNull();
  });

  it("reports amounts that sit outside every crop's window, such as a sale long after the harvest", () => {
    const c = cycle({ id: "c1", sowingDate: "2026-05-01", harvestDate: "2026-08-31", stage: "harvested" });
    const entries = [entry("2026-06-01", { expense: { amountInr: "10" } }), entry("2026-09-15", { activity: "sale", sale: { amountInr: "9000" } }), entry("2026-12-15", { activity: "sale", sale: { amountInr: "4000" } }), entry("2026-12-16"), entry("2026-04-01", { expense: { amountInr: "5" } })];
    expect(amountsOutsideCycles(entries, [c], TODAY2)).toBe(2);
    expect(only(entries, [c])[0]).toMatchObject({ entries: 2, saleInr: 9000, expenseInr: 10 });
  });

  it("formats rupees with Indian grouping and a true minus sign", () => {
    expect(formatRupees(4200)).toBe("₹4,200");
    expect(formatRupees(-4200)).toBe("−₹4,200");
    expect(formatRupees(125000.5)).toBe("₹1,25,000.50");
    expect(formatRupees(0)).toBe("₹0");
    expect(formatKg(320)).toBe("320 kg");
    expect(formatKg(1250.5)).toBe("1,250.5 kg");
  });
});
