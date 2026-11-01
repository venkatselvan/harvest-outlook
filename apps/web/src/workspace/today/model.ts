import type {
  IndexId,
  IndexStagePhase,
  IndexStageReading,
  NdviStats,
  PricePoint,
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
