import {z} from 'zod';
import {FarmAlert, FarmNewsReviewStatus} from './alerts';
import {NdviSeries} from './ndvi';
import {CareTask} from './command-center';
import {CropCycle} from './workspace';
import {StageTimeline, NumberRange, BasisRef} from './year-plan';
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
export type TodayView = z.infer<typeof TodayView>;
