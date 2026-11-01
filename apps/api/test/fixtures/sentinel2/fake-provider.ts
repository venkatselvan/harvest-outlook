/**
 * Test doubles for Microsoft Planetary Computer. No network: every request is answered in memory and recorded.
 *
 * Static fixtures in this directory (public Copernicus Sentinel-2 data via Planetary Computer, captured 2026-11-01):
 * - good-20261027-1ha.npy, bad-20261029-1ha.npy: `item/feature.npy` responses (B04, B08, SCL, mask; '<u2' (4, 11, 11))
 *   for the 1 ha square 76.2495..76.2505 E, 13.2495..13.2505 N on T43PFQ. The 2026-10-29 scene is the anomalous
 *   8-bit-looking scene from docs/research/TODAY_VIEW_PROVIDERS.md section 1.5. Legacy layout, kept as captured.
 * - good-20261027-1ha-9band.npy: the same polygon and scene read with FEATURE_ASSETS (B02, B03, B04, B05, B08, B8A, B11,
 *   SCL, mask; '<u2' (9, 11, 11)), captured 2026-11-01T09:28Z. Its B04, B08, SCL and mask bands equal good-20261027-1ha.npy.
 * - stac-search-43PFQ-2026-10.json: STAC POST search with the fields filter, October 2026, same bbox.
 * Reference statistics for the good fixture were computed independently in Python (offset 1000, SCL 4-7, n+r > 200):
 * 121 clear pixels, mean 0.6372, median 0.646, p10 0.5482, p90 0.7194, raw B04 p95 1867; bad fixture B04 p95 242.05.
 * Index statistics for the 9-band fixture come from reference-indices.py in this directory (pure Python, separate
 * implementation): run `python3 -I reference-indices.py good-20261027-1ha-9band.npy good-20261027-1ha.npy`.
 */
import sharp from 'sharp';
import {FEATURE_ASSETS, PC_ORIGIN, type FeatureAsset, type Sentinel2Fetch} from '../../../src/providers/sentinel2';

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

/** Surface reflectances (0..1) for the bands other than B04 and B08; B04 is 0.10 and B08 follows from the NDVI. */
export interface LookBands { b02?: number; b03?: number; b05?: number; b8a?: number; b11?: number }
/** Defaults for a green canopy; B8A defaults to the B08 reflectance. At NDVI 0.63 they give EVI 0.51, NDRE 0.49, GNDVI 0.69,
 * SAVI 0.49, NDMI and LSWI 0.33, NDWI -0.69. Synthetic test values, not observations. */
export const DEFAULT_LOOK_BANDS = {b02: 0.05, b03: 0.08, b05: 0.15, b11: 0.22} as const;
/** What a scene looks like over an area: uniform clear land with an NDVI (and optional reflectances), the 8-bit anomaly, or cloud. */
export type SceneLook = {ndvi: number; bands?: LookBands} | 'bad' | 'cloudy';

/** Position of a band in a (9, H, W) stack: FEATURE_ASSETS in order, then the mask. */
export const bandIndex = (band: FeatureAsset | 'mask') => (band === 'mask' ? FEATURE_ASSETS.length : FEATURE_ASSETS.indexOf(band));
export const STACK_BANDS = FEATURE_ASSETS.length + 1;

/**
 * Bands for an h x w area in the (9, H, W) feature layout with every pixel inside the mask; offset is added to clear-land
 * digital numbers. `layout: 'legacy'` returns the (4, H, W) B04, B08, SCL, mask stack of reads before 2026-11-01.
 */
export function sceneStack(look: SceneLook, h: number, w: number, offset = 1000, layout: 'feature' | 'legacy' = 'feature'): Uint16Array {
  const px = h * w, out = new Uint16Array(STACK_BANDS * px);
  const set = (band: FeatureAsset | 'mask', i: number, v: number) => { out[bandIndex(band) * px + i] = v; };
  const dn = (rho: number) => Math.round(rho * 10000) + offset;
  for (let i = 0; i < px; i++) {
    let b04: number, b08: number, scl: number, rest: Record<'B02' | 'B03' | 'B05' | 'B8A' | 'B11', number>;
    if (look === 'bad') {
      b04 = 20 + ((i * 37) % 220); b08 = 40 + ((i * 53) % 210); scl = 4;
      rest = {B02: 15 + ((i * 29) % 200), B03: 18 + ((i * 31) % 210), B05: 30 + ((i * 41) % 215), B8A: 42 + ((i * 47) % 205), B11: 25 + ((i * 43) % 220)};
    } else if (look === 'cloudy') {
      b04 = 6000; b08 = 6200; scl = 9;
      rest = {B02: 6400, B03: 6200, B05: 6100, B8A: 6200, B11: 4800};
    } else {
      const r = 1000, nirDn = Math.round((r * (1 + look.ndvi)) / (1 - look.ndvi)), b = {...DEFAULT_LOOK_BANDS, b8a: nirDn / 10000, ...look.bands};
      b04 = r + offset; b08 = nirDn + offset; scl = 4;
      rest = {B02: dn(b.b02), B03: dn(b.b03), B05: dn(b.b05), B8A: dn(b.b8a), B11: dn(b.b11)};
    }
    set('B04', i, b04); set('B08', i, b08); set('SCL', i, scl); set('mask', i, 255);
    for (const [band, v] of Object.entries(rest)) set(band as FeatureAsset, i, v);
  }
  if (layout === 'feature') return out;
  const legacy = new Uint16Array(4 * px);
  (['B04', 'B08', 'SCL', 'mask'] as const).forEach((band, j) => legacy.set(out.subarray(bandIndex(band) * px, (bandIndex(band) + 1) * px), j * px));
  return legacy;
}

export interface FakeScene { id: string; datetime: string; cloud?: number; baseline?: string; field: SceneLook; neighbourhood?: SceneLook }
export interface FakeCall { method: string; url: string; path: string; item: string | null; body: unknown }
export interface FakeOptions {
  /** Item ids whose next neighbourhood read fails with HTTP 500 (each id fails once). */
  failNeighbourhoodOnce?: Set<string>;
  /** Answer feature.npy with the legacy (4, H, W) stack regardless of the requested assets. */
  legacyLayout?: boolean;
  /** Item ids whose neighbourhood reads always get a 4-band answer, which the provider rejects permanently (unexpected_band_layout). */
  breakNeighbourhood?: Set<string>;
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
      const look = isField ? scene.field : scene.neighbourhood ?? scene.field;
      const npy = opts.legacyLayout || (!isField && opts.breakNeighbourhood?.has(scene.id)) ? makeNpy([4, h, w], sceneStack(look, h, w, offset, 'legacy')) : makeNpy([STACK_BANDS, h, w], sceneStack(look, h, w, offset));
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
