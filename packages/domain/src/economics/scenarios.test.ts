import { EconomicsResult, type EconomicsInput } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { calculateScenarios } from './scenarios';

// Every number here is a synthetic fixture chosen for hand-checkable arithmetic.
const t = (low: number | string, central: number | string, high: number | string) => ({ low, central, high });
const baseInput = (): EconomicsInput => ({
  schemaVersion: '1.0',
  productId: 'synthetic-ginger-fresh',
  area: { amount: 2, unit: 'acre' },
  yield: { productBasis: 'fresh', unit: 'kg/ha', amount: t(10000, 15000, 20000), evidenceState: 'scenario', evidenceIds: [] },
  marketableFraction: t(0.8, 0.9, 0.95),
  harvests: [{ periodId: 'synthetic-p1', period: { start: '2027-12-01', end: '2027-12-31' }, shareOfYield: 1 }],
  prices: [{ periodId: 'synthetic-p1', productBasis: 'fresh', unit: 'INR/kg', amount: t('20', '30', '40'), evidenceState: 'scenario', marketId: 'synthetic-market-a', evidenceIds: [] }],
  conversion: null,
  costs: {
    cashProduction: { basis: 'per_ha', amountInr: t('200000', '250000', '300000'), evidenceIds: [], definition: 'synthetic farmer-entered cash cost' },
    harvest: { basis: 'per_kg_marketable', amountInr: t('2', '3', '4'), evidenceIds: [], definition: 'synthetic' },
    saleAndTransport: { basis: 'per_kg_marketable', amountInr: t('1', '1.5', '2'), evidenceIds: [], definition: 'synthetic' },
    fullEconomic: null,
  },
  unpricedItems: ['synthetic-family-labour'],
});

const central = (r: EconomicsResult) => r.scenarios.find((s) => s.name === 'central')!;

describe('scenario economics', () => {
  it('central per-ha figures match hand calculation; totals use converted area', () => {
    const r = calculateScenarios(baseInput());
    expect(EconomicsResult.parse(r)).toEqual(r);
    expect(r.status).toBe('complete');
    const c = central(r);
    expect(c.perHa.marketableKgTotal).toBe('13500.000');
    expect(c.perHa.grossRevenueInr).toBe('405000.00');
    expect(c.perHa.netCashReturnInr).toBe('94250.00');
    expect(c.perHa.breakEvenPriceInrPerKg).toBe('23.02');
    expect(c.perHa.breakEvenMarketableYieldKgPerHa).toBe('9803.922');
    expect(c.total!.netCashReturnInr).toBe('76283.24'); // 94250 * 0.80937128448 ha
    expect(r.unpricedItems).toEqual(['synthetic-family-labour', 'full_economic_cost']);
  });
  it('low < central < high and the paired stress scenario is present', () => {
    const r = calculateScenarios(baseInput());
    const net = (n: string) => Number(r.scenarios.find((s) => s.name === n)!.perHa.netCashReturnInr);
    expect(net('low')).toBeLessThan(net('central'));
    expect(net('central')).toBeLessThan(net('high'));
    // low: 10000*0.8=8000 kg; gross 160000; costs 300000 + 8000*4 + 8000*2 = 348000
    expect(net('low')).toBe(-188000);
    expect(r.scenarios.map((s) => s.name)).toContain('yield_shortfall_price_rise');
  });
  it('produces no probability-of-loss output', () => {
    const r = calculateScenarios(baseInput());
    const keys = JSON.stringify(r, (k, v) => v).match(/"[A-Za-z]*[Pp]robab[A-Za-z]*":/g);
    expect(keys).toBeNull();
  });
  it('one-at-a-time sensitivity on central net cash', () => {
    const r = calculateScenarios(baseInput());
    const y = r.sensitivity.find((s) => s.input === 'yield')!;
    // yield low: 10000*0.9=9000 kg -> 270000 - 250000 - 9000*4.5 = -20500
    expect(y.netCashAtLowInputInrPerHa).toBe('-20500.00');
    const c = r.sensitivity.find((s) => s.input === 'cash_production_cost')!;
    expect(c.netCashAtLowInputInrPerHa).toBe('144250.00');
    expect(c.netCashAtHighInputInrPerHa).toBe('44250.00');
  });
  it('zero marketable yield: no break-even price, negative net equals costs', () => {
    const inp = baseInput();
    inp.yield!.amount = t(0, 0, 0);
    const r = calculateScenarios(inp);
    const c = central(r);
    expect(c.perHa.grossRevenueInr).toBe('0.00');
    expect(c.perHa.netCashReturnInr).toBe('-250000.00');
    expect(c.perHa.breakEvenPriceInrPerKg).toBeNull();
    expect(c.perHa.notes.join(' ')).toMatch(/zero marketable quantity/);
  });
  it('repeated harvest: quantity split by period with period prices', () => {
    const inp = baseInput();
    inp.harvests = [
      { periodId: 'synthetic-p1', period: { start: '2027-12-01', end: '2027-12-15' }, shareOfYield: 0.6 },
      { periodId: 'synthetic-p2', period: { start: '2028-01-01', end: '2028-01-15' }, shareOfYield: 0.4 },
    ];
    inp.prices = [inp.prices[0]!, { ...inp.prices[0]!, periodId: 'synthetic-p2', amount: t('15', '20', '25') }];
    const c = central(calculateScenarios(inp));
    expect(c.perHa.marketableQuantityKg).toEqual([{ periodId: 'synthetic-p1', kg: '8100.000' }, { periodId: 'synthetic-p2', kg: '5400.000' }]);
    expect(c.perHa.grossRevenueInr).toBe('351000.00'); // 8100*30 + 5400*20
  });
  it('rejects harvest shares that do not sum to 1', () => {
    const inp = baseInput();
    inp.harvests = [{ ...inp.harvests[0]!, shareOfYield: 0.7 }];
    const r = calculateScenarios(inp);
    expect(r.status).toBe('invalid');
    expect(r.errors[0]?.code).toBe('harvest_shares_not_unity');
  });
  it('unknown area: incomplete with per-ha results and no totals', () => {
    const inp = baseInput();
    inp.area = null;
    const r = calculateScenarios(inp);
    expect(r.status).toBe('incomplete');
    expect(r.missingInputs).toEqual(['area']);
    expect(central(r).perHa.netCashReturnInr).toBe('94250.00');
    expect(central(r).total).toBeNull();
  });
  it('missing yield or price basis: incomplete with no scenarios (no fabricated numbers)', () => {
    const a = baseInput();
    a.yield = null;
    expect(calculateScenarios(a)).toMatchObject({ status: 'incomplete', scenarios: [], missingInputs: ['yield'] });
    const b = baseInput();
    b.prices = [];
    expect(calculateScenarios(b)).toMatchObject({ status: 'incomplete', scenarios: [], missingInputs: ['price:synthetic-p1'] });
  });
  it('missing cost line: gross shown, net cash and break-even null', () => {
    const inp = baseInput();
    inp.costs.harvest = null;
    const r = calculateScenarios(inp);
    expect(r.status).toBe('incomplete');
    expect(central(r).perHa.grossRevenueInr).toBe('405000.00');
    expect(central(r).perHa.netCashReturnInr).toBeNull();
    expect(central(r).perHa.breakEvenPriceInrPerKg).toBeNull();
  });
  it('refuses fresh yield x dry price without a sourced conversion', () => {
    const inp = baseInput();
    inp.prices = [{ ...inp.prices[0]!, productBasis: 'dry', amount: t('120', '150', '180') }];
    const r = calculateScenarios(inp);
    expect(r.status).toBe('invalid');
    expect(r.errors.map((e) => e.code)).toEqual(['product_basis_mismatch']);
    expect(r.scenarios).toEqual([]);
  });
  it('fresh -> dry with a sourced conversion and processing cost', () => {
    const inp = baseInput();
    inp.prices = [{ ...inp.prices[0]!, productBasis: 'dry', amount: t('120', '150', '180') }];
    inp.conversion = { fromBasis: 'fresh', toBasis: 'dry', outputKgPerInputKg: t(0.15, 0.2, 0.25), processingCostInrPerOutputKg: t('8', '10', '12'), evidenceIds: ['synthetic-evidence-only'] };
    const r = calculateScenarios(inp);
    expect(r.status).toBe('complete');
    const c = central(r);
    expect(c.perHa.marketableKgTotal).toBe('2700.000');
    expect(c.perHa.grossRevenueInr).toBe('405000.00');
    expect(c.perHa.processingCostInr).toBe('27000.00');
    // 405000 - 250000 - 2700*3 - 2700*1.5 - 27000
    expect(c.perHa.netCashReturnInr).toBe('115850.00');
    expect(r.pricedBasis).toBe('dry');
  });
  it('rejects mixed price bases and negative costs', () => {
    const a = baseInput();
    a.harvests = [{ ...a.harvests[0]!, shareOfYield: 0.5 }, { periodId: 'synthetic-p2', period: { start: '2028-01-01', end: '2028-01-02' }, shareOfYield: 0.5 }];
    a.prices = [a.prices[0]!, { ...a.prices[0]!, periodId: 'synthetic-p2', productBasis: 'dry' }];
    expect(calculateScenarios(a).errors.map((e) => e.code)).toContain('mixed_price_basis');
    const b = baseInput();
    b.costs.cashProduction = { ...b.costs.cashProduction!, amountInr: t('-1', '0', '1') };
    expect(calculateScenarios(b).errors.map((e) => e.code)).toContain('negative_value');
  });
  it('INR/quintal price converts to INR/kg', () => {
    const inp = baseInput();
    inp.prices = [{ ...inp.prices[0]!, unit: 'INR/quintal', amount: t('2000', '3000', '4000') }];
    expect(central(calculateScenarios(inp)).perHa.grossRevenueInr).toBe('405000.00');
  });
  it('economic return does not double count costs included in the full cost', () => {
    const inp = baseInput();
    inp.costs.fullEconomic = { amountInrPerHa: t('300000', '320000', '340000'), definition: 'C2', includesHarvest: true, includesSaleAndTransport: false, evidenceIds: [] };
    const c = central(calculateScenarios(inp));
    // 405000 - 320000 - sale 20250 (harvest already in C2)
    expect(c.perHa.economicReturnInr).toBe('64750.00');
  });
  it('malformed input returns invalid, not an exception', () => {
    expect(calculateScenarios({ nonsense: true }).status).toBe('invalid');
  });
});
