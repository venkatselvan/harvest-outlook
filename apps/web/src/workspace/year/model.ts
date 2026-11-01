import type {
  CostEstimate,
  CropFitCandidate,
  IntercropCompanion,
  NumberRange,
  PriceEstimate,
  RescoreYearPlan,
  YearPlanOption,
  YearPlanReview,
  YearPlanScenario,
  YearPlanSlot,
} from "@harvest/contracts";
import type { CropSummary } from "../../features/comparison/types";
import { addDaysIso, addYearsIso, formatAreaHa, formatInrBand, formatInrRange, formatKgRange, monthYear, partOfMonth } from "./format";

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
