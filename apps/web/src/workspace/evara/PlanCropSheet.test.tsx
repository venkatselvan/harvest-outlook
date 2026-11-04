import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import type { PlanCropRequest } from "./actions";
import { ctxStub, gingerPreview, pigeonPlan, FIELD_ID } from "./fixtures";

vi.mock("../FieldGrowthScene", () => ({ FieldGrowthScene: () => <div /> }));
const { PlanCropBody } = await import("./PlanCropSheet");

const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/ data-hk="[^"]*"/g, "");
const request = (over: Partial<PlanCropRequest> = {}): PlanCropRequest => ({ mode: "pick", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12", ...over });
const body = (over: Parameters<typeof ctxStub>[1] = {}, req = request()) => {
  const { ctx, calls } = ctxStub({}, over);
  return { html: strip(renderToString(() => <PlanCropBody ctx={ctx} request={req} preview={gingerPreview()} onClose={() => undefined} />)), calls };
};

describe("Plan-this-crop sheet content", () => {
  it("shows the stages and harvest window, then the exact add before the button, and writes nothing on open", () => {
    const { html, calls } = body({ plans: [] });
    expect(html).toContain("Establishment");
    expect(html).toContain("Vegetative growth");
    expect(html).toContain("20 Sep 2027 – 15 Oct 2027");
    expect(html).toContain("Adds Ginger to your plan on Hassan field A: sow 12 Feb 2027, harvest by 15 Oct 2027.");
    expect(html).toContain("Nothing is saved until you confirm.");
    expect(html).toContain("Add as planned season");
    expect(html).not.toContain("Replace Pigeon pea");
    expect(calls.saved).toEqual([]);
    expect(calls.notices).toEqual([]);
  });
  it("offers Replace <crop> (planned <date>) instead of Add when a replaceable season overlaps, with the exact change", () => {
    const { html } = body({ plans: [pigeonPlan()] });
    expect(html).toContain("Pigeon pea (planned 20 Feb 2027) is replaced by Ginger: sow 12 Feb 2027, harvest by 15 Oct 2027.");
    expect(html).toContain("Replace Pigeon pea (planned 20 Feb 2027)");
    expect(html).not.toContain("Add as planned season");
  });
  it("offers no save at all, only the reason, when a sown season holds the field", () => {
    const { html } = body({ plans: [pigeonPlan()], cycles: [{ id: "c", cropId: "pigeon-pea", sowingDate: "2027-02-25", stage: "growing", fieldId: FIELD_ID }] });
    expect(html).toContain("Pigeon pea is already sown on this field");
    expect(html).not.toContain("Add as planned season");
    expect(html).not.toContain("Replace Pigeon pea");
  });
  it("shows why before any save when a growing crop's harvest date is not known, and offers no save", () => {
    const { html, calls } = body({ plans: [], cycles: [{ id: "c", cropId: "paddy", cropName: "Paddy", sowingDate: "2026-08-20", stage: "growing", fieldId: FIELD_ID }] });
    expect(html).toContain("The field is growing Paddy; its harvest date is not known yet, so a new season cannot be placed from 12 Feb 2027.");
    expect(html).not.toContain("Add as planned season");
    expect(calls.saved).toEqual([]);
  });
  it("labels the preview as a calculated reference, not a prediction", () => {
    expect(body({ plans: [] }).html).toContain("calculated reference");
  });
  it("names the whole farm when no field is viewed", () => {
    const { ctx } = ctxStub({ fieldId: null }, { plans: [] });
    const html = strip(renderToString(() => <PlanCropBody ctx={ctx} request={request()} preview={gingerPreview()} onClose={() => undefined} />));
    expect(html).toContain("Whole farm");
  });
});
