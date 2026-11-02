import type {BasisRef, HarvestEconomics} from '@harvest/contracts';
import * as data from '../year-plan/data';
import {assumptionBasis, ASSUMPTIONS} from '../year-plan/scoring';
import {placeWindows} from '../year-plan/windows';
import {addDays, monthOf} from '../year-plan/dates';
import type {Season} from '../year-plan/types';
import {estimateProfit} from '../estimate';
import type {HarvestPriceOutlook} from '../price-series';

/**
 * Expected profit at harvest for the growing crop (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 1). Pure: every input is a
 * plain value, the only reads are the year-plan research files through year-plan/data.ts; no database, network or model.
 *
 * Arithmetic: the same references the year plan uses for its fixed slot (regional yield of the product's own form, the
 * sourced post-harvest loss, the harvest-week price outlook the Today view already fetched, the A2+FL cost, else a C2-type
 * total), simulated by estimateProfit: revenue = yield x price x keep, profit = revenue - cost, per hectare and for the field.
 * evaluateSlot is not called (it needs a stored year-plan review context; spec section 0 item 2).
 *
 * Documented choices that change results:
 * - seed: `fixed:<cycle id>`, the year plan's own key for the slot of the crop in the ground (scenario.ts fixedSlotFor), so the
 *   Today figure and the plan figure are the same draws and agree exactly for the same inputs (the spec text names the seed
 *   `today:<cycle id>`; with a different seed the two would differ by up to one Rs 100 rounding step);
 * - season: the year plan's fixed-slot rule (scenario.ts fixedSlotFor): the season of the sourced sowing window (district, else
 *   state) that contains the recorded sowing date, else seasonOfMonth of the sowing month (for a transplanted crop the
 *   establishment date can fall in the next month; the yield season belongs to the sowing). See `sowingSeason` below;
 * - keep: 1 - the sourced loss share, unrounded, exactly as the year plan's evaluateSlot passes it to estimateProfit;
 * - farmer yield override: the year plan's evaluateSlot scales its yield by `Inputs.yieldOverrides` (engine inputs of a
 *   review run; no stored farm field feeds it, so it is not reachable here). This module always uses the regional yield and
 *   says so in a limitation (NO_OVERRIDE) whenever a yield is used;
 * - the harvest date is the window midpoint (the date harvestPrice is for); the profit is not re-dated.
 */

export const HARVEST_ECONOMICS_REASONS = {
  no_product_recorded: 'No product is recorded for this crop, so no yield or price applies.',
  yield_not_sourced: 'No regional yield of this product form is sourced.',
  harvest_window_unknown: 'No harvest window is known for this crop, so no harvest-week price applies.',
  price_insufficient: 'No harvest-week price range is available for this product.',
} as const;

const ALWAYS = 'Regional reference yield and cost, not this field\'s; the price is a seasonal reference of past years, not a forecast.';
const NO_LOSS = 'No post-harvest loss share is sourced for this crop; nothing is deducted for losses.';
const NO_AREA = 'No field area is recorded, so the figures are per hectare only.';
/** Parity gap with the year plan that this module cannot close (see the header). */
export const NO_OVERRIDE = 'The year plan can scale its yield by a farmer-entered yield; this estimate reads no farmer yield and uses the regional reference.';

/**
 * Season of the yield reference, by the year plan's fixed-slot rule (scenario.ts fixedSlotFor line `season: hit?.season ??
 * seasonOfMonth(monthOf(cycle.sowingDate))`): the usable sowing windows for the farm (data.windowsFor), placed around the
 * sowing date with the plan's own placeWindows and the same +-400 day range, the first one containing the sowing date; else
 * the calendar season of the sowing month.
 */
export function sowingSeason(cropId: string, sowingDate: string, where: {stateId: string | null; districtId: string | null}): Season {
  const scoped = data.windowsFor(cropId, where).filter((w) => w.usable);
  const hit = placeWindows(scoped, {from: addDays(sowingDate, -400), to: addDays(sowingDate, 400)}).find((p) => p.from <= sowingDate && sowingDate <= p.to) ?? null;
  return hit?.season ?? data.seasonOfMonth(monthOf(sowingDate));
}
const ESTIMATE_BASIS: BasisRef = {
  kind: 'model', label: 'Profit estimate: lognormal yield x harvest-week price, 2000 seeded draws', sourceId: 'estimate:lognormal-yield-price-v1', url: null, scope: null,
  note: 'Yield and price are independent lognormals with medians at the regional yield p50 and the price p50 and sigma = ln(p75/p25)/1.349; cost is deterministic. Likely = middle half of the simulated outcomes (p25 to p75); possible = 10th to 90th percentile; rounded to Rs 100. Same model and seed as the year plan\'s slot for the crop in the ground.',
};

export interface HarvestEconomicsInput {
  cycle: {id: string; cropId: string; productId: string | null; sowingDate: string};
  farm: {stateId: string | null; districtId: string | null; areaHa: number | null};
  /** The stage timeline's harvest window (null when none). */
  harvest: {earliest: string; latest: string} | null;
  /** The harvest-midpoint date the price is for (view.ts harvestMidpoint); null without a window. */
  harvestDate: string | null;
  /** The harvest-week outlook the Today view fetched (price.headline); null when none. */
  headline: HarvestPriceOutlook | null;
  /** The view's scope label of the harvest price (harvestPrice.scopeLabel). */
  priceScopeLabel: string;
  /** Plain-text reason of an insufficient headline (the view's price reason map). */
  priceMissingText: string | null;
  today: string;
}

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const validArea = (a: number | null) => (a !== null && Number.isFinite(a) && a > 0 ? a : null);
const round = (x: number) => Math.round(x);

function empty(i: HarvestEconomicsInput, reason: keyof typeof HARVEST_ECONOMICS_REASONS, limitations: string[], basis: BasisRef[] = [], extra: Partial<HarvestEconomics> = {}): HarvestEconomics {
  return {
    status: 'unavailable', reason, harvest: i.harvest, harvestDate: i.harvestDate, fieldAreaHa: validArea(i.farm.areaHa),
    yieldKgPerHa: null, yieldBasis: null, yieldForFieldKg: null, keepFraction: 1, price: null, cost: null,
    revenuePerHa: null, revenueForField: null, profitPerHa: null, profitForField: null, ...extra,
    basis: basis.slice(0, 14), limitations: [...new Set([HARVEST_ECONOMICS_REASONS[reason], ...limitations].map((s) => cap(s, 1000)))].slice(0, 12),
  };
}

function yieldBasisRef(ref: data.YieldRef): BasisRef {
  const src = data.yieldCostSource(ref.sourceIds[0]);
  const note = [
    `${ref.basis === 'reference' ? 'Single published year' : `Median and P25 to P75 of ${ref.years.length} years`} (${ref.years.join(', ')}), season ${ref.season}.`,
    ...ref.notes,
  ].join(' ');
  return {
    kind: 'yield_reference', label: cap(`Regional yield (${ref.basis}): ${src?.title ?? ref.sourceIds[0] ?? 'yield reference'}`, 200), sourceId: ref.sourceIds[0] ?? null, url: src?.url ?? null,
    scope: cap(`${ref.region} ${ref.years.join(', ')}`, 120), note: cap(note, 1000),
  };
}

/** Expected profit at the harvest midpoint for the growing crop; unavailable (reason set) when yield or price is missing. */
export function harvestEconomics(i: HarvestEconomicsInput): HarvestEconomics {
  const {cycle, farm} = i;
  const area = validArea(farm.areaHa);
  const areaNotes = area === null ? [NO_AREA] : [];
  if (!cycle.productId) return empty(i, 'no_product_recorded', areaNotes);
  const where = {stateId: farm.stateId, districtId: farm.districtId};
  const season = sowingSeason(cycle.cropId, cycle.sowingDate, where);
  const ref = data.yieldFor(cycle.cropId, cycle.productId, {...where, season, asOf: i.today});
  if (!ref) return empty(i, 'yield_not_sourced', [data.yieldGapReason(cycle.cropId, cycle.productId, farm.stateId), ...areaNotes]);

  const basis: BasisRef[] = [yieldBasisRef(ref)];
  const limitations: string[] = [ALWAYS, ...ref.notes, NO_OVERRIDE];
  const yieldKgPerHa = {low: ref.low, high: ref.high};
  const yieldForFieldKg = area !== null ? {low: round(ref.low * area), high: round(ref.high * area)} : null;
  const shared: Partial<HarvestEconomics> = {yieldKgPerHa, yieldBasis: ref.basis, yieldForFieldKg};

  // Loss: 1 - sourced share, else 1 (flagged). Unrounded, as the year plan's evaluateSlot computes it.
  const loss = data.postHarvestLoss(cycle.cropId);
  const keepFraction = loss ? 1 - loss.pct / 100 : 1;
  if (loss) {
    const src = data.yieldCostSource(loss.sourceId);
    basis.push({kind: 'yield_reference', label: cap(`Post-harvest loss ${loss.pct}%: ${src?.title ?? loss.sourceId ?? 'loss reference'}`, 200), sourceId: loss.sourceId, url: src?.url ?? null, scope: null, note: null});
  } else limitations.push(NO_LOSS);

  // Price: the headline the view already fetched (never fetched again here).
  const h = i.headline;
  if (!i.harvest || !h) return empty(i, i.harvest ? 'price_insufficient' : 'harvest_window_unknown', [...limitations, ...areaNotes], basis, {...shared, keepFraction});
  const priced = h.status === 'available' && h.p25 !== null && h.p50 !== null && h.p75 !== null && h.p50 > 0;
  const priceBlock: NonNullable<HarvestEconomics['price']> = {
    status: priced ? 'available' : 'insufficient', unit: 'INR/kg', p50: priced ? h.p50 : null,
    likely: priced ? {low: h.p25!, high: h.p75!} : null, scopeLabel: cap(i.priceScopeLabel, 160),
  };
  if (!priced) {
    return empty(i, 'price_insufficient', [...limitations, i.priceMissingText ? `Harvest price: ${i.priceMissingText}.` : 'Harvest price: no range is available.', ...areaNotes], basis, {...shared, keepFraction, price: priceBlock});
  }
  basis.push({
    kind: 'price_history', label: cap(`Harvest-week price reference: ${h.basisLabel}`, 200), sourceId: null, url: null, scope: cap(i.priceScopeLabel, 120),
    note: cap(`Median and P25 to P75 of weekly mandi prices near ${i.harvestDate ?? h.harvestDate} in ${h.yearsUsed.join(', ')}; not a forecast.`, 1000),
  });

  // Cost: A2+FL, else a published C2-type total (conservative), else none (partial).
  const cost = data.costFor(cycle.cropId, {stateId: farm.stateId});
  if (cost) {
    const src = data.yieldCostSource(cost.sourceId);
    basis.push({
      kind: 'cost_reference', label: cap(`Cost of cultivation (${cost.estimate.authority ?? 'other'}${cost.estimate.year ? ` ${cost.estimate.year}` : ''}): ${src?.title ?? cost.sourceId ?? 'cost reference'}`, 200),
      sourceId: cost.sourceId, url: src?.url ?? null, scope: cost.estimate.region, note: cap([`Deducted: ${cost.deductionBasis === 'a2fl' ? 'A2+FL' : 'C2-type total'} Rs ${cost.deductionPerHa}/ha.`, cost.locator, ...cost.notes].filter(Boolean).join(' '), 1000),
    });
    limitations.push(...cost.notes);
  } else limitations.push(data.costGapReason(cycle.cropId, farm.stateId));

  const est = estimateProfit({
    seed: `fixed:${cycle.id}`, keep: keepFraction, costPerHa: cost?.deductionPerHa ?? null, areaHa: area,
    yieldKgPerHa: {p25: ref.low, p50: ref.p50, p75: ref.high}, pricePerKg: {p25: h.p25!, p50: h.p50!, p75: h.p75!},
  });
  basis.push(ESTIMATE_BASIS);
  if (est.yieldSigmaAssumed) {
    limitations.push(`The yield has no year-to-year range; the profit simulation assumes a yield spread (sigma ${ASSUMPTIONS.singleYearYieldSigma.value}).`);
    basis.push(assumptionBasis('singleYearYieldSigma'));
  }
  limitations.push(...areaNotes);
  const status: HarvestEconomics['status'] = cost && ref.basis !== 'reference' ? 'available' : 'partial';
  return {
    status, reason: null, harvest: i.harvest, harvestDate: i.harvestDate, fieldAreaHa: area, ...shared, yieldKgPerHa, yieldBasis: ref.basis, yieldForFieldKg,
    keepFraction, price: priceBlock, cost: cost?.estimate ?? null,
    revenuePerHa: est.revenuePerHa, revenueForField: est.revenueForField, profitPerHa: est.profitPerHa, profitForField: est.profitForField,
    basis: basis.slice(0, 14), limitations: [...new Set(limitations.map((s) => cap(s, 1000)))].slice(0, 12),
  };
}
