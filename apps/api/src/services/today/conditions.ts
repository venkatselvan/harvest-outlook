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
 *   3. moist (rain_rule): light rain or more that day or on one of the moistHoldDays days before;
 *   4. dry (none) when the day has a rain figure, else unknown (none);
 * - heat: the crop's sourced threshold on days whose calendar stage matches the threshold's stage (rice 35 C at
 *   flowering); otherwise the project's 40 C alert threshold (WEATHER_THRESHOLDS.tMaxC, flagged); stress = tMax >= threshold;
 *   no tMax: stress false and a null threshold;
 * - greenness: the latest usable reading on or before the day, held (never interpolated); null before the first;
 * - events: alerts whose validity covers the day, warnings first, at most 5;
 * - stage: the calendar stage of the day and the share of that stage elapsed.
 * Every unsourced choice is in CONDITION_ASSUMPTIONS and surfaces as a `model` BasisRef and a limitation.
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import type {BasisRef, FarmAlert, FieldConditionPoint, FieldConditions, RainClass, StageTimeline, WeatherPoint} from '@harvest/contracts';
import {REPO_ROOT} from '../../catalogue/files';
import {WEATHER_THRESHOLDS} from './alerts';
import {stageAt} from './stage-timeline';
import {irrigationClass} from '../year-plan/scoring';

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
} as const;
export type ConditionAssumptionKey = keyof typeof CONDITION_ASSUMPTIONS;
const assumptionBasis = (key: ConditionAssumptionKey): BasisRef => ({kind: 'model', label: `Engine assumption: ${key}`, sourceId: `today-conditions-assumption:${key}`, url: null, scope: null, note: CONDITION_ASSUMPTIONS[key].text});

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
const ConditionsFile = z.object({
  rainClasses: z.object({sourceId: optStr, locator: optStr, note: optStr, classes: tolerantArray(RainBand, 'rainClasses.classes')}).nullable().optional().transform((v) => v ?? null),
  waterPractice: tolerantArray(Practice, 'waterPractice'),
  heatThresholds: tolerantArray(Heat, 'heatThresholds'),
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
  const points: FieldConditionPoint[] = [];
  for (let k = 0; k < n; k++) {
    const date = addDays(i.window.from, k);
    const w = byDate.get(date);
    const kind: FieldConditionPoint['kind'] = w ? w.kind : 'unavailable';
    const mm = rainOf(date);
    const cls = classOf(date);
    if (cls !== 'unknown') used.rain = true;

    let water: FieldConditionPoint['water'];
    if (flooded && flooded.from <= date && date <= flooded.to) { water = {state: 'flooded', basis: 'crop_practice'}; used.flooded = true; }
    else if (within(date, CONDITION_ASSUMPTIONS.pondHoldDays.value, pondTrigger)) { water = {state: 'ponded', basis: 'rain_rule'}; used.rainRule = true; }
    else if (within(date, CONDITION_ASSUMPTIONS.moistHoldDays.value, (x) => RAIN_RANK[classOf(x)] >= RAIN_RANK.light)) { water = {state: 'moist', basis: 'rain_rule'}; used.rainRule = true; }
    else water = {state: cls === 'unknown' ? 'unknown' : 'dry', basis: 'none'};

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
  if (points.some((p) => p.kind === 'typical')) limitations.push('Days beyond the forecast use typical weather of past years (climatology), not a forecast for this year.');
  if (points.some((p) => p.kind === 'unavailable')) limitations.push('Some days have no weather record; no rain, water or heat is drawn for them.');
  if (dayDiff(i.window.from, i.window.to) + 1 > MAX_POINTS) limitations.push(`At most ${MAX_POINTS} days are drawn.`);
  return {points, basis: basis.slice(0, 12), limitations: [...new Set(limitations)].slice(0, 12)};
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
