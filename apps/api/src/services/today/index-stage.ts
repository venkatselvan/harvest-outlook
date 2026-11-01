/**
 * Index stage reader (open-source comparison, 2026-11-01; method and sources in docs/research/INDEX_STAGE_READER.md).
 * Pure code, no I/O: reads the field's own Sentinel-2 NDVI curve, names its current phase, dates the green-up and puts
 * the phase beside the calendar stage estimate. It is evidence shown next to the stage timeline and never moves it.
 *
 * Thresholds come from three kinds of basis, all re-derived from public sources and the series itself (no private
 * pipeline rule was used):
 * - public: amplitude fractions 15 / 50 / 90 % (adapted from the MODIS MCD12Q2 user guide) and the NDVI bands (bare or
 *   very sparse below about 0.2, dense green canopy from about 0.6; USGS), in STAGE_READER_SOURCES;
 * - data-driven: the change threshold, 2 x the series' robust noise;
 * - engine assumptions, not sourced: the window lead, smoothing window, trend window, minimum readings, the noise floor,
 *   the peak-age and rising-peak limits and the stage-position mapping, in STAGE_READER_ASSUMPTIONS, each named with its
 *   value in the reading's basis note.
 *
 * Refinements over the task method that the data or the review forced (each documented in the doc, section 3):
 * 0. The window lead is the NDVI series' own lead (30 days, shared with the Today view and the monitor) and the window
 *    is clipped to the window the series was fetched for, so `window` never claims days that were not read.
 * 1. The peak is looked for only on or after the recorded establishment (else sowing) date. The lead exists to see the
 *    pre-season level; a previous crop standing in the lead is not this cycle's peak.
 * 2. While the curve is still rising its own peak is not known yet, so the levels use the USGS dense-canopy floor as
 *    the provisional season top (otherwise the latest point is always the peak and "green-up" could never be read).
 * 3. Without a significant season amplitude, and always for the upper phases, the USGS dense-canopy floor also counts
 *    as "at or above mid-season", so a steady dense canopy reads as a plateau.
 * 4. The expected phase uses where the latest reading's date sits in the cycle, not where its stage starts: with the
 *    stage start, the FAO mid-season (full cover) of maize starts at 0.50 of the cycle and would be expected to be
 *    "rising" throughout, and its development stage (0.18) "bare or green-up" throughout.
 * 5. The noise residual is the raw value minus the median of its neighbours within the smoothing window, the reading
 *    itself excluded, only for readings with a neighbour on each side, and the deviation is taken about zero. Raw minus the smoothed value (which includes the reading)
 *    is exactly zero for most readings, and a MAD re-centred on the median residual is zero whenever more than half
 *    the residuals are equal; both made a flat canopy with alternating scene-to-scene jitter read as "harvested". One-sided residuals at the
 *    series ends measured the season's slope (six readings 10 days apart through a green-up and a fall gave a noise of
 *    0.12 and hid a 0.22 fall from the drop alert).
 */
import type {IndexStagePhase, IndexStageReading, NdviReading, NdviSeries, StageTimeline} from '@harvest/contracts';
import {stageAt} from './stage-timeline';

// ------------------------------------------------------------------ sources and assumptions

export const MCD12Q2_GUIDE_URL = 'https://lpdaac.usgs.gov/documents/1417/MCD12Q2_User_Guide_V61.pdf';
export const USGS_NDVI_URL = 'https://www.usgs.gov/special-topics/remote-sensing-phenology/science/ndvi-foundation-remote-sensing-phenology';
export const READER_ID = 'index-stage-reader-v1';

/** Public constants, each with its source. MCD12Q2 works on EVI2; using its fractions on NDVI is a transfer (doc 2.1). */
export const STAGE_READER_SOURCES = {
  amplitudeFractions: {value: {greenUp: 0.15, mid: 0.5, maturity: 0.9}, url: MCD12Q2_GUIDE_URL,
    text: 'Adapted from the MCD12Q2 C6.1 user guide (Gray, Sulla-Menashe and Friedl, 2022) section 2.3: green-up, mid-green-up and maturity are the first dates the smoothed series crosses 15, 50 and 90 % of the segment amplitude above the segment start. Here the green-up level (15 % above the trough) also stands in for MCD12Q2 dormancy, which needs the segment end (15 % of the falling-limb amplitude) and so is not known while the season is open.'},
  sparseVegetationFloor: {value: 0.2, url: USGS_NDVI_URL,
    text: 'USGS: sparse shrubland, grassland or senescing crops give about 0.2 to 0.5 and barren rock, sand or snow about 0.1 or less, so a smoothed value below 0.2 is read as bare or very sparse cover and a green-up date needs at least 0.2.'},
  denseCanopyFloor: {value: 0.6, url: USGS_NDVI_URL,
    text: 'USGS: dense green canopy (temperate and tropical forests, crops at peak growth) gives about 0.6 to 0.9, so 0.6 is the provisional season top while the curve is still rising and counts as at or above mid-season.'},
} as const;

/** Engine assumptions (not sourced). Each key used is named with its value in the reading's basis note. */
export const STAGE_READER_ASSUMPTIONS = {
  windowLeadDays: {value: 30, text: 'Clear readings from 30 days before the recorded establishment (else sowing) date are read, so the pre-season level (the trough) is inside the window. The same lead is used to fetch the NDVI series for the Today view and the daily monitor (NDVI_LEAD_DAYS), and the window is clipped to the window the series was fetched for.'},
  maxWindowDays: {value: 400, text: 'At most the last 400 days are read (the limit of the NDVI series window).'},
  minReadings: {value: 4, text: 'At least 4 clear field readings are needed to read a phase.'},
  minSpanDays: {value: 30, text: 'The clear readings must span at least 30 days.'},
  smoothingHalfWidthDays: {value: 12, text: 'Each reading is replaced by the median of the clear readings within 12 days either side (a 24-day moving median, about five scenes at the 5-day Sentinel-2 revisit when all are clear), which removes single-scene haze or shadow outliers. One-sided at the ends of the series, so the latest value lags a fast change by about one scene.'},
  noiseFloor: {value: 0.03, text: 'The change threshold is never below 0.03 NDVI, so a very smooth series does not turn tiny wiggles into phases.'},
  noiseMultiple: {value: 2, text: 'Change threshold = max(noise floor, 2 x noise), where noise = 1.4826 x the median absolute residual, a residual being a raw value minus the median of its neighbours within the smoothing window (the value itself excluded). Only readings with a neighbour on each side count: at the ends of the series a one-sided median measures the slope of the season, not noise. The residuals are already centred by the local median, so the deviation is taken about zero. 1.4826 makes it comparable to a standard deviation for normal errors.'},
  minAmplitudeThresholds: {value: 2, text: 'A season amplitude (peak minus trough) counts only when it is at least 2 change thresholds; below that there is no green-up date, no harvested reading, and the levels are not used.'},
  trendWindowDays: {value: 30, text: 'The trend is the least-squares slope of the smoothed values in the last 30 days before the latest reading, both ends included (the last two readings when fewer than two fall in it).'},
  risingPeakDays: {value: 30, text: 'While the curve rises, its peak counts as still forming (provisional top, see the dense-canopy floor) when the peak is at most 30 days before the latest reading.'},
  changeHorizonDays: {value: 15, text: 'The trend is reported as the change over 15 days (slope x 15) and compared with the change threshold.'},
  peakAgeDays: {value: 15, text: 'A harvested reading needs the peak to be more than 15 days before the latest reading.'},
  stagePosition: {value: {earlyBelow: 0.2, risingBelow: 0.55, plateauBelow: 0.8}, text: 'Expected phase from where the latest reading date sits between the timeline start and the latest harvest date (else the end of the last stage), as a fraction f: below 0.2 bare or green-up, below 0.55 rising, below 0.8 plateau, else falling or harvested. Before the start counts as early, after the expected harvest as late. Near a band edge a few days change the comparison.'},
} as const;

const A = STAGE_READER_ASSUMPTIONS, S = STAGE_READER_SOURCES;
const LABEL = 'Field NDVI curve read by code: 24-day moving medians, phase from the 15-day change against the series noise, amplitude fractions from the MODIS MCD12Q2 method, USGS NDVI bands';
const NOTE_KEYS = `Assumptions (STAGE_READER_ASSUMPTIONS): windowLeadDays ${A.windowLeadDays.value}, maxWindowDays ${A.maxWindowDays.value}, minReadings ${A.minReadings.value}, minSpanDays ${A.minSpanDays.value}, smoothingHalfWidthDays ${A.smoothingHalfWidthDays.value}, noiseFloor ${A.noiseFloor.value}, noiseMultiple ${A.noiseMultiple.value}, minAmplitudeThresholds ${A.minAmplitudeThresholds.value}, trendWindowDays ${A.trendWindowDays.value}, risingPeakDays ${A.risingPeakDays.value}, changeHorizonDays ${A.changeHorizonDays.value}, peakAgeDays ${A.peakAgeDays.value}, stagePosition ${A.stagePosition.value.earlyBelow}/${A.stagePosition.value.risingBelow}/${A.stagePosition.value.plateauBelow}. Sourced: MCD12Q2 amplitude fractions ${S.amplitudeFractions.value.greenUp}/${S.amplitudeFractions.value.mid}/${S.amplitudeFractions.value.maturity}; USGS sparse-vegetation floor ${S.sparseVegetationFloor.value}, dense-canopy floor ${S.denseCanopyFloor.value}.`;

// ------------------------------------------------------------------ helpers

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => dayNo(b) - dayNo(a);
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const maxDate = (a: string, b: string) => (a > b ? a : b);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** "2026-10-15" -> "15 Oct 2026" (every digit comes from the ISO date). */
export const fmtDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const PHASE_ORDER: Record<Exclude<IndexStagePhase, 'unknown'>, number> = {bare: 0, green_up: 1, rising: 2, plateau: 3, falling: 4, harvested: 5};

// ------------------------------------------------------------------ input

export interface IndexStageInput {
  readings: readonly NdviReading[];
  /** Calendar date the view is for (IST); readings after it are ignored. */
  today: string;
  timeline: StageTimeline | null;
  cycle: {sowingDate: string; establishmentDate?: string | null | undefined} | null;
  smallField: boolean;
  polygonBasis: NdviSeries['polygonBasis'];
  /**
   * Status of the series the readings came from; an unavailable series gives an unavailable reading. When its `window`
   * is given, the reading's window is clipped to it (a reading never claims days that were not fetched).
   */
  series?: {status: NdviSeries['status']; reason: string | null; window?: {from: string; to: string} | undefined} | null | undefined;
}

interface Pt { date: string; t: number; v: number; s: number }

// ------------------------------------------------------------------ calendar comparison

type Band = 'early' | 'rising' | 'plateau' | 'late';
const EXPECTED: Record<Band, {phases: Exclude<IndexStagePhase, 'unknown'>[]; words: string}> = {
  early: {phases: ['bare', 'green_up'], words: 'bare soil or early growth'},
  rising: {phases: ['rising'], words: 'fast canopy growth'},
  plateau: {phases: ['plateau'], words: 'full canopy'},
  late: {phases: ['falling', 'harvested'], words: 'ripening or harvest'},
};
const bandOf = (f: number): Band => {
  const p = A.stagePosition.value;
  return f < p.earlyBelow ? 'early' : f < p.risingBelow ? 'rising' : f < p.plateauBelow ? 'plateau' : 'late';
};

interface Calendar { stage: IndexStageReading['calendarStage']; band: Band | null; place: string | null; position: number | null }
/**
 * The stage containing the date (stageAt fills the tail up to the latest harvest) is shown; the expected band comes
 * from the date's position f in the cycle (stagePosition). Before the start: early; after the expected harvest: late.
 */
export function calendarAt(timeline: StageTimeline | null, date: string | null): Calendar {
  if (!timeline || !timeline.stages.length || !date) return {stage: null, band: null, place: null, position: null};
  const anchor = timeline.anchorDate;
  const end = timeline.harvest?.latest ?? timeline.stages.at(-1)!.to;
  const f = dayDiff(anchor, date) / Math.max(1, dayDiff(anchor, end));
  const containing = [...timeline.stages].reverse().find((s) => s.from <= date && date <= s.to) ?? stageAt(timeline, date).stage;
  const stage = containing ? {id: containing.id, name: cap(containing.name, 80), from: containing.from, to: containing.to} : null;
  const place = stage ? stage.name : date < anchor ? 'the weeks before the recorded start' : 'the weeks after the expected harvest';
  return {stage, band: bandOf(f), place, position: f};
}

export function agreementOf(phase: IndexStagePhase, band: Band | null): IndexStageReading['agreement'] {
  if (!band) return 'no_calendar';
  if (phase === 'unknown') return 'unknown';
  const expected = EXPECTED[band].phases.map((p) => PHASE_ORDER[p]);
  const o = PHASE_ORDER[phase];
  return o < Math.min(...expected) ? 'curve_earlier' : o > Math.max(...expected) ? 'curve_later' : 'consistent';
}

// ------------------------------------------------------------------ the reader

const scopeOf = (b: NdviSeries['polygonBasis']) => (b === 'boundary' ? 'drawn field boundary' : b === 'farm_point_square' ? '1 ha square around the farm point' : null);

function baseLimitations(i: IndexStageInput): string[] {
  return [
    'Read by code from clear Sentinel-2 scenes of this field; not validated against field observations of crop stage.',
    'Evidence, not a verdict: the stage dates are calendar estimates and are not changed by this reading.',
    'Only clear scenes count, so a cloudy spell can hide a turn in the curve; phase dates are the first clear scene at or past a level and can be up to one scene gap late.',
    i.polygonBasis === 'farm_point_square' ? 'No field boundary is drawn, so a 1 ha square around the farm point stands in for the field.' : null,
    'Edge pixels at 10 m mix the crop with its surroundings.',
    'The 1 km neighbourhood is not used in this reading.',
    i.smallField ? 'The field covers fewer than 12 Sentinel-2 pixels, so this reading is unreliable.' : null,
  ].filter((x): x is string => !!x);
}

function emptyReading(i: IndexStageInput, status: 'insufficient' | 'unavailable', reason: string, summary: string, extra: Partial<IndexStageReading>, note: string): IndexStageReading {
  const cal = calendarAt(i.timeline, extra.asOf ?? null);
  return {
    status, reason: cap(reason, 120), index: 'ndvi', asOf: null, phase: 'unknown', greenUpDate: null, peakDate: null, peakValue: null, troughDate: null, troughValue: null,
    latestSmoothed: null, change15d: null, noise: null, changeThreshold: null, readingsUsed: 0, window: null,
    calendarStage: cal.stage, agreement: agreementOf('unknown', cal.band), summary: cap(summary, 300),
    basis: {kind: 'ndvi', label: LABEL, sourceId: READER_ID, url: MCD12Q2_GUIDE_URL, scope: scopeOf(i.polygonBasis), note: cap(`${note} ${NOTE_KEYS}`.trim(), 1000)},
    limitations: baseLimitations(i).slice(0, 10), ...extra,
  };
}

const STANDS_ALONE = 'the calendar stage estimate stands alone';

export function readIndexStage(i: IndexStageInput): IndexStageReading {
  try {
    return read(i);
  } catch {
    // Pure arithmetic should not throw; if it does, the reading degrades to a reason rather than failing the view.
    return emptyReading(i, 'unavailable', 'reader_error', `The satellite greenness curve could not be read now, so ${STANDS_ALONE}.`, {}, '');
  }
}

function read(i: IndexStageInput): IndexStageReading {
  if (!isDate(i.today)) return emptyReading(i, 'unavailable', 'invalid_date', `The satellite greenness curve could not be read now, so ${STANDS_ALONE}.`, {}, '');
  if (i.series && i.series.status === 'unavailable') {
    return emptyReading(i, 'unavailable', i.series.reason ?? 'satellite_readings_unavailable', `No satellite readings of this field are available now, so ${STANDS_ALONE}.`, {}, '');
  }
  if (!i.readings.length) return emptyReading(i, 'unavailable', 'no_satellite_readings', `No satellite readings of this field are available now, so ${STANDS_ALONE}.`, {}, '');

  // 1. Window and clear readings (same-day duplicates from overlapping tiles collapse to their mean).
  const recorded = i.cycle ? (isDate(i.cycle.establishmentDate) ? i.cycle.establishmentDate : i.cycle.sowingDate) : null;
  const anchor = isDate(recorded) ? recorded : null;
  const floor = addDays(i.today, -A.maxWindowDays.value);
  const fetchedFrom = isDate(i.series?.window?.from) ? i.series!.window!.from : null;
  const own = anchor ? maxDate(addDays(anchor, -A.windowLeadDays.value), floor) : floor;
  const from = fetchedFrom ? maxDate(own, fetchedFrom) : own;
  const window = from <= i.today ? {from, to: i.today} : {from: i.today, to: i.today};
  const byDate = new Map<string, number[]>();
  for (const r of i.readings) {
    if (!r.usable || r.field.mean === null || !Number.isFinite(r.field.mean) || !isDate(r.date) || r.date < window.from || r.date > window.to) continue;
    byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.field.mean]);
  }
  const raw = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, vs]) => ({date, t: dayNo(date), v: vs.reduce((x, y) => x + y, 0) / vs.length}));
  const n = raw.length;
  const spanDays = n ? raw[n - 1]!.t - raw[0]!.t : 0;
  const latestDate = n ? raw[n - 1]!.date : null;
  const counted = `Clear field readings in the window: ${n}${n ? ` over ${spanDays} days (${raw[0]!.date} to ${latestDate})` : ''}; needed: ${A.minReadings.value} over ${A.minSpanDays.value} days.`;
  if (n < A.minReadings.value) {
    return emptyReading(i, 'insufficient', 'too_few_clear_scenes', `Only ${n} of the ${A.minReadings.value} clear satellite scenes needed are available in this window, so no greenness phase is read yet; ${STANDS_ALONE}.`, {asOf: latestDate, readingsUsed: n, window}, counted);
  }
  if (spanDays < A.minSpanDays.value) {
    return emptyReading(i, 'insufficient', 'clear_scenes_span_too_short', `The ${n} clear satellite scenes span ${spanDays} days, fewer than the ${A.minSpanDays.value} needed, so no greenness phase is read yet; ${STANDS_ALONE}.`, {asOf: latestDate, readingsUsed: n, window}, counted);
  }

  // 2. Smoothing (moving median) and the robust noise of the series.
  const h = A.smoothingHalfWidthDays.value;
  const pts: Pt[] = raw.map((p) => ({...p, s: median(raw.filter((q) => Math.abs(q.t - p.t) <= h).map((q) => q.v))}));
  const res = raw.flatMap((p) => {
    const nb = raw.filter((q) => q !== p && Math.abs(q.t - p.t) <= h);
    return nb.some((q) => q.t < p.t) && nb.some((q) => q.t > p.t) ? [p.v - median(nb.map((q) => q.v))] : [];
  });
  const noise = res.length ? 1.4826 * median(res.map(Math.abs)) : 0;
  const tau = Math.max(A.noiseFloor.value, A.noiseMultiple.value * noise);
  const minAmp = A.minAmplitudeThresholds.value * tau;

  // 4. Trend: least-squares slope of the smoothed values in the trend window, as a 15-day change.
  const last = pts[n - 1]!;
  const recent = pts.filter((p) => p.t >= last.t - A.trendWindowDays.value);
  const trendPts = recent.length >= 2 ? recent : pts.slice(-2);
  const mt = trendPts.reduce((x, p) => x + p.t, 0) / trendPts.length, ms = trendPts.reduce((x, p) => x + p.s, 0) / trendPts.length;
  const sxx = trendPts.reduce((x, p) => x + (p.t - mt) ** 2, 0);
  const slope = sxx > 0 ? trendPts.reduce((x, p) => x + (p.t - mt) * (p.s - ms), 0) / sxx : 0;
  const c = slope * A.changeHorizonDays.value;
  const L = last.s;

  // 3. Peak (on or after the recorded start), trough (lowest before the peak, the one closest to it: adapted from MCD12Q2,
  // whose 185-day search window and 0.1 / 35 % amplitude conditions are not implemented), amplitude, levels.
  const candidates = pts.map((p, k) => k).filter((k) => !anchor || pts[k]!.date >= anchor);
  let peakIdx: number | null = null;
  for (const k of candidates) if (peakIdx === null || pts[k]!.s > pts[peakIdx]!.s) peakIdx = k;
  let troughIdx: number | null = null;
  if (peakIdx !== null) {
    troughIdx = peakIdx;
    for (let k = 0; k < peakIdx; k++) if (troughIdx === peakIdx || pts[k]!.s <= pts[troughIdx]!.s) troughIdx = k;
    if (pts[troughIdx]!.s > pts[peakIdx]!.s) troughIdx = peakIdx;
  }
  const peak = peakIdx === null ? null : pts[peakIdx]!, trough = troughIdx === null ? null : pts[troughIdx]!;
  const amp = peak && trough ? peak.s - trough.s : 0;
  const significant = amp >= minAmp && amp > 0;
  const stillRising = !!peak && c > tau && last.t - peak.t <= A.risingPeakDays.value;
  const top = peak ? (stillRising ? Math.max(peak.s, S.denseCanopyFloor.value) : peak.s) : null;
  const F = S.amplitudeFractions.value;
  const levels = significant && trough && top !== null
    ? {greenUp: trough.s + F.greenUp * (top - trough.s), mid: trough.s + F.mid * (top - trough.s), maturity: trough.s + F.maturity * (top - trough.s)}
    : null;
  let greenUp: Pt | null = null;
  if (levels && peakIdx !== null && troughIdx !== null) {
    for (let k = troughIdx + 1; k <= peakIdx; k++) {
      const p = pts[k]!;
      if (p.s >= levels.greenUp && p.s >= S.sparseVegetationFloor.value) { greenUp = p; break; }
    }
  }

  // 5. Phase of the latest reading.
  const upper = (levels !== null && L >= levels.mid) || L >= S.denseCanopyFloor.value;
  let phase: IndexStagePhase;
  // Harvested = back at or below the green-up level (a stand-in for MCD12Q2 dormancy, which needs the segment end) and
  // not greening again.
  if (levels && peak && last.t - peak.t > A.peakAgeDays.value && L <= levels.greenUp && c <= tau) phase = 'harvested';
  else if (L < S.sparseVegetationFloor.value) phase = 'bare';
  else if (c < -tau) phase = 'falling';
  else if (c > tau) phase = upper ? 'rising' : 'green_up';
  else if (upper) phase = 'plateau';
  else phase = 'unknown';

  // 6. Calendar comparison (the stage dates are not changed).
  const cal = calendarAt(i.timeline, last.date);
  const agreement = agreementOf(phase, cal.band);

  // 7. Summary, basis and limitations.
  const d = fmtDate;
  const peakSeen = significant && peak ? peak : null;
  const clause: Record<IndexStagePhase, string> = {
    bare: 'Satellite greenness shows bare soil or very sparse cover',
    green_up: greenUp ? `Satellite greenness has started to rise, with the green-up on ${d(greenUp.date)}` : 'Satellite greenness has started to rise',
    rising: greenUp ? `Satellite greenness has been rising since the green-up on ${d(greenUp.date)}` : 'Satellite greenness is rising',
    plateau: peakSeen ? `Satellite greenness is steady near the peak reached on ${d(peakSeen.date)}` : 'Satellite greenness is steady at a dense green level',
    falling: peakSeen ? `Satellite greenness has been falling since the peak on ${d(peakSeen.date)}` : 'Satellite greenness is falling',
    harvested: `Satellite greenness is back at the pre-season level after the peak on ${d(peak!.date)}, as after a harvest or clearing`,
    unknown: 'The satellite greenness curve shows no clear phase',
  };
  const agreeWords: Record<IndexStageReading['agreement'], string> = {
    consistent: 'so the curve and the calendar agree', curve_earlier: 'so the curve is behind the calendar estimate', curve_later: 'so the curve is ahead of the calendar estimate',
    no_calendar: '', unknown: 'so no comparison is made',
  };
  const calendarClause = !cal.band ? 'there is no calendar stage estimate to compare with'
    : agreement === 'unknown' ? `the calendar puts the crop in ${cal.place}, ${agreeWords.unknown}`
    : `the calendar puts the crop in ${cal.place} and expects ${EXPECTED[cal.band].words}, ${agreeWords[agreement]}`;
  const summary = `${clause[phase]} (latest clear scene ${d(last.date)}); ${calendarClause}.`;

  const limitations = baseLimitations(i);
  if (recent.length < 2) limitations.push(`Fewer than two clear scenes fall in the last ${A.trendWindowDays.value} days, so the trend uses the last two clear scenes (${trendPts[0]!.date} and ${last.date}).`);
  if (levels && stillRising) limitations.push('The curve is still rising, so its peak is not known yet; the levels use the dense-canopy floor as a provisional top and the green-up date can still move.');
  if (anchor && peak === null) limitations.push('No clear scene falls on or after the recorded start date yet, so no season peak or green-up is read.');
  const series = `This series: ${n} clear readings, noise ${r3(noise)}, change threshold ${r3(tau)}, amplitude ${r3(amp)}${levels ? `, levels green-up ${r3(levels.greenUp)} / mid ${r3(levels.mid)} / maturity ${r3(levels.maturity)}${stillRising ? ' (provisional top)' : ''}` : ' (below the minimum amplitude, levels not used)'}.${cal.position !== null ? ` The latest reading sits at ${r3(cal.position)} of the calendar cycle.` : ''}`;

  return {
    status: 'available', reason: null, index: 'ndvi', asOf: last.date, phase,
    greenUpDate: greenUp?.date ?? null, peakDate: peak?.date ?? null, peakValue: peak ? r3(peak.s) : null,
    troughDate: trough?.date ?? null, troughValue: trough ? r3(trough.s) : null,
    latestSmoothed: r3(L), change15d: r3(c), noise: r3(noise), changeThreshold: r3(tau), readingsUsed: n, window,
    calendarStage: cal.stage, agreement, summary: cap(summary, 300),
    basis: {kind: 'ndvi', label: LABEL, sourceId: READER_ID, url: MCD12Q2_GUIDE_URL, scope: scopeOf(i.polygonBasis), note: cap(`${series} ${NOTE_KEYS}`, 1000)},
    limitations: limitations.slice(0, 10),
  };
}
