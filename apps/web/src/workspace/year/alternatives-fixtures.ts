import type { YearPlanOccupant, YearPlanOption, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { FIXTURE_SAVED_SEASON_ID, bestOverallV2, fullYearReview, savedSeasonOccupant, soilEnrichmentV2 } from "./fixtures";
import type { YearPlanAlternatives } from "./model";

/**
 * SYNTHETIC fixtures for the alternatives of a year its planned seasons (or the sown crop) fill (EVARA_ACTIONS_SPEC.md 1.3).
 * Shapes follow `YearPlanAlternatives`, `YearPlanOccupant.realisation` and `YearPlanReview.alternatives`; the tests parse
 * them with the shared contract. Dates and figures are invented for layout and state tests.
 */
export const PLANNED_PIGEON_PEA: YearPlanOccupant = { ...savedSeasonOccupant, realisation: "planned" };
export const OVERDUE_MAIZE: YearPlanOccupant = {
  ...savedSeasonOccupant,
  id: "season-overdue-maize",
  cropId: "maize",
  productId: "maize-grain",
  cropName: "Maize",
  productName: "Grain",
  sowing: "2026-10-20",
  harvestDate: "2027-02-10",
  occupancy: { from: "2026-10-20", to: "2027-02-20" },
  realisation: "overdue",
};
export const SOWN_COTTON: YearPlanOccupant = {
  ...savedSeasonOccupant,
  id: "season-sown-cotton",
  cropId: "cotton",
  productId: "cotton-kapas",
  cropName: "Cotton",
  productName: "Kapas",
  sowing: "2027-06-20",
  harvestDate: "2027-12-01",
  occupancy: { from: "2027-06-20", to: "2027-12-11" },
  realisation: "sown",
};

const growingPaddy = fullYearReview.options[0]!.slots.find((s) => s.fixed)!;
const later = (base: YearPlanSlot, slotId: string, sowing: string, earliest: string, latest: string, to: string): YearPlanSlot => ({
  ...base,
  slotId,
  fixed: false,
  sowing,
  harvest: { earliest, latest },
  occupancy: { from: sowing, to },
});

/** Replaces the planned pigeon pea (16 May to 8 Sep 2027): the new crop is sown on 20 May and overlaps it. */
export const ALT_MAIZE: YearPlanOption = {
  ...bestOverallV2,
  optionId: "alt-1",
  label: "Maize in kharif",
  origin: "deterministic",
  slots: [growingPaddy, later(bestOverallV2.slots[1]!, "alt-1-maize", "2027-05-20", "2027-09-10", "2027-09-25", "2027-10-05")],
  gaps: [],
  editable: false,
};
export const ALT_BLACK_GRAM: YearPlanOption = {
  ...soilEnrichmentV2,
  optionId: "alt-2",
  label: "Black gram in kharif",
  origin: "deterministic",
  slots: [growingPaddy, later(soilEnrichmentV2.slots[1]!, "alt-2-black-gram", "2027-06-01", "2027-08-10", "2027-08-25", "2027-09-05")],
  gaps: [],
  editable: false,
};
/** A comparison plan starts at the growing crop's sowing date and has no fixed slot. */
export const CMP_OPTION: YearPlanOption = {
  ...bestOverallV2,
  optionId: "alt-1",
  label: "From sowing day",
  origin: "deterministic",
  slots: [later(bestOverallV2.slots[1]!, "alt-1-maize", "2026-10-31", "2027-02-20", "2027-03-05", "2027-03-15")],
  gaps: [],
  editable: false,
};

export const REPLACE_ALTERNATIVES: YearPlanAlternatives = {
  basis: "replace_planned",
  summary: "Pigeon pea is planned for 16 May 2027 but not sown, so these plans use that time instead.",
  replaces: [{ rotationPlanId: FIXTURE_SAVED_SEASON_ID, cropId: "pigeon-pea", cropName: "Pigeon pea", plannedSowingDate: "2027-05-16" }],
  horizon: fullYearReview.scenario.horizon,
  options: [ALT_MAIZE, ALT_BLACK_GRAM],
  limitations: ["Synthetic fixture: alternatives are calculated by code, not chosen by AI."],
};
export const COMPARISON_ALTERNATIVES: YearPlanAlternatives = {
  basis: "sown_comparison",
  summary: "This compares what could have fitted the field from 31 Oct 2026. The paddy you sowed stays.",
  replaces: [],
  horizon: fullYearReview.scenario.horizon,
  options: [CMP_OPTION],
  limitations: [],
};

/** Paddy growing, a planned pigeon pea after it that nothing realises: two alternatives that replace it. */
export const replaceReview: YearPlanReview = {
  ...fullYearReview,
  scenario: { ...fullYearReview.scenario, occupied: [PLANNED_PIGEON_PEA] },
  alternatives: REPLACE_ALTERNATIVES,
};
/** Paddy growing and every other season sown: nothing is replaceable, so the alternatives are for comparison only. */
export const comparisonReview: YearPlanReview = {
  ...fullYearReview,
  scenario: { ...fullYearReview.scenario, occupied: [SOWN_COTTON] },
  alternatives: COMPARISON_ALTERNATIVES,
};
