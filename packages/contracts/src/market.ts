import {z} from 'zod';
import {NumberRange} from './year-plan';
import {FarmAlertSeverity, FarmAlertType} from './alerts';

/**
 * Market timeline (ROUND2_SPEC.md section 3): one weekly timeline per product from 36 months back to 12 months ahead
 * with price, weather and events in sync, plus "years with similar rain" as a selection of history, never a forecast.
 */
const isoDate = z.iso.date();
const text = z.string().max(600);

export const MarketPricePoint = z.discriminatedUnion('kind', [
 z.object({kind: z.literal('observed'), p50: z.number(), min: z.number(), max: z.number(), n: z.number().int().nonnegative(), markets: z.number().int().nonnegative()}).strict(),
 z.object({kind: z.literal('reference'), p50: z.number(), likely: NumberRange, possible: NumberRange, yearsUsed: z.array(z.number().int()).max(6), observations: z.number().int().nonnegative()}).strict(),
 z.object({kind: z.literal('none'), reason: z.string().max(80)}).strict(),
]);

export const MarketWeatherPoint = z.object({
 kind: z.enum(['observed', 'forecast', 'typical', 'unavailable']),
 rainMm: z.number().nullable(),
 tMaxC: z.number().nullable(),
 tMinC: z.number().nullable(),
 /** Days of the week covered by the kind (7 when complete). */
 days: z.number().int().min(0).max(7),
}).strict();

export const MarketEvent = z.object({
 id: z.string().max(160),
 kind: z.enum(['alert', 'price_move']),
 type: FarmAlertType.nullable(),
 severity: FarmAlertSeverity,
 title: z.string().max(120),
 detail: text,
 date: isoDate,
 source: z.object({name: z.string().max(200), url: z.url().nullable(), date: isoDate.nullable()}).strict().nullable(),
 alertId: z.uuid().nullable(),
 dismissed: z.boolean(),
 /** Last day the alert applied (alerts only), so the UI can mark expired items. */
 validTo: isoDate.nullable().optional(),
}).strict();

export const MarketTimelinePoint = z.object({
 /** Monday of the ISO week. */
 weekStart: isoDate,
 weekEnd: isoDate,
 isoWeek: z.string().max(10),
 price: MarketPricePoint,
 weather: MarketWeatherPoint,
 events: z.array(MarketEvent).max(20),
}).strict();

export const MarketAnalogueYear = z.object({
 /** Crop year label, e.g. "2024-25" (July to June). */
 cropYear: z.string().max(10),
 /** Monsoon rain 1 June to 30 September at the field point, mm (observed). */
 rainMm: z.number(),
 similarity: z.number().min(0).max(1),
 /** Weekly p50 in that crop year keyed by the ISO week number of the calendar. */
 pricePath: z.array(z.object({isoWeek: z.number().int().min(1).max(53), p50: z.number()}).strict()).max(60),
 /** p50 in the current cycle's harvest week versus its sowing week in that year; null without a cycle or data. */
 harvestChangePct: z.number().nullable(),
}).strict();

export const MarketAnalogues = z.object({
 status: z.enum(['available', 'insufficient']),
 reason: z.string().max(200).nullable(),
 thisSeason: z.object({cropYear: z.string().max(10), rainMm: z.number().nullable(), observedThrough: isoDate.nullable(), typicalRemainderMm: z.number().nullable()}).strict().nullable(),
 years: z.array(MarketAnalogueYear).max(6),
}).strict();

export const MarketTimeline = z.object({
 farmId: z.uuid(),
 productId: z.string().max(200),
 productName: z.string().max(120),
 cropName: z.string().max(120),
 asOf: z.iso.datetime(),
 today: isoDate,
 from: isoDate,
 to: isoDate,
 todayIndex: z.number().int().nonnegative(),
 scope: z.object({level: z.enum(['market', 'district', 'state', 'national']), stateName: z.string().nullable(), districtName: z.string().nullable(), marketCount: z.number().int().nonnegative(), label: z.string().max(160)}).strict(),
 unit: z.literal('INR/kg'),
 /** Last day covered by a stored forecast; weather after it is typical, never forecast. */
 forecastHorizonEnd: isoDate.nullable(),
 harvestWindow: z.object({earliest: isoDate, latest: isoDate}).strict().nullable(),
 /** Up to 60 months back plus 18 ahead (about 340 weeks). */
 points: z.array(MarketTimelinePoint).max(400),
 analogues: MarketAnalogues,
 band: z.object({likely: z.literal('p25_p75'), possible: z.literal('p10_p90')}).strict(),
 limitations: z.array(text),
}).strict();

export type MarketPricePoint = z.infer<typeof MarketPricePoint>;
export type MarketWeatherPoint = z.infer<typeof MarketWeatherPoint>;
export type MarketEvent = z.infer<typeof MarketEvent>;
export type MarketTimelinePoint = z.infer<typeof MarketTimelinePoint>;
export type MarketAnalogueYear = z.infer<typeof MarketAnalogueYear>;
export type MarketAnalogues = z.infer<typeof MarketAnalogues>;
export type MarketTimeline = z.infer<typeof MarketTimeline>;
