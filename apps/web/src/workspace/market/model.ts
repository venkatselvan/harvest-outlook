import type {
  MarketAnalogueYear,
  MarketEvent,
  MarketTimeline,
  MarketTimelinePoint,
} from "@harvest/contracts";

/**
 * Pure helpers for the Market timeline view (ROUND2_SPEC 3.2): week labels, slider keys, card summaries, the analogue
 * overlay mapping and the SVG chart geometry. No DOM and no Solid, so unit tests and Playwright specs can import them.
 * Dates are calendar days (YYYY-MM-DD) handled in UTC so the browser time zone never shifts a day.
 */
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parts = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d };
};
/** "26 Oct 2026" (or "26 Oct" without the year). */
export function formatDate(date: string, withYear = true): string {
  const { y, m, d } = parts(date);
  if (!y || !m || !d) return "date unknown";
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}
/** "Oct 2026". */
export function formatMonth(date: string): string {
  const { y, m } = parts(date);
  return `${MONTHS[m - 1] ?? ""} ${y}`;
}
/** Slider value text and card headings: "Week of 26 Oct 2026". */
export function weekLabel(point: Pick<MarketTimelinePoint, "weekStart">): string {
  return `Week of ${formatDate(point.weekStart)}`;
}
/** "26 Oct to 1 Nov 2026". */
export function weekSpan(point: Pick<MarketTimelinePoint, "weekStart" | "weekEnd">): string {
  const sameYear = point.weekStart.slice(0, 4) === point.weekEnd.slice(0, 4);
  return `${formatDate(point.weekStart, !sameYear)} to ${formatDate(point.weekEnd)}`;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Per-kg mandi price: whole rupees from 100, one decimal below. */
export function formatInr(value: number): string {
  return `₹${value >= 100 ? Math.round(value).toLocaleString("en-IN") : value.toFixed(1)}`;
}
/** "₹21.5–22.5" with one formatting rule for both ends. */
export function inrRange(low: number, high: number): string {
  return `${formatInr(low)}–${formatInr(high).slice(1)}`;
}
export function formatRain(mm: number | null): string {
  if (mm === null) return "Rain unknown";
  return `${mm < 10 ? mm.toFixed(1).replace(/\.0$/, "") : Math.round(mm).toLocaleString("en-IN")} mm`;
}
export const formatTemp = (c: number | null) => (c === null ? "–" : `${Math.round(c)}°`);
export function formatPct(pct: number): string {
  const r = Math.round(pct);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

// ------------------------------------------------------------------ slider

/**
 * Index change for a slider key: arrows move exactly one week, Page keys four weeks, Home and End the ends.
 * Returns null for keys the slider does not handle (so the browser keeps its default).
 */
export function stepForKey(key: string, index: number, last: number): number | null {
  const clamp = (v: number) => Math.max(0, Math.min(last, v));
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(index + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(index - 1);
    case "PageUp":
      return clamp(index + 4);
    case "PageDown":
      return clamp(index - 4);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ cards

export type PriceChip = "Observed" | "Reference" | null;
export interface PriceSummary {
  value: string | null;
  chip: PriceChip;
  band: string;
  spoken: string;
}

const NONE_TEXT: Record<string, string> = {
  no_quotes_this_week: "No mandi quotes this week",
  price_history_not_ingested: "No mandi price series is stored for this product yet",
  market_not_in_history: "No quotes for this product in these markets in the reference years",
  no_state_quotes: "No quotes from this state's mandis for this product",
  farm_state_unknown: "The farm's state is not recorded",
  price_history_insufficient: "Too few years with quotes near this week for a reference",
  price_residuals_insufficient: "Too few weeks of quotes to measure the year-to-year range",
  price_interval_crossing: "The reference range could not be computed consistently",
};
export const noneText = (reason: string) => NONE_TEXT[reason] ?? "No price for this week";

export function priceSummary(point: MarketTimelinePoint): PriceSummary {
  const p = point.price;
  if (p.kind === "observed") {
    const days = `${p.n} market-day${p.n === 1 ? "" : "s"}, ${p.markets} market${p.markets === 1 ? "" : "s"}`;
    return {
      value: formatInr(p.p50),
      chip: "Observed",
      band: p.min === p.max ? `One price across ${days}` : `Range ${inrRange(p.min, p.max)} across ${days}`,
      spoken: `${weekLabel(point)}: observed weekly median ${formatInr(p.p50)} per kg, range ${formatInr(p.min)} to ${formatInr(p.max)}.`,
    };
  }
  if (p.kind === "reference") {
    return {
      value: formatInr(p.p50),
      chip: "Reference",
      band: `Likely ${inrRange(p.likely.low, p.likely.high)} · possible ${inrRange(p.possible.low, p.possible.high)}${p.yearsUsed.length ? ` (${p.yearsUsed.join(", ")})` : ""}`,
      spoken: `${weekLabel(point)}: seasonal reference ${formatInr(p.p50)} per kg, likely ${formatInr(p.likely.low)} to ${formatInr(p.likely.high)}, not a forecast.`,
    };
  }
  return { value: null, chip: null, band: noneText(p.reason), spoken: `${weekLabel(point)}: ${noneText(p.reason)}.` };
}

export type WeatherChip = "Observed" | "Forecast" | "Typical" | null;
export interface WeatherSummary {
  rain: string;
  temps: string | null;
  chip: WeatherChip;
  coverage: string;
}
const WEATHER_CHIP = { observed: "Observed", forecast: "Forecast", typical: "Typical", unavailable: null } as const;

export function weatherSummary(point: MarketTimelinePoint): WeatherSummary {
  const w = point.weather;
  if (w.kind === "unavailable") return { rain: "No weather stored", temps: null, chip: null, coverage: "No observations, forecast or typical values for this week" };
  const coverage =
    w.days === 7
      ? w.kind === "typical"
        ? "Typical for these dates, all 7 days"
        : "All 7 days"
      : `${w.days} of 7 days ${w.kind === "observed" ? "observed" : w.kind === "forecast" ? "forecast" : "typical"}`;
  return {
    rain: formatRain(w.rainMm),
    temps: w.tMaxC === null && w.tMinC === null ? null : `${formatTemp(w.tMaxC)}/${formatTemp(w.tMinC)}`,
    chip: WEATHER_CHIP[w.kind],
    coverage,
  };
}

export const severityTone = (s: MarketEvent["severity"]) => s;
export function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//.test(url) ? url : null;
}

// ------------------------------------------------------------------ analogues

/** Monsoon year of the crop year (July to June) that contains `date`. */
export const cropYearOf = (date: string) => {
  const { y, m } = parts(date);
  return m >= 7 ? y : y - 1;
};
const isoWeekNumber = (label: string) => Number(label.split("-W")[1]);

/**
 * An analogue year's weekly path drawn over this crop year (July to June containing today): each timeline week in that
 * span takes the analogue's median for the same ISO week number, when it has one.
 */
export function analogueOverlay(
  timeline: Pick<MarketTimeline, "points" | "today">,
  year: Pick<MarketAnalogueYear, "pricePath">,
): { index: number; p50: number }[] {
  const y = cropYearOf(timeline.today);
  const start = `${y}-07-01`;
  const end = `${y + 1}-06-30`;
  const byWeek = new Map(year.pricePath.map((p) => [p.isoWeek, p.p50]));
  const out: { index: number; p50: number }[] = [];
  timeline.points.forEach((p, index) => {
    if (p.weekStart < start || p.weekStart > end) return;
    const v = byWeek.get(isoWeekNumber(p.isoWeek));
    if (v !== undefined) out.push({ index, p50: v });
  });
  return out;
}

// ------------------------------------------------------------------ chart geometry

export const CHART_W = 1000;
export const CHART_H = 220;
const PAD_TOP = 14;
const PAD_BOTTOM = 10;

export interface ChartOverlay {
  cropYear: string;
  points: { index: number; p50: number }[];
}
export interface ChartGeometry {
  n: number;
  x: (index: number) => number;
  y: (value: number) => number;
  step: number;
  min: number;
  max: number;
  observedLine: string;
  observedDots: { x: number; y: number }[];
  observedBand: string;
  referenceLine: string;
  likelyBand: string;
  possibleBand: string;
  overlays: { cropYear: string; path: string }[];
  todayX: number;
  harvest: { x: number; width: number } | null;
  hasPrice: boolean;
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/** Contiguous runs of indices for which `pick` returns a value. */
function runs<T>(n: number, pick: (i: number) => T | null): { index: number; v: T }[][] {
  const out: { index: number; v: T }[][] = [];
  let cur: { index: number; v: T }[] = [];
  for (let i = 0; i < n; i++) {
    const v = pick(i);
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push({ index: i, v });
  }
  if (cur.length) out.push(cur);
  return out;
}

function linePath(run: { x: number; y: number }[]): string {
  return run.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("");
}
/** Closed band between `hi` (left to right) and `lo` (right to left); single-point runs get a narrow box. */
function bandPath(run: { x: number; lo: number; hi: number }[], halfWidth: number): string {
  const pts = run.length === 1 ? [{ ...run[0]!, x: run[0]!.x - halfWidth }, { ...run[0]!, x: run[0]!.x + halfWidth }] : run;
  const top = pts.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.hi)}`).join("");
  const bottom = [...pts].reverse().map((p) => `L${f(p.x)} ${f(p.lo)}`).join("");
  return `${top}${bottom}Z`;
}

export function chartGeometry(timeline: Pick<MarketTimeline, "points" | "todayIndex" | "harvestWindow">, overlays: ChartOverlay[] = []): ChartGeometry {
  const pts = timeline.points;
  const n = Math.max(1, pts.length);
  const step = CHART_W / n;
  const x = (i: number) => (i + 0.5) * step;
  const values: number[] = [];
  for (const p of pts) {
    if (p.price.kind === "observed") values.push(p.price.min, p.price.max, p.price.p50);
    if (p.price.kind === "reference") values.push(p.price.possible.low, p.price.possible.high, p.price.p50);
  }
  for (const o of overlays) for (const p of o.points) values.push(p.p50);
  const hasPrice = values.length > 0;
  let min = hasPrice ? Math.min(...values) : 0;
  let max = hasPrice ? Math.max(...values) : 1;
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * 0.04;
  max += span * 0.04;
  const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * (CHART_H - PAD_TOP - PAD_BOTTOM);

  const obs = runs(pts.length, (i) => {
    const p = pts[i]!.price;
    return p.kind === "observed" ? p : null;
  });
  const ref = runs(pts.length, (i) => {
    const p = pts[i]!.price;
    return p.kind === "reference" ? p : null;
  });
  const half = step * 0.35;
  const observedLine = obs.filter((r) => r.length > 1).map((r) => linePath(r.map((p) => ({ x: x(p.index), y: y(p.v.p50) })))).join("");
  const observedDots = obs.filter((r) => r.length === 1).map((r) => ({ x: x(r[0]!.index), y: y(r[0]!.v.p50) }));
  const observedBand = obs.map((r) => bandPath(r.map((p) => ({ x: x(p.index), lo: y(p.v.min), hi: y(p.v.max) })), half)).join("");
  const referenceLine = ref.map((r) => (r.length > 1 ? linePath(r.map((p) => ({ x: x(p.index), y: y(p.v.p50) }))) : `M${f(x(r[0]!.index) - half)} ${f(y(r[0]!.v.p50))}L${f(x(r[0]!.index) + half)} ${f(y(r[0]!.v.p50))}`)).join("");
  const likelyBand = ref.map((r) => bandPath(r.map((p) => ({ x: x(p.index), lo: y(p.v.likely.low), hi: y(p.v.likely.high) })), half)).join("");
  const possibleBand = ref.map((r) => bandPath(r.map((p) => ({ x: x(p.index), lo: y(p.v.possible.low), hi: y(p.v.possible.high) })), half)).join("");
  const overlayPaths = overlays.map((o) => {
    const byIndex = new Map(o.points.map((p) => [p.index, p.p50]));
    const segs = runs(pts.length, (i) => byIndex.get(i) ?? null);
    return { cropYear: o.cropYear, path: segs.filter((r) => r.length > 1).map((r) => linePath(r.map((p) => ({ x: x(p.index), y: y(p.v) })))).join("") };
  });

  let harvest: ChartGeometry["harvest"] = null;
  const hw = timeline.harvestWindow;
  if (hw && pts.length) {
    const first = pts.findIndex((p) => p.weekEnd >= hw.earliest);
    let last = -1;
    for (let i = pts.length - 1; i >= 0; i--)
      if (pts[i]!.weekStart <= hw.latest) {
        last = i;
        break;
      }
    if (first >= 0 && last >= first) harvest = { x: first * step, width: (last - first + 1) * step };
  }
  return {
    n,
    x,
    y,
    step,
    min,
    max,
    observedLine,
    observedDots,
    observedBand,
    referenceLine,
    likelyBand,
    possibleBand,
    overlays: overlayPaths,
    todayX: x(timeline.todayIndex),
    harvest,
    hasPrice,
  };
}

/** Year boundaries along the x axis (first week of each January), as fractions 0..1 for HTML labels. */
export function yearTicks(points: Pick<MarketTimelinePoint, "weekStart" | "isoWeek">[]): { fraction: number; label: string }[] {
  const out: { fraction: number; label: string }[] = [];
  const n = Math.max(1, points.length);
  points.forEach((p, i) => {
    if (isoWeekNumber(p.isoWeek) === 1) out.push({ fraction: (i + 0.5) / n, label: p.isoWeek.slice(0, 4) });
  });
  return out;
}

/** Plain-language summary of the chart for its accessible name. */
export function chartLabel(timeline: MarketTimeline): string {
  const obs = timeline.points.flatMap((p) => (p.price.kind === "observed" ? [p.price.p50] : []));
  const ref = timeline.points.flatMap((p) => (p.price.kind === "reference" ? [p.price.p50] : []));
  const span = `${formatMonth(timeline.from)} to ${formatMonth(timeline.to)}`;
  if (!obs.length && !ref.length) return `${timeline.productName}: no mandi price series for ${span}.`;
  const parts: string[] = [];
  if (obs.length) parts.push(`observed weekly medians between ${formatInr(Math.min(...obs))} and ${formatInr(Math.max(...obs))} per kg`);
  if (ref.length) parts.push(`seasonal reference ahead between ${formatInr(Math.min(...ref))} and ${formatInr(Math.max(...ref))} per kg, not a forecast`);
  return `${timeline.productName} mandi price by week, ${span}: ${parts.join("; ")}.`;
}

/** True when no week of the timeline has any price (observed or reference). */
export const hasNoPrices = (timeline: Pick<MarketTimeline, "points">) => timeline.points.every((p) => p.price.kind === "none");
