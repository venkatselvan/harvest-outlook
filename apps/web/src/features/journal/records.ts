/**
 * Farmer-recorded harvest pickings, stock on hand, water applied and fertiliser applications, per crop cycle. Pure functions over
 * the journal entries and crop records already loaded; no network, no AI. Every figure is a sum of what the farmer wrote down
 * (never an estimate), added exactly: quantities are bigint counts of 1/QUANTITY_SCALE units, as in `seasonTotals`, whose
 * attribution window (`attributeEntries`) and unit rules (`KG_PER_UNIT`) are reused rather than copied.
 */
import { KG_PER_UNIT, QUANTITY_SCALE, attributeEntries, scaledQuantity, type SeasonCycle, type SeasonEntry } from "./model";

export interface RecordEntry extends SeasonEntry {
  id?: string;
  note?: string | null;
}

// ---------------------------------------------------------------- exact decimals

/** An exact non-negative count of `1 / 10^scale` units as a decimal string without trailing zeros ("12.5", "0.004", "7"). */
export function decimalString(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
/** "12345.5" as "12,345.5" (Indian digit grouping on the whole part; the fraction is shown as it is, so nothing is rounded). */
export function formatDecimal(text: string): string {
  const [whole = "0", frac] = text.split(".");
  const grouped = BigInt(whole).toLocaleString("en-IN");
  return frac ? `${grouped}.${frac}` : grouped;
}

const day = (d: string) => d.slice(0, 10);
const byDate = <T extends { date: string }>(a: T, b: T) => a.date.localeCompare(b.date);

// ---------------------------------------------------------------- harvest pickings

export interface HarvestPicking {
  id?: string;
  date: string;
  /** The quantity as the farmer wrote it. */
  quantity: { value: number; unit: string };
  kg: number;
  /** Running total in kg up to and including this picking (pickings on the same date add in the order entered). */
  runningKg: number;
  note?: string;
}
export interface HarvestRecord {
  pickings: HarvestPicking[];
  /** Exact total of the convertible pickings (kg, quintal, t); null when there is none. */
  totalKg: number | null;
  /** Harvest entries in another unit (or with no quantity above zero) that are not added. */
  unitsSkipped: number;
}

const kgOf = (units: bigint) => Number(units) / QUANTITY_SCALE;

/** Harvest entries with a convertible quantity as a dated list with a running total; other-unit harvest quantities are only counted. */
export function harvestPickings(entries: readonly RecordEntry[]): HarvestRecord {
  const sorted = entries.filter((e) => e.activity === "harvest" && e.quantity).map((e) => ({ e, date: day(e.observedOn) })).sort(byDate);
  const pickings: HarvestPicking[] = [];
  let total = 0n;
  let skipped = 0;
  for (const { e, date } of sorted) {
    const q = e.quantity!;
    const factor = KG_PER_UNIT[q.unit];
    if (factor === undefined) {
      skipped += 1;
      continue;
    }
    const scaled = scaledQuantity(q.value);
    if (scaled === null) continue;
    const kg = scaled * factor;
    total += kg;
    pickings.push({ ...(e.id !== undefined ? { id: e.id } : {}), date, quantity: { value: q.value, unit: q.unit }, kg: kgOf(kg), runningKg: kgOf(total), ...(e.note ? { note: e.note } : {}) });
  }
  return { pickings, totalKg: pickings.length ? kgOf(total) : null, unitsSkipped: skipped };
}

// ---------------------------------------------------------------- stock on hand

export interface StockRecord {
  soldKg: number;
  /** Harvested minus sold, never below zero. */
  stockKg: number;
  /** True when the sold quantity is more than the recorded harvest (the stock then shows zero, not a negative number). */
  salesExceedHarvest: boolean;
  /** Sale entries with a quantity in another unit, which cannot be subtracted. */
  soldUnitsSkipped: number;
}

/**
 * Harvested minus sold, from the entries. Null (hide the line) unless at least one sale carries a quantity that converts to kg:
 * without one the stock would only repeat the harvest total, and a sale in an unconvertible unit cannot be subtracted.
 */
export function stockOnHand(entries: readonly RecordEntry[], harvestKg: number | null): StockRecord | null {
  let sold = 0n;
  let haveSold = false;
  let skipped = 0;
  for (const e of entries) {
    if (e.activity !== "sale" || !e.quantity) continue;
    const factor = KG_PER_UNIT[e.quantity.unit];
    if (factor === undefined) {
      skipped += 1;
      continue;
    }
    const q = scaledQuantity(e.quantity.value);
    if (q === null) continue;
    sold += q * factor;
    haveSold = true;
  }
  if (!haveSold) return null;
  // harvestKg came from exact ten-thousandths, so converting back is exact.
  const harvested = BigInt(Math.round((harvestKg ?? 0) * QUANTITY_SCALE));
  const exceeds = sold > harvested;
  return { soldKg: kgOf(sold), stockKg: exceeds ? 0 : kgOf(harvested - sold), salesExceedHarvest: exceeds, soldUnitsSkipped: skipped };
}

// ---------------------------------------------------------------- water applied

export interface WaterRecord {
  /** Irrigation entries counted in the window. */
  events: number;
  /** Sum of the entries in mm, an exact decimal string ("42.5"); null when none. mm and m3 are different families and are never added. */
  mm: string | null;
  /** Sum of the entries in L and m3 as m3 (L / 1000), an exact decimal string; null when none. */
  m3: string | null;
  /** The mm total as m3 (`mm × areaHa × 10`), only when the field area is known; the area is a measurement, so this is a number rounded to 0.1 m3, not an exact sum. */
  mmAsM3: number | null;
  /** Hectares used for mmAsM3. */
  areaHa: number | null;
  /** Irrigation entries with no quantity, or a quantity in another unit, which are not added. */
  skipped: number;
}

/** 1 L = 1/1000 m3 and the stored scale is 1/10 000 units, so litres are exact in 1/10^7 m3 and m3 are x1000. */
const M3_SCALE_DIGITS = 7;

/** Irrigation entries summed per unit family. mm to m3 only when `areaHa` is a positive number. */
export function waterApplied(entries: readonly RecordEntry[], areaHa?: number | null): WaterRecord {
  let mm = 0n;
  let haveMm = false;
  let m3 = 0n;
  let haveM3 = false;
  let events = 0;
  let skipped = 0;
  for (const e of entries) {
    if (e.activity !== "irrigation") continue;
    events += 1;
    const q = e.quantity ? scaledQuantity(e.quantity.value) : null;
    if (!e.quantity || q === null) {
      skipped += 1;
      continue;
    }
    if (e.quantity.unit === "mm") {
      mm += q;
      haveMm = true;
    } else if (e.quantity.unit === "L") {
      m3 += q;
      haveM3 = true;
    } else if (e.quantity.unit === "m3") {
      m3 += q * 1000n;
      haveM3 = true;
    } else skipped += 1;
  }
  const area = typeof areaHa === "number" && Number.isFinite(areaHa) && areaHa > 0 ? areaHa : null;
  const mmAsM3 = haveMm && area !== null ? Math.round((Number(mm) / QUANTITY_SCALE) * area * 10 * 10) / 10 : null;
  return { events, mm: haveMm ? decimalString(mm, 4) : null, m3: haveM3 ? decimalString(m3, M3_SCALE_DIGITS) : null, mmAsM3, areaHa: mmAsM3 === null ? null : area, skipped };
}

// ---------------------------------------------------------------- fertiliser

export interface FertiliserApplication {
  id?: string;
  date: string;
  note: string | null;
  /** As the farmer wrote it, in any unit; never converted. */
  quantity: { value: number; unit: string } | null;
}

/** Fertiliser or compost entries as a dated list. No recommendation, no conversion. */
export function fertiliserApplications(entries: readonly RecordEntry[]): FertiliserApplication[] {
  return entries
    .filter((e) => e.activity === "fertilizer")
    .map((e) => ({ ...(e.id !== undefined ? { id: e.id } : {}), date: day(e.observedOn), note: e.note?.trim() ? e.note.trim() : null, quantity: e.quantity ? { value: e.quantity.value, unit: e.quantity.unit } : null }))
    .sort(byDate);
}

// ---------------------------------------------------------------- per cycle

export interface CycleRecords {
  cycleId: string;
  cropId: string;
  cropName?: string;
  sowingDate: string;
  from: string;
  to: string;
  windowTo: string;
  ongoing: boolean;
  active: boolean;
  harvest: HarvestRecord;
  stock: StockRecord | null;
  water: WaterRecord;
  fertiliser: FertiliserApplication[];
}

export interface RecordsOptions {
  /** Field area in hectares by cycle id; a cycle without an entry gets no mm to m3 conversion. */
  areaHaByCycle?: Readonly<Record<string, number | null | undefined>>;
}

/** One record set per crop cycle, in the order of the season totals, from the entries inside each cycle's window (the same rule as `seasonTotals`). */
export function cycleRecords(entries: readonly RecordEntry[], cycles: readonly SeasonCycle[], today: string, opts: RecordsOptions = {}): CycleRecords[] {
  return attributeEntries(entries, cycles, today).map((r) => {
    const harvest = harvestPickings(r.entries);
    return {
      cycleId: r.c.id,
      cropId: r.c.cropId,
      ...(r.c.cropName !== undefined ? { cropName: r.c.cropName } : {}),
      sowingDate: day(r.c.sowingDate),
      from: r.from,
      to: r.to,
      windowTo: r.windowTo,
      ongoing: !r.c.harvestDate,
      active: r.active,
      harvest,
      stock: stockOnHand(r.entries, harvest.totalKg),
      water: waterApplied(r.entries, opts.areaHaByCycle?.[r.c.id]),
      fertiliser: fertiliserApplications(r.entries),
    };
  });
}
