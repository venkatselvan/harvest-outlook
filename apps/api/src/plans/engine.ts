import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Assumption, NamedInput, PlanSnapshot, StageDefinition, VersionRef, type Mode } from "@harvest/contracts";
import { addDays, contentHash, deriveRevisionDraft, sealPlanSnapshot, sha256Hex, verifyPlanSnapshot, ECONOMICS_METHOD_VERSION, WATER_METHOD_VERSION } from "@harvest/domain";
import { withTransaction, type Pool } from "../db/pool";
import {
  bindOutlook,
  buildTaskDrafts,
  computeEconomics,
  computeHarvest,
  computeStages,
  computeWater,
  economicDelta,
  finalizeTasks,
  parseConfirmedInputs,
  seasonEnd,
  valueRecord,
  type EconomicsOutput,
  type HarvestOutput,
  type OutlookOutput,
  type ParsedInputs,
  type PlanTask,
  type StageOutput,
  type TaskOutput,
  type WaterOutput,
} from "./compute";
import { invalidPlanInput, modeMismatch, PlanError, planNotFound, versionConflict } from "./errors";
import * as repo from "./repository";
import type { PlanSources, WeatherScope } from "./sources";
import { buildTimeline, seasonRange, type TimelineDay } from "./timeline";
import {
  INPUT_KEYS,
  PLAN_ENGINE_VERSION,
  PlanChange,
  PlanParameters,
  ScenarioSelection,
  TASK_METHOD_VERSION,
  TIMELINE_METHOD_VERSION,
  type CreatePlanArgs,
  type OutputKind,
  type RevisePlanArgs,
  type StageTiming,
} from "./types";
import { composeWeather, regionDate, type ComposedWeather } from "./weather";

type StageDef = ReturnType<typeof StageDefinition.parse>;
type AssumptionT = ReturnType<typeof Assumption.parse>;
type NamedInputT = ReturnType<typeof NamedInput.parse>;
type Params = ReturnType<typeof PlanParameters.parse>;

/** Stored as plan output kind 'inputs'; its hash is pinned in snapshot.modelVersions (id 'plan-inputs'). */
interface InputsBundle {
  engineVersion: string;
  stageDefinitions: StageDef[];
  parameters: Params;
  decisionCutoff: string | null;
}

export interface ChangeSummary {
  changes: z.infer<typeof PlanChange>[];
  oldAssumptions: { confirmedInputs: NamedInputT[]; assumptions: AssumptionT[] };
  newAssumptions: { confirmedInputs: NamedInputT[]; assumptions: AssumptionT[] };
  changedTaskIds: string[];
  addedTaskIds: string[];
  removedTaskIds: string[];
  economicDelta: ReturnType<typeof economicDelta>;
  recomputedOutputs: OutputKind[];
  reusedOutputs: OutputKind[];
}

export interface PlanView {
  snapshot: PlanSnapshot;
  outputs: { id: string; kind: OutputKind; planId: string; methodVersion: string | null; contentHash: string; output: unknown }[];
  lineage: { parentId: string | null; childIds: string[] };
  deduplicated: boolean;
}

export interface TimelineView {
  planId: string;
  planContentHash: string;
  scenarioId: StageTiming;
  dataVersion: string;
  asOfDate: string;
  cached: boolean;
  range: { from: string; to: string };
  days: TimelineDay[];
}

export interface PlanServiceOptions {
  pool: Pool;
  /** Server-derived runtime mode (config.RUNTIME_MODE). */
  mode: Mode;
  sources: PlanSources;
  clock?: () => Date;
  newId?: () => string;
}

/** Deterministic UUID-shaped id from a seed (for output ids that are fixed before sealing). */
export function uuidFromSeed(seed: string): string {
  const h = sha256Hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const SELECTED_SCENARIO = "selected_scenario";
const EQUAL_SHARES = "equal_harvest_shares";
const PRICE_MIDPOINT = "assumed_price_central_midpoint";
const MAX_TIMELINE_DAYS = 800;

function parseOr<T extends z.ZodType>(schema: T, v: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw invalidPlanInput(`${what} is invalid`, { issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

const hashOf = (v: unknown) => contentHash(v);

/** Normalises pg/JSON round-trips (removes undefined, freezes nothing). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class PlanService {
  private readonly pool: Pool;
  private readonly mode: Mode;
  private readonly sources: PlanSources;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(o: PlanServiceOptions) {
    this.pool = o.pool;
    this.mode = o.mode;
    this.sources = o.sources;
    this.clock = o.clock ?? (() => new Date());
    this.newId = o.newId ?? randomUUID;
  }

  // ---------------------------------------------------------------- create

  async createPlan(args: CreatePlanArgs): Promise<PlanView> {
    if (args.mode !== this.mode) throw modeMismatch(`plan mode ${args.mode} does not match server mode ${this.mode}`);
    const mode = this.mode;
    const cutoff = this.checkCutoff(mode, args.decisionCutoff ?? null);
    const confirmedInputs = parseOr(z.array(NamedInput).max(100), args.confirmedInputs, "confirmedInputs");
    const userAssumptions = parseOr(z.array(Assumption).max(100), args.assumptions, "assumptions");
    const ruleVersions = parseOr(z.array(VersionRef).max(200), args.ruleVersions, "ruleVersions");
    const stageDefinitions = parseOr(z.array(StageDefinition).min(1).max(100), args.stageDefinitions, "stageDefinitions");
    const parameters = parseOr(PlanParameters, args.parameters, "parameters");
    this.checkStageDefs(stageDefinitions, args.cropId, mode);
    if (userAssumptions.some((a) => [SELECTED_SCENARIO, EQUAL_SHARES, PRICE_MIDPOINT].includes(a.id) || a.id.startsWith("climatology_"))) {
      throw invalidPlanInput("assumption ids selected_scenario, equal_harvest_shares, assumed_price_central_midpoint and climatology_* are engine-generated");
    }
    if (mode === "replay" && !args.sourceSnapshotId) throw invalidPlanInput("replay requires sourceSnapshotId");

    const farm = await repo.findFarm(this.pool, args.ownerId, args.farmId);
    if (!farm) throw new PlanError(404, "not_found", "Farm not found");
    const cropUuid = await repo.resolveCrop(this.pool, args.cropId);
    if (!cropUuid) throw invalidPlanInput(`unknown crop ${args.cropId}`);
    if (!(await repo.productBelongsToCrop(this.pool, args.productId, cropUuid))) throw invalidPlanInput(`product ${args.productId} is not a product of crop ${args.cropId}`);

    const now = this.clock();
    const decidedAt = cutoff ?? now.toISOString();
    const parsed = parseConfirmedInputs(confirmedInputs);
    const bundle: InputsBundle = { engineVersion: PLAN_ENGINE_VERSION, stageDefinitions, parameters, decisionCutoff: cutoff };
    const scope = this.scopeOf(farm);
    const computed = await this.computeAll({ bundle, parsed, assumptions: userAssumptions, productId: args.productId, scope, decidedAt, cutoff, mode, reuse: null, affected: null });

    const assumptions = this.withEngineAssumptions(userAssumptions, computed, parsed, args.farmId, null);
    const planId = this.newId();
    const outputs = this.newOutputs(planId, computed.newKinds, computed);
    const draft = {
      schemaVersion: "1.0" as const,
      id: planId,
      parentId: null,
      parentContentHash: null,
      ownerId: args.ownerId,
      farmId: args.farmId,
      cropId: args.cropId,
      productId: args.productId,
      createdAt: now.toISOString(),
      decidedAt,
      mode,
      sourceSnapshotId: args.sourceSnapshotId,
      confirmedInputs,
      assumptions,
      ruleVersions: [...ruleVersions, parameters.taskTemplateSet],
      modelVersions: this.modelVersions(hashOf(bundle), computed.outlook),
      outputIds: [...outputs.map((o) => o.id), uuidFromSeed(`${planId}:tasks`)],
    };
    const snapshot = sealPlanSnapshot(draft);
    const tasksOut = this.tasksOutput(computed, snapshot);
    const allOutputs = [...outputs, tasksOut];
    const inputHash = hashOf({
      op: "create",
      ownerId: args.ownerId,
      farmId: args.farmId,
      cropId: args.cropId,
      productId: args.productId,
      mode,
      confirmedInputs,
      assumptions: userAssumptions,
      ruleVersions,
      bundle,
      sourceSnapshotId: args.sourceSnapshotId,
      data: computed.dataFingerprint,
    });
    return this.persist({ snapshot, cropUuid, inputHash, outputs: allOutputs, dataVersions: computed.dataVersions, ownerId: args.ownerId });
  }

  // ---------------------------------------------------------------- revise

  async revisePlan(args: RevisePlanArgs): Promise<PlanView> {
    const changes = parseOr(z.array(PlanChange).min(1).max(20), args.changes, "changes");
    const parentRow = await repo.findPlan(this.pool, args.ownerId, args.planId);
    if (!parentRow) throw planNotFound();
    const parent = PlanSnapshot.parse(parentRow.snapshot);
    if (!verifyPlanSnapshot(parent)) throw new PlanError(500, "internal_error", "stored plan hash does not verify");
    if (parent.mode !== this.mode) throw modeMismatch(`plan mode ${parent.mode} does not match server mode ${this.mode}`);
    if (parent.contentHash !== args.expectedParentContentHash) {
      throw versionConflict("expected parent content hash does not match the plan", { currentContentHash: parent.contentHash });
    }
    const outRows = await repo.getOutputs(this.pool, args.ownerId, parent.outputIds);
    const byKind = new Map(outRows.map((r) => [r.kind, r]));
    const inputsRow = byKind.get("inputs");
    if (!inputsRow) throw new PlanError(500, "internal_error", "plan inputs output missing");
    const oldBundle = inputsRow.output as InputsBundle;

    // Apply typed changes.
    const nowIso = this.clock().toISOString();
    let confirmedInputs = plain(parent.confirmedInputs) as NamedInputT[];
    const userAssumptions = (plain(parent.assumptions) as AssumptionT[]).filter((a) => !this.isEngineAssumption(a.id));
    let selection: z.infer<typeof ScenarioSelection> | null = this.selectionOf(parent.assumptions as AssumptionT[]);
    const parameters = plain(oldBundle.parameters);
    const affected = new Set<OutputKind>();
    const scope = { level: "farm" as const, ids: [parent.farmId] };
    const setInput = (key: string, value: ReturnType<typeof valueRecord> | null, match?: (i: NamedInputT) => boolean) => {
      confirmedInputs = confirmedInputs.filter((i) => !(i.key === key && (!match || match(i))));
      if (value) confirmedInputs.push({ key, value });
    };
    for (const c of changes) {
      switch (c.type) {
        case "planting_date":
          setInput(INPUT_KEYS.plantingDate, valueRecord({ kind: "text", value: c.date, unit: null, evidenceState: "farmer_reported", scope }));
          // Observed stages before the new planting date no longer apply.
          confirmedInputs = confirmedInputs.filter((i) => !(i.key === INPUT_KEYS.observedStage && (i.value.validFrom ?? "") < c.date));
          ["stage_windows", "harvest_windows", "tasks", "water", "market_outlook", "economics"].forEach((k) => affected.add(k as OutputKind));
          break;
        case "observed_stage":
          setInput(
            INPUT_KEYS.observedStage,
            valueRecord({ kind: "category", value: c.stageId, unit: null, evidenceState: c.basis, scope, validFrom: c.observedOn, evidenceIds: c.journalEntryId ? [c.journalEntryId] : [] }),
            (i) => i.value.value === c.stageId,
          );
          ["stage_windows", "harvest_windows", "tasks", "water", "market_outlook", "economics"].forEach((k) => affected.add(k as OutputKind));
          break;
        case "area":
          setInput(INPUT_KEYS.area, valueRecord({ kind: "quantity", value: c.amount, unit: c.unit, evidenceState: "farmer_reported", scope }));
          affected.add("water");
          affected.add("economics");
          break;
        case "irrigation_category":
          setInput(INPUT_KEYS.irrigationCategory, valueRecord({ kind: "category", value: c.category, unit: null, evidenceState: "farmer_reported", scope }));
          affected.add("tasks");
          affected.add("water");
          break;
        case "cost_override":
          if (!parameters.economics) throw invalidPlanInput("plan has no economics parameters to override");
          parameters.economics.costs[c.line] = c.cost;
          affected.add("inputs");
          affected.add("economics");
          break;
        case "assumed_price":
          setInput(
            INPUT_KEYS.assumedPrice,
            c.price
              ? c.price.low === c.price.high
                ? valueRecord({ kind: "quantity", value: c.price.low, unit: c.price.unit, evidenceState: "farmer_reported", scope })
                : valueRecord({ kind: "range", value: { low: c.price.low, high: c.price.high }, unit: c.price.unit, evidenceState: "farmer_reported", scope })
              : null,
          );
          affected.add("economics");
          break;
        case "scenario_selection":
          selection = c.selection;
          break;
      }
    }
    // Any confirmed-input change re-binds tasks to the new snapshot; tasks are always re-issued per plan version.
    affected.add("tasks");
    const bundle: InputsBundle = { ...oldBundle, parameters };
    const parsed = parseConfirmedInputs(confirmedInputs);
    const farm = await repo.findFarm(this.pool, args.ownerId, parent.farmId);
    if (!farm) throw planNotFound();
    const cutoff = oldBundle.decisionCutoff;
    const decidedAt = this.mode === "replay" ? parent.decidedAt : nowIso;
    const reuse = {
      stages: byKind.get("stage_windows")?.output as StageOutput,
      harvest: byKind.get("harvest_windows")?.output as HarvestOutput,
      water: byKind.get("water")?.output as WaterOutput,
      outlook: byKind.get("market_outlook")?.output as OutlookOutput,
      economics: byKind.get("economics")?.output as EconomicsOutput,
      tasks: byKind.get("tasks")?.output as TaskOutput,
    };
    const computed = await this.computeAll({ bundle, parsed, assumptions: userAssumptions, productId: parent.productId, scope: this.scopeOf(farm), decidedAt, cutoff, mode: this.mode, reuse, affected });
    const assumptions = this.withEngineAssumptions(userAssumptions, computed, parsed, parent.farmId, selection);

    const planId = this.newId();
    const newKinds = computed.newKinds;
    const newOutputs = this.newOutputs(planId, newKinds, computed);
    const reusedIds = (["inputs", "stage_windows", "harvest_windows", "water", "market_outlook", "economics"] as OutputKind[])
      .filter((k) => !newKinds.includes(k) && byKind.has(k))
      .map((k) => ({ kind: k, id: byKind.get(k)!.id }));

    // Change summary (tasks diff ignores planId/planContentHash).
    const strip = (t: PlanTask) => hashOf({ timing: t.task.timing, amount: t.task.amount, dependsOn: t.task.dependsOn, taskType: t.task.taskType, trigger: t.trigger });
    const oldTasks = new Map((reuse.tasks?.tasks ?? []).map((t) => [t.task.id, strip(t)]));
    const newTaskHashes = new Map(computed.taskDrafts.map((d) => [d.task.id, strip(d as unknown as PlanTask)]));
    const summary: ChangeSummary = {
      changes,
      oldAssumptions: { confirmedInputs: parent.confirmedInputs as NamedInputT[], assumptions: parent.assumptions as AssumptionT[] },
      newAssumptions: { confirmedInputs, assumptions },
      changedTaskIds: [...newTaskHashes].filter(([id, h]) => oldTasks.has(id) && oldTasks.get(id) !== h).map(([id]) => id).sort(),
      addedTaskIds: [...newTaskHashes.keys()].filter((id) => !oldTasks.has(id)).sort(),
      removedTaskIds: [...oldTasks.keys()].filter((id) => !newTaskHashes.has(id)).sort(),
      economicDelta: economicDelta(reuse.economics ?? null, computed.economics),
      recomputedOutputs: [...newKinds, "tasks"],
      reusedOutputs: reusedIds.map((r) => r.kind),
    };
    const summaryOut = { id: uuidFromSeed(`${planId}:change_summary`), kind: "change_summary" as const, methodVersion: PLAN_ENGINE_VERSION, contentHash: hashOf(summary), output: summary };

    const draft = deriveRevisionDraft(parent, args.expectedParentContentHash, {
      id: planId,
      createdAt: nowIso,
      decidedAt,
      confirmedInputs,
      assumptions,
      ruleVersions: parent.ruleVersions as z.infer<typeof VersionRef>[],
      modelVersions: this.modelVersions(hashOf(bundle), computed.outlook),
      outputIds: [...reusedIds.map((r) => r.id), ...newOutputs.map((o) => o.id), uuidFromSeed(`${planId}:tasks`), summaryOut.id],
    });
    const snapshot = sealPlanSnapshot(draft);
    const tasksOut = this.tasksOutput(computed, snapshot);
    const inputHash = hashOf({ op: "revise", parentContentHash: parent.contentHash, changes, data: computed.dataFingerprint });
    const cropRow = await this.pool.query<{ crop_id: string }>("SELECT crop_id FROM plans WHERE id=$1", [parent.id]);
    return this.persist({
      snapshot,
      cropUuid: cropRow.rows[0]!.crop_id,
      inputHash,
      outputs: [...newOutputs, tasksOut, summaryOut],
      dataVersions: { ...(parentRow.data_versions ?? {}), ...computed.dataVersions },
      ownerId: args.ownerId,
      parentId: parent.id,
    });
  }

  // ---------------------------------------------------------------- read

  async getPlan(ownerId: string, planId: string): Promise<PlanView> {
    const row = await repo.findPlan(this.pool, ownerId, planId);
    if (!row) throw planNotFound();
    return this.view(row, false);
  }

  async getTimeline(ownerId: string, planId: string, q: { from?: string | undefined; to?: string | undefined; scenarioId?: StageTiming | undefined }): Promise<TimelineView> {
    const row = await repo.findPlan(this.pool, ownerId, planId);
    if (!row) throw planNotFound();
    const snap = row.snapshot;
    if (snap.mode !== this.mode) throw modeMismatch(`plan mode ${snap.mode} does not match server mode ${this.mode}`);
    const outs = await repo.getOutputs(this.pool, ownerId, snap.outputIds);
    const byKind = new Map(outs.map((o) => [o.kind, o]));
    const bundle = byKind.get("inputs")!.output as InputsBundle;
    const stages = byKind.get("stage_windows")!.output as StageOutput;
    const tasks = (byKind.get("tasks")!.output as TaskOutput).tasks;
    const scenarioId: StageTiming = q.scenarioId ?? this.selectionOf(snap.assumptions as AssumptionT[])?.stageTiming ?? "early";
    const cutoff = bundle.decisionCutoff;
    const asOfInstant = snap.mode === "replay" ? cutoff! : this.clock().toISOString();
    const asOfDate = regionDate(asOfInstant);
    const fullRange = seasonRange(stages, tasks);
    // Bounded: a timeline never exceeds MAX_TIMELINE_DAYS from its start.
    const maxTo = addDays(fullRange.from, MAX_TIMELINE_DAYS - 1);
    const range = { from: fullRange.from, to: fullRange.to > maxTo ? maxTo : fullRange.to };
    const farm = await repo.findFarm(this.pool, ownerId, snap.farmId);
    if (!farm) throw planNotFound();
    const scope = this.scopeOf(farm);

    const [wv, vv, cv] = await Promise.all([
      this.sources.weather.dataVersion(scope, { start: range.from, end: range.to }, asOfInstant),
      this.sources.visuals.version(ownerId, planId),
      this.sources.completions.version(ownerId, planId),
    ]);
    const dataVersion = hashOf({ m: TIMELINE_METHOD_VERSION, plan: snap.contentHash, asOfDate, weather: wv, visuals: vv, completions: cv });
    const slice = (days: TimelineDay[]) => {
      const from = q.from ?? range.from;
      const to = q.to ?? range.to;
      return days.filter((d) => d.calendarDate >= from && d.calendarDate <= to);
    };
    const base = { planId, planContentHash: snap.contentHash, scenarioId, dataVersion, asOfDate, range };
    const cached = (await repo.getCachedTimeline(this.pool, ownerId, planId, scenarioId, dataVersion)) as TimelineDay[] | null;
    if (cached) return { ...base, cached: true, days: slice(cached) };

    const weather = await this.fetchWeather(scope, range.from, range.to, asOfInstant, cutoff, snap.mode);
    const [visuals, completions] = await Promise.all([this.sources.visuals.getAssets(ownerId, planId), this.sources.completions.getCompletions(ownerId, planId)]);
    const days = buildTimeline({
      planId,
      planContentHash: snap.contentHash,
      scenarioId,
      asOfDate,
      range,
      stages,
      tasks,
      water: (byKind.get("water")?.output as WaterOutput) ?? null,
      waterOutputId: byKind.get("water")?.id ?? null,
      outlook: (byKind.get("market_outlook")?.output as OutlookOutput) ?? null,
      economics: (byKind.get("economics")?.output as EconomicsOutput) ?? null,
      harvestPeriods: ((byKind.get("harvest_windows")?.output as HarvestOutput)?.periods ?? []).map((p) => ({ periodId: p.periodId, period: p.period })),
      weather,
      visuals,
      completions,
    });
    await repo.putCachedTimeline(this.pool, ownerId, planId, scenarioId, dataVersion, days);
    return { ...base, cached: false, days: slice(days) };
  }

  // ---------------------------------------------------------------- internals

  private checkCutoff(mode: Mode, cutoff: string | null): string | null {
    if (mode === "replay") {
      if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw invalidPlanInput("replay mode requires decisionCutoff (ISO timestamp)");
      return new Date(cutoff).toISOString();
    }
    if (cutoff) throw modeMismatch("decisionCutoff is only accepted in replay mode");
    return null;
  }

  private checkStageDefs(defs: StageDef[], cropId: string, mode: Mode) {
    for (const d of defs) {
      if (d.cropId !== cropId) throw invalidPlanInput(`stage ${d.stageId} belongs to crop ${d.cropId}, not ${cropId}`);
      if (d.reviewStatus === "disabled") throw invalidPlanInput(`stage ${d.stageId} is disabled`);
      if (mode === "synthetic" && d.mode !== "synthetic") throw modeMismatch(`stage ${d.stageId} is ${d.mode}; synthetic plans use synthetic stage definitions only`);
      if (mode !== "synthetic" && (d.mode === "synthetic" || d.reviewStatus === "synthetic" || d.evidenceIds.some((e) => e.startsWith("synthetic-")))) {
        throw modeMismatch(`synthetic stage ${d.stageId} cannot be used in ${mode} mode`);
      }
    }
  }

  private scopeOf(f: repo.FarmRow): WeatherScope {
    return { farmId: f.id, districtId: f.district_code, stateId: f.state_code, point: f.lon !== null && f.lat !== null ? { lon: f.lon, lat: f.lat } : null };
  }

  private assertSourceMode(name: string, modes: readonly Mode[], mode: Mode) {
    if (!modes.includes(mode)) throw modeMismatch(`${name} source does not serve ${mode} mode`);
  }

  /** Exactly one call per WeatherSource method per computation. */
  private async fetchWeather(scope: WeatherScope, from: string, to: string, asOfInstant: string, cutoff: string | null, mode: Mode): Promise<ComposedWeather> {
    this.assertSourceMode("weather", this.sources.weather.modes, mode);
    const range = { start: from, end: to };
    const [observations, forecast, climatology] = await Promise.all([
      this.sources.weather.getDailyObservations(scope, range, { availableBy: asOfInstant }),
      this.sources.weather.getForecast(scope, { issuedAtOrBefore: asOfInstant }),
      this.sources.weather.getClimatology(scope, range),
    ]);
    return composeWeather({ from, to, asOfDate: regionDate(asOfInstant), mode, cutoff, observations, forecast, climatology });
  }

  private async computeAll(a: {
    bundle: InputsBundle;
    parsed: ParsedInputs;
    assumptions: AssumptionT[];
    productId: string;
    scope: WeatherScope;
    decidedAt: string;
    cutoff: string | null;
    mode: Mode;
    reuse: { stages: StageOutput; harvest: HarvestOutput; water: WaterOutput; outlook: OutlookOutput; economics: EconomicsOutput; tasks: TaskOutput } | null;
    affected: Set<OutputKind> | null;
  }) {
    const need = (k: OutputKind) => a.affected === null || a.affected.has(k) || !a.reuse;
    const p = a.bundle.parameters;
    const newKinds: OutputKind[] = [];
    const dataVersions: Record<string, unknown> = {};
    const dataFingerprint: Record<string, unknown> = {};
    if (need("inputs")) newKinds.push("inputs");

    let stages: StageOutput;
    if (need("stage_windows")) {
      stages = computeStages(a.bundle.stageDefinitions, a.parsed.plantingDate, a.parsed.observedStages);
      newKinds.push("stage_windows");
    } else stages = a.reuse!.stages;

    let harvest: HarvestOutput;
    if (need("harvest_windows")) {
      harvest = computeHarvest(stages);
      newKinds.push("harvest_windows");
    } else harvest = a.reuse!.harvest;

    const { drafts, skipped } = buildTaskDrafts({ templates: p.taskTemplates, stages, irrigationCategory: a.parsed.irrigationCategory, assumptions: a.assumptions, mode: a.mode });

    let water: WaterOutput;
    let weather: ComposedWeather | null = null;
    if (need("water")) {
      if (p.water) {
        weather = await this.fetchWeather(a.scope, stages.plantingDate, seasonEnd(stages), a.decidedAt, a.cutoff, a.mode);
        dataFingerprint.weather = hashOf(weather);
        dataVersions.weather = { asOfDate: weather.asOfDate, forecastIssuedAt: weather.forecastIssuedAt, climatology: weather.climatology };
      }
      water = computeWater({ params: p.water, stages, weather, areaHa: a.parsed.area?.ha ?? null, irrigationCategory: a.parsed.irrigationCategory });
      newKinds.push("water");
    } else water = a.reuse!.water;

    let outlook: OutlookOutput;
    if (need("market_outlook")) {
      this.assertSourceMode("market outlook", this.sources.outlook.modes, a.mode);
      const result = await this.sources.outlook.getOutlook(a.productId, p.economics?.marketIds ?? [], harvest.periods.map((h) => h.period), a.decidedAt);
      outlook = bindOutlook({ result, harvest, productId: a.productId, mode: a.mode, issueDate: a.decidedAt, cutoff: a.cutoff });
      dataFingerprint.outlook = hashOf({ state: outlook.state, artifactId: outlook.artifactId, issuedAt: outlook.issuedAt, missingReason: outlook.missingReason });
      dataVersions.outlook = { state: outlook.state, artifactId: outlook.artifactId, issuedAt: outlook.issuedAt, missingReason: outlook.missingReason };
      newKinds.push("market_outlook");
    } else outlook = a.reuse!.outlook;

    let economics: EconomicsOutput;
    if (need("economics")) {
      economics = computeEconomics({ params: p.economics, harvest, outlook, assumedPrice: a.parsed.assumedPrice, area: a.parsed.area, productId: a.productId });
      newKinds.push("economics");
    } else economics = a.reuse!.economics;

    return { bundle: a.bundle, stages, harvest, taskDrafts: drafts, skipped, water, outlook, economics, newKinds, dataVersions, dataFingerprint, weather };
  }

  private isEngineAssumption(id: string) {
    return id === SELECTED_SCENARIO || id === EQUAL_SHARES || id === PRICE_MIDPOINT || id.startsWith("climatology_");
  }

  private selectionOf(assumptions: AssumptionT[]): z.infer<typeof ScenarioSelection> | null {
    const a = assumptions.find((x) => x.id === SELECTED_SCENARIO);
    if (!a?.value || a.value.kind !== "category" || typeof a.value.value !== "string") return null;
    const [stageTiming, economicsScenario] = a.value.value.split("/");
    const r = ScenarioSelection.safeParse({ stageTiming, economicsScenario });
    return r.success ? r.data : null;
  }

  /** Adds engine-generated named assumptions so that the snapshot states every assumption used. */
  private withEngineAssumptions(
    user: AssumptionT[],
    c: { water: WaterOutput; economics: EconomicsOutput },
    parsed: ParsedInputs,
    farmId: string,
    selection: z.infer<typeof ScenarioSelection> | null,
  ): AssumptionT[] {
    const scope = { level: "farm" as const, ids: [farmId] };
    const out = user.filter((a) => !this.isEngineAssumption(a.id));
    const clim = c.water.weather?.climatologyAssumptionId;
    if (clim) {
      out.push({ id: clim, description: "Beyond the weather forecast horizon, daily climatological normals for these reference years stand in for weather (scenario, not a forecast).", value: null, evidenceIds: [] });
    }
    if (c.economics.equalSharesAssumed && c.economics.harvestShares.length > 0) {
      out.push({ id: EQUAL_SHARES, description: "Yield is split equally across harvest occurrences (no sourced per-picking shares).", value: null, evidenceIds: [] });
    }
    if (parsed.assumedPrice && parsed.assumedPrice.low !== parsed.assumedPrice.high) {
      out.push({ id: PRICE_MIDPOINT, description: "The central scenario uses the midpoint of the farmer's stated price range.", value: null, evidenceIds: [] });
    }
    const sel = selection ?? { stageTiming: "early" as const, economicsScenario: "central" as const };
    out.push({
      id: SELECTED_SCENARIO,
      description: "Default stage-timing and economics scenario shown in the explorer (selection only; no output depends on it).",
      value: valueRecord({ kind: "category", value: `${sel.stageTiming}/${sel.economicsScenario}`, unit: null, evidenceState: "farmer_reported", scope }),
      evidenceIds: [],
    });
    return out;
  }

  private modelVersions(bundleHash: string, outlook: OutlookOutput) {
    const v = [
      { id: "plan-engine", version: PLAN_ENGINE_VERSION },
      { id: "plan-inputs", version: bundleHash },
      { id: "stage-windows", version: "stage-windows/1" },
      { id: "task-templates", version: TASK_METHOD_VERSION },
      { id: "water-balance", version: WATER_METHOD_VERSION },
      { id: "economics-scenarios", version: ECONOMICS_METHOD_VERSION },
    ];
    if (outlook.artifactId && outlook.issuedAt) v.push({ id: outlook.artifactId, version: outlook.issuedAt });
    return v;
  }

  private newOutputs(planId: string, kinds: OutputKind[], c: Awaited<ReturnType<PlanService["computeAll"]>>): repo.NewOutput[] {
    const content: Partial<Record<OutputKind, { methodVersion: string; output: unknown }>> = {
      inputs: { methodVersion: PLAN_ENGINE_VERSION, output: c.bundle },
      stage_windows: { methodVersion: c.stages.methodVersion, output: c.stages },
      harvest_windows: { methodVersion: c.harvest.methodVersion, output: c.harvest },
      water: { methodVersion: c.water.methodVersion, output: c.water },
      market_outlook: { methodVersion: c.outlook.methodVersion, output: c.outlook },
      economics: { methodVersion: c.economics.methodVersion, output: c.economics },
    };
    return kinds.map((k) => {
      const x = plain(content[k]!);
      return { id: uuidFromSeed(`${planId}:${k}`), kind: k, methodVersion: x.methodVersion, contentHash: hashOf(x.output), output: x.output };
    });
  }

  private tasksOutput(c: Awaited<ReturnType<PlanService["computeAll"]>>, snapshot: PlanSnapshot): repo.NewOutput {
    const tasks = finalizeTasks(c.taskDrafts, snapshot.id, snapshot.contentHash);
    const out: TaskOutput = { methodVersion: TASK_METHOD_VERSION, templateSet: c.bundle.parameters.taskTemplateSet, tasks, skipped: c.skipped };
    const o = plain(out);
    return { id: uuidFromSeed(`${snapshot.id}:tasks`), kind: "tasks", methodVersion: TASK_METHOD_VERSION, contentHash: hashOf(o), output: o };
  }

  private async persist(p: {
    snapshot: PlanSnapshot;
    cropUuid: string;
    inputHash: string;
    outputs: repo.NewOutput[];
    dataVersions: Record<string, unknown>;
    ownerId: string;
    parentId?: string;
  }): Promise<PlanView> {
    const existing = await repo.findPlanByInputHash(this.pool, p.ownerId, p.inputHash);
    if (existing) return this.view(existing, true);
    try {
      await withTransaction(this.pool, async (client) => {
        if (p.parentId) {
          const parent = await repo.findPlan(client, p.ownerId, p.parentId, true);
          if (!parent) throw planNotFound();
          const kids = await repo.childPlanIds(client, p.ownerId, p.parentId);
          if (kids.length > 0) throw versionConflict("plan already has a newer revision", { latestPlanId: kids[0] });
        }
        await repo.insertPlan(client, { snapshot: p.snapshot, cropUuid: p.cropUuid, inputHash: p.inputHash, dataVersions: p.dataVersions, outputs: p.outputs });
      });
    } catch (e) {
      const code = (e as { code?: string; constraint?: string }).code;
      const constraint = (e as { constraint?: string }).constraint;
      if (code === "23505" && constraint === "plans_owner_input_hash_uq") {
        const again = await repo.findPlanByInputHash(this.pool, p.ownerId, p.inputHash);
        if (again) return this.view(again, true);
      }
      if (code === "23505" && constraint === "plans_single_child_uq") throw versionConflict("plan already has a newer revision");
      throw e;
    }
    const row = await repo.findPlan(this.pool, p.ownerId, p.snapshot.id);
    return this.view(row!, false);
  }

  private async view(row: repo.PlanRow, deduplicated: boolean): Promise<PlanView> {
    const snapshot = PlanSnapshot.parse(row.snapshot);
    const outs = await repo.getOutputs(this.pool, snapshot.ownerId, snapshot.outputIds);
    return {
      snapshot,
      outputs: outs.map((o) => ({ id: o.id, kind: o.kind, planId: o.plan_id, methodVersion: o.method_version, contentHash: o.content_hash, output: o.output })),
      lineage: { parentId: snapshot.parentId, childIds: await repo.childPlanIds(this.pool, snapshot.ownerId, snapshot.id) },
      deduplicated,
    };
  }
}

export { MAX_TIMELINE_DAYS };
