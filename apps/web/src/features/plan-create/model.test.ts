import { describe, expect, it } from "vitest";
import { defaultPlantingDate, toCreateInput, validateCreate } from "./model";

const form = (o: Partial<Parameters<typeof validateCreate>[0]> = {}) => ({ plantingDate: "2026-11-01", area: "", irrigation: "" as const, price: "", ...o });

describe("create plan form", () => {
  it("defaults the planting date to the first of next month in India time, including the year rollover", () => {
    expect(defaultPlantingDate(new Date("2026-10-30T06:00:00Z"))).toBe("2026-11-01");
    expect(defaultPlantingDate(new Date("2026-12-15T06:00:00Z"))).toBe("2027-01-01");
    // 20:00 UTC on 31 Dec is already 1 Jan in India: next month is February.
    expect(defaultPlantingDate(new Date("2026-12-31T20:00:00Z"))).toBe("2027-02-01");
  });
  it("asks for area and irrigation only when the farm does not hold them", () => {
    expect(validateCreate(form(), { hasArea: false, hasIrrigation: false })).toEqual({ area: "Enter the area in hectares.", irrigation: expect.stringMatching(/Choose/) });
    expect(validateCreate(form(), { hasArea: true, hasIrrigation: true })).toEqual({});
  });
  it("rejects bad dates, areas and prices", () => {
    const e = validateCreate(form({ plantingDate: "2026-02-31", area: "-1", irrigation: "rainfed", price: "abc" }), { hasArea: false, hasIrrigation: false });
    expect(Object.keys(e).sort()).toEqual(["area", "plantingDate", "price"]);
    expect(validateCreate(form({ area: "0" }), { hasArea: true, hasIrrigation: true }).area).toBeDefined();
  });
  it("sends only what the farmer entered", () => {
    expect(toCreateInput("f", "ginger", "ginger-fresh", form())).toEqual({ farmId: "f", cropId: "ginger", productId: "ginger-fresh", plantingDate: "2026-11-01" });
    expect(toCreateInput("f", "ginger", "ginger-fresh", form({ area: "1.5", irrigation: "rainfed", price: "80" }))).toMatchObject({ areaHa: 1.5, irrigationCategory: "rainfed", assumedPriceInrPerKg: 80 });
  });
});
