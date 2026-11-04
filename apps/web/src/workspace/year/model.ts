import type {
  ApplyYearPlan,
  CostEstimate,
  CropFitCandidate,
  IntercropCompanion,
  NumberRange,
  PriceEstimate,
  RescoreYearPlan,
  YearPlanOccupant,
  YearPlanOption,
  YearPlanReview,
  YearPlanScenario,
  YearPlanSlot,
} from "@harvest/contracts";
import type { CropSummary } from "../../features/comparison/types";
import { seasonForMonth } from "../farm/cropFitModel";
import type { Rotation } from "../state";
import { addDaysIso, addYearsIso, formatAreaHa, formatInrBand, formatInrRange, formatKgRange, longDate, monthYear, partOfMonth, shortSpan } from "./format";

/** Pure view-model logic for the Year plan: no Solid, no fetch. */

/** Derived from the review: the contracts export the schemas of these two but not their types (2026-11-04). */
export type YearPlanAlternatives = NonNullable<YearPlanReview["alternatives"]>;
export type YearPlanReplacement = YearPlanAlternatives["replaces"][number];

import { POOL_CROPS, ROLE_LABEL, ROLE_ORDER, isLegume, type RoleGroup, type RotationRole } from "../cropPool";

/** The pool table lives in ../cropPool.ts (shared with the planting dialog); re-exported for existing importers. */
export { POOL_CROPS, ROLE_LABEL, ROLE_ORDER, isLegume };
export type { RoleGroup, RotationRole };

/** Editor groups: the pool's rotation roles, plus green manure (grown and ploughed in; no product, no price). */
export type ChoiceRole = RoleGroup | "green_manure";
export const GROUP_ORDER: readonly ChoiceRole[] = [
  "nitrogen_fixer",
  "light_feeder",
  "moderate_feeder",
  "heavy_feeder",
  "green_manure",
  "other",
];
export const GROUP_LABEL: Record<ChoiceRole, string> = { ...ROLE_LABEL, green_manure: "Green manure" };

export interface CropChoice {
  cropId: string;
  name: string;
  role: ChoiceRole;
  products: { productId: string; name: string }[];
}

/**
 * Green manure ids the server's research file defines (data/research/rotation/green-manure.json). Offered in the editor
 * only when the review carries no green manure slot to read the ids from.
 */
export const FALLBACK_GREEN_MANURE: readonly { cropId: string; name: string }[] = [
  { cropId: "gm-dhaincha", name: "Dhaincha" },
  { cropId: "gm-sunn-hemp", name: "Sunn hemp" },
  { cropId: "gm-cowpea", name: "Cowpea (green manure)" },
];

export const isGreenManure = (slot: Pick<YearPlanSlot, "kind">) => slot.kind === "green_manure";
/** "Cowpea (green manure)" -> "Cowpea": the strip already says "Green manure". */
export const greenManureName = (name: string) => name.replace(/\s*\(green manure\)\s*$/i, "").trim() || name;
/** {60, 80} -> "+N 60 to 80 kg/ha"; null when the server gave no credit. */
export function nitrogenCreditText(range: { low: number; high: number } | null | undefined): string | null {
  if (!range) return null;
  const low = Math.round(Math.min(range.low, range.high));
  const high = Math.round(Math.max(range.low, range.high));
  return low === high ? `+N ${low} kg/ha` : `+N ${low} to ${high} kg/ha`;
}

/**
 * Crops the farmer may pick when editing a plan: the scoring pool, limited to crops this farm can name (present in the
 * review's slots or in the crop catalogue). A crop the server already placed in a plan but which is missing from the
 * local pool table is kept under "Other crops in this plan", since the server scored it. Product names come from the
 * review first, then the catalogue, then the id.
 */
export function cropChoices(
  review: Pick<YearPlanReview, "options"> | undefined,
  catalogue: readonly CropSummary[] | undefined,
): CropChoice[] {
  const seen = new Map<string, { name: string; products: Map<string, string> }>();
  const manures = new Map<string, string>();
  for (const option of review?.options ?? [])
    for (const slot of option.slots) {
      if (isGreenManure(slot)) {
        manures.set(slot.cropId, slot.cropName);
        continue;
      }
      const entry = seen.get(slot.cropId) ?? { name: slot.cropName, products: new Map<string, string>() };
      entry.products.set(slot.productId, slot.productName);
      seen.set(slot.cropId, entry);
    }
  const choices: CropChoice[] = [];
  for (const [cropId, pool] of Object.entries(POOL_CROPS)) {
    const fromReview = seen.get(cropId);
    const fromCatalogue = catalogue?.find((c) => c.cropId === cropId);
    if (!fromReview && !fromCatalogue) continue;
    choices.push({
      cropId,
      name: fromReview?.name ?? fromCatalogue!.name,
      role: pool.role,
      products: pool.productIds.map((productId) => ({
        productId,
        name:
          fromReview?.products.get(productId) ??
          fromCatalogue?.products.find((p) => p.productId === productId)?.name ??
          productId,
      })),
    });
  }
  for (const [cropId, entry] of seen)
    if (!POOL_CROPS[cropId])
      choices.push({
        cropId,
        name: entry.name,
        role: "other",
        products: [...entry.products].map(([productId, name]) => ({ productId, name })),
      });
  // Green manure: the ids the review already uses, else the three the server's research file defines.
  const manureList = manures.size ? [...manures].map(([cropId, name]) => ({ cropId, name })) : FALLBACK_GREEN_MANURE;
  for (const m of manureList)
    choices.push({ cropId: m.cropId, name: m.name, role: "green_manure", products: [{ productId: m.cropId, name: m.name }] });
  return choices.sort(
    (a, b) => GROUP_ORDER.indexOf(a.role) - GROUP_ORDER.indexOf(b.role) || a.name.localeCompare(b.name),
  );
}

/** Reducer step after a re-score: the edited option is replaced in place (same position), everything else unchanged. */
export function replaceOption(review: YearPlanReview, optionId: string, next: YearPlanOption): YearPlanReview {
  if (!review.options.some((o) => o.optionId === optionId)) return review;
  return {
    ...review,
    options: review.options
      .filter((o) => o.optionId === optionId || o.optionId !== next.optionId)
      .map((o) => (o.optionId === optionId ? next : o)),
  };
}

export const isActive = (review: Pick<YearPlanReview, "status">) =>
  review.status === "pending" || review.status === "running";

/**
 * A review that answers the rebuild after a swap: a plan (ready or partial), or the server's own answer that no space is
 * left (`noFreeWindow`, which a fully taken fresh or later year reports as `unavailable` with no options). An error or any
 * other unavailable review is not a rebuilt plan.
 */
export const planRebuilt = (review: Pick<YearPlanReview, "status" | "noFreeWindow">) =>
  review.status === "ready" || review.status === "partial" || (review.status === "unavailable" && review.noFreeWindow === true);

/** Nothing generated yet for this farm: the view asks the server to build a plan once per load. */
export const needsGeneration = (review: Pick<YearPlanReview, "status" | "reviewId" | "options">) =>
  !isActive(review) && review.reviewId === null && review.options.length === 0;

/** Model name for the activity indicator; only the resolved model, never the requested one. */
export const planningModel = (review: Pick<YearPlanReview, "modelInvocation">) =>
  review.modelInvocation?.model ?? null;

/**
 * The options on screen were built by code alone (provider failed, unavailable, or not used). This origin-based rule is
 * only the fallback for plans stored before `modelSelection` existed; `selectionStatus` prefers the recorded outcome.
 */
export const modelUnavailable = (review: Pick<YearPlanReview, "status" | "options">) =>
  review.options.length > 0 &&
  !isActive(review) &&
  (review.status === "unavailable" ||
    review.status === "error" ||
    review.options.every((o) => o.origin === "deterministic"));

export const MODEL_UNAVAILABLE_CHIP = "Model unavailable, showing calculated plans";

/** "Planned seasons fill the year · 2 alternatives" or "Sown · 1 comparison plan" (replaces "No space for another crop"). */
export function alternativesChip(alternatives: Pick<YearPlanAlternatives, "basis" | "options">): string {
  const n = alternatives.options.length;
  return alternatives.basis === "replace_planned"
    ? `Planned seasons fill the year · ${n} ${n === 1 ? "alternative" : "alternatives"}`
    : `Sown · ${n} comparison ${n === 1 ? "plan" : "plans"}`;
}

export interface SelectionStatus {
  chip: string;
  tone: "watch" | "neutral";
  /** One sentence under the chips; null when the chip says enough. */
  line: string | null;
}

/**
 * "Your saved seasons fill the months after the growing crop, so no new crop fits." in the words the occupants allow: a
 * saved season is edited here (swap it, or change it in Saved seasons), a recorded crop in Farm details, and last year's
 * assumed plan by saving or changing that plan. The sentence names only what is actually present among
 * `scenario.occupied`, so a field held by recorded crops is never said to be held by saved seasons.
 */
function noSpaceLine(review: Pick<YearPlanReview, "options" | "scenario">): string {
  const present = new Set((review.scenario.occupied ?? []).map((o) => o.source));
  const afterGrowing = review.scenario.kind === "occupied";
  const span = afterGrowing ? "the months after the growing crop" : "this year";
  if (present.has("saved_season"))
    return `Your saved seasons fill ${span}, so no new crop fits. ${review.options.length > 0 ? "Swap a saved crop to change the year." : "Edit them in Saved seasons below."}`;
  if (present.has("recorded_cycle")) return `Your recorded crops fill ${span}, so no new crop fits.`;
  if (present.has("assumed_plan")) return "Last year's plan fills this year, so no new crop fits. Save or change that plan to change this.";
  // Nothing listed: the growing crop alone leaves no window (an occupied field), or no month is left.
  return afterGrowing
    ? "The growing crop leaves no free months for another crop, so no new crop fits."
    : "No free months are left this year, so no new crop fits.";
}

/**
 * The chip (and line) that says how the plans on screen were chosen. `noFreeWindow` decides first, whatever the model
 * outcome: the server marks a fresh or later year that saved seasons fill completely as status `unavailable` with no
 * `modelSelection` and no options, and that state still needs the chip and the line. Otherwise only the recorded
 * outcome decides: Meta being skipped by design (fewer than three sequences fit) is not a failure and never reads
 * "Model unavailable". Plans stored before `modelSelection` existed fall back to the origin-based rule. A pending or
 * running review shows the "Planning…" chip instead, and a review without any plan to show has nothing to describe.
 */
export function selectionStatus(
  review: Pick<YearPlanReview, "status" | "options" | "scenario" | "modelSelection" | "noFreeWindow" | "alternatives">,
): SelectionStatus | null {
  if (isActive(review)) return null;
  // 2026-11-04 (EVARA_ACTIONS_SPEC.md 1.3): alternatives exist, so the year is not a dead end; the server's own summary is the line.
  const alternatives = review.alternatives;
  if (alternatives && alternatives.options.length > 0)
    return { chip: alternativesChip(alternatives), tone: "neutral", line: alternatives.summary };
  if (review.noFreeWindow) return { chip: "No space for another crop", tone: "neutral", line: noSpaceLine(review) };
  const selection = review.modelSelection;
  if (!selection) return modelUnavailable(review) ? { chip: MODEL_UNAVAILABLE_CHIP, tone: "watch", line: null } : null;
  const shown = review.options.length;
  switch (selection.outcome) {
    case "model":
      return null;
    case "failed":
    case "not_configured":
    case "cancelled":
      return shown > 0 ? { chip: MODEL_UNAVAILABLE_CHIP, tone: "watch", line: null } : null;
    case "not_used":
      return shown > 0 ? { chip: "Calculated plans · AI not used in this mode", tone: "neutral", line: null } : null;
    case "not_needed":
      if (shown === 1) return { chip: "Only one plan fits", tone: "neutral", line: null };
      if (shown === 2) return { chip: "Only two plans fit", tone: "neutral", line: null };
      return null;
  }
}

export const displayLabel = (option: Pick<YearPlanOption, "origin" | "label">) =>
  option.origin === "farmer_edit" ? "Your version" : option.label;
export const editedFrom = (option: Pick<YearPlanOption, "origin" | "label">) =>
  option.origin === "farmer_edit" && option.label !== "Your version" ? option.label : null;

export const isApplied = (review: Pick<YearPlanReview, "appliedOptionIds">, optionId: string) =>
  review.appliedOptionIds.includes(optionId);

/** Seasons that applying an option adds: every slot except the crop already growing. */
export const slotsToApply = (option: Pick<YearPlanOption, "slots">) => option.slots.filter((s) => !s.fixed);

/**
 * "Sep 2026 to Sep 2027 · Paddy growing until mid-Nov" or "Starting fresh from today · last crop maize".
 * `cropName` resolves the previous crop id when no slot names it.
 */
export function scenarioText(
  scenario: YearPlanScenario,
  options: readonly YearPlanOption[],
  todayIso: string,
  cropName: (cropId: string) => string,
): string {
  if (scenario.kind === "occupied") {
    const fixed = options.flatMap((o) => o.slots).find((s) => s.fixed);
    const span = `${monthYear(scenario.horizon.from)} to ${monthYear(scenario.horizon.to)}`;
    return fixed
      ? `${span} · ${fixed.cropName} growing until ${partOfMonth(fixed.harvest.latest)}`
      : `${span} · current crop still growing`;
  }
  if (scenario.kind === "future") {
    const span = `${monthYear(scenario.horizon.from)} to ${monthYear(scenario.horizon.to)}`;
    return `${span} · ${predecessorText(scenario, cropName)}`;
  }
  const start =
    scenario.horizon.from === todayIso ? "Starting fresh from today" : `Starting fresh from ${monthYear(scenario.horizon.from)}`;
  if (!scenario.previousCropId) return start;
  const named =
    options.flatMap((o) => o.slots).find((s) => s.cropId === scenario.previousCropId)?.cropName ??
    cropName(scenario.previousCropId);
  return `${start} · last crop ${named.toLowerCase()}`;
}

/**
 * What a later horizon follows (round 3): the previous plan's first option when nothing is recorded or saved, else the
 * recorded or saved crop. The "not saved yet" wording is the server's own summary line, repeated here so it stays
 * visible above the calendar.
 */
export function predecessorText(scenario: YearPlanScenario, cropName: (cropId: string) => string): string {
  const p = scenario.assumedPredecessor;
  if (!p) {
    return scenario.previousCropId
      ? `Follows ${cropName(scenario.previousCropId).toLowerCase()}`
      : "The crop before this year is not known yet; open the year before and make a plan first";
  }
  const crop = p.cropName.toLowerCase();
  if (p.basis === "year_plan_option") {
    const label = p.optionLabel ?? "first";
    const span = p.horizonFrom ? `${monthYear(p.horizonFrom)} to ${monthYear(scenario.horizon.from)}` : "the year before";
    return `Follows the ${label} plan for ${span} (not saved yet; save a plan to fix the order) · after ${crop}`;
  }
  if (p.basis === "saved_season") return `Follows your saved season of ${crop}`;
  if (p.basis === "current_cycle") return `Follows the ${crop} growing now`;
  return `Follows the ${crop} you harvested last`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Horizons (round 3): the pager steps one 12-month horizon at a time; year index 0 is the current horizon, which the
// server serves without a `from`.

export type HorizonNavigation = NonNullable<YearPlanReview["navigation"]>;

/** The `from` to request for the horizon a navigation describes: none for the current horizon. */
export const horizonQuery = (nav: HorizonNavigation): string | undefined => (nav.yearIndex === 0 ? undefined : nav.from);

/**
 * One step of the pager: the `from` to ask the server for and the navigation to show while that answer is on its way
 * (the server's own navigation replaces it). Null when there is no horizon in that direction.
 */
export function horizonStep(
  nav: HorizonNavigation,
  direction: "previous" | "next",
): { from: string | undefined; navigation: HorizonNavigation } | null {
  if (direction === "previous") {
    if (!nav.previousFrom || nav.yearIndex <= 0) return null;
    const yearIndex = nav.yearIndex - 1;
    const navigation: HorizonNavigation = {
      from: nav.previousFrom,
      previousFrom: yearIndex > 0 ? addYearsIso(nav.previousFrom, -1) : null,
      nextFrom: nav.from,
      yearIndex,
      maxYearIndex: nav.maxYearIndex,
    };
    return { from: horizonQuery(navigation), navigation };
  }
  if (!nav.nextFrom || nav.yearIndex >= nav.maxYearIndex) return null;
  const yearIndex = nav.yearIndex + 1;
  const navigation: HorizonNavigation = {
    from: nav.nextFrom,
    previousFrom: nav.from,
    nextFrom: yearIndex < nav.maxYearIndex ? addYearsIso(nav.nextFrom, 1) : null,
    yearIndex,
    maxYearIndex: nav.maxYearIndex,
  };
  return { from: horizonQuery(navigation), navigation };
}

// ---------------------------------------------------------------------------------------------------------------------
// Intercrops (round 3)

export const isIntercrop = (slot: Pick<YearPlanSlot, "kind" | "companion">) => slot.kind === "intercrop" && !!slot.companion;
/** "pigeon pea · 8:1" */
/** "pigeon pea · 4:1"; the ratio is left out when the source did not state one ("not stated"). */
export const companionLabel = (c: Pick<IntercropCompanion, "cropName" | "rowRatio">) =>
  ratioStated(c.rowRatio) ? `${c.cropName.toLowerCase()} · ${c.rowRatio}` : c.cropName.toLowerCase();
export const ratioStated = (ratio: string | null | undefined) => !!ratio && !/^not stated$/i.test(ratio.trim());
/** "Finger millet + pigeon pea · 8:1"; the plain crop name for a sole crop. */
export const intercropName = (slot: Pick<YearPlanSlot, "kind" | "companion" | "cropName">) =>
  slot.companion && slot.kind === "intercrop" ? `${slot.cropName} + ${companionLabel(slot.companion)}` : slot.cropName;

const percent = (n: number) => Math.round(n * 100);
/** {0.7, 0.8} -> "70 to 80 percent". */
export function shareText(range: NumberRange): string {
  const low = percent(Math.min(range.low, range.high));
  const high = percent(Math.max(range.low, range.high));
  return low === high ? `${low} percent` : `${low} to ${high} percent`;
}
export const shareBasisText = (basis: IntercropCompanion["shareBasis"]) => (basis === "sourced" ? "Sourced shares" : "Assumed shares");

/** "Expected 650 to 800 kg for your 0.16 ha"; null when the server gave no field yield. */
export function fieldYieldText(slot: Pick<YearPlanSlot, "yieldForFieldKg">, areaHa: number | null | undefined): string | null {
  if (!slot.yieldForFieldKg) return null;
  const where = areaHa != null && areaHa > 0 ? `your ${formatAreaHa(areaHa)} ha` : "your field";
  return `Expected ${formatKgRange(slot.yieldForFieldKg)} for ${where}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Basis lines: one short sentence under each estimate. Detail stays in the "Sources" list of the sheet.

export function yieldBasisText(slot: Pick<YearPlanSlot, "yieldBasis" | "basis">): string {
  const lead =
    slot.yieldBasis === "district"
      ? "Recent district yields"
      : slot.yieldBasis === "state"
        ? "State yields (no district figure)"
        : slot.yieldBasis === "reference"
          ? "Package-of-practice reference yield"
          : slot.yieldBasis === "farmer"
            ? "Your recorded yield"
            : "Yield source not given";
  const ref = slot.basis.find((b) => b.kind === "yield_reference");
  return ref ? `${lead} · ${ref.label}` : lead;
}

export function priceScopeName(price: Pick<PriceEstimate, "scope">): string {
  const s = price.scope;
  if (s.level === "district" && s.districtName) return `${s.districtName} district`;
  if (s.level === "state" && s.stateName) return s.stateName;
  if (s.level === "market") return "selected";
  return "all-India";
}

export function priceBasisText(price: PriceEstimate): string {
  const years = price.yearsUsed.length;
  const markets = price.scope.marketCount ? `, ${price.scope.marketCount} markets` : "";
  return `${years} year${years === 1 ? "" : "s"} of ${priceScopeName(price)} mandi prices around harvest week${markets} · wholesale`;
}

const AUTHORITY: Record<NonNullable<CostEstimate["authority"]>, string> = {
  cacp: "CACP",
  des: "DES",
  sau: "State agricultural university",
  other: "Published source",
};

export function costBasisText(cost: CostEstimate | null): string {
  if (!cost || cost.a2flPerHa == null) return "Cost not sourced";
  const parts = [cost.authority ? AUTHORITY[cost.authority] : null, cost.year, cost.region].filter(Boolean);
  return `Paid-out cost plus family labour (A2+FL)${parts.length ? ` · ${parts.join(", ")}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Editing

export interface DraftSlot {
  key: string;
  slotId?: string | undefined;
  fixed: boolean;
  cropId: string;
  productId: string;
  establishmentMethod?: string | undefined;
  /** 'green_manure' rows send kind and productId = cropId; 'intercrop' rows send kind and systemId; absent means an ordinary crop. */
  kind?: "crop" | "green_manure" | "intercrop" | undefined;
  /** Intercrop system id (intercropping.json) and the label shown in the editor ("pigeon pea · 8:1"); never sent for crops. */
  systemId?: string | undefined;
  companionLabel?: string | undefined;
  /** Last day the field is occupied by this row, when known (server occupancy or the picked candidate's harvest); cleared by manual edits. */
  endsOn?: string | undefined;
  /** Set when the row came from the crop picker, so the candidate's establishment method is sent with the new crop. */
  picked?: boolean | undefined;
  sowing: string;
  /** The crop the slot had before editing; a changed crop drops the slot id. */
  originalCropId?: string | undefined;
}

export function draftFromOption(option: YearPlanOption): DraftSlot[] {
  return option.slots.map((s) => ({
    key: s.slotId,
    slotId: s.slotId,
    fixed: s.fixed,
    cropId: s.cropId,
    productId: s.productId,
    ...(s.establishmentMethod ? { establishmentMethod: s.establishmentMethod } : {}),
    ...(isGreenManure(s) ? { kind: "green_manure" as const } : {}),
    ...(isIntercrop(s) ? { kind: "intercrop" as const, systemId: s.companion!.systemId, companionLabel: companionLabel(s.companion!) } : {}),
    sowing: s.sowing,
    endsOn: s.occupancy.to,
    originalCropId: s.cropId,
  }));
}

/** Problems the farmer can fix before re-scoring. Window and overlap checks belong to the server's re-score. */
export function draftProblems(drafts: readonly DraftSlot[], horizon: { from: string; to: string }): string[] {
  const problems: string[] = [];
  if (!drafts.length) problems.push("Keep at least one crop in the plan.");
  for (const [i, d] of drafts.entries()) {
    if (d.fixed) continue;
    if (!d.cropId || !d.productId) problems.push(`Choose a crop for row ${i + 1}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.sowing)) problems.push(`Choose a sowing date for row ${i + 1}.`);
    else if (d.sowing < horizon.from || d.sowing > horizon.to)
      problems.push(`Row ${i + 1}: sowing must fall between ${horizon.from} and ${horizon.to}.`);
  }
  return problems;
}

/** Request body for POST .../year-plan/rescore. Slots are sent in sowing order; a changed crop is sent as a new slot. */
export function rescoreBody(reviewId: string, optionId: string, drafts: readonly DraftSlot[]): RescoreYearPlan {
  return {
    reviewId,
    optionId,
    slots: [...drafts]
      .sort((a, b) => (a.fixed === b.fixed ? a.sowing.localeCompare(b.sowing) : a.fixed ? -1 : 1))
      .map((d) => ({
        ...(d.slotId && d.cropId === d.originalCropId ? { slotId: d.slotId } : {}),
        cropId: d.cropId,
        // A green manure has no product: the server expects the crop id there.
        productId: d.kind === "green_manure" ? d.cropId : d.productId,
        ...(d.establishmentMethod && (d.cropId === d.originalCropId || d.picked) ? { establishmentMethod: d.establishmentMethod } : {}),
        ...(d.kind === "green_manure"
          ? { kind: "green_manure" as const }
          : d.kind === "intercrop" && d.systemId
            ? { kind: "intercrop" as const, systemId: d.systemId }
            : {}),
        sowing: d.sowing,
      })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Swap and suggest-next (round 3): the crop picker is scored for one sowing date after one previous crop.

export interface PickerContext {
  /** Sowing date the picker scores for (YYYY-MM-DD). */
  sowing: string;
  /** Crop before the slot; null lets the server use the field's own history. */
  after: string | null;
}

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const inOrder = (drafts: readonly DraftSlot[]) =>
  [...drafts].sort((a, b) => (a.fixed === b.fixed ? a.sowing.localeCompare(b.sowing) : a.fixed ? -1 : 1));

/**
 * Context for swapping one row: its own sowing date, and the crop before it (the fixed crop or the previous row in
 * sowing order, else the scenario's previous crop). A green manure before the row counts as that row's predecessor.
 */
export function swapContext(
  drafts: readonly DraftSlot[],
  key: string,
  previousCropId: string | null,
  horizon: { from: string; to: string },
): PickerContext | null {
  const sorted = inOrder(drafts);
  const index = sorted.findIndex((d) => d.key === key);
  if (index < 0) return null;
  const target = sorted[index]!;
  const before = sorted.slice(0, index).filter((d) => d.cropId).at(-1);
  const after = before?.cropId ?? previousCropId;
  return { sowing: isIsoDate(target.sowing) ? target.sowing : horizon.from, after };
}

export type NextCropContext = { ok: true; context: PickerContext } | { ok: false; reason: string };

/**
 * Context for "Suggest next crop": the day after the last row's occupancy ends (or the horizon start for an empty
 * draft), scored after the last row's crop. Blocked, with a reason, when that date is not known yet or falls outside
 * the 12 months.
 */
export function nextCropContext(
  drafts: readonly DraftSlot[],
  horizon: { from: string; to: string },
  previousCropId: string | null,
): NextCropContext {
  const last = inOrder(drafts).at(-1);
  if (!last) return { ok: true, context: { sowing: horizon.from, after: previousCropId } };
  if (!last.cropId) return { ok: false, reason: "Choose a crop for the last row first." };
  if (!last.endsOn || !isIsoDate(last.endsOn)) return { ok: false, reason: "Re-score the plan first, so the day the field is free is known." };
  const next = addDaysIso(last.endsOn, 1);
  const sowing = next < horizon.from ? horizon.from : next;
  if (sowing > horizon.to) return { ok: false, reason: "This plan already runs to the end of the 12 months." };
  return { ok: true, context: { sowing, after: last.cropId } };
}

const candidateIsIntercrop = (c: CropFitCandidate) => c.kind === "intercrop" && !!c.companion;

/** The picker's `current` prop for a row; null for a blank row or a green manure (crop fit does not rank those). */
export function pickerCurrent(draft: DraftSlot): { cropId: string; productId: string; systemId: string | null } | null {
  if (!draft.cropId || !draft.productId || draft.kind === "green_manure") return null;
  return { cropId: draft.cropId, productId: draft.productId, systemId: draft.kind === "intercrop" ? (draft.systemId ?? null) : null };
}

/** Whether picking this candidate for this row would change anything (crop, product, system or sowing). */
export function pickChangesDraft(draft: DraftSlot, c: CropFitCandidate): boolean {
  return (
    draft.cropId !== c.cropId ||
    draft.productId !== c.productId ||
    (draft.kind ?? "crop") !== (candidateIsIntercrop(c) ? "intercrop" : "crop") ||
    (draft.systemId ?? null) !== (candidateIsIntercrop(c) ? c.companion!.systemId : null) ||
    draft.sowing !== c.sowing
  );
}

/** The row fields a picked candidate sets: crop, product, kind, system and sowing. `endsOn` is the harvest, an estimate until the re-score answers. */
function pickedFields(c: CropFitCandidate): Partial<DraftSlot> {
  const intercrop = candidateIsIntercrop(c);
  return {
    cropId: c.cropId,
    productId: c.productId,
    kind: intercrop ? "intercrop" : "crop",
    systemId: intercrop ? c.companion!.systemId : undefined,
    companionLabel: intercrop ? companionLabel(c.companion!) : undefined,
    establishmentMethod: c.establishmentMethod ?? undefined,
    sowing: c.sowing,
    endsOn: c.harvest.latest,
    picked: true,
  };
}

/** Replace one row with a picked candidate. A different crop, product, kind or system is a new slot (the slot id is dropped). */
export function applyPick(drafts: readonly DraftSlot[], key: string, c: CropFitCandidate): DraftSlot[] {
  return drafts.map((d) => {
    if (d.key !== key) return d;
    const sameSlot =
      d.cropId === c.cropId &&
      d.productId === c.productId &&
      (d.kind ?? "crop") === (candidateIsIntercrop(c) ? "intercrop" : "crop") &&
      (d.systemId ?? null) === (candidateIsIntercrop(c) ? c.companion!.systemId : null);
    return { ...d, ...pickedFields(c), ...(sameSlot ? {} : { slotId: undefined }) };
  });
}

/** Append a picked candidate as a new row. */
export function appendPick(drafts: readonly DraftSlot[], key: string, c: CropFitCandidate): DraftSlot[] {
  return [...drafts, { key, fixed: false, cropId: c.cropId, productId: c.productId, sowing: c.sowing, ...pickedFields(c) }];
}

/**
 * Merge a review the server sent back (after apply, or a background re-read) into the one on screen. For the same
 * review id the server's status fields win (stale, appliedOptionIds, status) but the options on screen are kept, so a
 * farmer's re-scored "Your version" is not silently replaced. A different review id replaces everything.
 */
export function mergeServerReview(local: YearPlanReview | undefined, server: YearPlanReview): YearPlanReview {
  const same = !!local && local.reviewId !== null && server.reviewId === local.reviewId;
  return same ? { ...server, options: local!.options } : server;
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendar surface: headline profit, short warnings, the fixed crop's two lines

export interface ProfitHeadline {
  value: string;
  caption: string;
  /** Which figure was used: the field total, the per-hectare estimate, the older per-hectare range, or none. */
  source: "field" | "per_ha" | "range" | "none";
}

/**
 * Headline profit for a calendar row and the sheet summary, first match wins:
 * 1. field total, likely band, "for your 0.16 ha"
 * 2. per-hectare estimate, likely band, with the hint to draw the boundary
 * 3. the older per-hectare range (reviews built before round 2)
 * 4. not available
 */
export function profitText(
  option: Partial<Pick<YearPlanOption, "totalProfitForField" | "totalProfitEstimate" | "totalProfitPerHa" | "fieldAreaHa">>,
): ProfitHeadline {
  if (option.totalProfitForField) {
    const area = option.fieldAreaHa;
    return {
      value: formatInrBand(option.totalProfitForField.likely),
      caption: area != null && area > 0 ? `for your ${formatAreaHa(area)} ha` : "for your field",
      source: "field",
    };
  }
  if (option.totalProfitEstimate)
    return {
      value: formatInrBand(option.totalProfitEstimate.likely),
      caption: "per hectare · draw the boundary for your field total",
      source: "per_ha",
    };
  if (option.totalProfitPerHa)
    return { value: formatInrRange(option.totalProfitPerHa), caption: "profit per ha", source: "range" };
  return { value: "Profit not available", caption: "needs a price and a cost for every crop", source: "none" };
}

/** No sentence longer than this is drawn on the calendar itself; longer text lives in the detail sheet. */
export const CALENDAR_TEXT_MAX = 90;

/** Warnings that fit on the calendar as chips; the rest are counted and shown in full in the sheet. */
export function calendarWarnings(warnings: readonly string[]): { short: string[]; hidden: number } {
  const short = warnings.filter((w) => w.length <= CALENDAR_TEXT_MAX);
  return { short, hidden: warnings.length - short.length };
}

/**
 * The crop already growing gets up to two short lines under its strip ("Harvest expected 13 Feb to 15 Mar (estimated
 * from the sowing date)", "Next crop from 25 Mar"). The server writes them into `transitionNote` separated by a line
 * break; a note that is one long sentence is not drawn here (the sheet shows it whole).
 */
export function noteLines(note: string | null | undefined): string[] {
  if (!note) return [];
  return note
    .split(/\n+|\.\s+(?=[A-Z])/)
    .map((line) => line.trim().replace(/\.$/, ""))
    .filter((line) => line.length > 0 && line.length <= CALENDAR_TEXT_MAX)
    .slice(0, 2);
}

/**
 * Round 3 (ROUND3_SPEC.md section 4 item 4): the idle penalty deducted from the plan score, in points, from the server
 * (`idlePenaltyPoints`); older servers without the field get the published constants (0.04 per month beyond half a month,
 * on the unweighted idle months, so at most an upper bound). Null when nothing is deducted.
 */
export function idlePenaltyText(option: Pick<YearPlanOption, "idlePenaltyPoints" | "idleMonths">): string | null {
  const points =
    option.idlePenaltyPoints ?? Math.round(Math.max(0, option.idleMonths - 0.5) * 0.04 * 100 * 100) / 100;
  if (!(points > 0)) return null;
  const shown = points < 1 ? "less than 1 point" : `${Math.round(points)} point${Math.round(points) === 1 ? "" : "s"}`;
  return `Idle time lowers the score separately: −${shown} for ${option.idleMonths.toFixed(1).replace(/\.0$/, "")} idle months.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved seasons on the calendar (follow-up of 2026-11-01): the occupants every option shares, and swapping a saved
// season's crop with the same picker as a suggested slot. The swap edits the saved season on the field (workspace save);
// the year plan is then rebuilt by code.

export type OccupantSource = YearPlanOccupant["source"];

/** Word on the strip and the panel chip. */
export const OCCUPANT_STRIP_LABEL: Record<OccupantSource, string> = {
  saved_season: "Saved season",
  recorded_cycle: "Recorded crop",
  assumed_plan: "Assumed plan",
};
/** Small text under a pill in the option sheet. */
export const OCCUPANT_PILL_LABEL: Record<OccupantSource, string> = {
  saved_season: "saved",
  recorded_cycle: "recorded",
  assumed_plan: "assumed",
};

/** Crop name as drawn: an intercrop reads "Main + companion · ratio", a green manure and a sole crop their own name. */
export const occupantName = (o: Pick<YearPlanOccupant, "kind" | "companion" | "cropName">) =>
  o.kind === "intercrop" && o.companion ? `${o.cropName} + ${companionLabel(o.companion)}` : o.cropName;

/**
 * "harvest by 29 Aug 2027" when the farmer's own harvest date exists. Without one the only end date is where the engine
 * stops the occupancy (the latest sourced harvest plus a buffer and the land-preparation gap), which is not a harvest
 * date, so it reads "field busy until 8 Sep 2027".
 */
export const occupantEndText = (o: Pick<YearPlanOccupant, "harvestDate" | "occupancy">) =>
  o.harvestDate ? `harvest by ${longDate(o.harvestDate)}` : `field busy until ${longDate(o.occupancy.to)}`;

/** Occupants in sowing order (stable for equal dates). */
export const sortedOccupants = (occupied: readonly YearPlanOccupant[] | undefined): YearPlanOccupant[] =>
  [...(occupied ?? [])].sort((a, b) => a.sowing.localeCompare(b.sowing));

/** A pill of the option sheet: a crop of the plan or an occupant, in date order. */
export type SheetItem = { kind: "slot"; slot: YearPlanSlot } | { kind: "occupant"; occupant: YearPlanOccupant };

/** Slots and occupants of one option merged by sowing date, so the pills read like the calendar. A slot sorts before an occupant sown the same day. */
export function sheetItems(option: Pick<YearPlanOption, "slots">, occupied: readonly YearPlanOccupant[] | undefined): SheetItem[] {
  const items: SheetItem[] = [
    ...option.slots.map((slot) => ({ kind: "slot" as const, slot })),
    ...sortedOccupants(occupied).map((occupant) => ({ kind: "occupant" as const, occupant })),
  ];
  const start = (i: SheetItem) => (i.kind === "slot" ? i.slot.sowing : i.occupant.sowing);
  return items.sort((a, b) => start(a).localeCompare(start(b)) || (a.kind === b.kind ? 0 : a.kind === "slot" ? -1 : 1));
}

/**
 * Context for swapping a saved season: its own sowing date, and the crop before it, which is the nearest earlier item
 * by sowing among the fixed slot, the option's suggested slots and the other occupants, else the scenario's previous
 * crop. Null when the occupant is not in the list.
 */
export function occupantSwapContext(
  occupantId: string,
  option: Pick<YearPlanOption, "slots">,
  occupied: readonly YearPlanOccupant[] | undefined,
  previousCropId: string | null,
): PickerContext | null {
  const target = (occupied ?? []).find((o) => o.id === occupantId);
  if (!target) return null;
  const others: { sowing: string; cropId: string }[] = [
    ...option.slots.map((s) => ({ sowing: s.sowing, cropId: s.cropId })),
    ...(occupied ?? []).filter((o) => o.id !== occupantId).map((o) => ({ sowing: o.sowing, cropId: o.cropId })),
  ].filter((i) => i.sowing < target.sowing);
  // The latest earlier sowing wins; of two sown the same day the one listed last does.
  const before = others.reduce<{ sowing: string; cropId: string } | undefined>(
    (best, item) => (!best || item.sowing >= best.sowing ? item : best),
    undefined,
  );
  return { sowing: target.sowing, after: before?.cropId ?? previousCropId };
}

/** The picker's `current` for a saved season; null for a green manure (crop fit does not rank those) or an unknown product. */
export function occupantPickerCurrent(
  o: Pick<YearPlanOccupant, "kind" | "cropId" | "productId" | "companion">,
): { cropId: string; productId: string; systemId: string | null } | null {
  if (o.kind === "green_manure" || !o.productId) return null;
  return { cropId: o.cropId, productId: o.productId, systemId: o.companion?.systemId ?? null };
}

/** Whether picking this candidate would change the saved season: crop, product, kind, system or sowing differ. */
export function occupantPickChanges(
  o: Pick<YearPlanOccupant, "kind" | "cropId" | "productId" | "companion" | "sowing">,
  c: CropFitCandidate,
): boolean {
  const candidateKind = candidateIsIntercrop(c) ? "intercrop" : "crop";
  const occupantKind = o.kind === "green_manure" ? "green_manure" : o.kind === "intercrop" && o.companion ? "intercrop" : "crop";
  return (
    o.cropId !== c.cropId ||
    (o.productId ?? null) !== c.productId ||
    occupantKind !== candidateKind ||
    (occupantKind === "intercrop" ? (o.companion?.systemId ?? null) : null) !== (candidateIsIntercrop(c) ? c.companion!.systemId : null) ||
    o.sowing !== c.sowing
  );
}

/**
 * One short line under a calendar row that names the saved seasons ("Saved season: Pigeon pea 16 May to 8 Sep"), so a
 * narrow screen, where the calendar scrolls to the current month and the season may lie off to the right, still says
 * what the plan works around. At most two are named; the line never runs past the calendar's 90-character limit.
 */
export function occupantHint(occupied: readonly YearPlanOccupant[] | undefined): string | null {
  const list = sortedOccupants(occupied);
  if (!list.length) return null;
  const many = list.length > 1;
  const lead = list.every((o) => o.source === "saved_season")
    ? many ? "Saved seasons" : "Saved season"
    : list.every((o) => o.source === "recorded_cycle")
      ? many ? "Recorded crops" : "Recorded crop"
      : list.every((o) => o.source === "assumed_plan")
        ? "Assumed plan"
        : "Saved and recorded";
  for (let named = Math.min(2, list.length); named >= 1; named--) {
    const names = list.slice(0, named).map((o) => `${occupantName(o)} ${shortSpan(o.sowing, o.occupancy.to)}`).join("; ");
    const more = list.length > named ? ` and ${list.length - named} more` : "";
    const text = `${lead}: ${names}${more}`;
    if (text.length <= CALENDAR_TEXT_MAX) return text;
  }
  return `${lead}: ${list.length} on this field`;
}

/** The label the server's apply writes (`seasonOfMonth`, capitalised): Feb to Apr "Summer", May to Aug "Kharif", else "Rabi". */
const SEASON_LABEL = { summer: "Summer", kharif: "Kharif", rabi: "Rabi" } as const;
export const seasonLabelForSowing = (sowingIso: string) => SEASON_LABEL[seasonForMonth(sowingIso)];

/**
 * The planned harvest a saved season gets from a candidate: the main crop's latest harvest, or the companion's when an
 * intercrop's companion is harvested later, because the field stays busy until then (the server's apply writes that
 * later date as well).
 */
export const candidatePlannedHarvest = (c: Pick<CropFitCandidate, "harvest" | "companionHarvest">): string =>
  c.companionHarvest && c.companionHarvest.latest > c.harvest.latest ? c.companionHarvest.latest : c.harvest.latest;

/** The engine's occupancy of a candidate (sowing to release); servers that do not send it fall back to sowing to the planned harvest. */
export const candidateOccupancy = (c: Pick<CropFitCandidate, "sowing" | "harvest" | "companionHarvest" | "occupancy">): { from: string; to: string } =>
  c.occupancy ?? { from: c.sowing, to: candidatePlannedHarvest(c) };

/** The engine's overlap rule for occupancies (half-open: a season may begin the day another is released). */
const occupanciesOverlap = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from < b.to && b.from < a.to;

/** The prefix of the notes the server's apply writes: `Year plan "Best overall" (model) from review ...`. */
const APPLY_NOTE_PREFIX = 'Year plan "';

/**
 * Notes after a swap. The apply-written notes carry the old crop's yield, price and cost, which do not belong to the new
 * crop, so they are replaced by one line saying what changed. Notes the farmer wrote stay as they are.
 */
export const swappedSeasonNotes = (
  existing: string | undefined,
  change: { fromCropName: string; toCropName: string; todayIso: string },
): string | undefined =>
  existing?.startsWith(APPLY_NOTE_PREFIX)
    ? `Crop changed from ${change.fromCropName} to ${change.toCropName} in the year plan on ${longDate(change.todayIso)}; the earlier plan's figures no longer apply. Dates are calculated references, not predictions.`
    : existing;

/**
 * The saved season after the swap: id stays; crop, product, kind, companion, establishment method, dates, year and
 * season label come from the picked candidate (`plannedHarvestDate` is the later of the main and companion harvest), and
 * notes written by the year plan's apply are replaced (see `swappedSeasonNotes`). A key the candidate does not set
 * (establishment method, companion) is removed rather than left from the old crop.
 */
export function replacementRotationPlan(
  existing: Rotation,
  c: CropFitCandidate,
  change: { fromCropName: string; todayIso: string },
): Rotation {
  const { establishmentMethod: _method, companion: _companion, kind: _kind, productId: _pid, productName: _pname, cropName: _name, notes, ...kept } = existing;
  const intercrop = candidateIsIntercrop(c);
  const nextNotes = swappedSeasonNotes(notes, { ...change, toCropName: c.cropName });
  return {
    ...kept,
    ...(nextNotes !== undefined ? { notes: nextNotes } : {}),
    cropId: c.cropId,
    cropName: c.cropName,
    productId: c.productId,
    productName: c.productName,
    ...(c.establishmentMethod ? { establishmentMethod: c.establishmentMethod } : {}),
    kind: intercrop ? "intercrop" : "crop",
    ...(intercrop
      ? {
          companion: {
            systemId: c.companion!.systemId,
            cropId: c.companion!.cropId,
            cropName: c.companion!.cropName,
            productId: c.companion!.productId,
            productName: c.companion!.productName,
            rowRatio: c.companion!.rowRatio,
          },
        }
      : {}),
    plannedSowingDate: c.sowing,
    plannedHarvestDate: candidatePlannedHarvest(c),
    year: Number(c.sowing.slice(0, 4)),
    season: seasonLabelForSowing(c.sowing),
  };
}

export type SavedSeasonSwap =
  | { kind: "unchanged" }
  | { kind: "missing"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "saved"; from: string; to: string };

export const SWAP_MISSING = "This saved season is no longer on the field; reload.";
export const SWAP_CONFLICT = "Saved seasons changed elsewhere; reload and try again.";

/**
 * Why a swap cannot be saved, or null when it can: the checks the server's apply makes, run before the save so the farmer
 * reads the reason in the swap sheet. In order: the candidate's sowing date has passed; it overlaps the growing crop;
 * it overlaps another occupant of the plan (any source; the season being swapped is left out, it is being replaced).
 * Overlap is the engine's rule on the candidate's occupancy (`occupancy`, else sowing to planned harvest).
 */
export function swapRefusal(args: {
  occupant: Pick<YearPlanOccupant, "id">;
  candidate: CropFitCandidate;
  /** Today's calendar date (ISO); a candidate sown before it cannot be saved. */
  todayIso: string;
  /** The growing crop (the fixed slot) of the plan on screen, if any. */
  fixedSlot: Pick<YearPlanSlot, "cropName" | "occupancy"> | null;
  occupied: readonly YearPlanOccupant[];
}): string | null {
  const { occupant, candidate, todayIso, fixedSlot, occupied } = args;
  if (candidate.sowing < todayIso) return `The sowing date ${longDate(candidate.sowing)} has passed; pick a crop that can still be sown.`;
  const taken = candidateOccupancy(candidate);
  if (fixedSlot && occupanciesOverlap(taken, fixedSlot.occupancy))
    return `${candidate.cropName} would overlap the growing ${fixedSlot.cropName}, which is expected to hold the field until ${longDate(fixedSlot.occupancy.to)}.`;
  const other = sortedOccupants(occupied).find((o) => o.id !== occupant.id && occupanciesOverlap(taken, o.occupancy));
  if (other)
    return `${candidate.cropName} would overlap ${other.cropName} (${shortSpan(other.occupancy.from, other.occupancy.to)}). Pick a shorter crop or change that season first.`;
  return null;
}

/**
 * Swap a saved season's crop: picking what is already there changes nothing; a pick the server's apply would refuse (see
 * `swapRefusal`) is refused with its reason and nothing is saved; otherwise the matching saved season (by the occupant's
 * own id) is replaced and the whole list goes to `save` (the workspace PUT, which carries the expected version). A 409
 * means the saved seasons changed elsewhere. The caller rebuilds the year plan after "saved".
 */
export async function swapSavedSeason(args: {
  occupant: YearPlanOccupant;
  candidate: CropFitCandidate;
  rotationPlans: readonly Rotation[];
  todayIso: string;
  fixedSlot: Pick<YearPlanSlot, "cropName" | "occupancy"> | null;
  occupied: readonly YearPlanOccupant[];
  save: (patch: { rotationPlans: Rotation[] }) => Promise<unknown>;
}): Promise<SavedSeasonSwap> {
  const { occupant, candidate, rotationPlans, todayIso, fixedSlot, occupied, save } = args;
  if (!occupantPickChanges(occupant, candidate)) return { kind: "unchanged" };
  if (!rotationPlans.some((r) => r.id === occupant.id)) return { kind: "missing", message: SWAP_MISSING };
  const refusal = swapRefusal({ occupant, candidate, todayIso, fixedSlot, occupied });
  if (refusal) return { kind: "refused", message: refusal };
  const change = { fromCropName: occupant.cropName, todayIso };
  const replaced = rotationPlans.map((r) => (r.id === occupant.id ? replacementRotationPlan(r, candidate, change) : r));
  try {
    await save({ rotationPlans: replaced });
  } catch (error) {
    const e = error as { status?: unknown; code?: unknown; message?: unknown };
    if (e?.status === 409 || e?.code === "version_conflict") return { kind: "failed", message: SWAP_CONFLICT };
    return { kind: "failed", message: typeof e?.message === "string" && e.message ? e.message : "The saved season could not be changed. Try again." };
  }
  return { kind: "saved", from: occupant.cropName, to: candidate.cropName };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2026-11-04 (EVARA_ACTIONS_SPEC.md 1.1, 1.3): planned-but-unsown seasons and the alternatives the server computes when the
// growing crop and the saved seasons leave no free window.

/** The small tag on a saved season no recorded cycle realises; a sown season (or an older row without `realisation`) gets none. */
export const REALISATION_TAG = { planned: "Planned, not sown", overdue: "Overdue, not sown" } as const;
export const realisationTag = (o: Pick<YearPlanOccupant, "realisation">): string | null =>
  o.realisation === "planned" || o.realisation === "overdue" ? REALISATION_TAG[o.realisation] : null;

/** "Pigeon pea", "Pigeon pea and Maize", "Pigeon pea, Maize and Onion"; repeated names are said once. */
export function joinNames(names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/** "Pigeon pea (planned 12 Feb 2027)"; the date is left out when the saved season has none. */
export const replacementText = (r: Pick<YearPlanReplacement, "cropName" | "plannedSowingDate">): string =>
  r.plannedSowingDate ? `${r.cropName} (planned ${longDate(r.plannedSowingDate)})` : r.cropName;

/** The engine's overlap rule on occupancies (half-open), as in `swapRefusal`. */
const windowsOverlap = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from < b.to && b.from < a.to;

/**
 * The planned seasons one alternative option takes over: those of `alternatives.replaces` whose occupancy a suggested
 * (not growing) slot overlaps. The server removes exactly these on apply. A season the occupants do not describe counts as taken
 * (the farmer is never told less than the server does); an option that overlaps none of them takes over none: the empty list.
 */
export function replacedByOption(
  alternatives: Pick<YearPlanAlternatives, "basis" | "replaces">,
  option: Pick<YearPlanOption, "slots">,
  occupied: readonly YearPlanOccupant[] | undefined,
): YearPlanReplacement[] {
  if (alternatives.basis !== "replace_planned") return [];
  const slots = option.slots.filter((s) => !s.fixed);
  const hit = alternatives.replaces.filter((r) => {
    const season = (occupied ?? []).find((o) => o.id === r.rotationPlanId);
    return !season || slots.some((s) => windowsOverlap(s.occupancy, season.occupancy));
  });
  return hit;
}

/** The occupants an alternative is drawn against: the saved seasons it takes over are no longer in the way, a comparison draws none. */
export function alternativeOccupants(
  alternatives: Pick<YearPlanAlternatives, "basis" | "replaces">,
  option: Pick<YearPlanOption, "slots">,
  occupied: readonly YearPlanOccupant[] | undefined,
): YearPlanOccupant[] {
  if (alternatives.basis !== "replace_planned") return [];
  const taken = new Set(replacedByOption(alternatives, option, occupied).map((r) => r.rotationPlanId));
  return (occupied ?? []).filter((o) => !taken.has(o.id));
}

/**
 * "Instead of Pigeon pea" / "For comparison only, Paddy stays". A comparison plan has no growing slot of its own, so the
 * growing crop's name comes from the review's own plan (`growingCropName`).
 */
export function alternativeBasisText(
  alternatives: Pick<YearPlanAlternatives, "basis" | "replaces">,
  option: Pick<YearPlanOption, "slots">,
  occupied: readonly YearPlanOccupant[] | undefined,
  growingCropName?: string | null,
): string {
  if (alternatives.basis === "replace_planned") {
    const names = joinNames(replacedByOption(alternatives, option, occupied).map((r) => r.cropName));
    return names ? `Instead of ${names}` : "Fits beside your planned seasons";
  }
  return `For comparison only, ${option.slots.find((s) => s.fixed)?.cropName ?? growingCropName ?? "the sown crop"} stays`;
}

/** The button of a replace_planned card and the sheet footer: "Use instead of Pigeon pea". */
export const useInsteadText = (replaced: readonly Pick<YearPlanReplacement, "cropName">[]): string =>
  replaced.length ? `Use instead of ${joinNames(replaced.map((r) => r.cropName))}` : "Add these seasons";

/** The alternative option with this id, with its alternatives block; null when the id is one of the review's own options. */
export function alternativeOption(
  review: Pick<YearPlanReview, "alternatives">,
  optionId: string | null | undefined,
): { alternatives: YearPlanAlternatives; option: YearPlanOption } | null {
  const alternatives = review.alternatives;
  const option = alternatives?.options.find((o) => o.optionId === optionId);
  return alternatives && option ? { alternatives, option } : null;
}

/**
 * The apply request for one option. `alternative: true` goes only with an option of `review.alternatives` whose basis is
 * `replace_planned` (the server removes the seasons it replaces in the same write); a `sown_comparison` option has no
 * request at all (null: it is never applied, the server would answer 400 alternative_not_applicable).
 */
export function applyBody(args: {
  review: Pick<YearPlanReview, "reviewId" | "alternatives">;
  option: YearPlanOption;
  workspaceVersion: number;
}): ApplyYearPlan | null {
  const { review, option, workspaceVersion } = args;
  if (!review.reviewId) return null;
  const alt = alternativeOption(review, option.optionId);
  if (alt?.alternatives.basis === "sown_comparison") return null;
  return {
    reviewId: review.reviewId,
    optionId: option.optionId,
    slotIds: slotsToApply(option).map((x) => x.slotId),
    expectedWorkspaceVersion: workspaceVersion,
    ...(alt ? { alternative: true } : {}),
  };
}

/** One slot of an alternative card: "₹4,200 to ₹9,300 for your field", the per-hectare band when the area is unknown, else "Profit not shown". */
export function slotProfitLine(slot: Pick<YearPlanSlot, "profitForField" | "profitEstimate" | "fixed" | "kind">): string {
  if (slot.fixed) return "Already growing";
  if (slot.kind === "green_manure") return "No income; adds nitrogen";
  if (slot.profitForField) return `${formatInrBand(slot.profitForField.likely)} for your field`;
  if (slot.profitEstimate) return `${formatInrBand(slot.profitEstimate.likely)} per hectare`;
  return "Profit not shown";
}
