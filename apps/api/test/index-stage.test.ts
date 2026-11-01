import {describe, expect, it} from 'vitest';
import {IndexStageReading, type NdviReading, type StageTimeline} from '@harvest/contracts';
import {
  MCD12Q2_GUIDE_URL, STAGE_READER_ASSUMPTIONS, STAGE_READER_SOURCES, agreementOf, calendarAt, fmtDate, readIndexStage, type IndexStageInput,
} from '../src/services/today/index-stage';

/**
 * Every curve, date and timeline in this file is SYNTHETIC test data built from a date list and values; none of it is a
 * satellite observation or a crop calendar. Assertions use only the reader's own exported assumptions and sources (or
 * values computed from the synthetic inputs); no outside rule constant is asserted or needed.
 */
const SOW = '2026-06-01';
const day = (n: number) => new Date(Date.parse(`${SOW}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const stats = (mean: number | null, clearFraction: number, usable: boolean) => ({
  mean, median: mean, p10: mean, p90: mean, clearPixels: usable ? 100 : 10, totalPixels: 121, clearFraction, cloudOrShadowFraction: 1 - clearFraction, b04P95: 1800, usable, rejection: usable ? null : 'low_clear_fraction' as const,
});
const reading = (n: number, mean: number | null, usable = true, nb: number | null = mean === null ? null : mean - 0.05): NdviReading => ({
  itemId: `S2A_MSIL2A_${day(n).replace(/-/g, '')}T052231_R062_T43PFQ_${day(n).replace(/-/g, '')}T101714`, date: day(n), acquiredAt: `${day(n)}T05:22:31.024Z`,
  tileId: '43PFQ', baseline: '05.11', offsetApplied: true, sceneCloudPct: usable ? 3 : 80, usable,
  field: stats(mean, usable ? 0.95 : 0.2, usable), neighbourhood: nb === null ? null : stats(nb, 0.9, true),
});
/** A season sampled every 5 days from `fromDay` to `toDay`, with cloudy scenes sprinkled in (unusable, with a misleading value) and one usable scene without a field mean. */
function curve(f: (d: number) => number, fromDay: number, toDay: number, opts: {jitter?: number} = {}): NdviReading[] {
  const out: NdviReading[] = [];
  for (let d = fromDay; d <= toDay; d += 5) {
    const j = opts.jitter ? (Math.round(d / 5) % 2 ? opts.jitter : -opts.jitter) : 0;
    out.push(reading(d, Math.round((f(d) + j) * 1000) / 1000));
    if (d % 20 === 0) out.push(reading(d + 2, 0.05, false)); // cloud: low value, not usable
  }
  out.push(reading(fromDay + 3, null, true)); // usable flag without a mean: ignored
  return out;
}
/** Logistic green-up from 0.15 to 0.8 around day 35, flat top, falling from day 95. */
const season = (d: number) => 0.15 + 0.65 / (1 + Math.exp(-(d - 35) / 6)) - (d > 95 ? Math.min(0.62, (d - 95) * 0.025) : 0);
/** Synthetic 120-day calendar: f = day / 120, so the bands are early < day 24, rising < day 66, plateau < day 96, late after. */
function timeline(anchor = SOW): StageTimeline {
  const at = (n: number) => new Date(Date.parse(`${anchor}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return {
    cropId: 'testcrop', productId: null, establishmentMethod: 'direct_sowing', anchorDate: anchor,
    stages: [
      {id: 'initial', name: 'Initial', from: at(0), to: at(24), basis: 'estimate'},
      {id: 'development', name: 'Crop development', from: at(24), to: at(54), basis: 'estimate'},
      {id: 'mid_season', name: 'Mid-season', from: at(54), to: at(94), basis: 'estimate'},
      {id: 'late_season', name: 'Late season', from: at(94), to: at(120), basis: 'estimate'},
    ],
    harvest: {earliest: at(110), latest: at(120)},
    basis: {kind: 'duration', label: 'Synthetic test calendar', sourceId: null, url: null, scope: null, note: null},
  };
}
const input = (readings: NdviReading[], toDay: number, over: Partial<IndexStageInput> = {}): IndexStageInput => ({
  readings, today: day(toDay + 1), timeline: timeline(), cycle: {sowingDate: SOW, establishmentDate: SOW}, smallField: false, polygonBasis: 'boundary', ...over,
});
const read = (readings: NdviReading[], toDay: number, over: Partial<IndexStageInput> = {}) => IndexStageReading.parse(readIndexStage(input(readings, toDay, over)));

/** Independent re-computation of the 24-day moving median of the clear field readings at each clear date. */
function smoothed(readings: NdviReading[]): Map<string, number> {
  const clear = readings.filter((r) => r.usable && r.field.mean !== null).map((r) => ({t: Date.parse(r.date) / 86_400_000, date: r.date, v: r.field.mean!}));
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
  const h = STAGE_READER_ASSUMPTIONS.smoothingHalfWidthDays.value;
  return new Map(clear.map((p) => [p.date, med(clear.filter((q) => Math.abs(q.t - p.t) <= h).map((q) => q.v))]));
}

/**
 * Every date in the summary is exactly the formatted asOf, greenUpDate or peakDate, and every other digit run appears in
 * the reading's other fields (counts, the basis note).
 */
function digitsTraceable(r: IndexStageReading) {
  const {summary, limitations: _l, ...rest} = r;
  const dates = new Set([r.asOf, r.greenUpDate, r.peakDate].filter((d): d is string => !!d).map(fmtDate));
  for (const d of summary.match(/\d{1,2} [A-Z][a-z]{2} \d{4}/g) ?? []) expect(dates, `date "${d}" in "${summary}"`).toContain(d);
  const fields = JSON.stringify(rest);
  for (const run of summary.replace(/\d{1,2} [A-Z][a-z]{2} \d{4}/g, '').match(/\d+(?:\.\d+)?/g) ?? []) expect(fields, `digit run ${run} in "${summary}"`).toContain(run);
}

describe('index stage reader: phases on synthetic seasons', () => {
  it('green-up: the curve has started to rise and is still below mid-season', () => {
    const r = read(curve(season, -30, 30), 30);
    expect(r).toMatchObject({status: 'available', reason: null, index: 'ndvi', phase: 'green_up', asOf: day(30)});
    expect(r.change15d!).toBeGreaterThan(r.changeThreshold!);
    expect(r.greenUpDate).not.toBeNull();
    expect(r.summary).toMatch(/started to rise/);
    expect(r.limitations.join(' ')).toMatch(/still rising, so its peak is not known yet/);
    digitsTraceable(r);
  });

  it('rising: past mid-season and still greening; the green-up date is the first scene at the level', () => {
    const r = read(curve(season, -30, 50), 50);
    expect(r).toMatchObject({phase: 'rising', calendarStage: {id: 'development'}, agreement: 'consistent'});
    expect(r.troughValue!).toBeCloseTo(0.15, 2);
    // Independent check of the crossing: recompute the moving medians and the level from the reading's own trough and
    // peak (still rising, so the top is max(peak, dense-canopy floor)); the green-up is the first clear scene at or above it.
    const s = smoothed(curve(season, -30, 50));
    const top = Math.max(r.peakValue!, STAGE_READER_SOURCES.denseCanopyFloor.value);
    const level = Math.max(r.troughValue! + STAGE_READER_SOURCES.amplitudeFractions.value.greenUp * (top - r.troughValue!), STAGE_READER_SOURCES.sparseVegetationFloor.value);
    const after = [...s.entries()].filter(([d]) => d > r.troughDate!).sort(([a], [b]) => a.localeCompare(b));
    expect(after.find(([, v]) => v >= level - 0.0005)?.[0]).toBe(r.greenUpDate);
    expect(s.get(r.greenUpDate!)!).toBeGreaterThanOrEqual(level - 0.0005);
    expect(r.summary).toBe(`Satellite greenness has been rising since the green-up on ${fmtDate(r.greenUpDate!)} (latest clear scene ${fmtDate(day(50))}); the calendar puts the crop in Crop development and expects fast canopy growth, so the curve and the calendar agree.`);
    digitsTraceable(r);
  });

  it('green-up date equals the first crossing on a step curve', () => {
    // Flat bare soil, then a jump at day 15 that stays up: the smoothed curve first reaches the level on day 15.
    const step = (d: number) => (d < 15 ? 0.15 : Math.min(0.8, 0.45 + (d - 15) * 0.01));
    const r = read(curve(step, -40, 60), 60);
    expect(r.greenUpDate).toBe(day(15));
    expect(r.troughDate! < day(15)).toBe(true);
  });

  it('plateau: steady near the peak', () => {
    const r = read(curve(season, -30, 90), 90);
    expect(r).toMatchObject({phase: 'plateau', calendarStage: {id: 'mid_season'}, agreement: 'consistent'});
    expect(Math.abs(r.change15d!)).toBeLessThanOrEqual(r.changeThreshold!);
    expect(r.summary).toMatch(/^Satellite greenness is steady near the peak reached on /);
    digitsTraceable(r);
  });

  it('falling: past the peak and losing greenness, still above the dormancy level', () => {
    const r = read(curve(season, -30, 108), 108);
    expect(r).toMatchObject({phase: 'falling', calendarStage: {id: 'late_season'}, agreement: 'consistent'});
    expect(r.change15d!).toBeLessThan(-r.changeThreshold!);
    digitsTraceable(r);
  });

  it('harvested: back below the green-up level after the peak; after the expected harvest the calendar expects ripening or harvest', () => {
    const r = read(curve(season, -30, 130), 130);
    const level = r.troughValue! + STAGE_READER_SOURCES.amplitudeFractions.value.greenUp * (r.peakValue! - r.troughValue!);
    expect(r.latestSmoothed!).toBeLessThanOrEqual(level + 0.001);
    expect(r).toMatchObject({phase: 'harvested', calendarStage: null, agreement: 'consistent'});
    expect(r.summary).toMatch(/back at the pre-season level after the peak on .*the weeks after the expected harvest/);
    digitsTraceable(r);
  });

  it('bare: a low flat series', () => {
    const r = read(curve((d) => 0.12 + (d % 10 ? 0.01 : 0), -30, 20), 20);
    expect(r).toMatchObject({phase: 'bare', greenUpDate: null, calendarStage: {id: 'initial'}, agreement: 'consistent'});
    expect(r.latestSmoothed!).toBeLessThan(STAGE_READER_SOURCES.sparseVegetationFloor.value);
    digitsTraceable(r);
  });

  it('noise threshold: a dense canopy with alternating scene-to-scene jitter stays plateau', () => {
    const r = read(curve(() => 0.7, 0, 60, {jitter: 0.05}), 60, {cycle: {sowingDate: day(-10)}, timeline: null});
    expect(r.phase).toBe('plateau');
    expect(r.noise!).toBeGreaterThan(0);
    expect(r.changeThreshold!).toBeCloseTo(Math.max(STAGE_READER_ASSUMPTIONS.noiseFloor.value, STAGE_READER_ASSUMPTIONS.noiseMultiple.value * r.noise!), 2);
    expect(r.changeThreshold!).toBeGreaterThan(STAGE_READER_ASSUMPTIONS.noiseFloor.value); // the jitter, not the floor, sets the threshold
    expect(r.greenUpDate).toBeNull(); // the jitter is not a season
    expect(r.agreement).toBe('no_calendar');
  });

  it('a previous crop standing in the lead is not this cycle\'s peak', () => {
    // Previous crop high until 10 days before sowing (inside the 30-day lead), then this cycle greens up to a lower top.
    const prev = (d: number) => (d < -10 ? 0.82 : d < 10 ? 0.16 : Math.min(0.62, 0.16 + (d - 10) * 0.02));
    const r = read(curve(prev, -30, 45), 45);
    expect(r.window!.from).toBe(day(-STAGE_READER_ASSUMPTIONS.windowLeadDays.value));
    expect(r.peakDate! >= SOW).toBe(true);
    expect(r.troughValue!).toBeCloseTo(0.16, 2);
    expect(['green_up', 'rising']).toContain(r.phase);
    expect(r.greenUpDate! > SOW).toBe(true);
  });

  it('ignores unusable scenes, scenes after today and outside the window; collapses same-day duplicates by their mean', () => {
    const base = curve(season, -30, 50);
    const extra = [reading(50, 0.2), reading(60, 0.1), reading(-90, 0.9)]; // duplicate of day 50, a future scene, before the window
    const r = read([...base, ...extra], 50);
    const plain = read(base, 50);
    expect(r.readingsUsed).toBe(plain.readingsUsed);
    expect(r.asOf).toBe(day(50));
    expect(r.window).toEqual({from: day(-STAGE_READER_ASSUMPTIONS.windowLeadDays.value), to: day(51)});
    expect(r.latestSmoothed).not.toBe(plain.latestSmoothed); // the day-50 value is now the mean of two scenes
  });
});

describe('index stage reader: window and boundaries', () => {
  it('the window is clipped to the window the series was fetched for', () => {
    const r = read(curve(season, -30, 50), 50, {series: {status: 'available', reason: null, window: {from: day(-10), to: day(51)}}});
    expect(r.window).toEqual({from: day(-10), to: day(51)});
    const unclipped = read(curve(season, -30, 50), 50);
    expect(r.readingsUsed).toBeLessThan(unclipped.readingsUsed);
    expect(r.troughDate! >= day(-10)).toBe(true);
  });

  it('the moving median reaches exactly 12 days either side, not 13', () => {
    // Readings far enough apart that only the latest window matters: 0.9 twelve (or thirteen) days before a latest 0.5.
    const at = (gap: number) => read([reading(0, 0.3), reading(10, 0.3), reading(20, 0.3), reading(40 - gap, 0.9), reading(40, 0.5)], 40, {timeline: null});
    expect(at(12).latestSmoothed).toBeCloseTo(0.7, 3); // median of 0.9 and 0.5
    expect(at(13).latestSmoothed).toBeCloseTo(0.5, 3); // 0.9 is outside the window
  });

  it('the trend window includes a reading exactly 30 days back and falls back to the last two readings beyond that', () => {
    // Readings more than 24 days apart, so each smoothed value is the raw value.
    const at = (gap: number) => read([reading(0, 0.3), reading(25, 0.3), reading(70 - gap, 0.4), reading(70, 0.6)], 70, {timeline: null});
    const in30 = at(30), out31 = at(31);
    expect(in30.change15d).toBeCloseTo((0.2 / 30) * 15, 3);
    expect(in30.limitations.join(' ')).not.toMatch(/trend uses the last two clear scenes/);
    expect(out31.change15d).toBeCloseTo((0.2 / 31) * 15, 3);
    expect(out31.limitations.join(' ')).toMatch(/Fewer than two clear scenes fall in the last 30 days, so the trend uses the last two clear scenes/);
  });
});

describe('index stage reader: insufficient and unavailable', () => {
  it('three clear scenes are too few; six over 20 days span too little', () => {
    const three = read([reading(0, 0.2), reading(10, 0.3), reading(20, 0.4), reading(25, 0.1, false)], 20);
    expect(three).toMatchObject({status: 'insufficient', reason: 'too_few_clear_scenes', phase: 'unknown', readingsUsed: 3, asOf: day(20), latestSmoothed: null, agreement: 'unknown', calendarStage: {id: 'initial'}});
    expect(three.summary).toBe(`Only 3 of the ${STAGE_READER_ASSUMPTIONS.minReadings.value} clear satellite scenes needed are available in this window, so no greenness phase is read yet; the calendar stage estimate stands alone.`);
    digitsTraceable(three);
    const six = read([0, 4, 8, 12, 16, 20].map((d) => reading(d, 0.2 + d / 100)), 20);
    expect(six).toMatchObject({status: 'insufficient', reason: 'clear_scenes_span_too_short', readingsUsed: 6});
    expect(six.summary).toMatch(/span 20 days, fewer than the 30 needed/);
    digitsTraceable(six);
  });

  it('no readings or an unavailable series: unavailable with the reason', () => {
    expect(read([], 10)).toMatchObject({status: 'unavailable', reason: 'no_satellite_readings', asOf: null, window: null, readingsUsed: 0});
    expect(read(curve(season, -30, 50), 50, {series: {status: 'unavailable', reason: 'live_mode_required'}})).toMatchObject({status: 'unavailable', reason: 'live_mode_required'});
  });
});

describe('index stage reader: calendar comparison', () => {
  it('agreement covers all five states', () => {
    // consistent: rising in the rising band (day 50 of 120).
    expect(read(curve(season, -30, 50), 50).agreement).toBe('consistent');
    // curve_earlier: still green-up when the calendar expects fast growth (calendar started 20 days before sowing).
    const early = read(curve(season, -30, 30), 30, {timeline: timeline(day(-20))});
    expect(early).toMatchObject({phase: 'green_up', agreement: 'curve_earlier'});
    expect(early.summary).toMatch(/so the curve is behind the calendar estimate\.$/);
    // curve_later: falling while the calendar expects full canopy (calendar started 30 days after sowing).
    const late = read(curve(season, -30, 108), 108, {timeline: timeline(day(30))});
    expect(late).toMatchObject({phase: 'falling', agreement: 'curve_later'});
    expect(late.summary).toMatch(/so the curve is ahead of the calendar estimate\.$/);
    // no_calendar: no timeline.
    expect(read(curve(season, -30, 50), 50, {timeline: null})).toMatchObject({agreement: 'no_calendar', calendarStage: null});
    // unknown: a steady sparse cover has no clear phase.
    const flat = read(curve(() => 0.35, -30, 40), 40);
    expect(flat).toMatchObject({phase: 'unknown', agreement: 'unknown'});
    expect(flat.summary).toMatch(/no clear phase .* so no comparison is made\.$/);
  });

  it('the stage dates are not changed by the reading, and the mapping uses the date position', () => {
    const t = timeline();
    const before = JSON.stringify(t);
    readIndexStage(input(curve(season, -30, 108), 108, {timeline: t}));
    expect(JSON.stringify(t)).toBe(before);
    expect(calendarAt(t, day(-5))).toMatchObject({stage: null, band: 'early'});
    expect(calendarAt(t, day(30))).toMatchObject({stage: {id: 'development'}, band: 'rising'});
    expect(calendarAt(t, day(70))).toMatchObject({stage: {id: 'mid_season'}, band: 'plateau'});
    expect(calendarAt(t, day(100))).toMatchObject({stage: {id: 'late_season'}, band: 'late'});
    expect(calendarAt(null, day(30))).toMatchObject({band: null});
    expect(agreementOf('harvested', 'early')).toBe('curve_later');
    expect(agreementOf('bare', 'plateau')).toBe('curve_earlier');
  });
});

describe('index stage reader: basis, limitations and contract', () => {
  it('names the method, the source and every assumption key; states it is evidence, not a verdict', () => {
    const r = read(curve(season, -30, 50), 50, {polygonBasis: 'farm_point_square', smallField: true});
    expect(r.basis).toMatchObject({kind: 'ndvi', sourceId: 'index-stage-reader-v1', url: MCD12Q2_GUIDE_URL, scope: '1 ha square around the farm point'});
    expect(r.basis.label).toBe('Field NDVI curve read by code: 24-day moving medians, phase from the 15-day change against the series noise, amplitude fractions from the MODIS MCD12Q2 method, USGS NDVI bands');
    for (const key of Object.keys(STAGE_READER_ASSUMPTIONS)) expect(r.basis.note).toContain(key);
    const text = r.limitations.join(' ');
    expect(text).toMatch(/not validated against field observations/);
    expect(text).toMatch(/Evidence, not a verdict: the stage dates are calendar estimates and are not changed by this reading/);
    expect(text).toMatch(/1 ha square around the farm point stands in/);
    expect(text).toMatch(/so this reading is unreliable/);
    expect(text).toMatch(/neighbourhood is not used/);
    expect(r.limitations.length).toBeLessThanOrEqual(10);
    for (const a of Object.values(STAGE_READER_ASSUMPTIONS)) expect(a.text.length).toBeGreaterThan(20);
  });

  it('every reading parses against the contract and never throws on odd input', () => {
    const odd = readIndexStage({readings: [reading(0, 0.3)], today: 'not-a-date', timeline: null, cycle: null, smallField: false, polygonBasis: null});
    expect(IndexStageReading.parse(odd)).toMatchObject({status: 'unavailable', reason: 'invalid_date'});
    const noCycle = IndexStageReading.parse(readIndexStage({readings: curve(season, -30, 50), today: day(51), timeline: null, cycle: null, smallField: false, polygonBasis: null}));
    expect(noCycle.status).toBe('available');
  });
});
