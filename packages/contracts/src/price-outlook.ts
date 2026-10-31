import {z} from 'zod';

/**
 * Price read contracts shared by the Year plan and the Today view (apps/api/src/services/price-series.ts).
 *
 * Every price here is a WHOLESALE MANDI MODAL price in INR/kg taken from stored market_observations
 * (`price_modal_inr_per_kg`, converted at ingest from the published INR/quintal). It is never a farm-gate price.
 * Bucket min/max are the lowest/highest market-day modal values in the bucket: they are not the mandi's published
 * min/max prices and not a prediction interval. Every payload carries the scope that was actually used, so the UI can
 * always show a basis ("Hassan district mandis, 9 markets" or "Karnataka state pool").
 */

const text = z.string().max(1000);
/** Prices are rounded to 2 decimals for display; computations use full precision. */
const inrPerKg = z.number().nonnegative();

export const PriceScopeLevel = z.enum(['market', 'district', 'state', 'national']);
export type PriceScopeLevel = z.infer<typeof PriceScopeLevel>;

/**
 * Reason codes. The first three reuse docs/DECISIONS.md D45. The last two are interval failures of the seasonal
 * reference (too few leave-one-year-out residuals, or quantiles out of order) so a point is never shown without a range.
 */
export const PriceMissingReasonCode = z.enum([
  'price_history_not_ingested',
  'price_history_insufficient',
  'market_not_in_history',
  'price_residuals_insufficient',
  'price_interval_crossing',
]);
export type PriceMissingReasonCode = z.infer<typeof PriceMissingReasonCode>;

export const PriceScope = z.object({
  /** Level actually used for the numbers. */
  level: PriceScopeLevel,
  /** Most specific level the caller asked for (market > district > state > national). */
  requestedLevel: PriceScopeLevel,
  stateName: z.string().nullable(),
  districtName: z.string().nullable(),
  /** Distinct markets in the scope, counted by state + canonical market name (Agmarknet renames such as "Belur" -> "Belur APMC" count once). */
  marketCount: z.number().int().nonnegative(),
  /** Requested market ids when level is 'market'; empty otherwise. */
  marketIds: z.array(z.string()),
  /** Plain-language reason when the used level is less specific than the requested one; null when not a fallback. */
  fallbackNote: text.nullable(),
}).strict();
export type PriceScope = z.infer<typeof PriceScope>;

export const PriceCoverage = z.object({
  /** Valid stored rows (vintage-resolved, mode-scoped) used in the scope. */
  observations: z.number().int().nonnegative(),
  markets: z.number().int().nonnegative(),
  firstDate: z.iso.date().nullable(),
  lastDate: z.iso.date().nullable(),
  /** Distinct trading dates with at least one valid modal quote. */
  validDays: z.number().int().nonnegative(),
  /** Rows dropped as invalid (modal missing or <= 0, or min > modal, modal > max, min > max); counted, never repaired. */
  excludedRows: z.number().int().nonnegative(),
}).strict();
export type PriceCoverage = z.infer<typeof PriceCoverage>;

const common = {
  productId: z.string().min(1).max(200),
  status: z.enum(['available', 'insufficient']),
  missingReason: PriceMissingReasonCode.nullable(),
  scope: PriceScope,
  unit: z.literal('INR/kg'),
  priceBasis: z.literal('wholesale_mandi_modal'),
  /** "Mandi reference (wholesale), not a farm-gate price". */
  basisLabel: text,
  limitations: z.array(text),
};

export const PriceBucket = z.object({
  start: z.iso.date(),
  end: z.iso.date(),
  /** Median of market-day modal values in the bucket (a market-day value is the median of that market's rows that day). */
  p50: inrPerKg.nullable(),
  min: inrPerKg.nullable(),
  max: inrPerKg.nullable(),
  /** Number of market-day values. */
  n: z.number().int().nonnegative(),
  markets: z.number().int().nonnegative(),
}).strict();
export type PriceBucket = z.infer<typeof PriceBucket>;

export const PriceSeries = z.object({
  ...common,
  bucket: z.enum(['week', 'month']),
  from: z.iso.date(),
  to: z.iso.date(),
  buckets: z.array(PriceBucket),
  coverage: PriceCoverage,
  /** Runs of consecutive empty buckets. */
  gaps: z.array(z.object({from: z.iso.date(), to: z.iso.date()}).strict()),
}).strict();
export type PriceSeries = z.infer<typeof PriceSeries>;

/**
 * Seasonal reference for a harvest date (FORECASTING.md section 3, B_seasonal_reference, pooled across the scope's
 * markets): p50 = median of weekly medians in ISO weeks within +/- weekWindow of the harvest week, over the last
 * `years` complete ISO years before asOf. p10/p25/p75/p90 = p50 x exp(quantile of leave-one-year-out log residuals).
 * This is a historical reference, not a fitted forecast. Prices null when status is 'insufficient'.
 */
export const HarvestPriceOutlook = z.object({
  ...common,
  method: z.literal('B_seasonal_reference/pooled-v1'),
  harvestDate: z.iso.date(),
  harvestWeek: z.object({year: z.number().int(), week: z.number().int().min(1).max(53)}).strict(),
  asOf: z.iso.date(),
  weekWindow: z.number().int().min(0).max(8),
  yearsRequested: z.number().int().positive(),
  yearsConsidered: z.array(z.number().int()),
  yearsUsed: z.array(z.number().int()),
  perYear: z.array(z.object({year: z.number().int(), weeks: z.number().int().nonnegative(), median: inrPerKg}).strict()),
  p10: inrPerKg.nullable(),
  p25: inrPerKg.nullable(),
  p50: inrPerKg.nullable(),
  p75: inrPerKg.nullable(),
  p90: inrPerKg.nullable(),
  /** Mean of all weekly medians in yearsUsed (for the harvest-timing ratio p50 / annualMean). */
  annualMean: inrPerKg.nullable(),
  annualWeeks: z.number().int().nonnegative(),
  /** Weekly medians in the harvest-week pool. */
  weeksUsed: z.number().int().nonnegative(),
  /** Valid rows in the harvest-week pool. */
  observations: z.number().int().nonnegative(),
  marketsUsed: z.number().int().nonnegative(),
  residualCount: z.number().int().nonnegative(),
}).strict();
export type HarvestPriceOutlook = z.infer<typeof HarvestPriceOutlook>;

export const PriceTrend = z.object({
  ...common,
  months: z.number().int().positive(),
  asOf: z.iso.date(),
  /** First day of the first month and last day of the last complete month before asOf's month. */
  from: z.iso.date(),
  to: z.iso.date(),
  series: z.array(z.object({month: z.string().regex(/^\d{4}-\d{2}$/), p50: inrPerKg.nullable(), n: z.number().int().nonnegative(), markets: z.number().int().nonnegative()}).strict()),
  /** Last 12 months vs the prior 12, over calendar months present in both; null unless both windows have >= 9 months of data. */
  yoy: z.object({
    lastMonthsWithData: z.number().int().nonnegative(),
    priorMonthsWithData: z.number().int().nonnegative(),
    pairedMonths: z.number().int().nonnegative(),
    lastMean: inrPerKg,
    priorMean: inrPerKg,
    changePct: z.number(),
  }).strict().nullable(),
  yoyMissingReason: text.nullable(),
  coverage: PriceCoverage,
}).strict();
export type PriceTrend = z.infer<typeof PriceTrend>;
