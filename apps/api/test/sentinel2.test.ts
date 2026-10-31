import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {NdviStats} from '@harvest/contracts';
import {
  PC_ORIGIN, bandStack, baselineOffset, bboxAreaKm2, bufferBbox, listScenes, ndviStats, neighbourhoodBands, parseNpy, polygonBands, prepareRing, renderScene,
  type Sentinel2Fetch,
} from '../src/providers/sentinel2';
import {fakePlanetary, makeNpy, sceneStack} from './fixtures/sentinel2/fake-provider';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/sentinel2', name)));
const HA_RING = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];

/** One pixel per SCL class 0..11, all inside the mask, with clear-land values (B04 1500, B08 3500 raw). */
function sclLadder() {
  const px = 12, out = new Uint16Array(4 * px);
  for (let i = 0; i < px; i++) { out[i] = 1500; out[px + i] = 3500; out[2 * px + i] = i; out[3 * px + i] = 255; }
  return bandStack({dtype: 'u2', shape: [4, 1, px], data: out})!;
}

describe('npy parser', () => {
  it('parses real provider output (<u2, (4, 11, 11)) for both captured scenes', () => {
    for (const name of ['good-20261027-1ha.npy', 'bad-20261029-1ha.npy']) {
      const npy = parseNpy(fixture(name));
      expect(npy.dtype).toBe('u2');
      expect(npy.shape).toEqual([4, 11, 11]);
      expect(npy.data).toBeInstanceOf(Uint16Array);
      expect(npy.data.length).toBe(4 * 121);
      expect([...npy.data.subarray(3 * 121)].every((v) => v === 255)).toBe(true); // mask band
    }
  });
  it('round-trips generated buffers for every supported dtype and format version 2', () => {
    const values = [0, 1, 255, 65535, 1000, 4096];
    expect([...parseNpy(makeNpy([2, 3], values)).data]).toEqual(values);
    expect(parseNpy(makeNpy([2, 3], values, {version: 2})).shape).toEqual([2, 3]);
    expect([...parseNpy(makeNpy([3], [0, 7, 255], {descr: '|u1'})).data]).toEqual([0, 7, 255]);
    expect([...parseNpy(makeNpy([3], [-5, 0, 300], {descr: '<i2'})).data]).toEqual([-5, 0, 300]);
    expect([...parseNpy(makeNpy([2], [70000, 1], {descr: '<u4'})).data]).toEqual([70000, 1]);
    const f4 = parseNpy(makeNpy([2], [0.5, -0.25], {descr: '<f4'}));
    expect(f4.dtype).toBe('f4');
    expect([...f4.data]).toEqual([0.5, -0.25]);
    expect([...parseNpy(makeNpy([1], [Math.PI], {descr: '<f8'})).data]).toEqual([Math.PI]);
  });
  it('rejects bad magic, big-endian, Fortran order, truncation and trailing bytes', () => {
    const good = makeNpy([2, 2], [1, 2, 3, 4]);
    expect(() => parseNpy(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toThrow('npy_bad_magic');
    expect(() => parseNpy(makeNpy([2], [1, 2], {descr: '>u2'}))).toThrow('npy_unsupported_byte_order');
    expect(() => parseNpy(makeNpy([2, 2], [1, 2, 3, 4], {fortran: true}))).toThrow('npy_fortran_order_unsupported');
    expect(() => parseNpy(good.subarray(0, good.length - 1))).toThrow('npy_length_mismatch');
    const longer = new Uint8Array(good.length + 2); longer.set(good);
    expect(() => parseNpy(longer)).toThrow('npy_length_mismatch');
  });
  it('accepts only a (4, H, W) uint16 stack as band input', () => {
    expect(bandStack(parseNpy(makeNpy([3, 2, 2], new Array(12).fill(1))))).toBeNull();
    expect(bandStack(parseNpy(makeNpy([4, 2, 2], new Array(16).fill(1), {descr: '<f4'})))).toBeNull();
    expect(bandStack(parseNpy(makeNpy([4, 2, 2], new Array(16).fill(1))))).not.toBeNull();
  });
});

describe('radiometry and masking', () => {
  it('derives the +1000 offset from the processing baseline only', () => {
    expect(baselineOffset('05.13')).toBe(1000);
    expect(baselineOffset('04.00')).toBe(1000);
    expect(baselineOffset('03.01')).toBe(0);
    expect(baselineOffset('02.14')).toBe(0);
    expect(baselineOffset(null)).toBeNull();
    expect(baselineOffset('5.13a')).toBeNull();
  });
  it('matches the independent reference on the real 2026-10-27 fixture with the offset on, and the naive value with it off', () => {
    const bands = bandStack(parseNpy(fixture('good-20261027-1ha.npy')))!;
    const on = ndviStats(bands, 1000);
    expect(NdviStats.parse(on)).toEqual(on);
    expect(on).toMatchObject({clearPixels: 121, totalPixels: 121, clearFraction: 1, mean: 0.6372, median: 0.646, p10: 0.5482, p90: 0.7194, b04P95: 1867, usable: true, rejection: null});
    const off = ndviStats(bands, 0);
    expect(off.mean).toBe(0.404);
    expect(on.mean! - off.mean!).toBeGreaterThan(0.2);
  });
  it('clamps corrected digital numbers at zero and drops near-zero denominators', () => {
    // Raw 900/1150 with offset 1000 -> r 0, n 150: n + r <= 200, so excluded rather than NDVI = 1.
    const px = 10, d = new Uint16Array(4 * px);
    for (let i = 0; i < px; i++) { d[i] = i < 9 ? 1500 : 900; d[px + i] = i < 9 ? 3500 : 1150; d[2 * px + i] = 4; d[3 * px + i] = 255; }
    const s = ndviStats(bandStack({dtype: 'u2', shape: [4, 1, px], data: d})!, 1000);
    expect(s.clearPixels).toBe(9);
    expect(s.mean).toBeCloseTo(2000 / 3000, 4);
    expect(s.p90).toBeLessThanOrEqual(1);
  });
  it('keeps SCL 4, 5, 6, 7 and drops no-data, saturated, dark, shadow, cloud, cirrus and snow', () => {
    const s = ndviStats(sclLadder(), 1000);
    expect(s.totalPixels).toBe(12);
    expect(s.clearPixels).toBe(4);
    expect(s.clearFraction).toBeCloseTo(4 / 12, 4);
    expect(s.cloudOrShadowFraction).toBeCloseTo(4 / 12, 4); // classes 3, 8, 9, 10
    expect(s.rejection).toBe('insufficient_clear_pixels');
  });
  it('ignores pixels outside the polygon mask and raw zero (no data) bands', () => {
    const px = 20, d = sceneStack({ndvi: 0.5}, 1, px);
    for (let i = 0; i < 5; i++) d[3 * px + i] = 0; // outside the polygon
    d[px + 10] = 0; // B08 no data
    const s = ndviStats(bandStack({dtype: 'u2', shape: [4, 1, px], data: d})!, 1000);
    expect(s.totalPixels).toBe(15);
    expect(s.clearPixels).toBe(14);
    expect(s.mean).toBeCloseTo(0.5, 3);
  });
  it('rejects the 2026-10-29 style scene with the B04 p95 plausibility guard (real and generated)', () => {
    const real = ndviStats(bandStack(parseNpy(fixture('bad-20261029-1ha.npy')))!, 1000);
    expect(real.usable).toBe(false);
    expect(real.rejection).toBe('implausible_band_values');
    expect(real.b04P95).toBeCloseTo(242.05, 0);
    // Even without the offset (which would otherwise zero every pixel) the guard still rejects it.
    const generated = ndviStats(bandStack({dtype: 'u2', shape: [4, 10, 10], data: sceneStack('bad', 10, 10)})!, 0);
    expect(generated.clearPixels).toBeGreaterThan(8);
    expect(generated.rejection).toBe('implausible_band_values');
  });
  it('requires a 0.6 clear fraction and at least 8 clear pixels', () => {
    const mixed = (clear: number, cloud: number) => {
      const px = clear + cloud, d = sceneStack({ndvi: 0.6}, 1, px);
      for (let i = clear; i < px; i++) d[2 * px + i] = 9;
      return ndviStats(bandStack({dtype: 'u2', shape: [4, 1, px], data: d})!, 1000);
    };
    expect(mixed(12, 8)).toMatchObject({clearFraction: 0.6, usable: true});
    expect(mixed(11, 9)).toMatchObject({rejection: 'low_clear_fraction', usable: false});
    expect(mixed(7, 0)).toMatchObject({rejection: 'insufficient_clear_pixels', usable: false});
    expect(mixed(0, 10)).toMatchObject({mean: null, median: null, usable: false});
  });
});

describe('geometry guards', () => {
  it('rounds vertices to 4 decimals, drops repeats and rejects degenerate rings', () => {
    expect(prepareRing([[76.249512, 13.249549], [76.250461, 13.249549], [76.250461, 13.250451], [76.249512, 13.250451]])).toEqual([[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]]);
    expect(prepareRing([[76.24951, 13.24951], [76.24952, 13.24952], [76.24953, 13.24951]])).toBeNull();
    expect(prepareRing([[200, 13], [76, 13], [76, 14]])).toBeNull();
  });
  it('buffers about 1 km and measures area', () => {
    const b = bufferBbox([76.24, 13.24, 76.26, 13.26], 1000);
    expect(b[0]).toBeCloseTo(76.2308, 3);
    expect(b[1]).toBeCloseTo(13.231, 3);
    expect(bboxAreaKm2(b)).toBeGreaterThan(16);
    expect(bboxAreaKm2(b)).toBeLessThan(25);
  });
});

describe('provider requests', () => {
  const scenes = [
    {id: 'S2C_MSIL2A_20261027T051911_R062_T43PFQ_20261027T101812', datetime: '2026-10-27T05:19:11.025Z', field: {ndvi: 0.63} as const, baseline: '05.13'},
    {id: 'S2X_OLD_20210101', datetime: '2021-01-01T05:19:11.025Z', field: {ndvi: 0.63} as const, baseline: '02.14'},
  ];
  it('lists scenes by STAC POST with a fields filter, 4-decimal bbox and the fixed origin', async () => {
    const {fetchImpl, calls} = fakePlanetary(scenes);
    const res = await listScenes({bbox: [76.249512, 13.249549, 76.250461, 13.250451], from: '2026-10-01', to: '2026-10-31', fetchImpl});
    expect(res).toMatchObject({status: 'ok', truncated: false});
    if (res.status !== 'ok') throw new Error('unreachable');
    expect(res.scenes.map((s) => s.id)).toEqual([scenes[0]!.id]);
    expect(res.scenes[0]).toMatchObject({baseline: '05.13', tileId: '43PFQ', cloudPct: 1});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PC_ORIGIN}/api/stac/v1/search`);
    expect(calls[0]!.method).toBe('POST');
    const body = calls[0]!.body as {bbox: number[]; fields: {include: string[]; exclude: string[]}; collections: string[]; datetime: string};
    expect(body.collections).toEqual(['sentinel-2-l2a']);
    expect(body.bbox).toEqual([76.2495, 13.2495, 76.2505, 13.2505]);
    expect(body.datetime).toBe('2026-10-01T00:00:00Z/2026-10-31T23:59:59Z');
    expect(body.fields.include).toContain('properties.s2:processing_baseline');
    expect(body.fields.exclude).toEqual(expect.arrayContaining(['assets', 'links']));
  });
  it('parses the captured live STAC response and drops duplicate acquisitions from overlapping tiles', async () => {
    const live = JSON.parse(new TextDecoder().decode(fixture('stac-search-43PFQ-2026-10.json')));
    const dup = structuredClone(live.features[1]);
    dup.id = dup.id.replace('T43PFQ', 'T43PFP'); dup.properties['s2:mgrs_tile'] = '43PFP';
    live.features.push(dup, {id: '../../etc', properties: {datetime: '2026-10-02T00:00:00Z'}});
    const fetchImpl: Sentinel2Fetch = async () => new Response(JSON.stringify(live), {status: 200, headers: {'content-type': 'application/geo+json'}});
    const res = await listScenes({bbox: [76.24, 13.24, 76.26, 13.26], from: '2026-10-01', to: '2026-10-31', fetchImpl});
    if (res.status !== 'ok') throw new Error(res.reason);
    expect(res.scenes).toHaveLength(6);
    expect(res.duplicatesSkipped).toBe(1);
    expect(res.scenes.every((s) => s.tileId === '43PFQ')).toBe(true);
    expect(res.scenes[0]).toMatchObject({id: 'S2A_MSIL2A_20261029T052231_R062_T43PFQ_20261029T101714', datetime: '2026-10-29T05:22:31.024Z', baseline: '05.13'});
  });
  it('rejects bboxes over 25 km2 and bad windows before any request', async () => {
    const {fetchImpl, calls} = fakePlanetary(scenes);
    expect(await listScenes({bbox: [76, 13, 76.1, 13.1], from: '2026-10-01', to: '2026-10-31', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'bbox_too_large'});
    expect(await listScenes({bbox: [76.24, 13.24, 76.26, 13.26], from: '2026-11-01', to: '2026-10-31', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'invalid_window'});
    expect(await polygonBands({itemId: scenes[0]!.id, polygon: [[76, 13], [76.1, 13], [76.1, 13.1], [76, 13.1], [76, 13]], baseline: '05.13', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'bbox_too_large'});
    expect(await polygonBands({itemId: '../x', polygon: HA_RING, baseline: '05.13', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'invalid_item_id'});
    expect(await polygonBands({itemId: scenes[0]!.id, polygon: HA_RING, baseline: null, fetchImpl})).toMatchObject({status: 'unavailable', reason: 'processing_baseline_unknown'});
    expect(await neighbourhoodBands({itemId: scenes[0]!.id, polygon: [[76, 13], [76.04, 13], [76.04, 13.04], [76, 13.04], [76, 13]], baseline: '05.13', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'neighbourhood_too_large'});
    expect(calls).toHaveLength(0);
  });
  it('reads field bands with feature.npy and a rounded polygon, applying the offset only for baseline >= 04.00', async () => {
    const {fetchImpl, calls} = fakePlanetary(scenes);
    const field = await polygonBands({itemId: scenes[0]!.id, polygon: [[76.249512, 13.249549], [76.250461, 13.249549], [76.250461, 13.250451], [76.249512, 13.250451], [76.249512, 13.249549]], baseline: '05.13', fetchImpl});
    if (field.status !== 'ok') throw new Error(field.reason);
    expect(field.offset).toBe(1000);
    expect(field.stats).toMatchObject({totalPixels: 100, clearPixels: 100, usable: true});
    expect(field.stats.mean).toBeCloseTo(0.63, 3);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe(`${PC_ORIGIN}/api/data/v1/item/feature.npy`);
    expect(u.searchParams.getAll('assets')).toEqual(['B04', 'B08', 'SCL']);
    expect(u.searchParams.get('asset_as_band')).toBe('true');
    expect((calls[0]!.body as {geometry: {coordinates: number[][][]}}).geometry.coordinates[0]).toEqual(HA_RING);
    const old = await polygonBands({itemId: scenes[1]!.id, polygon: HA_RING, baseline: '02.14', fetchImpl});
    if (old.status !== 'ok') throw new Error(old.reason);
    expect(old.offset).toBe(0);
    expect(old.stats.mean).toBeCloseTo(0.63, 3);
  });
  it('reads the 1 km neighbourhood as a buffered bbox polygon', async () => {
    const {fetchImpl, calls} = fakePlanetary([{...scenes[0]!, neighbourhood: {ndvi: 0.5}}]);
    const nb = await neighbourhoodBands({itemId: scenes[0]!.id, polygon: HA_RING, baseline: '05.13', fetchImpl});
    if (nb.status !== 'ok') throw new Error(nb.reason);
    expect(nb.stats.totalPixels).toBe(576);
    expect(nb.stats.mean).toBeCloseTo(0.5, 3);
    const ring = (calls[0]!.body as {geometry: {coordinates: number[][][]}}).geometry.coordinates[0]!;
    expect(ring[0]![0]).toBeCloseTo(76.2495 - 1000 / (111320 * Math.cos(13.25 * Math.PI / 180)), 3);
    expect(ring.every((p) => p.every((v) => Math.round(v * 1e4) / 1e4 === v))).toBe(true);
  });
  it('renders true colour and offset-aware NDVI PNGs from the fixed bbox endpoint', async () => {
    const {fetchImpl, calls} = fakePlanetary(scenes);
    const visual = await renderScene({itemId: scenes[0]!.id, bbox: [76.245, 13.245, 76.255, 13.255], kind: 'visual', fetchImpl});
    expect(visual).toMatchObject({status: 'ok', contentType: 'image/png'});
    const ndvi = await renderScene({itemId: scenes[0]!.id, bbox: [76.245, 13.245, 76.255, 13.255], kind: 'ndvi', baseline: '05.13', fetchImpl});
    expect(ndvi.status).toBe('ok');
    const old = await renderScene({itemId: scenes[1]!.id, bbox: [76.245, 13.245, 76.255, 13.255], kind: 'ndvi', baseline: '02.14', fetchImpl});
    expect(old.status).toBe('ok');
    const [v, n, o] = calls.map((c) => new URL(c.url));
    expect(v!.pathname).toBe('/api/data/v1/item/bbox/76.2450,13.2450,76.2550,13.2550/512x512.png');
    expect(v!.searchParams.get('assets')).toBe('visual');
    expect(n!.searchParams.get('expression')).toBe('(B08-B04)/(B08+B04-2000)');
    expect(n!.searchParams.get('colormap_name')).toBe('rdylgn');
    expect(o!.searchParams.get('expression')).toBe('(B08-B04)/(B08+B04)');
    expect(await renderScene({itemId: scenes[0]!.id, bbox: [76.245, 13.245, 76.255, 13.255], kind: 'ndvi', baseline: null, fetchImpl})).toMatchObject({status: 'unavailable', reason: 'processing_baseline_unknown'});
    expect(await renderScene({itemId: scenes[0]!.id, bbox: [76, 13, 76.2, 13.2], kind: 'visual', fetchImpl})).toMatchObject({status: 'unavailable', reason: 'bbox_too_large'});
  });
  it('degrades every provider failure to unavailable instead of throwing', async () => {
    const respond = (status: number, headers: Record<string, string> = {}, body: BodyInit = 'x'): Sentinel2Fetch => async () => new Response(body, {status, headers});
    const args = {itemId: scenes[0]!.id, bbox: [76.245, 13.245, 76.255, 13.255] as const, kind: 'visual' as const};
    expect(await renderScene({...args, fetchImpl: respond(500)})).toMatchObject({status: 'unavailable', reason: 'provider_error', transient: true});
    expect(await renderScene({...args, fetchImpl: respond(429)})).toMatchObject({status: 'unavailable', reason: 'provider_rate_limited', transient: true});
    expect(await renderScene({...args, fetchImpl: respond(404)})).toMatchObject({status: 'unavailable', reason: 'scene_not_found'});
    expect(await renderScene({...args, fetchImpl: respond(200, {'content-type': 'text/html'}, '<html>')})).toMatchObject({status: 'unavailable', reason: 'invalid_provider_response'});
    expect(await renderScene({...args, fetchImpl: respond(200, {'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024)})})).toMatchObject({status: 'unavailable', reason: 'response_too_large'});
    expect(await renderScene({...args, fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); }})).toMatchObject({status: 'unavailable', reason: 'provider_timeout', transient: true});
    expect(await renderScene({...args, fetchImpl: async () => { throw new TypeError('fetch failed'); }})).toMatchObject({status: 'unavailable', reason: 'provider_unreachable', transient: true});
    expect(await polygonBands({itemId: scenes[0]!.id, polygon: HA_RING, baseline: '05.13', fetchImpl: respond(200, {}, 'not npy')})).toMatchObject({status: 'unavailable', reason: 'invalid_provider_response'});
    expect(await polygonBands({itemId: scenes[0]!.id, polygon: HA_RING, baseline: '05.13', fetchImpl: respond(200, {}, makeNpy([3, 2, 2], new Array(12).fill(1)))})).toMatchObject({status: 'unavailable', reason: 'unexpected_band_layout'});
    expect(await listScenes({bbox: [76.24, 13.24, 76.26, 13.26], from: '2026-10-01', to: '2026-10-31', fetchImpl: respond(200, {}, '{"features":"nope"}')})).toMatchObject({status: 'unavailable', reason: 'invalid_provider_response'});
  });
});
