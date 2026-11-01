import type { NumberEstimate } from '@harvest/contracts';
import { ASSUMPTIONS } from './year-plan/scoring';

/**
 * Revenue and profit estimates as NumberEstimate (ROUND2_SPEC.md 1.2 item 6), shared by the year plan and crop fit.
 * Pure: no database, network or model call; deterministic for identical inputs.
 *
 * Model per slot (one crop on one hectare): yield and harvest-week price are independent lognormals with medians at
 * the regional yield p50 and the outlook price p50 and sigma = ln(p75/p25) / 1.349 (the interquartile range of a
 * normal is 1.349 sigma). A yield range without spread (a single published year) uses
 * ASSUMPTIONS.singleYearYieldSigma (0.15, flagged); a price range without spread uses sigma 0. Revenue = yield x price x
 * keep (1 minus losses); cost (A2+FL) is deterministic; profit = revenue - cost.
 *
 * The product of two independent lognormals is lognormal with sigma^2 = sigma_y^2 + sigma_p^2, so each draw samples
 * revenue directly as median x exp(sigma x z). The z values are stratified (Latin hypercube): N = 2000 strata of the
 * standard normal, jittered and permuted by xorshift32 seeded from a string hash, so a single slot's quantiles match the
 * closed form within a few rupees and option totals (sums of independently permuted slot draws, draw by draw) are
 * reproducible. Quantiles p10, p25, p50, p75, p90 are rounded to Rs 100: central = p50, likely = p25..p75 (middle half of
 * the simulated outcomes), possible = p10..p90.
 */
export const ESTIMATE_DRAWS = 2000;
const IQR_Z = 1.349;
const ROUND_TO = 100;

/** FNV-1a 32-bit hash of a string (never 0, so it can seed xorshift32). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0 || 0x9e3779b9;
}

/** Marsaglia xorshift32: uint32 stream from a nonzero seed. */
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error below 1.2e-9). */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('inverseNormal needs 0 < p < 1');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** N stratified standard normal draws in a seeded random order (one per stratum (i + u) / N). */
export function stratifiedNormals(seed: string, n = ESTIMATE_DRAWS): Float64Array {
  const next = xorshift32(hash32(seed));
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = next() % (i + 1); const t = perm[i]!; perm[i] = perm[j]!; perm[j] = t; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = inverseNormal((perm[i]! + (next() + 0.5) / 4294967296) / n);
  return out;
}

const round100 = (x: number): number => Math.round(x / ROUND_TO) * ROUND_TO + 0;
/** Type-7 quantile of an ascending array. */
function quantileSorted(s: Float64Array, p: number): number {
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo]! + (h - lo) * (s[lo + 1]! - s[lo]!) : s[lo]!;
}
/** NumberEstimate of `draws` x `scale` (scale > 0), quantiles rounded to Rs 100. */
export function summarise(draws: ArrayLike<number>, scale = 1): NumberEstimate {
  const s = Float64Array.from(draws).sort();
  const q = (p: number) => round100(quantileSorted(s, p) * scale);
  return { central: q(0.5), likely: { low: q(0.25), high: q(0.75) }, possible: { low: q(0.1), high: q(0.9) } };
}

export interface Quantiles3 { p25: number; p50: number; p75: number }
/** sigma of a lognormal from its interquartile range; null when the range has no spread or is not positive. */
export function sigmaFromRange(r: Quantiles3): number | null {
  return r.p25 > 0 && r.p75 > r.p25 ? Math.log(r.p75 / r.p25) / IQR_Z : null;
}
const fieldArea = (a: number | null | undefined): number | null => (a !== null && a !== undefined && Number.isFinite(a) && a > 0 ? a : null);

/** Per-hectare draws of one slot (null when not computable). Exported so crop fit can reuse and sum them. */
export interface SlotDraws { revenue: Float64Array | null; profit: Float64Array | null }
export interface ProfitArgs {
  /** Seed string; the year plan uses the slot key, so a slot's numbers do not depend on the option it sits in. */
  seed: string;
  /** Yield kg/ha: p50 = regional median, p25/p75 = the range shown. */
  yieldKgPerHa: Quantiles3 | null;
  /** Harvest-week price INR/kg: outlook p25, p50, p75. */
  pricePerKg: Quantiles3 | null;
  /** 1 minus the post-harvest loss share (1 when not sourced). */
  keep?: number | undefined;
  /** Deterministic cost INR/ha (A2+FL, else a published C2-type total); null when not sourced. */
  costPerHa: number | null;
  /** Field area in hectares; null when unknown (no field totals). */
  areaHa: number | null;
  /** Green manure: no product, revenue is exactly 0 and profit is minus the cost. */
  noRevenue?: boolean | undefined;
  draws?: number | undefined;
}
export interface ProfitEstimate {
  revenuePerHa: NumberEstimate | null;
  profitPerHa: NumberEstimate | null;
  revenueForField: NumberEstimate | null;
  profitForField: NumberEstimate | null;
  draws: SlotDraws;
  /** Revenue median INR/ha (yield p50 x price p50 x keep) and the sigmas used; null without revenue. */
  median: number | null;
  sigma: { yield: number; price: number; revenue: number } | null;
  /** True when ASSUMPTIONS.singleYearYieldSigma replaced a yield range without spread. */
  yieldSigmaAssumed: boolean;
}

/** Revenue and profit estimates for one slot, per hectare and for the field (ROUND2_SPEC.md 1.2 item 6). */
export function estimateProfit(args: ProfitArgs): ProfitEstimate {
  const n = args.draws ?? ESTIMATE_DRAWS;
  const area = fieldArea(args.areaHa);
  const cost = args.costPerHa !== null && Number.isFinite(args.costPerHa) ? args.costPerHa : null;
  let revenue: Float64Array | null = null;
  let median: number | null = null;
  let sigma: ProfitEstimate['sigma'] = null;
  let yieldSigmaAssumed = false;
  if (args.noRevenue) {
    revenue = new Float64Array(n);
    median = 0;
  } else if (args.yieldKgPerHa && args.pricePerKg && args.yieldKgPerHa.p50 > 0 && args.pricePerKg.p50 > 0) {
    const sy0 = sigmaFromRange(args.yieldKgPerHa);
    yieldSigmaAssumed = sy0 === null;
    const sy = sy0 ?? ASSUMPTIONS.singleYearYieldSigma.value;
    const sp = sigmaFromRange(args.pricePerKg) ?? 0;
    const s = Math.sqrt(sy * sy + sp * sp);
    median = args.yieldKgPerHa.p50 * args.pricePerKg.p50 * (args.keep ?? 1);
    sigma = { yield: sy, price: sp, revenue: s };
    const z = stratifiedNormals(args.seed, n);
    revenue = new Float64Array(n);
    for (let i = 0; i < n; i++) revenue[i] = median * Math.exp(s * z[i]!);
  }
  const profit = revenue && cost !== null ? revenue.map((r) => r - cost) : null;
  return {
    revenuePerHa: revenue ? summarise(revenue) : null,
    profitPerHa: profit ? summarise(profit) : null,
    revenueForField: revenue && area ? summarise(revenue, area) : null,
    profitForField: profit && area ? summarise(profit, area) : null,
    draws: { revenue, profit }, median, sigma, yieldSigmaAssumed,
  };
}

/** Draw-by-draw sum of slot draws; null when any slot lacks them or the list is empty. */
function sumDraws(list: readonly (Float64Array | null)[]): Float64Array | null {
  if (!list.length || list.some((d) => d === null)) return null;
  const n = list[0]!.length;
  if (list.some((d) => d!.length !== n)) throw new Error('sumEstimates: draw counts differ');
  const out = new Float64Array(n);
  for (const d of list) for (let i = 0; i < n; i++) out[i]! += d![i]!;
  return out;
}

export interface TotalEstimate { revenuePerHa: NumberEstimate | null; profitPerHa: NumberEstimate | null; revenueForField: NumberEstimate | null; profitForField: NumberEstimate | null; draws: SlotDraws }
/**
 * Option totals from the same draw matrix: the slots' draws are summed draw by draw and the quantiles are taken of the
 * sums, so a total is not a sum of quantiles. Null when any slot has no revenue (or no profit for the profit total).
 */
export function sumEstimates(slots: readonly SlotDraws[], areaHa: number | null): TotalEstimate {
  const area = fieldArea(areaHa);
  const revenue = sumDraws(slots.map((s) => s.revenue));
  const profit = sumDraws(slots.map((s) => s.profit));
  return {
    revenuePerHa: revenue ? summarise(revenue) : null,
    profitPerHa: profit ? summarise(profit) : null,
    revenueForField: revenue && area ? summarise(revenue, area) : null,
    profitForField: profit && area ? summarise(profit, area) : null,
    draws: { revenue, profit },
  };
}
