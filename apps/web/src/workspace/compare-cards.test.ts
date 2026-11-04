import { describe, expect, it } from "vitest";
import { hassanFixture } from "../features/comparison/fixtures";
import type { CompareItem } from "../features/comparison/types";
import { CHIP_TITLE, NOT_SOURCED, cardRows } from "./compare-cards";

/** The Hassan fixture is captured from the API in synthetic mode: shapes are real, values are not field data. */
const byName = (name: string) => hassanFixture.items.find((i) => i.cropName === name)!;
const row = (item: CompareItem, key: string) => cardRows(item).find((r) => r.key === key)!;
const withDims = (item: CompareItem, patch: Partial<CompareItem["dimensions"]>): CompareItem => ({ ...item, dimensions: { ...item.dimensions, ...patch } });

describe("compare cards: rows and source chips", () => {
  it("always gives the four rows in order", () => {
    expect(cardRows(byName("Turmeric")).map((r) => r.label)).toEqual(["Season", "Planting window", "Duration", "Water need"]);
  });
  it("a national sourced record is chipped 'sourced', not 'state window'", () => {
    const turmeric = byName("Turmeric");
    expect(turmeric.context?.regionMatch).toBe("national");
    expect(row(turmeric, "season")).toMatchObject({ value: "Kharif", chip: "sourced" });
    expect(row(turmeric, "window")).toMatchObject({ value: "Apr to May", chip: "sourced" });
    expect(row(turmeric, "duration")).toMatchObject({ value: "180 to 270 days", chip: "sourced" });
  });
  it("a record scoped to the farm's state is chipped 'state window'", () => {
    const stateScoped: CompareItem = { ...byName("Turmeric"), context: { ...byName("Turmeric").context!, regionMatch: "state_or_region" } };
    expect(row(stateScoped, "window").chip).toBe("state window");
    expect(row(stateScoped, "season").chip).toBe("state window");
    expect(row(stateScoped, "duration").chip).toBe("state window");
  });
  it("a figure with no evidence record behind it is an 'estimate', never 'sourced'", () => {
    const turmeric = byName("Turmeric");
    const noEvidence: CompareItem = { ...turmeric, plantingWindow: { ...turmeric.plantingWindow!, evidenceIds: [] } };
    expect(row(noEvidence, "window").chip).toBe("estimate");
    const duration = withDims(turmeric, { timeToFirstIncome: { ...turmeric.dimensions.timeToFirstIncome, evidenceIds: [] } });
    expect(row(duration, "duration").chip).toBe("estimate");
  });
  it("a crop with no sourced context for the state shows 'Not sourced for this state', no number and no chip", () => {
    const ginger = byName("Ginger");
    expect(ginger.plantingWindow).toBeNull();
    expect(row(ginger, "season")).toMatchObject({ value: NOT_SOURCED, chip: null });
    expect(row(ginger, "window")).toMatchObject({ value: NOT_SOURCED, chip: null, note: null });
    expect(row(ginger, "water")).toMatchObject({ value: NOT_SOURCED, chip: null });
  });
  it("a duration from the sum of sourced stage durations stays 'sourced' even without a regional context", () => {
    expect(row(byName("Ginger"), "duration")).toMatchObject({ value: "210 to 240 days", chip: "sourced" });
  });
  it("water need is shown only when a water-need class is sourced; the irrigation of a source record is not a need", () => {
    const turmeric = byName("Turmeric");
    const sourced = withDims(turmeric, {
      waterFit: { status: "known", basis: "water_need_class", missingReason: null, evidenceIds: ["e1"], value: { fit: "partial", waterNeedClass: "medium", farmerIrrigation: "rainfed" } },
    });
    expect(row(sourced, "water")).toMatchObject({ value: "Medium water need", chip: "sourced", note: "Partial match with water access" });
    const irrigationOnly = withDims(turmeric, {
      waterFit: { status: "known", basis: "source_context_irrigation_not_water_requirement", missingReason: null, evidenceIds: ["e2"], value: { fit: "matches", sourceContextIrrigation: "irrigated", farmerIrrigation: "irrigated" } },
    });
    expect(row(irrigationOnly, "water")).toMatchObject({ value: NOT_SOURCED, chip: null, note: "Matches water access" });
  });
  it("a single duration figure reads as one number of days", () => {
    const turmeric = byName("Turmeric");
    const one = withDims(turmeric, { timeToFirstIncome: { ...turmeric.dimensions.timeToFirstIncome, value: { minDays: 120, maxDays: 120 } } });
    expect(row(one, "duration").value).toBe("120 days");
  });
  it("every chip has an explanation for its tooltip", () => {
    expect(Object.keys(CHIP_TITLE).sort()).toEqual(["estimate", "sourced", "state window"]);
  });
});
