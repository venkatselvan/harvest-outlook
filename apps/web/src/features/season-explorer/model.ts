import { computeStageBlend, dapBetween, type StageBlend, type StageWindow } from "../season-scene";
import type { PlanOutputs, PlanTaskOutput, Scenario, TimelineDay, TimelineView, WaterDaily, WaterRunOut } from "../../lib/plan-api";

/*
 * Pure view model for the season explorer. Everything here is selection and formatting over fields the API already
 * computed; there is no agronomy, forecasting or arithmetic on agronomic quantities on the client. Moving the slider
 * calls `recordAt`, which is a Map lookup on a timeline that was fetched once.
 */

export const MS_DAY = 86_400_000;

/** `YYYY-MM-DD` plus `n` days (UTC calendar arithmetic, no time zone drift). */
export function addDaysIso(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}
export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDaysIso(s, 0) === s;

/** The calendar date in Asia/Kolkata for an instant (the "today" marker). */
export function todayInKolkata(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA is YYYY-MM-DD
}

export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: false })} IST`;
}
export const fmtNum = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toLocaleString("en-IN", { maximumFractionDigits: digits }));
/** Decimal strings from the API (rupees) shown with grouping; the value itself is untouched. */
export const fmtInr = (s: string | null | undefined): string => {
  if (s === null || s === undefined) return "n/a";
  const n = Number(s);
  return Number.isFinite(n) ? `Rs ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : s;
};

// ------------------------------------------------------------------ timeline index

export interface TimelineIndex {
  planId: string;
  scenarioId: Scenario;
  planContentHash: string;
  asOfDate: string;
  from: string;
  to: string;
  days: readonly TimelineDay[];
  byDate: ReadonlyMap<string, number>;
  plantingDate: string;
  stageWindows: readonly StageWindow[];
  /** Stage ids in the order they first appear in the timeline. */
  stageOrder: readonly string[];
}

/**
 * Stage windows in days after planting derived from the timeline's own expectedStage per day (so they match the selected
 * scenario): a stage starts on the first day it is the expected stage and ends where the next one starts.
 */
export function stageWindowsFromDays(days: readonly TimelineDay[]): StageWindow[] {
  const out: StageWindow[] = [];
  for (const d of days) {
    const id = d.expectedStage?.stageId;
    if (!id) continue;
    const last = out[out.length - 1];
    if (last && last.stageId === id) continue;
    if (last) last.endDap = d.daysAfterPlanting;
    out.push({ stageId: id, startDap: d.daysAfterPlanting, endDap: d.daysAfterPlanting + 1 });
  }
  const lastDay = days[days.length - 1];
  const last = out[out.length - 1];
  if (last && lastDay) last.endDap = Math.max(last.endDap, lastDay.daysAfterPlanting + 1);
  return out;
}

export function indexTimeline(t: TimelineView, plantingDate: string): TimelineIndex {
  const byDate = new Map<string, number>();
  t.days.forEach((d, i) => byDate.set(d.calendarDate, i));
  const windows = stageWindowsFromDays(t.days);
  return {
    planId: t.planId,
    scenarioId: t.scenarioId,
    planContentHash: t.planContentHash,
    asOfDate: t.asOfDate,
    from: t.range.from,
    to: t.range.to,
    days: t.days,
    byDate,
    plantingDate,
    stageWindows: windows,
    stageOrder: windows.map((w) => w.stageId),
  };
}

/** O(1) lookup of the prepared record for a date. */
export function recordAt(ix: TimelineIndex, date: string): TimelineDay | null {
  const i = ix.byDate.get(date);
  return i === undefined ? null : (ix.days[i] ?? null);
}

export function clampDate(ix: TimelineIndex, date: string): string {
  return date < ix.from ? ix.from : date > ix.to ? ix.to : date;
}

export const dateToDap = (plantingDate: string, date: string): number => dapBetween(plantingDate, date);
export const dapToDate = (plantingDate: string, dap: number): string => addDaysIso(plantingDate, dap);

/** Slider position (0-based index into the timeline) for a date, and back. */
export function dateToPos(ix: TimelineIndex, date: string): number {
  return ix.byDate.get(clampDate(ix, date)) ?? 0;
}
export function posToDate(ix: TimelineIndex, pos: number): string {
  const i = Math.min(ix.days.length - 1, Math.max(0, Math.round(pos)));
  return ix.days[i]?.calendarDate ?? ix.from;
}
/** Percent position of a date marker along the track (null when outside the range). */
export function markerPercent(ix: TimelineIndex, date: string): number | null {
  if (!ix.byDate.has(date) || ix.days.length < 2) return null;
  return (dateToPos(ix, date) / (ix.days.length - 1)) * 100;
}

// ------------------------------------------------------------------ weather horizon

export type WeatherKind = "observed" | "gap" | "forecast" | "scenario" | "unavailable";
export interface WeatherView {
  kind: WeatherKind;
  badge: "observed" | "forecast" | "scenario" | "unavailable";
  title: string;
  lines: string[];
}

const REASONS: Record<string, string> = {
  no_observation: "No weather observation is stored for this date.",
  forecast_day_missing: "The forecast does not cover this day.",
  outside_weather_range: "Outside the weather range the plan fetched.",
  no_climatology: "No seasonal climatology is available.",
};
const reasonText = (r: string | null): string => (r ? (REASONS[r] ?? r.replace(/_/g, " ")) : "No data.");

/**
 * Qualifier shown beside value badges at panel level. Only live mode has real observations: in synthetic mode a row
 * badged "Observed" is a fixture, and in replay it is a recorded response. Null means no qualifier is needed.
 */
export function modeQualifier(mode: "live" | "replay" | "synthetic" | null): string | null {
  if (mode === "live") return null;
  if (mode === "replay") return "Replay";
  if (mode === "synthetic") return "Synthetic fixture (observed-shaped)";
  return "Data mode not confirmed";
}

export const SCENARIO_WEATHER_TEXT = "Seasonal climatology scenario. No daily rain prediction exists this far ahead.";

export function weatherView(day: TimelineDay): WeatherView {
  const w = day.weather;
  const v = w.values;
  const daily = (): string[] => [
    `Rain ${fmtNum(v?.rainMm)} mm`,
    `Reference evapotranspiration ${fmtNum(v?.et0Mm)} mm`,
    `Temperature ${fmtNum(v?.tMinC)} to ${fmtNum(v?.tMaxC)} C`,
  ];
  switch (w.state) {
    case "observed":
      return { kind: "observed", badge: "observed", title: "Observed", lines: [...daily(), ...(w.sourceId ? [`Source: ${w.sourceId}`] : [])] };
    case "forecast":
      return {
        kind: "forecast",
        badge: "forecast",
        title: "Forecast",
        lines: [
          w.issuedAt ? `Issued ${formatInstant(w.issuedAt)}` : "Issue time not recorded",
          w.horizonDays !== null ? `Horizon: ${w.horizonDays} days from issue` : "Horizon not recorded",
          ...daily(),
          "A forecast is not the rain that fell on this farm.",
        ],
      };
    case "scenario":
      // Deliberately no daily values: climatology is not a prediction for this date.
      return { kind: "scenario", badge: "scenario", title: "Seasonal scenario", lines: [SCENARIO_WEATHER_TEXT, ...(w.assumptionId ? [`Assumption: ${w.assumptionId}`] : [])] };
    default:
      if (w.missingReason === "no_observation") {
        return { kind: "gap", badge: "unavailable", title: "No record", lines: ["No weather observation is stored for this date. It is shown as a gap, not filled in."] };
      }
      return { kind: "unavailable", badge: "unavailable", title: "Unavailable", lines: [reasonText(w.missingReason)] };
  }
}

// ------------------------------------------------------------------ price / outlook

export interface OutlookView {
  badge: "forecast" | "farmer_reported" | "unavailable";
  title: string;
  lines: string[];
}

export const PRICE_PENDING_TEXT = "Unavailable — price access pending";

export function outlookView(day: TimelineDay, o: PlanOutputs["market_outlook"] | undefined, assumedPrice: string | null): OutlookView {
  const ol = day.outlook;
  if (ol.state === "forecast" && o) {
    const p = o.periods.find((x) => x.periodId === ol.harvestPeriodId)?.price;
    if (p) {
      return {
        badge: "forecast",
        title: "Forecast price range",
        lines: [
          `Harvest period price per kg: low ${fmtNum(p.low)}, central ${fmtNum(p.central)}, high ${fmtNum(p.high)} Rs (quantile levels ${p.levels.join(", ")})`,
          ol.issuedAt ? `Forecast issued ${formatInstant(ol.issuedAt)}` : `Outlook issue date ${o.issueDate}`,
          "A range from a model, not a guaranteed farm-gate price.",
        ],
      };
    }
  }
  if (ol.state === "farmer_reported") {
    return { badge: "farmer_reported", title: "Your assumed price", lines: [assumedPrice ?? "Price you entered", "Farmer reported, not a market observation."] };
  }
  const pending = o?.state === "unavailable" && (o.missingReason === "price_access_key_gated" || o.missingReason === null);
  const lines = [pending ? PRICE_PENDING_TEXT : o?.missingReason ? `Unavailable — ${o.missingReason.replace(/_/g, " ")}` : `Unavailable — ${(ol.missingReason ?? "no outlook").replace(/_/g, " ")}`];
  if (ol.missingReason === "outside_harvest_window") lines.push("No harvest window on this date; the price outlook applies to harvest periods only.");
  return { badge: "unavailable", title: "Price outlook", lines };
}

// ------------------------------------------------------------------ tasks

export interface TaskRow {
  id: string;
  description: string;
  window: string | null;
  reason: string;
  evidenceIds: string[];
  state: "due" | "overdue" | "done";
  flag: string | null;
  trigger: string | null;
}

export const humanizeReason = (code: string): string => code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function taskRows(day: TimelineDay, tasksById: ReadonlyMap<string, PlanTaskOutput>): TaskRow[] {
  const flags = new Map(day.tasks.conditionFlags.map((f) => [f.taskId, f]));
  const row = (id: string, state: TaskRow["state"]): TaskRow | null => {
    const t = tasksById.get(id);
    if (!t) return null;
    const w = t.task.timing.kind === "window" ? t.task.timing.window : null;
    const f = flags.get(id);
    return {
      id,
      description: t.description,
      window: w ? (w.start === w.end ? formatDate(w.start) : `${formatDate(w.start)} to ${formatDate(w.end)}`) : null,
      reason: humanizeReason(t.task.reasonCode),
      evidenceIds: t.task.evidenceIds,
      state,
      flag: f ? `Heavy-rain check: ${f.weatherState} rain ${fmtNum(f.rainMm)} mm is at or above the ${fmtNum(f.thresholdMm)} mm threshold (a planning assumption, not a source value).` : null,
      trigger: t.trigger ? `Prompted when daily rain reaches ${fmtNum(t.trigger.thresholdMm)} mm (${t.trigger.thresholdBasis === "sourced" ? "sourced threshold" : "named assumption"}).` : null,
    };
  };
  return [
    ...day.tasks.overdue.map((id) => row(id, "overdue")),
    ...day.tasks.due.map((id) => row(id, "due")),
    ...day.tasks.done.map((id) => row(id, "done")),
  ].filter((r): r is TaskRow => r !== null);
}

// ------------------------------------------------------------------ scene

export type SceneChoice =
  | { kind: "photo"; assetId: string; date: string; label: string }
  | { kind: "illustration"; progress: StageBlend }
  | { kind: "absent"; message: string };

/** An actual journal photo for the selected date always wins over the illustration; a past date without one stays empty. */
export function sceneChoice(ix: TimelineIndex, day: TimelineDay): SceneChoice {
  if (day.visual.state === "observed_photo" && day.visual.assetId) {
    return { kind: "photo", assetId: day.visual.assetId, date: day.calendarDate, label: `Your photo · ${formatDate(day.calendarDate)}` };
  }
  if (day.visual.state === "none") {
    return {
      kind: "absent",
      message: day.markers.past
        ? "No photo recorded for this date. No picture is drawn; any stage shown in the panels is inferred from the calendar."
        : "No stage is expected on this date, so no illustration is drawn.",
    };
  }
  return { kind: "illustration", progress: computeStageBlend(day.daysAfterPlanting, ix.stageWindows) };
}

// ------------------------------------------------------------------ water

export interface WaterRow {
  label: string;
  evidenceState: string;
  day: WaterDaily | null;
  stressDays: number;
}
export type WaterIndex = ReadonlyMap<string, ReadonlyMap<string, WaterDaily>>;

export function indexWater(runs: readonly WaterRunOut[] | undefined): WaterIndex {
  return new Map((runs ?? []).map((r) => [r.label, new Map(r.daily.map((d) => [d.date, d]))]));
}
export function waterRows(runs: readonly WaterRunOut[] | undefined, idx: WaterIndex, date: string): WaterRow[] {
  return (runs ?? []).map((r) => ({ label: r.label, evidenceState: r.evidenceState, day: idx.get(r.label)?.get(date) ?? null, stressDays: r.stressDays }));
}

// ------------------------------------------------------------------ evidence badges

export const BADGE_TEXT: Record<string, string> = {
  observed: "Observed",
  farmer_reported: "Farmer reported",
  derived: "Derived",
  forecast: "Forecast",
  scenario: "Scenario",
  illustrative: "Illustrative",
  unavailable: "Unavailable",
  inferred: "Inferred",
};
