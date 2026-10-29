import {
  EconomicsInput,
  type EconomicsFigures,
  type EconomicsResult,
  type ProductBasis,
  type ScenarioName,
} from '@harvest/contracts';
import { Decimal, convertDecimal, decString, inrString } from '../units';

/**
 * BUILD_SPEC 8.3 scenario economics (method economics-scenarios/1).
 *
 *   gross_revenue   = sum_t marketable_kg[t] * price_INR_per_kg[t]
 *   net_cash_return = gross - cash_production - harvest - sale_and_transport - processing
 *   economic_return = gross - full_economic_cost
 *                     - harvest (only if not included in the full cost definition)
 *                     - sale_and_transport (only if not included)
 *                     - processing (fresh->dry conversion cost; assumed outside cost-of-cultivation definitions)
 *
 * Assumptions documented in the result:
 * - "low" = low yield, low marketable fraction, low price, low conversion ratio, HIGH costs;
 *   "high" is the reverse; "central" uses central values; "yield_shortfall_price_rise"
 *   pairs a low local yield with a high price (regional shortage) at central costs.
 *   These are bounding stress cases with no probability attached.
 * - Break-even price is a single uniform INR/kg across all harvest periods.
 * - Break-even marketable yield is in kg of the PRICED product basis per ha.
 * - Yield and price bases must match; otherwise a sourced conversion is required.
 */
export const ECONOMICS_METHOD_VERSION = 'economics-scenarios/1';

type Input = ReturnType<typeof EconomicsInput.parse>;
type Pick3 = 'low' | 'central' | 'high';
interface Choice {
  yield: Pick3;
  mf: Pick3;
  price: Pick3;
  conv: Pick3;
  cost: Pick3;
}

const SCENARIOS: { name: ScenarioName; description: string; choice: Choice }[] = [
  { name: 'low', description: 'Low yield, low marketable fraction, low price, high costs (bounding stress case).', choice: { yield: 'low', mf: 'low', price: 'low', conv: 'low', cost: 'high' } },
  { name: 'central', description: 'Central values for every input.', choice: { yield: 'central', mf: 'central', price: 'central', conv: 'central', cost: 'central' } },
  { name: 'high', description: 'High yield, high marketable fraction, high price, low costs (bounding favourable case).', choice: { yield: 'high', mf: 'high', price: 'high', conv: 'high', cost: 'low' } },
  {
    name: 'yield_shortfall_price_rise',
    description: 'Paired stress: low local yield with a high price (regional shortage) at central costs. No joint probability is implied.',
    choice: { yield: 'low', mf: 'low', price: 'high', conv: 'central', cost: 'central' },
  },
];

const D = (v: Decimal.Value) => new Decimal(v);
const tri = (t: { low: Decimal.Value; central: Decimal.Value; high: Decimal.Value }, p: Pick3) => D(t[p]);

interface Err {
  code: string;
  message: string;
}

function validate(inp: Input): Err[] {
  const errs: Err[] = [];
  const neg = (t: { low: Decimal.Value } | null | undefined, name: string) => {
    if (t && D(t.low).isNeg()) errs.push({ code: 'negative_value', message: `${name} must be non-negative` });
  };
  if (inp.area && !D(inp.area.amount).gt(0)) errs.push({ code: 'invalid_area', message: 'area must be positive' });
  neg(inp.yield?.amount, 'yield');
  if (inp.marketableFraction) {
    neg(inp.marketableFraction, 'marketableFraction');
    if (D(inp.marketableFraction.high).gt(1)) errs.push({ code: 'invalid_fraction', message: 'marketableFraction must be <= 1' });
  }
  inp.prices.forEach((p) => neg(p.amount, `price ${p.periodId}`));
  for (const [k, c] of Object.entries(inp.costs)) {
    if (c && 'amountInr' in c) neg(c.amountInr, `costs.${k}`);
    if (c && 'amountInrPerHa' in c) neg(c.amountInrPerHa, `costs.${k}`);
  }
  if (inp.conversion) {
    neg(inp.conversion.outputKgPerInputKg, 'conversion ratio');
    neg(inp.conversion.processingCostInrPerOutputKg, 'processing cost');
  }
  const shareSum = inp.harvests.reduce((a, h) => a.add(h.shareOfYield), D(0));
  if (shareSum.sub(1).abs().gt('1e-9')) errs.push({ code: 'harvest_shares_not_unity', message: `harvest shares sum to ${shareSum.toString()}, expected 1` });
  const ids = inp.harvests.map((h) => h.periodId);
  if (new Set(ids).size !== ids.length) errs.push({ code: 'duplicate_period', message: 'duplicate harvest periodId' });
  const pricedIds = inp.prices.map((p) => p.periodId);
  if (new Set(pricedIds).size !== pricedIds.length) errs.push({ code: 'duplicate_price_period', message: 'more than one price for a period' });

  const bases = new Set(inp.prices.map((p) => p.productBasis));
  if (bases.size > 1) errs.push({ code: 'mixed_price_basis', message: `prices use multiple product bases: ${[...bases].join(', ')}` });
  const priced = [...bases][0];
  if (inp.yield && priced !== undefined && inp.yield.productBasis !== priced) {
    const c = inp.conversion;
    if (!c) {
      errs.push({ code: 'product_basis_mismatch', message: `yield is ${inp.yield.productBasis} but price is ${priced}; a sourced conversion is required` });
    } else if (c.fromBasis !== inp.yield.productBasis || c.toBasis !== priced) {
      errs.push({ code: 'conversion_basis_mismatch', message: `conversion ${c.fromBasis}->${c.toBasis} does not map ${inp.yield.productBasis}->${priced}` });
    }
  }
  if (inp.yield && priced !== undefined && inp.yield.productBasis === priced && inp.conversion) {
    errs.push({ code: 'unexpected_conversion', message: 'conversion supplied but yield and price bases already match' });
  }
  return errs;
}

interface PerHaCalc {
  figures: EconomicsFigures;
  netCash: Decimal | null;
}

function computePerHa(inp: Input, ch: Choice, areaHa: Decimal): PerHaCalc {
  const notes: string[] = [];
  const yieldKgHa = convertDecimal(tri(inp.yield!.amount, ch.yield), inp.yield!.unit, 'kg/ha');
  const inputKg = yieldKgHa.mul(tri(inp.marketableFraction!, ch.mf)).mul(areaHa);
  let marketKg = inputKg;
  let processing = D(0);
  let processingPerKg = D(0);
  if (inp.conversion) {
    marketKg = inputKg.mul(tri(inp.conversion.outputKgPerInputKg, ch.conv));
    processingPerKg = tri(inp.conversion.processingCostInrPerOutputKg, ch.cost);
    processing = marketKg.mul(processingPerKg);
    notes.push(`Converted ${inp.conversion.fromBasis} to ${inp.conversion.toBasis} using a sourced ratio.`);
  }
  const priceByPeriod = new Map(inp.prices.map((p) => [p.periodId, p]));
  const periods = inp.harvests.map((h) => {
    const p = priceByPeriod.get(h.periodId)!;
    const priceKg = convertDecimal(tri(p.amount, ch.price), p.unit, 'INR/kg');
    return { periodId: h.periodId, kg: marketKg.mul(h.shareOfYield), priceKg, share: D(h.shareOfYield) };
  });
  const gross = periods.reduce((a, p) => a.add(p.kg.mul(p.priceKg)), D(0));

  // Fixed (per ha * area) and variable (per marketable kg) parts of each cost line.
  const line = (c: Input['costs']['cashProduction']) => {
    if (!c) return null;
    const amt = tri(c.amountInr, ch.cost);
    return c.basis === 'per_ha' ? { total: amt.mul(areaHa), fixed: amt.mul(areaHa), perKg: D(0) } : { total: amt.mul(marketKg), fixed: D(0), perKg: amt };
  };
  const cash = line(inp.costs.cashProduction);
  const harvest = line(inp.costs.harvest);
  const sale = line(inp.costs.saleAndTransport);
  const allCosts = cash && harvest && sale;
  const netCash = allCosts ? gross.sub(cash.total).sub(harvest.total).sub(sale.total).sub(processing) : null;

  let economic: Decimal | null = null;
  const fe = inp.costs.fullEconomic;
  if (fe) {
    const needHarvest = !fe.includesHarvest;
    const needSale = !fe.includesSaleAndTransport;
    if ((!needHarvest || harvest) && (!needSale || sale)) {
      economic = gross
        .sub(tri(fe.amountInrPerHa, ch.cost).mul(areaHa))
        .sub(needHarvest ? harvest!.total : 0)
        .sub(needSale ? sale!.total : 0)
        .sub(processing);
    } else {
      notes.push('Economic return not computed: full cost excludes harvest or sale costs that are missing.');
    }
  }

  let bePrice: Decimal | null = null;
  let beYield: Decimal | null = null;
  if (allCosts) {
    const fixed = cash.fixed.add(harvest.fixed).add(sale.fixed);
    const varPerKg = cash.perKg.add(harvest.perKg).add(sale.perKg).add(processingPerKg);
    if (marketKg.gt(0)) {
      bePrice = fixed.div(marketKg).add(varPerKg);
    } else {
      notes.push('Break-even price undefined: zero marketable quantity.');
    }
    const avgPrice = periods.reduce((a, p) => a.add(p.share.mul(p.priceKg)), D(0));
    const margin = avgPrice.sub(varPerKg);
    if (margin.gt(0)) beYield = fixed.div(margin).div(areaHa);
    else notes.push('Break-even yield undefined: price does not exceed per-kg variable cost.');
  }

  const figures: EconomicsFigures = {
    marketableQuantityKg: periods.map((p) => ({ periodId: p.periodId, kg: decString(p.kg, 3) })),
    marketableKgTotal: decString(marketKg, 3),
    grossRevenueInr: inrString(gross),
    cashProductionCostInr: cash ? inrString(cash.total) : null,
    harvestCostInr: harvest ? inrString(harvest.total) : null,
    saleAndTransportCostInr: sale ? inrString(sale.total) : null,
    processingCostInr: inrString(processing),
    netCashReturnInr: netCash ? inrString(netCash) : null,
    economicReturnInr: economic ? inrString(economic) : null,
    breakEvenPriceInrPerKg: bePrice ? decString(bePrice, 2) : null,
    breakEvenMarketableYieldKgPerHa: beYield ? decString(beYield, 3) : null,
    notes,
  };
  return { figures, netCash };
}

export function calculateScenarios(raw: unknown): EconomicsResult {
  const base = {
    schemaVersion: '1.0' as const,
    methodVersion: ECONOMICS_METHOD_VERSION,
    evidenceState: 'scenario' as const,
  };
  const parsed = EconomicsInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ...base,
      status: 'invalid',
      pricedBasis: null,
      missingInputs: [],
      errors: parsed.error.issues.map((i) => ({ code: 'schema_invalid', message: `${i.path.join('.') || '(root)'}: ${i.message}` })),
      scenarios: [],
      sensitivity: [],
      unpricedItems: [],
      assumptions: [],
    };
  }
  const inp = parsed.data;
  const pricedBasis: ProductBasis | null = inp.prices[0]?.productBasis ?? null;
  const assumptions = [
    'Low/high scenarios are bounding combinations, not probabilities; no probability of loss is computed.',
    'Break-even price is a uniform INR/kg across harvest periods.',
    'Processing (product conversion) cost is treated as outside cost-of-cultivation definitions.',
  ];
  const unpricedItems = [...inp.unpricedItems];
  if (!inp.costs.fullEconomic) unpricedItems.push('full_economic_cost');

  const errors = validate(inp);
  if (errors.length > 0) {
    return { ...base, status: 'invalid', pricedBasis, missingInputs: [], errors, scenarios: [], sensitivity: [], unpricedItems, assumptions };
  }

  const missingInputs: string[] = [];
  if (!inp.area) missingInputs.push('area');
  if (!inp.yield) missingInputs.push('yield');
  if (!inp.marketableFraction) missingInputs.push('marketableFraction');
  const priced = new Set(inp.prices.map((p) => p.periodId));
  for (const h of inp.harvests) if (!priced.has(h.periodId)) missingInputs.push(`price:${h.periodId}`);
  if (!inp.costs.cashProduction) missingInputs.push('costs.cashProduction');
  if (!inp.costs.harvest) missingInputs.push('costs.harvest');
  if (!inp.costs.saleAndTransport) missingInputs.push('costs.saleAndTransport');

  const canCompute = inp.yield && inp.marketableFraction && missingInputs.every((m) => !m.startsWith('price:'));
  if (!canCompute) {
    return { ...base, status: 'incomplete', pricedBasis, missingInputs, errors: [], scenarios: [], sensitivity: [], unpricedItems, assumptions };
  }

  const areaHa = inp.area ? convertDecimal(inp.area.amount, inp.area.unit, 'ha') : null;
  const scenarios = SCENARIOS.map((s) => ({
    name: s.name,
    description: s.description,
    perHa: computePerHa(inp, s.choice, D(1)).figures,
    total: areaHa ? computePerHa(inp, s.choice, areaHa).figures : null,
  }));
  if (!areaHa) assumptions.push('Area unknown: results are per hectare only; totals are not computed.');

  const central: Choice = SCENARIOS[1]!.choice;
  const sens = (input: 'yield' | 'price' | 'marketable_fraction' | 'cash_production_cost', key: keyof Choice) => {
    const at = (p: Pick3) => {
      const n = computePerHa(inp, { ...central, [key]: p }, D(1)).netCash;
      return n ? inrString(n) : null;
    };
    if (input === 'cash_production_cost') {
      // Only cash cost varies; other cost lines stay central.
      const cashOnly = (p: Pick3) => {
        const c = inp.costs.cashProduction;
        if (!c) return null;
        const modified = { ...inp, costs: { ...inp.costs, cashProduction: { ...c, amountInr: { low: c.amountInr[p], central: c.amountInr[p], high: c.amountInr[p] } } } };
        const n = computePerHa(modified, central, D(1)).netCash;
        return n ? inrString(n) : null;
      };
      return { input, netCashAtLowInputInrPerHa: cashOnly('low'), netCashAtHighInputInrPerHa: cashOnly('high') };
    }
    return { input, netCashAtLowInputInrPerHa: at('low'), netCashAtHighInputInrPerHa: at('high') };
  };
  const sensitivity = [sens('yield', 'yield'), sens('price', 'price'), sens('marketable_fraction', 'mf'), sens('cash_production_cost', 'cost')];

  return {
    ...base,
    status: missingInputs.length === 0 ? 'complete' : 'incomplete',
    pricedBasis,
    missingInputs,
    errors: [],
    scenarios,
    sensitivity,
    unpricedItems,
    assumptions,
  };
}
