import { describe, expect, it } from "vitest";
import type { EvaraAction } from "@harvest/contracts";
import { compareHref, finishSeasonSave, openHref, runEvaraAction, savedMessage, usePlanHref } from "./actions";
import { ASK_QUESTIONS } from "./labels";
import { REVIEW_ID, ctxStub } from "./fixtures";

const KINDS = {
  ask: { kind: "ask", label: "x", promptKey: "plant_next" },
  show_journey: { kind: "show_journey", label: "x", cropId: "ginger", cropName: "Ginger", sowingDate: "2027-02-12" },
  compare: { kind: "compare", label: "x", cropIds: ["ginger", "turmeric", "unknown-crop"] },
  pick_crop: { kind: "pick_crop", label: "x", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12" },
  use_plan: { kind: "use_plan", label: "x", reviewId: REVIEW_ID, optionId: "alt-1", alternative: true, fieldId: "field-b" },
  replace_season: { kind: "replace_season", label: "x", rotationPlanId: "rot-pigeon", fromCropName: "Pigeon pea", cropId: "ginger", cropName: "Ginger", productId: null, sowingDate: "2027-02-12" },
  add_season: { kind: "add_season", label: "x", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12" },
  open: { kind: "open", label: "x", target: "plan" },
} satisfies Record<EvaraAction["kind"], EvaraAction>;

describe("runEvaraAction dispatches every action kind", () => {
  it("ask sends the code-written question for the key in the panel's language, never text from the tree", () => {
    for (const language of ["en", "hi", "ta"] as const) {
      const { ctx, calls } = ctxStub({ language });
      runEvaraAction(KINDS.ask, ctx);
      expect(calls.asked).toEqual([ASK_QUESTIONS[language].plant_next]);
    }
    expect(ASK_QUESTIONS.hi.plant_next).not.toBe(ASK_QUESTIONS.en.plant_next);
    expect(ASK_QUESTIONS.ta.plant_next).not.toBe(ASK_QUESTIONS.en.plant_next);
  });
  it("has a question for every prompt key in every language", () => {
    for (const language of ["en", "hi", "ta"] as const)
      for (const key of ["care_15_days", "plant_next", "compare_season", "weather_market", "what_could_have_been", "show_journey"] as const) expect(ASK_QUESTIONS[language][key].length).toBeGreaterThan(5);
  });
  it("show_journey only hands the crop to the journey strip; it writes and navigates nothing", () => {
    const { ctx, calls } = ctxStub();
    runEvaraAction(KINDS.show_journey, ctx);
    expect(calls.journeys).toEqual(["ginger"]);
    expect([calls.navigated, calls.sheets, calls.saved, calls.compare]).toEqual([[], [], [], []]);
  });
  it("compare writes the selection by catalogue product (crops without a product are left out) and opens ?tool=compare on the current tab and field", () => {
    const { ctx, calls } = ctxStub({ tab: "year" });
    runEvaraAction(KINDS.compare, ctx);
    expect(calls.compare).toEqual([{ farmId: ctx.farmId, productIds: ["ginger-fresh", "turmeric-fresh"] }]);
    expect(calls.navigated).toEqual(["/farm?tab=year&field=field-hassan-a&tool=compare"]);
    expect(compareHref("today", null)).toBe("/farm?tab=today&tool=compare");
  });
  it("compare without a farm writes nothing and does not navigate", () => {
    const { ctx, calls } = ctxStub({ farmId: null });
    runEvaraAction(KINDS.compare, ctx);
    expect(calls.compare).toEqual([]);
    expect(calls.navigated).toEqual([]);
    expect(calls.notices.length).toBe(1);
  });
  it("pick_crop, replace_season and add_season only open the sheet with the right mode; nothing is saved on open", () => {
    const { ctx, calls } = ctxStub();
    runEvaraAction(KINDS.pick_crop, ctx);
    runEvaraAction(KINDS.replace_season, ctx);
    runEvaraAction(KINDS.add_season, ctx);
    expect(calls.sheets.map((s) => s.mode)).toEqual(["pick", "replace", "add"]);
    expect(calls.sheets[1]).toMatchObject({ rotationPlanId: "rot-pigeon", cropId: "ginger", productId: null });
    expect(calls.sheets[2]).toMatchObject({ sowingDate: "2027-02-12", productId: "ginger-fresh" });
    expect([calls.saved, calls.navigated]).toEqual([[], []]);
  });
  it("use_plan opens the Plan tab of the action's field with ?option=<id>, and &alternative=1 only for an alternative", () => {
    const { ctx, calls } = ctxStub();
    runEvaraAction(KINDS.use_plan, ctx);
    expect(calls.navigated).toEqual(["/farm?tab=year&field=field-b&option=alt-1&alternative=1"]);
    expect(usePlanHref({ ...KINDS.use_plan, alternative: false, fieldId: null }, "field-hassan-a")).toBe("/farm?tab=year&field=field-hassan-a&option=alt-1");
    expect(usePlanHref({ ...KINDS.use_plan, optionId: "a b&c", fieldId: null }, null)).toBe("/farm?tab=year&option=a%20b%26c&alternative=1");
  });
  it("open goes to the tab each target names", () => {
    const { ctx } = ctxStub({ tab: "harvest" });
    expect(openHref("plan", ctx)).toBe("/farm?tab=year&field=field-hassan-a");
    expect(openHref("fit", ctx)).toBe("/farm?tab=soil&field=field-hassan-a");
    expect(openHref("journal", ctx)).toBe("/farm?tab=soil&view=activity&field=field-hassan-a");
    expect(openHref("today", ctx)).toBe("/farm?tab=today&field=field-hassan-a");
    expect(openHref("compare", ctx)).toBe("/farm?tab=harvest&field=field-hassan-a&tool=compare");
    const run = ctxStub();
    runEvaraAction(KINDS.open, run.ctx);
    expect(run.calls.navigated).toEqual(["/farm?tab=year&field=field-hassan-a"]);
  });
});

describe("after a save", () => {
  it("reloads the workspace first, then toasts, then tells the chat, with an Open plan action", async () => {
    const { ctx, calls } = ctxStub();
    await finishSeasonSave(ctx, { kind: "replaced", cropName: "Ginger", fromCropName: "Pigeon pea", sowing: "2027-02-12" });
    expect(calls.order).toEqual(["refresh", "notify", "say"]);
    expect(calls.notices).toEqual(["Saved: Ginger replaces Pigeon pea, planned for 12 Feb 2027"]);
    expect(calls.said[0]).toMatchObject({ text: "Saved: Ginger replaces Pigeon pea, planned for 12 Feb 2027", actions: [{ kind: "open", target: "plan" }] });
  });
  it("a failed reload does not hide the fact that the save happened", async () => {
    const { ctx, calls } = ctxStub({ refreshWorkspace: async () => { throw new Error("offline"); } });
    await finishSeasonSave(ctx, { kind: "added", cropName: "Ginger", sowing: "2027-02-12" });
    expect(calls.notices).toEqual(["Saved: Ginger is planned for 12 Feb 2027"]);
    expect(calls.said.length).toBe(1);
  });
  it("is written in the panel's language", () => {
    const hi = savedMessage({ kind: "added", cropName: "अदरक", sowing: "2027-02-12" }, "hi");
    expect(hi.text).toContain("सहेजा गया");
    expect(hi.text).toContain("अदरक");
    expect(hi.actions[0]!.label).toBe("योजना खोलें");
  });
});
