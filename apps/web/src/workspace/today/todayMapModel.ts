import type { FarmAlert, FieldConditionPoint, FieldSummary, HealthReading, UpcomingStep, WeatherPoint } from "@harvest/contracts";
import { addDays, formatDay, formatRain, formatSoilMoisture, formatTemp, nextActionWhen, type SliderModel, type StageAt } from "./model";

/**
 * Code rules behind the Today full-map layout (docs/research/TODAY_MAP_LAYOUT_SPEC.md). Every value here is read from
 * data the Today view already has (alerts, steps, the weather track, the day's condition point, the satellite reading,
 * the slider model and the field summaries); nothing is estimated here and no model is called. No DOM, no Solid.
 */

// ---------------------------------------------------------------- headline

/** "Your farm today." or, with a field selected, "Strip 2 today.". */
export function headlineTitle(fieldName: string | null | undefined): string {
  return fieldName ? `${fieldName} today.` : "Your farm today.";
}

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
/** The one sentence under the headline, from the attention count (open alerts plus due or overdue steps). */
export function headlineSentence(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "Nothing needs attention today.";
  if (count === 1) return "One thing deserves a closer look.";
  return `${COUNT_WORDS[count] ?? String(Math.round(count))} things deserve a closer look.`;
}

/** "Wednesday · 4 November" for the server's today, in UTC so the calendar day never shifts. */
export function headlineEyebrow(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return "";
  const weekday = day.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const rest = day.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${weekday} · ${rest}`;
}

// ---------------------------------------------------------------- needs your attention

export interface AttentionItem {
  kind: "alert" | "step";
  id: string;
  title: string;
  /** One evidence line: the alert's first sentence, or the step's window (and a field check's reason). */
  evidence: string;
  /** Label of the action link. */
  action: string;
  /** What the link jumps to: an alert card or a step in the lists below. */
  target: { kind: "alert" | "step"; id: string };
  severity: FarmAlert["severity"] | "due" | "overdue";
}

const SEVERITY_RANK: Record<FarmAlert["severity"], number> = { warning: 0, watch: 1, info: 2 };
const firstSentence = (text: string) => {
  const match = text.match(/^.+?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
};
const isOpenStep = (step: UpcomingStep) => step.status === "due" || step.status === "overdue";

/**
 * What needs the farmer's attention: every open alert (warning first) and every due or overdue step that is not the
 * suggested step of a listed alert (that pair counts once, as the alert). `total` is the count the headline sentence uses;
 * `items` are the first `limit` for the panel.
 */
export function attentionItems(alerts: readonly FarmAlert[], steps: readonly UpcomingStep[], today: string, limit = 3): { items: AttentionItem[]; total: number } {
  const sorted = [...alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const alertIds = new Set(sorted.map((alert) => alert.id));
  const openSteps = steps.filter(isOpenStep);
  const linked = new Map(openSteps.filter((step) => step.alertId && alertIds.has(step.alertId)).map((step) => [step.alertId!, step]));
  const all: AttentionItem[] = sorted.map((alert) => {
    const step = linked.get(alert.id);
    return {
      kind: "alert",
      id: alert.id,
      title: alert.title,
      evidence: firstSentence(alert.detail),
      action: step ? "Review suggested step" : "Review alert",
      target: step ? { kind: "step", id: step.id } : { kind: "alert", id: alert.id },
      severity: alert.severity,
    };
  });
  const rest = openSteps
    .filter((step) => !(step.alertId && alertIds.has(step.alertId)))
    .sort((a, b) => (a.status === b.status ? a.dueTo.localeCompare(b.dueTo) : a.status === "overdue" ? -1 : 1));
  for (const step of rest) {
    const reason = step.kind === "field_check" ? step.fieldCheck?.reason : null;
    all.push({
      kind: "step",
      id: step.id,
      title: step.title,
      evidence: reason ? `${nextActionWhen(step, today)} · ${reason}` : nextActionWhen(step, today),
      action: step.kind === "field_check" ? "Open field check" : "Review step",
      target: { kind: "step", id: step.id },
      severity: step.status as "due" | "overdue",
    });
  }
  return { items: all.slice(0, limit), total: all.length };
}

// ---------------------------------------------------------------- the week ahead

export interface WeekDay {
  date: string;
  /** "Today", then "Thu". */
  label: string;
  kind: WeatherPoint["kind"];
  high: string;
  low: string;
  /** Rain chance when the point carries one ("40%"), else the rain amount ("2 mm"), else "–". */
  rain: string;
  rainSpoken: string;
  /** 1 mm or more of rain recorded or forecast (the weather card's rain icon rule); null without a rain figure. */
  wet: boolean | null;
}

/** Five days from the server's today, from the weather track the view already loaded; a day without a row is "unavailable". */
export function weekAhead(track: readonly WeatherPoint[], today: string, days = 5): WeekDay[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i);
    const point = track.find((p) => p.date === date) ?? null;
    const usable = point && point.kind !== "unavailable" ? point : null;
    const chance = usable?.agro?.rainProbabilityPct;
    const label = i === 0 ? "Today" : new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
    const rain =
      chance != null ? `${Math.round(chance)}%` : usable?.rainMm != null ? formatRain(usable.rainMm).replace(" rain", "") : "–";
    const rainSpoken =
      chance != null ? `${Math.round(chance)} percent chance of rain` : usable?.rainMm != null ? formatRain(usable.rainMm) : "no rain figure";
    const wet = usable?.rainMm != null ? usable.rainMm >= 1 : null;
    return { date, label, kind: point?.kind ?? "unavailable", high: formatTemp(usable?.tMaxC), low: formatTemp(usable?.tMinC), rain, rainSpoken, wet };
  });
}

/**
 * The week's one takeaway, from the existing alert rules: the most severe weather alert whose validity overlaps the
 * five days (rain, heat or gusts), as its own title. Null when no weather alert covers them.
 */
export function weekTakeaway(alerts: readonly FarmAlert[], today: string, days = 5): string | null {
  const end = addDays(today, days - 1);
  const alert = [...alerts]
    .filter((a) => a.type === "weather" && a.validFrom <= end && a.validTo >= today)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
  if (!alert) return null;
  return /[.!?]$/.test(alert.title) ? alert.title : `${alert.title}.`;
}

// ---------------------------------------------------------------- gauges

/** observed: a satellite image; modelled: a grid-cell model value; estimated: a rule or a calendar estimate. */
export type GaugeBasis = "observed" | "modelled" | "estimated";
export const GAUGE_BASIS_LABEL: Record<GaugeBasis, string> = { observed: "Observed", modelled: "Modelled", estimated: "Estimated" };

export interface Gauge {
  id: "greenness" | "water" | "stage";
  label: string;
  /** Short visible value ("0.62", "Moist", "Day 47 of 120"). */
  value: string;
  /** Line under the value (image date, model value, stage name). */
  caption: string;
  /** Ring fill 0..1 for numeric gauges; null for the water state (an ordered state, not a number). */
  fraction: number | null;
  /** Water only: the step of dry, moist, ponded, flooded (0..3), or null when unknown. */
  level: number | null;
  basis: GaugeBasis | null;
  /** Plain words for the chip's title and the screen reader. */
  basisNote: string;
  /** The existing sheet the gauge opens. */
  sheet: "health" | "weather" | "harvest";
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Greenness: the satellite NDVI reading the crop-condition card shows, with its image date. */
export function greennessGauge(health: HealthReading | null | undefined): Gauge {
  if (!health)
    return { id: "greenness", label: "Greenness", value: "–", caption: "No clear satellite reading yet", fraction: null, level: null, basis: null, basisNote: "No satellite reading", sheet: "health" };
  return {
    id: "greenness",
    label: "Greenness",
    value: health.ndviMean.toFixed(2).replace(/^-/, "−"),
    caption: `NDVI · image of ${formatDay(health.date, false)}`,
    fraction: clamp01(health.ndviMean),
    level: null,
    basis: "observed",
    basisNote: `Observed in the satellite image of ${formatDay(health.date, false)}; a satellite signal, not a field inspection`,
    sheet: "health",
  };
}

export const WATER_LEVELS = ["dry", "moist", "ponded", "flooded"] as const;
const WATER_WORDS: Record<FieldConditionPoint["water"]["state"], string> = { dry: "Dry", moist: "Moist", ponded: "Ponded", flooded: "Flooded", unknown: "Unknown" };

/** Water: the day's water-balance state from the condition series, with its basis (model soil moisture, rain rule or crop practice). */
export function waterGauge(point: FieldConditionPoint | null | undefined): Gauge {
  const base = { id: "water" as const, label: "Water", fraction: null, sheet: "weather" as const };
  if (!point || point.water.state === "unknown" || point.water.basis === "none")
    return { ...base, value: point ? WATER_WORDS[point.water.state] : "–", caption: "No water reading for this day", level: null, basis: null, basisNote: "No water-balance state for this day" };
  const { state, basis, soilMoisture0to7 } = point.water;
  const level = WATER_LEVELS.indexOf(state as (typeof WATER_LEVELS)[number]);
  const forecast = point.kind === "forecast" ? " (forecast)" : point.kind === "typical" ? " (typical weather)" : "";
  if (basis === "model_soil_moisture")
    return {
      ...base,
      value: WATER_WORDS[state],
      caption: `Model soil moisture${soilMoisture0to7 != null ? ` ${formatSoilMoisture(soilMoisture0to7)}` : ""}${forecast}`,
      level: level >= 0 ? level : null,
      basis: "modelled",
      basisNote: "Modelled: Open-Meteo model estimate for the grid cell, not a field reading",
    };
  return {
    ...base,
    value: WATER_WORDS[state],
    caption: basis === "crop_practice" ? "Standing water kept by crop practice" : `From recent rain${forecast}`,
    level: level >= 0 ? level : null,
    basis: "estimated",
    basisNote: basis === "crop_practice" ? "Estimated from the crop practice for this stage" : "Estimated by a rain rule from the weather record",
  };
}

/** Stage progress: day N of M on the season slider (calendar days from sowing to the latest harvest date), with the stage name. */
export function stageGauge(model: SliderModel | null | undefined, index: number, stage: StageAt): Gauge {
  const base = { id: "stage" as const, label: "Stage progress", level: null, sheet: "harvest" as const };
  if (!model || model.total <= 0)
    return { ...base, value: "–", caption: "No stage dates for this crop yet", fraction: null, basis: null, basisNote: "No stage dates" };
  const day = Math.max(0, Math.min(model.total, Math.round(index)));
  const name =
    stage.kind === "stage" ? stage.stage.name : stage.kind === "harvest" ? "Harvest window" : stage.kind === "before" ? "Before the first stage" : stage.kind === "after" ? "Past the harvest window" : "Stage not known";
  return {
    ...base,
    value: `Day ${day} of ${model.total}`,
    caption: name,
    fraction: day / model.total,
    basis: "estimated",
    basisNote: "Estimated: calendar stage dates from the recorded sowing date, never marked reached by a satellite image",
  };
}

// ---------------------------------------------------------------- at a glance

export interface GlanceFacts {
  /** Hectares under a current crop: the drawn fields with a crop, or the drawn farm for a whole-farm crop; null when unknown. */
  areaHa: number | null;
  /** Fields with a current crop and all fields; null on a farm without fields. */
  fields: { active: number; total: number } | null;
  /** Today's season day for the described crop (days since sowing on the slider) and the season's length; null without one. */
  seasonDay: { day: number; total: number } | null;
}

export function glanceFacts(input: { fields: readonly FieldSummary[]; farmAreaHa: number | null; hasCycle: boolean; model: SliderModel | null }): GlanceFacts {
  const fields = input.fields;
  const areaHa = fields.length
    ? fields.filter((f) => f.cycle).reduce((sum, f) => sum + f.areaHa, 0)
    : input.hasCycle && input.farmAreaHa != null && input.farmAreaHa > 0
      ? input.farmAreaHa
      : input.hasCycle
        ? null
        : 0;
  return {
    areaHa,
    fields: fields.length ? { active: fields.filter((f) => f.cycle).length, total: fields.length } : null,
    seasonDay: input.hasCycle && input.model && input.model.total > 0 ? { day: input.model.todayIndex, total: input.model.total } : null,
  };
}

/** "8.4", "0.36", "12": two decimals under 10 ha, one under 100, whole hectares above. */
export function formatHa(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: value < 10 ? 2 : value < 100 ? 1 : 0 });
}

// ---------------------------------------------------------------- actions: this week

export interface WeekPlanRow {
  date: string;
  /** "Today", "Thu 6 Nov". */
  label: string;
  steps: UpcomingStep[];
}

/**
 * The Actions tab's "This week": open steps placed on the first day of their window that falls within today and the
 * next six days (an overdue or already open step sits on today). Days without a step are left out.
 */
export function weekPlan(steps: readonly UpcomingStep[], today: string, days = 7): WeekPlanRow[] {
  const end = addDays(today, days - 1);
  const rows = new Map<string, UpcomingStep[]>();
  for (const step of steps) {
    if (step.status === "completed") continue;
    if (step.dueFrom > end) continue;
    if (step.status !== "overdue" && step.dueTo < today) continue;
    const date = step.dueFrom < today ? today : step.dueFrom;
    rows.set(date, [...(rows.get(date) ?? []), step]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      label: date === today ? "Today" : `${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${formatDay(date, false)}`,
      steps: list,
    }));
}
