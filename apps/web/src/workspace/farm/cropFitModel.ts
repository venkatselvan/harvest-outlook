import type { CropFitCandidate, CropFitPick, CropFitReview, CropSeason, IntercropCompanion, NumberEstimate, PriceEstimate, SoilCheck } from "@harvest/contracts";
import type { ChipTone } from "../ui/Chip";

/**
 * Pure view model for the Farm tab crop fit (ROUND2_SPEC.md 4.2). Every number shown comes from the server review
 * (code-computed); this module only formats and joins. No model output is turned into a number here.
 */

export type FitMode = CropFitReview["request"]["mode"];
export interface ControlsState {
  mode: FitMode;
  season: CropSeason;
  /** YYYY-MM-DD, used when mode is "date". */
  sowing: string;
  /** Round 3: previous-crop override for mode "date" (the swap picker); null = the field's own history. */
  after: string | null;
}
export const SEASONS: readonly { id: CropSeason; label: string }[] = [
  { id: "kharif", label: "Kharif" },
  { id: "rabi", label: "Rabi" },
  { id: "summer", label: "Summer" },
];
export const MODES: readonly { id: FitMode; label: string }[] = [
  { id: "next", label: "Next crop" },
  { id: "season", label: "By season" },
  { id: "date", label: "Pick a date" },
];
/** Prefix of the server limitation written when Meta could not pick (services/crop-fit/service.ts MODEL_UNAVAILABLE). */
export const MODEL_UNAVAILABLE_PREFIX = "Model unavailable";
/**
 * Latest sowing date the server accepts (routes/crop-fit.ts SOWING_LIMIT_DAYS): through the end of plan year 3, the last
 * later horizon, which on a fresh field ends about today + 1,461 days (ROUND3_SPEC.md 3.1).
 */
export const MAX_DAYS_AHEAD = 1461;

const DAY = 86_400_000;
export const localToday = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
export const addDaysIso = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Season shown first in the chips: the one whose sowing usually comes next (Feb-Apr summer, May-Aug kharif, else rabi). */
export function seasonForMonth(iso: string): CropSeason {
  const m = Number(iso.slice(5, 7));
  return m >= 2 && m <= 4 ? "summer" : m >= 5 && m <= 8 ? "kharif" : "rabi";
}
export const defaultControls = (todayIso: string): ControlsState => ({ mode: "date", season: seasonForMonth(todayIso), sowing: todayIso, after: null });
/** Controls that match the review the server resolved (the first GET sends no mode; the server picks the default). */
export function controlsFromReview(review: Pick<CropFitReview, "request">, current: ControlsState): ControlsState {
  const r = review.request;
  return { mode: r.mode, season: r.season ?? current.season, sowing: r.sowing ?? current.sowing, after: r.after ?? null };
}
/** Query string for a request; parameters that do not apply to the mode are left out. */
export function queryFor(c: ControlsState | null): string {
  if (!c) return "";
  const q = new URLSearchParams({ mode: c.mode });
  if (c.mode === "season") q.set("season", c.season);
  if (c.mode === "date") {
    q.set("sowing", c.sowing);
    if (c.after) q.set("after", c.after);
  }
  return `?${q.toString()}`;
}
/** Problems with the picked date, or null when it can be sent. */
export function sowingProblem(sowing: string, todayIso: string): string | null {
  if (!isIsoDate(sowing)) return "Enter a sowing date.";
  if (sowing < todayIso) return "Pick today or a later date.";
  if (sowing > addDaysIso(todayIso, MAX_DAYS_AHEAD)) return "Pick a date within about four years.";
  return null;
}

export const isActive = (r: Pick<CropFitReview, "status">) => r.status === "pending" || r.status === "running";
/** Meta could not pick (provider failure, gate rejection or not configured in live mode); the picks are calculated. */
export const modelUnavailable = (r: Pick<CropFitReview, "pickOrigin" | "limitations">) =>
  r.pickOrigin === "deterministic" && r.limitations.some((l) => l.startsWith(MODEL_UNAVAILABLE_PREFIX));
export type PicksChip = "pending" | "model" | "unavailable" | "calculated" | null;
export function picksChip(r: Pick<CropFitReview, "status" | "pickOrigin" | "limitations">): PicksChip {
  if (isActive(r)) return "pending";
  if (r.pickOrigin === "model") return "model";
  if (modelUnavailable(r)) return "unavailable";
  if (r.pickOrigin === "deterministic") return "calculated";
  return null;
}
/** Resolved model name for the activity indicator (never the requested one). */
export const pickingModel = (r: Pick<CropFitReview, "modelInvocation">) => r.modelInvocation?.model ?? null;

// ------------------------------------------------------------------ formatting
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const formatDate = (iso: string, withYear = true): string => {
  const d = Number(iso.slice(8, 10));
  const m = MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
  return withYear ? `${d} ${m} ${iso.slice(0, 4)}` : `${d} ${m}`;
};
export const formatRangeDates = (from: string, to: string): string =>
  from === to ? formatDate(from) : from.slice(0, 4) === to.slice(0, 4) ? `${formatDate(from, false)} to ${formatDate(to)}` : `${formatDate(from)} to ${formatDate(to)}`;
const group = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const formatInr = (n: number): string => `${n < 0 ? "−" : ""}₹${group.format(Math.abs(Math.round(n)))}`;
export const formatInrRange = (r: { low: number; high: number }): string => (r.low === r.high ? formatInr(r.low) : `${formatInr(r.low)} to ${formatInr(r.high)}`);
export const formatPerKg = (n: number): string => `₹${Math.round(n * 10) / 10}/kg`;
export const formatKg = (n: number): string => `${group.format(Math.round(n))} kg`;
export const formatArea = (ha: number): string => `${Math.round(ha * 100) / 100} ha`;
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
export const cropLabel = (id: string | null | undefined): string => cap((id ?? "").replace(/-/g, " "));

/** "Sowing from 25 Mar 2027, after paddy" (next, date) or "Kharif windows from 22 May 2027, after paddy" (season). */
export function resolvedLine(r: Pick<CropFitReview, "request" | "resolvedSowing" | "previousCropId" | "status">, nameOf: (id: string) => string = cropLabel): string {
  const after = r.previousCropId ? `, after ${nameOf(r.previousCropId).toLowerCase()}` : "";
  if (r.request.mode === "season") {
    const season = SEASONS.find((s) => s.id === r.request.season)?.label ?? "Season";
    return r.resolvedSowing ? `${season} windows from ${formatDate(r.resolvedSowing)}${after}; each crop uses its own window` : `Each crop uses its own ${season.toLowerCase()} sowing window`;
  }
  return r.resolvedSowing ? `Sowing from ${formatDate(r.resolvedSowing)}${after}` : "Working out the sowing date";
}

// ------------------------------------------------------------------ candidates and picks
/** Crop, product and (for an intercrop) the system id, so a sole crop and its intercrop are different rows. Picks carry no system id. */
export const candidateKey = (c: Pick<CropFitCandidate, "cropId" | "productId"> & { companion?: Pick<IntercropCompanion, "systemId"> | null | undefined }) => `${c.cropId}|${c.productId}|${c.companion?.systemId ?? ""}`;
const pickKey = (c: Pick<CropFitCandidate, "cropId" | "productId">) => `${c.cropId}|${c.productId}`;
export const isIntercrop = (c: Pick<CropFitCandidate, "kind" | "companion">): boolean => c.kind === "intercrop" && !!c.companion;
/** Candidates in ranking order: rankScore (score minus the wait penalty) first, then the server rank. */
export const rankedCandidates = (r: Pick<CropFitReview, "candidates">): CropFitCandidate[] =>
  [...r.candidates].sort((a, b) => (b.rankScore ?? b.score) - (a.rankScore ?? a.score) || a.rank - b.rank);
/** Display name, with the product when the crop has several marketed forms ("Chilli (dry)"). */
export function displayName(c: Pick<CropFitCandidate, "cropName" | "productName">): string {
  return /\b(dry|green|fresh)\b/i.test(c.productName) && c.productName.toLowerCase() !== c.cropName.toLowerCase() ? `${c.cropName} (${c.productName.toLowerCase()})` : c.cropName;
}
export interface PickCard { pick: CropFitPick; candidate: CropFitCandidate }
/** Picks joined to their candidates in pick order; a pick whose candidate is missing is dropped. A pick names a crop and product only, so when that crop is ranked both alone and as an intercrop it joins the higher-ranked one. */
export function pickCards(r: Pick<CropFitReview, "picks" | "candidates">): PickCard[] {
  const by = new Map<string, CropFitCandidate>();
  for (const c of rankedCandidates(r)) if (!by.has(pickKey(c))) by.set(pickKey(c), c);
  return [...r.picks].sort((a, b) => a.rank - b.rank).flatMap((pick) => {
    const candidate = by.get(pickKey(pick));
    return candidate ? [{ pick, candidate }] : [];
  });
}

export function priceNowText(c: CropFitCandidate): string {
  return c.marketNow ? `${formatPerKg(c.marketNow.p50)} on ${formatDate(c.marketNow.date, false)}` : "No recent mandi quotes";
}
export function priceHarvestText(c: { price: PriceEstimate | null }): string {
  const p = c.price;
  if (!p || p.status !== "available" || !p.range) return "No harvest-week price range";
  return p.range.low === p.range.high ? `${formatPerKg(p.range.low)} at harvest` : `₹${Math.round(p.range.low * 10) / 10} to ₹${Math.round(p.range.high * 10) / 10}/kg at harvest`;
}
const BASIS_TEXT: Record<string, string> = { district: "district record", state: "state record", reference: "single published year", farmer: "your figure" };
export function yieldText(c: CropFitCandidate): string {
  if (!c.yieldKgPerHa) return "No regional yield for this product";
  const r = c.yieldKgPerHa;
  const range = r.low === r.high ? formatKg(r.low) : `${group.format(Math.round(r.low))} to ${group.format(Math.round(r.high))} kg`;
  return `${range}/ha${c.yieldBasis ? ` · ${BASIS_TEXT[c.yieldBasis] ?? c.yieldBasis}` : ""}`;
}
/** Profit row: the field total's likely band when the area is known, else per hectare; or why it is not shown. */
export function profitText(c: CropFitCandidate, fieldAreaHa: number | null): { text: string; caption: string | null } {
  if (c.profitForField && fieldAreaHa) return { text: `${formatInrRange(c.profitForField.likely)} for your ${formatArea(fieldAreaHa)}`, caption: null };
  if (c.profitPerHa) return { text: `${formatInrRange(c.profitPerHa.likely)} per ha`, caption: "Per hectare; draw the boundary for your field total" };
  const why = c.reasonCodes.includes("cost_not_sourced") ? "cost of cultivation not sourced" : !c.yieldKgPerHa ? "no regional yield" : "no harvest-week price range";
  return { text: `Not shown: ${why}`, caption: null };
}
export const estimateLines = (e: NumberEstimate) => ({ central: formatInr(e.central), likely: formatInrRange(e.likely), possible: formatInrRange(e.possible) });
export const BAND_NOTE = "Likely = middle half of the simulated outcomes; possible = 10th to 90th percentile.";

// ------------------------------------------------------------------ soil
const SHORT: Record<string, string> = {
  ph: "pH", electrical_conductivity: "EC", organic_carbon: "OC", organic_matter: "OM", nitrogen_available: "N", nitrogen_unspecified: "N", phosphorus_available: "P", phosphorus_total: "P",
  potassium_available: "K", potassium_total: "K", sulphur_available: "S", zinc_available: "Zn", iron_available: "Fe", manganese_available: "Mn", copper_available: "Cu", boron_available: "B",
};
export const shortLabel = (parameter: string, fallback: string) => SHORT[parameter] ?? fallback;
export const ratingText = (r: SoilCheck["rating"]) => (r === "unrated" ? "not rated" : r.replace(/_/g, " "));
export const VERDICT_TEXT: Record<SoilCheck["verdict"], string> = { ok: "OK", watch: "Watch", short: "Short", unknown: "No comparison" };
export const verdictTone = (v: SoilCheck["verdict"]): ChipTone => (v === "ok" ? "done" : v === "watch" ? "watch" : v === "short" ? "warning" : "neutral");
/** Chip text: "N low · needs high", "pH 7.2 · outside crop range", "EC normal". */
export function soilChipText(s: SoilCheck): string {
  const short = shortLabel(s.parameter, s.label);
  if (s.parameter === "ph") {
    const v = s.value !== null ? ` ${s.value}` : "";
    return `${short}${v} · ${s.verdict === "watch" ? "outside crop range" : s.verdict === "ok" ? "in crop range" : "no crop range"}`;
  }
  return `${short} ${ratingText(s.rating)}${s.need ? ` · needs ${s.need}` : ""}`;
}
const ORDER: Record<SoilCheck["verdict"], number> = { short: 0, watch: 1, ok: 2, unknown: 3 };
/** Checks for the card: short and watch first, then ok, then the rest; at most `n`. */
export const cardChecks = (c: CropFitCandidate, n = 4): SoilCheck[] => [...c.soil.checks].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]).slice(0, n);
/** One-line soil verdict for the ranked list. */
export function soilLine(c: CropFitCandidate): string {
  if (c.soil.status === "no_report") return "No confirmed soil report";
  const flagged = c.soil.checks.filter((s) => s.verdict === "short" || s.verdict === "watch");
  if (flagged.length) return flagged.map((s) => `${shortLabel(s.parameter, s.label)} ${s.verdict === "short" ? "short" : "watch"}`).join(", ");
  const ok = c.soil.checks.filter((s) => s.verdict === "ok").length;
  return ok ? `Soil fits on ${ok} marker${ok === 1 ? "" : "s"}` : "No crop need to compare";
}

export const COMPONENT_LABELS: readonly { key: keyof CropFitCandidate["components"]; label: string; weight: number }[] = [
  { key: "price", label: "Price at harvest", weight: 40 },
  { key: "yield", label: "Yield", weight: 30 },
  { key: "soilRotation", label: "Soil and rotation", weight: 15 },
  { key: "water", label: "Water", weight: 10 },
  { key: "confidence", label: "Data confidence", weight: 5 },
];
export const harvestText = (c: CropFitCandidate) => `Harvest ${formatRangeDates(c.harvest.earliest, c.harvest.latest)}`;
export const sowingText = (c: CropFitCandidate) =>
  `Sow ${formatDate(c.sowing)}${c.window && c.window.shiftedDays !== 0 ? ` (moved ${Math.abs(c.window.shiftedDays)} day${Math.abs(c.window.shiftedDays) === 1 ? "" : "s"} into the sowing window)` : ""}`;

// ------------------------------------------------------------------ round 3: plan labels, wait, intercrops, history
/** The one explanatory line under the crop fit heading (ROUND3_SPEC.md 3.1). */
export const SAME_AS_PLAN_LINE = "Same candidates, dates and scoring as the year plan";
/** "Finger millet + pigeon pea (8:1)" for an intercrop, else the plain display name. */
export function candidateTitle(c: Pick<CropFitCandidate, "cropName" | "productName" | "kind" | "companion">): string {
  return isIntercrop(c) ? `${displayName(c)} + ${c.companion!.cropName.toLowerCase()}${ratioStated(c.companion!.rowRatio) ? ` (${c.companion!.rowRatio})` : ""}` : displayName(c);
}
/** Chip text for how the intercrop yield shares were set. */
export const shareBasisText = (comp: Pick<IntercropCompanion, "shareBasis">): string => (comp.shareBasis === "sourced" ? "Sourced shares" : "Assumed shares");
/** "In your year plan: Best overall" (several labels are joined); null when no plan option starts with this crop. */
export const yearPlanText = (c: Pick<CropFitCandidate, "yearPlanLabels">): string | null => (c.yearPlanLabels?.length ? `In your year plan: ${c.yearPlanLabels.join(", ")}` : null);
/** "Grown here before: 2025" from the recorded cycles; null when the crop was never recorded on this farm. */
export function grownBeforeText(c: Pick<CropFitCandidate, "grownBefore">): string | null {
  const g = c.grownBefore;
  if (!g || g.cycles === 0) return null;
  const year = (g.lastHarvest ?? g.lastSowing)?.slice(0, 4);
  return `Grown here before${year ? `: ${year}` : ""}${g.cycles > 1 ? ` (${g.cycles} seasons)` : ""}`;
}
/** "Field idle 7 weeks before sowing, −2 points" (next), "... before sowing" (season, no penalty), or null when there is no wait. */
export function waitLine(c: Pick<CropFitCandidate, "waitDays" | "waitPenalty">): string | null {
  const days = c.waitDays ?? 0;
  if (days <= 0) return null;
  const idle = days >= 14 ? `${Math.round(days / 7)} weeks` : `${days} day${days === 1 ? "" : "s"}`;
  const p = c.waitPenalty;
  if (p === null || p === undefined) return `Field idle ${idle} before sowing`;
  if (p <= 0) return `Field idle ${idle} before sowing, no penalty`;
  const rounded = Math.round(p);
  return `Field idle ${idle} before sowing, ${rounded === 0 ? "less than 1 point" : `−${rounded} point${rounded === 1 ? "" : "s"}`}`;
}
/** Expected harvest from the whole field, when the area is known. */
export function yieldFieldText(c: Pick<CropFitCandidate, "yieldForFieldKg">): string | null {
  const r = c.yieldForFieldKg;
  if (!r) return null;
  return r.low === r.high ? `About ${formatKg(r.low)} from your field` : `About ${group.format(Math.round(r.low))} to ${group.format(Math.round(r.high))} kg from your field`;
}
export function companionYieldText(comp: Pick<IntercropCompanion, "yieldKgPerHa" | "yieldBasis">): string {
  if (!comp.yieldKgPerHa) return "No regional yield for the companion";
  const r = comp.yieldKgPerHa;
  const range = r.low === r.high ? formatKg(r.low) : `${group.format(Math.round(r.low))} to ${group.format(Math.round(r.high))} kg`;
  return `${range}/ha as a sole crop${comp.yieldBasis ? ` · ${BASIS_TEXT[comp.yieldBasis] ?? comp.yieldBasis}` : ""}`;
}
const ARRANGEMENT: Record<string, string> = { row: "alternate rows", paired_row: "paired rows", strip: "strips", mixed: "mixed sowing" };
export const arrangementText = (comp: Pick<IntercropCompanion, "arrangement">): string | null => (comp.arrangement ? ARRANGEMENT[comp.arrangement] ?? comp.arrangement : null);

// ------------------------------------------------------------------ round 3: the reusable picker
/** The crop in the slot being edited (the picker's `current` prop). */
export interface CurrentCrop { cropId: string; productId: string; systemId?: string | null }
/** Picker request: date mode with the swap's previous-crop override (ROUND3_SPEC.md 3.1). */
export const pickerControls = (sowing: string, after: string | null): ControlsState => ({ mode: "date", season: seasonForMonth(sowing), sowing, after });
/** Same crop, product and (for an intercrop) system as the current slot. */
export const isCurrentCandidate = (c: Pick<CropFitCandidate, "cropId" | "productId" | "companion">, current: CurrentCrop | null): boolean =>
  !!current && c.cropId === current.cropId && c.productId === current.productId && (c.companion?.systemId ?? null) === (current.systemId ?? null);
export interface PickerSections {
  /** The current crop's candidate when it is ranked for this date. */
  current: CropFitCandidate | null;
  /** Meta's (or the calculated) picks joined to candidates, minus the current crop, which is shown first. */
  picks: PickCard[];
  /** Every ranked crop except the current one, in ranking order; picks stay in place and carry a chip. */
  rest: CropFitCandidate[];
}
export function pickerSections(r: Pick<CropFitReview, "picks" | "candidates">, current: CurrentCrop | null): PickerSections {
  const ranked = rankedCandidates(r);
  return {
    current: ranked.find((c) => isCurrentCandidate(c, current)) ?? null,
    picks: pickCards(r).filter((card) => !isCurrentCandidate(card.candidate, current)),
    rest: ranked.filter((c) => !isCurrentCandidate(c, current)),
  };
}
/** The row button: the current crop's row keeps it (no change), every other row picks it. */
export const rowAction = (c: Pick<CropFitCandidate, "cropId" | "productId" | "companion">, current: CurrentCrop | null): "keep" | "use" => (isCurrentCandidate(c, current) ? "keep" : "use");

/** A row ratio the research stated; "not stated" (the engine's placeholder) is left out of labels. */
export const ratioStated = (ratio: string | null | undefined) => !!ratio && !/^not stated$/i.test(ratio.trim());

/**
 * Round 3: a rotation order the year plan never proposes (it prunes same-family repeats without a cited succession and
 * cited avoid-after orders) is still ranked here, so the farmer sees it with a warning chip instead of silently.
 */
export function rotationWarningText(c: Pick<CropFitCandidate, "reasonCodes" | "rotation">): string | null {
  const prev = c.rotation.previousCropId ? c.rotation.previousCropId.replace(/-/g, " ") : "the crop before";
  if (c.reasonCodes.includes("avoid_after_violation")) return `A source advises against this order after ${prev}; the year plan avoids it`;
  if (c.reasonCodes.includes("same_family_repeat")) return `Same crop family as ${prev}; the year plan avoids this order`;
  return null;
}
