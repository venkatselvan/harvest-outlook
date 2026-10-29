import { z } from 'zod';
import { DateRange, DecimalString, EvidenceState, Id, NumericLike, SchemaVersion } from './common';
import { ProductBasis } from './identity';

/**
 * BUILD_SPEC 8.3 scenario economics contract. Low/central/high triples must be
 * ordered (low <= central <= high). The "low" scenario combines low yield, low
 * price and HIGH costs; "high" the reverse. These are bounding stress cases, not
 * probabilities. No probability of loss is produced.
 */
export const Triple = z
  .object({ low: NumericLike, central: NumericLike, high: NumericLike })
  .strict()
  .refine((t) => Number(t.low) <= Number(t.central) && Number(t.central) <= Number(t.high), {
    message: 'triple must satisfy low <= central <= high',
  });
export type Triple = z.infer<typeof Triple>;

export const CostBasis = z.enum(['per_ha', 'per_kg_marketable']);

export const CostLine = z
  .object({ basis: CostBasis, amountInr: Triple, evidenceIds: z.array(Id), definition: z.string().min(1) })
  .strict();

export const EconomicsInput = z
  .object({
    schemaVersion: SchemaVersion,
    productId: Id,
    area: z.object({ amount: NumericLike, unit: z.enum(['ha', 'acre']) }).strict().nullable(),
    yield: z
      .object({
        productBasis: ProductBasis,
        unit: z.enum(['kg/ha', 'kg/acre']),
        amount: Triple,
        evidenceState: EvidenceState,
        evidenceIds: z.array(Id),
      })
      .strict()
      .nullable(),
    /** Fraction of harvested quantity that is sold after grading and losses (0..1). */
    marketableFraction: Triple.nullable(),
    /** Repeated harvests: shares of total yield per harvest period; must sum to 1. */
    harvests: z.array(z.object({ periodId: Id, period: DateRange, shareOfYield: z.number().min(0).max(1) }).strict()).min(1),
    prices: z.array(
      z
        .object({
          periodId: Id,
          productBasis: ProductBasis,
          unit: z.enum(['INR/kg', 'INR/quintal']),
          amount: Triple,
          evidenceState: EvidenceState,
          marketId: Id.nullable(),
          evidenceIds: z.array(Id),
        })
        .strict(),
    ),
    /** Required when yield basis differs from price basis (e.g. fresh -> dry). Sourced only. */
    conversion: z
      .object({
        fromBasis: ProductBasis,
        toBasis: ProductBasis,
        outputKgPerInputKg: Triple,
        processingCostInrPerOutputKg: Triple,
        evidenceIds: z.array(Id).min(1),
      })
      .strict()
      .nullable(),
    costs: z
      .object({
        cashProduction: CostLine.nullable(),
        harvest: CostLine.nullable(),
        saleAndTransport: CostLine.nullable(),
        fullEconomic: z
          .object({
            amountInrPerHa: Triple,
            definition: z.enum(['A2+FL', 'C2', 'C3', 'farmer_defined', 'other_documented']),
            includesHarvest: z.boolean(),
            includesSaleAndTransport: z.boolean(),
            evidenceIds: z.array(Id),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    unpricedItems: z.array(z.string().min(1)),
  })
  .strict();
export type EconomicsInput = z.input<typeof EconomicsInput>;

export const EconomicsFigures = z
  .object({
    marketableQuantityKg: z.array(z.object({ periodId: Id, kg: DecimalString }).strict()),
    marketableKgTotal: DecimalString,
    grossRevenueInr: DecimalString,
    cashProductionCostInr: DecimalString.nullable(),
    harvestCostInr: DecimalString.nullable(),
    saleAndTransportCostInr: DecimalString.nullable(),
    processingCostInr: DecimalString,
    netCashReturnInr: DecimalString.nullable(),
    economicReturnInr: DecimalString.nullable(),
    breakEvenPriceInrPerKg: DecimalString.nullable(),
    breakEvenMarketableYieldKgPerHa: DecimalString.nullable(),
    notes: z.array(z.string()),
  })
  .strict();
export type EconomicsFigures = z.infer<typeof EconomicsFigures>;

export const ScenarioName = z.enum(['low', 'central', 'high', 'yield_shortfall_price_rise']);
export type ScenarioName = z.infer<typeof ScenarioName>;

export const EconomicsResult = z
  .object({
    schemaVersion: SchemaVersion,
    methodVersion: z.string().min(1),
    status: z.enum(['complete', 'incomplete', 'invalid']),
    evidenceState: z.literal('scenario'),
    pricedBasis: ProductBasis.nullable(),
    missingInputs: z.array(z.string().min(1)),
    errors: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
    scenarios: z.array(
      z
        .object({
          name: ScenarioName,
          description: z.string().min(1),
          perHa: EconomicsFigures,
          total: EconomicsFigures.nullable(),
        })
        .strict(),
    ),
    /** One-at-a-time sensitivity of central net cash return per ha. */
    sensitivity: z.array(
      z.object({ input: z.enum(['yield', 'price', 'marketable_fraction', 'cash_production_cost']), netCashAtLowInputInrPerHa: DecimalString.nullable(), netCashAtHighInputInrPerHa: DecimalString.nullable() }).strict(),
    ),
    unpricedItems: z.array(z.string()),
    assumptions: z.array(z.string()),
  })
  .strict();
export type EconomicsResult = z.infer<typeof EconomicsResult>;
