import Decimal from 'decimal.js';
import { Unit } from '@harvest/contracts';

/**
 * Unit conversion with tested constants. Conversions are exact decimal
 * arithmetic; incompatible dimensions throw. A missing unit is never inferred.
 *
 * Constants:
 * - 1 acre = 0.40468564224 ha (international acre, exact)
 * - 1 quintal = 100 kg (Indian usage); 1 t = 1000 kg
 * - 1 m3 = 1000 L
 * - 1 mm of water over 1 ha = 10 m3 = 10,000 L
 */
export const HA_PER_ACRE = new Decimal('0.40468564224');
export const KG_PER_QUINTAL = new Decimal(100);
export const KG_PER_TONNE = new Decimal(1000);
export const LITRES_PER_M3 = new Decimal(1000);
export const LITRES_PER_MM_HA = new Decimal(10000);

export type Dimension = 'area' | 'mass' | 'currency' | 'price_per_mass' | 'cost_per_area' | 'depth' | 'volume' | 'yield' | 'time' | 'temperature' | 'ratio';

/** Each unit: dimension and factor to the canonical unit of that dimension. */
const UNIT_TABLE: Record<Unit, { dim: Dimension; toCanonical: Decimal }> = {
  ha: { dim: 'area', toCanonical: new Decimal(1) },
  acre: { dim: 'area', toCanonical: HA_PER_ACRE },
  kg: { dim: 'mass', toCanonical: new Decimal(1) },
  quintal: { dim: 'mass', toCanonical: KG_PER_QUINTAL },
  t: { dim: 'mass', toCanonical: KG_PER_TONNE },
  INR: { dim: 'currency', toCanonical: new Decimal(1) },
  'INR/kg': { dim: 'price_per_mass', toCanonical: new Decimal(1) },
  'INR/quintal': { dim: 'price_per_mass', toCanonical: new Decimal(1).div(KG_PER_QUINTAL) },
  'INR/ha': { dim: 'cost_per_area', toCanonical: new Decimal(1) },
  mm: { dim: 'depth', toCanonical: new Decimal(1) },
  L: { dim: 'volume', toCanonical: new Decimal(1) },
  m3: { dim: 'volume', toCanonical: LITRES_PER_M3 },
  'kg/ha': { dim: 'yield', toCanonical: new Decimal(1) },
  'kg/acre': { dim: 'yield', toCanonical: new Decimal(1).div(HA_PER_ACRE) },
  days: { dim: 'time', toCanonical: new Decimal(1) },
  celsius: { dim: 'temperature', toCanonical: new Decimal(1) },
  percent: { dim: 'ratio', toCanonical: new Decimal(1) },
};

export const CANONICAL_UNIT: Record<Dimension, Unit> = {
  area: 'ha',
  mass: 'kg',
  currency: 'INR',
  price_per_mass: 'INR/kg',
  cost_per_area: 'INR/ha',
  depth: 'mm',
  volume: 'L',
  yield: 'kg/ha',
  time: 'days',
  temperature: 'celsius',
  ratio: 'percent',
};

export class UnitError extends Error {
  constructor(public readonly code: 'missing_unit' | 'unknown_unit' | 'incompatible_dimensions' | 'invalid_value', message: string) {
    super(message);
  }
}

export function requireUnit(u: unknown): Unit {
  if (u === null || u === undefined || u === '') throw new UnitError('missing_unit', 'unit is required and is never inferred from magnitude');
  const parsed = Unit.safeParse(u);
  if (!parsed.success) throw new UnitError('unknown_unit', `unknown unit: ${String(u)}`);
  return parsed.data;
}

export function dimensionOf(u: Unit): Dimension {
  return UNIT_TABLE[requireUnit(u)].dim;
}

export type DecimalInput = Decimal.Value;

function toDecimal(v: DecimalInput): Decimal {
  const d = new Decimal(v);
  if (!d.isFinite()) throw new UnitError('invalid_value', `non-finite value: ${String(v)}`);
  return d;
}

/** Exact decimal conversion. Throws on missing/unknown unit or incompatible dimensions. */
export function convertDecimal(value: DecimalInput, from: Unit | null | undefined, to: Unit | null | undefined): Decimal {
  const f = requireUnit(from);
  const t = requireUnit(to);
  const df = UNIT_TABLE[f];
  const dt = UNIT_TABLE[t];
  if (df.dim !== dt.dim) throw new UnitError('incompatible_dimensions', `incompatible dimensions: cannot convert ${f} (${df.dim}) to ${t} (${dt.dim})`);
  return toDecimal(value).mul(df.toCanonical).div(dt.toCanonical);
}

/** Number convenience wrapper over convertDecimal. */
export function convert(value: DecimalInput, from: Unit | null | undefined, to: Unit | null | undefined): number {
  return convertDecimal(value, from, to).toNumber();
}

/** Water depth over an area to volume: litres = mm * ha * 10,000. */
export function depthOverAreaToLitres(depthMm: DecimalInput, areaHa: DecimalInput): Decimal {
  return toDecimal(depthMm).mul(toDecimal(areaHa)).mul(LITRES_PER_MM_HA);
}

/** Dimensional self-check used by the water balance: 1 mm over 1 ha must equal 10,000 L. */
export function waterDimensionalCheck(): { litresPerMmHa: number; passed: boolean } {
  const l = depthOverAreaToLitres(1, 1);
  const viaM3 = new Decimal(1).div(1000).mul(10000).mul(LITRES_PER_M3); // 1 mm = 0.001 m; 1 ha = 10,000 m2
  return { litresPerMmHa: l.toNumber(), passed: l.eq(10000) && viaM3.eq(l) };
}

/* ---------- INR (decimal-safe) ---------- */

export function inr(v: DecimalInput): Decimal {
  return toDecimal(v);
}

/** Format INR to paise (2 dp, banker's rounding) as a DecimalString. */
export function inrString(v: Decimal): string {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
}

/** Generic fixed-precision decimal string. */
export function decString(v: Decimal, dp: number): string {
  return v.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp);
}

export function sumInr(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.add(toDecimal(v)), new Decimal(0));
}

export { Decimal };
