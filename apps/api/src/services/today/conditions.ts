/**
 * Daily field conditions along the Today slider (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 10.1 item 4). Pure: one point
 * per day of the window from the weather track, the alerts, the usable NDVI readings, the stage timeline and the sourced
 * thresholds in data/research/footprint/field-conditions.json. Nothing here is seen on the field: every point is drawn
 * from weather records, forecasts and typical (climatology) weather, the farmer's alerts and the latest satellite reading.
 *
 * Rules (sources in the data file and docs/research/FOOTPRINT_SOURCES.md, section "Field conditions"):
 * - rain class: IMD daily rainfall classes, from each class's lower bound (inclusive): very light above 0 mm, light 2.5,
 *   moderate 15.6, heavy 64.5, very heavy 115.6, extremely heavy 204.5 mm; 0 mm is none; null rain is unknown;
 * - water, first rule that applies:
 *   1. flooded (crop_practice): inside the crop's sourced standing-water window (paddy, TNAU: from establishment for
 *      transplanted rice, from day 7 otherwise, until the drain date = earliest harvest minus the larger sourced drain lead);
 *   2. ponded (rain_rule): the day or one of the CONDITION_ASSUMPTIONS.pondHoldDays days before it had heavy rain or more,
 *      or a three-day total (that day and the two before) of at least WEATHER_THRESHOLDS.threeDayRainMm (100 mm, the alert
 *      threshold);
 *   3. moist / dry (model_soil_moisture, WEATHER_DEPTH_SPEC.md 6.2), only when the farm's soil texture is recorded and
 *      printed in FAO 56 Table 19: the day's grid-cell 0 to 7 cm soil moisture (`agro.soilMoisture0to7`, m3/m3) read as
 *      the end of stage-1 drying: at or above its wet end (fcHigh - rewLow / (1000 x 0.10 m)) moist, below its dry end
 *      (fcLow - rewHigh / (1000 x 0.10 m)) dry, in between no class. Where it classes a day it takes precedence over the
 *      rain rule (a dry cell overrides recent light rain). Without a texture the class is held back
 *      (CONDITION_ASSUMPTIONS.soilMoistureNoTexture): the value rides along, the state comes from rules 1, 2, 4, 5, 6.
 *      Soil moisture never yields ponded or flooded;
 *   4. moist (rain_rule): light rain or more that day or on one of the moistHoldDays days before;
 *   5. dry (none) when the day has a rain figure, 6. else unknown (none);
 * - pressure (wetness context, never a diagnosis): the higher class of mean leaf-wetness probability (high from 50%,
 *   moderate from 25%) and mean relative humidity (high from 90%, moderate from 80%), engine assumptions
 *   (CONDITION_ASSUMPTIONS.wetness) until the data file supplies sourced figures; VPD and gust are carried as values; gusts
 *   at or above the 60 km/h alert threshold (flagged, not a lodging figure) are counted in the limitations. Absent `agro`
 *   or `agro` without any of leaf wetness, humidity, VPD or gust (old rows with only ET0 or rain chance) gives no pressure
 *   block; with only VPD or gust the block has wetness unknown and basis none;
 * - heat: the crop's sourced threshold on days whose calendar stage matches the threshold's stage (rice 35 C at
 *   flowering); otherwise the project's 40 C alert threshold (WEATHER_THRESHOLDS.tMaxC, flagged); stress = tMax >= threshold;
 *   no tMax: stress false and a null threshold;
 * - greenness: the latest usable reading on or before the day, held (never interpolated); null before the first;
 * - events: alerts whose validity covers the day, warnings first, at most 5;
 * - stage: the calendar stage of the day and the share of that stage elapsed.
 * Every unsourced choice is in CONDITION_ASSUMPTIONS and surfaces as a `model` BasisRef and a limitation. The `agro` values
 * are Open-Meteo model estimates for the grid cell (D-W4), never field readings; an absent `agro` is read as all null.
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import type {BasisRef, FarmAlert, FieldConditionPoint, FieldConditions, RainClass, StageTimeline, WeatherPoint} from '@harvest/contracts';
import {REPO_ROOT} from '../../catalogue/files';
import {WEATHER_THRESHOLDS} from './alerts';
import {stageAt} from './stage-timeline';
import {irrigationClass} from '../year-plan/scoring';
import {factValue, type ScenarioFarm} from '../year-plan/scenario';

export const CONDITIONS_FILE = 'data/research/footprint/field-conditions.json';
const MAX_POINTS = 400;
const MAX_EVENTS = 5;

export const CONDITION_ASSUMPTIONS = {
  rainRule: {
    value: {pondFrom: 'heavy', threeDayMm: WEATHER_THRESHOLDS.threeDayRainMm, moistFrom: 'light'},
    text: 'Standing water from rain is inferred, not observed: the field is drawn ponded after heavy rain or more (IMD 64.5 mm a day) or a three-day total of 100 mm or more (the project\'s alert threshold), and moist after light rain or more. Drainage, soil and slope of this field are not known.',
  },
  pondHoldDays: {value: 2, text: 'Ponded water is drawn on the rain day and the 2 days after it, then the field dries (engine assumption, not sourced).'},
  moistHoldDays: {value: 2, text: 'A moist soil is drawn on the rain day and the 2 days after it (engine assumption, not sourced).'},
  defaultHeatC: {value: WEATHER_THRESHOLDS.tMaxC, text: 'Where no crop- and stage-specific heat threshold is sourced, heat stress is drawn when the daily maximum reaches 40 C, the project\'s heat alert threshold (not a crop figure).'},
  heatStageMatch: {value: 'stage name', text: 'A crop heat threshold sourced for one stage (rice: flowering) is applied on the days whose calendar stage name matches it (for the FAO stages, Mid-season); the calendar stage is an estimate.'},
  floodedWhenIrrigationUnknown: {value: true, text: 'The irrigation category of this field is not recorded, so the paddy standing-water practice (TNAU, irrigated lowland rice) is drawn; record the irrigation category to change this.'},
  drainLead: {value: 'high', text: 'Standing water in paddy is drawn until the earliest harvest date minus the larger sourced drain lead (10 of 7 to 10 days before harvest).'},
  // ---- weather depth, packet B (WEATHER_DEPTH_SPEC.md 6.2, 2026-11-03)
  soilMoistureClass: {value: {layer: '0 to 7 cm model layer read against a 0.10 m evaporation layer', precedence: 'model soil moisture over the rain rule for moist or dry'}, text: 'Model soil moisture is read against FAO 56 Table 19 for the recorded soil texture: moist when the grid cell\'s 0 to 7 cm value is at or above the wettest end of stage-1 drying for that texture (field capacity minus readily evaporable water over 0.10 m), dry when below the driest end; in between the rain rule decides. The model holds water by its own soil class, not this field\'s, so an absolute threshold applied to the model layer is uncalibrated; its 0 to 7 cm layer is also shallower than FAO\'s 0.10 to 0.15 m evaporation layer. Where it classes a day, model soil moisture takes precedence over the rain rule for moist or dry (a dry model cell overrides recent rain short of ponding); ponded and flooded still come only from rain and crop practice (engine assumption).'},
  soilMoistureNoTexture: {value: 'class held back; no moist or dry from soil moisture', text: 'No soil texture from FAO 56 Table 19 is recorded for this field, so the grid cell\'s model soil moisture is shown but does not set moist or dry: the class is held back until the cell\'s own multi-year soil-moisture history exists (a percentile rule on that history is the planned follow-up). The water state comes from the crop practice and the rain rule.'},
  wetness: {value: {leafWetnessHighPct: 50, leafWetnessModeratePct: 25, rhMeanHighPct: 90, rhMeanModeratePct: 80}, text: 'Wetness is an engine assumption, not a sourced threshold: high when the grid cell\'s mean leaf-wetness probability is 50% or more or mean humidity 90% or more, moderate from 25% or 80%, low below both. High wetness means conditions favour fungal spread; it is not a disease forecast. No Indian agromet or FAO crop-independent figure was found.'},
  lodgingGust: {value: WEATHER_THRESHOLDS.windGustKmh, text: 'Gusts are counted against the project\'s 60 km/h gust alert threshold, not a sourced lodging figure; whether a crop lodges also depends on crop, stage, rain and variety.'},
} as const;
export type ConditionAssumptionKey = keyof typeof CONDITION_ASSUMPTIONS;
const assumptionBasis = (key: ConditionAssumptionKey): BasisRef => ({kind: 'model', label: `Engine assumption: ${key}`, sourceId: `today-conditions-assumption:${key}`, url: null, scope: null, note: CONDITION_ASSUMPTIONS[key].text});
/** D-W4 wording for every value read from `agro`. */
export const MODEL_ESTIMATE_TEXT = 'Open-Meteo model estimate for the ~9 to 11 km grid cell around the field, not a field reading';

// ------------------------------------------------------------------ data file (tolerant; nothing invented)

const issues: string[] = [];
export const loadIssues = (): readonly string[] => issues;
const optStr = z.string().nullable().optional().transform((v) => v ?? null);
function tolerantArray<T extends z.ZodType>(schema: T, label: string) {
  return z.array(z.unknown()).nullable().optional().transform((xs) => (xs ?? []).flatMap((x, i) => {
    const r = schema.safeParse(x);
    if (r.success) return [r.data as z.output<T>];
    issues.push(`${label}[${i}] skipped: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim());
    return [];
  }));
}
const RAIN_CLASSES = ['very_light', 'light', 'moderate', 'heavy', 'very_heavy', 'extremely_heavy'] as const;
const RainBand = z.object({class: z.enum(RAIN_CLASSES), lowerMm: z.number().positive(), upperMm: z.number().nullable().optional()});
const Practice = z.object({
  cropId: z.string().min(1),
  standingWater: z.object({
    startDaysAfterEstablishment: z.object({transplanted: z.number().int().min(0), otherMethods: z.number().int().min(0)}),
    drainDaysBeforeHarvest: z.object({low: z.number().int().min(0), high: z.number().int().min(0)}).refine((r) => r.low <= r.high, 'low above high'),
  }),
  sourceId: optStr, locator: optStr, note: optStr,
});
const Heat = z.object({cropId: z.string().min(1), tMaxC: z.number().finite(), stage: optStr, stagePattern: optStr, sourceId: optStr, locator: optStr, note: optStr});
const SourceMeta = z.object({url: optStr, title: optStr, publisher: optStr});
/** A whole optional block: a malformed block is skipped and recorded, never fatal (older files have none of these). */
function tolerantObject<T extends z.ZodType>(schema: T, label: string) {
  return z.unknown().optional().transform((x): z.output<T> | null => {
    if (x === null || x === undefined) return null;
    const r = schema.safeParse(x);
    if (r.success) return r.data as z.output<T>;
    issues.push(`${label} skipped: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim());
    return null;
  });
}
const share = z.number().min(0).max(1);
const SmTexture = z.object({
  texture: z.string().min(1), faoLabel: optStr,
  fcLow: share, fcHigh: share, wpLow: share.nullable().optional(), wpHigh: share.nullable().optional(),
  rewLowMm: z.number().min(0), rewHighMm: z.number().min(0),
}).refine((t) => t.fcLow <= t.fcHigh && t.rewLowMm <= t.rewHighMm, 'low above high');
const SoilMoistureClasses = z.object({
  sourceId: optStr, locator: optStr, note: optStr,
  evaporationLayerM: z.number().positive().max(1),
  textures: tolerantArray(SmTexture, 'soilMoistureClasses.textures'),
});
const Pair = z.object({high: z.number().min(0).max(100), moderate: z.number().min(0).max(100)}).refine((p) => p.moderate <= p.high, 'moderate above high');
const WetnessThresholds = z.object({sourceId: optStr, locator: optStr, note: optStr, leafWetnessPct: Pair.nullable().optional().transform((v) => v ?? null), rhMeanPct: Pair.nullable().optional().transform((v) => v ?? null)});
const LodgingGust = z.object({sourceId: optStr, locator: optStr, note: optStr, gustKmh: z.number().positive().nullable().optional().transform((v) => v ?? null)});
const ConditionsFile = z.object({
  rainClasses: z.object({sourceId: optStr, locator: optStr, note: optStr, classes: tolerantArray(RainBand, 'rainClasses.classes')}).nullable().optional().transform((v) => v ?? null),
  waterPractice: tolerantArray(Practice, 'waterPractice'),
  heatThresholds: tolerantArray(Heat, 'heatThresholds'),
  soilMoistureClasses: tolerantObject(SoilMoistureClasses, 'soilMoistureClasses'),
  wetnessThresholds: tolerantObject(WetnessThresholds, 'wetnessThresholds'),
  lodgingGust: tolerantObject(LodgingGust, 'lodgingGust'),
  sources: z.record(z.string(), z.unknown()).nullable().optional().transform((rec) => new Map(Object.entries(rec ?? {}).flatMap(([k, v]) => {
    const r = SourceMeta.safeParse(v);
    return r.success ? [[k, r.data] as const] : [];
  }))),
});
export type ConditionsData = z.output<typeof ConditionsFile>;

let fixture: unknown | null = null;
let cache: ConditionsData | null = null;
/** Clears the cache; with `next`, later loads parse that raw object instead of the file (tests). */
export function invalidate(next?: unknown): void { cache = null; fixture = next ?? null; issues.length = 0; }
/** The parsed file; throws when it is missing or not an object of the expected shape. */
export function loadConditionsData(): ConditionsData {
  if (cache) return cache;
  const parsed = ConditionsFile.parse(fixture ?? JSON.parse(readFileSync(resolve(REPO_ROOT, CONDITIONS_FILE), 'utf8')));
  if (parsed.rainClasses) parsed.rainClasses.classes.sort((a, b) => a.lowerMm - b.lowerMm);
  return (cache = parsed);
}
const validUrl = (u: string | null | undefined): string | null => { if (!u) return null; try { return new URL(u).protocol.startsWith('http') ? u : null; } catch { return null; } };
function cited(d: ConditionsData, kind: BasisRef['kind'], label: string, sourceId: string | null, locator: string | null, note: string | null): BasisRef {
  const s = sourceId ? d.sources.get(sourceId) : undefined;
  return {kind, label: `${label}${s?.title ? `: ${s.title}` : ''}`.slice(0, 200), sourceId, url: validUrl(s?.url), scope: locator ? locator.slice(0, 120) : null, note: note ? note.slice(0, 1000) : null};
}

// ------------------------------------------------------------------ rules (pure)

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const RAIN_RANK: Record<RainClass, number> = {unknown: -1, none: 0, very_light: 1, light: 2, moderate: 3, heavy: 4, very_heavy: 5, extremely_heavy: 6};

/** IMD class of a daily rain amount (from the lower bounds in the data file); `unknown` when rain or the classes are missing. */
export function rainClass(mm: number | null, bands: readonly {class: (typeof RAIN_CLASSES)[number]; lowerMm: number}[]): RainClass {
  if (mm === null || !Number.isFinite(mm) || !bands.length) return 'unknown';
  if (mm <= 0) return 'none';
  let out: RainClass = 'very_light';
  for (const b of bands) if (mm >= b.lowerMm) out = b.class;
  return out;
}

// ---- weather depth, packet B (WEATHER_DEPTH_SPEC.md 6.2): soil-moisture class and wetness context

type SmRow = z.output<typeof SmTexture>;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
/** Lower case with underscores, so 'Sandy loam', 'sandy-loam' and 'sandy_loam' match. */
export const textureKey = (t: string | null | undefined): string | null => {
  const k = (t ?? '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  return k ? k.slice(0, 60) : null;
};
/** The end of stage-1 drying for one Table 19 row: wet end (fcHigh - rewLow / layer) and dry end (fcLow - rewHigh / layer), m3/m3. */
export function stageOneEnds(row: {fcLow: number; fcHigh: number; rewLowMm: number; rewHighMm: number}, layerM: number): {wetEnd: number; dryEnd: number} {
  return {wetEnd: r3(row.fcHigh - row.rewLowMm / (1000 * layerM)), dryEnd: r3(Math.max(0, row.fcLow - row.rewHighMm / (1000 * layerM)))};
}
export interface SoilMoistureRule { texture: string; faoLabel: string | null; wetEnd: number; dryEnd: number }
/**
 * The class rule for a farm: the recorded texture's Table 19 row. Null without the data block, without a recorded texture
 * or for a texture the table does not print: the class is then held back (CONDITION_ASSUMPTIONS.soilMoistureNoTexture).
 */
export function soilMoistureRule(texture: string | null | undefined, d: ConditionsData): SoilMoistureRule | null {
  const block = d.soilMoistureClasses;
  const key = textureKey(texture);
  if (!block || !key) return null;
  const row: SmRow | undefined = block.textures.find((t) => textureKey(t.texture) === key || textureKey(t.faoLabel) === key);
  if (!row) return null;
  const e = stageOneEnds(row, block.evaporationLayerM);
  return {texture: row.texture, faoLabel: row.faoLabel, wetEnd: e.wetEnd, dryEnd: e.dryEnd};
}
/** Moist at or above the wet end, dry below the dry end, else null (the rain rule decides). Never ponded or flooded. */
export function soilMoistureClass(theta: number | null, rule: SoilMoistureRule | null): 'moist' | 'dry' | null {
  if (theta === null || !rule) return null;
  if (theta >= rule.wetEnd) return 'moist';
  if (theta < rule.dryEnd) return 'dry';
  return null;
}
/** The farm's recorded soil texture fact (farmer reported, lab test or confirmed), as the year plan reads facts. */
export function soilTextureOf(facts: ScenarioFarm['facts']): string | null {
  const v = factValue({location: {stateCode: null, districtId: null}, areaHectares: null, facts}, 'soil_texture');
  return typeof v === 'string' ? v.slice(0, 60) : null;
}

type Agro = NonNullable<WeatherPoint['agro']>;
const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
/** The `agro` inputs the rules read, range-checked; absent `agro` (or an unavailable day) reads as all null. */
export function agroInputs(w: WeatherPoint | undefined): {pressureInputs: boolean; soilMoisture: number | null; leafWetnessPct: number | null; rhMeanPct: number | null; vpdMaxKpa: number | null; gustMaxKmh: number | null} {
  const a: Partial<Agro> | undefined = w && w.kind !== 'unavailable' ? w.agro : undefined;
  const out = {
    soilMoisture: num(a?.soilMoisture0to7, 0, 1),
    leafWetnessPct: num(a?.leafWetnessPct, 0, 100),
    rhMeanPct: num(a?.rhMeanPct, 0, 100),
    vpdMaxKpa: num(a?.vpdMaxKpa, 0, 20),
    gustMaxKmh: num(a?.gustMaxKmh, 0, 500),
  };
  // A pressure block needs at least one of its own inputs (old rows may carry only ET0 or the rain chance).
  return {...out, pressureInputs: out.leafWetnessPct !== null || out.rhMeanPct !== null || out.vpdMaxKpa !== null || out.gustMaxKmh !== null};
}
type Wetness = NonNullable<FieldConditionPoint['pressure']>['wetness'];
const WET_RANK: Record<Wetness, number> = {unknown: -1, low: 0, moderate: 1, high: 2};
export interface WetnessRule { leafWetnessPct: {high: number; moderate: number} | null; rhMeanPct: {high: number; moderate: number} | null; basis: 'sourced_threshold' | 'engine_assumption' }
/** Sourced figures from the data file when it has a sourceId and at least one pair; else the engine assumption. */
export function wetnessRule(d: ConditionsData): WetnessRule {
  const w = d.wetnessThresholds;
  if (w && w.sourceId && (w.leafWetnessPct || w.rhMeanPct)) return {leafWetnessPct: w.leafWetnessPct, rhMeanPct: w.rhMeanPct, basis: 'sourced_threshold'};
  const a = CONDITION_ASSUMPTIONS.wetness.value;
  return {leafWetnessPct: {high: a.leafWetnessHighPct, moderate: a.leafWetnessModeratePct}, rhMeanPct: {high: a.rhMeanHighPct, moderate: a.rhMeanModeratePct}, basis: 'engine_assumption'};
}
const classOfPair = (v: number | null, pair: {high: number; moderate: number} | null): Wetness => (v === null || !pair ? 'unknown' : v >= pair.high ? 'high' : v >= pair.moderate ? 'moderate' : 'low');
/** The higher class of leaf wetness and mean humidity; unknown (basis none) when neither input is there. */
export function wetnessOf(leafWetnessPct: number | null, rhMeanPct: number | null, rule: WetnessRule): {wetness: Wetness; basis: 'sourced_threshold' | 'engine_assumption' | 'none'} {
  const a = classOfPair(leafWetnessPct, rule.leafWetnessPct), b = classOfPair(rhMeanPct, rule.rhMeanPct);
  const wetness = WET_RANK[a] >= WET_RANK[b] ? a : b;
  return {wetness, basis: wetness === 'unknown' ? 'none' : rule.basis};
}

export interface GreenReading { date: string; ndvi: number | null; verdict: 'above_typical' | 'near_typical' | 'below_typical' | 'no_reference' }
export interface ConditionsInput {
  cropId: string;
  establishmentMethod: string | null;
  /** Establishment (else sowing) date. */
  anchorDate: string;
  /** Days to draw (the view's slider window, bounded like the weather track). */
  window: {from: string; to: string};
  timeline: StageTimeline | null;
  weather: readonly WeatherPoint[];
  alerts: readonly FarmAlert[];
  /** The farm's irrigation category as the year plan reads it (factValue + irrigationClass); null when not recorded. */
  irrigationCategory?: string | null | undefined;
  /** Usable readings with the verdict the health card gives them (view.ts readingVerdict). */
  readings: readonly GreenReading[];
  /**
   * The farm's recorded soil texture (SoilTexture ids or an FAO 56 Table 19 label; `soilTextureOf(farm.facts)`); null or
   * absent when not recorded, which holds the soil-moisture class back. view.ts and future-look.ts pass soilTextureOf(facts).
   */
  soilTexture?: string | null | undefined;
}

const SEVERITY_RANK: Record<string, number> = {warning: 0, watch: 1, info: 2};

/** One condition point per day of the window, with the thresholds' basis and the limitations. */
export function fieldConditions(i: ConditionsInput, data: ConditionsData = loadConditionsData()): FieldConditions {
  const bands = data.rainClasses?.classes ?? [];
  const byDate = new Map(i.weather.map((w) => [w.date, w]));
  const practice = data.waterPractice.find((p) => p.cropId === i.cropId) ?? null;
  const heat = data.heatThresholds.find((h) => h.cropId === i.cropId) ?? null;
  const heatPattern = heat?.stagePattern ? safeRegex(heat.stagePattern) : null;
  const readings = [...i.readings].sort((a, b) => a.date.localeCompare(b.date));
  const smRule = soilMoistureRule(i.soilTexture ?? null, data);
  const wetRule = wetnessRule(data);
  const gustThreshold = data.lodgingGust?.sourceId && data.lodgingGust.gustKmh !== null ? data.lodgingGust.gustKmh : CONDITION_ASSUMPTIONS.lodgingGust.value;

  // Standing-water window from the crop practice (needs a harvest window for the drain date).
  // Decision 2026-11-02: the practice applies to irrigated or supplemental fields; rainfed paddy gets rain-rule water only;
  // an unrecorded category keeps the practice window, flagged (floodedWhenIrrigationUnknown).
  const irrigation = irrigationClass(i.irrigationCategory ?? null);
  const rainfed = irrigation === 'none';
  let flooded: {from: string; to: string} | null = null;
  if (practice && i.timeline?.harvest && !rainfed) {
    const transplanted = /transplant/i.test(i.establishmentMethod ?? '');
    const from = addDays(i.anchorDate, transplanted ? practice.standingWater.startDaysAfterEstablishment.transplanted : practice.standingWater.startDaysAfterEstablishment.otherMethods);
    const to = addDays(i.timeline.harvest.earliest, -practice.standingWater.drainDaysBeforeHarvest.high);
    if (from <= to) flooded = {from, to};
  }

  const rainOf = (d: string): number | null => { const w = byDate.get(d); return w && w.kind !== 'unavailable' ? w.rainMm : null; };
  const classOf = (d: string) => rainClass(rainOf(d), bands);
  const pondTrigger = (d: string) => {
    if (RAIN_RANK[classOf(d)] >= RAIN_RANK.heavy) return true;
    const sum = [0, 1, 2].map((k) => rainOf(addDays(d, -k))).filter((x): x is number => x !== null);
    return sum.length > 0 && sum.reduce((s, x) => s + x, 0) >= CONDITION_ASSUMPTIONS.rainRule.value.threeDayMm;
  };
  const within = (d: string, hold: number, pred: (x: string) => boolean) => Array.from({length: hold + 1}, (_, k) => addDays(d, -k)).some(pred);

  const n = Math.min(MAX_POINTS, Math.max(0, dayDiff(i.window.from, i.window.to) + 1));
  const used = {flooded: false, rainRule: false, defaultHeat: false, cropHeat: false, rain: false};
  const depth = {pressure: false, smValue: false, wetness: false, gustValue: false, gustDays: 0, waterDays: {crop_practice: 0, rain_rule: 0, model_soil_moisture: 0, none: 0}};
  const points: FieldConditionPoint[] = [];
  for (let k = 0; k < n; k++) {
    const date = addDays(i.window.from, k);
    const w = byDate.get(date);
    const kind: FieldConditionPoint['kind'] = w ? w.kind : 'unavailable';
    const mm = rainOf(date);
    const cls = classOf(date);
    if (cls !== 'unknown') used.rain = true;

    // Water, first rule that applies (WEATHER_DEPTH_SPEC.md 6.2 order); soil moisture only ever gives moist or dry.
    const ag = agroInputs(w);
    const smClass = soilMoistureClass(ag.soilMoisture, smRule);
    let water: FieldConditionPoint['water'];
    if (flooded && flooded.from <= date && date <= flooded.to) { water = {state: 'flooded', basis: 'crop_practice'}; used.flooded = true; }
    else if (within(date, CONDITION_ASSUMPTIONS.pondHoldDays.value, pondTrigger)) { water = {state: 'ponded', basis: 'rain_rule'}; used.rainRule = true; }
    else if (smClass) water = {state: smClass, basis: 'model_soil_moisture'};
    else if (within(date, CONDITION_ASSUMPTIONS.moistHoldDays.value, (x) => RAIN_RANK[classOf(x)] >= RAIN_RANK.light)) { water = {state: 'moist', basis: 'rain_rule'}; used.rainRule = true; }
    else water = {state: cls === 'unknown' ? 'unknown' : 'dry', basis: 'none'};
    // The cell's value rides along whenever it was there, whichever rule decided (omitted otherwise, as before packet B).
    if (ag.soilMoisture !== null) { water = {...water, soilMoisture0to7: r3(ag.soilMoisture)}; depth.smValue = true; }
    depth.waterDays[water.basis] += 1;
    // Wetness context: only when the day carries at least one pressure input (else no block, read as unknown).
    let pressure: FieldConditionPoint['pressure'];
    if (ag.pressureInputs) {
      depth.pressure = true;
      const wc = wetnessOf(ag.leafWetnessPct, ag.rhMeanPct, wetRule);
      if (wc.basis !== 'none') depth.wetness = true;
      if (ag.gustMaxKmh !== null) { depth.gustValue = true; if (ag.gustMaxKmh >= gustThreshold) depth.gustDays += 1; }
      pressure = {
        wetness: wc.wetness,
        leafWetnessPct: ag.leafWetnessPct === null ? null : r1(ag.leafWetnessPct),
        rhMeanPct: ag.rhMeanPct === null ? null : r1(ag.rhMeanPct),
        vpdMaxKpa: ag.vpdMaxKpa === null ? null : r2(ag.vpdMaxKpa),
        gustMaxKmh: ag.gustMaxKmh === null ? null : r1(ag.gustMaxKmh),
        basis: wc.basis,
      };
    }

    const st = i.timeline ? stageAt(i.timeline, date) : null;
    const stage = st?.stage ? {id: st.stage.id.slice(0, 80), name: st.stage.name.slice(0, 80), progress: stageProgress(st.stage, date)} : null;
    const tMaxC = w && w.kind !== 'unavailable' ? w.tMaxC : null;
    let thresholdC: number | null = null;
    if (tMaxC !== null) {
      const cropStage = heat && heatPattern && stage && heatPattern.test(`${stage.name} ${stage.id}`);
      thresholdC = cropStage ? heat!.tMaxC : CONDITION_ASSUMPTIONS.defaultHeatC.value;
      if (cropStage) used.cropHeat = true; else used.defaultHeat = true;
    }
    const g = latestOnOrBefore(readings, date);
    const events = i.alerts.filter((a) => a.validFrom <= date && date <= a.validTo)
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id))
      .slice(0, MAX_EVENTS).map((a) => ({alertId: a.id, type: a.type.slice(0, 40), severity: a.severity, title: a.title.slice(0, 160)}));
    points.push({
      date, kind, rain: {mm, class: cls}, water,
      heat: {tMaxC, stress: tMaxC !== null && thresholdC !== null && tMaxC >= thresholdC, thresholdC},
      ...(pressure ? {pressure} : {}),
      greenness: g ? {ndvi: g.ndvi, verdict: g.verdict, observedOn: g.date, daysSince: dayDiff(g.date, date)} : {ndvi: null, verdict: null, observedOn: null, daysSince: null},
      events, stage,
    });
  }

  const basis: BasisRef[] = [];
  const limitations: string[] = ['The field conditions are drawn from weather records, forecasts and typical weather, the alerts and the latest clear satellite reading; they are not seen on the field.'];
  if (data.rainClasses) basis.push(cited(data, 'climatology', 'IMD daily rainfall classes', data.rainClasses.sourceId, data.rainClasses.locator, data.rainClasses.note));
  else limitations.push('The IMD rainfall classes are not in the data file, so every rain class is unknown.');
  if (used.rainRule || used.rain) { basis.push(assumptionBasis('rainRule'), assumptionBasis('pondHoldDays'), assumptionBasis('moistHoldDays')); limitations.push(CONDITION_ASSUMPTIONS.rainRule.text, CONDITION_ASSUMPTIONS.pondHoldDays.text); }
  if (practice && rainfed) limitations.push('Rainfed paddy: standing water is drawn only from rain, not from the irrigated practice.');
  else if (practice) {
    basis.push(cited(data, 'water', `Standing-water practice (${practice.cropId})`, practice.sourceId, practice.locator, practice.note));
    if (flooded && irrigation === null) { basis.push(assumptionBasis('floodedWhenIrrigationUnknown')); limitations.push(CONDITION_ASSUMPTIONS.floodedWhenIrrigationUnknown.text); }
    if (flooded) { basis.push(assumptionBasis('drainLead')); limitations.push(`Standing water is drawn from ${flooded.from} to ${flooded.to} because the sourced practice for this crop keeps the field flooded then; whether this field is flooded is not recorded.`, CONDITION_ASSUMPTIONS.drainLead.text); }
    else limitations.push('No harvest window is known, so the standing-water period of the crop practice cannot be dated.');
  }
  if (used.cropHeat && heat) { basis.push(cited(data, 'climatology', `Heat threshold ${heat.tMaxC} C${heat.stage ? ` at ${heat.stage}` : ''} (${heat.cropId})`, heat.sourceId, heat.locator, heat.note)); basis.push(assumptionBasis('heatStageMatch')); limitations.push(CONDITION_ASSUMPTIONS.heatStageMatch.text); }
  if (used.defaultHeat) { basis.push(assumptionBasis('defaultHeatC')); limitations.push(CONDITION_ASSUMPTIONS.defaultHeatC.text); }
  // ---- weather depth (packet B): which water basis was used, the soil-moisture rule, wetness and gusts; every value a grid-cell estimate (D-W4)
  if (depth.smValue || depth.pressure) {
    const wd = depth.waterDays;
    const counts = `Water state by basis over ${points.length} days: model soil moisture ${wd.model_soil_moisture}, rain rule ${wd.rain_rule}, crop practice ${wd.crop_practice}, no rule ${wd.none}.`;
    let sm = '';
    let smRuleText: string | null = null;
    if (depth.smValue && smRule && data.soilMoistureClasses) {
      basis.push(cited(data, 'soil', 'Soil water by texture (FAO 56 Table 19)', data.soilMoistureClasses.sourceId, data.soilMoistureClasses.locator, data.soilMoistureClasses.note));
      basis.push(assumptionBasis('soilMoistureClass'));
      sm = ` Soil texture ${smRule.faoLabel ?? smRule.texture}: moist at ${smRule.wetEnd} m3/m3 or more, dry below ${smRule.dryEnd} m3/m3.`;
      smRuleText = CONDITION_ASSUMPTIONS.soilMoistureClass.text;
    } else if (depth.smValue && !data.soilMoistureClasses) sm = ' The soil-moisture classes are not in the data file, so model soil moisture is shown but does not set the water state.';
    else if (depth.smValue) {
      basis.push(assumptionBasis('soilMoistureNoTexture'));
      const named = textureKey(i.soilTexture) ? `The recorded texture (${textureKey(i.soilTexture)}) is not printed in FAO 56 Table 19. ` : '';
      smRuleText = `${named}${CONDITION_ASSUMPTIONS.soilMoistureNoTexture.text}`;
    }
    limitations.push(`Soil moisture, leaf wetness, humidity, vapour pressure deficit and gusts are an ${MODEL_ESTIMATE_TEXT}; the soil moisture is the model's land-surface value, not calibrated to this field's soil. ${counts}${sm}`.slice(0, 1000));
    if (smRuleText) limitations.push(smRuleText.slice(0, 1000));
    const parts: string[] = [];
    // Only when some day carried a pressure input (soil moisture alone says nothing about wetness or gusts).
    if (depth.wetness) {
      if (wetRule.basis === 'sourced_threshold' && data.wetnessThresholds) basis.push(cited(data, 'climatology', 'Wetness thresholds', data.wetnessThresholds.sourceId, data.wetnessThresholds.locator, data.wetnessThresholds.note));
      else { basis.push(assumptionBasis('wetness')); parts.push(CONDITION_ASSUMPTIONS.wetness.text); }
    } else if (depth.pressure) parts.push('Leaf wetness and humidity are not in the weather record for these days, so wetness is unknown.');
    if (depth.gustValue) {
      const sourced = !!(data.lodgingGust?.sourceId && data.lodgingGust.gustKmh !== null);
      basis.push(sourced ? cited(data, 'climatology', `Lodging gust ${gustThreshold} km/h`, data.lodgingGust!.sourceId, data.lodgingGust!.locator, data.lodgingGust!.note) : assumptionBasis('lodgingGust'));
      parts.push(`Gusts reached ${gustThreshold} km/h on ${depth.gustDays} of these days.${sourced ? '' : ` ${CONDITION_ASSUMPTIONS.lodgingGust.text}`}`);
    }
    if (parts.length) limitations.push(parts.join(' ').slice(0, 1000));
  }
  if (points.some((p) => p.kind === 'typical')) limitations.push('Days beyond the forecast use typical weather of past years (climatology), not a forecast for this year.');
  if (points.some((p) => p.kind === 'unavailable')) limitations.push('Some days have no weather record; no rain, water or heat is drawn for them.');
  if (dayDiff(i.window.from, i.window.to) + 1 > MAX_POINTS) limitations.push(`At most ${MAX_POINTS} days are drawn.`);
  return {points, basis: capped(basis, BASIS_DROP_ORDER), limitations: capped([...new Set(limitations)], LIMITATION_DROP_ORDER)};
}

/**
 * The contract caps basis and limitations at 12. Over the cap, the listed lower-priority entries go first, then the tail;
 * nothing is dropped below the cap.
 */
const BASIS_DROP_ORDER = ['today-conditions-assumption:moistHoldDays', 'today-conditions-assumption:pondHoldDays'];
/** The pond-hold note is restated by the rain rule; the drain-lead note by the dated standing-water sentence and its BasisRef. */
const LIMITATION_DROP_ORDER = [CONDITION_ASSUMPTIONS.pondHoldDays.text, CONDITION_ASSUMPTIONS.drainLead.text];
function capped<T extends BasisRef | string>(xs: T[], dropFirst: readonly string[], max = 12): T[] {
  const out = [...xs];
  for (const key of dropFirst) {
    if (out.length <= max) break;
    const k = out.findIndex((x) => (typeof x === 'string' ? x : x.sourceId) === key);
    if (k >= 0) out.splice(k, 1);
  }
  return out.slice(0, max);
}

function safeRegex(p: string): RegExp | null { try { return new RegExp(p, 'i'); } catch { return null; } }
function stageProgress(stage: {from: string; to: string}, date: string): number {
  const total = dayDiff(stage.from, stage.to);
  return total <= 0 ? 1 : Math.min(1, Math.max(0, dayDiff(stage.from, date) / total));
}
function latestOnOrBefore(readings: readonly GreenReading[], date: string): GreenReading | null {
  let out: GreenReading | null = null;
  for (const r of readings) { if (r.date <= date) out = r; else break; }
  return out;
}
