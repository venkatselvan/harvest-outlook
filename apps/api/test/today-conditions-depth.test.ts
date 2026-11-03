import {afterEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FieldConditions, type StageTimeline, type WeatherAgro, type WeatherPoint} from '@harvest/contracts';
import {
  CONDITION_ASSUMPTIONS, CONDITIONS_FILE, MODEL_ESTIMATE_TEXT, fieldConditions, invalidate, loadConditionsData, loadIssues, soilMoistureClass, soilMoistureRule,
  soilTextureOf, stageOneEnds, wetnessOf, wetnessRule, type ConditionsInput,
} from '../src/services/today/conditions';
import {REPO_ROOT} from '../src/catalogue/files';

/**
 * Weather depth, packet B (WEATHER_DEPTH_SPEC.md 6.2): the soil-moisture water basis, the wetness (pressure) block and the
 * gust count in the daily field conditions. Every weather and `agro` value below is SYNTHETIC and fed directly (no
 * provider, no database); thresholds come from the real data/research/footprint/field-conditions.json (FAO 56 Table 19)
 * and CONDITION_ASSUMPTIONS unless a test injects a fixture.
 */
afterEach(() => invalidate());

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NULL_AGRO: WeatherAgro = {
  et0Mm: null, rhMeanPct: null, rhMinPct: null, rhMaxPct: null, dewPointC: null, vpdMaxKpa: null, windMaxKmh: null, gustMaxKmh: null,
  soilMoisture0to7: null, soilTemp0to7C: null, leafWetnessPct: null, sunshineHours: null, rainHours: null, rainProbabilityPct: null, basis: 'grid_model_estimate',
};
const agro = (over: Partial<WeatherAgro> = {}): WeatherAgro => ({...NULL_AGRO, ...over});
const wx = (date: string, rainMm: number | null, a?: Partial<WeatherAgro> | null, kind: WeatherPoint['kind'] = 'observed'): WeatherPoint => ({
  date, kind, rainMm, tMinC: 20, tMaxC: 30, basis: {source: 'synthetic', issuedAt: null, years: null}, ...(a === undefined || a === null ? {} : {agro: agro(a)}),
});
const A = '2026-09-01';
const timeline = (cropId: string, harvest: {earliest: string; latest: string} | null): StageTimeline => ({
  cropId, productId: null, establishmentMethod: null, anchorDate: A,
  stages: [
    {id: 'initial', name: 'Initial', from: A, to: addDays(A, 29), basis: 'fao_generic'},
    {id: 'development', name: 'Crop development', from: addDays(A, 30), to: addDays(A, 59), basis: 'fao_generic'},
    {id: 'mid_season', name: 'Mid-season', from: addDays(A, 60), to: addDays(A, 89), basis: 'fao_generic'},
    {id: 'late_season', name: 'Late season', from: addDays(A, 90), to: addDays(A, 109), basis: 'fao_generic'},
  ],
  harvest, basis: {kind: 'duration', label: 'synthetic', sourceId: null, url: null, scope: null, note: null},
});
/** One day (A) of maize with the given rain and agro; texture as given. */
const one = (rainMm: number | null, a: Partial<WeatherAgro> | null | undefined, soilTexture: string | null = 'loam', over: Partial<ConditionsInput> = {}) =>
  fieldConditions({
    cropId: 'maize', establishmentMethod: 'direct_sowing', anchorDate: A, window: {from: A, to: A}, timeline: timeline('maize', {earliest: addDays(A, 105), latest: addDays(A, 110)}),
    weather: [wx(A, rainMm, a)], alerts: [], readings: [], soilTexture, ...over,
  });
const water = (c: ReturnType<typeof fieldConditions>) => c.points[0]!.water;

describe('data file: FAO 56 Table 19, wetness and gust blocks', () => {
  it('loads all three blocks with no skipped rows; the stage-1 ends follow the table', () => {
    const d = loadConditionsData();
    expect(loadIssues()).toEqual([]);
    const sm = d.soilMoistureClasses!;
    expect(sm.sourceId).toBe('FAO-56-CH7-TABLE-19');
    expect(sm.evaporationLayerM).toBe(0.1);
    expect(sm.textures.map((t) => t.texture)).toEqual(['sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam', 'silt', 'silty_clay_loam', 'silty_clay', 'clay']);
    const loam = sm.textures.find((t) => t.texture === 'loam')!;
    expect(loam).toMatchObject({fcLow: 0.2, fcHigh: 0.3, wpLow: 0.07, wpHigh: 0.17, rewLowMm: 8, rewHighMm: 10});
    // wet end = 0.30 - 8 / 100 = 0.22; dry end = 0.20 - 10 / 100 = 0.10
    expect(stageOneEnds(loam, 0.1)).toEqual({wetEnd: 0.22, dryEnd: 0.1});
    expect(stageOneEnds(sm.textures.find((t) => t.texture === 'clay')!, 0.1)).toEqual({wetEnd: 0.32, dryEnd: 0.2});
    expect(stageOneEnds(sm.textures.find((t) => t.texture === 'sand')!, 0.1)).toEqual({wetEnd: 0.15, dryEnd: 0});
    expect(d.sources.get('FAO-56-CH7-TABLE-19')?.url).toBe('https://www.fao.org/4/x0490e/x0490e0c.htm');
    // Wetness and gust: no sourced figure was found, so the file holds none and the engine assumption applies.
    expect(d.wetnessThresholds).toMatchObject({sourceId: null, leafWetnessPct: null, rhMeanPct: null});
    expect(d.lodgingGust).toMatchObject({sourceId: null, gustKmh: null});
    expect(wetnessRule(d).basis).toBe('engine_assumption');
    const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, CONDITIONS_FILE), 'utf8')) as Record<string, {note?: string; locator?: string | null}>;
    for (const k of ['soilMoistureClasses', 'wetnessThresholds', 'lodgingGust']) expect(raw[k]!.note, k).toMatch(/\w/);
  });

  it('the class rule: recorded texture, an FAO label, a texture the table lacks and none', () => {
    const d = loadConditionsData();
    expect(soilMoistureRule('loam', d)).toEqual({texture: 'loam', faoLabel: 'Loam', wetEnd: 0.22, dryEnd: 0.1});
    expect(soilMoistureRule('Sandy loam', d)).toMatchObject({texture: 'sandy_loam'});
    expect(soilMoistureRule('Silt clay loam', d)).toMatchObject({texture: 'silty_clay_loam'});
    // No texture, or a USDA class Table 19 does not print: the class is held back (decision M2, 2026-11-03).
    expect(soilMoistureRule(null, d)).toBeNull();
    expect(soilMoistureRule('clay_loam', d)).toBeNull();
    expect(soilMoistureClass(0.22, soilMoistureRule('loam', d))).toBe('moist');
    expect(soilMoistureClass(0.219, soilMoistureRule('loam', d))).toBeNull();
    expect(soilMoistureClass(0.1, soilMoistureRule('loam', d))).toBeNull();
    expect(soilMoistureClass(0.099, soilMoistureRule('loam', d))).toBe('dry');
    expect(soilMoistureClass(0.0, soilMoistureRule(null, d))).toBeNull();
    expect(soilMoistureClass(0.9, soilMoistureRule(null, d))).toBeNull();
    expect(soilMoistureClass(null, soilMoistureRule('loam', d))).toBeNull();
  });

  it('reads the texture fact only when farmer reported, lab tested or confirmed', () => {
    const fact = (basis: string, confirmed = false) => ({soil_texture: {value: 'loam', basis, confirmed}}) as never;
    expect(soilTextureOf(fact('farmer_reported'))).toBe('loam');
    expect(soilTextureOf(fact('lab_test'))).toBe('loam');
    expect(soilTextureOf(fact('inferred'))).toBeNull();
    expect(soilTextureOf(fact('inferred', true))).toBe('loam');
    expect(soilTextureOf(null as never)).toBeNull();
  });
});

describe('water: rule order 1 flooded, 2 ponded, 3 model soil moisture, 4 rain moist, 5 dry, 6 unknown', () => {
  it('3: moist and dry from model soil moisture with a texture; the value rides along', () => {
    expect(water(one(0, {soilMoisture0to7: 0.25}))).toEqual({state: 'moist', basis: 'model_soil_moisture', soilMoisture0to7: 0.25});
    expect(water(one(0, {soilMoisture0to7: 0.05}))).toEqual({state: 'dry', basis: 'model_soil_moisture', soilMoisture0to7: 0.05});
    // Between the ends (loam 0.10 to 0.22): no class, the rain rule decides.
    expect(water(one(0, {soilMoisture0to7: 0.15}))).toEqual({state: 'dry', basis: 'none', soilMoisture0to7: 0.15});
    expect(water(one(5, {soilMoisture0to7: 0.15}))).toEqual({state: 'moist', basis: 'rain_rule', soilMoisture0to7: 0.15});
    expect(water(one(null, {soilMoisture0to7: 0.15}))).toEqual({state: 'unknown', basis: 'none', soilMoisture0to7: 0.15});
    // Soil moisture decides even without a rain figure.
    expect(water(one(null, {soilMoisture0to7: 0.3}))).toEqual({state: 'moist', basis: 'model_soil_moisture', soilMoisture0to7: 0.3});
  });

  it('3 before 4: a dry model cell overrides recent rain short of ponding (documented precedence)', () => {
    expect(water(one(5, {soilMoisture0to7: 0.05})).state).toBe('dry');
    expect(water(one(5, {soilMoisture0to7: 0.05})).basis).toBe('model_soil_moisture');
    // The reviewer's probe: loam, 30 mm the day before, 0.05 m3/m3 today -> dry by model soil moisture.
    const c = fieldConditions({cropId: 'maize', establishmentMethod: null, anchorDate: A, window: {from: addDays(A, -1), to: A}, timeline: null, alerts: [], readings: [], soilTexture: 'loam',
      weather: [wx(addDays(A, -1), 30, null), wx(A, 0, {soilMoisture0to7: 0.05})]});
    expect(c.points.map((p) => `${p.water.state}/${p.water.basis}`)).toEqual(['moist/rain_rule', 'dry/model_soil_moisture']);
    expect(c.limitations.join(' ')).toMatch(/model soil moisture takes precedence over the rain rule for moist or dry/);
    expect(c.limitations.join(' ')).toMatch(/model holds water by its own soil class/);
  });

  it('2 before 3: ponded from rain beats a dry or moist model cell', () => {
    expect(water(one(70, {soilMoisture0to7: 0.05}))).toEqual({state: 'ponded', basis: 'rain_rule', soilMoisture0to7: 0.05});
    expect(water(one(70, {soilMoisture0to7: 0.45}))).toEqual({state: 'ponded', basis: 'rain_rule', soilMoisture0to7: 0.45});
  });

  it('1 before 3: the paddy crop practice keeps the field flooded whatever the model soil moisture', () => {
    const c = fieldConditions({
      cropId: 'paddy', establishmentMethod: 'transplanting', anchorDate: A, window: {from: A, to: addDays(A, 2)}, timeline: timeline('paddy', {earliest: addDays(A, 100), latest: addDays(A, 105)}),
      irrigationCategory: 'irrigated', weather: [wx(A, 0, {soilMoisture0to7: 0.02}), wx(addDays(A, 1), 0, {soilMoisture0to7: 0.5}), wx(addDays(A, 2), 0, null)], alerts: [], readings: [], soilTexture: 'loam',
    });
    expect(c.points.map((p) => p.water)).toEqual([
      {state: 'flooded', basis: 'crop_practice', soilMoisture0to7: 0.02},
      {state: 'flooded', basis: 'crop_practice', soilMoisture0to7: 0.5},
      {state: 'flooded', basis: 'crop_practice'},
    ]);
  });

  it('no texture (or one Table 19 does not print): soil moisture never sets moist or dry; the value still rides along', () => {
    for (const tex of [null, 'clay_loam']) {
      for (const theta of [0, 0.01, 0.3, 0.34, 0.55, 1]) {
        const w = water(one(0, {soilMoisture0to7: theta}, tex));
        expect(w, `${tex} ${theta}`).toEqual({state: 'dry', basis: 'none', soilMoisture0to7: theta});
      }
      expect(water(one(5, {soilMoisture0to7: 0.01}, tex))).toEqual({state: 'moist', basis: 'rain_rule', soilMoisture0to7: 0.01});
      expect(water(one(70, {soilMoisture0to7: 0.5}, tex))).toEqual({state: 'ponded', basis: 'rain_rule', soilMoisture0to7: 0.5});
      expect(water(one(null, {soilMoisture0to7: 0.5}, tex))).toEqual({state: 'unknown', basis: 'none', soilMoisture0to7: 0.5});
    }
    const c = one(0, {soilMoisture0to7: 0.34}, 'clay_loam');
    const ids = c.basis.map((b) => b.sourceId);
    expect(ids).toContain('today-conditions-assumption:soilMoistureNoTexture');
    expect(ids).not.toContain('FAO-56-CH7-TABLE-19');
    expect(ids).not.toContain('today-conditions-assumption:soilMoistureClass');
    const lim = c.limitations.join(' ');
    expect(lim).toMatch(/recorded texture \(clay_loam\) is not printed in FAO 56 Table 19/);
    expect(lim).toContain(CONDITION_ASSUMPTIONS.soilMoistureNoTexture.text);
    expect(CONDITION_ASSUMPTIONS.soilMoistureNoTexture.text).toMatch(/held back until the cell's own multi-year soil-moisture history exists/);
    expect(lim).toMatch(/model soil moisture 0, rain rule 0, crop practice 0, no rule 1/);
  });

  it('invariant: soil moisture never yields ponded or flooded, for every texture and value', () => {
    for (const tex of [null, 'sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam', 'silt', 'silty_clay_loam', 'silty_clay', 'clay', 'clay_loam']) {
      for (let k = 0; k <= 100; k++) {
        const theta = k / 100;
        const w = water(one(0, {soilMoisture0to7: theta}, tex));
        expect(['moist', 'dry'], `${tex} ${theta}`).toContain(w.state);
        if (w.basis === 'model_soil_moisture') expect(['moist', 'dry']).toContain(w.state);
        if (tex === null || tex === 'clay_loam') expect(w.basis).toBe('none');
        expect(w.basis).not.toBe('crop_practice');
        expect(w.basis).not.toBe('rain_rule');
      }
    }
    // A long wet model series with no rain stays moist, never ponded.
    const days = Array.from({length: 10}, (_, k) => wx(addDays(A, k), 0, {soilMoisture0to7: 0.55}));
    const c = fieldConditions({cropId: 'maize', establishmentMethod: null, anchorDate: A, window: {from: A, to: addDays(A, 9)}, timeline: null, weather: days, alerts: [], readings: [], soilTexture: 'clay'});
    expect(new Set(c.points.map((p) => `${p.water.state}/${p.water.basis}`))).toEqual(new Set(['moist/model_soil_moisture']));
  });
});

describe('pressure: wetness context (engine assumption), VPD and gusts carried', () => {
  it('classes with inclusive edges; the higher of leaf wetness and humidity wins', () => {
    const rule = wetnessRule(loadConditionsData());
    const cases: [number | null, number | null, string][] = [
      [50, null, 'high'], [49.9, null, 'moderate'], [25, null, 'moderate'], [24.9, null, 'low'],
      [null, 90, 'high'], [null, 89.9, 'moderate'], [null, 80, 'moderate'], [null, 79.9, 'low'],
      [10, 92, 'high'], [60, 50, 'high'], [30, 70, 'moderate'], [10, 50, 'low'], [null, null, 'unknown'],
    ];
    for (const [lw, rh, cls] of cases) expect(wetnessOf(lw, rh, rule).wetness, `${lw}/${rh}`).toBe(cls);
    expect(wetnessOf(null, null, rule).basis).toBe('none');
    expect(wetnessOf(10, null, rule).basis).toBe('engine_assumption');
    expect(CONDITION_ASSUMPTIONS.wetness.value).toEqual({leafWetnessHighPct: 50, leafWetnessModeratePct: 25, rhMeanHighPct: 90, rhMeanModeratePct: 80});
  });

  it('fills the block per day from agro, rounded; the basis and limitations say engine assumption and grid-cell estimate', () => {
    const c = one(0, {leafWetnessPct: 61.234, rhMeanPct: 88.06, vpdMaxKpa: 0.4567, gustMaxKmh: 64.44});
    expect(c.points[0]!.pressure).toEqual({wetness: 'high', leafWetnessPct: 61.2, rhMeanPct: 88.1, vpdMaxKpa: 0.46, gustMaxKmh: 64.4, basis: 'engine_assumption'});
    const ids = c.basis.map((b) => b.sourceId);
    expect(ids).toEqual(expect.arrayContaining(['today-conditions-assumption:wetness', 'today-conditions-assumption:lodgingGust']));
    const lim = c.limitations.join(' ');
    expect(lim).toContain(MODEL_ESTIMATE_TEXT);
    expect(lim).toContain(CONDITION_ASSUMPTIONS.wetness.text);
    expect(lim).toMatch(/Gusts reached 60 km\/h on 1 of these days/);
    expect(lim).toContain(CONDITION_ASSUMPTIONS.lodgingGust.text);
    // D-W7: context wording only; no disease is named anywhere in the output.
    expect(JSON.stringify(c)).not.toMatch(/blast|blight|mildew|rust|leaf spot|rot\b/i);
    expect(CONDITION_ASSUMPTIONS.wetness.text).toMatch(/conditions favour fungal spread/);
    expect(FieldConditions.parse(c)).toEqual(c);
  });

  it('gusts below the threshold are counted as zero days; no gust value adds no gust basis', () => {
    expect(one(0, {gustMaxKmh: 59.9, rhMeanPct: 50}).limitations.join(' ')).toMatch(/Gusts reached 60 km\/h on 0 of these days/);
    expect(one(0, {rhMeanPct: 50}).basis.map((b) => b.sourceId)).not.toContain('today-conditions-assumption:lodgingGust');
  });
});

describe('absent and null inputs', () => {
  it('no agro: no pressure block, no soil-moisture value, the pre-packet output, no grid-cell limitation', () => {
    const c = one(0, undefined);
    expect(c.points[0]!.pressure).toBeUndefined();
    expect('pressure' in c.points[0]!).toBe(false);
    expect(water(c)).toEqual({state: 'dry', basis: 'none'});
    expect(c.limitations.join(' ')).not.toContain(MODEL_ESTIMATE_TEXT);
    expect(c.basis.some((b) => (b.sourceId ?? '').startsWith('FAO-56'))).toBe(false);
  });

  it('agro with every field null, or only rain chance and ET0 (old forecast rows): no pressure block and no weather-depth limitation', () => {
    for (const a of [{}, {rainProbabilityPct: 65}, {rainProbabilityPct: 65, et0Mm: 3.1, sunshineHours: 6}]) {
      const c = one(5, a);
      expect(c.points[0]!.pressure, JSON.stringify(a)).toBeUndefined();
      expect(water(c)).toEqual({state: 'moist', basis: 'rain_rule'});
      expect(c.limitations.join(' ')).not.toContain(MODEL_ESTIMATE_TEXT);
      expect(c.limitations.join(' ')).not.toMatch(/wetness/i);
      expect(c.basis.map((b) => b.sourceId)).not.toContain('today-conditions-assumption:wetness');
    }
  });

  it('only VPD or gust: a pressure block with wetness unknown and basis none, and the limitation says wetness is unknown', () => {
    const c = one(5, {vpdMaxKpa: 1.2, rainProbabilityPct: 40});
    expect(c.points[0]!.pressure).toEqual({wetness: 'unknown', leafWetnessPct: null, rhMeanPct: null, vpdMaxKpa: 1.2, gustMaxKmh: null, basis: 'none'});
    expect(c.limitations.join(' ')).toMatch(/wetness is unknown/);
    expect(c.limitations.join(' ')).toContain(MODEL_ESTIMATE_TEXT);
  });

  it('soil moisture only: the grid-cell limitation, no wetness or gust sentence', () => {
    const c = one(0, {soilMoisture0to7: 0.3});
    expect(c.points[0]!.pressure).toBeUndefined();
    const lim = c.limitations.join(' ');
    expect(lim).toContain(MODEL_ESTIMATE_TEXT);
    expect(lim).not.toMatch(/wetness is unknown|Gusts reached/);
    expect(c.limitations.some((l) => l.startsWith('Wetness is an engine assumption'))).toBe(false);
  });

  it('out-of-range values are ignored (a percentage passed as soil moisture, humidity above 100); unavailable days read no agro', () => {
    const c = one(0, {soilMoisture0to7: 35, rhMeanPct: 140, leafWetnessPct: -3});
    expect(water(c)).toEqual({state: 'dry', basis: 'none'});
    expect(c.points[0]!.pressure).toBeUndefined(); // no valid pressure input left
    expect(one(0, {rhMeanPct: 140, gustMaxKmh: 20}).points[0]!.pressure).toMatchObject({wetness: 'unknown', rhMeanPct: null, gustMaxKmh: 20, basis: 'none'});
    const u = fieldConditions({cropId: 'maize', establishmentMethod: null, anchorDate: A, window: {from: A, to: A}, timeline: null, weather: [{...wx(A, null, {soilMoisture0to7: 0.3, leafWetnessPct: 80}), kind: 'unavailable'}], alerts: [], readings: [], soilTexture: 'loam'});
    expect(u.points[0]!.water).toEqual({state: 'unknown', basis: 'none'});
    expect(u.points[0]!.pressure).toBeUndefined();
  });
});

describe('basis, limitations and the 12-entry caps', () => {
  it('names the basis used: FAO Table 19 (cited, with url) plus the texture rule, and the day counts by basis', () => {
    const c = fieldConditions({
      cropId: 'maize', establishmentMethod: null, anchorDate: A, window: {from: A, to: addDays(A, 3)}, timeline: null, soilTexture: 'loam', alerts: [], readings: [],
      weather: [wx(A, 0, {soilMoisture0to7: 0.3}), wx(addDays(A, 1), 0, {soilMoisture0to7: 0.15}), wx(addDays(A, 2), 70, {soilMoisture0to7: 0.05}), wx(addDays(A, 3), 0, null)],
    });
    expect(c.points.map((p) => p.water.basis)).toEqual(['model_soil_moisture', 'none', 'rain_rule', 'rain_rule']);
    const fao = c.basis.find((b) => b.sourceId === 'FAO-56-CH7-TABLE-19')!;
    expect(fao).toMatchObject({kind: 'soil', url: 'https://www.fao.org/4/x0490e/x0490e0c.htm'});
    expect(c.basis.map((b) => b.sourceId)).toContain('today-conditions-assumption:soilMoistureClass');
    expect(c.basis.map((b) => b.sourceId)).not.toContain('today-conditions-assumption:soilMoistureNoTexture');
    const lim = c.limitations.join(' ');
    expect(lim).toMatch(/model soil moisture 1, rain rule 2, crop practice 0, no rule 1/);
    expect(lim).toMatch(/Soil texture Loam: moist at 0.22 m3\/m3 or more, dry below 0.1 m3\/m3/);
    expect(lim).toMatch(/not calibrated to this field's soil/);
  });

  it('the worst case stays within the contract caps and keeps the new entries', () => {
    const harvest = {earliest: addDays(A, 100), latest: addDays(A, 105)};
    const weather = Array.from({length: 70}, (_, k) => wx(addDays(A, k), k % 9 === 0 ? 70 : 0, {soilMoisture0to7: 0.3, leafWetnessPct: 55, gustMaxKmh: 65}, k > 60 ? 'typical' : 'observed'));
    weather[65] = {...weather[65]!, kind: 'unavailable'};
    const c = FieldConditions.parse(fieldConditions({cropId: 'paddy', establishmentMethod: 'transplanting', anchorDate: A, window: {from: A, to: addDays(A, 69)}, timeline: timeline('paddy', harvest), weather: weather.map((w, k) => (k === 62 ? {...w, tMaxC: 45} : w.date === addDays(A, 60) ? {...w, tMaxC: 36} : w)), alerts: [], readings: [], irrigationCategory: null, soilTexture: 'loam'}));
    expect(c.basis.length).toBeLessThanOrEqual(12);
    expect(c.limitations.length).toBeLessThanOrEqual(12);
    const ids = c.basis.map((b) => b.sourceId);
    expect(ids).toEqual(expect.arrayContaining(['FAO-56-CH7-TABLE-19', 'today-conditions-assumption:soilMoistureClass', 'today-conditions-assumption:wetness', 'today-conditions-assumption:lodgingGust', 'today-conditions-assumption:rainRule', 'TNAU-AGRITECH-PADDY-WATER']));
    expect(c.limitations.join(' ')).toContain(MODEL_ESTIMATE_TEXT);
  });
});

describe('caps: the drop path runs when more than 12 limitations and basis entries are produced', () => {
  it('a 420-day paddy window with every rule in use drops the hold-day notes first, then keeps 12', () => {
    const harvest = {earliest: addDays(A, 100), latest: addDays(A, 105)};
    const n = 420;
    const weather: WeatherPoint[] = Array.from({length: n}, (_, k) => {
      const w = wx(addDays(A, k), k % 9 === 0 ? 70 : 0, {soilMoisture0to7: 0.3, leafWetnessPct: 55, gustMaxKmh: 65}, k > 60 ? 'typical' : 'observed');
      return k === 60 ? {...w, tMaxC: 36} : k === 62 ? {...w, tMaxC: 45} : k === 65 ? {...w, kind: 'unavailable'} : w;
    });
    const input: ConditionsInput = {cropId: 'paddy', establishmentMethod: 'transplanting', anchorDate: A, window: {from: A, to: addDays(A, n - 1)}, timeline: timeline('paddy', harvest), weather, alerts: [], readings: [], irrigationCategory: null, soilTexture: 'loam'};
    const c = FieldConditions.parse(fieldConditions(input));
    expect(c.points).toHaveLength(400);
    expect(c.limitations).toHaveLength(12);
    // 14 distinct limitations are produced; the pond-hold and drain-lead notes are the ones dropped.
    expect(c.limitations).not.toContain(CONDITION_ASSUMPTIONS.pondHoldDays.text);
    expect(c.limitations).not.toContain(CONDITION_ASSUMPTIONS.drainLead.text);
    expect(c.limitations).toContain(CONDITION_ASSUMPTIONS.soilMoistureClass.text);
    expect(c.limitations.some((l) => l.startsWith(CONDITION_ASSUMPTIONS.wetness.text))).toBe(true);
    expect(c.limitations).toContain(CONDITION_ASSUMPTIONS.rainRule.text);
    expect(c.limitations).toContain('At most 400 days are drawn.');
    expect(c.limitations.join(' ')).toContain(MODEL_ESTIMATE_TEXT);
    // Basis: 14 produced; both hold-day notes dropped, every other source kept.
    const ids = c.basis.map((b) => b.sourceId);
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain('today-conditions-assumption:moistHoldDays');
    expect(ids).not.toContain('today-conditions-assumption:pondHoldDays');
    expect(ids).toEqual(expect.arrayContaining(['IMD-MC-AGARTALA-DAILY-RAINFALL', 'today-conditions-assumption:rainRule', 'TNAU-AGRITECH-PADDY-WATER', 'FAO-56-CH7-TABLE-19', 'today-conditions-assumption:lodgingGust']));
  });
});

describe('tolerant loader', () => {
  const OLD = {rainClasses: {sourceId: 'X', classes: [{class: 'light', lowerMm: 2.5}, {class: 'heavy', lowerMm: 64.5}]}, waterPractice: [], heatThresholds: [], sources: {}};

  it('an older file without the new blocks loads: soil moisture is shown but does not set the water state; wetness uses the engine assumption', () => {
    invalidate(OLD);
    const d = loadConditionsData();
    expect(d.soilMoistureClasses).toBeNull();
    expect(d.wetnessThresholds).toBeNull();
    expect(d.lodgingGust).toBeNull();
    expect(loadIssues()).toEqual([]);
    const c = one(0, {soilMoisture0to7: 0.05, leafWetnessPct: 70});
    expect(water(c)).toEqual({state: 'dry', basis: 'none', soilMoisture0to7: 0.05});
    expect(c.points[0]!.pressure).toMatchObject({wetness: 'high', basis: 'engine_assumption'});
    expect(c.limitations.join(' ')).toMatch(/soil-moisture classes are not in the data file/);
  });

  it('a malformed block or row is skipped and recorded, never fatal', () => {
    invalidate({...OLD, soilMoistureClasses: {evaporationLayerM: 'deep', textures: []}, lodgingGust: {gustKmh: -5},
      wetnessThresholds: {sourceId: 'W', leafWetnessPct: {high: 20, moderate: 40}}});
    const d = loadConditionsData();
    expect(d.soilMoistureClasses).toBeNull();
    expect(d.lodgingGust).toBeNull();
    expect(d.wetnessThresholds).toBeNull();
    expect(loadIssues().length).toBe(3);
    invalidate({...OLD, soilMoistureClasses: {evaporationLayerM: 0.1, textures: [{texture: 'loam', fcLow: 0.3, fcHigh: 0.2, rewLowMm: 8, rewHighMm: 10}, {texture: 'clay', fcLow: 0.32, fcHigh: 0.4, rewLowMm: 8, rewHighMm: 12}]}});
    expect(loadConditionsData().soilMoistureClasses!.textures.map((t) => t.texture)).toEqual(['clay']);
    expect(loadIssues()).toHaveLength(1);
  });

  it('sourced wetness figures and a sourced gust in the file replace the engine assumptions', () => {
    invalidate({...OLD,
      wetnessThresholds: {sourceId: 'SRC-W', locator: 'Table 1', note: 'synthetic test source', rhMeanPct: {high: 95, moderate: 85}},
      lodgingGust: {sourceId: 'SRC-G', locator: 'p. 2', note: 'synthetic test source', gustKmh: 45},
      sources: {'SRC-W': {url: 'https://example.test/w', title: 'Synthetic wetness'}, 'SRC-G': {url: 'https://example.test/g', title: 'Synthetic gust'}}});
    const c = one(0, {rhMeanPct: 90, leafWetnessPct: 99, gustMaxKmh: 50});
    // Leaf wetness has no sourced pair, so only humidity classes: 90 is moderate against 95/85.
    expect(c.points[0]!.pressure).toMatchObject({wetness: 'moderate', basis: 'sourced_threshold'});
    const ids = c.basis.map((b) => b.sourceId);
    expect(ids).toEqual(expect.arrayContaining(['SRC-W', 'SRC-G']));
    expect(ids).not.toContain('today-conditions-assumption:wetness');
    expect(ids).not.toContain('today-conditions-assumption:lodgingGust');
    expect(c.limitations.join(' ')).toMatch(/Gusts reached 45 km\/h on 1 of these days\./);
  });
});
