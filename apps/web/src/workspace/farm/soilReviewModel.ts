import type { SoilRating, SoilRatingBand, SoilReading, SoilReview } from "@harvest/contracts";

/**
 * Pure helpers for the soil biomarker view (ROUND2_SPEC.md 5.3): bar geometry, rating tones and labels, and the text
 * shown for each reading. Nothing here rates anything: ratings, bands and axes come from the server (code), the view
 * only draws them.
 */

export interface Axis {
  min: number;
  max: number;
}

/** Position of a value on the axis, 0 (left edge) to 1 (right edge), clamped; null when there is nothing to draw. */
export function barPosition(value: number | null | undefined, axis: Axis | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!axis || !(axis.max > axis.min)) return null;
  return Math.min(1, Math.max(0, (value - axis.min) / (axis.max - axis.min)));
}

/** True when the value lies outside the drawn axis (the marker is then pinned to the edge). */
export function beyondAxis(value: number | null | undefined, axis: Axis | null | undefined): "below" | "above" | null {
  if (value === null || value === undefined || !axis || !(axis.max > axis.min)) return null;
  return value < axis.min ? "below" : value > axis.max ? "above" : null;
}

export type ZoneTone = "bad" | "caution" | "ok" | "good" | "none";
const TONES: Record<SoilRating, ZoneTone> = {
  very_low: "bad",
  low: "bad",
  deficient: "bad",
  strongly_acidic: "bad",
  strongly_alkaline: "bad",
  injurious: "bad",
  acidic: "caution",
  alkaline: "caution",
  critical: "caution",
  medium: "ok",
  high: "good",
  very_high: "good",
  sufficient: "good",
  neutral: "good",
  normal: "good",
  unrated: "none",
};
export const zoneTone = (rating: SoilRating): ZoneTone => TONES[rating];

export type RatingChipTone = "warning" | "watch" | "neutral" | "done";
/** Chip tone for a rating: red for short or harmful zones, plain for the middle, green for sufficient. */
export function ratingChipTone(rating: SoilRating): RatingChipTone {
  const tone = zoneTone(rating);
  return tone === "bad" ? "warning" : tone === "caution" ? "watch" : tone === "good" ? "done" : "neutral";
}

export function ratingLabel(rating: SoilRating | string): string {
  if (rating === "unrated") return "Not rated";
  const text = rating.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface Segment {
  label: SoilRating;
  tone: ZoneTone;
  /** Left edge and width as fractions of the axis (0..1); segments tile the axis. */
  left: number;
  width: number;
  note: string | null;
}

/** The coloured zones of the bar: each band clipped to the axis, open ends extended to the axis edges. */
export function bandSegments(bands: readonly SoilRatingBand[], axis: Axis | null | undefined): Segment[] {
  if (!axis || !(axis.max > axis.min)) return [];
  const out: Segment[] = [];
  for (const band of bands) {
    const from = barPosition(band.from ?? axis.min, axis);
    const to = barPosition(band.to ?? axis.max, axis);
    if (from === null || to === null || to - from <= 0) continue;
    out.push({ label: band.label, tone: zoneTone(band.label), left: from, width: to - from, note: band.note });
  }
  return out;
}

/**
 * Index of the band that holds the rated value (for highlighting the current zone in the legend), or -1. Zones may share
 * a label (two "critical" salinity zones), so the value, not the label alone, picks the band.
 */
export function zoneIndexOf(reading: Pick<SoilReading, "bands" | "rating" | "ratedValue">): number {
  const same = reading.bands.map((b, i) => ({ b, i })).filter(({ b }) => b.label === reading.rating);
  if (same.length <= 1 || reading.ratedValue === null) return same[0]?.i ?? -1;
  const v = reading.ratedValue;
  const hit = same.find(({ b }) => (b.from === null || v >= b.from) && (b.to === null || v < b.to)) ?? same.find(({ b }) => b.from === null || v >= b.from);
  return (hit ?? same[0])!.i;
}

export const formatNumber = (n: number): string => String(Number(n.toFixed(3)));

/** The unit as shown beside a printed value ("-" and blanks are no unit; the conductivity spelling is normalised). */
export function unitLabel(unit: string | null | undefined): string {
  const u = (unit ?? "").trim();
  if (!u || u === "-" || u === "--") return "";
  return u === "ds/m" ? "dS/m" : u;
}

export function valueText(r: Pick<SoilReading, "value" | "unit">): string {
  if (r.value === null) return "Not a single number";
  const unit = unitLabel(r.unit);
  return unit ? `${formatNumber(r.value)} ${unit}` : formatNumber(r.value);
}

/** Shown under the value when the rating used another number or form (converted organic matter, elemental P). */
export function ratedAsText(r: Pick<SoilReading, "status" | "value" | "unit" | "ratedValue" | "ratedUnit">): string | null {
  if (r.status !== "rated" || r.ratedValue === null) return null;
  const unit = unitLabel(r.unit);
  const sameNumber = r.value !== null && Math.abs(r.value - r.ratedValue) < 1e-9;
  const sameUnit = !unit || !r.ratedUnit || unit === r.ratedUnit;
  if (sameNumber && sameUnit) return null;
  return `Rated as ${formatNumber(r.ratedValue)}${r.ratedUnit ? ` ${r.ratedUnit}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15 Sep 2026" from an ISO date, without time-zone arithmetic. */
export function sampleDateText(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

/** The text of one zone in the legend: the server's note (it states the limits and units) or the numeric range. */
export function bandRangeText(band: SoilRatingBand): string {
  if (band.note) return band.note;
  if (band.from === null && band.to !== null) return `Below ${formatNumber(band.to)}`;
  if (band.to === null && band.from !== null) return `${formatNumber(band.from)} and above`;
  if (band.from !== null && band.to !== null) return `${formatNumber(band.from)} to ${formatNumber(band.to)}`;
  return "";
}

const ORDER = [
  "ph", "electrical_conductivity", "organic_carbon", "organic_matter", "nitrogen_available", "nitrogen_unspecified", "nitrogen_total",
  "phosphorus_available", "phosphorus_total", "potassium_available", "potassium_total", "sulphur_available", "zinc_available", "boron_available",
  "iron_available", "manganese_available", "copper_available",
];
const rank = (parameter: string) => {
  const i = ORDER.indexOf(parameter);
  return i < 0 ? ORDER.length : i;
};

/** Rated readings (drawn as bars) and everything else (listed under "Other values"), each in a fixed parameter order. */
export function splitReadings(readings: readonly SoilReading[]): { rated: SoilReading[]; other: SoilReading[] } {
  const byOrder = (a: SoilReading, b: SoilReading) => rank(a.parameter) - rank(b.parameter);
  const rated = readings.filter((r) => r.status === "rated" && r.axis !== null && r.bands.length > 0).sort(byOrder);
  const other = readings.filter((r) => !rated.includes(r)).sort(byOrder);
  return { rated, other };
}

export function otherStatusText(status: SoilReading["status"]): string {
  return status === "qualifier" ? "Printed as a range or limit" : status === "unit_mismatch" ? "Unit not comparable" : "No cited rating";
}

export const needText = (need: "low" | "medium" | "high" | null): string => (need ? `${need.charAt(0).toUpperCase()}${need.slice(1)} need` : "Need not compared");

export const isActive = (r: Pick<SoilReview, "status">): boolean => r.status === "pending" || r.status === "running";

/** The AI mark belongs on model-made text only: a model narrative, or the text still being written. */
export const showAiMark = (r: Pick<SoilReview, "status" | "narrativeOrigin">): boolean => r.narrativeOrigin === "model" || isActive(r);

/** Alt text for a bar: the value, its rating and the zones, so the colours are never the only carrier of meaning. */
export function barDescription(r: SoilReading): string {
  const zones = r.bands.map((b) => `${ratingLabel(b.label).toLowerCase()} ${bandRangeText(b)}`.trim()).join("; ");
  const edge = beyondAxis(r.ratedValue, r.axis);
  return `${r.label} ${valueText(r)}, ${ratingLabel(r.rating).toLowerCase()}${edge ? ` (beyond the ${edge === "above" ? "top" : "bottom"} of the scale)` : ""}. Zones: ${zones}.`;
}
