import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {REPO_ROOT} from '../../catalogue/files';

/**
 * Residue, energy and emission references for the Today economics and footprint blocks (read-only;
 * docs/research/TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 5). The file is written by research (Packet A1); this module only
 * reads it, in the style of services/year-plan/data.ts: unknown fields are ignored, a malformed crop row (or a malformed
 * nested figure, constant or list entry) is skipped and recorded in loadIssues(), and nothing is repaired, imputed or
 * invented. A missing figure stays null: "a missing value means no cited figure was found; it never means zero".
 *
 * Parsed data is cached in module scope; invalidate() clears it and can inject a raw fixture object (tests) in place of the
 * file. A missing or unparseable file throws (the Today view's guard turns that into null blocks plus a limitation).
 */
export const FOOTPRINT_FILE = 'data/research/footprint/crop-footprint.json';

const issues: string[] = [];
/** What the last load skipped, in file order ("crops[3] skipped: residue.rpr.low expected number"). */
export const loadIssues = (): readonly string[] => issues;

const where = (e: z.ZodError) => `${e.issues[0]?.path.join('.') ?? ''} ${e.issues[0]?.message ?? 'invalid'}`.trim();
function tolerantArray<T extends z.ZodType>(schema: T, label: string) {
  return z.array(z.unknown()).nullable().optional().transform((xs) => (xs ?? []).flatMap((x, i) => {
    const r = schema.safeParse(x);
    if (r.success) return [r.data as z.output<T>];
    issues.push(`${label}[${i}] skipped: ${where(r.error)}`);
    return [];
  }));
}
/**
 * A figure the file records as not found: an object whose numeric fields (value, low, high, ch4, n2o) are all null. It is a
 * documented gap, not a malformed figure, so it becomes null without a load issue.
 */
const FIGURE_KEYS = ['value', 'low', 'high', 'ch4', 'n2o'] as const;
function unsourced(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const present = FIGURE_KEYS.filter((k) => k in (v as Record<string, unknown>));
  return present.length > 0 && present.every((k) => (v as Record<string, unknown>)[k] === null);
}
/** Optional nested object: a malformed value becomes null and is recorded instead of failing the row. */
function soft<T extends z.ZodType>(schema: T, label: string) {
  return z.unknown().optional().transform((v): z.output<T> | null => {
    if (v === null || v === undefined || unsourced(v)) return null;
    const r = schema.safeParse(v);
    if (r.success) return r.data as z.output<T>;
    issues.push(`${label} ignored: ${where(r.error)}`);
    return null;
  });
}
const optStr = z.string().nullable().optional().transform((v) => v ?? null);
const optNum = z.number().finite().nullable().optional().transform((v) => v ?? null);
const nonNeg = z.number().finite().nonnegative();

// ------------------------------------------------------------------ schemas (section 5)

const ordered = <T extends {low: number; high: number}>(r: T) => r.low <= r.high;
/**
 * Further sources a figure was read from or checked against (the file's `additionalSourceIds`); kept so the engine can cite
 * them beside the primary `sourceId`. A malformed list becomes empty (nothing is invented).
 */
const extraIds = z.array(z.string().min(1)).nullable().optional().catch(null).transform((v) => v ?? []);
const cited = {sourceId: optStr, locator: optStr, note: optStr, additionalSourceIds: extraIds};
/** A low/high range with its source; both bounds present and low <= high, or the figure is skipped. */
const Range = z.object({low: nonNeg, high: nonNeg, ...cited}).refine(ordered, 'low above high');
/** A low/central/high factor (central optional). */
const Factor = z.object({low: nonNeg, central: optNum, high: nonNeg}).refine(ordered, 'low above high');
const Value = z.object({value: z.number().finite().positive(), ...cited});
const share01 = z.number().min(0).max(1);
const Share = z.object({low: share01, high: share01}).refine(ordered, 'low above high');
const CitedShare = z.object({low: share01, high: share01, ...cited}).refine(ordered, 'low above high');

const Constants = z.object({
  gwp100: soft(z.object({ch4: z.number().positive(), n2o: z.number().positive(), sourceId: optStr, locator: optStr, note: optStr}), 'constants.gwp100'),
  n2oNToN2o: soft(Value, 'constants.n2oNToN2o'),
  cToCo2: soft(Value, 'constants.cToCo2'),
  biomassCarbonFraction: soft(CitedShare, 'constants.biomassCarbonFraction'),
  riceMethaneBaselineKgPerHaDay: soft(z.object({low: nonNeg, central: optNum, high: nonNeg, ...cited}).refine(ordered, 'low above high'), 'constants.riceMethaneBaselineKgPerHaDay'),
  riceWaterRegimeScaling: soft(z.object({
    continuouslyFlooded: soft(Factor, 'constants.riceWaterRegimeScaling.continuouslyFlooded'),
    singleDrainage: soft(Factor, 'constants.riceWaterRegimeScaling.singleDrainage'),
    multipleDrainage: soft(Factor, 'constants.riceWaterRegimeScaling.multipleDrainage'),
    rainfedRegular: soft(Factor, 'constants.riceWaterRegimeScaling.rainfedRegular'),
    rainfedDroughtProne: soft(Factor, 'constants.riceWaterRegimeScaling.rainfedDroughtProne'),
    /** IPCC aggregated cases (drainage practice unknown within irrigated or rainfed). */
    aggregatedIrrigated: soft(Factor, 'constants.riceWaterRegimeScaling.aggregatedIrrigated'),
    aggregatedRainfed: soft(Factor, 'constants.riceWaterRegimeScaling.aggregatedRainfed'),
    sourceId: optStr, locator: optStr,
  }), 'constants.riceWaterRegimeScaling'),
  /** IPCC SF_p (water regime before the season, Table 5.13); `aggregated` is the IPCC default when that regime is unknown. */
  ricePreSeasonWaterScaling: soft(z.object({
    aggregated: soft(Factor, 'constants.ricePreSeasonWaterScaling.aggregated'), sourceId: optStr, locator: optStr, note: optStr,
  }), 'constants.ricePreSeasonWaterScaling'),
  ricePreSeasonStrawScaling: soft(z.object({
    none: soft(Factor, 'constants.ricePreSeasonStrawScaling.none'),
    strawShortBefore: soft(Factor, 'constants.ricePreSeasonStrawScaling.strawShortBefore'),
    strawLongBefore: soft(Factor, 'constants.ricePreSeasonStrawScaling.strawLongBefore'),
    /** Present when the file gives only IPCC Equation 5.3 (SF_o depends on the straw rate) instead of fixed factors. */
    equation: optStr,
    sourceId: optStr, locator: optStr, note: optStr,
  }), 'constants.ricePreSeasonStrawScaling'),
  n2oEf1: soft(z.object({
    default: soft(Factor, 'constants.n2oEf1.default'), floodedRice: soft(Factor, 'constants.n2oEf1.floodedRice'), sourceId: optStr, locator: optStr,
  }), 'constants.n2oEf1'),
  residueBurning: soft(z.object({
    ch4GPerKgDm: z.number().positive(), n2oGPerKgDm: z.number().positive(), combustionFactor: Share,
    /**
     * IPCC 2006 Table 2.6 combustion factors by residue (keys as the file writes them: rice, maize, wheat, sugarcane). An entry
     * that is not a number in 0..1 is skipped and recorded; the engine uses the envelope `combustionFactor` for other residues.
     */
    combustionFactorByResidue: z.record(z.string(), z.unknown()).nullable().optional().transform((rec) => Object.fromEntries(Object.entries(rec ?? {}).flatMap(([k, v]) => {
      const r = share01.safeParse(v);
      if (r.success) return [[k.trim().toLowerCase(), r.data] as const];
      issues.push(`constants.residueBurning.combustionFactorByResidue.${k} skipped: expected a number from 0 to 1`);
      return [];
    })) as Record<string, number>),
    sourceId: optStr, locator: optStr, note: optStr,
  }), 'constants.residueBurning'),
  dieselKgCo2PerLitre: soft(Value, 'constants.dieselKgCo2PerLitre'),
  /** Null bounds mean "not sourced" (the file records the gap); only both bounds with a source id are used. */
  ureaManufactureKgCo2ePerKgN: soft(z.object({low: optNum, high: optNum, sourceId: optStr, locator: optStr, note: optStr}), 'constants.ureaManufactureKgCo2ePerKgN'),
  lpgMjPerKg: soft(Value, 'constants.lpgMjPerKg'),
  lpgCylinderKg: soft(Value, 'constants.lpgCylinderKg'),
  dieselMjPerLitre: soft(Value, 'constants.dieselMjPerLitre'),
  methaneKgPerM3: soft(Value, 'constants.methaneKgPerM3'),
  cbgMethaneShare: soft(CitedShare, 'constants.cbgMethaneShare'),
  /** Not in the section 5 example: read only when research finds a cited soil retention share of residue carbon. */
  residueCarbonRetentionFraction: soft(CitedShare, 'constants.residueCarbonRetentionFraction'),
}).prefault({});

/**
 * Nitrogen rate rows also carry an optional `doseKind`: "recommended" (the default when absent) or "contingency_partial" (a
 * contingency or part dose, not the full recommendation). Kept as written; footprint.ts reads it (and falls back to the note
 * only when it is absent or not one of the two values).
 */
const RegionRange = z.object({region: z.string().min(1), low: nonNeg, high: nonNeg, ...cited, doseKind: optStr}).refine(ordered, 'low above high');
const RegionShare = z.object({region: z.string().min(1), low: share01, high: share01, ...cited}).refine(ordered, 'low above high');
const ResidueUse = z.object({
  use: z.enum(['cbg_feedstock', 'dry_fodder', 'biomass_fuel', 'mushroom_substrate', 'soil_incorporation', 'other']),
  label: z.string().min(1),
  /** A printed share of the surplus this use takes (one number or a low/high range); null = the whole surplus. */
  share: z.union([share01.transform((v) => ({low: v, high: v})), Share]).nullable().optional().transform((v) => v ?? null),
  priceInrPerTonne: soft(Range, 'residue.uses.priceInrPerTonne'),
  priceBasis: optStr, sourceId: optStr, locator: optStr, note: optStr,
});
const Residue = z.object({
  name: z.string().min(1),
  /** Product id the residue-to-product ratio is defined on (for example paddy-grain). */
  productBasis: z.string().min(1),
  rpr: Range,
  surplusFraction: tolerantArray(RegionShare, 'residue.surplusFraction'),
  calorificValueMJPerKg: soft(Range, 'residue.calorificValueMJPerKg'),
  biogasM3PerTonneDm: soft(z.object({low: nonNeg, high: nonNeg, ...cited, methaneShare: Share.nullable().optional().transform((v) => v ?? null)}).refine(ordered, 'low above high'), 'residue.biogasM3PerTonneDm'),
  uses: tolerantArray(ResidueUse, 'residue.uses'),
});
const EnergyInput = z.object({
  gjPerHa: z.object({low: optNum, high: optNum}).nullable().optional().transform((v) => v ?? null),
  region: optStr, year: z.union([z.string(), z.number()]).nullable().optional().transform((v) => (v === null || v === undefined ? null : String(v))),
  sourceId: optStr, locator: optStr, note: optStr, additionalSourceIds: extraIds,
  breakdown: tolerantArray(z.object({item: z.string().min(1), share: share01}), 'energyInput.breakdown'),
  dieselLitresPerHa: z.object({low: optNum, high: optNum}).nullable().optional().transform((v) => v ?? null),
});
const CropRow = z.object({
  cropId: z.string().min(1),
  /** Null when research found no residue figure for the crop. */
  residue: soft(Residue, 'residue'),
  nitrogenRateKgPerHa: tolerantArray(RegionRange, 'nitrogenRateKgPerHa'),
  energyInput: soft(EnergyInput, 'energyInput'),
  methane: soft(z.object({applies: z.boolean(), note: optStr}), 'methane'),
  notes: z.array(z.string()).nullable().optional().catch(null).transform((v) => v ?? []),
});
const SourceMeta = z.object({url: optStr, title: optStr, publisher: optStr, locator: optStr, retrievedAt: optStr});
const FootprintFile = z.object({
  generatedAt: optStr,
  status: optStr,
  constants: Constants,
  crops: tolerantArray(CropRow, 'crops'),
  sources: z.record(z.string(), z.unknown()).nullable().optional().transform((rec) => new Map(Object.entries(rec ?? {}).flatMap(([k, v]) => {
    const r = SourceMeta.safeParse(v);
    if (r.success) return [[k, r.data] as const];
    issues.push(`sources.${k} skipped: ${where(r.error)}`);
    return [];
  }))),
});

export type FootprintConstants = z.output<typeof Constants>;
export type FootprintCrop = z.output<typeof CropRow>;
export type FootprintResidue = z.output<typeof Residue>;
export type FootprintData = z.output<typeof FootprintFile>;
export type FactorRange = z.output<typeof Factor>;

// ------------------------------------------------------------------ cache and fixtures

let fixture: unknown | null = null;
let cache: {data?: FootprintData; index?: Map<string, FootprintCrop>} = {};

/** Clears the module cache. With `next`, later loads parse that raw object instead of the file (tests). */
export function invalidate(next?: unknown): void {
  cache = {};
  fixture = next ?? null;
  issues.length = 0;
}

/** The parsed file. Throws when the file is missing or its top level is not an object of the section 5 shape. */
export function loadFootprint(): FootprintData {
  if (cache.data) return cache.data;
  const raw = fixture ?? JSON.parse(readFileSync(resolve(REPO_ROOT, FOOTPRINT_FILE), 'utf8'));
  const parsed = FootprintFile.parse(raw);
  const seen = new Set<string>();
  const crops = parsed.crops.filter((c, i) => {
    if (!seen.has(c.cropId)) { seen.add(c.cropId); return true; }
    issues.push(`crops[${i}] skipped: duplicate cropId ${c.cropId}`);
    return false;
  });
  return (cache.data = {...parsed, crops});
}

const index = () => (cache.index ??= new Map(loadFootprint().crops.map((c) => [c.cropId, c])));
export const footprintCrop = (cropId: string): FootprintCrop | null => index().get(cropId) ?? null;
export const footprintCrops = (): readonly FootprintCrop[] => loadFootprint().crops;
export const footprintConstants = (): FootprintConstants => loadFootprint().constants;

export interface FootprintSource { id: string; url: string | null; title: string | null; publisher: string | null; locator: string | null }
const validUrl = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try { return new URL(u).protocol.startsWith('http') ? u : null; } catch { return null; }
};
/** Source register entry for an id (url only when it is a valid http(s) URL); null for a null id. */
export function footprintSource(id: string | null | undefined): FootprintSource | null {
  if (!id) return null;
  const s = loadFootprint().sources.get(id);
  return {id, url: validUrl(s?.url), title: s?.title ?? null, publisher: s?.publisher ?? null, locator: s?.locator ?? null};
}
