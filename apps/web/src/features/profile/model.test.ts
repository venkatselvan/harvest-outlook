import { describe, expect, it } from "vitest";
import { PROFILE_KEY, areaConversionText, emptyProfile, hasErrors, loadProfile, priceConversionText, priceInrPerKg, saveProfile, toRequest, validateProfile, type ProfileInput } from "./model";

const valid = (over: Partial<ProfileInput> = {}): ProfileInput => ({ ...emptyProfile(), stateId: "IN-KA", districtId: "IN-KA-hassan", plantingMonth: "5", irrigation: "rainfed", ...over });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
};

describe("validateProfile", () => {
  it("requires state, planting month and an explicit irrigation answer", () => {
    expect(Object.keys(validateProfile(emptyProfile())).sort()).toEqual(["irrigation", "month", "state"]);
    expect(hasErrors(validateProfile(valid()))).toBe(false);
  });
  it("accepts 'unknown' irrigation as an explicit answer", () => {
    expect(validateProfile(valid({ irrigation: "unknown" })).irrigation).toBeUndefined();
  });
  it.each(["0", "13", "1.5", "abc", "-1"])("rejects planting month %s", (m) => {
    expect(validateProfile(valid({ plantingMonth: m })).month).toBeDefined();
  });
  it.each(["1", "12"])("accepts planting month %s", (m) => {
    expect(validateProfile(valid({ plantingMonth: m })).month).toBeUndefined();
  });
  it("requires an exact date to be a real date inside the chosen month", () => {
    expect(validateProfile(valid({ plantingDate: "2027-05-14" })).date).toBeUndefined();
    expect(validateProfile(valid({ plantingDate: "2027-06-01" })).date).toMatch(/May/);
    expect(validateProfile(valid({ plantingDate: "2027-02-30", plantingMonth: "2" })).date).toBeDefined();
    expect(validateProfile(valid({ plantingDate: "14/05/2027" })).date).toBeDefined();
  });
  it("requires a positive area only when the area is declared", () => {
    expect(validateProfile(valid({ areaKnown: false, area: "garbage" })).area).toBeUndefined();
    for (const a of ["", "0", "-2", "two", "1e3"]) expect(validateProfile(valid({ areaKnown: true, area: a })).area).toBeDefined();
    expect(validateProfile(valid({ areaKnown: true, area: "2.5" })).area).toBeUndefined();
  });
  it("flags an area that is implausible in the chosen unit", () => {
    expect(validateProfile(valid({ areaKnown: true, area: "5000000", areaUnit: "ha" })).area).toBeDefined();
  });
  it("requires a product and a positive price when a price is on", () => {
    const e = validateProfile(valid({ priceOn: true, price: "", priceProductId: "" }));
    expect(e.price).toBeDefined();
    expect(e.priceProduct).toBeDefined();
    expect(hasErrors(validateProfile(valid({ priceOn: true, price: "30", priceProductId: "ginger-fresh" })))).toBe(false);
  });
  it("flags a quintal price that is absurd per kg only after unit conversion", () => {
    expect(validateProfile(valid({ priceOn: true, price: "1500000", priceUnit: "inr_per_quintal", priceProductId: "x" })).price).toBeUndefined();
    expect(validateProfile(valid({ priceOn: true, price: "1500000", priceUnit: "inr_per_kg", priceProductId: "x" })).price).toBeDefined();
  });
  it("limits the narrative length", () => {
    expect(validateProfile(valid({ narrative: "x".repeat(1001) })).narrative).toBeDefined();
  });
});

describe("unit display and request", () => {
  it("shows the converted area for the selected unit", () => {
    expect(areaConversionText({ areaKnown: true, area: "2", areaUnit: "acre" })).toBe("2 acre = 0.81 hectare");
    expect(areaConversionText({ areaKnown: true, area: "1", areaUnit: "ha" })).toBe("1 hectare = 2.47 acre");
    expect(areaConversionText({ areaKnown: false, area: "1", areaUnit: "ha" })).toBeNull();
    expect(areaConversionText({ areaKnown: true, area: "x", areaUnit: "ha" })).toBeNull();
  });
  it("sends the area with the unit the farmer toggled, never a converted amount", () => {
    expect(toRequest(valid({ areaKnown: true, area: "2", areaUnit: "acre" })).area).toEqual({ amount: 2, unit: "acre" });
    expect(toRequest(valid({ areaKnown: true, area: "2", areaUnit: "ha" })).area).toEqual({ amount: 2, unit: "ha" });
    expect(toRequest(valid()).area).toBeUndefined();
  });
  it("converts a quintal price to INR/kg and shows both", () => {
    expect(priceInrPerKg({ price: "3000", priceUnit: "inr_per_quintal" })).toBe(30);
    expect(priceInrPerKg({ price: "30", priceUnit: "inr_per_kg" })).toBe(30);
    expect(priceConversionText({ priceOn: true, price: "3000", priceUnit: "inr_per_quintal" })).toContain("INR 30 per kg");
    expect(toRequest(valid({ priceOn: true, price: "3000", priceUnit: "inr_per_quintal", priceProductId: "ginger-fresh" })).assumedPrices).toEqual([{ productId: "ginger-fresh", amountInrPerKg: 30 }]);
  });
  it("omits optional parts and never sends the narrative", () => {
    const body = toRequest(valid({ districtId: "", plantingDate: "", narrative: "my private note" }));
    expect(body).toEqual({ location: { stateId: "IN-KA" }, planting: { month: 5 }, irrigation: "rainfed", excludedCropIds: [], assumedPrices: [] });
    expect(JSON.stringify(body)).not.toContain("private");
  });
  it("sends exact date, district and exclusions", () => {
    const body = toRequest(valid({ plantingDate: "2027-05-14", excludedCropIds: ["cotton"] }));
    expect(body.planting).toEqual({ month: 5, date: "2027-05-14" });
    expect(body.location).toEqual({ stateId: "IN-KA", districtId: "IN-KA-hassan" });
    expect(body.excludedCropIds).toEqual(["cotton"]);
  });
});

describe("persistence", () => {
  it("round-trips the profile but not the narrative", () => {
    const s = memory();
    saveProfile(valid({ narrative: "private text", areaKnown: true, area: "3", areaUnit: "ha", excludedCropIds: ["cotton"] }), s);
    expect(s.raw.get(PROFILE_KEY)).not.toContain("private text");
    expect(s.raw.get(PROFILE_KEY)).not.toMatch(/lat|lon|coord/i);
    const back = loadProfile(s);
    expect(back).toMatchObject({ stateId: "IN-KA", plantingMonth: "5", areaKnown: true, area: "3", areaUnit: "ha", excludedCropIds: ["cotton"], narrative: "" });
  });
  it("falls back to an empty profile on corrupt or foreign data", () => {
    const s = memory();
    s.setItem(PROFILE_KEY, "{not json");
    expect(loadProfile(s)).toEqual(emptyProfile());
    s.setItem(PROFILE_KEY, JSON.stringify({ stateId: 5, irrigation: "flood", areaUnit: "sqft", excludedCropIds: [1, "a"] }));
    const p = loadProfile(s);
    expect(p.stateId).toBe("");
    expect(p.irrigation).toBe("");
    expect(p.areaUnit).toBe("acre");
    expect(p.excludedCropIds).toEqual(["a"]);
  });
});
