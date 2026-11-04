import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { StageTimeline, YearPlanReview } from "@harvest/contracts";
import { occupiedReview, savedSeasonOccupant } from "./fixtures";
import {
  chosenOption,
  currentSpan,
  fieldStripMonths,
  fixedTarget,
  monthLabel,
  nextMonthKey,
  planSpans,
  savedSpans,
  seasonMonths,
  stageWord,
  stripAnchor,
  stripRangeText,
  stripSummary,
  type StripMonth,
} from "./seasonStripModel";
import { SeasonStrip, SeasonStripCompact } from "./SeasonStrip";

const TODAY = "2026-11-04";
const ANCHOR = "2026-11-01";
const name = (id: string) => id;
const word = (months: StripMonth[], key: string) => months.find((m) => m.key === key)!;

/** SYNTHETIC timeline: shaped like the real route's answer, values invented for the test. */
const timeline: StageTimeline = {
  cropId: "ginger",
  productId: null,
  establishmentMethod: null,
  anchorDate: "2026-10-01",
  stages: [
    { id: "est", name: "Establishment", from: "2026-10-01", to: "2026-11-30", basis: "estimate" },
    { id: "veg", name: "Vegetative growth", from: "2026-12-01", to: "2027-02-28", basis: "estimate" },
    { id: "bulk", name: "Rhizome bulking", from: "2027-03-01", to: "2027-05-31", basis: "estimate" },
  ],
  harvest: { earliest: "2027-06-15", latest: "2027-07-20" },
  basis: { kind: "duration", label: "Synthetic", sourceId: null, url: null, scope: null, note: null },
};

describe("season strip: the twelve months", () => {
  it("starts at the current month and spans twelve months across the year end", () => {
    const months = seasonMonths([], ANCHOR, TODAY);
    expect(months.map((m) => m.key)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10"]);
    expect(stripRangeText(months)).toBe("Nov 2026 to Oct 2027");
  });
  it("a month with nothing under it rests: hollow, no crop, no basis and never a task", () => {
    const months = seasonMonths([], ANCHOR, TODAY);
    for (const m of months) expect(m).toMatchObject({ kind: "rest", word: "Field rests", crop: null, basis: null, covered: false, target: null });
    expect(months[0]!.text).toBe("Field rests · no crop recorded, saved or planned this month");
  });
  it("anchors a later horizon at its own start and the current one at the current month", () => {
    expect(stripAnchor("2026-11-18", { kind: "occupied", horizon: { from: "2026-09-01", to: "2027-09-01" }, yearIndex: 0 })).toBe("2026-11-01");
    expect(stripAnchor("2026-11-18", undefined)).toBe("2026-11-01");
    expect(stripAnchor("2026-11-18", { kind: "future", horizon: { from: "2027-10-31", to: "2028-10-31" }, yearIndex: 1 })).toBe("2027-10-01");
  });
});

describe("season strip: the growing crop", () => {
  const span = currentSpan({ fixedSlot: null, timeline, cropName: "Ginger", target: null })!;
  const months = seasonMonths([span], ANCHOR, TODAY);
  it("labels Grow, Bulk and Harvest from the stage timeline and the harvest window", () => {
    expect(word(months, "2026-11")).toMatchObject({ word: "Grow", kind: "current", covered: true, text: "Grow · Ginger (Establishment)" });
    expect(word(months, "2027-01").word).toBe("Grow");
    expect(word(months, "2027-04")).toMatchObject({ word: "Bulk", text: "Bulk · Ginger (Rhizome bulking)" });
    expect(word(months, "2027-06")).toMatchObject({ word: "Harvest", text: "Harvest window · Ginger, estimated 15 Jun to 20 Jul 2027", basis: "estimate" });
    expect(word(months, "2027-07").word).toBe("Harvest");
  });
  it("rests after the harvest window ends and never extends the crop past it", () => {
    expect(word(months, "2027-08")).toMatchObject({ kind: "rest", covered: false });
    expect(word(months, "2027-10").covered).toBe(false);
  });
  it("without a timeline the plan's fixed slot labels Grow until its harvest window, then Harvest, and says Recorded", () => {
    const fixed = occupiedReview.options[0]!.slots.find((s) => s.fixed)!;
    const slotOnly = currentSpan({ fixedSlot: fixed, timeline: null, cropName: "Paddy", target: null })!;
    const sep = seasonMonths([slotOnly], "2026-09-01", "2026-09-15");
    expect(word(sep, "2026-09")).toMatchObject({ word: "Grow", basis: "recorded", text: "Grow · Paddy" });
    expect(word(sep, "2026-11")).toMatchObject({ word: "Harvest", basis: "estimate", text: "Harvest window · Paddy, estimated 10 to 18 Nov 2026" });
    expect(word(sep, "2026-12").kind).toBe("rest");
  });
  it("ignores a timeline built for another crop and has nothing to draw without a slot or a usable timeline", () => {
    const fixed = occupiedReview.options[0]!.slots.find((s) => s.fixed)!;
    expect(currentSpan({ fixedSlot: fixed, timeline, cropName: "x", target: null })!.timeline).toBeNull();
    expect(currentSpan({ fixedSlot: null, timeline: null, cropName: "x", target: null })).toBeNull();
    expect(currentSpan({ fixedSlot: null, timeline: { ...timeline, stages: [], harvest: null }, cropName: "x", target: null })).toBeNull();
  });
  it("picks the short word from the stage name", () => {
    expect(stageWord("Rhizome bulking")).toBe("Bulk");
    expect(stageWord("Grain filling")).toBe("Bulk");
    expect(stageWord("Tillering")).toBe("Grow");
    expect(stageWord(null)).toBe("Grow");
  });
});

describe("season strip: saved seasons", () => {
  const seasons = [
    { id: "s1", cropId: "maize", cropName: "Maize", plannedSowingDate: "2026-12-10", plannedHarvestDate: "2027-03-20" },
    { id: "nodate", cropId: "onion", cropName: "Onion" },
  ];
  const months = seasonMonths(savedSpans(seasons, undefined, name), ANCHOR, TODAY);
  it("reads Sow, Grow and Harvest from the planned dates and leaves out a season without a sowing date", () => {
    expect(word(months, "2026-11").kind).toBe("rest");
    expect(word(months, "2026-12")).toMatchObject({ word: "Sow", basis: "saved", crop: "Maize", text: "Sow · Maize, planned 10 Dec 2026" });
    expect(word(months, "2027-01").word).toBe("Grow");
    expect(word(months, "2027-03")).toMatchObject({ word: "Harvest", text: "Harvest · Maize, planned 20 Mar 2027" });
    expect(word(months, "2027-04").kind).toBe("rest");
    expect(months.some((m) => m.crop === "Onion")).toBe(false);
  });
  it("a saved season targets its occupant when the plan lists it, else the Saved seasons list", () => {
    const withOccupant = savedSpans([{ id: savedSeasonOccupant.id, cropId: "pigeon-pea", cropName: "Pigeon pea", plannedSowingDate: "2027-05-16" }], [savedSeasonOccupant], name)[0]!;
    expect(withOccupant.target).toEqual({ kind: "occupant", occupantId: savedSeasonOccupant.id });
    // Without a farmer harvest date in the list, the occupant's harvest date and occupancy fill the end.
    expect(withOccupant).toMatchObject({ harvestDate: "2027-08-29", to: "2027-08-29" });
    expect(savedSpans(seasons, undefined, name)[0]!.target).toEqual({ kind: "season", seasonId: "s1" });
  });
  it("without a harvest date or an occupant only the sowing month is drawn, not an invented duration", () => {
    const m = seasonMonths(savedSpans([{ id: "x", cropId: "ragi", cropName: "Ragi", plannedSowingDate: "2027-01-05" }], undefined, name), ANCHOR, TODAY);
    expect(m.filter((x) => x.covered).map((x) => x.key)).toEqual(["2027-01"]);
  });
  it("recorded crops and the assumed plan come from the review: Recorded and Estimate chips, the assumption said", () => {
    const recorded = { ...savedSeasonOccupant, id: "rec", source: "recorded_cycle" as const };
    const assumed = { ...savedSeasonOccupant, id: "assumed:r", source: "assumed_plan" as const, sowing: "2027-05-16" };
    const spans = savedSpans([], [recorded, assumed], name);
    expect(spans.map((s) => s.basis)).toEqual(["recorded", "estimate"]);
    expect(seasonMonths([spans[1]!], ANCHOR, TODAY).find((m) => m.key === "2027-06")!.text).toBe("Grow · Pigeon pea (assumed from last year's plan)");
  });
});

describe("season strip: the generated plan", () => {
  const model: YearPlanReview = { ...occupiedReview, appliedOptionIds: [] };
  it("draws the Best overall option's new crops with Planned and the AI plan chip when Meta chose it", () => {
    const spans = planSpans(model);
    expect(spans.map((s) => s.cropName)).toEqual(["Maize", "Green gram"]);
    const m = word(seasonMonths(spans, "2026-09-01", TODAY), "2027-01");
    expect(m).toMatchObject({ word: "Planned", kind: "plan", basis: "ai_plan", crop: "Maize" });
    expect(m.target).toMatchObject({ kind: "slot", optionId: "opt-best-overall" });
  });
  it("a calculated option is an Estimate, not an AI plan; the applied option wins over Best overall", () => {
    const calculated: YearPlanReview = { ...model, options: model.options.map((o) => ({ ...o, origin: "deterministic" as const })) };
    expect(planSpans(calculated).every((s) => s.basis === "estimate")).toBe(true);
    const applied: YearPlanReview = { ...model, appliedOptionIds: ["opt-lowest-water"] };
    expect(chosenOption(model)?.optionId).toBe("opt-best-overall");
    expect(chosenOption(applied)?.optionId).toBe("opt-lowest-water");
    expect(planSpans(applied)[0]!.target).toMatchObject({ optionId: "opt-lowest-water" });
    expect(chosenOption({ options: [], appliedOptionIds: [] })).toBeNull();
    expect(planSpans(undefined)).toEqual([]);
  });
  it("the growing crop's slot of the chosen option is the Open target for its months", () => {
    const { slot, target } = fixedTarget(model);
    expect(slot?.fixed).toBe(true);
    expect(target).toMatchObject({ kind: "slot", optionId: "opt-best-overall", slotId: slot!.slotId });
  });
});

describe("season strip: which source a month shows", () => {
  const cur = currentSpan({ fixedSlot: null, timeline: { ...timeline, harvest: { earliest: "2026-11-10", latest: "2026-11-20" }, stages: [{ id: "a", name: "Growth", from: "2026-10-01", to: "2026-11-09", basis: "estimate" }] }, cropName: "Ginger", target: null })!;
  it("the source with most days in the month wins: a crop harvested on the 20th beats one sown on the 25th", () => {
    const saved = savedSpans([{ id: "n", cropId: "maize", cropName: "Maize", plannedSowingDate: "2026-11-25", plannedHarvestDate: "2027-03-01" }], undefined, name);
    expect(word(seasonMonths([cur, ...saved], ANCHOR, TODAY), "2026-11").crop).toBe("Ginger");
    expect(word(seasonMonths([cur, ...saved], ANCHOR, TODAY), "2026-12").crop).toBe("Maize");
  });
  it("on equal days the growing crop beats a saved season, and a saved season beats the plan", () => {
    const a = { kind: "saved" as const, cropName: "Saved", from: "2027-01-01", to: "2027-01-31", harvestDate: null, basis: "saved" as const, assumed: false, target: null };
    const b = { kind: "plan" as const, cropName: "Planned crop", from: "2027-01-01", to: "2027-01-31", basis: "ai_plan" as const, target: null };
    expect(word(seasonMonths([b, a], ANCHOR, TODAY), "2027-01").crop).toBe("Saved");
    const c = { ...cur, from: "2027-01-01", to: "2027-01-31", timeline: null, harvest: null };
    expect(word(seasonMonths([a, c], ANCHOR, TODAY), "2027-01").crop).toBe("Ginger");
  });
  it("Plans by field strip: timeline plus the field's saved seasons, no plan read", () => {
    const months = fieldStripMonths({ cycleName: "Ginger", timeline, seasons: [{ id: "s", cropId: "maize", cropName: "Maize", plannedSowingDate: "2027-08-20", plannedHarvestDate: "2027-10-15" }], todayIso: TODAY, cropName: name });
    expect(months.map((m) => m.word)).toEqual(["Grow", "Grow", "Grow", "Grow", "Bulk", "Bulk", "Bulk", "Harvest", "Harvest", "Sow", "Grow", "Harvest"]);
    expect(months.some((m) => m.kind === "plan")).toBe(false);
  });
});

describe("season strip: keyboard and wording", () => {
  const months = seasonMonths([], ANCHOR, TODAY);
  it("arrow keys, Home and End move the radio; the ends hold; other keys are left alone", () => {
    expect(nextMonthKey(months, "2026-11", "ArrowRight")).toBe("2026-12");
    expect(nextMonthKey(months, "2026-11", "ArrowLeft")).toBe("2026-11");
    expect(nextMonthKey(months, "2027-10", "ArrowRight")).toBe("2027-10");
    expect(nextMonthKey(months, "2027-03", "Home")).toBe("2026-11");
    expect(nextMonthKey(months, "2027-03", "End")).toBe("2027-10");
    expect(nextMonthKey(months, "2027-03", "Enter")).toBeNull();
  });
  it("a month's accessible name starts with its visible text, and the summary joins runs", () => {
    const span = currentSpan({ fixedSlot: null, timeline, cropName: "Ginger", target: null })!;
    const m = seasonMonths([span], ANCHOR, TODAY);
    expect(monthLabel(m[0]!)).toBe("Nov 2026, Grow, Ginger. Estimate");
    expect(monthLabel(seasonMonths([], ANCHOR, TODAY)[0]!)).toBe("Nov 2026, Field rests");
    expect(stripSummary(m)).toBe("Nov to Feb: Grow Ginger; Mar to May: Bulk Ginger; Jun to Jul: Harvest Ginger; Aug to Oct: Field rests");
    expect(stripSummary(seasonMonths([], ANCHOR, TODAY))).toBe("Nov to Oct: Field rests");
  });
});

describe("season strip: markup", () => {
  const span = currentSpan({ fixedSlot: null, timeline, cropName: "Ginger", target: { kind: "slot", optionId: "o", slotId: "s" } })!;
  const months = seasonMonths([span], ANCHOR, TODAY);
  const html = renderToString(() => <SeasonStrip months={months} onOpen={() => undefined} />).replace(/<!--[^>]*-->/g, "");
  it("is a radiogroup of twelve radios with one tab stop, the first month selected, and a detail card with the basis chip", () => {
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(12);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain("Grow · Ginger (Establishment)");
    expect(html).toContain("Estimate");
    expect(html).toContain("Open in the plan");
  });
  it("shows no action when the month has no target, and the compact strip is one labelled image", () => {
    const rest = renderToString(() => <SeasonStrip months={seasonMonths([], ANCHOR, TODAY)} onOpen={() => undefined} />);
    expect(rest).not.toContain("season-strip-open");
    const compact = renderToString(() => <SeasonStripCompact months={months} fieldName="North strip" />);
    expect(compact).toContain('role="img"');
    expect(compact).toContain("North strip, next twelve months.");
  });
});
