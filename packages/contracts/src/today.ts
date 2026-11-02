import {z} from 'zod';
import {FarmAlert, FarmNewsReviewStatus} from './alerts';
import {NdviSeries} from './ndvi';
import {CareTask} from './command-center';
import {CropCycle} from './workspace';
import {StageTimeline, NumberRange, BasisRef, CostEstimate, HarvestWindow, NumberEstimate} from './year-plan';
import {ModelInvocation} from './common';

/**
 * Today view contract (Stream B). One stage slider drives the illustration and the satellite view;
 * price and weather tracks are indexed by date; alerts carry dated sources. See docs/research/TODAY_VIEW_SPEC.md.
 */
const text = z.string().max(1000);
const isoDate = z.iso.date();

export const SceneRef = z.object({
 date: isoDate,
 kind: z.enum(['observed', 'illustration']),
 itemId: z.string().max(200).nullable(),
 acquisitionDate: isoDate.nullable(),
 cloudPct: z.number().nullable(),
 /** Owner-private image path on this API (visual or ndvi), never a third-party URL. */
 imagePath: z.string().max(300).nullable(),
 ndviImagePath: z.string().max(300).nullable(),
 derivedFromItemId: z.string().max(200).nullable(),
 stageId: z.string().max(80).nullable(),
}).strict();

export const HealthReading = z.object({
 date: isoDate,
 ndviMean: z.number(),
 neighbourhoodMean: z.number().nullable(),
 typicalRange: NumberRange.nullable(),
 verdict: z.enum(['above_typical', 'near_typical', 'below_typical', 'no_reference']),
 clearFraction: z.number(),
 basis: BasisRef,
}).strict();

export const PricePoint = z.object({
 date: isoDate,
 kind: z.enum(['observed', 'reference']),
 p50: z.number().nullable(),
 range: NumberRange.nullable(),
 unit: z.literal('INR/kg'),
}).strict();

export const WeatherPoint = z.object({
 date: isoDate,
 kind: z.enum(['observed', 'forecast', 'typical', 'unavailable']),
 rainMm: z.number().nullable(),
 tMinC: z.number().nullable(),
 tMaxC: z.number().nullable(),
 basis: z.object({source: z.string().max(120), issuedAt: z.iso.datetime().nullable(), years: z.array(z.number().int()).nullable()}).strict(),
}).strict();

export const UpcomingStep = z.object({
 id: z.string().max(160),
 /** Round 2: 'stage_check' = sourced stage guidance dated from the stage timeline (ROUND2_SPEC.md 2.1). */
 kind: z.enum(['care_task', 'stage_transition', 'alert_step', 'stage_check']),
 title: z.string().max(160),
 detail: text.nullable(),
 dueFrom: isoDate,
 dueTo: isoDate,
 status: z.enum(['upcoming', 'due', 'overdue', 'completed']),
 careTask: CareTask.nullable(),
 alertId: z.uuid().nullable(),
}).strict();

export const OutlookNote = z.object({
 status: z.enum(['ready', 'pending', 'unavailable']),
 text: z.string().max(300).nullable(),
 /** Code facts the sentence was written from; every digit in text appears in one of them. */
 facts: z.array(z.string().max(200)).max(8),
 origin: z.enum(['model', 'deterministic']).nullable(),
 generatedAt: z.iso.datetime().nullable(),
 modelInvocation: ModelInvocation.nullable(),
}).strict();

/**
 * Code-only reading of the field's own NDVI curve (open-source comparison, 2026-11-01; method in
 * docs/research/INDEX_STAGE_READER.md). It is evidence shown next to the calendar stage estimate, never a verdict:
 * the stage timeline is not moved by it. Thresholds are either public (USGS NDVI bands, the MODIS MCD12Q2
 * amplitude fractions) or data-driven from the series' own noise; every remaining constant is a flagged assumption.
 */
export const IndexStagePhase = z.enum(['bare', 'green_up', 'rising', 'plateau', 'falling', 'harvested', 'unknown']);
export const IndexStageReading = z.object({
 status: z.enum(['available', 'insufficient', 'unavailable']),
 reason: z.string().max(120).nullable(),
 index: z.literal('ndvi'),
 /** Date of the latest usable field reading the phase was read from; null when none. */
 asOf: isoDate.nullable(),
 phase: IndexStagePhase,
 /** First date the smoothed curve rose above the green-up level of the current run (null when not seen). */
 greenUpDate: isoDate.nullable(),
 peakDate: isoDate.nullable(),
 peakValue: z.number().nullable(),
 troughDate: isoDate.nullable(),
 troughValue: z.number().nullable(),
 latestSmoothed: z.number().nullable(),
 /** Smoothed change over the last 15 days (positive = greening). */
 change15d: z.number().nullable(),
 /** Robust noise estimate of the series (used for the change threshold). */
 noise: z.number().nullable(),
 /** Change threshold the phase rules used. */
 changeThreshold: z.number().nullable(),
 readingsUsed: z.number().int().min(0),
 window: z.object({from: isoDate, to: isoDate}).strict().nullable(),
 /** The calendar stage the latest reading falls in, for the side-by-side comparison. */
 calendarStage: z.object({id: z.string(), name: z.string().max(80), from: isoDate, to: isoDate}).strict().nullable(),
 /** How the curve compares with the calendar estimate; 'consistent' is not a confirmation. */
 agreement: z.enum(['consistent', 'curve_earlier', 'curve_later', 'no_calendar', 'unknown']),
 /** One code-written sentence for the UI, digits only from the fields above. */
 summary: z.string().max(300),
 basis: BasisRef,
 limitations: z.array(z.string().max(400)).max(10),
}).strict();

/**
 * Today economics and footprint (2026-11-02, docs/research/TODAY_ECONOMICS_FOOTPRINT_SPEC.md). Four optional blocks on
 * the Today view for the growing crop: the expected profit at harvest, the residue (straw, stover, haulm) and what it
 * could earn, the energy used and held, and the greenhouse-gas footprint of the season on this field. Every number is
 * code arithmetic on cited regional references times the field area; nothing is a measurement of this field, a forecast
 * or a guaranteed sale. Residue options are alternatives for the same residue and are never added together.
 */
const reason = z.string().max(120).nullable();
const sourceIds = z.array(z.string().max(80)).max(8);
const limitations = z.array(text).max(12);
const basisList = z.array(BasisRef).max(14);

export const HarvestEconomics = z.object({
 /** available: yield, price and cost all sourced; partial: revenue without a cost, or yield from a single year; unavailable: nothing to show (see reason). */
 status: z.enum(['available', 'partial', 'unavailable']),
 reason,
 harvest: HarvestWindow.nullable(),
 /** The harvest date the price is for (the window midpoint, the same date as harvestPrice). */
 harvestDate: isoDate.nullable(),
 fieldAreaHa: z.number().nullable(),
 /** Regional yield of the product's own form, kg/ha, likely band (p25 to p75) or a single-year reference without spread. */
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 yieldForFieldKg: NumberRange.nullable(),
 /** 1 minus the sourced post-harvest loss share; 1 when none is sourced. */
 keepFraction: z.number().min(0).max(1),
 price: z.object({status: z.enum(['available', 'insufficient']), unit: z.literal('INR/kg'), p50: z.number().nullable(), likely: NumberRange.nullable(), scopeLabel: z.string().max(160)}).strict().nullable(),
 cost: CostEstimate.nullable(),
 revenuePerHa: NumberEstimate.nullable(),
 revenueForField: NumberEstimate.nullable(),
 profitPerHa: NumberEstimate.nullable(),
 profitForField: NumberEstimate.nullable(),
 basis: basisList,
 limitations,
}).strict();

export const ResidueUse = z.enum(['cbg_feedstock', 'dry_fodder', 'biomass_fuel', 'mushroom_substrate', 'soil_incorporation', 'other']);
export const ResidueOption = z.object({
 use: ResidueUse,
 label: z.string().max(80),
 /** Dry-matter residue this use could take from the field, kg (the surplus, or the sourced share of it). */
 quantityKg: NumberRange,
 /** Reported farm-gate or plant-gate price, INR per tonne as reported (moisture basis in priceBasis); null when none is sourced. */
 priceInrPerTonne: NumberRange.nullable(),
 /** Where, when and on what basis the price was reported. */
 priceBasis: z.string().max(240).nullable(),
 incomeForField: NumberRange.nullable(),
 note: text.nullable(),
 sourceIds,
}).strict();
export const ResidueIncome = z.object({
 status: z.enum(['available', 'unavailable']),
 reason,
 /** The residue's name for the UI ("paddy straw", "maize stover", "groundnut haulm"). */
 residueName: z.string().max(80).nullable(),
 /** Published residue-to-product ratio, kg dry residue per kg product. */
 residueToProductRatio: NumberRange.nullable(),
 residueForFieldKg: NumberRange.nullable(),
 /** Published share of the residue that is surplus after on-farm uses; null when the whole residue is shown (flagged). */
 surplusFraction: NumberRange.nullable(),
 surplusForFieldKg: NumberRange.nullable(),
 /** Alternatives for the same residue; incomes are not additive. */
 options: z.array(ResidueOption).max(6),
 basis: basisList,
 limitations,
}).strict();

export const EnergyEquivalent = z.object({label: z.string().max(80), amount: NumberRange, unit: z.string().max(30), sourceIds}).strict();
export const EnergyFootprint = z.object({
 status: z.enum(['available', 'partial', 'unavailable']),
 reason,
 /** Energy used to grow the crop (fuel, electricity, fertiliser, seed, labour as published), GJ per hectare, from a cited study. */
 inputEnergyGJPerHa: NumberRange.nullable(),
 inputEnergyGJForField: NumberRange.nullable(),
 /** Where the input energy figure comes from (study, region, year). */
 inputEnergyBasis: z.string().max(240).nullable(),
 /** Share of the input energy by item when the study prints it (shares sum to at most 1). */
 inputBreakdown: z.array(z.object({item: z.string().max(60), share: z.number().min(0).max(1)}).strict()).max(10),
 /** Gross calorific value of the dry residue, MJ/kg. */
 calorificValueMJPerKg: NumberRange.nullable(),
 /** Energy held in the surplus residue of the field, GJ (surplus kg times calorific value). */
 residueEnergyGJForField: NumberRange.nullable(),
 /** Code arithmetic on cited constants: the same residue energy as LPG cylinders, diesel litres, or compressed biogas kg. */
 equivalents: z.array(EnergyEquivalent).max(4),
 basis: basisList,
 limitations,
}).strict();

export const CarbonSource = z.enum(['rice_methane', 'fertiliser_n2o', 'fertiliser_manufacture', 'fuel_and_machinery', 'residue_burning', 'residue_carbon', 'other']);
export const CarbonTerm = z.object({
 source: CarbonSource,
 label: z.string().max(80),
 /** Positive = emitted; negative = carbon the residue holds (informational, not credited in any net); tCO2e for the field this season (null when the field area is unknown). */
 tCO2eForField: NumberRange.nullable(),
 tCO2ePerHa: NumberRange,
 /** One code-written line naming the factor, the activity figure and the arithmetic. */
 method: z.string().max(400),
 /** baseline terms sum into emissionsForField; scenario terms depend on what is done with the residue. */
 kind: z.enum(['baseline', 'scenario']),
 sourceIds,
}).strict();
export const ResidueScenario = z.object({
 id: z.enum(['burn', 'incorporate', 'sell_cbg', 'sell_fodder']),
 label: z.string().max(80),
 /** Baseline emissions plus this scenario's residue term, tCO2e for the field. */
 netForField: NumberRange,
 note: text,
}).strict();
export const PoolComparison = z.object({
 /** Rank of the growing crop among the pool crops with a footprint figure (1 = lowest emissions per hectare). */
 rank: z.number().int().min(1),
 of: z.number().int().min(1),
 lowest: z.object({cropId: z.string().max(120), cropName: z.string().max(120), tCO2eForField: NumberRange}).strict().nullable(),
 highest: z.object({cropId: z.string().max(120), cropName: z.string().max(120), tCO2eForField: NumberRange}).strict().nullable(),
}).strict();
export const CarbonFootprint = z.object({
 status: z.enum(['available', 'partial', 'unavailable']),
 reason,
 fieldAreaHa: z.number().nullable(),
 /** Season length the per-day factors were applied over (establishment to the earliest harvest date), days. */
 seasonDays: z.number().int().min(0).nullable(),
 /** Sum of the baseline terms, tCO2e for the field this season (low and high). */
 emissionsForField: NumberRange.nullable(),
 emissionsPerHa: NumberRange.nullable(),
 terms: z.array(CarbonTerm).max(10),
 residueScenarios: z.array(ResidueScenario).max(4),
 comparison: PoolComparison.nullable(),
 /** Global warming potentials used (100-year), with their source. */
 gwp: z.object({ch4: z.number(), n2o: z.number(), basis: z.string().max(160)}).strict().nullable(),
 /** One code-written sentence for the card; every digit in it appears in the fields above. */
 summary: z.string().max(300),
 basis: basisList,
 limitations,
}).strict();

/**
 * Today overview (2026-11-02, TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 9): what today's facts mean for the farmer and what
 * to do, in at most five points. Code builds the facts (each with an id and, where it has one, the step, alert or card it
 * refers to); Meta muse-spark writes the headline and points from those facts under a strict schema, naming the fact ids
 * each point rests on; code resolves the refs from the fact ids and gates every number. A code-written version is always
 * available: it is returned inline in synthetic and replay modes, and while the model job is pending.
 */
export const OverviewPointKind = z.enum(['do_now', 'watch', 'money', 'later', 'good_news']);
export const OverviewRef = z.object({
 kind: z.enum(['step', 'alert', 'card']),
 /** UpcomingStep.id, FarmAlert.id, or a card kind (harvest, price, weather, health, profit, residue, energy, carbon). */
 id: z.string().max(160),
}).strict();
export const OverviewFact = z.object({id: z.string().max(40), text: z.string().max(240), ref: OverviewRef.nullable()}).strict();
export const OverviewPoint = z.object({
 kind: OverviewPointKind,
 /** What it means for the farmer and what to do, in plain words; every number comes from the cited facts. */
 text: z.string().max(240),
 factIds: z.array(z.string().max(40)).max(6),
 /** The first cited fact's ref, so the UI can jump to the step, alert or card. */
 ref: OverviewRef.nullable(),
}).strict();
export const TodayOverview = z.object({
 /** ready: shown as final; pending: the code-written version is shown while the model job runs; unavailable: nothing to show. */
 status: z.enum(['ready', 'pending', 'unavailable']),
 headline: z.string().max(160).nullable(),
 points: z.array(OverviewPoint).max(5),
 facts: z.array(OverviewFact).max(16),
 origin: z.enum(['model', 'deterministic']).nullable(),
 generatedAt: z.iso.datetime().nullable(),
 modelInvocation: ModelInvocation.nullable(),
}).strict();

export const TodayView = z.object({
 farmId: z.uuid(),
 asOf: z.iso.datetime(),
 today: isoDate,
 cycle: CropCycle.nullable(),
 product: z.object({productId: z.string(), productName: z.string(), cropName: z.string()}).nullable(),
 timeline: StageTimeline.nullable(),
 slider: z.object({from: isoDate, to: isoDate, todayProgress: z.number().min(0).max(1)}).strict().nullable(),
 daysToHarvest: z.object({earliest: z.number().int(), latest: z.number().int()}).strict().nullable(),
 scenes: z.array(SceneRef).max(120),
 ndvi: NdviSeries.nullable(),
 health: HealthReading.nullable(),
 priceTrack: z.array(PricePoint).max(400),
 harvestPrice: z.object({p50: z.number().nullable(), range: NumberRange.nullable(), status: z.enum(['available', 'insufficient']), reason: z.string().max(80).nullable(), scopeLabel: z.string().max(160)}).strict().nullable(),
 weatherTrack: z.array(WeatherPoint).max(400),
 alerts: z.array(FarmAlert).max(50),
 newsReview: FarmNewsReviewStatus.nullable(),
 imdStatus: z.literal('not_connected'),
 upcoming: z.array(UpcomingStep).max(30),
 /** Round 2: the one step to do next (overdue, then due, then upcoming), shown bold above the list. */
 nextAction: UpcomingStep.nullable().optional(),
 /** Round 2: harvest price outlook in words, written by Meta from code facts (ROUND2_SPEC.md 2.2). */
 outlookNote: OutlookNote.nullable().optional(),
 /** Open-source comparison (2026-11-01): the field's own NDVI curve read by code, shown beside the calendar stage. */
 indexStage: IndexStageReading.nullable().optional(),
 /** 2026-11-02 (TODAY_ECONOMICS_FOOTPRINT_SPEC.md): expected profit at harvest, residue income, energy and carbon for the growing crop. */
 harvestEconomics: HarvestEconomics.nullable().optional(),
 residueIncome: ResidueIncome.nullable().optional(),
 energyFootprint: EnergyFootprint.nullable().optional(),
 carbonFootprint: CarbonFootprint.nullable().optional(),
 /** 2026-11-02 (spec section 9): the AI overview of today, written from code facts. */
 overview: TodayOverview.nullable().optional(),
 monitoring: z.object({enabled: z.boolean(), lastCheckedAt: z.iso.datetime().nullable(), nextCheckAt: z.iso.datetime().nullable()}).strict(),
 limitations: z.array(text),
}).strict();

export type SceneRef = z.infer<typeof SceneRef>;
export type HealthReading = z.infer<typeof HealthReading>;
export type PricePoint = z.infer<typeof PricePoint>;
export type WeatherPoint = z.infer<typeof WeatherPoint>;
export type UpcomingStep = z.infer<typeof UpcomingStep>;
export type OutlookNote = z.infer<typeof OutlookNote>;
export type IndexStagePhase = z.infer<typeof IndexStagePhase>;
export type IndexStageReading = z.infer<typeof IndexStageReading>;
export type HarvestEconomics = z.infer<typeof HarvestEconomics>;
export type ResidueUse = z.infer<typeof ResidueUse>;
export type ResidueOption = z.infer<typeof ResidueOption>;
export type ResidueIncome = z.infer<typeof ResidueIncome>;
export type EnergyEquivalent = z.infer<typeof EnergyEquivalent>;
export type EnergyFootprint = z.infer<typeof EnergyFootprint>;
export type CarbonSource = z.infer<typeof CarbonSource>;
export type CarbonTerm = z.infer<typeof CarbonTerm>;
export type ResidueScenario = z.infer<typeof ResidueScenario>;
export type PoolComparison = z.infer<typeof PoolComparison>;
export type CarbonFootprint = z.infer<typeof CarbonFootprint>;
export type OverviewPointKind = z.infer<typeof OverviewPointKind>;
export type OverviewRef = z.infer<typeof OverviewRef>;
export type OverviewFact = z.infer<typeof OverviewFact>;
export type OverviewPoint = z.infer<typeof OverviewPoint>;
export type TodayOverview = z.infer<typeof TodayOverview>;
export type TodayView = z.infer<typeof TodayView>;
