import type {
  CarbonFootprint,
  BasisRef,
  CarbonTerm,
  EnergyEquivalent,
  HarvestEconomics,
  IndexId,
  IndexStagePhase,
  IndexStageReading,
  NdviStats,
  NumberEstimate,
  NumberRange,
  PricePoint,
  ResidueIncome,
  ResidueOption,
  SceneRef,
  StageTimeline,
  TodayView,
  UpcomingStep,
  WeatherPoint,
} from "@harvest/contracts";

/**
 * Pure date, stage and track lookups for the Today view. No DOM, no Solid, so unit tests and Playwright specs can
 * import them. All dates are calendar days (YYYY-MM-DD) handled in UTC so the browser time zone never shifts a day;
 * the server's `today` (Asia/Kolkata) is the reference for "today", not the browser clock.
 */
const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type Stage = StageTimeline["stages"][number];

/** Days since 1970-01-01 for a YYYY-MM-DD date, or NaN when the string is not a valid calendar date. */
export function dayNumber(date: string | null | undefined): number {
  if (!date || !ISO_DAY.test(date)) return NaN;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return NaN;
  const n = Math.round(ms / DAY_MS);
  // Reject roll-over dates such as 2026-02-31, which Date.parse silently moves into March.
  return fromDayNumber(n) === date ? n : NaN;
}
export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}
/** Whole days from `a` to `b` (negative when `b` is earlier). NaN when either date is invalid. */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

// ------------------------------------------------------------------ slider

export interface SliderModel {
  from: string;
  to: string;
  /** Number of day steps; the slider runs 0..total inclusive. */
  total: number;
  /** Step that represents the server's today, clamped into the range. */
  todayIndex: number;
}

/**
 * Slider geometry from `TodayView.slider`. The Today marker uses the server's `today` date when it parses (so the
 * marker and the default position land on an exact day) and falls back to `todayProgress` otherwise.
 */
export function sliderModel(
  view: Pick<TodayView, "slider" | "today">,
): SliderModel | null {
  const slider = view.slider;
  if (!slider) return null;
  const total = daysBetween(slider.from, slider.to);
  if (!Number.isFinite(total) || total < 0) return null;
  const fromToday = daysBetween(slider.from, view.today);
  const todayIndex = Number.isFinite(fromToday)
    ? clamp(fromToday, 0, total)
    : Math.round(clamp(slider.todayProgress, 0, 1) * total);
  return { from: slider.from, to: slider.to, total, todayIndex };
}
export function dateAtIndex(model: SliderModel, index: number): string {
  return addDays(model.from, clamp(Math.round(index), 0, model.total));
}
export function indexOfDate(model: SliderModel, date: string): number {
  const offset = daysBetween(model.from, date);
  return Number.isFinite(offset) ? clamp(offset, 0, model.total) : model.todayIndex;
}
/** Position of a date along the slider, 0..1 (used for ticks and the Today marker). */
export function fractionOf(model: SliderModel, date: string): number {
  return model.total === 0 ? 0 : indexOfDate(model, date) / model.total;
}

// ------------------------------------------------------------------ stages

export type StageAt =
  | { kind: "stage"; stage: Stage; index: number }
  | { kind: "before"; firstStage: Stage | null }
  | { kind: "harvest"; from: string; to: string }
  | { kind: "after"; lastDate: string | null }
  | { kind: "none" };

/**
 * Calendar stage for a date. A stage is a calendar estimate from the recorded establishment date, never an observed
 * state. Between the last stage and the end of the harvest window the date is in the harvest window.
 */
export function stageAt(timeline: StageTimeline | null | undefined, date: string): StageAt {
  if (!timeline || !timeline.stages.length) {
    if (timeline?.harvest && date >= timeline.harvest.earliest && date <= timeline.harvest.latest)
      return { kind: "harvest", from: timeline.harvest.earliest, to: timeline.harvest.latest };
    return { kind: "none" };
  }
  const stages = timeline.stages;
  const index = stages.findIndex((stage) => stage.from <= date && date <= stage.to);
  if (index >= 0) return { kind: "stage", stage: stages[index]!, index };
  if (date < stages[0]!.from) return { kind: "before", firstStage: stages[0]! };
  // A gap between two stages belongs to the earlier stage (stage end dates are inclusive, gaps are rounding).
  for (let i = stages.length - 1; i >= 0; i--)
    if (stages[i]!.to < date && i + 1 < stages.length && date < stages[i + 1]!.from)
      return { kind: "stage", stage: stages[i]!, index: i };
  const harvest = timeline.harvest;
  if (harvest && date <= harvest.latest)
    return { kind: "harvest", from: harvest.earliest, to: harvest.latest };
  return { kind: "after", lastDate: harvest?.latest ?? stages.at(-1)!.to };
}

/** The first stage that starts after `date`, for "Next: <stage> on <date>". */
export function nextStage(timeline: StageTimeline | null | undefined, date: string): Stage | null {
  return timeline?.stages.find((stage) => stage.from > date) ?? null;
}

/** Stage start dates after the first stage, as slider ticks (stage boundaries). */
export function stageTicks(timeline: StageTimeline | null | undefined, model: SliderModel) {
  if (!timeline) return [];
  return timeline.stages
    .filter((stage, i) => i > 0 && stage.from >= model.from && stage.from <= model.to)
    .map((stage) => ({ id: stage.id, name: stage.name, date: stage.from, fraction: fractionOf(model, stage.from) }));
}

/**
 * Schematic growth progress 0..1 for the illustration: linear in calendar days from the first stage (or the timeline
 * anchor) to the latest harvest date (or the last stage end). Drives plant size in the 3D sketch only; it is not a
 * biological growth model.
 */
export function growthProgress(timeline: StageTimeline | null | undefined, date: string): number {
  if (!timeline) return 0;
  const start = timeline.stages[0]?.from ?? timeline.anchorDate;
  const end = timeline.harvest?.latest ?? timeline.stages.at(-1)?.to ?? null;
  if (!end) return 0;
  const span = daysBetween(start, end);
  const done = daysBetween(start, date);
  if (!Number.isFinite(span) || !Number.isFinite(done) || span <= 0) return 0;
  return clamp(done / span, 0, 1);
}

// ------------------------------------------------------------------ tracks

function sortedByDate<T extends { date: string }>(track: readonly T[]): T[] {
  return [...track].sort((a, b) => a.date.localeCompare(b.date));
}

/** Latest point on or before `date`, no more than `maxGapDays` earlier. Null when nothing qualifies. */
export function pointOnOrBefore<T extends { date: string }>(
  track: readonly T[],
  date: string,
  maxGapDays: number,
): T | null {
  let found: T | null = null;
  for (const point of sortedByDate(track)) {
    if (point.date > date) break;
    found = point;
  }
  if (!found) return null;
  const gap = daysBetween(found.date, date);
  return Number.isFinite(gap) && gap <= maxGapDays ? found : null;
}

/** Price track points are weekly; the point for a date is the latest one in the 7 days up to it. */
export const PRICE_MAX_GAP_DAYS = 7;
export function priceAt(track: readonly PricePoint[], date: string): PricePoint | null {
  return pointOnOrBefore(track, date, PRICE_MAX_GAP_DAYS);
}
/** Weather points are daily; only the exact day counts, never a neighbouring day. */
export function weatherAt(track: readonly WeatherPoint[], date: string): WeatherPoint | null {
  return pointOnOrBefore(track, date, 0);
}

export interface PriceTrend {
  direction: "up" | "down" | "flat";
  /** Percentage change of the observed weekly median between the two ends, rounded to a whole number. */
  pct: number;
  since: string;
  until: string;
}
/** Below this absolute change the arrow is flat. A display threshold, not a market signal. */
export const TREND_FLAT_PCT = 3;
/**
 * Trend of observed prices over the 12 months up to `today`: first versus last observed p50 inside that window.
 * Null with fewer than two observed points or a span under 28 days. The label states the actual span used.
 */
export function priceTrend(track: readonly PricePoint[], today: string): PriceTrend | null {
  const start = addDays(today, -365);
  const observed = sortedByDate(track).filter(
    (p) => p.kind === "observed" && p.p50 != null && p.date >= start && p.date <= today,
  );
  if (observed.length < 2) return null;
  const first = observed[0]!, last = observed.at(-1)!;
  if (daysBetween(first.date, last.date) < 28 || !first.p50) return null;
  const pct = Math.round(((last.p50! - first.p50) / first.p50) * 100);
  return {
    direction: pct >= TREND_FLAT_PCT ? "up" : pct <= -TREND_FLAT_PCT ? "down" : "flat",
    pct,
    since: first.date,
    until: last.date,
  };
}

// ------------------------------------------------------------------ satellite scenes

export type ScenePick =
  | { mode: "observed"; scene: SceneRef }
  | { mode: "illustration"; scene: SceneRef; derivedFrom: SceneRef | null }
  | { mode: "latest"; scene: SceneRef }
  | { mode: "none"; reason: "no_scenes" | "none_before_date" };

const observedDate = (scene: SceneRef) => scene.acquisitionDate ?? scene.date;

/**
 * Scene for the slider date. Past and today: the nearest observed scene on or before the date. Future: the
 * illustration for the stage at that date when one with an image exists, else the latest observed scene, labelled
 * as the latest image. Observed scenes without an image path are skipped.
 */
export function sceneFor(
  scenes: readonly SceneRef[],
  date: string,
  today: string,
  stageId: string | null,
): ScenePick {
  const observed = scenes
    .filter((s) => s.kind === "observed" && s.imagePath)
    .sort((a, b) => observedDate(a).localeCompare(observedDate(b)));
  if (date > today) {
    const illustration = stageId
      ? scenes.find((s) => s.kind === "illustration" && s.stageId === stageId && s.imagePath)
      : undefined;
    if (illustration)
      return {
        mode: "illustration",
        scene: illustration,
        derivedFrom: observed.find((s) => s.itemId && s.itemId === illustration.derivedFromItemId) ?? null,
      };
    const latest = observed.filter((s) => observedDate(s) <= today).at(-1);
    return latest ? { mode: "latest", scene: latest } : { mode: "none", reason: observed.length ? "none_before_date" : "no_scenes" };
  }
  if (!observed.length) return { mode: "none", reason: "no_scenes" };
  const nearest = observed.filter((s) => observedDate(s) <= date).at(-1);
  return nearest ? { mode: "observed", scene: nearest } : { mode: "none", reason: "none_before_date" };
}
export { observedDate as sceneDate };

// ------------------------------------------------------------------ formatting

/** "1 Nov 2026" (with year) or "1 Nov". Formatted in UTC so the calendar day never shifts. */
export function formatDay(date: string | null | undefined, withYear = true): string {
  const n = dayNumber(date);
  if (!Number.isFinite(n)) return "date unknown";
  return new Date(n * DAY_MS).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}
/** "12 Nov to 3 Dec"; years are added when the range crosses a calendar year. */
export function rangeLabel(from: string, to: string): string {
  const years = from.slice(0, 4) !== to.slice(0, 4);
  if (from === to) return formatDay(from, years);
  return `${formatDay(from, years)} to ${formatDay(to, years)}`;
}
export function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: value >= 100 ? 0 : 1, minimumFractionDigits: value >= 100 ? 0 : 1 })}`;
}
/**
 * Compact range for a card ("₹19–24"): rounded outward (low down, high up) so the shown range never looks narrower
 * than the data; whole rupees from ₹10, one decimal below that. Exact values stay in the spoken text and the sheet.
 */
export function shortInrRange(low: number, high: number): string {
  const step = high >= 10 ? 1 : 0.1;
  const down = Math.floor(low / step + 1e-9) * step, up = Math.ceil(high / step - 1e-9) * step;
  const fmt = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: step < 1 ? 1 : 0, minimumFractionDigits: step < 1 ? 1 : 0 });
  return `₹${fmt(down)}–${fmt(up)}`;
}
export function formatTemp(value: number | null | undefined): string {
  return value == null ? "–" : `${Math.round(value)}°`;
}
export function formatRain(value: number | null | undefined): string {
  return value == null ? "rain unknown" : `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} mm rain`;
}
export const words = (value: string) =>
  value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// ---------------------------------------------------------------- step windows and the next action (ROUND2_SPEC 2.1)

/** Two dates joined by `joiner`, sharing the month ("3 to 9 Nov"), else full day-month ("28 Oct to 3 Nov"), years when crossing one. */
function joinDays(from: string, to: string, joiner: string): string {
  if (from === to) return formatDay(from, false);
  const years = from.slice(0, 4) !== to.slice(0, 4);
  if (!years && from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))} ${joiner} ${formatDay(to, false)}`;
  return `${formatDay(from, years)} ${joiner} ${formatDay(to, years)}`;
}
/** Step window for a list line: "3 to 9 Nov", "28 Oct to 3 Nov", "9 Nov". */
export const windowLabel = (from: string, to: string) => joinDays(from, to, "to");

const STEP_RANK: Record<UpcomingStep["status"], number> = { overdue: 0, due: 1, upcoming: 2, completed: 3 };
const preferredTier = (step: UpcomingStep) => (step.kind === "care_task" || step.kind === "alert_step" ? 0 : 1);
/**
 * Client copy of the server's next-action rule, used only when the view has no `nextAction` (the degraded care-schedule
 * list): care tasks and alert steps first, then overdue, due, upcoming, then the earlier start.
 */
export function pickNextStep(steps: readonly UpcomingStep[]): UpcomingStep | null {
  return (
    [...steps]
      .filter((step) => step.status !== "completed")
      .sort(
        (a, b) =>
          preferredTier(a) - preferredTier(b) ||
          STEP_RANK[a.status] - STEP_RANK[b.status] ||
          a.dueFrom.localeCompare(b.dueFrom) ||
          a.dueTo.localeCompare(b.dueTo) ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}

/** When-line of the next-action card: "Do between 3 and 9 Nov", "Do on 9 Nov", "Due today", "Overdue since 28 Oct", "Done". */
export function nextActionWhen(step: UpcomingStep, today: string): string {
  if (step.status === "completed") return "Done";
  if (step.status === "overdue") return `Overdue since ${formatDay(step.dueTo, step.dueTo.slice(0, 4) !== today.slice(0, 4))}`;
  if (step.status === "due" && step.dueTo === today) return "Due today";
  if (step.dueFrom === step.dueTo) return `Do on ${formatDay(step.dueFrom, step.dueFrom.slice(0, 4) !== today.slice(0, 4))}`;
  return `Do between ${joinDays(step.dueFrom, step.dueTo, "and")}`;
}

// ---------------------------------------------------------------- spectral indices and the stage reader (open-source comparison, 2026-11-01)

export interface IndexInfo {
  /** Short farmer-facing name. */
  label: string;
  /** One sentence on what the index responds to. Not a diagnosis. */
  meaning: string;
  /** Formula in Sentinel-2 band names, copied from the contract comment in packages/contracts/src/ndvi.ts. */
  formula: string;
  /** Position in the health sheet; the first three are the ones on the Vegetation health card. */
  order: number;
}

/** Formulas are the contract's, so a screen never states a different calculation than the API ran. */
export const INDEX_INFO: Record<IndexId, IndexInfo> = {
  ndmi: {
    label: "Moisture index",
    meaning: "How much water the leaves and canopy seem to hold, from near-infrared against shortwave infrared.",
    formula: "(B8 − B11) / (B8 + B11)",
    order: 1,
  },
  ndre: {
    label: "Red-edge greenness",
    meaning: "Leaf greenness that keeps responding on a dense canopy, where NDVI levels off.",
    formula: "(B8 − B5) / (B8 + B5)",
    order: 2,
  },
  ndwi: {
    label: "Water index",
    meaning: "Open water and flooded ground read above zero; land with a crop normally reads below zero.",
    formula: "(B3 − B8) / (B3 + B8)",
    order: 3,
  },
  evi: {
    label: "Enhanced greenness",
    meaning: "Greenness that is less affected by haze and soil background, and slower to level off than NDVI on a thick canopy.",
    formula: "2.5 × (B8 − B4) / (B8 + 6 × B4 − 7.5 × B2 + 1)",
    order: 4,
  },
  gndvi: {
    label: "Green-band greenness",
    meaning: "Greenness from the green band instead of the red band, often used for leaf chlorophyll.",
    formula: "(B8 − B3) / (B8 + B3)",
    order: 5,
  },
  savi: {
    label: "Soil-adjusted greenness",
    meaning: "Greenness with a correction for bare soil showing between plants, most useful early in the season.",
    formula: "1.5 × (B8 − B4) / (B8 + B4 + 0.5)",
    order: 6,
  },
  lswi: {
    label: "Land surface water",
    meaning: "Water in the canopy and wet surfaces, like the moisture index but from the narrow near-infrared band 8A.",
    formula: "(B8A − B11) / (B8A + B11)",
    order: 7,
  },
};
/** Index ids in the order the health sheet lists them. */
export const INDEX_ORDER: IndexId[] = (Object.keys(INDEX_INFO) as IndexId[]).sort((a, b) => INDEX_INFO[a].order - INDEX_INFO[b].order);
export const indexCode = (id: IndexId) => id.toUpperCase();

/** Two decimals with a true minus sign; "–" when there is no value. Never "-0.00". */
export function formatIndex(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const fixed = value.toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed.replace("-", "−");
}
/** The same number for a screen reader: "minus 0.45". */
export const spokenIndex = (value: number) => formatIndex(value).replace("−", "minus ");

export interface IndexLineItem {
  id: IndexId;
  label: string;
  /** Upper-case index name, "NDMI". */
  code: string;
  /** Field mean of the scene. */
  value: number;
}
/** The indices shown on the Vegetation health card, in this order. */
export const CARD_INDEX_IDS: readonly IndexId[] = ["ndmi", "ndre", "ndwi"];
/** Up to three indices (Moisture index, Red-edge greenness, Water index) that have a field mean in `stats`; none when the scene has no index summaries. */
export function indexLine(stats: Pick<NdviStats, "indices"> | null | undefined): IndexLineItem[] {
  const indices = stats?.indices;
  if (!indices) return [];
  const items: IndexLineItem[] = [];
  for (const id of CARD_INDEX_IDS) {
    const mean = indices[id]?.mean;
    if (typeof mean === "number" && Number.isFinite(mean)) items.push({ id, label: INDEX_INFO[id].label, code: indexCode(id), value: mean });
  }
  return items;
}

/**
 * Reader constants the contract does not carry, mirrored from apps/api/src/services/today/index-stage.ts
 * (STAGE_READER_ASSUMPTIONS minReadings and minSpanDays, STAGE_READER_SOURCES denseCanopyFloor). Change them there first.
 */
export const CURVE_MIN_READINGS = 4;
export const CURVE_MIN_SPAN_DAYS = 30;
/** USGS dense-canopy floor: a smoothed NDVI at or above it is a dense green canopy. */
export const CURVE_DENSE_CANOPY_NDVI = 0.6;
/** The latest clear image is named on the line when it is older than this many days before the view's today. */
export const CURVE_STALE_DAYS = 10;
/** Reasons the reader gives for an `insufficient` reading; any other reason is shown through the reading's own summary. */
export const CURVE_TOO_FEW = "too_few_clear_scenes";
export const CURVE_SPAN_SHORT = "clear_scenes_span_too_short";

export const curvePhaseWords: Record<IndexStagePhase, string> = {
  bare: "bare soil or very sparse cover",
  green_up: "greening up",
  rising: "greening",
  plateau: "steady near its peak",
  falling: "drying down",
  harvested: "harvested look",
  unknown: "unclear",
};
export const curveAgreementWords: Record<IndexStageReading["agreement"], string> = {
  consistent: "in line with the calendar estimate",
  curve_earlier: "behind the calendar",
  curve_later: "ahead of the calendar",
  no_calendar: "no calendar to compare",
  unknown: "",
};
/**
 * Phase in words. A plateau only says the curve is steady near its own peak (a sparse crop peaking at 0.40 is a
 * plateau too), so "dense canopy" is added only when the smoothed value is in the USGS dense band.
 */
export function curvePhaseText(reading: Pick<IndexStageReading, "phase" | "latestSmoothed">): string {
  const words = curvePhaseWords[reading.phase];
  return reading.phase === "plateau" && reading.latestSmoothed != null && reading.latestSmoothed >= CURVE_DENSE_CANOPY_NDVI
    ? `${words} (dense canopy)`
    : words;
}
/**
 * Why an `insufficient` reading is insufficient, in the reader's own terms: too few clear scenes (the minimum applies),
 * a span under 30 days (the count is enough, so no minimum is quoted), or another reason (the reader's summary speaks).
 */
export function curveShortfall(reading: Pick<IndexStageReading, "reason" | "readingsUsed" | "summary">): {
  kind: "too_few" | "span_short" | "other";
  line: string;
  /** Short status words for the sheet. */
  status: string;
  /** What follows the readings count in the sheet ("(at least 4 needed)"); empty for another reason. */
  needed: string;
} {
  if (reading.reason === CURVE_TOO_FEW)
    return {
      kind: "too_few",
      line: `Satellite curve: not enough clear images yet (${reading.readingsUsed} used, ${CURVE_MIN_READINGS} needed)`,
      status: "Not enough clear images yet",
      needed: ` (at least ${CURVE_MIN_READINGS} needed)`,
    };
  if (reading.reason === CURVE_SPAN_SHORT)
    return {
      kind: "span_short",
      line: `Satellite curve: clear images span under ${CURVE_MIN_SPAN_DAYS} days so far (${reading.readingsUsed} used)`,
      status: `Clear images span under ${CURVE_MIN_SPAN_DAYS} days so far`,
      needed: ` (spanning under ${CURVE_MIN_SPAN_DAYS} days so far)`,
    };
  return {
    kind: "other",
    line: reading.summary.trim() || "Satellite curve: not enough satellite data yet",
    status: "Not enough satellite data yet",
    needed: "",
  };
}
/**
 * Short text for the hero line: phase, green-up date and how the curve compares with the calendar estimate.
 * Null (hide the line) when there is no reading or the reader was unavailable. The words describe the field's own
 * satellite curve beside the calendar; they never change the stage dates.
 */
export function curveLine(reading: IndexStageReading | null | undefined): string | null {
  if (!reading || reading.status === "unavailable") return null;
  if (reading.status === "insufficient") return curveShortfall(reading).line;
  const parts: string[] = [curvePhaseText(reading)];
  if (reading.greenUpDate && Number.isFinite(dayNumber(reading.greenUpDate))) parts.push(`green-up seen ${formatDay(reading.greenUpDate, false)}`);
  const agreement = curveAgreementWords[reading.agreement];
  if (agreement) parts.push(agreement);
  return `Satellite curve: ${parts.join(", ")}`;
}
/**
 * "reading of 27 Oct" when the line describes a clear image other than the one the screen is about: any slider date
 * other than today, and today itself when the latest clear image is more than CURVE_STALE_DAYS old. Null otherwise.
 */
export function curveAsOfNote(reading: Pick<IndexStageReading, "asOf"> | null | undefined, date: string, today: string): string | null {
  if (!reading?.asOf || !Number.isFinite(dayNumber(reading.asOf))) return null;
  const age = daysBetween(reading.asOf, today);
  const stale = Number.isFinite(age) && age > CURVE_STALE_DAYS;
  return date !== today || stale ? `reading of ${formatDay(reading.asOf, false)}` : null;
}

// ---------------------------------------------------------------- economics and footprint cards (TODAY_ECONOMICS_FOOTPRINT_SPEC section 6)

const TRUE_MINUS = "\u2212";
const grouped = (value: number, decimals: number) =>
  value.toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
/** A number with a true minus sign (never "-0.0"). `value` is already rounded to `decimals`. */
function signedText(value: number, decimals: number, trim = false): string {
  const text = trim
    ? Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
    : grouped(Math.abs(value), decimals);
  return value < 0 && Number(text.replace(/,/g, "")) !== 0 ? `${TRUE_MINUS}${text}` : text;
}
/**
 * Two ends of a range as one text, rounded outward (low down, high up) so the shown range is never narrower than the
 * data. One number when both ends round to the same value. An en dash joins non-negative ends; ends below zero use
 * "to" so "−0.8–−0.3" is never printed.
 */
export function rangeText(range: NumberRange, decimals: number, trim = false): string {
  const step = 10 ** -decimals;
  const down = Math.floor(range.low / step + 1e-9) * step;
  const up = Math.ceil(range.high / step - 1e-9) * step;
  const low = Number(down.toFixed(decimals)), high = Number(up.toFixed(decimals));
  if (low === high) return signedText(low, decimals, trim);
  return `${signedText(low, decimals, trim)}${low < 0 || high < 0 ? " to " : "–"}${signedText(high, decimals, trim)}`;
}

/** Residue quantity: kilograms in, tonnes out with one decimal and a "t" ("4,200 kg" becomes "4.2 t"). */
export function formatTonnes(kg: number): string {
  return `${signedText(Math.round((kg / 1000) * 10) / 10, 1)} t`;
}
/** A kilogram range as tonnes, "3.8–4.6 t". */
export function formatTonnesRange(kg: NumberRange): string {
  return `${rangeText({ low: kg.low / 1000, high: kg.high / 1000 }, 1)} t`;
}
/** Energy range in gigajoules: one decimal below 100 GJ, whole gigajoules from 100. */
export function formatGJ(range: NumberRange): string {
  return `${rangeText(range, range.high >= 100 ? 0 : 1)} GJ`;
}
/** Parts of a tonnes-of-CO2e range, so a card can set the unit small. Kilograms when the whole range is under 1 t. */
export function co2eParts(range: NumberRange): { short: string; unit: string } {
  if (Math.max(Math.abs(range.low), Math.abs(range.high)) < 1) {
    const kg = { low: range.low * 1000, high: range.high * 1000 };
    return { short: rangeText(kg, 0), unit: "kg CO₂e" };
  }
  return { short: rangeText(range, 1), unit: "t CO₂e" };
}
/** "2.1–3.4 t CO₂e", or "420–610 kg CO₂e" when the whole range is under 1 t. */
export function formatCo2e(range: NumberRange): string {
  const { short, unit } = co2eParts(range);
  return `${short} ${unit}`;
}
/** The same for a screen reader ("2.1 to 3.4 tonnes of carbon dioxide equivalent"). */
export function spokenCo2e(range: NumberRange): string {
  const { short, unit } = co2eParts(range);
  return `${short.replace("–", " to ")} ${unit.startsWith("kg") ? "kilograms" : "tonnes"} of carbon dioxide equivalent`;
}

/** Rupees in the short Indian form for a card: "₹950", "₹4.5k", "₹29.5k", "₹1.2 L" (lakh), "₹1.4 Cr" (crore). */
export function compactInr(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? TRUE_MINUS : "";
  const unit = (div: number, suffix: string, decimals: number) => {
    const text = grouped(Math.round((abs / div) * 10 ** decimals) / 10 ** decimals, decimals).replace(/\.0+$/, "");
    return `${sign}₹${text}${suffix}`;
  };
  if (abs >= 1e7) return unit(1e7, " Cr", 1);
  if (abs >= 1e5) return unit(1e5, " L", 1);
  if (abs >= 1000) return unit(1000, "k", 1);
  return `${sign}₹${grouped(Math.round(abs), 0)}`;
}
/**
 * A rupee range for a card, one shared unit: "₹18–41k", "₹1.2–1.9 L". Lakh only when the low end is itself at least one
 * lakh, so "₹96k to ₹1.3 lakh" is written "₹96–134k" and never as a loosened "₹0.9–1.4 L". Ends of different sign are written in
 * full ("−₹4k to ₹12k").
 */
export function compactInrRange(low: number, high: number): string {
  if (low < 0 || high < 0) return `${compactInr(low)} to ${compactInr(high)}`;
  const [div, suffix] = low >= 1e7 ? [1e7, " Cr"] : low >= 1e5 ? [1e5, " L"] : high >= 1000 ? [1000, "k"] : [1, ""];
  const decimals = div === 1 || low / div >= 10 ? 0 : 1;
  const step = 10 ** -decimals;
  const down = Math.floor(low / div / step + 1e-9) * step, up = Math.ceil(high / div / step - 1e-9) * step;
  const fmt = (v: number) => grouped(Number(v.toFixed(decimals)), decimals);
  return fmt(down) === fmt(up) ? `₹${fmt(down)}${suffix}` : `₹${fmt(down)}–${fmt(up)}${suffix}`;
}
/** Full rupees for a screen reader or a sheet; a loss reads "minus ₹4,200". */
export function spokenInr(value: number): string {
  return value < 0 ? `minus ${formatInr(-value)}` : formatInr(value);
}
/** "₹18,000 to ₹41,000" for a range, in full rupees. */
export function inrRangeText(low: number, high: number): string {
  return `${spokenInr(low)} to ${spokenInr(high)}`;
}

export interface ProfitValue {
  /** Profit when the cost is sourced; revenue (profit not computable) otherwise. */
  kind: "profit" | "revenue";
  /** The whole field when its area is known, else one hectare. */
  scope: "field" | "ha";
  estimate: NumberEstimate;
}
/** The figure the profit card leads with: the field total when `fieldAreaHa` is known, else per hectare. Null when nothing is computable. */
export function profitValue(econ: Pick<HarvestEconomics, "fieldAreaHa" | "profitForField" | "profitPerHa" | "revenueForField" | "revenuePerHa">): ProfitValue | null {
  const field = econ.fieldAreaHa != null;
  if (field && econ.profitForField) return { kind: "profit", scope: "field", estimate: econ.profitForField };
  if (econ.profitPerHa) return { kind: "profit", scope: "ha", estimate: econ.profitPerHa };
  if (field && econ.revenueForField) return { kind: "revenue", scope: "field", estimate: econ.revenueForField };
  if (econ.revenuePerHa) return { kind: "revenue", scope: "ha", estimate: econ.revenuePerHa };
  return null;
}
/** Revenue, for the same scope as the profit figure: the field when the area is known, else per hectare. */
export function revenueValue(econ: Pick<HarvestEconomics, "fieldAreaHa" | "revenueForField" | "revenuePerHa">): { scope: "field" | "ha"; estimate: NumberEstimate } | null {
  if (econ.fieldAreaHa != null && econ.revenueForField) return { scope: "field", estimate: econ.revenueForField };
  return econ.revenuePerHa ? { scope: "ha", estimate: econ.revenuePerHa } : null;
}
/** Cost the profit was computed with: A2+FL when sourced, else C2, times the field area when it is known. Null when no cost is sourced. */
export function costValue(econ: Pick<HarvestEconomics, "fieldAreaHa" | "cost">): { label: string; scope: "field" | "ha"; value: number } | null {
  const a2fl = econ.cost?.a2flPerHa ?? null, c2 = econ.cost?.c2PerHa ?? null;
  const perHa = a2fl ?? c2;
  if (perHa == null) return null;
  const label = a2fl != null ? "A2+FL cost" : "C2 cost";
  return econ.fieldAreaHa != null ? { label, scope: "field", value: perHa * econ.fieldAreaHa } : { label, scope: "ha", value: perHa };
}
export const yieldBasisWords: Record<NonNullable<HarvestEconomics["yieldBasis"]>, string> = {
  district: "district yield",
  state: "state yield",
  reference: "reference yield",
  farmer: "your own recorded yield",
};

/** A residue income in rupees, central value of its range; null when no price is sourced for the use. */
const optionCentre = (option: ResidueOption) => (option.incomeForField ? (option.incomeForField.low + option.incomeForField.high) / 2 : null);
/**
 * Options best first: highest central income, options without an income after every priced one, ties and the unpriced
 * keep the order the API sent. Residue options are alternatives for the same residue, so nothing here adds them up.
 */
export function orderResidueOptions(options: readonly ResidueOption[]): ResidueOption[] {
  return options
    .map((option, index) => ({ option, index, centre: optionCentre(option) }))
    .sort((a, b) => (a.centre == null ? 1 : 0) - (b.centre == null ? 1 : 0) || (b.centre ?? 0) - (a.centre ?? 0) || a.index - b.index)
    .map((entry) => entry.option);
}
export function bestResidueOption(options: readonly ResidueOption[]): ResidueOption | null {
  return orderResidueOptions(options)[0] ?? null;
}
export const RESIDUE_ALTERNATIVES = "Alternatives, not added together";
export const RESIDUE_SHEET_ALTERNATIVES = "These are alternatives for the same residue. The incomes do not add up: the residue can be used once.";
/** "Paddy straw income" from the residue's name; "Residue income" when the API names none. */
export function residueTitle(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)} income` : "Residue income";
}

/**
 * The high end of a term in one common unit: the field value when every baseline term has one, else the per-hectare value
 * for every term (the field area is unknown, so a mix of units is never compared). Shares are the same either way.
 */
function termHighs(terms: readonly CarbonTerm[]): Map<CarbonTerm, number> {
  const baseline = terms.filter((t) => t.kind === "baseline");
  const useField = baseline.every((t) => t.tCO2eForField != null);
  return new Map(baseline.map((t) => [t, (useField ? t.tCO2eForField! : t.tCO2ePerHa).high]));
}
/**
 * The baseline term with the largest high value (the one that dominates the footprint); scenario terms are not baseline.
 * Shared rule with the API summary (TODAY_ECONOMICS_FOOTPRINT_SPEC section 4): "largest" and "mostly" (share of at least
 * 0.5 of the sum of baseline high values) are judged on high values, never on midpoints.
 */
export function largestCarbonTerm(terms: readonly CarbonTerm[]): CarbonTerm | null {
  let best: CarbonTerm | null = null;
  const highs = termHighs(terms);
  for (const [term, high] of highs) if (!best || high > highs.get(best)!) best = term;
  return best;
}
/**
 * "Mostly methane from flooded rice" when the term is at least half of the baseline (by high values, the same rule as
 * `largestCarbonTerm` and the API summary), else "Largest part: ...".
 */
export function carbonTermLine(terms: readonly CarbonTerm[]): string | null {
  const term = largestCarbonTerm(terms);
  if (!term) return null;
  const highs = termHighs(terms);
  const total = [...highs.values()].reduce((sum, high) => sum + Math.max(0, high), 0);
  const label = term.label.charAt(0).toLowerCase() + term.label.slice(1);
  return total > 0 && highs.get(term)! / total >= 0.5 ? `Mostly ${label}` : `Largest part: ${label}`;
}
const RESIDUE_CARBON_NOTE =
  "carbon the residue holds; not a removal and not counted (most of it returns to the air as the residue decays)";
const KEPT_OUT_NOTE = "carbon kept out of the air";
/**
 * The plain-words note a carbon term's figures carry in the sheet, or null. The informational residue-carbon term is
 * never described as a removal; only a term whose method line names a retained share keeps "carbon kept out of the air".
 */
export function carbonTermNote(term: Pick<CarbonTerm, "source" | "method" | "tCO2ePerHa" | "tCO2eForField">): string | null {
  if (term.source === "residue_carbon") return RESIDUE_CARBON_NOTE;
  const negative = term.tCO2ePerHa.low < 0 || term.tCO2ePerHa.high < 0 || (term.tCO2eForField != null && (term.tCO2eForField.low < 0 || term.tCO2eForField.high < 0));
  return negative && /retained share/i.test(term.method) ? KEPT_OUT_NOTE : null;
}
const ORDINALS = ["first", "second", "third"];
/** The rank chip's text and its spoken form. */
export function rankChip(comparison: NonNullable<CarbonFootprint["comparison"]>): { text: string; spoken: string } {
  const place = comparison.rank <= 3 ? ORDINALS[comparison.rank - 1]! : `number ${comparison.rank}`;
  return {
    text: `${comparison.rank} of ${comparison.of} crops`,
    spoken: `Ranked ${place} lowest of ${comparison.of} crops by emissions per hectare`,
  };
}
/** The energy equivalent to quote on the card: household LPG cylinders when the API sent them, else the first. */
export function lpgEquivalent(equivalents: readonly EnergyEquivalent[]): EnergyEquivalent | null {
  return equivalents.find((e) => /lpg/i.test(`${e.label} ${e.unit}`)) ?? null;
}
/** "30–38 cylinders": the amount and its unit as the API sent them (the sheet puts the label in front). */
export function equivalentAmount(eq: EnergyEquivalent): string {
  return `${rangeText(eq.amount, eq.amount.high >= 100 ? 0 : 1)} ${eq.unit}`;
}
/** "30–38 LPG cylinders": the amount, then the unit, with "LPG" kept in the words when only the label names it. */
export function equivalentText(eq: EnergyEquivalent): string {
  const unit = /lpg/i.test(eq.label) && !/lpg/i.test(eq.unit) ? `LPG ${eq.unit}` : eq.unit;
  return `${rangeText(eq.amount, eq.amount.high >= 100 ? 0 : 1)} ${unit}`;
}
/**
 * The energy card's one-line basis: "Published energy study · Andhra Pradesh 1996-97", with the region and year parsed from
 * the basis text ("IN-AP (Andhra Pradesh, 20 districts)", the last year or year range in it) or from the energy_reference
 * BasisRef's scope and note. A basis from which neither parses is cut to 60 characters with an ellipsis. The full citation
 * stays in the sheet.
 */
export function energyBasisShort(basis: string | null | undefined, refs: readonly Pick<BasisRef, "kind" | "scope" | "note">[] = []): string {
  const text = basis?.trim() ?? "";
  const ref = refs.find((r) => r.kind === "energy_reference");
  const years = (value: string) => value.match(/\b(?:19|20)\d{2}(?:-\d{2})?\b/g)?.at(-1) ?? null;
  const region = text.match(/\bIN-[A-Z]{2}\s*\(([^,)]+)/)?.[1]?.trim() ?? (ref?.scope?.trim() || null);
  const year = years(text) ?? (ref?.note ? years(ref.note) : null);
  const where = [region, year].filter(Boolean).join(" ");
  if (where) return `Published energy study · ${where}`;
  if (!text) return "Published energy-use studies and calorific values";
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
}
/** The reason a block has no figure: the first limitation, else the reason when it reads as a sentence, else the fallback. */
export function unavailableReason(block: { reason: string | null; limitations: readonly string[] }, fallback: string): string {
  const first = block.limitations[0]?.trim();
  if (first) return first;
  const reason = block.reason?.trim();
  return reason && /\s/.test(reason) ? reason : fallback;
}
