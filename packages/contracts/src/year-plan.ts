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
/**
 * Round 2 (ROUND2_SPEC.md 1.2): an estimate with a central value, the likely band (middle half of simulated outcomes,
 * p25 to p75) and the possible band (p10 to p90). Produced by apps/api/src/services/estimate.ts.
 */
export const NumberEstimate = z.object({central: z.number(), likely: NumberRange, possible: NumberRange}).strict();
/** An idle gap on the calendar with the code-written reason (ROUND2_SPEC.md 1.2 item 3). */
export const YearPlanGap = z.object({from: isoDate, to: isoDate, days: z.number().int().nonnegative(), reason: z.string().max(300)}).strict();
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

/**
 * Saved-season follow-up (2026-11-01, docs/research/YEAR_PLAN_SAVED_SEASONS.md): a saved season or recorded crop that
 * takes months of this horizon. Every option shares them: the calendar draws them in each row as "Saved season" strips
 * and the option sheet lets the farmer swap a saved season's crop with the same picker as a suggested slot (the swap
 * edits the saved season on the field; the plan is then rebuilt by code). 'assumed_plan' is the previous year's unsaved
 * plan a future horizon follows; it is drawn lighter and cannot be swapped.
 */
export const YearPlanOccupant = z.object({
 /** The saved season's or cycle's own id (so the UI can edit it); 'assumed:<reviewId>' for an assumed plan. */
 id: z.string().max(160),
 source: z.enum(['saved_season', 'recorded_cycle', 'assumed_plan']),
 /** The real crop id (an intercrop's main crop), never the engine's rotation token. */
 cropId: z.string().max(120),
 productId: z.string().max(200).nullable(),
 cropName: z.string().max(120),
 productName: z.string().max(120).nullable(),
 kind: z.enum(['crop', 'green_manure', 'intercrop']),
 companion: z.object({systemId: z.string().max(120).nullable(), cropId: z.string().max(120), cropName: z.string().max(120), rowRatio: z.string().max(20)}).strict().nullable(),
 establishmentMethod: z.string().max(80).nullable(),
 /** Planned sowing (saved season) or recorded sowing (cycle). */
 sowing: isoDate,
 /** The farmer's planned or recorded harvest date; null when the occupancy end comes from the crop's duration. */
 harvestDate: isoDate.nullable(),
 /** The months the engine treats as taken, in full (not clipped to the horizon). */
 occupancy: DateWindow,
 occupancyBasis: z.enum(['recorded', 'planned', 'sourced_duration', 'assumed_duration']),
 note: text.nullable(),
}).strict();

/**
 * How the plans on screen were chosen (same follow-up). 'model': Meta chose among the code-scored sequences.
 * 'not_needed': fewer than three distinct sequences fit, so code showed what fits and no model call was made.
 * 'not_configured' / 'not_used': no model key, or a runtime mode that never calls Meta. 'cancelled': the requesting
 * session ended first. 'failed': the call was made and failed or was rejected by the checks (`detail` = failure code).
 * Absent on plans stored before this field existed; the UI then falls back to the option origins.
 */
export const YearPlanSelection = z.object({
 outcome: z.enum(['model', 'not_needed', 'not_configured', 'not_used', 'cancelled', 'failed']),
 detail: z.string().max(200).nullable(),
}).strict();

/**
 * Round 3 (ROUND3_SPEC.md section 6): the companion crop of an intercrop slot. Yield shares are fractions of the
 * sole-crop regional yield (sourced per system, or the flagged research fallback); the slot's main crop keeps its own
 * yield, price and cost fields and the combined revenue goes into the slot estimates.
 */
export const IntercropCompanion = z.object({
 systemId: z.string().max(120),
 cropId: z.string().max(120),
 productId: z.string().max(200),
 cropName: z.string().max(120),
 productName: z.string().max(120),
 /** Main rows to companion rows, e.g. "4:1". */
 rowRatio: z.string().max(20),
 arrangement: z.enum(['row', 'paired_row', 'strip', 'mixed']).nullable(),
 yieldShare: z.object({main: NumberRange, companion: NumberRange}).strict(),
 shareBasis: z.enum(['sourced', 'assumed']),
 /** Sole-crop regional yield of the companion, kg/ha, before the share. */
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 price: PriceEstimate.nullable(),
 nitrogenCreditKgPerHa: NumberRange.nullable(),
 /** The companion's cost share deducted in the slot economics, INR/ha (sole-crop A2+FL times the seed-rate or row share); null when not sourced. */
 costPerHa: z.number().nullable().optional(),
 source: z.object({id: z.string().max(80), title: z.string().max(200), url: z.url().nullable(), locator: z.string().max(200).nullable()}).strict().nullable(),
}).strict();

export const YearPlanSlot = z.object({
 slotId: z.string().max(120),
 cropId: z.string().max(120),
 productId: z.string().max(200),
 cropName: z.string().max(120),
 productName: z.string().max(120),
 establishmentMethod: z.string().max(80).nullable(),
 /**
  * Round 2: 'green_manure' slots are grown and ploughed in (no product, no price, revenue 0). Round 3: 'intercrop' slots
  * carry a main crop (these fields) and a companion (`companion`). Absent = 'crop'.
  */
 kind: z.enum(['crop', 'green_manure', 'intercrop']).optional(),
 companion: IntercropCompanion.nullable().optional(),
 /** Nitrogen a legume or green manure leaves for the next crop, kg/ha (sourced range), for display. */
 nitrogenCreditKgPerHa: NumberRange.nullable().optional(),
 /** True for the farmer's current growing cycle (occupied-field scenario); never editable. */
 fixed: z.boolean(),
 sowing: isoDate,
 harvest: HarvestWindow,
 occupancy: DateWindow,
 durationDays: NumberRange,
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 /** Round 3: yieldKgPerHa times the field area (main crop share-adjusted for an intercrop); null when the area is unknown. */
 yieldForFieldKg: NumberRange.nullable().optional(),
 price: PriceEstimate.nullable(),
 cost: CostEstimate.nullable(),
 /** Round 2: revenuePerHa and profitPerHa carry the likely band (p25 to p75); the estimates below add central and possible. */
 revenuePerHa: NumberRange.nullable(),
 profitPerHa: NumberRange.nullable(),
 revenueEstimate: NumberEstimate.nullable().optional(),
 profitEstimate: NumberEstimate.nullable().optional(),
 /** profitEstimate times the field area in hectares; null when the area is unknown. */
 profitForField: NumberEstimate.nullable().optional(),
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
 /** Round 3: further labels code established for this plan (for example "Best profit" on a plan Meta labelled otherwise). */
 secondaryLabels: z.array(z.string().max(60)).max(3).optional(),
 origin: z.enum(['model', 'deterministic', 'farmer_edit']),
 score: z.number().min(0).max(100),
 components: ScoreComponents,
 slots: z.array(YearPlanSlot).min(1).max(6),
 idleMonths: z.number().min(0).max(12),
 /** Round 3: the idle penalty deducted from the score, in score points (0..100), so the UI can show it beside the component bars. */
 idlePenaltyPoints: z.number().min(0).max(100).optional(),
 reasons: z.array(YearPlanReason).max(3),
 totalRevenuePerHa: NumberRange.nullable(),
 totalProfitPerHa: NumberRange.nullable(),
 /** Round 2 (ROUND2_SPEC.md 1.2): simulated totals, per hectare and for the field; fieldAreaHa from the boundary. */
 totalRevenueEstimate: NumberEstimate.nullable().optional(),
 totalProfitEstimate: NumberEstimate.nullable().optional(),
 totalProfitForField: NumberEstimate.nullable().optional(),
 fieldAreaHa: z.number().nullable().optional(),
 /** Idle gaps of 21 days or more with their reasons. */
 gaps: z.array(YearPlanGap).max(6).optional(),
 warnings: z.array(text).max(10),
 editable: z.boolean(),
}).strict();

export const YearPlanScenario = z.object({
 /** Round 3: 'future' is a later 12-month horizon (ROUND3_SPEC.md section 1) that starts after the current one. */
 kind: z.enum(['occupied', 'fresh', 'future']),
 horizon: DateWindow,
 /** 0 for the current horizon, 1..3 for later ones (12 months each). */
 yearIndex: z.number().int().min(0).max(3).optional(),
 currentCycleId: z.string().nullable(),
 previousCropId: z.string().nullable(),
 /** Round 3: where the previous crop of a future horizon comes from, so the UI can say "follows the Best overall plan for Oct 2026 to Oct 2027 (not saved yet)". */
 assumedPredecessor: z.object({
  cropId: z.string().max(120),
  cropName: z.string().max(120),
  basis: z.enum(['current_cycle', 'saved_season', 'previous_harvest', 'year_plan_option']),
  optionLabel: z.string().max(60).nullable(),
  horizonFrom: isoDate.nullable(),
 }).strict().nullable().optional(),
 fieldAreaHa: z.number().nullable(),
 irrigationCategory: z.string().max(80).nullable(),
 stateId: z.string().nullable(),
 districtId: z.string().nullable(),
 soilSummary: text.nullable(),
 neighbourhoodActiveMonths: z.array(z.number().int().min(1).max(12)).nullable(),
 /** Saved seasons, other recorded crops and an assumed plan that take months of this horizon, in sowing order (the current growing cycle is the fixed slot, not listed here). */
 occupied: z.array(YearPlanOccupant).max(24).optional(),
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
 /** Round 2: up to four options (the fourth is 'Green manure first'). Round 3: up to five ('Best profit' is added when no chosen plan holds it). */
 options: z.array(YearPlanOption).max(5),
 /** Round 3: horizon paging (ROUND3_SPEC.md section 1); absent on servers that only serve the current horizon. */
 navigation: z.object({from: isoDate, previousFrom: isoDate.nullable(), nextFrom: isoDate.nullable(), yearIndex: z.number().int().min(0).max(3), maxYearIndex: z.number().int().min(0).max(3)}).strict().optional(),
 /** How the options were chosen (see YearPlanSelection); null while pending, absent on older stored plans. */
 modelSelection: YearPlanSelection.nullable().optional(),
 /** True when the growing crop and the occupants leave no window in this horizon where any sourced crop fits: the options then hold the growing crop alone, or nothing (status 'unavailable'). */
 noFreeWindow: z.boolean().optional(),
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
  /** Round 2: a farmer may insert a green manure slot (cropId from green-manure.json, productId = cropId). Round 3: an intercrop slot names its system (intercropping.json id); cropId/productId are the main crop's. */
  kind: z.enum(['crop', 'green_manure', 'intercrop']).optional(),
  systemId: z.string().max(120).optional(),
  sowing: isoDate,
  harvestLatest: isoDate.optional(),
 }).strict()).min(1).max(6),
}).strict();

/** Round 3: GET /year-plan?from= and POST body `from` select a later 12-month horizon (ROUND3_SPEC.md section 1). */
export const YearPlanHorizonQuery = z.object({from: isoDate.optional()}).strict();

export const ApplyYearPlan = z.object({
 reviewId: z.uuid(),
 optionId: z.string().max(120),
 slotIds: z.array(z.string().max(120)).max(6).optional(),
 expectedWorkspaceVersion: z.number().int().nonnegative(),
}).strict();
export const ApplyYearPlanResult = z.object({workspace: FarmWorkspace, review: YearPlanReview}).strict();

export type NumberRange = z.infer<typeof NumberRange>;
export type NumberEstimate = z.infer<typeof NumberEstimate>;
export type YearPlanGap = z.infer<typeof YearPlanGap>;
export type BasisRef = z.infer<typeof BasisRef>;
export type ScoreComponents = z.infer<typeof ScoreComponents>;
export type PriceEstimate = z.infer<typeof PriceEstimate>;
export type CostEstimate = z.infer<typeof CostEstimate>;
export type StageTimeline = z.infer<typeof StageTimeline>;
export type IntercropCompanion = z.infer<typeof IntercropCompanion>;
export type YearPlanOccupant = z.infer<typeof YearPlanOccupant>;
export type YearPlanSelection = z.infer<typeof YearPlanSelection>;
export type YearPlanHorizonQuery = z.infer<typeof YearPlanHorizonQuery>;
export type YearPlanSlot = z.infer<typeof YearPlanSlot>;
export type YearPlanOption = z.infer<typeof YearPlanOption>;
export type YearPlanScenario = z.infer<typeof YearPlanScenario>;
export type YearPlanReview = z.infer<typeof YearPlanReview>;
export type RescoreYearPlan = z.infer<typeof RescoreYearPlan>;
export type ApplyYearPlan = z.infer<typeof ApplyYearPlan>;
export type ApplyYearPlanResult = z.infer<typeof ApplyYearPlanResult>;
