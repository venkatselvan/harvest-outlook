import type { CropFitCandidate, CropFitPick, CropFitReview, CropSeason, NumberEstimate, SoilCheck } from "@harvest/contracts";
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
/** Latest sowing date the server accepts (routes/crop-fit.ts). */
export const MAX_DAYS_AHEAD = 400;

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
export const defaultControls = (todayIso: string): ControlsState => ({ mode: "date", season: seasonForMonth(todayIso), sowing: todayIso });
/** Controls that match the review the server resolved (the first GET sends no mode; the server picks the default). */
export function controlsFromReview(review: Pick<CropFitReview, "request">, current: ControlsState): ControlsState {
  const r = review.request;
  return { mode: r.mode, season: r.season ?? current.season, sowing: r.sowing ?? current.sowing };
}
/** Query string for a request; parameters that do not apply to the mode are left out. */
export function queryFor(c: ControlsState | null): string {
  if (!c) return "";
  const q = new URLSearchParams({ mode: c.mode });
  if (c.mode === "season") q.set("season", c.season);
  if (c.mode === "date") q.set("sowing", c.sowing);
  return `?${q.toString()}`;
}
/** Problems with the picked date, or null when it can be sent. */
export function sowingProblem(sowing: string, todayIso: string): string | null {
  if (!isIsoDate(sowing)) return "Enter a sowing date.";
  if (sowing < todayIso) return "Pick today or a later date.";
  if (sowing > addDaysIso(todayIso, MAX_DAYS_AHEAD)) return "Pick a date within about a year.";
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
export const candidateKey = (c: Pick<CropFitCandidate, "cropId" | "productId">) => `${c.cropId}|${c.productId}`;
/** Display name, with the product when the crop has several marketed forms ("Chilli (dry)"). */
export function displayName(c: Pick<CropFitCandidate, "cropName" | "productName">): string {
  return /\b(dry|green|fresh)\b/i.test(c.productName) && c.productName.toLowerCase() !== c.cropName.toLowerCase() ? `${c.cropName} (${c.productName.toLowerCase()})` : c.cropName;
}
export interface PickCard { pick: CropFitPick; candidate: CropFitCandidate }
/** Picks joined to their candidates in pick order; a pick whose candidate is missing is dropped. */
export function pickCards(r: Pick<CropFitReview, "picks" | "candidates">): PickCard[] {
  const by = new Map(r.candidates.map((c) => [candidateKey(c), c]));
  return [...r.picks].sort((a, b) => a.rank - b.rank).flatMap((pick) => {
    const candidate = by.get(candidateKey(pick));
    return candidate ? [{ pick, candidate }] : [];
  });
}

export function priceNowText(c: CropFitCandidate): string {
  return c.marketNow ? `${formatPerKg(c.marketNow.p50)} on ${formatDate(c.marketNow.date, false)}` : "No recent mandi quotes";
}
export function priceHarvestText(c: CropFitCandidate): string {
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
