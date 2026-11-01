/**
 * Pure formatting and calendar math for the Year plan view. No locale-dependent APIs for dates, so unit tests, the
 * browser and the server-side renderer agree. ISO dates are calendar dates (no time zone shift).
 */

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface YMD {
  y: number;
  /** 1..12 */
  m: number;
  d: number;
}

export function parseIso(iso: string): YMD {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const monthName = (m: number) => MONTH_SHORT[m - 1] ?? "";

/** "2026-12-01" -> "1 Dec" */
export const shortDate = (iso: string) => {
  const p = parseIso(iso);
  return `${p.d} ${monthName(p.m)}`;
};
/** "2026-12-01" -> "1 Dec 2026" */
export const longDate = (iso: string) => `${shortDate(iso)} ${parseIso(iso).y}`;
/** "2026-09-01" -> "Sep 2026" */
export const monthYear = (iso: string) => {
  const p = parseIso(iso);
  return `${monthName(p.m)} ${p.y}`;
};
/** "2026-11-18" -> "mid-Nov" (1-10 early, 11-20 mid, 21+ late). */
export const partOfMonth = (iso: string) => {
  const p = parseIso(iso);
  return `${p.d <= 10 ? "early" : p.d <= 20 ? "mid" : "late"}-${monthName(p.m)}`;
};
/** Two dates as a compact span: "1 Dec to 8 Apr". */
export const shortSpan = (from: string, to: string) => `${shortDate(from)} to ${shortDate(to)}`;
/** "1 Dec 2026 to 8 Apr 2027", or "10 to 18 Nov 2026" within one month. */
export function longSpan(from: string, to: string): string {
  const a = parseIso(from);
  const b = parseIso(to);
  if (a.y === b.y && a.m === b.m) return `${a.d} to ${b.d} ${monthName(b.m)} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${monthName(a.m)} to ${b.d} ${monthName(b.m)} ${b.y}`;
  return `${longDate(from)} to ${longDate(to)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Month grid. Column 0 is the month containing the horizon start. Positions are fractional months from the first day of
// that month, so day 16 of a 31-day month sits at +15/31.

/** Fractional month position of the start (or, with endOfDay, the end) of `iso` relative to `originIso`'s month. */
export function monthPosition(iso: string, originIso: string, endOfDay = false): number {
  const p = parseIso(iso);
  const o = parseIso(originIso);
  const whole = (p.y - o.y) * 12 + (p.m - o.m);
  return whole + (p.d - (endOfDay ? 0 : 1)) / daysInMonth(p.y, p.m);
}

export interface MonthColumn {
  key: string;
  /** "Sep" */
  label: string;
  year: number;
  month: number;
  /** True for the first column and for every January, so the year can be shown once per year. */
  showYear: boolean;
}

export function monthColumns(originIso: string, count = 12): MonthColumn[] {
  const o = parseIso(originIso);
  return Array.from({ length: count }, (_, i) => {
    const index = o.m - 1 + i;
    const year = o.y + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return {
      key: `${year}-${String(month).padStart(2, "0")}`,
      label: monthName(month),
      year,
      month,
      showYear: i === 0 || month === 1,
    };
  });
}

export interface StripPlacement {
  /** Percent of the grid width. */
  left: number;
  width: number;
  /** The strip starts before the first column or ends after the last; the visible part is clipped. */
  clippedStart: boolean;
  clippedEnd: boolean;
  visible: boolean;
}

/**
 * Place a strip from the start of `fromIso` to the end of `toIso` on a `columns`-month grid that begins in
 * `originIso`'s month. Works across year boundaries; clips to the grid and reports the clipping.
 */
export function stripPlacement(fromIso: string, toIso: string, originIso: string, columns = 12): StripPlacement {
  const start = monthPosition(fromIso, originIso);
  const end = monthPosition(toIso, originIso, true);
  const a = Math.max(0, Math.min(columns, start));
  const b = Math.max(0, Math.min(columns, end));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    left: round((a / columns) * 100),
    width: round((Math.max(0, b - a) / columns) * 100),
    clippedStart: start < 0,
    clippedEnd: end > columns,
    visible: b > a,
  };
}

/** Column index of `todayIso` on the grid, or null when today is outside it. */
export function columnOf(todayIso: string, originIso: string, columns = 12): number | null {
  const pos = monthPosition(todayIso, originIso);
  return pos >= 0 && pos < columns ? Math.floor(pos) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Money and quantity. Indian grouping and units: thousand, lakh (1,00,000), crore (1,00,00,000).

const MINUS = "−";
const trim = (s: string) => s.replace(/\.0$/, "");

interface Scaled {
  sign: string;
  number: string;
  unit: "" | "thousand" | "lakh" | "crore";
}

function scale(value: number): Scaled {
  const sign = value < 0 ? MINUS : "";
  const a = Math.abs(value);
  // Thresholds use the rounded value so 99,999 reads "₹1 lakh", not "₹100 thousand".
  if (a >= 99.95e5) return { sign, number: trim((a / 1e7).toFixed(1)), unit: "crore" };
  if (a >= 99.5e3) return { sign, number: trim((a / 1e5).toFixed(1)), unit: "lakh" };
  if (a >= 1e4) return { sign, number: String(Math.round(a / 1e3)), unit: "thousand" };
  if (a >= 1e3) return { sign, number: trim((a / 1e3).toFixed(1)), unit: "thousand" };
  return { sign, number: String(Math.round(a)), unit: "" };
}

/** 52_000 -> "₹52 thousand"; 1_42_822 -> "₹1.4 lakh"; -1_659 -> "−₹1.7 thousand"; 541 -> "₹541". */
export function formatInr(value: number): string {
  const s = scale(value);
  if (s.number === "0") return "₹0";
  return `${s.sign}₹${s.number}${s.unit ? ` ${s.unit}` : ""}`;
}

/**
 * A rupee range in words. Shares the unit when both ends use the same one and neither is negative
 * ("₹42 to 61 thousand"); otherwise spells out both ends ("₹52 thousand to ₹1.4 lakh", "−₹1.7 thousand to ₹19 thousand").
 * The ends are ordered low to high.
 */
export function formatInrRange(range: { low: number; high: number }): string {
  const lowValue = Math.min(range.low, range.high);
  const highValue = Math.max(range.low, range.high);
  const low = scale(lowValue);
  const high = scale(highValue);
  if (formatInr(lowValue) === formatInr(highValue)) return `about ${formatInr(highValue)}`;
  if (!low.sign && !high.sign && low.unit === high.unit && low.unit && low.number !== "0")
    return `₹${low.number} to ${high.number} ${high.unit}`;
  return `${formatInr(lowValue)} to ${formatInr(highValue)}`;
}

const grouped = (n: number) => Math.round(n).toLocaleString("en-IN");

/** 3600..4400 kg/ha -> "3,600 to 4,400 kg"; rounded to tens below 1,000 and to fifties above. */
export function formatKgRange(range: { low: number; high: number }): string {
  const r = (n: number) => (n >= 1000 ? Math.round(n / 50) * 50 : Math.round(n / 10) * 10);
  return `${grouped(r(range.low))} to ${grouped(r(range.high))} kg`;
}

/** Mandi price per kg: one decimal below ₹100, whole rupees above. */
export const formatPerKg = (value: number) =>
  `₹${value >= 100 ? grouped(value) : value.toFixed(1).replace(/\.0$/, "")}`;
export const formatPerKgRange = (range: { low: number; high: number }) =>
  `${formatPerKg(range.low)} to ${formatPerKg(range.high)} per kg`;

// ---------------------------------------------------------------------------------------------------------------------
// Full rupee figures for profit headlines and estimate bands (round 2). The words form above ("₹52 thousand") hides
// the size of a small field's profit and turns "-₹3 thousand to ₹84 thousand" into a puzzle, so these keep every digit,
// rounded to the nearest ₹100, with Indian digit grouping (₹1,23,400).

/** 123400 -> "1,23,400"; 4100 -> "4,100". Non-negative integers only. */
function groupIndian(n: number): string {
  const digits = String(n);
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Nearest ₹100, rounding halves away from zero so a loss and a gain of the same size read alike. */
export const roundToHundred = (value: number) => Math.sign(value) * Math.round(Math.abs(value) / 100) * 100;

/** 123400 -> "₹1,23,400"; 4149 -> "₹4,100"; -3150 -> "−₹3,200"; a value that rounds to zero is "₹0". */
export function formatInrFull(value: number): string {
  if (!Number.isFinite(value)) return "not available";
  const rounded = roundToHundred(value);
  if (rounded === 0) return "₹0";
  return `${rounded < 0 ? MINUS : ""}₹${groupIndian(Math.abs(rounded))}`;
}

/**
 * A band in full rupees, ordered low to high: "₹4,100 to ₹9,800", "−₹3,100 to ₹84,000". A band whose two ends are the
 * same number (a cost known exactly) is that one figure; ends that only round to the same ₹100 read "about ₹4,100".
 */
export function formatInrBand(range: { low: number; high: number }): string {
  const lowest = Math.min(range.low, range.high);
  const highest = Math.max(range.low, range.high);
  if (lowest === highest) return formatInrFull(highest);
  const low = formatInrFull(lowest);
  const high = formatInrFull(highest);
  return low === high ? `about ${high}` : `${low} to ${high}`;
}

/** Field area in hectares with at most two decimals and no trailing zeros: 0.16 -> "0.16", 1.2 -> "1.2", 2 -> "2". */
export function formatAreaHa(ha: number): string {
  if (!Number.isFinite(ha) || ha <= 0) return "0";
  if (ha < 0.005) return "under 0.01";
  return ha.toFixed(2).replace(/\.?0+$/, "");
}
