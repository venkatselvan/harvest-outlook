import { describe, expect, it } from "vitest";
import { addPlannedSeason, planCropModel, replacePlannedSeason } from "./planCrop";
import { releaseOfTimeline, seasonRealisation } from "./seasons";
import type { PlanCropRequest } from "./actions";
import type { Cycle } from "../state";
import { FIELD_ID, TODAY, ctxStub, gingerPreview, pigeonPlan } from "./fixtures";

const request = (over: Partial<PlanCropRequest> = {}): PlanCropRequest => ({ mode: "pick", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12", ...over });
const cycle = (over: Partial<Cycle> = {}): Cycle => ({ id: "c1", cropId: "paddy", sowingDate: "2026-08-20", stage: "growing", fieldId: FIELD_ID, ...over });

describe("which saved seasons can be replaced", () => {
  it("a planned or overdue season is replaceable; one a recorded cycle of the same crop realises (within 45 days) is sown", () => {
    const plan = pigeonPlan();
    expect(seasonRealisation(plan, [], FIELD_ID, "2026-11-04")).toBe("planned");
    expect(seasonRealisation(plan, [], FIELD_ID, "2027-03-01")).toBe("overdue");
    expect(seasonRealisation(plan, [cycle({ cropId: "pigeon-pea", sowingDate: "2027-03-30" })], FIELD_ID, "2027-04-02")).toBe("sown");
    expect(seasonRealisation(plan, [cycle({ cropId: "pigeon-pea", sowingDate: "2027-04-10" })], FIELD_ID, "2027-04-12")).toBe("overdue");
    // A cycle of the same crop on another field does not realise this field's season.
    expect(seasonRealisation(plan, [cycle({ cropId: "pigeon-pea", sowingDate: "2027-02-22", fieldId: "field-b" })], FIELD_ID, "2027-02-25")).toBe("overdue");
  });
});

describe("planCropModel (reads only)", () => {
  it("offers Add when no saved season of the field overlaps the crop's occupancy", () => {
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan({ plannedSowingDate: "2027-11-01", plannedHarvestDate: "2028-04-01" })] });
    const model = planCropModel({ request: request(), preview: gingerPreview(), ctx });
    expect(model.choice).toEqual({ kind: "add" });
    expect(model.occupancy).toEqual({ from: "2027-02-12", to: "2027-10-15" });
    expect(calls.saved).toEqual([]);
  });
  it("offers Replace for a replaceable season it overlaps, and only for seasons of this field", () => {
    const { ctx } = ctxStub({}, { plans: [pigeonPlan(), pigeonPlan({ id: "other-field", fieldId: "field-b" })] });
    const model = planCropModel({ request: request(), preview: gingerPreview(), ctx });
    expect(model.choice.kind).toBe("replace");
    if (model.choice.kind === "replace") expect(model.choice.seasons.map((s) => s.plan.id)).toEqual(["rot-pigeon"]);
  });
  it("refuses to plan beside a season a recorded cycle already sowed, and says which", () => {
    const { ctx } = ctxStub({}, { plans: [pigeonPlan()], cycles: [cycle({ cropId: "pigeon-pea", sowingDate: "2027-02-25" })] });
    const model = planCropModel({ request: request(), preview: gingerPreview(), ctx });
    expect(model.choice.kind).toBe("none");
    if (model.choice.kind === "none") expect(model.choice.message).toContain("Pigeon pea is already sown");
  });
  it("refuses a sowing date that has passed, and waits while the workspace is loading", () => {
    const past = ctxStub({}, { plans: [] }).ctx;
    const model = planCropModel({ request: request({ sowingDate: "2026-10-01" }), preview: gingerPreview({ sowing: "2026-10-01", harvest: { earliest: "2027-05-01", latest: "2027-06-01" } }), ctx: past });
    expect(model.choice).toMatchObject({ kind: "none" });
    expect((model.choice as { message: string }).message).toContain("has passed");
    const loading = ctxStub({ rotationPlans: () => undefined }).ctx;
    expect(planCropModel({ request: request(), preview: gingerPreview(), ctx: loading }).choice).toMatchObject({ kind: "none", message: "Farm details are still loading. Try again in a moment." });
  });
  it("a replace request for a season that is gone, or already sown, offers nothing", () => {
    const gone = ctxStub({}, { plans: [] }).ctx;
    expect(planCropModel({ request: request({ mode: "replace", rotationPlanId: "rot-pigeon" }), preview: gingerPreview(), ctx: gone }).choice.kind).toBe("none");
    const sown = ctxStub({}, { plans: [pigeonPlan()], cycles: [cycle({ cropId: "pigeon-pea", sowingDate: "2027-02-25" })] }).ctx;
    const model = planCropModel({ request: request({ mode: "replace", rotationPlanId: "rot-pigeon" }), preview: gingerPreview(), ctx: sown });
    expect(model.choice).toMatchObject({ kind: "none", message: "This season is already sown or no longer planned, so it cannot be replaced." });
  });
});

describe("Add as planned season", () => {
  it("appends a RotationPlan as the Planner builds one, then reloads, toasts and tells the chat", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan({ plannedSowingDate: "2027-11-01", plannedHarvestDate: "2028-04-01" })] });
    const outcome = await addPlannedSeason({ ctx, request: request(), preview: gingerPreview(), id: "rotation-new-1" });
    expect(outcome).toEqual({ kind: "saved", saved: { kind: "added", cropName: "Ginger", sowing: "2027-02-12" } });
    expect(calls.saved.length).toBe(1);
    const plans = calls.saved[0]!.rotationPlans;
    expect(plans.map((p) => p.id)).toEqual(["rot-pigeon", "rotation-new-1"]);
    expect(plans[1]).toMatchObject({ id: "rotation-new-1", year: 2027, season: "Summer", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", plannedSowingDate: "2027-02-12", plannedHarvestDate: "2027-10-15", fieldId: FIELD_ID });
    expect(calls.order).toEqual(["refresh", "notify", "say"]);
    expect(calls.notices[0]).toBe("Saved: Ginger is planned for 12 Feb 2027");
  });
  it("a retry after a failed save reuses the id, so one tap never adds the season twice", async () => {
    const state: { plans: ReturnType<typeof pigeonPlan>[]; saveError?: unknown } = { plans: [], saveError: Object.assign(new Error("conflict"), { status: 409 }) };
    const { ctx, calls } = ctxStub({}, state);
    const first = await addPlannedSeason({ ctx, request: request(), preview: gingerPreview(), id: "rotation-new-1" });
    expect(first).toMatchObject({ kind: "failed", conflict: true, message: "Your saved seasons changed elsewhere. Reload the plan and try again." });
    expect(calls.saved).toEqual([]);
    expect(calls.said).toEqual([]);
    delete state.saveError;
    const retried = await addPlannedSeason({ ctx, request: request(), preview: gingerPreview(), id: "rotation-new-1" });
    expect(retried.kind).toBe("saved");
    expect(calls.saved.length).toBe(1);
    expect(calls.saved[0]!.rotationPlans.map((p) => p.id)).toEqual(["rotation-new-1"]);
    // A save whose answer was lost: the stored list already holds the season. A second add refuses (it would now be a Replace of itself) instead of duplicating it.
    const stored = ctxStub({}, { plans: [calls.saved[0]!.rotationPlans[0]!] });
    const again = await addPlannedSeason({ ctx: stored.ctx, request: request(), preview: gingerPreview(), id: "rotation-new-1" });
    expect(again.kind).toBe("refused");
    expect(stored.calls.saved).toEqual([]);
  });
  it("does not write when the crop collides with a planned season (that is a Replace) or the date has passed", async () => {
    const { ctx, calls } = ctxStub();
    const outcome = await addPlannedSeason({ ctx, request: request(), preview: gingerPreview(), id: "x" });
    expect(outcome.kind).toBe("refused");
    expect(calls.saved).toEqual([]);
    expect(calls.said).toEqual([]);
  });
  it("shows a server message for other failures and keeps the sheet usable", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [], saveError: new Error("Please wait for the current save to finish.") });
    expect(await addPlannedSeason({ ctx, request: request(), preview: gingerPreview(), id: "x" })).toEqual({ kind: "failed", message: "Please wait for the current save to finish.", conflict: false });
    expect(calls.said).toEqual([]);
  });
});

describe("Replace <crop> (planned <date>)", () => {
  it("swaps the planned season in place: same id and field, the new crop and dates, the apply-written notes replaced", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan({ notes: 'Year plan "Best overall" (model) from review abc: expected 800 kg/ha.' })] });
    const outcome = await replacePlannedSeason({ ctx, request: request(), preview: gingerPreview(), rotationPlanId: "rot-pigeon" });
    expect(outcome).toEqual({ kind: "saved", saved: { kind: "replaced", cropName: "Ginger", fromCropName: "Pigeon pea", sowing: "2027-02-12" } });
    expect(calls.saved.length).toBe(1);
    const [plan] = calls.saved[0]!.rotationPlans;
    expect(calls.saved[0]!.rotationPlans.length).toBe(1);
    expect(plan).toMatchObject({ id: "rot-pigeon", fieldId: FIELD_ID, cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", plannedSowingDate: "2027-02-12", plannedHarvestDate: "2027-10-15", year: 2027, season: "Summer" });
    expect(plan!.notes).toContain("Crop changed from Pigeon pea to Ginger");
    expect(plan!.notes).not.toContain("800 kg/ha");
    expect(calls.notices[0]).toBe("Saved: Ginger replaces Pigeon pea, planned for 12 Feb 2027");
    expect(calls.said[0]!.actions).toEqual([{ kind: "open", label: "Open plan", target: "plan" }]);
  });
  it("refuses, without writing, a season a recorded cycle realises or one that is not on the field any more", async () => {
    const sown = ctxStub({}, { plans: [pigeonPlan()], cycles: [cycle({ cropId: "pigeon-pea", sowingDate: "2027-02-25" })] });
    expect((await replacePlannedSeason({ ctx: sown.ctx, request: request({ mode: "replace" }), preview: gingerPreview(), rotationPlanId: "rot-pigeon" })).kind).toBe("refused");
    const gone = ctxStub({}, { plans: [] });
    expect(await replacePlannedSeason({ ctx: gone.ctx, request: request({ mode: "replace" }), preview: gingerPreview(), rotationPlanId: "rot-pigeon" })).toMatchObject({ kind: "refused", message: "That planned season is no longer on the field. Reload and try again." });
    expect([sown.calls.saved, gone.calls.saved]).toEqual([[], []]);
  });
  it("refuses a replacement that would overlap another saved season of the field, with the swap's own reason", async () => {
    const neighbour = pigeonPlan({ id: "rot-next", cropId: "ragi", cropName: "Finger millet", plannedSowingDate: "2027-09-01", plannedHarvestDate: "2028-01-15" });
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan(), neighbour] });
    const outcome = await replacePlannedSeason({ ctx, request: request(), preview: gingerPreview(), rotationPlanId: "rot-pigeon" });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect((outcome as { message: string }).message).toContain("would overlap Finger millet");
    expect(calls.saved).toEqual([]);
  });
  it("a 409 is reported as a conflict the farmer can retry after a reload, and nothing is announced as saved", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan()], saveError: Object.assign(new Error("version"), { status: 409, code: "version_conflict" }) });
    const outcome = await replacePlannedSeason({ ctx, request: request(), preview: gingerPreview(), rotationPlanId: "rot-pigeon" });
    expect(outcome).toEqual({ kind: "failed", message: "Your saved seasons changed elsewhere. Reload the plan and try again.", conflict: true });
    expect([calls.notices, calls.said, calls.order]).toEqual([[], [], []]);
  });
  it("picking what is already there changes nothing", async () => {
    const same = pigeonPlan({ cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", plannedSowingDate: "2027-02-12", plannedHarvestDate: "2027-10-15" });
    const { ctx, calls } = ctxStub({}, { plans: [same] });
    expect(await replacePlannedSeason({ ctx, request: request(), preview: gingerPreview(), rotationPlanId: "rot-pigeon" })).toMatchObject({ kind: "refused", message: "That planned season already has this crop on this date." });
    expect(calls.saved).toEqual([]);
  });
});

describe("the crop standing in the field holds it (review finding 1)", () => {
  const paddy = (over: Partial<Cycle> = {}): Cycle => cycle({ cropName: "Paddy", ...over });
  const today = () => gingerPreview({ sowing: TODAY, harvest: { earliest: "2027-06-20", latest: "2027-07-15" } });
  const UNKNOWN = "The field is growing Paddy; its harvest date is not known yet, so a new season cannot be placed from 4 Nov 2026.";

  it("refuses to add ginger with no sowing date (today) on a field growing paddy, and never saves", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [], cycles: [paddy()] });
    const req = request({ sowingDate: null });
    expect(planCropModel({ request: req, preview: today(), ctx }).choice).toEqual({ kind: "none", message: UNKNOWN });
    expect(await addPlannedSeason({ ctx, request: req, preview: today(), id: "x" })).toEqual({ kind: "refused", message: UNKNOWN });
    expect(calls.saved).toEqual([]);
    expect(calls.said).toEqual([]);
  });
  it("with a known release date, refuses a sowing before it and allows one on or after it", async () => {
    const releases = { c1: "2026-12-10" };
    const { ctx, calls } = ctxStub({}, { plans: [], cycles: [paddy()] });
    const early = await addPlannedSeason({ ctx, request: request({ sowingDate: null }), preview: today(), id: "x", releases });
    expect(early).toEqual({ kind: "refused", message: "Paddy is already sown on this field from 20 Aug 2026 to 10 Dec 2026, so this crop cannot be planned at the same time." });
    expect(calls.saved).toEqual([]);
    const preview = gingerPreview({ sowing: "2026-12-10", harvest: { earliest: "2027-08-01", latest: "2027-08-20" } });
    expect(planCropModel({ request: request({ sowingDate: "2026-12-10" }), preview, ctx, releases }).choice).toEqual({ kind: "add" });
    expect((await addPlannedSeason({ ctx, request: request({ sowingDate: "2026-12-10" }), preview, id: "y", releases })).kind).toBe("saved");
  });
  it("a harvested cycle and a cycle of another field do not hold this field; a farm-wide cycle does", () => {
    const free = (cycles: Cycle[]) => planCropModel({ request: request(), preview: gingerPreview(), ctx: ctxStub({}, { plans: [], cycles }).ctx }).choice;
    expect(free([paddy({ stage: "harvested" })])).toEqual({ kind: "add" });
    expect(free([paddy({ fieldId: "field-b" })])).toEqual({ kind: "add" });
    expect(free([(({ fieldId: _own, ...rest }) => rest)(paddy())]).kind).toBe("none");
  });
  it("a replace is refused while the growing crop's release date is unknown or later than the new sowing, and nothing is saved", async () => {
    const { ctx, calls } = ctxStub({}, { plans: [pigeonPlan()], cycles: [paddy()] });
    const req = request({ mode: "replace", rotationPlanId: "rot-pigeon" });
    const unknown = { kind: "refused", message: "The field is growing Paddy; its harvest date is not known yet, so a new season cannot be placed from 12 Feb 2027." };
    expect(planCropModel({ request: req, preview: gingerPreview(), ctx }).choice).toMatchObject({ kind: "none" });
    expect(await replacePlannedSeason({ ctx, request: req, preview: gingerPreview(), rotationPlanId: "rot-pigeon" })).toEqual(unknown);
    expect(await replacePlannedSeason({ ctx, request: req, preview: gingerPreview(), rotationPlanId: "rot-pigeon", releases: { c1: "2027-03-01" } })).toMatchObject({ kind: "refused", message: expect.stringContaining("Paddy is already sown") });
    expect(calls.saved).toEqual([]);
    const ok = await replacePlannedSeason({ ctx, request: req, preview: gingerPreview(), rotationPlanId: "rot-pigeon", releases: { c1: "2026-12-10" } });
    expect(ok.kind).toBe("saved");
    expect(calls.saved.length).toBe(1);
  });
  it("reads the release date from the harvest window, else the last stage, else says it is unknown", () => {
    const stages = [{ id: "a", name: "A", from: "2026-08-20", to: "2026-10-01", basis: "sourced" as const }, { id: "b", name: "B", from: "2026-10-02", to: "2026-11-30", basis: "sourced" as const }];
    expect(releaseOfTimeline({ stages, harvest: { earliest: "2026-11-20", latest: "2026-12-05" } as never })).toBe("2026-12-05");
    expect(releaseOfTimeline({ stages, harvest: null })).toBe("2026-11-30");
    expect(releaseOfTimeline({ stages: [], harvest: null })).toBeNull();
    expect(releaseOfTimeline(null)).toBeNull();
  });
});
