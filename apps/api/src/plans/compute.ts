import {
  ActionTask,
  ForecastArtifact,
  IrrigationCategory,
  type Assumption,
  type DateRange,
  type EconomicsInput,
  type EconomicsResult,
  type Mode,
  type NamedInput,
  type StageDefinition,
  type ValueRecord,
  type WaterBalanceResult,
} from "@harvest/contracts";
import {
  addDays,
  calculateScenarios,
  calculateWaterBalance,
  computeStageWindows,
  convertDecimal,
  Decimal,
  ECONOMICS_METHOD_VERSION,
  WATER_METHOD_VERSION,
  type StageWindow,
} from "@harvest/domain";
import { invalidPlanInput, modeMismatch, ReplayLeakError } from "./errors";
import type { OutlookResult } from "./sources";
import {
  HARVEST_METHOD_VERSION,
  INPUT_KEYS,
  OUTLOOK_METHOD_VERSION,
  STAGE_METHOD_VERSION,
  TASK_METHOD_VERSION,
  type EconomicsParameters,
  type StageTiming,
  type TaskTemplate,
  type WaterParameters,
} from "./types";
import type { ComposedWeather } from "./weather";

/*
 * Pure, deterministic plan computations. No I/O, no clock, no randomness: every
 * function's output depends only on its arguments. Data sources are fetched by
 * the service layer (engine.ts) and passed in.
 */

type NamedInputT = ReturnType<typeof NamedInput.parse>;
type AssumptionT = ReturnType<typeof Assumption.parse>;
type StageDef = ReturnType<typeof StageDefinition.parse>;

// ------------------------------------------------------------------ value records

export function valueRecord(p: {
  kind: "quantity" | "range" | "category" | "text";
  value: unknown;
  unit: string | null;
  evidenceState: ValueRecord["evidenceState"];
  scope: { level: "farm" | "district" | "state" | "market" | "region" | "national"; ids: string[] };
  validFrom?: string | null;
  evidenceIds?: string[];
  assumptionIds?: string[];
  methodVersion?: string | null;
  missingReason?: string | null;
}): ValueRecord {
  return {
    schemaVersion: "1.0",
    kind: p.kind,
    value: p.value,
    unit: p.unit,
    evidenceState: p.evidenceState,
    scope: p.scope,
    validFrom: p.validFrom ?? null,
    validTo: null,
    issuedAt: null,
    evidenceIds: p.evidenceIds ?? [],
    assumptionIds: p.assumptionIds ?? [],
    methodVersion: p.methodVersion ?? null,
    validationStatus: "pending",
    missingReason: p.missingReason ?? null,
  } as ValueRecord;
}

// ------------------------------------------------------------------ confirmed inputs

export interface ParsedInputs {
  plantingDate: string;
  area: { amount: number; unit: "ha" | "acre"; ha: number } | null;
  irrigationCategory: IrrigationCategory | null;
  assumedPrice: { unit: "INR/kg" | "INR/quintal"; low: number; high: number } | null;
  observedStages: { stageId: string; observedOn: string; evidenceState: string }[];
}

/** Interprets the well-known confirmedInputs keys (INPUT_KEYS). Unknown keys are carried but unused. */
export function parseConfirmedInputs(inputs: NamedInputT[]): ParsedInputs {
  const one = (key: string) => {
    const xs = inputs.filter((i) => i.key === key);
    if (xs.length > 1) throw invalidPlanInput(`confirmed input ${key} appears more than once`);
    return xs[0]?.value ?? null;
  };
  const pd = one(INPUT_KEYS.plantingDate);
  if (!pd || pd.kind !== "text" || typeof pd.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pd.value)) {
    throw invalidPlanInput(`confirmed input ${INPUT_KEYS.plantingDate} (kind text, YYYY-MM-DD) is required`);
  }
  const ar = one(INPUT_KEYS.area);
  let area: ParsedInputs["area"] = null;
  if (ar && ar.value !== null) {
    if (ar.kind !== "quantity" || (ar.unit !== "ha" && ar.unit !== "acre")) throw invalidPlanInput("area must be a quantity in ha or acre");
    const amount = Number(ar.value);
    if (!(amount > 0)) throw invalidPlanInput("area must be positive");
    area = { amount, unit: ar.unit, ha: convertDecimal(amount, ar.unit, "ha").toNumber() };
  }
  const ir = one(INPUT_KEYS.irrigationCategory);
  let irrigationCategory: IrrigationCategory | null = null;
  if (ir && ir.value !== null) {
    const parsed = IrrigationCategory.safeParse(ir.value);
    if (ir.kind !== "category" || !parsed.success) throw invalidPlanInput("irrigation_category must be rainfed, supplemental or irrigated");
    irrigationCategory = parsed.data;
  }
  const ap = one(INPUT_KEYS.assumedPrice);
  let assumedPrice: ParsedInputs["assumedPrice"] = null;
  if (ap && ap.value !== null) {
    if (ap.evidenceState !== "farmer_reported") throw invalidPlanInput("assumed_price must have evidenceState farmer_reported");
    if (ap.unit !== "INR/kg" && ap.unit !== "INR/quintal") throw invalidPlanInput("assumed_price unit must be INR/kg or INR/quintal");
    if (ap.kind === "quantity") {
      const v = Number(ap.value);
      assumedPrice = { unit: ap.unit, low: v, high: v };
    } else if (ap.kind === "range" && ap.value) {
      assumedPrice = { unit: ap.unit, low: Number(ap.value.low), high: Number(ap.value.high) };
    } else throw invalidPlanInput("assumed_price must be a quantity or range");
    if (assumedPrice.low < 0) throw invalidPlanInput("assumed_price must be non-negative");
  }
  const observedStages = inputs
    .filter((i) => i.key === INPUT_KEYS.observedStage)
    .map((i) => {
      const v = i.value;
      if (v.kind !== "category" || typeof v.value !== "string" || !v.validFrom) throw invalidPlanInput("observed_stage must be a category (stageId) with validFrom = observation date");
      if (v.evidenceState !== "observed" && v.evidenceState !== "farmer_reported") throw invalidPlanInput("observed_stage must be observed or farmer_reported");
      return { stageId: v.value, observedOn: v.validFrom, evidenceState: v.evidenceState };
    });
  return { plantingDate: pd.value, area, irrigationCategory, assumedPrice, observedStages };
}

// ------------------------------------------------------------------ stages

export interface StageOutput {
  methodVersion: string;
  evidenceState: "derived";
  plantingDate: string;
  windows: StageWindow[];
  stages: { stageId: string; name: string; order: number; isHarvest: boolean; evidenceIds: string[]; reviewStatus: string }[];
  overrides: { stageId: string; observedOn: string; evidenceState: string; affectedStageIds: string[] }[];
  limitations: string[];
}

function descendants(defs: StageDef[], root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of defs) if (d.startsAfter && out.has(d.startsAfter) && !out.has(d.stageId)) { out.add(d.stageId); grew = true; }
  }
  return out;
}

/**
 * Stage windows from duration ranges and a single planting date (domain time/stages).
 * A confirmed observed stage re-anchors that stage and its successors at the
 * observation date; earlier stages keep their calendar estimate.
 */
export function computeStages(defs: StageDef[], plantingDate: string, observed: ParsedInputs["observedStages"]): StageOutput {
  const base = computeStageWindows(defs, { earliest: plantingDate, latest: plantingDate });
  if (base.status !== "ok") throw invalidPlanInput(`stage windows unsupported: ${base.reason}`, { stageIds: base.stageIds });
  let windows = base.windows;
  const overrides: StageOutput["overrides"] = [];
  for (const o of [...observed].sort((a, b) => (a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0))) {
    if (!defs.some((d) => d.stageId === o.stageId)) throw invalidPlanInput(`observed stage ${o.stageId} is not a stage of this crop`);
    if (o.observedOn < plantingDate) throw invalidPlanInput("observed stage date is before planting");
    const sub = descendants(defs, o.stageId);
    const subDefs = defs.filter((d) => sub.has(d.stageId)).map((d) => (d.stageId === o.stageId ? { ...d, startsAfter: null } : d));
    const r = computeStageWindows(subDefs, { earliest: o.observedOn, latest: o.observedOn });
    if (r.status !== "ok") throw invalidPlanInput(`stage override unsupported: ${r.reason}`);
    windows = [...windows.filter((w) => !sub.has(w.stageId)), ...r.windows];
    overrides.push({ ...o, affectedStageIds: [...sub].sort() });
  }
  const order = new Map(defs.map((d) => [d.stageId, d.order]));
  windows.sort((a, b) => order.get(a.stageId)! - order.get(b.stageId)! || a.occurrence - b.occurrence);
  return {
    methodVersion: STAGE_METHOD_VERSION,
    evidenceState: "derived",
    plantingDate,
    windows,
    stages: [...defs]
      .sort((a, b) => a.order - b.order)
      .map((d) => ({ stageId: d.stageId, name: d.name, order: d.order, isHarvest: d.isHarvest, evidenceIds: d.evidenceIds, reviewStatus: d.reviewStatus })),
    overrides,
    limitations: [...base.limitations, "Stage windows are calendar-day estimates from duration ranges, not a growth model; the stage shown for a date is inferred."],
  };
}

/** Day-level span of each stage under a timing scenario (early = minimum durations, late = maximum). End is inclusive. */
export function stageSpans(windows: StageWindow[], timing: StageTiming): { stageId: string; occurrence: number; start: string; end: string }[] {
  return windows
    .map((w) => ({
      stageId: w.stageId,
      occurrence: w.occurrence,
      start: timing === "early" ? w.earliestStart : w.latestStart,
      end: addDays(timing === "early" ? w.earliestEnd : w.latestEnd, -1),
    }))
    .filter((s) => s.start <= s.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** Per-stage span merged across occurrences (repeated pickings: first start .. last end), used where gaps between pickings must still map to the stage. */
export function mergedStageSpans(windows: StageWindow[], timing: StageTiming): { stageId: string; start: string; end: string }[] {
  const by = new Map<string, { stageId: string; start: string; end: string }>();
  for (const s of stageSpans(windows, timing)) {
    const m = by.get(s.stageId);
    if (!m) by.set(s.stageId, { stageId: s.stageId, start: s.start, end: s.end });
    else { if (s.start < m.start) m.start = s.start; if (s.end > m.end) m.end = s.end; }
  }
  return [...by.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export function seasonEnd(stages: StageOutput): string {
  return stages.windows.map((w) => w.latestEnd).sort().at(-1)!;
}

// ------------------------------------------------------------------ harvest windows

export interface HarvestPeriod {
  periodId: string;
  stageId: string;
  occurrence: number;
  period: DateRange;
  earliestStart: string;
  latestStart: string;
  earliestEnd: string;
  latestEnd: string;
}
export interface HarvestOutput {
  methodVersion: string;
  evidenceState: "derived";
  repeated: boolean;
  periods: HarvestPeriod[];
  limitations: string[];
}

/** Harvest windows from duration ranges; repeated-picking stages yield one period per occurrence. */
export function computeHarvest(stages: StageOutput): HarvestOutput {
  const hw = stages.windows.filter((w) => w.isHarvest);
  const periods = hw
    .map((w) => ({
      periodId: `harvest-${w.stageId}-${w.occurrence}`,
      stageId: w.stageId,
      occurrence: w.occurrence,
      period: { start: w.earliestStart, end: w.latestEnd },
      earliestStart: w.earliestStart,
      latestStart: w.latestStart,
      earliestEnd: w.earliestEnd,
      latestEnd: w.latestEnd,
    }))
    .sort((a, b) => (a.earliestStart < b.earliestStart ? -1 : a.earliestStart > b.earliestStart ? 1 : a.occurrence - b.occurrence));
  const limitations = periods.length === 0 ? ["No harvest stage is defined; no harvest window can be computed."] : [];
  if (hw.some((w) => w.occurrence > 1)) limitations.push("Repeated harvest windows widen with each occurrence; the number of pickings achieved is not predicted.");
  return { methodVersion: HARVEST_METHOD_VERSION, evidenceState: "derived", repeated: hw.some((w) => w.occurrence > 1), periods, limitations };
}

// ------------------------------------------------------------------ tasks

export interface TaskTrigger {
  type: "daily_rain_gte";
  thresholdAssumptionId: string;
  thresholdMm: number;
  /** Threshold is a named planning assumption unless the assumption carries evidence IDs. */
  thresholdBasis: "assumption" | "sourced";
}
export interface PlanTaskDraft {
  task: Omit<ActionTask, "planId" | "planContentHash">;
  templateId: string;
  stageId: string;
  occurrence: number;
  description: string;
  offsetBasis: TaskTemplate["offsetBasis"];
  trigger: TaskTrigger | null;
}
export interface PlanTask extends Omit<PlanTaskDraft, "task"> {
  task: ActionTask;
}
export interface TaskOutput {
  methodVersion: string;
  templateSet: { id: string; version: string | number };
  tasks: PlanTask[];
  skipped: { templateId: string; reason: string }[];
}

function assumptionNumber(assumptions: AssumptionT[], id: string, unit: string): { value: number; sourced: boolean } {
  const a = assumptions.find((x) => x.id === id);
  if (!a) throw invalidPlanInput(`task references unknown assumption ${id}`);
  const v = a.value;
  if (!v || v.kind !== "quantity" || v.value === null || v.unit !== unit) throw invalidPlanInput(`assumption ${id} must be a quantity in ${unit}`);
  return { value: Number(v.value), sourced: a.evidenceIds.length > 0 };
}

export function buildTaskDrafts(args: {
  templates: TaskTemplate[];
  stages: StageOutput;
  irrigationCategory: IrrigationCategory | null;
  assumptions: AssumptionT[];
  mode: Mode;
}): { drafts: PlanTaskDraft[]; skipped: TaskOutput["skipped"] } {
  const { templates, stages, irrigationCategory, assumptions, mode } = args;
  const skipped: TaskOutput["skipped"] = [];
  const drafts: PlanTaskDraft[] = [];
  const ids = new Set(templates.map((t) => t.id));
  if (ids.size !== templates.length) throw invalidPlanInput("duplicate task template id");
  const occurrencesByTemplate = new Map<string, Set<number>>();
  for (const t of templates) {
    if (t.irrigation.length > 0) {
      if (irrigationCategory === null) { skipped.push({ templateId: t.id, reason: "irrigation_category_unknown" }); continue; }
      if (!t.irrigation.includes(irrigationCategory)) { skipped.push({ templateId: t.id, reason: `not_applicable_${irrigationCategory}` }); continue; }
    }
    if (t.offsetBasis.kind === "assumption" && !assumptions.some((a) => a.id === (t.offsetBasis as { assumptionId: string }).assumptionId)) {
      throw invalidPlanInput(`task template ${t.id} offset assumption is not listed in plan assumptions`);
    }
    const ws = stages.windows.filter((w) => w.stageId === t.stageId);
    if (ws.length === 0) { skipped.push({ templateId: t.id, reason: "stage_not_in_plan" }); continue; }
    let trigger: TaskTrigger | null = null;
    if (t.trigger) {
      const th = assumptionNumber(assumptions, t.trigger.thresholdAssumptionId, "mm");
      trigger = { type: "daily_rain_gte", thresholdAssumptionId: t.trigger.thresholdAssumptionId, thresholdMm: th.value, thresholdBasis: th.sourced ? "sourced" : "assumption" };
    }
    occurrencesByTemplate.set(t.id, new Set(ws.map((w) => w.occurrence)));
    for (const w of ws) {
      const [a, b] =
        t.anchor === "stage_start" ? [w.earliestStart, w.latestStart] : t.anchor === "stage_end" ? [w.earliestEnd, w.latestEnd] : [w.earliestStart, w.latestEnd];
      const window = { start: addDays(a, t.startOffsetDays), end: addDays(b, t.endOffsetDays) };
      if (window.start > window.end) throw invalidPlanInput(`task template ${t.id} produces an inverted window`);
      const evidenceIds = [...t.evidenceIds];
      if (mode !== "synthetic" && evidenceIds.some((e) => e.startsWith("synthetic-"))) throw modeMismatch(`synthetic evidence on task template ${t.id} in ${mode} mode`);
      drafts.push({
        templateId: t.id,
        stageId: t.stageId,
        occurrence: w.occurrence,
        description: t.description,
        offsetBasis: t.offsetBasis,
        trigger,
        task: {
          schemaVersion: "1.0",
          id: `${t.id}:${w.occurrence}`,
          taskType: t.taskType,
          // ActionTask 'condition' timing requires a RuleField; no daily-rain field exists yet, so
          // rain-conditioned tasks carry a window (when to watch) plus the `trigger` below.
          timing: { kind: "window", window },
          dependsOn: [],
          amount: t.amount,
          evidenceIds,
          reasonCode: t.reasonCode,
          state: "pending",
          completionEvidence: null,
          mode,
        },
      });
    }
  }
  const draftIds = new Set(drafts.map((d) => d.task.id));
  for (const d of drafts) {
    const t = templates.find((x) => x.id === d.templateId)!;
    d.task.dependsOn = t.dependsOn
      .map((dep) => (occurrencesByTemplate.get(dep)?.has(d.occurrence) ? `${dep}:${d.occurrence}` : `${dep}:1`))
      .filter((id) => draftIds.has(id) && id !== d.task.id);
  }
  drafts.sort((x, y) => (x.task.timing.kind === "window" && y.task.timing.kind === "window" ? x.task.timing.window.start.localeCompare(y.task.timing.window.start) : 0) || x.task.id.localeCompare(y.task.id));
  return { drafts, skipped };
}

/** Binds drafts to the sealed snapshot (planId + contentHash) and validates each ActionTask. */
export function finalizeTasks(drafts: PlanTaskDraft[], planId: string, planContentHash: string): PlanTask[] {
  return drafts.map((d) => {
    const parsed = ActionTask.safeParse({ ...d.task, planId, planContentHash });
    if (!parsed.success) throw invalidPlanInput(`task ${d.task.id} invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { ...d, task: parsed.data };
  });
}

// ------------------------------------------------------------------ water

export interface WaterOutput {
  methodVersion: string;
  status: "computed" | "unavailable";
  missingReason: string | null;
  irrigationCategory: IrrigationCategory | null;
  interpretation: "irrigation_requirement" | "deficit_indicator_rainfed" | "irrigation_category_unknown" | null;
  weather: {
    from: string;
    to: string;
    asOfDate: string;
    forecastIssuedAt: string | null;
    forecastHorizonEnd: string | null;
    climatologyAssumptionId: string | null;
    counts: Record<string, number>;
    days: { date: string; state: string; rainMm: number | null; et0Mm: number | null; issuedAt: string | null; sourceId: string | null }[];
  } | null;
  byTiming: Partial<Record<StageTiming, WaterBalanceResult>>;
  notes: string[];
}

export function computeWater(args: {
  params: WaterParameters | null;
  stages: StageOutput;
  weather: ComposedWeather | null;
  areaHa: number | null;
  irrigationCategory: IrrigationCategory | null;
}): WaterOutput {
  const { params, stages, weather, areaHa, irrigationCategory } = args;
  const interpretation =
    irrigationCategory === null ? "irrigation_category_unknown" : irrigationCategory === "rainfed" ? "deficit_indicator_rainfed" : "irrigation_requirement";
  if (!params || !weather) {
    return { methodVersion: WATER_METHOD_VERSION, status: "unavailable", missingReason: params ? "weather_unavailable" : "water_parameters_missing", irrigationCategory, interpretation: null, weather: null, byTiming: {}, notes: [] };
  }
  const notes = [
    "Climatology days are passed to the water balance with rainState 'climatology'; such results are scenarios.",
    "Past days without an observation are passed as missing; the balance is then incomplete rather than gap-filled.",
  ];
  if (interpretation === "deficit_indicator_rainfed") notes.push("Rainfed plan: computed irrigation need is a water-deficit indicator, not an irrigation instruction.");
  const byDate = new Map(weather.days.map((d) => [d.date, d]));
  const byTiming: WaterOutput["byTiming"] = {};
  for (const timing of ["early", "late"] as const) {
    const spans = mergedStageSpans(stages.windows, timing);
    const kcStages = spans.flatMap((s) => {
      const k = params.kcByStage.find((x) => x.stageId === s.stageId);
      return k ? [{ stageId: s.stageId, start: s.start, end: s.end, kc: k.kc, kcSource: k.kcSource }] : [];
    });
    const end = spans.map((s) => s.end).sort().at(-1) ?? stages.plantingDate;
    const days: { date: string; et0Mm: number | null; et0Source: string | null; rainMm: number | null; rainState: "observed" | "forecast" | "climatology" | "missing" }[] = [];
    for (let d = stages.plantingDate; d <= end; d = addDays(d, 1)) {
      const w = byDate.get(d);
      const rain = w && w.state !== "unavailable" ? w.rainMm : null;
      const et0 = w && w.state !== "unavailable" ? w.et0Mm : null;
      days.push({
        date: d,
        et0Mm: et0,
        et0Source: et0 === null ? null : (w?.sourceId ?? null),
        rainMm: rain,
        rainState: rain === null ? "missing" : w!.state === "observed" ? "observed" : w!.state === "scenario" ? "climatology" : "forecast",
      });
    }
    byTiming[timing] = calculateWaterBalance({
      schemaVersion: "1.0",
      days,
      stages: kcStages.length ? kcStages : [{ stageId: "none", start: stages.plantingDate, end: stages.plantingDate, kc: 0, kcSource: "none" }],
      rootZone: params.rootZone,
      effectiveRain: params.effectiveRain,
      forecastRainPolicy: params.forecastRainPolicy,
      irrigationEfficiency: params.irrigationEfficiency,
      areaHa,
      tawScenariosMm: params.tawScenariosMm,
    });
  }
  return {
    methodVersion: WATER_METHOD_VERSION,
    status: "computed",
    missingReason: null,
    irrigationCategory,
    interpretation,
    weather: {
      from: weather.days[0]?.date ?? stages.plantingDate,
      to: weather.days.at(-1)?.date ?? stages.plantingDate,
      asOfDate: weather.asOfDate,
      forecastIssuedAt: weather.forecastIssuedAt,
      forecastHorizonEnd: weather.forecastHorizonEnd,
      climatologyAssumptionId: weather.climatology?.assumptionId ?? null,
      counts: weather.counts,
      days: weather.days.map((d) => ({ date: d.date, state: d.state, rainMm: d.rainMm, et0Mm: d.et0Mm, issuedAt: d.issuedAt, sourceId: d.sourceId })),
    },
    byTiming,
    notes,
  };
}

// ------------------------------------------------------------------ market outlook

export interface OutlookOutput {
  methodVersion: string;
  state: "forecast" | "unavailable";
  missingReason: string | null;
  issueDate: string;
  artifactId: string | null;
  issuedAt: string | null;
  modelId: string | null;
  /** Per harvest period: price triple from forecast quantiles, or null with a reason. */
  periods: { periodId: string; period: DateRange; price: { low: number; central: number; high: number; levels: [number, number, number] } | null; missingReason: string | null }[];
  artifact: ForecastArtifact | null;
}

export function bindOutlook(args: { result: OutlookResult; harvest: HarvestOutput; productId: string; mode: Mode; issueDate: string; cutoff: string | null }): OutlookOutput {
  const { result, harvest, productId, mode, issueDate, cutoff } = args;
  const base = { methodVersion: OUTLOOK_METHOD_VERSION, issueDate };
  if ("state" in result) {
    return { ...base, state: "unavailable", missingReason: result.missingReason, artifactId: null, issuedAt: null, modelId: null, periods: harvest.periods.map((p) => ({ periodId: p.periodId, period: p.period, price: null, missingReason: result.missingReason })), artifact: null };
  }
  const parsed = ForecastArtifact.safeParse(result);
  if (!parsed.success) throw invalidPlanInput("market outlook artifact failed contract validation");
  const a = parsed.data;
  if (a.mode !== mode) throw modeMismatch(`market outlook artifact mode ${a.mode} cannot feed a ${mode} plan`);
  if (a.productId !== productId) throw invalidPlanInput("market outlook artifact is for a different product");
  const bound = cutoff ?? issueDate;
  if (Date.parse(a.issuedAt) > Date.parse(bound)) throw new ReplayLeakError("market outlook issued after the decision time", { issuedAt: a.issuedAt, bound });
  const periods = harvest.periods.map((p) => {
    let best: (typeof a.predictions)[number] | null = null;
    let bestOverlap = 0;
    for (const pr of a.predictions) {
      const s = pr.period.start > p.period.start ? pr.period.start : p.period.start;
      const e = pr.period.end < p.period.end ? pr.period.end : p.period.end;
      const ov = s <= e ? Date.parse(e) - Date.parse(s) + 1 : 0;
      if (ov > bestOverlap) { best = pr; bestOverlap = ov; }
    }
    if (!best) return { periodId: p.periodId, period: p.period, price: null, missingReason: "no_forecast_for_period" };
    const q = best.quantiles;
    const med = q.find((x) => x.level === 0.5);
    if (!med || q.length < 3) return { periodId: p.periodId, period: p.period, price: null, missingReason: "forecast_lacks_median_and_interval" };
    const lo = q[0]!;
    const hi = q[q.length - 1]!;
    return { periodId: p.periodId, period: p.period, price: { low: lo.value, central: med.value, high: hi.value, levels: [lo.level, 0.5, hi.level] as [number, number, number] }, missingReason: null };
  });
  return { ...base, state: "forecast", missingReason: null, artifactId: a.id, issuedAt: a.issuedAt, modelId: a.modelId, periods, artifact: a };
}

// ------------------------------------------------------------------ economics

export interface EconomicsOutput {
  methodVersion: string;
  status: "computed" | "unavailable";
  missingReason: string | null;
  price: { state: "forecast" | "farmer_reported" | "unavailable"; sources: ("forecast" | "farmer_reported")[]; missingReason: string | null };
  harvestShares: { periodId: string; share: number }[];
  equalSharesAssumed: boolean;
  /** Figures that do not depend on any price (marketable quantity, costs, break-even price). */
  priceIndependent: {
    status: EconomicsResult["status"];
    missingInputs: string[];
    errors: EconomicsResult["errors"];
    scenarios: {
      name: string;
      perHa: { marketableKgTotal: string; cashProductionCostInr: string | null; harvestCostInr: string | null; saleAndTransportCostInr: string | null; processingCostInr: string; breakEvenPriceInrPerKg: string | null };
    }[];
  } | null;
  /** Full scenario economics per price basis; empty when no price basis exists. */
  variants: { priceSource: "forecast" | "farmer_reported"; priceEvidenceIds: string[]; assumptions: string[]; result: EconomicsResult }[];
}

export function computeEconomics(args: {
  params: EconomicsParameters | null;
  harvest: HarvestOutput;
  outlook: OutlookOutput;
  assumedPrice: ParsedInputs["assumedPrice"];
  area: ParsedInputs["area"];
  productId: string;
}): EconomicsOutput {
  const { params, harvest, outlook, assumedPrice, area, productId } = args;
  const priceState: EconomicsOutput["price"] = { state: "unavailable", sources: [], missingReason: outlook.missingReason };
  if (!params) {
    return { methodVersion: ECONOMICS_METHOD_VERSION, status: "unavailable", missingReason: "economics_parameters_missing", price: priceState, harvestShares: [], equalSharesAssumed: false, priceIndependent: null, variants: [] };
  }
  const n = harvest.periods.length;
  const equal = !(params.harvestShares && params.harvestShares.length === n);
  const shares = harvest.periods.map((p, i) => ({ periodId: p.periodId, share: equal ? 1 / n : params.harvestShares![i]! }));
  const baseInput = (prices: EconomicsInput["prices"]): EconomicsInput => ({
    schemaVersion: "1.0",
    productId,
    area: area ? { amount: area.amount, unit: area.unit } : null,
    yield: params.yield,
    marketableFraction: params.marketableFraction,
    harvests: harvest.periods.map((p, i) => ({ periodId: p.periodId, period: p.period, shareOfYield: shares[i]!.share })),
    prices,
    conversion: params.conversion,
    costs: params.costs,
    unpricedItems: params.unpricedItems,
  });
  if (n === 0) {
    return { methodVersion: ECONOMICS_METHOD_VERSION, status: "unavailable", missingReason: "no_harvest_window", price: priceState, harvestShares: [], equalSharesAssumed: false, priceIndependent: null, variants: [] };
  }

  // Price-independent figures: the domain is run with a zero placeholder price that never leaves
  // this function; only quantities, cost lines and the break-even price (which do not depend on
  // price) are kept. Gross revenue / net return are NOT taken from this run.
  const probe = calculateScenarios(
    baseInput(harvest.periods.map((p) => ({ periodId: p.periodId, productBasis: params.priceProductBasis, unit: "INR/kg", amount: { low: 0, central: 0, high: 0 }, evidenceState: "scenario", marketId: null, evidenceIds: [] }))),
  );
  const priceIndependent: EconomicsOutput["priceIndependent"] = {
    status: probe.status,
    missingInputs: probe.missingInputs,
    errors: probe.errors,
    scenarios: probe.scenarios.map((s) => ({
      name: s.name,
      perHa: {
        marketableKgTotal: s.perHa.marketableKgTotal,
        cashProductionCostInr: s.perHa.cashProductionCostInr,
        harvestCostInr: s.perHa.harvestCostInr,
        saleAndTransportCostInr: s.perHa.saleAndTransportCostInr,
        processingCostInr: s.perHa.processingCostInr,
        breakEvenPriceInrPerKg: s.perHa.breakEvenPriceInrPerKg,
      },
    })),
  };

  const variants: EconomicsOutput["variants"] = [];
  if (outlook.state === "forecast" && outlook.periods.every((p) => p.price !== null)) {
    const prices = outlook.periods.map((p) => ({
      periodId: p.periodId,
      productBasis: params.priceProductBasis,
      unit: "INR/kg" as const,
      amount: { low: p.price!.low, central: p.price!.central, high: p.price!.high },
      evidenceState: "forecast" as const,
      marketId: null,
      evidenceIds: [outlook.artifactId!],
    }));
    variants.push({ priceSource: "forecast", priceEvidenceIds: [outlook.artifactId!], assumptions: [`Price triple = forecast quantiles ${outlook.periods[0]!.price!.levels.join("/")} from artifact ${outlook.artifactId}; quantiles are not mandi min/max.`], result: calculateScenarios(baseInput(prices)) });
    priceState.sources.push("forecast");
  } else if (outlook.state === "forecast") {
    priceState.missingReason = "forecast_does_not_cover_all_harvest_periods";
  }
  if (assumedPrice) {
    const kg = (v: number) => convertDecimal(v, assumedPrice.unit, "INR/kg");
    const lo = kg(assumedPrice.low);
    const hi = kg(assumedPrice.high);
    const central = lo.add(hi).div(2);
    const amount = { low: lo.toString(), central: central.toDecimalPlaces(6).toString(), high: hi.toString() };
    const prices = harvest.periods.map((p) => ({ periodId: p.periodId, productBasis: params.priceProductBasis, unit: "INR/kg" as const, amount, evidenceState: "farmer_reported" as const, marketId: null, evidenceIds: [] }));
    const assumptions = ["Farmer-reported assumed price applied to every harvest period; it is not a market observation or forecast."];
    if (assumedPrice.low !== assumedPrice.high) assumptions.push("Central price is the midpoint of the farmer's stated range (assumed_price_central_midpoint).");
    variants.push({ priceSource: "farmer_reported", priceEvidenceIds: [], assumptions, result: calculateScenarios(baseInput(prices)) });
    priceState.sources.push("farmer_reported");
  }
  priceState.state = priceState.sources.includes("forecast") ? "forecast" : priceState.sources.includes("farmer_reported") ? "farmer_reported" : "unavailable";
  if (priceState.state !== "unavailable") priceState.missingReason = null;
  return { methodVersion: ECONOMICS_METHOD_VERSION, status: "computed", missingReason: null, price: priceState, harvestShares: shares, equalSharesAssumed: equal, priceIndependent, variants };
}

/** Central per-ha figures for the "Why this changed" economic delta. */
export function economicDelta(oldE: EconomicsOutput | null, newE: EconomicsOutput | null) {
  const pick = (e: EconomicsOutput | null) => {
    const out = new Map<string, { netCash: string | null; breakEven: string | null }>();
    for (const v of e?.variants ?? []) for (const s of v.result.scenarios) out.set(`${v.priceSource}:${s.name}`, { netCash: s.perHa.netCashReturnInr, breakEven: s.perHa.breakEvenPriceInrPerKg });
    for (const s of e?.priceIndependent?.scenarios ?? []) if (!out.has(`none:${s.name}`)) out.set(`none:${s.name}`, { netCash: null, breakEven: s.perHa.breakEvenPriceInrPerKg });
    return out;
  };
  const a = pick(oldE);
  const b = pick(newE);
  const diff = (x: string | null | undefined, y: string | null | undefined) => (x != null && y != null ? new Decimal(y).sub(x).toFixed(2) : null);
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((k) => {
    const [priceSource, scenario] = k.split(":") as [string, string];
    const o = a.get(k);
    const nw = b.get(k);
    return {
      priceSource,
      scenario,
      netCashReturnInrPerHa: { old: o?.netCash ?? null, new: nw?.netCash ?? null, delta: diff(o?.netCash, nw?.netCash) },
      breakEvenPriceInrPerKg: { old: o?.breakEven ?? null, new: nw?.breakEven ?? null, delta: diff(o?.breakEven, nw?.breakEven) },
    };
  });
}
