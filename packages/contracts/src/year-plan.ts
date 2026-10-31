import {z} from 'zod';
import {ModelInvocation} from './common';
import {FarmWorkspace} from './workspace';

/**
 * Year plan contracts (Stream A). Three scored 12-month crop sequences for a field, editable and
 * re-scorable by code; Meta only selects among code-built candidates and writes short reasons.
 * Every number is a range with a basis. See docs/research/ROTATION_SCORING.md.
 */
const text = z.string().max(1000);
const isoDate = z.iso.date();
export const NumberRange = z.object({low: z.number(), high: z.number()}).strict();
export const DateWindow = z.object({from: isoDate, to: isoDate}).strict();
export const HarvestWindow = z.object({earliest: isoDate, latest: isoDate}).strict();

export const BasisRef = z.object({
 kind: z.enum(['price_history', 'yield_reference', 'cost_reference', 'sowing_window', 'duration', 'rotation', 'water', 'soil', 'ndvi', 'climatology', 'model']),
 label: z.string().max(200),
 sourceId: z.string().max(200).nullable(),
 url: z.url().nullable(),
 scope: z.string().max(120).nullable(),
 note: text.nullable(),
}).strict();

/** Component scores are 0..1; weights are fixed by the user (price 40, yield 30) and orchestrator (15/10/5). */
export const ScoreComponents = z.object({
 price: z.number().min(0).max(1),
 yield: z.number().min(0).max(1),
 soilRotation: z.number().min(0).max(1),
 water: z.number().min(0).max(1),
 confidence: z.number().min(0).max(1),
}).strict();
export const ScoreWeights = z.object({price: z.literal(40), yield: z.literal(30), soilRotation: z.literal(15), water: z.literal(10), confidence: z.literal(5)}).strict();

export const PriceEstimate = z.object({
 status: z.enum(['available', 'insufficient']),
 unit: z.literal('INR/kg'),
 p50: z.number().nullable(),
 range: NumberRange.nullable(),
 harvestWeek: z.string().max(10).nullable(),
 yearsUsed: z.array(z.number().int()),
 observations: z.number().int().nonnegative(),
 scope: z.object({level: z.enum(['market', 'district', 'state', 'national']), stateName: z.string().nullable(), districtName: z.string().nullable(), marketCount: z.number().int().nonnegative()}).strict(),
 reason: z.string().max(80).nullable(),
}).strict();

export const CostEstimate = z.object({
 a2flPerHa: z.number().nullable(),
 c2PerHa: z.number().nullable(),
 authority: z.enum(['cacp', 'des', 'sau', 'other']).nullable(),
 year: z.string().max(20).nullable(),
 region: z.string().max(40).nullable(),
}).strict();

export const StageTimeline = z.object({
 cropId: z.string(),
 productId: z.string().nullable(),
 establishmentMethod: z.string().nullable(),
 anchorDate: isoDate,
 stages: z.array(z.object({id: z.string(), name: z.string().max(80), from: isoDate, to: isoDate, basis: z.enum(['sourced', 'fao_generic', 'estimate'])}).strict()).max(12),
 harvest: HarvestWindow.nullable(),
 basis: BasisRef,
}).strict();

export const YearPlanSlot = z.object({
 slotId: z.string().max(120),
 cropId: z.string().max(120),
 productId: z.string().max(200),
 cropName: z.string().max(120),
 productName: z.string().max(120),
 establishmentMethod: z.string().max(80).nullable(),
 /** True for the farmer's current growing cycle (occupied-field scenario); never editable. */
 fixed: z.boolean(),
 sowing: isoDate,
 harvest: HarvestWindow,
 occupancy: DateWindow,
 durationDays: NumberRange,
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 price: PriceEstimate.nullable(),
 cost: CostEstimate.nullable(),
 revenuePerHa: NumberRange.nullable(),
 profitPerHa: NumberRange.nullable(),
 score: z.number().min(0).max(100),
 components: ScoreComponents,
 confidence: z.enum(['high', 'medium', 'low']),
 transitionNote: text.nullable(),
 reasonCodes: z.array(z.string().max(60)).max(8),
 uncertainties: z.array(text).max(10),
 basis: z.array(BasisRef).max(20),
}).strict();

export const YearPlanReason = z.object({code: z.string().max(60), text: z.string().max(160)}).strict();

export const YearPlanOption = z.object({
 optionId: z.string().max(120),
 label: z.string().max(60),
 origin: z.enum(['model', 'deterministic', 'farmer_edit']),
 score: z.number().min(0).max(100),
 components: ScoreComponents,
 slots: z.array(YearPlanSlot).min(1).max(6),
 idleMonths: z.number().min(0).max(12),
 reasons: z.array(YearPlanReason).max(3),
 totalRevenuePerHa: NumberRange.nullable(),
 totalProfitPerHa: NumberRange.nullable(),
 warnings: z.array(text).max(10),
 editable: z.boolean(),
}).strict();

export const YearPlanScenario = z.object({
 kind: z.enum(['occupied', 'fresh']),
 horizon: DateWindow,
 currentCycleId: z.string().nullable(),
 previousCropId: z.string().nullable(),
 fieldAreaHa: z.number().nullable(),
 irrigationCategory: z.string().max(80).nullable(),
 stateId: z.string().nullable(),
 districtId: z.string().nullable(),
 soilSummary: text.nullable(),
 neighbourhoodActiveMonths: z.array(z.number().int().min(1).max(12)).nullable(),
}).strict();

export const YearPlanReview = z.object({
 reviewId: z.uuid().nullable(),
 jobId: z.uuid().nullable(),
 contextHash: z.string().nullable(),
 status: z.enum(['pending', 'running', 'partial', 'ready', 'unavailable', 'error']),
 stale: z.boolean(),
 inputVersions: z.object({farm: z.number().int(), workspace: z.number().int()}).strict(),
 generatedAt: z.iso.datetime().nullable(),
 retryAfter: z.iso.datetime().nullable(),
 modelInvocation: ModelInvocation.nullable(),
 scenario: YearPlanScenario,
 weights: ScoreWeights,
 options: z.array(YearPlanOption).max(3),
 candidatesConsidered: z.number().int().nonnegative(),
 summary: text,
 limitations: z.array(text),
 appliedOptionIds: z.array(z.string()),
}).strict();

/** Farmer edit: same option with changed slots; code re-scores without a model call. */
export const RescoreYearPlan = z.object({
 reviewId: z.uuid(),
 optionId: z.string().max(120),
 slots: z.array(z.object({
  slotId: z.string().max(120).optional(),
  cropId: z.string().max(120),
  productId: z.string().max(200),
  establishmentMethod: z.string().max(80).optional(),
  sowing: isoDate,
  harvestLatest: isoDate.optional(),
 }).strict()).min(1).max(6),
}).strict();

export const ApplyYearPlan = z.object({
 reviewId: z.uuid(),
 optionId: z.string().max(120),
 slotIds: z.array(z.string().max(120)).max(6).optional(),
 expectedWorkspaceVersion: z.number().int().nonnegative(),
}).strict();
export const ApplyYearPlanResult = z.object({workspace: FarmWorkspace, review: YearPlanReview}).strict();

export type BasisRef = z.infer<typeof BasisRef>;
export type ScoreComponents = z.infer<typeof ScoreComponents>;
export type PriceEstimate = z.infer<typeof PriceEstimate>;
export type CostEstimate = z.infer<typeof CostEstimate>;
export type StageTimeline = z.infer<typeof StageTimeline>;
export type YearPlanSlot = z.infer<typeof YearPlanSlot>;
export type YearPlanOption = z.infer<typeof YearPlanOption>;
export type YearPlanScenario = z.infer<typeof YearPlanScenario>;
export type YearPlanReview = z.infer<typeof YearPlanReview>;
export type RescoreYearPlan = z.infer<typeof RescoreYearPlan>;
export type ApplyYearPlan = z.infer<typeof ApplyYearPlan>;
export type ApplyYearPlanResult = z.infer<typeof ApplyYearPlanResult>;
