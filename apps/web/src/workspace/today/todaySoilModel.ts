import type { SoilReading, SoilReview } from "@harvest/contracts";
import { bandSegments, isActive, ratingLabel, sampleDateText, zoneIndexOf, type ZoneTone } from "../farm/soilReviewModel";

/**
 * Pure model for the "Soil for this farm" card on Today (FIELDS_MULTICROP_SOIL_SPEC.md section 7). Nothing here rates
 * anything: ratings, bands and axes come from the server (code); this file only chooses which readings to show, names the
 * zones under a bar, writes the headline and provenance lines, and runs the load/poll/dismiss logic without a DOM so it
 * can be tested directly.
 */

export const MAX_SOIL_ROWS = 5;
/** Parameters shown first, in this order: pH, organic carbon, then available nitrogen, phosphorus and potassium. */
export const PRIORITY_PARAMETERS = ["ph", "organic_carbon", "nitrogen_available", "phosphorus_available", "potassium_available"] as const;

/** A reading the bar can draw: rated, with a drawing axis and at least one zone. */
export const isRatedReading = (r: SoilReading): boolean => r.status === "rated" && r.axis !== null && r.bands.length > 0;

/** Up to five rated readings: the priority parameters in order (first of each), then any other rated reading in stored order. */
export function pickReadings(readings: readonly SoilReading[], max = MAX_SOIL_ROWS): SoilReading[] {
  const rated = readings.filter(isRatedReading);
  const picked: SoilReading[] = [];
  for (const parameter of PRIORITY_PARAMETERS) {
    const hit = rated.find((r) => r.parameter === parameter);
    if (hit) picked.push(hit);
  }
  for (const r of rated) if (!picked.includes(r)) picked.push(r);
  return picked.slice(0, Math.max(0, max));
}

export interface ZoneLabel {
  label: string;
  tone: ZoneTone;
  /** Left edge and width as fractions of the axis (0..1), the same geometry as the bar's zones. */
  left: number;
  width: number;
  /** True for the zone that holds the rated value. */
  current: boolean;
}

/**
 * The zone names under a bar. Neighbouring zones with the same rating (two "Critical" salinity zones) merge into one
 * label so the name is not printed twice side by side.
 */
export function zoneLabels(reading: Pick<SoilReading, "bands" | "axis" | "rating" | "ratedValue">): ZoneLabel[] {
  const segments = bandSegments(reading.bands, reading.axis);
  const currentBand = zoneIndexOf(reading);
  const currentSegment = currentBand >= 0 ? reading.bands[currentBand] : undefined;
  const out: ZoneLabel[] = [];
  segments.forEach((segment) => {
    const isCurrent = segment.label === reading.rating && (currentSegment === undefined || segment.note === currentSegment.note);
    const last = out[out.length - 1];
    if (last && last.label === ratingLabel(segment.label)) {
      last.width = segment.left + segment.width - last.left;
      last.current = last.current || isCurrent;
      return;
    }
    out.push({ label: ratingLabel(segment.label), tone: segment.tone, left: segment.left, width: segment.width, current: isCurrent });
  });
  return out;
}

export const PENDING_HEADLINE = "Rating your soil values…";
export const CODE_NOTE = "Written by code from the confirmed values.";

export interface Headline {
  /** The line to show: the first narrative line, or the pending text; null when there is nothing to say. */
  text: string | null;
  pending: boolean;
  /** Set when the narrative was written by code rather than the model. */
  note: string | null;
}

export function headlineOf(review: Pick<SoilReview, "status" | "narrative" | "narrativeOrigin">): Headline {
  if (isActive(review)) return { text: PENDING_HEADLINE, pending: true, note: null };
  const line = review.narrative?.lines.find((l) => l.trim().length > 0) ?? null;
  return { text: line, pending: false, note: line && review.narrativeOrigin === "deterministic" ? CODE_NOTE : null };
}

/**
 * "Collected 15 Sep 2026 · <method>", using only what the reading carries. A null date or method is left out, not guessed;
 * a missing date is said plainly. The review is accepted so a later field (laboratory) can be added without changing callers.
 */
export function provenanceOf(reading: Pick<SoilReading, "collectionDate" | "method">, _review?: unknown): string {
  const date = sampleDateText(reading.collectionDate);
  const method = reading.method?.trim() || null;
  return [date ? `Collected ${date}` : "Collection date not printed on the report", method].filter(Boolean).join(" · ");
}

/** The one provenance line when every shown row shares it; null when rows differ (each row then prints its own). */
export function sharedProvenance(rows: readonly SoilReading[], review?: unknown): string | null {
  if (rows.length === 0) return null;
  const first = provenanceOf(rows[0]!, review);
  return rows.every((r) => provenanceOf(r, review) === first) ? first : null;
}

export type SoilCardState =
  | { kind: "loading" }
  | { kind: "review"; review: SoilReview; polling: boolean }
  | { kind: "failed"; reason: "load" | "review" };

/** `fieldId` is the selected field (`?fieldId=`), null for the whole farm ("All fields" or a farm without fields). */
export interface SoilCardApi {
  load: (farmId: string, opts: { signal: AbortSignal; fieldId?: string | null }) => Promise<SoilReview>;
  refresh: (farmId: string, opts: { signal: AbortSignal; fieldId?: string | null; onUpdate?: (review: SoilReview) => void }) => Promise<SoilReview>;
  poll: (farmId: string, initial: SoilReview, opts: { signal: AbortSignal; fieldId?: string | null; onUpdate?: (review: SoilReview) => void }) => Promise<SoilReview>;
}

export const summaryFailed = (r: Pick<SoilReview, "status">) => r.status === "error" || r.status === "unavailable";
/** A failed review with nothing rated to draw is a plain failure; with rated readings the card still shows them. */
const failedReview = (r: SoilReview) => summaryFailed(r) && pickReadings(r.readings).length === 0;

/**
 * Load the farm's soil review and follow it while it is pending or running. Every emit is guarded by the signal, so a
 * response that arrives after the farm changed or the card unmounted is dropped. `force` is Retry after a review that
 * ended in error (POST, then poll); otherwise it is a plain GET. `fieldId` goes to every request so the card shares the
 * review the Farm tab shows for that field (one Meta narrative job per field); null keeps the farm-wide review.
 */
export async function runSoilCard(
  farmId: string,
  api: SoilCardApi,
  emit: (state: SoilCardState) => void,
  signal: AbortSignal,
  force = false,
  fieldId: string | null = null,
): Promise<void> {
  const show = (review: SoilReview, polling: boolean) => {
    if (signal.aborted) return;
    emit(failedReview(review) ? { kind: "failed", reason: "review" } : { kind: "review", review, polling });
  };
  try {
    const first = force ? await api.refresh(farmId, { signal, fieldId, onUpdate: (r) => show(r, isActive(r)) }) : await api.load(farmId, { signal, fieldId });
    if (signal.aborted) return;
    show(first, isActive(first));
    if (!isActive(first)) return;
    const last = await api.poll(farmId, first, { signal, fieldId, onUpdate: (r) => show(r, isActive(r)) });
    if (signal.aborted) return;
    show(last, false);
  } catch {
    if (!signal.aborted) emit({ kind: "failed", reason: "load" });
  }
}

export const DISMISS_KEY_PREFIX = "harvest.today.soilPrompt.dismissed.";
export const dismissKey = (farmId: string) => `${DISMISS_KEY_PREFIX}${farmId}`;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
/** The session storage, or null where it is blocked or missing (private mode, SSR). */
export function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Whether "Not now" was pressed for this farm in this browser session. Every access is guarded. */
export function readDismissed(farmId: string, store: StorageLike | null = sessionStore()): boolean {
  try {
    return store?.getItem(dismissKey(farmId)) === "1";
  } catch {
    return false;
  }
}

export function writeDismissed(farmId: string, store: StorageLike | null = sessionStore()): void {
  try {
    store?.setItem(dismissKey(farmId), "1");
  } catch {
    /* storage blocked: the card is hidden for this view only */
  }
}
