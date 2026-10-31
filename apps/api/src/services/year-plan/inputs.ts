import type { HarvestPriceOutlook } from '@harvest/contracts';
import { isoWeek, midpoint, monthOf, weekBucket } from './dates';
import type { HarvestRange } from './types';

/**
 * Inputs the orchestration layer (packet 2) prefetches before scoring. The engine never fetches: a missing entry is
 * scored as missing (price component 0, water fit neutral and flagged), never filled in.
 *
 * Prefetch recipe:
 *  - priceOutlooks: for each entry of collectInputKeys([...fixed slot, ...candidates]) call
 *    harvestPriceOutlook(pool, mode, {productId, stateName, districtName, harvestDate: entry.harvestDate, asOf}) once and
 *    store it under entry.key. With a fixed asOf the outlook depends only on (product, ISO week bucket of the harvest
 *    date), which is exactly what priceKey encodes, so one call serves every slot with the same key.
 *  - annualMeans: optional productId -> three-year annual mean INR/kg; when absent the outlook's own annualMean is used.
 *  - climatologyRainByMonth: 12 monthly rain normals (mm, Jan..Dec) for the field point, for example
 *    monthlyRainFromDaily(getClimatology(scope, {start: horizon.from, end: horizon.to - 1 day}).days); null when the
 *    climatology is unavailable.
 *  - soilPh: planningMeasuredPh(farmSoilMarkers(...)) (one compatible confirmed laboratory pH, never an average).
 *  - neighbourhoodActiveMonths / neighbourhoodObservedMonths: from neighbourhoodSeasonality(): activeMonths, and the
 *    monthOfYear of months whose meanNdvi is not null. Without observed months only the positive adjustment applies.
 *  - irrigationCategory: the farm fact (rainfed | supplemental | irrigated) or an allowance class; null when unknown.
 */
export type IrrigationInput = 'rainfed' | 'supplemental' | 'irrigated' | 'none' | 'protective' | 'assured' | null;

export interface Inputs {
  /** Keyed by priceKey(productId, harvestDate). */
  priceOutlooks: Map<string, HarvestPriceOutlook>;
  /** productId -> annual mean wholesale price INR/kg over the outlook years. */
  annualMeans: Map<string, number>;
  /** 12 monthly climatological rain normals in mm (index 0 = January); null when unavailable. */
  climatologyRainByMonth: number[] | null;
  climatologySource?: { sourceId: string; years: { from: number; to: number } } | null | undefined;
  /** One compatible confirmed laboratory soil pH, or undefined. */
  soilPh: number | undefined;
  /** Months of year (1..12) with neighbourhood NDVI at or above the active threshold; null when unavailable. */
  neighbourhoodActiveMonths: number[] | null;
  /** Months of year with a usable NDVI mean (observed); enables the -0.1 contradiction adjustment. */
  neighbourhoodObservedMonths?: number[] | null | undefined;
  irrigationCategory: IrrigationInput;
  /** Review date (YYYY-MM-DD); the price outlooks must have been computed with the same asOf. */
  asOf: string;
  /** productId -> farmer yield override in kg/ha (wins over regional yields; the range is scaled by it). */
  yieldOverrides?: Map<string, number> | undefined;
}

/** Representative harvest date for prices: midpoint of the earliest and latest harvest dates. */
export const priceHarvestDate = (h: HarvestRange): string => midpoint(h.earliest, h.latest);

/** Price key: product and ISO harvest week bucket (week 53 pooled with 52), e.g. "maize-grain@W07". */
export function priceKey(productId: string, harvestDate: string): string {
  return `${productId}@W${String(weekBucket(isoWeek(harvestDate).week)).padStart(2, '0')}`;
}
/** Key of a slot's harvest-week price outlook. */
export const slotPriceKey = (slot: { productId: string; harvest: HarvestRange }): string => priceKey(slot.productId, priceHarvestDate(slot.harvest));

export interface PriceInputKey { key: string; productId: string; harvestDate: string }

/** Unique price lookups for a set of slots, sorted by key; harvestDate is the earliest representative date per key. */
export function collectInputKeys(slots: Iterable<{ productId: string; harvest: HarvestRange }>): PriceInputKey[] {
  const out = new Map<string, PriceInputKey>();
  for (const s of slots) {
    const harvestDate = priceHarvestDate(s.harvest);
    const key = priceKey(s.productId, harvestDate);
    const cur = out.get(key);
    if (!cur || harvestDate < cur.harvestDate) out.set(key, { key, productId: s.productId, harvestDate });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Monthly rain normals from daily climatology normals:
 * the mean daily rain of the month times that month's length in a common year. Needs at least 20 days with a value in
 * every month; otherwise null (water fit then stays neutral and flagged).
 */
export function monthlyRainFromDaily(days: readonly { date: string; rainMm: number | null }[]): number[] | null {
  const sums = Array.from({ length: 12 }, () => ({ total: 0, n: 0 }));
  for (const d of days) {
    if (d.rainMm === null || !Number.isFinite(d.rainMm)) continue;
    const m = sums[monthOf(d.date) - 1]!;
    m.total += d.rainMm;
    m.n += 1;
  }
  if (sums.some((m) => m.n < 20)) return null;
  const LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return sums.map((m, i) => Math.round((m.total / m.n) * LENGTH[i]! * 10) / 10);
}

/** Inputs with nothing prefetched (every price missing, water neutral). */
export function emptyInputs(asOf: string, irrigationCategory: IrrigationInput = null): Inputs {
  return { priceOutlooks: new Map(), annualMeans: new Map(), climatologyRainByMonth: null, soilPh: undefined, neighbourhoodActiveMonths: null, irrigationCategory, asOf };
}
