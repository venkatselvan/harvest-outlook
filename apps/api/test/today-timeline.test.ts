import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {serializerCompiler, validatorCompiler} from 'fastify-type-provider-zod';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {StageTimeline} from '@harvest/contracts';
import {
  loadAgronomyPool, parseAgronomyPool, parseFocusedPool, stageAt, stageTimeline, timelineSpan, type StageTimelineInput,
} from '../src/services/today/stage-timeline';
import {MAX_TRACK_DAYS, unavailableTrack, weatherTrack, type WeatherTrackDay} from '../src/services/today/weather-track';
import {todayTimelineRoutes} from '../src/routes/today-timeline';
import {eachDate} from '../src/plans/weather';
import type {DailyWeather, ForecastBundle, WeatherSource} from '../src/plans/sources';
import {SYNTHETIC_SOURCE_ID, ensureSource} from '../src/ingest/sources';
import {loadProviderConfig} from '../src/providers/config';
import {createPool, type Pool} from '../src/db/pool';
import {migrate} from '../src/db/migrate';
import {errorEnvelope} from '../src/envelope';
import {ApiError} from '../src/services/errors';
import {sessionRoutes} from '../src/routes/session';
import {farmRoutes} from '../src/routes/farms';
import {FsStorage} from '../src/storage/fs';
import {ORIGIN, TEST_DB, login, testConfig, type Client} from './helpers';

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ fixture agronomy and focused pools (same parser as the real file)

const FIXTURE_AGRONOMY = {
  schemaVersion: 'fixture', futureTopLevelField: {anything: true},
  sourceCatalog: [{id: 'IISR-GIN', url: 'https://example.test/iisr', extra: 1}, {id: 'FAO-56', url: 'https://example.test/fao'}, {id: 'TNAU-X', url: 'https://example.test/tnau'}, {id: 'NOURL'}],
  crops: [
    // Deliberately different stage boundaries from the curated Hassan model, so a wrong precedence is visible in the dates.
    {
      cropId: 'ginger', futureField: 1, productIds: ['ginger-fresh', 'ginger-dry'],
      stagesBasis: {type: 'crop_specific', source: 'IISR-GIN p14', note: 'fixture note'},
      stages: [{id: 'a', name: 'Fixture A', startDay: 0, endDay: 60, description: 'x'}, {id: 'b', name: 'Fixture B', startDay: 60, endDay: 120}, {id: 'c', name: 'Fixture C', startDay: 120, endDay: 200}, {id: 'd', name: 'Fixture D', startDay: 200, endDay: 250}],
      durationDays: [{method: 'rhizome_planting', min: 200, max: 200, cultivar: 'x', source: 'IISR-GIN T1'}, {method: 'rhizome_planting', min: 210, max: 240, source: 'IISR-GIN p25'}],
    },
    {
      cropId: 'rice', stagesBasis: {type: 'FAO_Kc_split', source: 'FAO-56 Table 11 Rice', note: 'not cultivar phenology'},
      stages: [{id: 'initial', name: 'Initial', startDay: 0, endDay: 30}, {id: 'development', name: 'Crop development', startDay: 30, endDay: 60}, {id: 'mid_season', name: 'Mid-season', startDay: 60, endDay: 120}, {id: 'late_season', name: 'Late season', startDay: 120, endDay: 150}],
      durationDays: [
        {method: 'direct_sowing', min: 100, max: 105, cultivar: 'A', source: 'TNAU-X Duration'},
        {method: 'transplanting', min: 105, max: 110, cultivar: 'B', source: 'TNAU-X Duration', note: 'Includes nursery period; anchor sowing.'},
        {method: 'any', min: 60, max: 70, region: 'IN-TN-coimbatore', source: 'TNAU-X'},
      ],
    },
    {cropId: 'pulse', durationDays: [{method: 'direct_sowing', min: 60, max: 80, source: 'TNAU-X Variety table'}]},
    {
      cropId: 'gram', stagesBasis: {type: 'TNAU_cultivar_phenology', source: 'TNAU-X CO 6', note: 'Boundaries are midpoints of the published ranges; arithmetic, not source values.'},
      stages: [{id: 'vegetative', name: 'Sowing to 50% flowering', startDay: 0, endDay: 28}, {id: 'reproductive', name: '50% flowering to maturity', startDay: 28, endDay: 65}], durationDays: [],
    },
    {cropId: 'unclassified', stages: [{id: 's1', name: 'Only stage', startDay: 0, endDay: 50}]},
    {
      cropId: 'coriander', durationDays: [
        {method: 'direct_sowing', min: 30, max: 40, productId: 'coriander-leaf', source: 'TNAU-X'},
        {method: 'direct_sowing', min: 90, max: 110, productId: 'coriander-seed', source: 'TNAU-X'},
      ],
    },
    {cropId: 'empty', productIds: [], durationDays: [], stages: []},
    {cropId: 'chilli', durationDays: [{method: 'transplanting', min: 75, max: null, source: 'TNAU-X'}]},
    {cropId: 'broken-stage', stages: [{id: 'ok', name: 'Fine', startDay: 0, endDay: 10}, {id: 'zero', name: 'Zero length', startDay: 10, endDay: 10}, {id: 7}], durationDays: [{method: 'any', min: 20, max: 10}, {method: 'any'}]},
    {cropId: 7},
  ],
};
const agronomy = parseAgronomyPool(FIXTURE_AGRONOMY);
const focused = parseFocusedPool({
  sources: [{id: 'F1', url: 'https://example.test/f1'}],
  crops: [
    {cropId: 'focusedonly', duration: {minDays: 70, maxDays: 90, anchor: 'planting', kind: 'crop_completion', sourceRefs: [{sourceId: 'F1'}]}},
    {cropId: 'focusedsow', duration: {minDays: 50, maxDays: 60, anchor: 'sowing'}},
    {cropId: 'ginger', duration: {minDays: 999, maxDays: 999, anchor: 'planting'}},
  ],
});

const base: StageTimelineInput = {cropId: 'ginger', productId: 'ginger-fresh', establishmentMethod: 'rhizome_planting', anchorDate: '2026-05-15', stateId: 'IN-KA', districtId: 'IN-KA-hassan', agronomy, focused};
const A = base.anchorDate;

describe('stageTimeline precedence', () => {
  it('ginger in Hassan uses the sourced catalogue model, not the agronomy stage lengths', () => {
    const t = stageTimeline(base);
    expect(StageTimeline.safeParse(t).success).toBe(true);
    expect(t.stages.map((s) => s.id)).toEqual(['sprouting_vegetative', 'rhizome_initiation', 'rhizome_development', 'maturation', 'harvest_full_maturity']);
    // Curated model: 90, 45, 45 days then maturation 30 (shortest) and a harvest window up to 60 more.
    expect(t.stages.map((s) => [s.from, s.to])).toEqual([[A, plus(A, 90)], [plus(A, 90), plus(A, 135)], [plus(A, 135), plus(A, 180)], [plus(A, 180), plus(A, 210)], [plus(A, 210), plus(A, 240)]]);
    expect(new Set(t.stages.map((s) => s.basis))).toEqual(new Set(['sourced']));
    expect(t.stages.every((s) => s.name.length <= 80 && !s.name.includes('('))).toBe(true);
    expect(t.basis).toMatchObject({kind: 'duration', sourceId: 'stage.ginger.hassan-kharif', scope: 'IN-KA-hassan'});
    // The stage model governs the harvest window (210 to 240); the published durations (200 to 240) are quoted in the note, not used.
    expect(t.harvest).toEqual({earliest: plus(A, 210), latest: plus(A, 240)});
    expect(t.basis.note).toContain(`${plus(A, 210)} to ${plus(A, 240)}`);
    expect(t.basis.note).toContain(`${plus(A, 200)} to ${plus(A, 240)}`);
    expect(t.basis.note).toMatch(/not an observation/);
  });

  it('honours an injected snapshot and falls through to agronomy stages outside the catalogue geography', () => {
    const noModel = stageTimeline({...base, snapshot: {stages: []}});
    expect(noModel.stages.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(noModel.stages.map((s) => s.from)).toEqual([A, plus(A, 60), plus(A, 120), plus(A, 200)]);
    expect(noModel.stages.at(-1)!.to).toBe(plus(A, 250));
    expect(new Set(noModel.stages.map((s) => s.basis))).toEqual(new Set(['sourced']));
    expect(noModel.basis).toMatchObject({sourceId: 'IISR-GIN', url: 'https://example.test/iisr'});
    expect(noModel.basis.note).toContain('fixture note');
    // Same crop, a district without a stage model: also agronomy.
    expect(stageTimeline({...base, districtId: 'IN-KA-chikmagalur'}).stages.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    // The harvest window is the duration envelope in both cases; stage lengths running past it are flagged, not reconciled.
    expect(noModel.harvest).toEqual({earliest: plus(A, 200), latest: plus(A, 240)});
    expect(noModel.basis.note).toContain('Stage lengths run to day 250 while the published duration ends at day 240');
  });

  it('a crop with only FAO Kc stage splits gets fao_generic and says so', () => {
    const t = stageTimeline({...base, cropId: 'rice', productId: null, establishmentMethod: 'transplanting', anchorDate: '2026-07-10', stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
    expect(new Set(t.stages.map((s) => s.basis))).toEqual(new Set(['fao_generic']));
    expect(t.stages.map((s) => [s.from, s.to])).toEqual([[0, 30], [30, 60], [60, 120], [120, 150]].map(([a, b]) => [plus('2026-07-10', a!), plus('2026-07-10', b!)]));
    expect(t.basis.label).toMatch(/standard crop coefficients/i);
    expect(t.basis).toMatchObject({sourceId: 'FAO-56', url: 'https://example.test/fao'});
    expect(t.basis.note).toMatch(/not cultivar or district measurements/);
  });

  it('matches harvest durations to establishment method and region instead of mixing every cultivar', () => {
    const transplanted = stageTimeline({...base, cropId: 'rice', productId: null, establishmentMethod: 'transplanting'});
    expect(transplanted.harvest).toEqual({earliest: plus(A, 105), latest: plus(A, 110)});
    expect(transplanted.basis.note).toMatch(/nursery period/);
    const sown = stageTimeline({...base, cropId: 'rice', productId: null, establishmentMethod: 'direct_sowing'});
    expect(sown.harvest).toEqual({earliest: plus(A, 100), latest: plus(A, 105)});
    expect(sown.basis.note).not.toMatch(/nursery/);
    // A Coimbatore-only entry applies only to a Coimbatore farm.
    expect(stageTimeline({...base, cropId: 'rice', productId: null, establishmentMethod: 'direct_sowing', stateId: 'IN-TN', districtId: 'IN-TN-coimbatore'}).harvest).toEqual({earliest: plus(A, 60), latest: plus(A, 105)});
    // Unrecorded method considers every method, and says so.
    const unknownMethod = stageTimeline({...base, cropId: 'rice', productId: null, establishmentMethod: null});
    expect(unknownMethod.harvest).toEqual({earliest: plus(A, 100), latest: plus(A, 110)});
    expect(unknownMethod.basis.note).toMatch(/method is not recorded/);
  });

  it('duration-only crop gets a two-stage estimate that ends at the duration', () => {
    const t = stageTimeline({...base, cropId: 'pulse', productId: null, establishmentMethod: 'direct_sowing', districtId: null});
    expect(t.stages.map((s) => [s.id, s.basis])).toEqual([['growing', 'estimate'], ['maturing', 'estimate']]);
    expect(t.stages.map((s) => [s.from, s.to])).toEqual([[A, plus(A, 45)], [plus(A, 45), plus(A, 80)]]);
    expect(t.harvest).toEqual({earliest: plus(A, 60), latest: plus(A, 80)});
    expect(t.stages.at(-1)!.to).toBe(t.harvest!.latest);
    expect(t.basis.note).toMatch(/split is an assumption/);
    expect(t.basis).toMatchObject({sourceId: 'TNAU-X'});
  });

  it('an open-ended duration is flagged, never turned into a closed window silently', () => {
    const t = stageTimeline({...base, cropId: 'chilli', productId: null, establishmentMethod: 'transplanting'});
    expect(t.harvest).toEqual({earliest: plus(A, 75), latest: plus(A, 75)});
    expect(t.basis.note).toMatch(/open-ended/);
  });

  it('an unknown crop, or one with nothing usable, gets empty stages and a null harvest', () => {
    for (const cropId of ['no-such-crop', 'empty']) {
      const t = stageTimeline({...base, cropId});
      expect(t).toMatchObject({stages: [], harvest: null, cropId, basis: {note: 'no sourced stage data', sourceId: null}});
    }
  });

  it('focused-crop duration is the fallback, only when its anchor matches the establishment method', () => {
    const used = stageTimeline({...base, cropId: 'focusedonly', productId: null, establishmentMethod: 'rhizome_planting'});
    expect(used.harvest).toEqual({earliest: plus(A, 70), latest: plus(A, 90)});
    expect(used.stages.map((s) => s.id)).toEqual(['growing', 'maturing']);
    expect(used.basis).toMatchObject({sourceId: 'F1', url: 'https://example.test/f1'});
    // Duration counted from planting must not date a sown crop.
    expect(stageTimeline({...base, cropId: 'focusedonly', productId: null, establishmentMethod: 'direct_sowing'}).stages).toEqual([]);
    expect(stageTimeline({...base, cropId: 'focusedsow', productId: null, establishmentMethod: 'direct_sowing'}).harvest).toEqual({earliest: plus(A, 50), latest: plus(A, 60)});
    // Agronomy durations win over the focused value (999) when both exist.
    expect(stageTimeline({...base, snapshot: {stages: []}}).harvest!.latest).toBe(plus(A, 240));
  });

  it('product-specific durations apply only to their product', () => {
    const at = (productId: string | null) => stageTimeline({...base, cropId: 'coriander', productId, establishmentMethod: 'direct_sowing'});
    expect(at('coriander-leaf').harvest).toEqual({earliest: plus(A, 30), latest: plus(A, 40)});
    expect(at('coriander-seed').harvest).toEqual({earliest: plus(A, 90), latest: plus(A, 110)});
    expect(at(null)).toMatchObject({stages: [], harvest: null});
  });

  it('stage basis follows the record: crop-specific is sourced, unclassified is estimate, and the record note travels', () => {
    const gram = stageTimeline({...base, cropId: 'gram', productId: null, establishmentMethod: 'direct_sowing'});
    expect(new Set(gram.stages.map((s) => s.basis))).toEqual(new Set(['sourced']));
    expect(gram.stages.map((s) => s.name)).toEqual(['Sowing to 50% flowering', '50% flowering to maturity']);
    expect(gram.basis.note).toMatch(/arithmetic, not source values/);
    // No published duration: harvest is the end of the last stage, and that is stated.
    expect(gram.harvest).toEqual({earliest: plus(A, 65), latest: plus(A, 65)});
    expect(gram.basis.note).toMatch(/No published duration matched/);
    const unclassified = stageTimeline({...base, cropId: 'unclassified', productId: null});
    expect(new Set(unclassified.stages.map((s) => s.basis))).toEqual(new Set(['estimate']));
  });

  it('rejects a malformed anchor date instead of producing nonsense dates', () => {
    expect(() => stageTimeline({...base, anchorDate: '2026-13-45'})).toThrow(RangeError);
    expect(() => stageTimeline({...base, anchorDate: 'yesterday'})).toThrow(RangeError);
  });
});

describe('agronomy loader', () => {
  it('tolerates unknown fields, skips malformed records and rows, and lists what it dropped', () => {
    expect(agronomy.crops.has('ginger')).toBe(true);
    expect(agronomy.sources.get('NOURL')).toBeNull();
    expect(agronomy.crops.has('7')).toBe(false);
    const broken = agronomy.crops.get('broken-stage')!;
    expect(broken.stages.map((s) => s.id)).toEqual(['ok']);
    expect(broken.durations).toEqual([]);
    expect(agronomy.issues.some((i) => /crops\[\d+\]/.test(i))).toBe(true);
    expect(agronomy.issues.some((i) => /min > max/.test(i))).toBe(true);
    expect(agronomy.issues.some((i) => /endDay <= startDay/.test(i))).toBe(true);
    expect(parseAgronomyPool('not json at all').crops.size).toBe(0);
  });

  it('caches the real file once and invalidate() forces a fresh read', () => {
    const first = loadAgronomyPool();
    expect(loadAgronomyPool()).toBe(first);
    loadAgronomyPool.invalidate();
    const second = loadAgronomyPool();
    expect(second).not.toBe(first);
    expect([...second.crops.keys()].sort()).toEqual([...first.crops.keys()].sort());
  });

  it('every crop in the real pool yields a contract-valid, ordered timeline whose basis follows the raw record', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(resolve(here, '../../../data/research/rotation/crop-agronomy.json'), 'utf8')) as {crops: {cropId: string; stagesBasis?: {type?: string} | null; stages?: unknown[]; durationDays?: unknown[]}[]};
    const pool = loadAgronomyPool();
    expect(pool.crops.size).toBeGreaterThan(0);
    for (const method of [null, 'direct_sowing', 'transplanting']) {
      for (const rec of raw.crops) {
        const crop = pool.crops.get(rec.cropId);
        if (!crop) continue; // a record the tolerant loader rejected is reported in pool.issues, not asserted here
        const t = stageTimeline({cropId: rec.cropId, productId: crop.productIds[0] ?? null, establishmentMethod: method, anchorDate: '2026-06-01', stateId: 'IN-TN', districtId: 'IN-TN-coimbatore', snapshot: {stages: []}});
        expect(StageTimeline.safeParse(t).success, rec.cropId).toBe(true);
        expect(t.stages.length === 0, `${rec.cropId}: stages empty iff harvest null`).toBe(t.harvest === null);
        for (const [i, s] of t.stages.entries()) {
          expect(s.from < s.to, `${rec.cropId} ${s.id}`).toBe(true);
          if (i > 0) expect(s.from, `${rec.cropId} contiguous`).toBe(t.stages[i - 1]!.to);
        }
        if (t.harvest) {
          expect(t.harvest.earliest <= t.harvest.latest, rec.cropId).toBe(true);
          expect(t.harvest.latest >= t.stages[0]!.from, rec.cropId).toBe(true);
        }
        if ((rec.stages?.length ?? 0) > 0 && /fao/i.test(rec.stagesBasis?.type ?? '')) expect(new Set(t.stages.map((s) => s.basis)), rec.cropId).toEqual(new Set(['fao_generic']));
        if ((rec.stages?.length ?? 0) === 0 && t.stages.length) expect(t.stages.map((s) => s.basis), rec.cropId).toEqual(['estimate', 'estimate']);
      }
    }
  });
});

describe('stageAt', () => {
  const t = stageTimeline(base); // ginger Hassan: 0 / 90 / 135 / 180 / 210 days, harvest 210 to 240 (stage model)
  const at = (days: number) => stageAt(t, plus(A, days));

  it('anchor, mid-cycle and stage boundaries', () => {
    expect(at(0)).toMatchObject({index: 0, progress: 0, phase: 'growing'});
    expect(at(0).stage!.id).toBe('sprouting_vegetative');
    expect(at(100)).toMatchObject({index: 1, phase: 'growing'});
    expect(at(100).progress).toBeCloseTo(100 / 240, 10);
    expect(at(89).stage!.id).toBe('sprouting_vegetative');
    expect(at(90).stage!.id).toBe('rhizome_initiation'); // a boundary date belongs to the stage that starts on it
  });

  it('harvest window, the last day, after harvest and before the anchor', () => {
    expect(at(199)).toMatchObject({phase: 'growing'});
    expect(at(205)).toMatchObject({phase: 'growing'});
    expect(at(205).stage!.id).toBe('maturation');
    expect(at(210)).toMatchObject({phase: 'harvest_window'});
    expect(at(210).stage!.id).toBe('harvest_full_maturity');
    expect(at(240)).toMatchObject({phase: 'harvest_window', progress: 1});
    expect(at(240).stage!.id).toBe('harvest_full_maturity');
    expect(at(241)).toEqual({stage: null, index: null, progress: 1, phase: 'after_harvest'});
    expect(at(-1)).toEqual({stage: null, index: null, progress: 0, phase: 'before_anchor'});
  });

  it('the slider ends at the latest harvest, and the last stage covers the tail between its end and that date', () => {
    const tail = StageTimeline.parse({
      cropId: 'x', productId: null, establishmentMethod: null, anchorDate: '2026-01-01',
      stages: [{id: 'only', name: 'Only', from: '2026-01-01', to: '2026-01-11', basis: 'estimate'}],
      harvest: {earliest: '2026-01-11', latest: '2026-01-21'},
      basis: {kind: 'duration', label: 'x', sourceId: null, url: null, scope: null, note: null},
    });
    expect(timelineSpan(tail)).toEqual({start: '2026-01-01', end: '2026-01-21'});
    expect(stageAt(tail, '2026-01-15')).toMatchObject({index: 0, phase: 'harvest_window'});
    expect(stageAt(tail, '2026-01-15').progress).toBeCloseTo(14 / 20, 10);
    expect(stageAt(tail, '2026-01-22').phase).toBe('after_harvest');
  });

  it('a timeline without data has no slider position', () => {
    const empty = stageTimeline({...base, cropId: 'no-such-crop'});
    expect(timelineSpan(empty)).toBeNull();
    expect(stageAt(empty, A)).toEqual({stage: null, index: null, progress: 0, phase: 'unknown'});
  });
});

// ------------------------------------------------------------------ weather track (injected source, no database, no network)

const AS_OF = '2026-11-01T04:00:00Z'; // 09:30 on 2026-11-01 in India
const dw = (date: string, rain: number | null, tMin: number | null, tMax: number | null, sourceId = 'open-meteo-archive'): DailyWeather => ({date, rainMm: rain, et0Mm: null, tMinC: tMin, tMaxC: tMax, sourceId});
const forecastBundle = (issuedAt: string, from: string, to: string): ForecastBundle => ({issuedAt, sourceId: 'open-meteo-forecast', days: eachDate(from, to).map((d) => dw(d, 1, 21, 31, 'open-meteo-forecast'))});
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
function fakeSource(o: {obs?: DailyWeather[]; forecast?: ForecastBundle | null; clim?: boolean}): WeatherSource {
  return {
    modes: ['live', 'replay', 'synthetic'],
    getDailyObservations: async () => o.obs ?? [], // deliberately ignores the range: classification must not trust the source to filter
    getForecast: async () => o.forecast ?? null,
    getClimatology: async (_s, range) => (o.clim ? {years: {from: 2019, to: 2025}, qualifyingYears: YEARS, sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map((d) => dw(d, 4, 20, 30))} : null),
    dataVersion: async () => 'v',
  };
}
const track = (source: WeatherSource, from: string, to: string, asOf = AS_OF) => weatherTrack({source}, {point: {lat: 13, lon: 76.1}, from, to, asOf, mode: 'synthetic'});
const kinds = (days: WeatherTrackDay[]) => Object.fromEntries(days.map((d) => [d.date, d.kind]));

describe('weatherTrack labels', () => {
  const full = () => fakeSource({
    obs: [dw('2026-10-26', 0, 20, 30), dw('2026-10-27', 0, 20, 30), dw('2026-10-28', 5, 19, 28), dw('2026-11-02', 99, 0, 0)],
    forecast: forecastBundle('2026-10-31T02:00:00.000Z', '2026-10-31', '2026-11-06'),
    clim: true,
  });

  it('observed, then stored forecast to its horizon, then typical; nothing past the horizon is a forecast', async () => {
    const t = await track(full(), '2026-10-26', '2026-11-12');
    expect(kinds(t.days)).toEqual({
      '2026-10-26': 'observed', '2026-10-27': 'observed', '2026-10-28': 'observed',
      '2026-10-29': 'unavailable', '2026-10-30': 'unavailable', // no archive row and the forecast starts later
      '2026-10-31': 'forecast', // past, not archived yet: shown from the forecast issued that morning, labelled as such
      '2026-11-01': 'forecast', '2026-11-02': 'forecast', '2026-11-03': 'forecast', '2026-11-04': 'forecast', '2026-11-05': 'forecast', '2026-11-06': 'forecast',
      '2026-11-07': 'typical', '2026-11-08': 'typical', '2026-11-09': 'typical', '2026-11-10': 'typical', '2026-11-11': 'typical', '2026-11-12': 'typical',
    });
    expect(t.forecastHorizonEnd).toBe('2026-11-06');
    expect(t.days.filter((d) => d.kind === 'forecast').every((d) => d.date <= t.forecastHorizonEnd!)).toBe(true);
    // An archive row dated after "today" is look-ahead and never shown as observed.
    expect(t.days.find((d) => d.date === '2026-11-02')).toMatchObject({kind: 'forecast', rainMm: 1});
    expect(t.days.find((d) => d.date === '2026-10-28')).toMatchObject({kind: 'observed', rainMm: 5, tMinC: 19, tMaxC: 28, basis: {source: 'open-meteo-archive', issuedAt: null, years: null}});
    expect(t.days.find((d) => d.date === '2026-11-01')).toMatchObject({kind: 'forecast', tMaxC: 31, basis: {source: 'open-meteo-forecast', issuedAt: '2026-10-31T02:00:00.000Z', years: null}});
    expect(t.days.find((d) => d.date === '2026-11-09')).toMatchObject({kind: 'typical', rainMm: 4, tMinC: 20, tMaxC: 30, basis: {source: 'open-meteo-archive', issuedAt: null, years: YEARS}});
    expect(t.days.find((d) => d.date === '2026-10-30')).toEqual({date: '2026-10-30', kind: 'unavailable', rainMm: null, tMinC: null, tMaxC: null, basis: {source: null, issuedAt: null, years: null}});
    const text = t.limitations.join(' ');
    expect(text).toMatch(/Nothing after that date is labelled a forecast/);
    expect(text).toMatch(/reanalysis/);
    expect(text).toMatch(/7 years \(2019 to 2025\).*not a forecast/);
    expect(text).toMatch(/2 past days have no archive value/);
  });

  it('without enough archive years the days beyond the horizon are unavailable, not typical and not forecast', async () => {
    const t = await track(fakeSource({forecast: forecastBundle('2026-10-31T02:00:00.000Z', '2026-10-31', '2026-11-03'), clim: false}), '2026-11-01', '2026-11-08');
    expect(kinds(t.days)).toEqual({
      '2026-11-01': 'forecast', '2026-11-02': 'forecast', '2026-11-03': 'forecast',
      '2026-11-04': 'unavailable', '2026-11-05': 'unavailable', '2026-11-06': 'unavailable', '2026-11-07': 'unavailable', '2026-11-08': 'unavailable',
    });
    expect(t.limitations.join(' ')).toMatch(/5 future days have no typical values: fewer than 5 complete archive years/);
  });

  it('with no stored forecast even today is typical, never a forecast', async () => {
    const t = await track(fakeSource({clim: true}), '2026-10-31', '2026-11-03');
    expect(kinds(t.days)).toEqual({'2026-10-31': 'unavailable', '2026-11-01': 'typical', '2026-11-02': 'typical', '2026-11-03': 'typical'});
    expect(t.forecastHorizonEnd).toBeNull();
    expect(t.limitations.join(' ')).toMatch(/No stored forecast/);
  });

  it('a stale forecast whose horizon has passed does not label today or later as forecast', async () => {
    const stale = forecastBundle('2026-10-20T02:00:00.000Z', '2026-10-20', '2026-10-26');
    const t = await track(fakeSource({forecast: stale, clim: true}), '2026-10-24', '2026-11-03');
    expect(t.forecastHorizonEnd).toBe('2026-10-26');
    const lateForecast = t.days.filter((d) => d.kind === 'forecast' && d.date > '2026-10-26');
    expect(lateForecast).toEqual([]);
    expect(kinds(t.days)['2026-11-01']).toBe('typical');
    expect(kinds(t.days)['2026-10-27']).toBe('unavailable');
  });

  it('a date-only asOf is the end of that day in India, and bad ranges are refused', async () => {
    const t = await track(full(), '2026-11-01', '2026-11-08', '2026-11-01');
    expect(kinds(t.days)['2026-11-01']).toBe('forecast');
    await expect(track(full(), '2026-11-05', '2026-11-01')).rejects.toThrow(RangeError);
    await expect(track(full(), '2026-01-01', plus('2026-01-01', MAX_TRACK_DAYS))).rejects.toThrow(/at most/);
    await expect(track(full(), '2026-11-01', '2026-11-02', 'soon')).rejects.toThrow(RangeError);
    expect(unavailableTrack('2026-11-01', '2026-11-03', 'no location').days.map((d) => d.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
  });
});

// ------------------------------------------------------------------ database-backed: real weather adapter and the routes
// Everything below needs the dedicated local database; the pure tests above do not touch it.
describe('database-backed', () => {

  const DB_NAME = 'harvest_today_timeline_test';
  const NOW = new Date('2026-11-01T04:00:00Z');
  let pool: Pool;
  let app: FastifyInstance;
  let storageRoot: string;
  let a: Client, b: Client;
  let farmA: string, farmEmpty: string, farmNoPoint: string, farmBoundary: string;

  async function freshDatabase(): Promise<Pool> {
    const url = new URL(TEST_DB);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('refusing to create a test database on a non-local host');
    const admin = createPool(Object.assign(new URL(TEST_DB), {pathname: '/postgres'}).toString());
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [DB_NAME]);
      if (!exists.rowCount) await admin.query(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }
    url.pathname = `/${DB_NAME}`;
    const p = createPool(url.toString());
    if ((await p.query<{name: string}>('SELECT current_database() AS name')).rows[0]?.name !== DB_NAME) throw new Error('unexpected database identity');
    await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(p, undefined, () => undefined);
    return p;
  }

  async function seedForecast(p: Pool, o: {key: string; lat: number; lon: number; issuedAt: string; from: string; to: string}) {
    const sid = await ensureSource(p, SYNTHETIC_SOURCE_ID, {title: 's', publisher: 's', url: 'local:x', licence: 'synthetic'});
    await p.query(
      `INSERT INTO weather_forecasts (location_key, lon, lat, issued_at, valid_on, variables, source_id, is_synthetic, mode, available_at)
       SELECT $1,$3,$2,$4::timestamptz,d::date,'{"precipitation_sum":1.5,"temperature_2m_min":21,"temperature_2m_max":31}'::jsonb,$7,true,'synthetic',$4::timestamptz
         FROM generate_series($5::date,$6::date,interval '1 day') d`,
      [o.key, o.lat, o.lon, o.issuedAt, o.from, o.to, sid],
    );
  }
  async function seedArchive(p: Pool, o: {key: string; lat: number; lon: number; from: string; to: string}) {
    const sid = await ensureSource(p, SYNTHETIC_SOURCE_ID, {title: 's', publisher: 's', url: 'local:x', licence: 'synthetic'});
    await p.query(
      `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
       SELECT $1,$3,$2,d::date,'{"precipitation_sum":2,"temperature_2m_min":19,"temperature_2m_max":29}'::jsonb,$6,true,'synthetic','2026-01-01T00:00:00Z'
         FROM generate_series($4::date,$5::date,interval '1 day') d`,
      [o.key, o.lat, o.lon, o.from, o.to, sid],
    );
  }

  beforeAll(async () => {
    pool = await freshDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'ho-today-tl-'));
    const config = testConfig();
    app = Fastify({logger: false});
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie, {secret: config.SESSION_SECRET});
    await app.register(rateLimit, {global: true, max: 1000, timeWindow: '1 minute'});
    app.setErrorHandler((err: Error & {statusCode?: number; code?: string}, req, reply) => {
      if (err instanceof ApiError) return reply.code(err.statusCode).send(errorEnvelope(req.id, config.RUNTIME_MODE, {code: err.code, message: err.message}));
      const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
      return reply.code(status).send(errorEnvelope(req.id, config.RUNTIME_MODE, {code: err.code === 'FST_ERR_VALIDATION' ? 'validation_error' : (err.code ?? 'error'), message: err.message}));
    });
    await app.register(sessionRoutes, {config, pool});
    await app.register(farmRoutes, {config, pool, storage: new FsStorage(storageRoot)});
    await app.register(todayTimelineRoutes, {config, pool, now: () => NOW});
    await app.ready();
    a = await login(app);
    b = await login(app);
    const mk = async (name: string, location: Record<string, unknown>) => (await a.call('POST', '/api/v1/farms', {payload: {name, location}})).json().data.id as string;
    farmA = await mk('Hassan ginger', {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13, lon: 76.1, precision: 'approximate'});
    farmEmpty = await mk('No cycles', {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13, lon: 76.1, precision: 'approximate'});
    farmNoPoint = await mk('District only', {districtId: 'IN-KA-hassan', stateId: 'IN-KA', precision: 'district'});
    farmBoundary = await mk('Boundary elsewhere', {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13, lon: 76.1, precision: 'approximate'});
    const workspace = (cycles: unknown[], boundary: unknown = null) => JSON.stringify({boundary, previousHarvest: {status: 'unknown'}, cycles, rotationPlans: []});
    const ginger = {id: 'cycle-ginger', cropId: 'ginger', cropName: 'Ginger', productId: 'ginger-fresh', sowingDate: '2026-05-15', establishmentDate: '2026-05-15', establishmentMethod: 'rhizome_planting', stage: 'growing'};
    const oldRice = {id: 'cycle-old', cropId: 'paddy', cropName: 'Rice', sowingDate: '2025-06-01', stage: 'harvested', harvestDate: '2025-11-01'};
    await pool.query('INSERT INTO farm_workspaces(farm_id, version, state) VALUES ($1, 1, $2::jsonb)', [farmA, workspace([oldRice, ginger])]);
    const ring = [[77.0, 11.0], [77.002, 11.0], [77.002, 11.002], [77.0, 11.002], [77.0, 11.0]];
    await pool.query('INSERT INTO farm_workspaces(farm_id, version, state) VALUES ($1, 1, $2::jsonb)', [farmBoundary, workspace([], {type: 'Polygon', coordinates: [ring]})]);
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageRoot) await rm(storageRoot, {recursive: true, force: true});
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE weather_observations, weather_forecasts, provider_cache');
    await pool.query('DELETE FROM jobs');
  });

  describe('weatherTrack with the real weather source (no network)', () => {
    const range = {from: '2026-10-20', to: '2026-11-10'};
    const args = (mode: 'live' | 'synthetic') => ({point: {lat: 13, lon: 76.1}, ...range, asOf: NOW.toISOString(), mode});
    const offline = (calls: string[]) => async (url: string): Promise<never> => { calls.push(url); throw new Error('offline'); };
    const jobs = async () => Number((await pool.query("SELECT count(*) FROM jobs WHERE type='ingest.weather_archive'")).rows[0].count);

    it('autoIngest in live mode reaches the provider and queues the missing archive years; off, or in synthetic mode, it never does', async () => {
      const calls: string[] = [];
      const common = {pool, fetchImpl: offline(calls), providerConfig: loadProviderConfig({PROVIDER_MAX_RETRIES: '0'}), now: () => NOW, climatologyYears: 6};
      await weatherTrack({...common, autoIngest: false}, args('live'));
      expect(calls).toEqual([]);
      expect(await jobs()).toBe(0);
      await weatherTrack({...common, autoIngest: true}, args('synthetic'));
      expect(calls).toEqual([]);
      expect(await jobs()).toBe(0);
      const t = await weatherTrack({...common, autoIngest: true}, args('live'));
      expect(calls.some((u) => u.includes('archive-api'))).toBe(true);
      expect(calls.some((u) => u.includes('api.open-meteo.com'))).toBe(true);
      expect(await jobs()).toBe(6); // climatologyYears passed through: 2020 to 2025
      // Provider down: nothing is invented.
      expect(t.days.every((d) => d.kind === 'unavailable')).toBe(true);
      expect(t.limitations.join(' ')).toMatch(/archive download is requested/);
    });

    it('reads stored synthetic rows by label: forecast to the horizon then typical, with the qualifying years', async () => {
      await seedForecast(pool, {key: 'synthetic:f', lat: 13, lon: 76.1, issuedAt: '2026-10-31T02:00:00Z', from: '2026-10-31', to: '2026-11-05'});
      await seedArchive(pool, {key: 'synthetic:c', lat: 13, lon: 76.1, from: '2021-01-01', to: '2025-12-31'});
      const t = await weatherTrack({pool, now: () => NOW}, args('synthetic'));
      const k = kinds(t.days);
      expect(k['2026-10-30']).toBe('unavailable');
      expect(k['2026-10-31']).toBe('forecast');
      expect(k['2026-11-05']).toBe('forecast');
      expect(k['2026-11-06']).toBe('typical');
      expect(t.forecastHorizonEnd).toBe('2026-11-05');
      expect(t.days.find((d) => d.date === '2026-11-06')!.basis.years).toEqual([2021, 2022, 2023, 2024, 2025]);
      expect(t.days.filter((d) => d.kind === 'forecast' && d.date > '2026-11-05')).toEqual([]);
    });
  });

  describe('routes: stage timeline and weather track', () => {
    const get = (c: Client, url: string) => c.call('GET', url);

    it('requires a session', async () => {
      const res = await app.inject({method: 'GET', url: `/api/v1/farms/${farmA}/stage-timeline`, headers: {origin: ORIGIN}});
      expect(res.statusCode).toBe(401);
      expect((await app.inject({method: 'GET', url: `/api/v1/farms/${farmA}/weather-track?from=2026-11-01&to=2026-11-05`, headers: {origin: ORIGIN}})).statusCode).toBe(401);
    });

    it("never returns another owner's farm: both endpoints 404 for a foreign farm", async () => {
      expect((await get(b, `/api/v1/farms/${farmA}/stage-timeline`)).statusCode).toBe(404);
      expect((await get(b, `/api/v1/farms/${farmA}/stage-timeline?cycleId=cycle-ginger`)).statusCode).toBe(404);
      expect((await get(b, `/api/v1/farms/${farmA}/weather-track?from=2026-11-01&to=2026-11-05`)).statusCode).toBe(404);
      expect((await get(a, `/api/v1/farms/${farmA}/stage-timeline`)).statusCode).toBe(200);
    });

    it('builds the timeline of the current (not harvested) cycle from the workspace, or of the named cycle', async () => {
      const res = await get(a, `/api/v1/farms/${farmA}/stage-timeline`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data).toMatchObject({farmId: farmA, cycleId: 'cycle-ginger'});
      const t = StageTimeline.parse(data.timeline);
      expect(t).toMatchObject({cropId: 'ginger', productId: 'ginger-fresh', establishmentMethod: 'rhizome_planting', anchorDate: '2026-05-15'});
      expect(t.basis.sourceId).toBe('stage.ginger.hassan-kharif'); // farm location (IN-KA-hassan) reached the stage model lookup
      expect(t.stages.map((s) => s.basis)).toEqual(['sourced', 'sourced', 'sourced', 'sourced', 'sourced']);
      expect(t.stages[0]).toMatchObject({from: '2026-05-15', to: '2026-08-13'});
      expect(t.harvest && t.harvest.earliest <= t.harvest.latest).toBe(true);
      expect(data.limitations.join(' ')).toMatch(/never marked reached by an observation/);
      const old = await get(a, `/api/v1/farms/${farmA}/stage-timeline?cycleId=cycle-old`);
      expect(old.json().data).toMatchObject({cycleId: 'cycle-old', timeline: {cropId: 'paddy', anchorDate: '2025-06-01', establishmentMethod: null}});
      expect(old.json().data.limitations.join(' ')).toMatch(/method was not recorded/);
      expect((await get(a, `/api/v1/farms/${farmA}/stage-timeline?cycleId=nope`)).statusCode).toBe(404);
    });

    it('a farm with no cycle has no timeline rather than a made-up one', async () => {
      const res = await get(a, `/api/v1/farms/${farmEmpty}/stage-timeline`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({cycleId: null, timeline: null});
    });

    it('weather track labels forecast, typical and unavailable days for the farm point', async () => {
      await seedForecast(pool, {key: 'synthetic:f', lat: 13, lon: 76.1, issuedAt: '2026-10-31T02:00:00Z', from: '2026-10-31', to: '2026-11-05'});
      await seedArchive(pool, {key: 'synthetic:c', lat: 13, lon: 76.1, from: '2021-01-01', to: '2025-12-31'});
      const res = await get(a, `/api/v1/farms/${farmA}/weather-track?from=2026-10-30&to=2026-11-08`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.pointBasis).toBe('farm_point');
      expect(data.forecastHorizonEnd).toBe('2026-11-05');
      expect(kinds(data.days)).toMatchObject({'2026-10-30': 'unavailable', '2026-10-31': 'forecast', '2026-11-05': 'forecast', '2026-11-06': 'typical', '2026-11-08': 'typical'});
      expect(data.days.find((d: WeatherTrackDay) => d.date === '2026-11-06').basis.years).toEqual([2021, 2022, 2023, 2024, 2025]);
    });

    it('uses the field boundary centroid in preference to the farm point', async () => {
      // Forecast stored only near the boundary (11.0 N, 77.0 E); the farm point (13.0, 76.1) is far outside the grid tolerance.
      await seedForecast(pool, {key: 'synthetic:f-boundary', lat: 11.0, lon: 77.0, issuedAt: '2026-10-31T02:00:00Z', from: '2026-10-31', to: '2026-11-05'});
      const viaBoundary = (await get(a, `/api/v1/farms/${farmBoundary}/weather-track?from=2026-11-01&to=2026-11-03`)).json().data;
      expect(viaBoundary.pointBasis).toBe('boundary_centroid');
      expect(viaBoundary.days.map((d: WeatherTrackDay) => d.kind)).toEqual(['forecast', 'forecast', 'forecast']);
      const viaPoint = (await get(a, `/api/v1/farms/${farmA}/weather-track?from=2026-11-01&to=2026-11-03`)).json().data;
      expect(viaPoint.days.map((d: WeatherTrackDay) => d.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    });

    it('a farm with neither boundary nor point gets unavailable days and a reason', async () => {
      const data = (await get(a, `/api/v1/farms/${farmNoPoint}/weather-track?from=2026-11-01&to=2026-11-03`)).json().data;
      expect(data.pointBasis).toBe('none');
      expect(data.days.map((d: WeatherTrackDay) => d.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
      expect(data.limitations.join(' ')).toMatch(/No field boundary or farm point/);
    });

    it('rejects an inverted or oversized range with a validation error', async () => {
      expect((await get(a, `/api/v1/farms/${farmA}/weather-track?from=2026-11-05&to=2026-11-01`)).statusCode).toBe(400);
      expect((await get(a, `/api/v1/farms/${farmA}/weather-track?from=2024-01-01&to=2026-11-01`)).statusCode).toBe(400);
      expect((await get(a, `/api/v1/farms/${farmA}/weather-track?from=2026-11-01`)).statusCode).toBe(400);
    });
  });
});
