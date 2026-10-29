import { apiRequest, jsonInit, newEntryId } from "../features/photo-region/http";
import type { MediaInfo } from "../features/photo-region/types";
import type { SceneKeyframe } from "../features/season-scene";
import type { RuntimeMode } from "./api";

/*
 * Typed client for the plan, timeline and visuals routes (T08, T11, T12). Types mirror the server response shapes
 * (apps/api/src/plans/routes.ts, routes/schemas/visuals.ts); the client only reads and displays these fields.
 */

export type Scenario = "early" | "late";
export type TimelineWeatherState = "observed" | "forecast" | "scenario" | "unavailable";
export type EvidenceState = "observed" | "farmer_reported" | "derived" | "forecast" | "scenario" | "illustrative" | "unavailable";

export interface TimelineDay {
  calendarDate: string;
  daysAfterPlanting: number;
  markers: { planting: boolean; asOf: boolean; past: boolean };
  expectedStage: { stageId: string; occurrence: number; window: { start: string; end: string }; inferred: true; basis: "calendar_estimate" | "observed_stage_override"; possibleStageIds: string[] } | null;
  tasks: {
    due: string[];
    overdue: string[];
    done: string[];
    conditionFlags: { taskId: string; rainMm: number; weatherState: "observed" | "forecast"; thresholdMm: number; thresholdAssumptionId: string }[];
  };
  weather: {
    state: TimelineWeatherState;
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

export interface TimelineView {
  planId: string;
  planContentHash: string;
  scenarioId: Scenario;
  dataVersion: string;
  asOfDate: string;
  cached: boolean;
  range: { from: string; to: string };
  days: TimelineDay[];
}

export interface PlanTaskOutput {
  templateId: string;
  stageId: string;
  occurrence: number;
  description: string;
  trigger: { type: "daily_rain_gte"; thresholdAssumptionId: string; thresholdMm: number; thresholdBasis: "assumption" | "sourced" } | null;
  task: { id: string; taskType: string; timing: { kind: "window"; window: { start: string; end: string } } | { kind: "condition"; description: string }; evidenceIds: string[]; reasonCode: string; state: string; dependsOn: string[] };
}

export interface WaterDaily {
  date: string;
  kc: number;
  etcMm: number;
  effectiveRainMm: number;
  rainState: "observed" | "forecast" | "climatology" | "missing";
  irrigationNetMm: number;
  depletionEndMm: number | null;
}
export interface WaterRunOut {
  label: string;
  evidenceState: "derived" | "scenario";
  tawMm: number | null;
  stressDays: number;
  daily: WaterDaily[];
}
export interface EconomicsFiguresOut {
  marketableKgTotal: string;
  grossRevenueInr: string;
  cashProductionCostInr: string | null;
  harvestCostInr: string | null;
  saleAndTransportCostInr: string | null;
  netCashReturnInr: string | null;
  breakEvenPriceInrPerKg: string | null;
  notes: string[];
}

export interface PlanOutputs {
  inputs?: unknown;
  stage_windows?: {
    plantingDate: string;
    stages: { stageId: string; name: string; order: number; isHarvest: boolean; evidenceIds: string[]; reviewStatus: string }[];
    limitations: string[];
  };
  harvest_windows?: { periods: { periodId: string; stageId: string; period: { start: string; end: string }; earliestStart: string; latestEnd: string }[]; limitations: string[] };
  tasks?: { tasks: PlanTaskOutput[]; skipped: { templateId: string; reason: string }[]; templateSet: { id: string; version: string | number } };
  water?: {
    status: "computed" | "unavailable";
    missingReason: string | null;
    interpretation: string | null;
    byTiming: Partial<Record<Scenario, { status: string; evidenceState: string; permittedPrecision: string; runs: WaterRunOut[] }>>;
    notes: string[];
  };
  market_outlook?: {
    state: "forecast" | "unavailable";
    missingReason: string | null;
    issueDate: string;
    issuedAt: string | null;
    periods: { periodId: string; period: { start: string; end: string }; price: { low: number; central: number; high: number; levels: [number, number, number] } | null; missingReason: string | null }[];
  };
  economics?: {
    status: "computed" | "unavailable";
    missingReason: string | null;
    price: { state: "forecast" | "farmer_reported" | "unavailable"; sources: string[]; missingReason: string | null };
    equalSharesAssumed: boolean;
    priceIndependent: { status: string; missingInputs: string[]; scenarios: { name: string; perHa: { marketableKgTotal: string; cashProductionCostInr: string | null; harvestCostInr: string | null; saleAndTransportCostInr: string | null; breakEvenPriceInrPerKg: string | null } }[] } | null;
    variants: { priceSource: "forecast" | "farmer_reported"; assumptions: string[]; result: { status: string; scenarios: { name: string; perHa: EconomicsFiguresOut }[]; unpricedItems: string[] } }[];
  };
  change_summary?: {
    changes: { type: string }[];
    changedTaskIds: string[];
    addedTaskIds: string[];
    removedTaskIds: string[];
    recomputedOutputs: string[];
    reusedOutputs: string[];
    economicDelta: { priceSource: string; scenario: string; breakEvenPriceInrPerKg?: { old: string | null; new: string | null; delta: string | null }; netCashReturnInrPerHa?: { old: string | null; new: string | null; delta: string | null } }[];
    oldAssumptions: { confirmedInputs: { key: string; value: { value: unknown; unit: string | null } }[] };
    newAssumptions: { confirmedInputs: { key: string; value: { value: unknown; unit: string | null } }[] };
  };
}

export interface PlanSnapshotView {
  id: string;
  parentId: string | null;
  parentContentHash: string | null;
  contentHash: string;
  farmId: string;
  cropId: string;
  productId: string;
  createdAt: string;
  decidedAt: string;
  mode: RuntimeMode;
  sourceSnapshotId: string;
  confirmedInputs: { key: string; value: { value: unknown; unit: string | null; evidenceState: EvidenceState } }[];
  assumptions: { id: string; description: string; value: { value: unknown; unit: string | null } | null; evidenceIds: string[] }[];
}

export interface PlanView {
  snapshot: PlanSnapshotView;
  outputs: { id: string; kind: string; output: unknown }[];
  lineage: { parentId: string | null; childIds: string[] };
  deduplicated: boolean;
}

export const outputsOf = (view: PlanView): PlanOutputs => Object.fromEntries(view.outputs.map((o) => [o.kind, o.output])) as PlanOutputs;

export interface VisualStage {
  stageId: string;
  name: string;
  order: number;
  state: "ready" | "failed" | "schematic" | "queued";
  label: string;
  asset: { assetId: string; qaWarning: string | null; contentPath: string | null; reason: string | null } | null;
}
export interface VisualsView {
  planId: string;
  generating: boolean;
  stages: VisualStage[];
}
export interface VisualsStart {
  jobId: string | null;
  state: string;
  cached: boolean;
  label?: string;
}
export interface JobView {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
  error?: { code?: string; message?: string } | null;
  result?: unknown;
}

export interface CreatePlanInput {
  farmId: string;
  cropId: string;
  productId: string;
  plantingDate: string;
  areaHa?: number;
  irrigationCategory?: "rainfed" | "supplemental" | "irrigated";
  assumedPriceInrPerKg?: number;
  scenarioId?: Scenario;
}

export interface Resolved<T> {
  data: T;
  mode: RuntimeMode;
  warnings: string[];
}
const warn = (w: unknown[]): string[] => w.map((x) => (typeof x === "string" ? x : ((x as { message?: string })?.message ?? JSON.stringify(x))));

async function get<T>(path: string): Promise<Resolved<T>> {
  const env = await apiRequest<T>(path);
  return { data: env.data as T, mode: env.mode, warnings: warn(env.warnings) };
}

export async function createPlan(input: CreatePlanInput, idempotencyKey = newEntryId("plan")): Promise<Resolved<PlanView>> {
  const env = await apiRequest<PlanView>("/api/v1/plans", jsonInit("POST", input, { "idempotency-key": idempotencyKey }));
  return { data: env.data as PlanView, mode: env.mode, warnings: warn(env.warnings) };
}
export const getPlan = (id: string) => get<PlanView>(`/api/v1/plans/${encodeURIComponent(id)}`);
export const getTimeline = (id: string, scenarioId: Scenario) => get<TimelineView>(`/api/v1/plans/${encodeURIComponent(id)}/timeline?scenarioId=${scenarioId}`);
export const getVisuals = (id: string) => get<VisualsView>(`/api/v1/plans/${encodeURIComponent(id)}/visuals`);
export const getJob = (id: string) => get<JobView>(`/api/v1/jobs/${encodeURIComponent(id)}`);
export async function listFarmMedia(farmId: string): Promise<MediaInfo[]> {
  return (await get<{ media: MediaInfo[] }>(`/api/v1/farms/${encodeURIComponent(farmId)}/media`)).data.media;
}
export async function startVisuals(planId: string, mediaId: string, regionVersion: number, idempotencyKey: string): Promise<Resolved<VisualsStart>> {
  const env = await apiRequest<VisualsStart>(`/api/v1/plans/${encodeURIComponent(planId)}/visuals`, jsonInit("POST", { mediaId, regionVersion }, { "idempotency-key": idempotencyKey }));
  return { data: env.data as VisualsStart, mode: env.mode, warnings: warn(env.warnings) };
}

/** Maps the server's per-stage visual states to SceneCanvas keyframes. A ready keyframe is served from the private content route. */
export function toKeyframes(v: VisualsView | null): SceneKeyframe[] {
  return (v?.stages ?? []).map((s) => ({
    stageId: s.stageId,
    url: s.state === "ready" && s.asset ? (s.asset.contentPath ?? `/api/v1/visuals/${s.asset.assetId}/content`) : null,
    state: s.state,
    label: s.label,
    qaWarning: s.asset?.qaWarning ?? null,
  }));
}
