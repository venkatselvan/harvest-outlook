import type {
  CostEstimate,
  PriceEstimate,
  RescoreYearPlan,
  YearPlanOption,
  YearPlanReview,
  YearPlanScenario,
  YearPlanSlot,
} from "@harvest/contracts";
import type { CropSummary } from "../../features/comparison/types";
import { formatAreaHa, formatInrBand, formatInrRange, monthYear, partOfMonth } from "./format";

/** Pure view-model logic for the Year plan: no Solid, no fetch. */

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

/** Nothing generated yet for this farm: the view asks the server to build a plan once per load. */
export const needsGeneration = (review: Pick<YearPlanReview, "status" | "reviewId" | "options">) =>
  !isActive(review) && review.reviewId === null && review.options.length === 0;

/** Model name for the activity indicator; only the resolved model, never the requested one. */
export const planningModel = (review: Pick<YearPlanReview, "modelInvocation">) =>
  review.modelInvocation?.model ?? null;

/** The options on screen were built by code alone (provider failed, unavailable, or not used). */
export const modelUnavailable = (review: Pick<YearPlanReview, "status" | "options">) =>
  review.options.length > 0 &&
  !isActive(review) &&
  (review.status === "unavailable" ||
    review.status === "error" ||
    review.options.every((o) => o.origin === "deterministic"));

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
  const start =
    scenario.horizon.from === todayIso ? "Starting fresh from today" : `Starting fresh from ${monthYear(scenario.horizon.from)}`;
  if (!scenario.previousCropId) return start;
  const named =
    options.flatMap((o) => o.slots).find((s) => s.cropId === scenario.previousCropId)?.cropName ??
    cropName(scenario.previousCropId);
  return `${start} · last crop ${named.toLowerCase()}`;
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
  slotId?: string;
  fixed: boolean;
  cropId: string;
  productId: string;
  establishmentMethod?: string;
  /** 'green_manure' rows send kind and productId = cropId; absent means an ordinary crop. */
  kind?: "crop" | "green_manure";
  sowing: string;
  /** The crop the slot had before editing; a changed crop drops the slot id. */
  originalCropId?: string;
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
    sowing: s.sowing,
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
        ...(d.establishmentMethod && d.cropId === d.originalCropId ? { establishmentMethod: d.establishmentMethod } : {}),
        ...(d.kind === "green_manure" ? { kind: "green_manure" as const } : {}),
        sowing: d.sowing,
      })),
  };
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
