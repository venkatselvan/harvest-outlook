import { addDays } from "@harvest/domain";
import { mergedStageSpans, stageSpans, type EconomicsOutput, type OutlookOutput, type PlanTask, type StageOutput, type WaterOutput } from "./compute";
import type { TaskCompletion, VisualAssetRef } from "./sources";
import type { StageTiming } from "./types";
import { daysBetween, eachDate, type ComposedWeather, type WeatherDayState } from "./weather";

/**
 * Date-indexed plan timeline (PRD 8.1). Computed once per (plan, scenario,
 * dataVersion) and cached; the client slider reads this array locally and never
 * triggers a request, an LLM call or image generation per movement.
 */
export interface TimelineDay {
  calendarDate: string;
  daysAfterPlanting: number;
  markers: { planting: boolean; asOf: boolean; past: boolean };
  expectedStage: {
    stageId: string;
    occurrence: number;
    /** Envelope window of this stage occurrence (earliest start .. latest end). */
    window: { start: string; end: string };
    inferred: true;
    basis: "calendar_estimate" | "observed_stage_override";
    /** Every stage whose uncertainty envelope contains this date. */
    possibleStageIds: string[];
  } | null;
  tasks: {
    due: string[];
    overdue: string[];
    done: string[];
    conditionFlags: { taskId: string; rainMm: number; weatherState: "observed" | "forecast"; thresholdMm: number; thresholdAssumptionId: string }[];
  };
  weather: {
    state: WeatherDayState;
    values: { rainMm: number | null; et0Mm: number | null; tMaxC: number | null; tMinC: number | null } | null;
    issuedAt: string | null;
    horizonDays: number | null;
    assumptionId: string | null;
    sourceId: string | null;
    missingReason: string | null;
  };
  water: { state: "derived" | "scenario" | "unavailable"; outputId: string | null; missingReason: string | null };
  outlook: { state: "forecast" | "farmer_reported" | "unavailable"; harvestPeriodId: string | null; artifactId: string | null; issuedAt: string | null; missingReason: string | null };
  visual: { assetId: string | null; state: "observed_photo" | "illustrative" | "schematic" | "none" };
  evidenceRefs: string[];
}

export interface TimelineInputs {
  planId: string;
  planContentHash: string;
  scenarioId: StageTiming;
  asOfDate: string;
  range: { from: string; to: string };
  stages: StageOutput;
  tasks: PlanTask[];
  water: WaterOutput | null;
  waterOutputId: string | null;
  outlook: OutlookOutput | null;
  economics: EconomicsOutput | null;
  harvestPeriods: { periodId: string; period: { start: string; end: string } }[];
  weather: ComposedWeather;
  visuals: VisualAssetRef[];
  completions: TaskCompletion[];
}

/** Full season range covered by a timeline: planting/task starts through the latest stage or task end. */
export function seasonRange(stages: StageOutput, tasks: PlanTask[]): { from: string; to: string } {
  const starts = [stages.plantingDate];
  const ends = stages.windows.map((w) => w.latestEnd);
  for (const t of tasks) if (t.task.timing.kind === "window") { starts.push(t.task.timing.window.start); ends.push(t.task.timing.window.end); }
  return { from: starts.sort()[0]!, to: ends.sort().at(-1)! };
}

export function buildTimeline(inp: TimelineInputs): TimelineDay[] {
  const spans = stageSpans(inp.stages.windows, inp.scenarioId);
  const merged = mergedStageSpans(inp.stages.windows, inp.scenarioId);
  const overridden = new Set(inp.stages.overrides.flatMap((o) => o.affectedStageIds));
  const stageEvidence = new Map(inp.stages.stages.map((s) => [s.stageId, s.evidenceIds]));
  const weatherByDate = new Map(inp.weather.days.map((d) => [d.date, d]));
  const completion = new Map(inp.completions.map((c) => [c.taskId, c.completedOn]));
  const photos = new Map(inp.visuals.filter((v) => v.kind === "observed_photo" && v.date).map((v) => [v.date!, v.assetId]));
  const illustrations = new Map(inp.visuals.filter((v) => v.kind === "illustrative" && v.stageId).map((v) => [v.stageId!, v.assetId]));
  const waterResult = inp.water?.byTiming[inp.scenarioId] ?? null;
  const waterDays = new Set((waterResult?.runs[0]?.daily ?? []).map((d) => d.date));

  return eachDate(inp.range.from, inp.range.to).map((date): TimelineDay => {
    const refs = new Set<string>();
    // Stage (inferred)
    let span = [...spans].reverse().find((s) => s.start <= date && date <= s.end) ?? null;
    if (!span) {
      // Between repeated pickings: still the picking stage; report the latest occurrence already started.
      const m = [...merged].reverse().find((s) => s.start <= date && date <= s.end);
      if (m) span = [...spans].reverse().find((s) => s.stageId === m.stageId && s.start <= date) ?? null;
    }
    let expectedStage: TimelineDay["expectedStage"] = null;
    if (span) {
      const w = inp.stages.windows.find((x) => x.stageId === span.stageId && x.occurrence === span.occurrence)!;
      expectedStage = {
        stageId: span.stageId,
        occurrence: span.occurrence,
        window: { start: w.earliest, end: addDays(w.latest, -1) < w.earliest ? w.earliest : addDays(w.latest, -1) },
        inferred: true,
        basis: overridden.has(span.stageId) ? "observed_stage_override" : "calendar_estimate",
        possibleStageIds: [...new Set(inp.stages.windows.filter((x) => x.earliest <= date && date < x.latest).map((x) => x.stageId))],
      };
      for (const e of stageEvidence.get(span.stageId) ?? []) refs.add(e);
    }
    // Weather
    const wd = weatherByDate.get(date);
    const weather: TimelineDay["weather"] = wd
      ? {
          state: wd.state,
          values: wd.state === "unavailable" ? null : { rainMm: wd.rainMm, et0Mm: wd.et0Mm, tMaxC: wd.tMaxC, tMinC: wd.tMinC },
          issuedAt: wd.issuedAt,
          horizonDays: wd.horizonDays,
          assumptionId: wd.assumptionId,
          sourceId: wd.sourceId,
          missingReason: wd.missingReason,
        }
      : { state: "unavailable", values: null, issuedAt: null, horizonDays: null, assumptionId: null, sourceId: null, missingReason: "outside_weather_range" };
    if (wd?.sourceId) refs.add(wd.sourceId);
    // Tasks
    const due: string[] = [];
    const overdue: string[] = [];
    const done: string[] = [];
    const conditionFlags: TimelineDay["tasks"]["conditionFlags"] = [];
    for (const t of inp.tasks) {
      if (t.task.timing.kind !== "window") continue;
      const { start, end } = t.task.timing.window;
      const doneOn = completion.get(t.task.id);
      if (doneOn !== undefined && doneOn <= date) { done.push(t.task.id); continue; }
      if (start <= date && date <= end) {
        due.push(t.task.id);
        for (const e of t.task.evidenceIds) refs.add(e);
        if (t.trigger && wd && (wd.state === "observed" || wd.state === "forecast") && wd.rainMm !== null && wd.rainMm >= t.trigger.thresholdMm) {
          conditionFlags.push({ taskId: t.task.id, rainMm: wd.rainMm, weatherState: wd.state, thresholdMm: t.trigger.thresholdMm, thresholdAssumptionId: t.trigger.thresholdAssumptionId });
        }
      } else if (end < date && date <= inp.asOfDate) overdue.push(t.task.id);
    }
    // Water
    const water: TimelineDay["water"] =
      inp.water?.status !== "computed" || !waterResult
        ? { state: "unavailable", outputId: inp.waterOutputId, missingReason: inp.water?.missingReason ?? "water_not_computed" }
        : waterResult.runs.length === 0
          ? { state: "unavailable", outputId: inp.waterOutputId, missingReason: `water_balance_${waterResult.status}` }
          : waterDays.has(date)
            ? { state: waterResult.evidenceState, outputId: inp.waterOutputId, missingReason: null }
            : { state: "unavailable", outputId: inp.waterOutputId, missingReason: "outside_water_balance_range" };
    // Outlook / price
    const hp = inp.harvestPeriods.find((p) => p.period.start <= date && date <= p.period.end) ?? null;
    let outlook: TimelineDay["outlook"];
    if (!hp) outlook = { state: "unavailable", harvestPeriodId: null, artifactId: null, issuedAt: null, missingReason: "outside_harvest_window" };
    else {
      const op = inp.outlook?.periods.find((p) => p.periodId === hp.periodId);
      if (inp.outlook?.state === "forecast" && op?.price) {
        outlook = { state: "forecast", harvestPeriodId: hp.periodId, artifactId: inp.outlook.artifactId, issuedAt: inp.outlook.issuedAt, missingReason: null };
        if (inp.outlook.artifactId) refs.add(inp.outlook.artifactId);
      } else if (inp.economics?.price.sources.includes("farmer_reported")) {
        outlook = { state: "farmer_reported", harvestPeriodId: hp.periodId, artifactId: null, issuedAt: null, missingReason: null };
      } else {
        outlook = { state: "unavailable", harvestPeriodId: hp.periodId, artifactId: null, issuedAt: null, missingReason: op?.missingReason ?? inp.outlook?.missingReason ?? (inp.outlook?.state === "historical_reference" ? "historical_reference_only_no_forecast" : "no_outlook") };
      }
    }
    // Visual: a dated photo is the only actual image; past dates without one show nothing.
    let visual: TimelineDay["visual"];
    const photo = photos.get(date);
    if (photo) visual = { assetId: photo, state: "observed_photo" };
    else if (date < inp.asOfDate) visual = { assetId: null, state: "none" };
    else if (expectedStage && illustrations.has(expectedStage.stageId)) visual = { assetId: illustrations.get(expectedStage.stageId)!, state: "illustrative" };
    else if (expectedStage) visual = { assetId: null, state: "schematic" };
    else visual = { assetId: null, state: "none" };
    if (visual.assetId) refs.add(visual.assetId);

    return {
      calendarDate: date,
      daysAfterPlanting: daysBetween(inp.stages.plantingDate, date),
      markers: { planting: date === inp.stages.plantingDate, asOf: date === inp.asOfDate, past: date < inp.asOfDate },
      expectedStage,
      tasks: { due, overdue, done, conditionFlags },
      weather,
      water,
      outlook,
      visual,
      evidenceRefs: [...refs].sort(),
    };
  });
}
