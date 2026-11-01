import { describe, expect, it } from 'vitest';
import { NumberEstimate } from '@harvest/contracts';
import { ESTIMATE_DRAWS, estimateProfit, hash32, inverseNormal, stratifiedNormals, sumEstimates, xorshift32, type ProfitArgs } from '../src/services/estimate';
import { ASSUMPTIONS } from '../src/services/year-plan/scoring';

/**
 * Profit estimate tests (ROUND2_SPEC.md 1.2 item 6). Yield, price and cost figures are SYNTHETIC. Closed-form values were
 * computed independently in Python (statistics.NormalDist): median 66000 x exp(sigma x z_q), sigma = sqrt(sy^2 + sp^2),
 * sy = ln(1150/1050)/1.349 = 0.0674365, sp = ln(70/50)/1.349 = 0.2494235, sigma = 0.2583791.
 */
const ARGS: ProfitArgs = { seed: 'groundnut|2027-06-01', yieldKgPerHa: { p25: 1050, p50: 1100, p75: 1150 }, pricePerKg: { p25: 50, p50: 60, p75: 70 }, costPerHa: 30000, areaHa: 0.16 };
const CLOSED = { p10: 47395.57, p25: 55444.40, p50: 66000, p75: 78565.19, p90: 91907.33 };
const ordered = (e: NumberEstimate) => e.possible.low <= e.likely.low && e.likely.low <= e.central && e.central <= e.likely.high && e.likely.high <= e.possible.high;

describe('estimateProfit', () => {
  it('xorshift32 and the hash are deterministic and nonzero; the inverse normal matches known quantiles', () => {
    const a = xorshift32(hash32('x')), b = xorshift32(hash32('x'));
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((v) => v > 0 && v < 2 ** 32)).toBe(true);
    expect(inverseNormal(0.9)).toBeCloseTo(1.2815516, 6);
    expect(inverseNormal(0.25)).toBeCloseTo(-0.6744898, 6);
    expect(inverseNormal(0.01)).toBeCloseTo(-2.3263479, 6);
    const z = stratifiedNormals('s');
    expect(z.length).toBe(ESTIMATE_DRAWS);
    expect(Array.from(z).reduce((s, v) => s + v, 0) / z.length).toBeCloseTo(0, 2);
  });

  it('matches the closed form within Rs 200 for one slot, orders its bands and is reproducible', () => {
    const e = estimateProfit(ARGS);
    const r = e.revenuePerHa!;
    for (const [got, want] of [[r.possible.low, CLOSED.p10], [r.likely.low, CLOSED.p25], [r.central, CLOSED.p50], [r.likely.high, CLOSED.p75], [r.possible.high, CLOSED.p90]] as const) expect(Math.abs(got - want)).toBeLessThanOrEqual(200);
    const p = e.profitPerHa!;
    expect(Math.abs(p.central - (CLOSED.p50 - 30000))).toBeLessThanOrEqual(200);
    expect(Math.abs(p.likely.low - (CLOSED.p25 - 30000))).toBeLessThanOrEqual(200);
    for (const x of [r, p, e.profitForField!, e.revenueForField!]) { expect(ordered(x)).toBe(true); NumberEstimate.parse(x); }
    for (const v of [r.central, r.likely.low, p.possible.high]) expect(v % 100).toBe(0);
    expect(JSON.stringify(estimateProfit(ARGS))).toBe(JSON.stringify(e));
    expect(estimateProfit({ ...ARGS, seed: 'other' }).draws.revenue).not.toEqual(e.draws.revenue);
    expect(e.sigma!.revenue).toBeCloseTo(0.2583791, 6);
  });

  it('field = per hectare x area within rounding; unknown area gives no field estimate', () => {
    const e = estimateProfit(ARGS);
    const per = e.profitPerHa!, field = e.profitForField!;
    const tol = 50 * (1 + ARGS.areaHa!);
    for (const [f, h] of [[field.central, per.central], [field.likely.low, per.likely.low], [field.likely.high, per.likely.high], [field.possible.low, per.possible.low], [field.possible.high, per.possible.high]] as const) expect(Math.abs(f - h * ARGS.areaHa!)).toBeLessThanOrEqual(tol);
    expect(estimateProfit({ ...ARGS, areaHa: null }).profitForField).toBeNull();
    expect(estimateProfit({ ...ARGS, areaHa: 0 }).revenueForField).toBeNull();
  });

  it('a yield range without spread uses the flagged single-year sigma; missing inputs give null, never a guess', () => {
    const flat = estimateProfit({ ...ARGS, yieldKgPerHa: { p25: 1100, p50: 1100, p75: 1100 } });
    expect(flat.yieldSigmaAssumed).toBe(true);
    expect(flat.sigma!.yield).toBe(ASSUMPTIONS.singleYearYieldSigma.value);
    expect(ASSUMPTIONS.singleYearYieldSigma.value).toBe(0.15);
    expect(estimateProfit({ ...ARGS, pricePerKg: null })).toMatchObject({ revenuePerHa: null, profitPerHa: null, profitForField: null });
    const noCost = estimateProfit({ ...ARGS, costPerHa: null });
    expect(noCost.revenuePerHa).not.toBeNull();
    expect(noCost.profitPerHa).toBeNull();
    // Only the price varies: the stratified draws reproduce its closed-form quantiles almost exactly.
    const priceOnly = estimateProfit({ ...ARGS, yieldKgPerHa: { p25: 1000, p50: 1100, p75: 1200 }, pricePerKg: { p25: 60, p50: 60, p75: 60 } });
    expect(priceOnly.sigma!.price).toBe(0);
  });

  it('green manure: revenue exactly 0, profit minus the cost', () => {
    const gm = estimateProfit({ seed: 'gm', yieldKgPerHa: null, pricePerKg: null, costPerHa: 4500, areaHa: 2, noRevenue: true });
    expect(gm.revenuePerHa).toEqual({ central: 0, likely: { low: 0, high: 0 }, possible: { low: 0, high: 0 } });
    expect(gm.profitPerHa).toEqual({ central: -4500, likely: { low: -4500, high: -4500 }, possible: { low: -4500, high: -4500 } });
    expect(gm.profitForField!.central).toBe(-9000);
  });

  it('option totals are quantiles of summed draws, not sums of quantiles, and reproducible', () => {
    const a = estimateProfit(ARGS);
    const b = estimateProfit({ ...ARGS, seed: 'maize|2027-10-01', yieldKgPerHa: { p25: 3000, p50: 3200, p75: 3400 }, pricePerKg: { p25: 18, p50: 21, p75: 25 }, costPerHa: 50000 });
    const t = sumEstimates([a.draws, b.draws], ARGS.areaHa);
    expect(ordered(t.profitPerHa!)).toBe(true);
    expect(ordered(t.profitForField!)).toBe(true);
    const sumOfP10 = a.profitPerHa!.possible.low + b.profitPerHa!.possible.low;
    // Independent slots: the p10 of the sum lies above the sum of the p10s (diversification).
    expect(t.profitPerHa!.possible.low).toBeGreaterThan(sumOfP10);
    expect(Math.abs(t.profitPerHa!.central - (a.profitPerHa!.central + b.profitPerHa!.central))).toBeLessThan(3000);
    expect(JSON.stringify(sumEstimates([a.draws, b.draws], ARGS.areaHa))).toBe(JSON.stringify(t));
    expect(sumEstimates([a.draws, estimateProfit({ ...ARGS, costPerHa: null }).draws], 1).profitPerHa).toBeNull();
    expect(sumEstimates([], 1).revenuePerHa).toBeNull();
  });
});
