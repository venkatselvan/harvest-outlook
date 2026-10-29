import { z } from "zod";
import {
  Assumption,
  CostLine,
  DateRange,
  EconomicsInput,
  EffectiveRainMethod,
  Id,
  IrrigationCategory,
  IsoDate,
  IsoDateTime,
  NamedInput,
  ProductBasis,
  ReasonCode,
  ScenarioName,
  SchemaVersion,
  StageDefinition,
  ValueRecord,
  VersionRef,
  WaterBalanceInput,
} from "@harvest/contracts";

/**
 * Plan engine input/output types (T08). Contracts from @harvest/contracts are
 * reused; the types defined here are engine-local and versioned by
 * PLAN_ENGINE_VERSION. Promote to @harvest/contracts if another package needs them.
 */
export const PLAN_ENGINE_VERSION = "plan-engine/1";
export const STAGE_METHOD_VERSION = "stage-windows/1";
export const TASK_METHOD_VERSION = "task-templates/1";
export const HARVEST_METHOD_VERSION = "harvest-windows/1";
export const OUTLOOK_METHOD_VERSION = "market-outlook-binding/1";
export const TIMELINE_METHOD_VERSION = "timeline/1";

/** Well-known confirmedInputs keys interpreted by the engine. Other keys are carried through untouched. */
export const INPUT_KEYS = {
  plantingDate: "planting_date",
  area: "area",
  irrigationCategory: "irrigation_category",
  assumedPrice: "assumed_price",
  observedStage: "observed_stage",
} as const;

/**
 * Task template. Window = stage window (by anchor) shifted by the offsets. The
 * offsets come from a rule (offsetBasis.kind 'rule') or from a named assumption
 * listed in the snapshot (offsetBasis.kind 'assumption'); never from free text.
 */
export const TaskTemplate = z
  .object({
    id: Id,
    stageId: Id,
    taskType: z.enum(["prepare_land", "plant", "irrigate", "scout", "weed", "nutrient", "protect", "harvest", "sell", "record_observation", "other"]),
    description: z.string().min(1).max(500),
    anchor: z.enum(["stage_start", "stage_end", "stage_span"]),
    startOffsetDays: z.number().int().min(-365).max(365),
    endOffsetDays: z.number().int().min(-365).max(365),
    offsetBasis: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rule"), ruleId: Id, ruleVersion: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal("assumption"), assumptionId: Id }).strict(),
    ]),
    reasonCode: ReasonCode,
    evidenceIds: z.array(Id),
    /** Template ids this task depends on (same occurrence when both repeat, else occurrence 1). */
    dependsOn: z.array(Id),
    /** Empty = applies to every irrigation category. */
    irrigation: z.array(IrrigationCategory),
    /** Only with sourced evidence or a derived calculation (ActionTask refinement enforces this). */
    amount: ValueRecord.nullable(),
    /** Rain-conditioned task: flagged on dates where observed/forecast daily rain >= the named threshold assumption. */
    trigger: z.object({ type: z.literal("daily_rain_gte"), thresholdAssumptionId: Id }).strict().nullable(),
  })
  .strict();
export type TaskTemplate = z.infer<typeof TaskTemplate>;

const ec = EconomicsInput.shape;
const wb = WaterBalanceInput.shape;

export const WaterParameters = z
  .object({
    kcByStage: z.array(z.object({ stageId: Id, kc: z.number().min(0).max(2), kcSource: z.string().min(1) }).strict()),
    rootZone: wb.rootZone,
    effectiveRain: EffectiveRainMethod,
    forecastRainPolicy: wb.forecastRainPolicy,
    irrigationEfficiency: wb.irrigationEfficiency,
    tawScenariosMm: wb.tawScenariosMm,
  })
  .strict();
export type WaterParameters = z.infer<typeof WaterParameters>;

export const EconomicsParameters = z
  .object({
    marketIds: z.array(Id),
    /** Product basis of prices for this productId (e.g. fresh, dry). */
    priceProductBasis: ProductBasis,
    yield: ec.yield,
    marketableFraction: ec.marketableFraction,
    /** Shares per harvest occurrence; null = equal shares (recorded as a named assumption). */
    harvestShares: z.array(z.number().min(0).max(1)).nullable(),
    conversion: ec.conversion,
    costs: ec.costs,
    unpricedItems: ec.unpricedItems,
  })
  .strict();
export type EconomicsParameters = z.infer<typeof EconomicsParameters>;

export const PlanParameters = z
  .object({
    schemaVersion: SchemaVersion,
    taskTemplateSet: VersionRef,
    taskTemplates: z.array(TaskTemplate).max(200),
    water: WaterParameters.nullable(),
    economics: EconomicsParameters.nullable(),
  })
  .strict();
export type PlanParameters = z.infer<typeof PlanParameters>;

export type StageTiming = "early" | "late";
export const StageTiming = z.enum(["early", "late"]);

export const ScenarioSelection = z
  .object({ stageTiming: StageTiming, economicsScenario: ScenarioName })
  .strict();
export type ScenarioSelection = z.infer<typeof ScenarioSelection>;

/** Typed, user-confirmed revision changes (PRD 9.3). */
export const PlanChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("planting_date"), date: IsoDate }).strict(),
  z.object({ type: z.literal("area"), amount: z.number().positive(), unit: z.enum(["ha", "acre"]) }).strict(),
  z.object({ type: z.literal("irrigation_category"), category: IrrigationCategory }).strict(),
  z
    .object({ type: z.literal("observed_stage"), stageId: Id, observedOn: IsoDate, journalEntryId: Id.nullable(), basis: z.enum(["observed", "farmer_reported"]) })
    .strict(),
  z
    .object({ type: z.literal("cost_override"), line: z.enum(["cashProduction", "harvest", "saleAndTransport"]), cost: CostLine.nullable() })
    .strict(),
  z
    .object({
      type: z.literal("assumed_price"),
      /** Farmer-stated price or range; null removes it. Central = midpoint (named assumption) when low != high. */
      price: z
        .object({ unit: z.enum(["INR/kg", "INR/quintal"]), low: z.number().nonnegative(), high: z.number().nonnegative() })
        .strict()
        .refine((p) => p.low <= p.high, { message: "low must be <= high" })
        .nullable(),
    })
    .strict(),
  z.object({ type: z.literal("scenario_selection"), selection: ScenarioSelection }).strict(),
]);
export type PlanChange = z.infer<typeof PlanChange>;

export interface CreatePlanArgs {
  ownerId: string;
  farmId: string;
  cropId: string;
  productId: string;
  mode: "live" | "replay" | "synthetic";
  confirmedInputs: z.input<typeof NamedInput>[];
  assumptions: z.input<typeof Assumption>[];
  ruleVersions: z.input<typeof VersionRef>[];
  stageDefinitions: z.input<typeof StageDefinition>[];
  parameters: z.input<typeof PlanParameters>;
  sourceSnapshotId: string;
  /** Required in replay mode; forbidden otherwise. */
  decisionCutoff?: string | null;
}

export interface RevisePlanArgs {
  ownerId: string;
  planId: string;
  expectedParentContentHash: string;
  changes: z.input<typeof PlanChange>[];
}

export const OUTPUT_KINDS = ["inputs", "stage_windows", "harvest_windows", "tasks", "water", "market_outlook", "economics", "change_summary"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const TimelineQuery = z
  .object({ from: IsoDate.optional(), to: IsoDate.optional(), scenarioId: StageTiming.optional() })
  .strict();

export { DateRange, IsoDate, IsoDateTime };
