import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {StageTimeline} from '@harvest/contracts';
import {setupHarness, type Harness} from './helpers';
import {ensureSource, OPENMETEO_SOURCES} from '../src/ingest/sources';
import {storedPredictionContext} from '../src/services/today/future-look';

/** SYNTHETIC: stored forecast rows and facts written by the test; no provider is called. */
const NOW = () => new Date('2026-11-01T06:00:00Z');
const RING: [number, number][] = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];
const st = (id: string, name: string, from: string, to: string) => ({id, name, from, to, basis: 'fao_generic' as const});
const TIMELINE = StageTimeline.parse({
  cropId: 'maize', productId: null, establishmentMethod: null, anchorDate: '2026-09-20', harvest: {earliest: '2027-01-03', latest: '2027-01-08'},
  basis: {kind: 'duration', label: 'test timeline', sourceId: null, url: null, scope: null, note: null},
  stages: [st('initial', 'Initial', '2026-09-20', '2026-10-10'), st('development', 'Crop development', '2026-10-10', '2026-11-14'), st('mid_season', 'Mid-season', '2026-11-14', '2026-12-24'), st('late_season', 'Late season', '2026-12-24', '2027-01-23')],
});

let h: Harness;
beforeAll(async () => { h = await setupHarness(); });
afterAll(async () => h?.close());

describe('storedPredictionContext carries agro and the soil texture into the conditions point', () => {
  it('stored forecast agro (soil moisture 0.18) is read as moist for a recorded sand, and is not classed without a texture', async () => {
    const sourceId = await ensureSource(h.pool, OPENMETEO_SOURCES.forecast.manifestId, OPENMETEO_SOURCES.forecast.fallback);
    const variables = {precipitation_sum: 0, temperature_2m_max: 30, temperature_2m_min: 20, et0_fao_evapotranspiration: 4, soil_moisture_0_to_7cm_mean: 0.18, leaf_wetness_probability_mean: 70, relative_humidity_2m_mean: 85};
    await h.pool.query(
      `INSERT INTO weather_forecasts (location_key, lon, lat, issued_at, valid_on, variables, source_id, is_synthetic, mode, available_at, horizon_days)
       VALUES ('open-meteo:13.250,76.250', 76.25, 13.25, '2026-11-01T01:00:00Z', '2026-11-02', $1::jsonb, $2, false, 'live', '2026-11-01T01:00:00Z', 3)`,
      [JSON.stringify(variables), sourceId],
    );
    try {
      const base = {ownerId: randomUUID(), farmId: randomUUID(), polygonHash: 'none', ring: RING, cycle: {cropId: 'maize', sowingDate: '2026-09-20'}, timeline: TIMELINE, today: '2026-11-01', targetDate: '2026-11-02', now: NOW};
      const withSand = await storedPredictionContext(h.pool, {...base, facts: {soil_texture: {value: 'sand', basis: 'farmer_reported', confirmed: false}}});
      const point = withSand.conditionsAt('2026-11-02');
      expect(point?.water.basis).toBe('model_soil_moisture');
      expect(point?.water.soilMoisture0to7).toBe(0.18);
      expect(point?.pressure?.wetness).toBe('high'); // agro reached the conditions at all
      const without = (await storedPredictionContext(h.pool, {...base, facts: {}})).conditionsAt('2026-11-02');
      expect(without?.water.basis).not.toBe('model_soil_moisture');
      expect(without?.pressure?.wetness).toBe('high');
    } finally {
      await h.pool.query("DELETE FROM weather_forecasts WHERE location_key='open-meteo:13.250,76.250'");
    }
  });
});
