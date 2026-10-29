import { describe, expect, it } from "vitest";
import { buildFarmBody, validateFarmForm, type FarmFormInput } from "./formModel";

const base: FarmFormInput = { district: " Wayanad ", stateId: "IN-KL", districtId: "", startMonth: "6", endMonth: "8", irrigation: "rainfed", areaKnown: true, area: "2.5", areaUnit: "acre" };

describe("farm form", () => {
  it("converts acres to hectares and keeps the entered value and unit as a fact", () => {
    const b = buildFarmBody(base) as any;
    expect(b.areaHectares).toBeCloseTo(1.0117, 4);
    expect(b.facts.area_reported).toMatchObject({ value: 2.5, unit: "acre", basis: "farmer_reported" });
    expect(b.location).toEqual({ districtName: "Wayanad", stateId: "IN-KL", precision: "district" });
    expect(b.facts.planting_window_start_month.value).toBe(6);
    expect(b.facts.irrigation_category.value).toBe("rainfed");
  });
  it("leaves unknown answers out instead of inventing facts", () => {
    const b = buildFarmBody({ ...base, stateId: "", startMonth: "", endMonth: "", irrigation: "unknown", areaKnown: false, area: "7" }) as any;
    expect(b.areaHectares).toBeUndefined();
    expect(b.facts).toEqual({});
    expect(b.location.stateId).toBeUndefined();
    expect(b.location).toEqual({ districtName: "Wayanad", precision: "district" });
  });
  it("validates required and inconsistent answers", () => {
    expect(validateFarmForm(base)).toEqual({});
    expect(validateFarmForm({ ...base, district: "  " }).district).toBeTruthy();
    expect(validateFarmForm({ ...base, district: "!!!" }).district).toBeTruthy();
    expect(validateFarmForm({ ...base, endMonth: "" }).window).toBeTruthy();
    expect(validateFarmForm({ ...base, area: "0" }).area).toBeTruthy();
    expect(validateFarmForm({ ...base, area: "abc" }).area).toBeTruthy();
    expect(validateFarmForm({ ...base, areaKnown: false, area: "" })).toEqual({});
    expect(validateFarmForm({ ...base, irrigation: "" }).irrigation).toBeTruthy();
  });
  it("supports a wrap-around planting window and non-Latin district names", () => {
    const b = buildFarmBody({ ...base, district: "கோயம்புத்தூர்", startMonth: "11", endMonth: "2" }) as any;
    expect(b.facts.planting_window_end_month.value).toBe(2);
    expect(b.location.districtId).toBeUndefined();
    expect(b.location.districtName).toContain("க");
  });
  it("sends a picked registry id (never a typed or derived one) and ignores stale free text", () => {
    const f = { ...base, stateId: "IN-KA", districtId: "IN-KA-hassan", districtLabel: "Hassan", district: "old text" };
    const b = buildFarmBody(f) as any;
    expect(b.location).toEqual({ districtId: "IN-KA-hassan", stateId: "IN-KA", precision: "district" });
    expect(b.name).toBe("Hassan farm");
    expect(JSON.stringify(b)).not.toContain("typed:");
    expect(validateFarmForm(f)).toEqual({});
  });
  it("rejects a picked district that does not belong to the chosen state or has no state", () => {
    expect(validateFarmForm({ ...base, stateId: "IN-TN", districtId: "IN-KA-hassan" }).district).toBeTruthy();
    expect(validateFarmForm({ ...base, stateId: "", districtId: "IN-KA-hassan" }).district).toBeTruthy();
  });
});
