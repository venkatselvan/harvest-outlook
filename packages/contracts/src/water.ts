import { z } from 'zod';
import { Id, IsoDate, SchemaVersion } from './common';

/**
 * FAO-56 style single-coefficient daily root-zone water balance contract.
 * Kc is constant within each supplied stage (no linear interpolation across the
 * development stage); no soil evaporation split (dual Kc) and no capillary rise.
 */
export const EffectiveRainMethod = z.discriminatedUnion('method', [
  /** Peff = fraction * P (daily). */
  z.object({ method: z.literal('fixed_fraction'), fraction: z.number().min(0).max(1) }).strict(),
  /**
   * USDA-SCS simplified (as used in FAO CROPWAT) on calendar-month totals P (mm):
   * Peff = P * (125 - 0.2 P) / 125 for P <= 250, else 125 + 0.1 P. The monthly
   * ratio Peff/P is applied to each day of that month.
   */
  z.object({ method: z.literal('usda_scs_monthly') }).strict(),
]);
export type EffectiveRainMethod = z.infer<typeof EffectiveRainMethod>;

export const WaterDay = z
  .object({
    date: IsoDate,
    et0Mm: z.number().nonnegative().nullable(),
    et0Source: z.string().min(1).nullable(),
    rainMm: z.number().nonnegative().nullable(),
    /** climatology is a long-term normal, treated like forecast: it forces a scenario run. */
    rainState: z.enum(['observed', 'forecast', 'climatology', 'missing']),
  })
  .strict()
  .refine((d) => (d.rainState === 'missing') === (d.rainMm === null), { message: 'rainMm is null iff rainState is missing' });

export const WaterBalanceInput = z
  .object({
    schemaVersion: SchemaVersion,
    days: z.array(WaterDay).min(1),
    stages: z
      .array(z.object({ stageId: Id, start: IsoDate, end: IsoDate, kc: z.number().min(0).max(2), kcSource: z.string().min(1) }).strict())
      .min(1),
    rootZone: z
      .object({
        /** Total available water in the root zone (mm). Null = unknown soil capacity. */
        totalAvailableWaterMm: z.number().positive().nullable(),
        /** FAO-56 p: fraction of TAW that can be depleted before stress (RAW = p*TAW). */
        depletionFraction: z.number().gt(0).lt(1),
        initialDepletionMm: z.number().nonnegative(),
        basis: z.string().min(1),
      })
      .strict(),
    effectiveRain: EffectiveRainMethod,
    forecastRainPolicy: z.enum(['use_forecast', 'ignore_forecast']),
    /** Application efficiency (0,1]. Null = unknown; gross irrigation is then not reported. */
    irrigationEfficiency: z.number().gt(0).max(1).nullable(),
    areaHa: z.number().positive().nullable(),
    /** Labelled TAW scenarios, used only when totalAvailableWaterMm is null. */
    tawScenariosMm: z.array(z.number().positive()),
  })
  .strict();
export type WaterBalanceInput = z.infer<typeof WaterBalanceInput>;

export const WaterRun = z
  .object({
    label: z.string().min(1),
    evidenceState: z.enum(['derived', 'scenario']),
    tawMm: z.number().nullable(),
    etcMm: z.number(),
    effectiveRainMm: z.number(),
    effectiveRainFromForecastMm: z.number(),
    netIrrigationMm: z.number(),
    grossIrrigationMm: z.number().nullable(),
    grossLitresPerHa: z.number().nullable(),
    grossLitresTotal: z.number().nullable(),
    deepPercolationMm: z.number(),
    stressDays: z.number().int().nonnegative(),
    events: z.array(z.object({ date: IsoDate, netMm: z.number() }).strict()),
    daily: z.array(
      z
        .object({
          date: IsoDate,
          kc: z.number(),
          etcMm: z.number(),
          effectiveRainMm: z.number(),
          rainState: z.enum(['observed', 'forecast', 'climatology', 'missing']),
          irrigationNetMm: z.number(),
          depletionEndMm: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type WaterRun = z.infer<typeof WaterRun>;

export const WaterBalanceResult = z
  .object({
    schemaVersion: SchemaVersion,
    methodVersion: z.string().min(1),
    status: z.enum(['complete', 'incomplete', 'invalid']),
    evidenceState: z.enum(['derived', 'scenario']),
    missingInputs: z.array(z.string().min(1)),
    errors: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
    assumptions: z.array(z.string()),
    /** Initial policy: range_only whenever any run is a scenario or efficiency is unknown. */
    permittedPrecision: z.enum(['range_only', 'rounded_5mm']),
    dimensionalCheck: z.object({ litresPerMmHa: z.number(), passed: z.boolean() }).strict(),
    runs: z.array(WaterRun),
  })
  .strict();
export type WaterBalanceResult = z.infer<typeof WaterBalanceResult>;
