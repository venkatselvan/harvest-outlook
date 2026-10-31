import {z} from 'zod';
import {FarmAlert, FarmNewsReviewStatus} from './alerts';
import {NdviSeries} from './ndvi';
import {CareTask} from './command-center';
import {CropCycle} from './workspace';
import {StageTimeline, NumberRange, BasisRef} from './year-plan';

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
 kind: z.enum(['care_task', 'stage_transition', 'alert_step']),
 title: z.string().max(160),
 detail: text.nullable(),
 dueFrom: isoDate,
 dueTo: isoDate,
 status: z.enum(['upcoming', 'due', 'overdue', 'completed']),
 careTask: CareTask.nullable(),
 alertId: z.uuid().nullable(),
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
 monitoring: z.object({enabled: z.boolean(), lastCheckedAt: z.iso.datetime().nullable(), nextCheckAt: z.iso.datetime().nullable()}).strict(),
 limitations: z.array(text),
}).strict();

export type SceneRef = z.infer<typeof SceneRef>;
export type HealthReading = z.infer<typeof HealthReading>;
export type PricePoint = z.infer<typeof PricePoint>;
export type WeatherPoint = z.infer<typeof WeatherPoint>;
export type UpcomingStep = z.infer<typeof UpcomingStep>;
export type TodayView = z.infer<typeof TodayView>;
