/**
 * Test doubles for Microsoft Planetary Computer. No network: every request is answered in memory and recorded.
 *
 * Static fixtures in this directory (public Copernicus Sentinel-2 data via Planetary Computer, captured 2026-11-01):
 * - good-20261027-1ha.npy, bad-20261029-1ha.npy: `item/feature.npy` responses (B04, B08, SCL, mask; '<u2' (4, 11, 11))
 *   for the 1 ha square 76.2495..76.2505 E, 13.2495..13.2505 N on T43PFQ. The 2026-10-29 scene is the anomalous
 *   8-bit-looking scene from docs/research/TODAY_VIEW_PROVIDERS.md section 1.5.
 * - stac-search-43PFQ-2026-10.json: STAC POST search with the fields filter, October 2026, same bbox.
 * Reference statistics for the good fixture were computed independently in Python (offset 1000, SCL 4-7, n+r > 200):
 * 121 clear pixels, mean 0.6372, median 0.646, p10 0.5482, p90 0.7194, raw B04 p95 1867; bad fixture B04 p95 242.05.
 */
import sharp from 'sharp';
import {PC_ORIGIN, type Sentinel2Fetch} from '../../../src/providers/sentinel2';

export type NpyDescr = '<u2' | '|u1' | '<i2' | '<f4' | '<f8' | '>u2' | '<u4';

/** Writes a NumPy .npy buffer (format 1.0 or 2.0) the way numpy.save does: header padded to 64 bytes, ending in '\n'. */
export function makeNpy(shape: number[], values: ArrayLike<number>, opts: {descr?: NpyDescr; version?: 1 | 2; fortran?: boolean} = {}): Uint8Array<ArrayBuffer> {
  const descr = opts.descr ?? '<u2';
  const version = opts.version ?? 1;
  const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '${descr}', 'fortran_order': ${opts.fortran ? 'True' : 'False'}, 'shape': ${shapeText}, }`;
  const prefix = version === 1 ? 10 : 12;
  const total = Math.ceil((prefix + header.length + 1) / 64) * 64;
  header = header.padEnd(total - prefix - 1, ' ') + '\n';
  const size = {'<u2': 2, '|u1': 1, '<i2': 2, '<f4': 4, '<f8': 8, '>u2': 2, '<u4': 4}[descr];
  const out = new Uint8Array(total + values.length * size);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
  const view = new DataView(out.buffer);
  if (version === 1) view.setUint16(8, header.length, true); else view.setUint32(8, header.length, true);
  for (let i = 0; i < header.length; i++) out[prefix + i] = header.charCodeAt(i);
  for (let i = 0; i < values.length; i++) {
    const at = total + i * size, v = values[i]!;
    if (descr === '<u2') view.setUint16(at, v, true);
    else if (descr === '>u2') view.setUint16(at, v, false);
    else if (descr === '|u1') view.setUint8(at, v);
    else if (descr === '<i2') view.setInt16(at, v, true);
    else if (descr === '<u4') view.setUint32(at, v, true);
    else if (descr === '<f4') view.setFloat32(at, v, true);
    else view.setFloat64(at, v, true);
  }
  return out;
}

/** What a scene looks like over an area: a uniform NDVI on clear land, the 8-bit anomaly, or cloud. */
export type SceneLook = {ndvi: number} | 'bad' | 'cloudy';

/** Bands for an h x w area with every pixel inside the mask; offset is added to clear-land digital numbers. */
export function sceneStack(look: SceneLook, h: number, w: number, offset = 1000): Uint16Array {
  const px = h * w, out = new Uint16Array(4 * px);
  for (let i = 0; i < px; i++) {
    let b04: number, b08: number, scl: number;
    if (look === 'bad') { b04 = 20 + ((i * 37) % 220); b08 = 40 + ((i * 53) % 210); scl = 4; }
    else if (look === 'cloudy') { b04 = 6000; b08 = 6200; scl = 9; }
    else { const r = 1000; b04 = r + offset; b08 = Math.round((r * (1 + look.ndvi)) / (1 - look.ndvi)) + offset; scl = 4; }
    out[i] = b04; out[px + i] = b08; out[2 * px + i] = scl; out[3 * px + i] = 255;
  }
  return out;
}

export interface FakeScene { id: string; datetime: string; cloud?: number; baseline?: string; field: SceneLook; neighbourhood?: SceneLook }
export interface FakeCall { method: string; url: string; path: string; item: string | null; body: unknown }
export interface FakeOptions {
  /** Item ids whose next neighbourhood read fails with HTTP 500 (each id fails once). */
  failNeighbourhoodOnce?: Set<string>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/geo+json'}});

/** Field reads are recognised by a small polygon (< 0.005 degrees across); larger requests are neighbourhood reads. */
export function fakePlanetary(scenes: FakeScene[], opts: FakeOptions = {}) {
  const calls: FakeCall[] = [];
  const failOnce = new Set(opts.failNeighbourhoodOnce ?? []);
  const fetchImpl: Sentinel2Fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({method: init.method, url, path: u.pathname, item: u.searchParams.get('item'), body});
    if (u.origin !== PC_ORIGIN) throw new Error(`unexpected origin ${u.origin}`);
    if (!(init.signal instanceof AbortSignal)) throw new Error('request without timeout signal');
    if (u.pathname === '/api/stac/v1/search') {
      const [start, end] = String(body.datetime).split('/').map((s: string) => Date.parse(s)) as [number, number];
      const features = scenes.filter((s) => Date.parse(s.datetime) >= start && Date.parse(s.datetime) <= end && (s.cloud ?? 1) < (body.query?.['eo:cloud_cover']?.lt ?? 101))
        .sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, body.limit)
        .map((s) => ({id: s.id, properties: {datetime: s.datetime, 'eo:cloud_cover': s.cloud ?? 1, 's2:processing_baseline': s.baseline ?? '05.13', 's2:mgrs_tile': '43PFQ', platform: 'Sentinel-2A'}}));
      return json({type: 'FeatureCollection', links: [{rel: 'self', href: `${PC_ORIGIN}/api/stac/v1/search`}], features, numberReturned: features.length});
    }
    const scene = scenes.find((s) => s.id === u.searchParams.get('item'));
    if (!scene) return json({detail: 'not found'}, 404);
    if (u.pathname === '/api/data/v1/item/feature.npy') {
      const ring = body.geometry.coordinates[0] as [number, number][];
      const width = Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));
      const isField = width < 0.005;
      if (!isField && failOnce.delete(scene.id)) return json({detail: 'upstream'}, 500);
      const [h, w] = isField ? [10, 10] : [24, 24];
      const offset = Number((scene.baseline ?? '05.13').slice(0, 2)) >= 4 ? 1000 : 0;
      const npy = makeNpy([4, h, w], sceneStack(isField ? scene.field : scene.neighbourhood ?? scene.field, h, w, offset));
      return new Response(npy, {status: 200, headers: {'content-type': 'application/x-binary', 'content-length': String(npy.length)}});
    }
    if (u.pathname.startsWith('/api/data/v1/item/bbox/')) {
      const png = await sharp({create: {width: 4, height: 4, channels: 3, background: {r: 30, g: 140, b: 60}}}).png().toBuffer();
      return new Response(png, {status: 200, headers: {'content-type': 'image/png', 'content-length': String(png.length)}});
    }
    return json({detail: 'unexpected path'}, 400);
  };
  return {fetchImpl, calls};
}
