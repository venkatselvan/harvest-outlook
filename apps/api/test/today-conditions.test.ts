import {afterEach, describe, expect, it} from 'vitest';
import {FieldConditions, type FarmAlert, type StageTimeline, type WeatherPoint} from '@harvest/contracts';
import {CONDITION_ASSUMPTIONS, fieldConditions, invalidate, loadConditionsData, loadIssues, rainClass, type ConditionsInput} from '../src/services/today/conditions';

/**
 * Daily field conditions (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 10.1 item 4). Weather, alerts, readings and timelines
 * below are SYNTHETIC; thresholds are read from the real data/research/footprint/field-conditions.json (IMD classes, TNAU
 * paddy water practice, the rice 35 C flowering threshold) unless a test injects a fixture. Pure: no database or network.
 */
afterEach(() => invalidate());

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wx = (date: string, rainMm: number | null, tMaxC: number | null = 30, kind: WeatherPoint['kind'] = 'observed'): WeatherPoint => ({date, kind, rainMm, tMinC: 20, tMaxC, basis: {source: 'synthetic', issuedAt: null, years: null}});
const days = (from: string, values: (number | null)[], tMax: number | null = 30) => values.map((v, k) => wx(addDays(from, k), v, tMax));
const alert = (id: string, severity: FarmAlert['severity'], validFrom: string, validTo: string): FarmAlert => ({
  id, farmId: '11111111-1111-4111-8111-111111111111', type: 'weather', severity, origin: 'rule', title: `Synthetic ${severity}`, detail: 'Synthetic.',
  source: {name: 'Synthetic', url: 'https://example.test/a', date: validFrom}, validFrom, validTo, suggestedStep: null, createdAt: `${validFrom}T00:00:00.000Z`,
});
const timeline = (cropId: string, anchor: string, harvest: {earliest: string; latest: string} | null): StageTimeline => ({
  cropId, productId: null, establishmentMethod: null, anchorDate: anchor,
  stages: [
    {id: 'initial', name: 'Initial', from: anchor, to: addDays(anchor, 29), basis: 'fao_generic'},
    {id: 'development', name: 'Crop development', from: addDays(anchor, 30), to: addDays(anchor, 59), basis: 'fao_generic'},
    {id: 'mid_season', name: 'Mid-season', from: addDays(anchor, 60), to: addDays(anchor, 89), basis: 'fao_generic'},
    {id: 'late_season', name: 'Late season', from: addDays(anchor, 90), to: addDays(anchor, 109), basis: 'fao_generic'},
  ],
  harvest, basis: {kind: 'duration', label: 'synthetic', sourceId: null, url: null, scope: null, note: null},
});
const A = '2026-09-01';
const base = (over: Partial<ConditionsInput> = {}): ConditionsInput => ({
  cropId: 'maize', establishmentMethod: 'direct_sowing', anchorDate: A, window: {from: A, to: addDays(A, 9)},
  timeline: timeline('maize', A, {earliest: addDays(A, 105), latest: addDays(A, 110)}), weather: days(A, Array(10).fill(0)), alerts: [], readings: [], ...over,
});
const point = (c: FieldConditions, date: string) => c.points.find((p) => p.date === date)!;

describe('rain classes (IMD, from the data file)', () => {
  it('every band edge: 0, 0.1, 2.4/2.5, 15.5/15.6, 64.4/64.5, 115.5/115.6, 204.4/204.5; null is unknown', () => {
    const bands = loadConditionsData().rainClasses!.classes;
    const cases: [number | null, string][] = [
      [0, 'none'], [0.1, 'very_light'], [2.4, 'very_light'], [2.5, 'light'], [15.5, 'light'], [15.6, 'moderate'], [64.4, 'moderate'], [64.5, 'heavy'],
      [115.5, 'heavy'], [115.6, 'very_heavy'], [204.4, 'very_heavy'], [204.5, 'extremely_heavy'], [380, 'extremely_heavy'], [null, 'unknown'],
    ];
    for (const [mm, cls] of cases) expect(rainClass(mm, bands), String(mm)).toBe(cls);
    expect(loadIssues()).toEqual([]);
  });
});

describe('water state', () => {
  it('paddy is flooded from transplanting to the drain date (earliest harvest minus 10 days), by crop practice', () => {
    const harvest = {earliest: addDays(A, 100), latest: addDays(A, 105)};
    const c = fieldConditions(base({cropId: 'paddy', establishmentMethod: 'transplanting', timeline: timeline('paddy', A, harvest), window: {from: addDays(A, -1), to: addDays(A, 92)}, weather: days(addDays(A, -1), Array(94).fill(0))}));
    expect(point(c, addDays(A, -1)).water).toEqual({state: 'dry', basis: 'none'});
    expect(point(c, A).water).toEqual({state: 'flooded', basis: 'crop_practice'});
    expect(point(c, addDays(A, 90)).water).toEqual({state: 'flooded', basis: 'crop_practice'}); // 100 - 10
    expect(point(c, addDays(A, 91)).water).toEqual({state: 'dry', basis: 'none'});
    expect(c.basis.some((b) => b.kind === 'water' && b.sourceId === 'TNAU-AGRITECH-PADDY-WATER')).toBe(true);
    expect(c.basis.map((b) => b.sourceId)).toContain('today-conditions-assumption:drainLead');
    // Direct-seeded paddy: standing water from day 7 (wet-seeded practice).
    const direct = fieldConditions(base({cropId: 'paddy', establishmentMethod: 'direct_seeding', timeline: timeline('paddy', A, harvest), weather: days(A, Array(10).fill(0))}));
    expect(point(direct, addDays(A, 6)).water.state).toBe('dry');
    expect(point(direct, addDays(A, 7)).water).toEqual({state: 'flooded', basis: 'crop_practice'});
    // No harvest window: the practice cannot be dated.
    expect(fieldConditions(base({cropId: 'paddy', timeline: timeline('paddy', A, null)})).points.every((p) => p.water.state !== 'flooded')).toBe(true);
  });

  it('the paddy practice follows the irrigation category: irrigated or supplemental flooded, rainfed rain-only, unrecorded flooded and flagged', () => {
    const harvest = {earliest: addDays(A, 100), latest: addDays(A, 105)};
    const paddy = (irrigationCategory: string | null) => fieldConditions(base({cropId: 'paddy', establishmentMethod: 'transplanting', timeline: timeline('paddy', A, harvest), irrigationCategory, weather: days(A, [70, 0, 0, 0, 0, 0, 0, 0, 0, 0])}));
    const flagged = (c: FieldConditions) => c.basis.some((b) => b.sourceId === 'today-conditions-assumption:floodedWhenIrrigationUnknown');
    for (const cat of ['irrigated', 'supplemental']) {
      const c = paddy(cat);
      expect(c.points.every((p) => p.water.state === 'flooded' && p.water.basis === 'crop_practice'), cat).toBe(true);
      expect(flagged(c), cat).toBe(false);
    }
    const rainfed = paddy('rainfed');
    expect(rainfed.points.map((p) => p.water.state)).toEqual(['ponded', 'ponded', 'ponded', 'dry', 'dry', 'dry', 'dry', 'dry', 'dry', 'dry']);
    expect(rainfed.points.some((p) => p.water.basis === 'crop_practice')).toBe(false);
    expect(rainfed.limitations).toContain('Rainfed paddy: standing water is drawn only from rain, not from the irrigated practice.');
    expect(flagged(rainfed)).toBe(false);
    const unknown = paddy(null);
    expect(unknown.points.every((p) => p.water.state === 'flooded')).toBe(true);
    expect(flagged(unknown)).toBe(true);
    expect(unknown.limitations).toContain(CONDITION_ASSUMPTIONS.floodedWhenIrrigationUnknown.text);
  });

  it('ponded on heavy rain for the day and two days after, then dry; light rain gives moist for three days', () => {
    // day 0: 64.5 mm (heavy) -> ponded days 0 to 2, dry day 3; day 6: 2.5 mm (light) -> moist days 6 to 8, dry day 9.
    const c = fieldConditions(base({weather: days(A, [64.5, 0, 0, 0, 0, 0, 2.5, 0, 0, 0])}));
    expect(c.points.map((p) => p.water.state)).toEqual(['ponded', 'ponded', 'ponded', 'dry', 'dry', 'dry', 'moist', 'moist', 'moist', 'dry']);
    expect(point(c, A).water.basis).toBe('rain_rule');
    // 64.4 (moderate) is moist, not ponded.
    expect(fieldConditions(base({weather: days(A, [64.4, 0, 0, 0, 0, 0, 0, 0, 0, 0])})).points[0]!.water.state).toBe('moist');
    // Very light rain does not wet the field in this rule.
    expect(fieldConditions(base({weather: days(A, [2.4, 0, 0, 0, 0, 0, 0, 0, 0, 0])})).points[0]!.water.state).toBe('dry');
  });

  it('ponded when the three-day total reaches 100 mm (not at 99.9), held two days', () => {
    const c = fieldConditions(base({weather: days(A, [40, 30, 30, 0, 0, 0, 0, 0, 0, 0])}));
    // 40 + 30 + 30 = 100 on day 2 -> ponded days 2 to 4; days 0 and 1 are moist (moderate rain), day 5 dry.
    expect(c.points.slice(0, 6).map((p) => p.water.state)).toEqual(['moist', 'moist', 'ponded', 'ponded', 'ponded', 'dry']);
    expect(fieldConditions(base({weather: days(A, [40, 30, 29.9, 0, 0, 0, 0, 0, 0, 0])})).points[2]!.water.state).toBe('moist');
    expect(CONDITION_ASSUMPTIONS.rainRule.value.threeDayMm).toBe(100);
  });

  it('no weather record: unknown rain and water, kind unavailable', () => {
    const c = fieldConditions(base({weather: days(A, [0, 0, 0]).concat([{...wx(addDays(A, 3), null, null), kind: 'unavailable'}])}));
    expect(point(c, addDays(A, 3))).toMatchObject({kind: 'unavailable', rain: {mm: null, class: 'unknown'}, water: {state: 'unknown', basis: 'none'}, heat: {tMaxC: null, stress: false, thresholdC: null}});
    expect(point(c, addDays(A, 5))).toMatchObject({kind: 'unavailable', water: {state: 'unknown'}});
    expect(c.limitations.join(' ')).toMatch(/no weather record/);
  });
});

describe('heat stress', () => {
  it('rice 35 C at the flowering (mid-season) stage, inclusive; the flagged 40 C elsewhere; maize 40 C', () => {
    const tl = timeline('paddy', A, {earliest: addDays(A, 105), latest: addDays(A, 110)});
    const mid = addDays(A, 60), early = addDays(A, 10);
    const c = fieldConditions(base({cropId: 'paddy', timeline: tl, window: {from: A, to: addDays(A, 70)}, weather: [wx(early, 0, 39.9), wx(addDays(A, 11), 0, 40), wx(mid, 0, 35), wx(addDays(A, 61), 0, 34.9)]}));
    expect(point(c, mid).heat).toEqual({tMaxC: 35, stress: true, thresholdC: 35});
    expect(point(c, addDays(A, 61)).heat).toEqual({tMaxC: 34.9, stress: false, thresholdC: 35});
    expect(point(c, early).heat).toEqual({tMaxC: 39.9, stress: false, thresholdC: 40});
    expect(point(c, addDays(A, 11)).heat).toEqual({tMaxC: 40, stress: true, thresholdC: 40});
    expect(c.basis.some((b) => b.sourceId === 'CSU-RICE2001-HIGH-TEMP-FLOWERING')).toBe(true);
    expect(c.basis.map((b) => b.sourceId)).toEqual(expect.arrayContaining(['today-conditions-assumption:heatStageMatch', 'today-conditions-assumption:defaultHeatC']));
    const maize = fieldConditions(base({window: {from: mid, to: mid}, weather: [wx(mid, 0, 36)]}));
    expect(maize.points[0]!.heat).toEqual({tMaxC: 36, stress: false, thresholdC: 40});
  });
});

describe('greenness, events, stage, points', () => {
  it('greenness holds the latest reading on or before the day, null before the first; nothing interpolated', () => {
    const c = fieldConditions(base({readings: [{date: addDays(A, 2), ndvi: 0.31, verdict: 'near_typical'}, {date: addDays(A, 7), ndvi: 0.48, verdict: 'above_typical'}]}));
    expect(point(c, addDays(A, 1)).greenness).toEqual({ndvi: null, verdict: null, observedOn: null, daysSince: null});
    expect(point(c, addDays(A, 2)).greenness).toEqual({ndvi: 0.31, verdict: 'near_typical', observedOn: addDays(A, 2), daysSince: 0});
    expect(point(c, addDays(A, 6)).greenness).toEqual({ndvi: 0.31, verdict: 'near_typical', observedOn: addDays(A, 2), daysSince: 4});
    expect(point(c, addDays(A, 9)).greenness).toEqual({ndvi: 0.48, verdict: 'above_typical', observedOn: addDays(A, 7), daysSince: 2});
  });

  it('events are the alerts valid on the day, warnings first, at most 5', () => {
    const ids = Array.from({length: 7}, (_, k) => `2222222${k}-2222-4222-8222-222222222222`);
    const alerts = [alert(ids[0]!, 'info', addDays(A, 1), addDays(A, 3)), alert(ids[1]!, 'warning', addDays(A, 2), addDays(A, 2)), ...ids.slice(2).map((id) => alert(id, 'watch', A, addDays(A, 9)))];
    const c = fieldConditions(base({alerts}));
    expect(point(c, A).events.map((e) => e.alertId)).toEqual(ids.slice(2));
    const d2 = point(c, addDays(A, 2)).events;
    expect(d2).toHaveLength(5);
    expect(d2[0]).toEqual({alertId: ids[1], type: 'weather', severity: 'warning', title: 'Synthetic warning'});
    expect(d2.some((e) => e.alertId === ids[0])).toBe(false); // info sorts after the five shown
    expect(point(c, addDays(A, 4)).events.some((e) => e.alertId === ids[0])).toBe(false); // expired
  });

  it('one contract-valid point per day of the window, with stage, basis and limitations', () => {
    const c = FieldConditions.parse(fieldConditions(base({window: {from: A, to: addDays(A, 39)}, weather: days(A, Array(40).fill(1))})));
    expect(c.points).toHaveLength(40);
    expect(c.points.map((p) => p.date)).toEqual(Array.from({length: 40}, (_, k) => addDays(A, k)));
    expect(point(c, A).stage).toEqual({id: 'initial', name: 'Initial', progress: 0});
    expect(point(c, addDays(A, 30)).stage).toMatchObject({id: 'development', progress: 0});
    expect(c.basis.some((b) => b.kind === 'climatology' && b.sourceId === 'IMD-MC-AGARTALA-DAILY-RAINFALL')).toBe(true);
    expect(c.basis.some((b) => b.kind === 'model' && b.sourceId === 'today-conditions-assumption:rainRule')).toBe(true);
    expect(c.limitations[0]).toMatch(/not seen on the field/);
    expect(c.limitations).toContain(CONDITION_ASSUMPTIONS.rainRule.text);
    expect(c.limitations).toContain(CONDITION_ASSUMPTIONS.pondHoldDays.text);
    // Forecast and typical days keep their kind.
    const k = fieldConditions(base({window: {from: A, to: addDays(A, 1)}, weather: [wx(A, 3, 30, 'forecast'), wx(addDays(A, 1), 3, 30, 'typical')]}));
    expect(k.points.map((p) => p.kind)).toEqual(['forecast', 'typical']);
    expect(k.limitations.join(' ')).toMatch(/typical weather of past years/);
  });

  it('the loader is tolerant: a malformed class is skipped and recorded; nothing is invented', () => {
    invalidate({rainClasses: {sourceId: 'X', classes: [{class: 'light', lowerMm: 2.5}, {class: 'monsoon', lowerMm: 9}]}, waterPractice: [{cropId: 'paddy'}], heatThresholds: [], sources: {}});
    const d = loadConditionsData();
    expect(d.rainClasses!.classes).toEqual([{class: 'light', lowerMm: 2.5}]);
    expect(d.waterPractice).toEqual([]);
    expect(loadIssues().length).toBe(2);
    invalidate('not an object');
    expect(() => loadConditionsData()).toThrow();
  });
});
