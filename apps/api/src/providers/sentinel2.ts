/**
 * Sentinel-2 L2A reads from Microsoft Planetary Computer for field NDVI (Today view, Stream B).
 *
 * Verified provider behaviour (docs/research/TODAY_VIEW_PROVIDERS.md section 1, re-probed 2026-11-01):
 * - STAC POST search with a `fields` filter keeps scene lists small; anonymous, no SAS token needed.
 * - Data API `item/feature.npy` returns a NumPy array `<u2`: the requested assets in request order, then a mask band
 *   (255 inside the polygon), on an EPSG:4326 grid of about 10 m. Since 2026-11-01 the request is `FEATURE_ASSETS`
 *   (B02, B03, B04, B05, B08, B8A, B11, SCL), so the stack is (9, H, W). Re-probed 2026-11-01 on the 2026-10-27 T43PFQ
 *   scene: the 1 ha square gives (9, 11, 11) whose B04, B08, SCL and mask equal the earlier (4, 11, 11) read; the 20 m
 *   bands (B05, B8A, B11, SCL) arrive resampled onto the 10 m grid with about 25 distinct values each; the grid stays
 *   11 x 11 even when a 20 m band is requested first; the 1 km neighbourhood gives (9, 208, 215), 805,088 bytes.
 * - Processing baseline >= 04.00 adds +1000 to every L2A digital number; Planetary Computer does not correct it.
 * - The 2026-10-29 T43PFQ scene returns 8-bit-looking B04/B08 (p95 241); a B04 p95 <= 255 guard rejects it.
 * The service is a Preview ("not meant for production use", may change without notice), so every failure
 * degrades to `{status:'unavailable', reason, transient}` instead of throwing.
 */
import {z} from 'zod';
import {INDEX_IDS, type IndexId, type IndexSummaries, type IndexSummary, type NdviStats} from '@harvest/contracts';

export const PC_ORIGIN = 'https://planetarycomputer.microsoft.com';
const STAC_SEARCH_URL = `${PC_ORIGIN}/api/stac/v1/search`;
const DATA_API_URL = `${PC_ORIGIN}/api/data/v1`;
export const S2_COLLECTION = 'sentinel-2-l2a';
export const SENTINEL2_ATTRIBUTION = 'Contains modified Copernicus Sentinel-2 data; imagery served by Microsoft Planetary Computer (Sentinel data licence).';
/** Bump when masking, offset or statistics change; it is part of the cache key. */
export const NDVI_METHOD_VERSION = 'ndvi-s2l2a-v1';
/**
 * Version of the index formulas, scaling and guards in `indexStats`, reported in NdviSeries.method. It is deliberately not
 * in the polygon hash (stored NDVI rows keep matching); rows whose stats lack `indices` are re-analysed instead. The stored
 * stats do not record this version, so a later formula change needs its own completeness marker.
 */
export const INDEX_METHOD_VERSION = 'indices-s2l2a-v1';

export const REQUEST_TIMEOUT_MS = 20_000;
const MAX_STAC_BYTES = 2 * 1024 * 1024;
/**
 * feature.npy cap. The largest read is a 25 km2 bbox. The output grid holds about 1 pixel per 100 m2 (measured: the 4.49 km2
 * neighbourhood of the 1 ha fixture is 208 x 215 = 44,720 pixels), so 25 km2 is about 250,000 pixels; 9 bands x 2 bytes is
 * about 4.5 MB (the 4-band read was about 2 MB). 8 MB still leaves about 1.8 times headroom, so the cap is unchanged.
 */
const MAX_NPY_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
/** Pixels per band; about four times the 25 km2 worst case (about 250,000), so it only stops malformed shapes. */
const MAX_ARRAY_PIXELS = 1_000_000;
export const MAX_BBOX_KM2 = 25;
export const ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** SCL kept: 4 vegetation, 5 not vegetated, 6 water, 7 unclassified. Dropped: 0 no data, 1 saturated/defective,
 * 2 dark area, 3 cloud shadow, 8/9 cloud medium/high probability, 10 thin cirrus, 11 snow/ice. */
export const SCL_KEEP: readonly number[] = [4, 5, 6, 7];
const SCL_KEEP_SET = new Set(SCL_KEEP);
const SCL_CLOUD_OR_SHADOW = new Set([3, 8, 9, 10]);
export const BASELINE_OFFSET_DN = 1000;
export const MIN_CLEAR_FRACTION = 0.6;
export const MIN_CLEAR_PIXELS = 8;
/** Raw B04 p95 at or below this is treated as an implausible (8-bit looking) scene. */
export const PLAUSIBLE_B04_P95_DN = 255;
/** n + r must exceed 0.02 reflectance (200 DN after offset) so near-zero denominators cannot explode NDVI. */
export const MIN_REFLECTANCE_SUM_DN = 200;
export const DEFAULT_MAX_SCENE_CLOUD_PCT = 80;
/**
 * Assets of every feature.npy read, in this fixed order; the response stacks them and appends the polygon mask, so
 * bandStack reads band j as FEATURE_ASSETS[j]. Changing the list or its order changes the layout.
 */
export const FEATURE_ASSETS = ['B02', 'B03', 'B04', 'B05', 'B08', 'B8A', 'B11', 'SCL'] as const;
export type FeatureAsset = (typeof FEATURE_ASSETS)[number];
const FEATURE_BAND_COUNT = FEATURE_ASSETS.length + 1;
/** B04, B08, SCL and mask: the request before 2026-11-01 and the two real fixtures. */
const LEGACY_BAND_COUNT = 4;
/**
 * Our guard, not from Huete et al. 2002: EVI's denominator (rho8 + 6 rho4 - 7.5 rho2 + 1) falls toward zero or below when
 * blue is bright (haze, cloud edges SCL missed). Such values have no physical meaning, so pixels with a denominator below
 * 0.1 are skipped instead of being clamped to +-2 and moving the mean. The 2026-10-27 reference capture spans 1.28 to 1.52.
 */
export const EVI_MIN_DENOMINATOR = 0.1;

export type Bbox = readonly [number, number, number, number];
export type LonLat = readonly [number, number];
export interface Unavailable { status: 'unavailable'; reason: string; transient: boolean }
export type ImageKind = 'visual' | 'ndvi';
export interface SceneSummary { id: string; datetime: string; cloudPct: number | null; baseline: string | null; tileId: string | null; platform: string | null }

/** The subset of fetch used here; `typeof fetch` is assignable. Tests inject a fake. */
export type Sentinel2Fetch = (url: string, init: {method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal: AbortSignal}) =>
  Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer'>>;
const defaultFetch: Sentinel2Fetch = (url, init) => globalThis.fetch(url, init);

/**
 * In-process memo of successful Planetary Computer reads made with the default fetch (2026-11-05 latency pass). A
 * band read is a pure function of (item, polygon, processing baseline) and Sentinel-2 L2A items do not change once
 * published, so every farm with the same outline (each demo visitor's farm) reuses one read instead of making about
 * 48 feature.npy requests (about 14 s) per new farm. The key is the request itself, so no farm, owner or stored row is
 * shared. Scene searches are reused for 10 minutes (staleness bound: a newly published scene appears within that).
 * Failures are never kept; injected fetches (tests) bypass the memo; every hit returns a deep copy.
 */
const BAND_MEMO_TTL_MS = 6 * 3600_000;
const SEARCH_MEMO_TTL_MS = 10 * 60_000;
const PROVIDER_MEMO_MAX = 2000;
const providerMemo = new Map<string, {at: number; ttl: number; value: Promise<unknown>}>();
async function memoProvider<T extends {status: string}>(key: string, ttl: number, fetchImpl: Sentinel2Fetch, run: () => Promise<T>): Promise<T> {
  if (fetchImpl !== defaultFetch) return run();
  const now = Date.now();
  const hit = providerMemo.get(key);
  if (hit && now - hit.at <= hit.ttl) return structuredClone(await (hit.value as Promise<T>));
  const value = run().then((r) => {
    if (r.status !== 'ok' && providerMemo.get(key)?.value === value) providerMemo.delete(key);
    return r;
  }, (e: unknown) => {
    if (providerMemo.get(key)?.value === value) providerMemo.delete(key);
    throw e;
  });
  providerMemo.delete(key);
  providerMemo.set(key, {at: now, ttl, value});
  while (providerMemo.size > PROVIDER_MEMO_MAX) providerMemo.delete(providerMemo.keys().next().value!);
  return structuredClone(await value);
}
/** Forget memoised provider reads (tests). */
export function clearSentinel2Memo(): void {
  providerMemo.clear();
}

const unavailable = (reason: string, transient = false): Unavailable => ({status: 'unavailable', reason, transient});

// ------------------------------------------------------------------ geometry (all coordinates leave rounded to 4 dp)

const E4 = 1e4;
export const round4 = (n: number) => Math.round(n * E4) / E4;
const floor4 = (n: number) => Math.floor(n * E4 + 1e-6) / E4;
const ceil4 = (n: number) => Math.ceil(n * E4 - 1e-6) / E4;
const M_PER_DEG = 111_320;
const fmt = (n: number) => n.toFixed(4);

/**
 * Rounds a ring to 4 decimals (about 11 m; a vertex may move up to about 5.5 m), drops repeated vertices and closes it.
 * Returns null when fewer than three distinct vertices remain or a coordinate is out of range.
 */
export function prepareRing(input: readonly (readonly number[])[]): LonLat[] | null {
  const out: LonLat[] = [];
  for (const p of input) {
    const lon = p[0], lat = p[1];
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) return null;
    const v: LonLat = [round4(lon), round4(lat)];
    const last = out.at(-1);
    if (!last || last[0] !== v[0] || last[1] !== v[1]) out.push(v);
  }
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  if (new Set(out.map((v) => `${v[0]},${v[1]}`)).size < 3 || out.length > 500) return null;
  return [...out, out[0]!];
}

export function ringBbox(ring: readonly LonLat[]): Bbox {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Equirectangular area estimate; adequate for a size gate at field scale. */
export function bboxAreaKm2(b: Bbox): number {
  const latMid = ((b[1] + b[3]) / 2) * Math.PI / 180;
  return ((b[2] - b[0]) * M_PER_DEG * Math.cos(latMid) / 1000) * ((b[3] - b[1]) * M_PER_DEG / 1000);
}

/** Null when acceptable, else a reason code. */
export function bboxProblem(b: Bbox): string | null {
  if (b.length !== 4 || !b.every(Number.isFinite)) return 'invalid_bbox';
  if (b[0] < -180 || b[2] > 180 || b[1] < -85 || b[3] > 85 || b[0] >= b[2] || b[1] >= b[3]) return 'invalid_bbox';
  if (bboxAreaKm2(b) > MAX_BBOX_KM2) return 'bbox_too_large';
  return null;
}

/** Bbox grown by `meters` on every side, rounded outward to 4 decimals. */
export function bufferBbox(b: Bbox, meters: number): Bbox {
  const latMid = ((b[1] + b[3]) / 2) * Math.PI / 180;
  const dLat = meters / M_PER_DEG, dLon = meters / (M_PER_DEG * Math.max(0.1, Math.cos(latMid)));
  return [floor4(b[0] - dLon), floor4(b[1] - dLat), ceil4(b[2] + dLon), ceil4(b[3] + dLat)];
}

/** Square display window around the field: at least 600 m across, or 1.6 times the field's larger side. */
export function displayBbox(ring: readonly LonLat[]): Bbox {
  const b = ringBbox(ring);
  const latMid = ((b[1] + b[3]) / 2) * Math.PI / 180, cos = Math.max(0.1, Math.cos(latMid));
  const widthM = (b[2] - b[0]) * M_PER_DEG * cos, heightM = (b[3] - b[1]) * M_PER_DEG;
  const halfM = Math.max(300, 0.8 * Math.max(widthM, heightM));
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return [floor4(cx - halfM / (M_PER_DEG * cos)), floor4(cy - halfM / M_PER_DEG), ceil4(cx + halfM / (M_PER_DEG * cos)), ceil4(cy + halfM / M_PER_DEG)];
}

/** Smallest field-zoom window: 120 m across (12 native 10 m pixels). */
export const FIELD_WINDOW_MIN_M = 120;
export const FIELD_WINDOW_FACTOR = 1.6;
export const NATIVE_PIXEL_M = 10;
/** Rendered image size limits: 12 px is the smallest field window (the Data API accepted 12x12 on 2026-11-02), 768 the cap. */
export const RENDER_SIZE_MIN = 12;
export const RENDER_SIZE_MAX = 768;

/** Metres across a bbox at its mid latitude: [east-west, north-south]. */
export function bboxMeters(b: Bbox): [number, number] {
  const cos = Math.max(0.1, Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180));
  return [(b[2] - b[0]) * M_PER_DEG * cos, (b[3] - b[1]) * M_PER_DEG];
}

/**
 * Field-zoom window: a square around the field centre with side 1.6 times the field's larger side, at least 120 m, edges rounded
 * outward to 4 decimals like `displayBbox` (so each side can exceed the ideal by up to one 4-decimal step, about 11 m).
 */
export function fieldBbox(ring: readonly LonLat[]): Bbox {
  const b = ringBbox(ring);
  const latMid = ((b[1] + b[3]) / 2) * Math.PI / 180, cos = Math.max(0.1, Math.cos(latMid));
  const widthM = (b[2] - b[0]) * M_PER_DEG * cos, heightM = (b[3] - b[1]) * M_PER_DEG;
  const halfM = Math.max(FIELD_WINDOW_MIN_M, FIELD_WINDOW_FACTOR * Math.max(widthM, heightM)) / 2;
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return [floor4(cx - halfM / (M_PER_DEG * cos)), floor4(cy - halfM / M_PER_DEG), ceil4(cx + halfM / (M_PER_DEG * cos)), ceil4(cy + halfM / M_PER_DEG)];
}

/**
 * Native render size for a field window: ceil(larger side in metres / 10), clamped 12..768, so one output pixel is one 10 m
 * Sentinel-2 pixel (or a little less; the same size is used both ways so the image stays square).
 */
export function fieldRenderSize(b: Bbox): number {
  const [w, h] = bboxMeters(b);
  return Math.max(RENDER_SIZE_MIN, Math.min(RENDER_SIZE_MAX, Math.ceil(Math.max(w, h) / NATIVE_PIXEL_M - 1e-9)));
}

const bboxRing = (b: Bbox): LonLat[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];

/** Square of `sideMeters` centred on a point (fallback when no boundary is drawn), rounded to 4 decimals. */
export function squareAround(lat: number, lon: number, sideMeters: number): LonLat[] | null {
  const half = sideMeters / 2, cos = Math.max(0.1, Math.cos(lat * Math.PI / 180));
  const dLat = half / M_PER_DEG, dLon = half / (M_PER_DEG * cos);
  return prepareRing([[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat]]);
}

// ------------------------------------------------------------------ radiometry

/** 1000 for processing baseline >= 04.00, 0 below; null when the baseline is missing or malformed. */
export function baselineOffset(baseline: string | null | undefined): number | null {
  const m = typeof baseline === 'string' ? /^(\d{1,2})\.(\d{2})$/.exec(baseline.trim()) : null;
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]) >= 400 ? BASELINE_OFFSET_DN : 0;
}

// ------------------------------------------------------------------ .npy parsing

export type NpyDtype = 'u1' | 'u2' | 'i2' | 'u4' | 'i4' | 'f4' | 'f8';
export type NpyData = Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
export interface NpyArray { dtype: NpyDtype; shape: number[]; data: NpyData }
const ITEM_SIZE: Record<NpyDtype, number> = {u1: 1, u2: 2, i2: 2, u4: 4, i4: 4, f4: 4, f8: 8};

/**
 * Parses a NumPy .npy buffer (format versions 1-3), C order, little-endian or single-byte dtypes only.
 * Throws on anything else, including a payload whose length does not match the header shape.
 */
export function parseNpy(buf: Uint8Array): NpyArray {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  if (buf.length < 10 || !magic.every((b, i) => buf[i] === b)) throw new Error('npy_bad_magic');
  const major = buf[6]!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let headerLen: number, headerStart: number;
  if (major === 1) { headerLen = view.getUint16(8, true); headerStart = 10; }
  else if (major === 2 || major === 3) { if (buf.length < 12) throw new Error('npy_truncated'); headerLen = view.getUint32(8, true); headerStart = 12; }
  else throw new Error('npy_unsupported_version');
  if (headerLen > 65_535 || headerStart + headerLen > buf.length) throw new Error('npy_truncated');
  const header = String.fromCharCode(...buf.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr'\s*:\s*'([<>|=])([uif])(\d+)'/.exec(header);
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header);
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descr || !fortran || !shapeMatch) throw new Error('npy_bad_header');
  if (fortran[1] !== 'False') throw new Error('npy_fortran_order_unsupported');
  const dtype = `${descr[2]}${descr[3]}` as NpyDtype;
  if (!(dtype in ITEM_SIZE)) throw new Error('npy_unsupported_dtype');
  const size = ITEM_SIZE[dtype];
  if (descr[1] === '>' || (descr[1] === '|' && size !== 1) || descr[1] === '=') throw new Error('npy_unsupported_byte_order');
  const shape = shapeMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!/^\d{1,9}$/.test(s)) throw new Error('npy_bad_shape');
    return Number(s);
  });
  const count = shape.reduce((a, b) => a * b, 1);
  const dataStart = headerStart + headerLen;
  if (!Number.isSafeInteger(count) || buf.length - dataStart !== count * size) throw new Error('npy_length_mismatch');
  const read: Record<NpyDtype, () => NpyData> = {
    u1: () => buf.slice(dataStart, dataStart + count),
    u2: () => { const a = new Uint16Array(count); for (let i = 0; i < count; i++) a[i] = view.getUint16(dataStart + i * 2, true); return a; },
    i2: () => { const a = new Int16Array(count); for (let i = 0; i < count; i++) a[i] = view.getInt16(dataStart + i * 2, true); return a; },
    u4: () => { const a = new Uint32Array(count); for (let i = 0; i < count; i++) a[i] = view.getUint32(dataStart + i * 4, true); return a; },
    i4: () => { const a = new Int32Array(count); for (let i = 0; i < count; i++) a[i] = view.getInt32(dataStart + i * 4, true); return a; },
    f4: () => { const a = new Float32Array(count); for (let i = 0; i < count; i++) a[i] = view.getFloat32(dataStart + i * 4, true); return a; },
    f8: () => { const a = new Float64Array(count); for (let i = 0; i < count; i++) a[i] = view.getFloat64(dataStart + i * 8, true); return a; },
  };
  return {dtype, shape, data: read[dtype]()};
}

// ------------------------------------------------------------------ statistics

/** Linear-interpolated percentile of an ascending array (NumPy's default method). */
export function percentile(sorted: ArrayLike<number>, p: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  const idx = p * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
const r4 = (n: number | null) => (n === null ? null : Math.round(n * E4) / E4);

/** Raw digital numbers per band over one grid. The legacy (4, H, W) layout carries no b02, b03, b05, b8a or b11. */
export interface BandArrays {
  b04: ArrayLike<number>; b08: ArrayLike<number>; scl: ArrayLike<number>; mask: ArrayLike<number>;
  b02?: ArrayLike<number>; b03?: ArrayLike<number>; b05?: ArrayLike<number>; b8a?: ArrayLike<number>; b11?: ArrayLike<number>;
}

/** The NDVI clear-pixel rule, shared by every index: SCL kept, raw B04 and B08 non-zero (zero is no data), corrected n + r above 200 DN. */
function isClear(rRaw: number, nRaw: number, cls: number, offset: number): boolean {
  return SCL_KEEP_SET.has(cls) && rRaw > 0 && nRaw > 0 && Math.max(rRaw - offset, 0) + Math.max(nRaw - offset, 0) > MIN_REFLECTANCE_SUM_DN;
}

/**
 * NDVI statistics over clear pixels. A pixel counts in totalPixels when the mask is set. It is clear when its SCL
 * class is kept, both raw bands are non-zero (zero is no data), and the offset-corrected n + r exceeds 200 DN.
 * Corrected DN = max(raw - offset, 0); NDVI = (n - r) / (n + r), clamped to [-1, 1]. `indices` holds the other
 * spectral indices over the same clear pixels (indexStats).
 */
export function ndviStats(bands: BandArrays, offset: number): NdviStats {
  const {b04, b08, scl, mask} = bands;
  const n = mask.length;
  const values: number[] = [];
  const insideB04: number[] = [];
  let total = 0, cloudOrShadow = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    total++;
    const rRaw = b04[i]!, nRaw = b08[i]!, cls = scl[i]!;
    if (rRaw > 0) insideB04.push(rRaw);
    if (SCL_CLOUD_OR_SHADOW.has(cls)) cloudOrShadow++;
    if (!isClear(rRaw, nRaw, cls, offset)) continue;
    const r = Math.max(rRaw - offset, 0), nir = Math.max(nRaw - offset, 0);
    values.push(Math.max(-1, Math.min(1, (nir - r) / (nir + r))));
  }
  values.sort((a, b) => a - b);
  insideB04.sort((a, b) => a - b);
  const clear = values.length;
  const clearFraction = total ? clear / total : 0;
  const b04P95 = percentile(insideB04, 0.95);
  const rejection: NdviStats['rejection'] = !total ? 'no_pixels'
    : b04P95 === null || b04P95 <= PLAUSIBLE_B04_P95_DN ? 'implausible_band_values'
    : clear < MIN_CLEAR_PIXELS ? 'insufficient_clear_pixels'
    : clearFraction < MIN_CLEAR_FRACTION ? 'low_clear_fraction' : null;
  return {
    mean: clear ? r4(values.reduce((s, v) => s + v, 0) / clear) : null,
    median: r4(percentile(values, 0.5)), p10: r4(percentile(values, 0.1)), p90: r4(percentile(values, 0.9)),
    clearPixels: clear, totalPixels: total, clearFraction: r4(clearFraction)!, cloudOrShadowFraction: total ? r4(cloudOrShadow / total)! : 0,
    b04P95: b04P95 === null ? null : Math.round(b04P95 * 10) / 10,
    usable: rejection === null, rejection,
    indices: indexStats(bands, offset),
  };
}

// ------------------------------------------------------------------ other spectral indices (docs/research/SENTINEL2_INDICES.md)

type SpectralBand = 'b02' | 'b03' | 'b04' | 'b05' | 'b08' | 'b8a' | 'b11';
const SPECTRAL_BANDS: readonly SpectralBand[] = ['b02', 'b03', 'b04', 'b05', 'b08', 'b8a', 'b11'];
const INDEX_ONLY_BANDS = ['b02', 'b03', 'b05', 'b8a', 'b11'] as const;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Normalised difference of two corrected digital numbers (the 1/10000 reflectance scale cancels, so the 200 DN guard is exact). */
const normDiff = (a: number, b: number) => (a + b <= MIN_REFLECTANCE_SUM_DN ? null : clamp((a - b) / (a + b), -1, 1));
/**
 * Formulas over corrected digital numbers (DN = max(raw - offset, 0); reflectance = DN / 10000), each needed band > 0 DN.
 * Null skips the pixel. EVI and SAVI carry additive constants, so they work in reflectance; EVI skips denominators below
 * EVI_MIN_DENOMINATOR and clamps the rest to [-2, 2]. SAVI's denominator is at least 0.5 by construction and |SAVI| < 1.5
 * analytically, so it has no guard and the clamp only states the bound.
 */
const INDEX_FORMULAS: Record<IndexId, {needs: readonly SpectralBand[]; value: (dn: Readonly<Record<SpectralBand, number>>) => number | null}> = {
  evi: {needs: ['b02', 'b04', 'b08'], value: (dn) => {
    const nir = dn.b08 / 1e4, red = dn.b04 / 1e4, blue = dn.b02 / 1e4, den = nir + 6 * red - 7.5 * blue + 1;
    return den < EVI_MIN_DENOMINATOR ? null : clamp((2.5 * (nir - red)) / den, -2, 2);
  }},
  ndre: {needs: ['b05', 'b08'], value: (dn) => normDiff(dn.b08, dn.b05)},
  gndvi: {needs: ['b03', 'b08'], value: (dn) => normDiff(dn.b08, dn.b03)},
  savi: {needs: ['b04', 'b08'], value: (dn) => {
    const nir = dn.b08 / 1e4, red = dn.b04 / 1e4;
    return clamp((1.5 * (nir - red)) / (nir + red + 0.5), -1.5, 1.5);
  }},
  ndmi: {needs: ['b08', 'b11'], value: (dn) => normDiff(dn.b08, dn.b11)},
  lswi: {needs: ['b8a', 'b11'], value: (dn) => normDiff(dn.b8a, dn.b11)},
  ndwi: {needs: ['b03', 'b08'], value: (dn) => normDiff(dn.b03, dn.b08)},
};

function summarise(values: number[]): IndexSummary {
  values.sort((a, b) => a - b);
  return {mean: values.length ? r4(values.reduce((s, v) => s + v, 0) / values.length) : null, median: r4(percentile(values, 0.5)), p10: r4(percentile(values, 0.1)), p90: r4(percentile(values, 0.9))};
}

/**
 * EVI, NDRE, GNDVI, SAVI, NDMI, LSWI and NDWI (McFeeters) over the NDVI clear pixels: same mask, SCL classes and 200 DN
 * rule. A clear pixel adds to an index only when every band that index needs is above 0 DN after the offset correction
 * (a band at or below the +1000 offset would otherwise force a normalised difference to exactly +-1) and the formula's guard
 * passes. Statistics are rounded to 4 decimals and null when no pixel qualified. On a stack without the index bands (the
 * legacy (4, H, W) layout) every index is null, SAVI included, so a reading carries the full set or none.
 */
export function indexStats(bands: BandArrays, offset: number): IndexSummaries {
  const n = bands.mask.length;
  if (!INDEX_ONLY_BANDS.every((k) => bands[k]?.length === n)) return Object.fromEntries(INDEX_IDS.map((id) => [id, null])) as IndexSummaries;
  const src = bands as Required<BandArrays>;
  const values = Object.fromEntries(INDEX_IDS.map((id) => [id, [] as number[]])) as Record<IndexId, number[]>;
  const dn = {} as Record<SpectralBand, number>;
  for (let i = 0; i < n; i++) {
    if (!src.mask[i] || !isClear(src.b04[i]!, src.b08[i]!, src.scl[i]!, offset)) continue;
    for (const k of SPECTRAL_BANDS) dn[k] = Math.max(src[k][i]! - offset, 0);
    for (const id of INDEX_IDS) {
      const f = INDEX_FORMULAS[id];
      // Corrected > 0 implies raw > 0, so raw no-data (0) is excluded too. NDVI keeps its own rule (raw > 0) unchanged.
      if (!f.needs.every((k) => dn[k] > 0)) continue;
      const v = f.value(dn);
      if (v !== null) values[id].push(v);
    }
  }
  return Object.fromEntries(INDEX_IDS.map((id) => [id, summarise(values[id])])) as IndexSummaries;
}

/**
 * Splits a feature.npy uint16 stack into named band views. Accepts the current (9, H, W) layout (FEATURE_ASSETS, then the
 * mask) and the legacy (4, H, W) layout (B04, B08, SCL, mask), which the real fixtures captured before 2026-11-01 use.
 */
export function bandStack(npy: NpyArray): BandArrays | null {
  const k = npy.shape[0];
  if (npy.dtype !== 'u2' || npy.shape.length !== 3 || (k !== LEGACY_BAND_COUNT && k !== FEATURE_BAND_COUNT)) return null;
  const px = npy.shape[1]! * npy.shape[2]!;
  if (px <= 0 || px > MAX_ARRAY_PIXELS) return null;
  const d = npy.data as Uint16Array, band = (j: number) => d.subarray(j * px, (j + 1) * px);
  if (k === LEGACY_BAND_COUNT) return {b04: band(0), b08: band(1), scl: band(2), mask: band(3)};
  const at = (a: FeatureAsset) => band(FEATURE_ASSETS.indexOf(a));
  return {b02: at('B02'), b03: at('B03'), b04: at('B04'), b05: at('B05'), b08: at('B08'), b8a: at('B8A'), b11: at('B11'), scl: at('SCL'), mask: band(FEATURE_ASSETS.length)};
}

// ------------------------------------------------------------------ HTTP helpers

async function boundedFetch(fetchImpl: Sentinel2Fetch, url: string, init: {method: 'GET' | 'POST'; body?: string; accept: string}, maxBytes: number): Promise<{bytes: Uint8Array; contentType: string} | Unavailable> {
  try {
    const res = await fetchImpl(url, {method: init.method, headers: {accept: init.accept, ...(init.body ? {'content-type': 'application/json'} : {})}, ...(init.body ? {body: init.body} : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
    if (res.status === 429) return unavailable('provider_rate_limited', true);
    if (res.status === 404) return unavailable('scene_not_found');
    if (res.status >= 500) return unavailable('provider_error', true);
    if (!res.ok) return unavailable('provider_rejected_request');
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return unavailable('response_too_large');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) return unavailable('response_too_large');
    return {bytes, contentType: res.headers.get('content-type') ?? ''};
  } catch (e) {
    const name = (e as {name?: string})?.name;
    return unavailable(name === 'TimeoutError' || name === 'AbortError' ? 'provider_timeout' : 'provider_unreachable', true);
  }
}
const isUnavailable = (v: unknown): v is Unavailable => typeof v === 'object' && v !== null && (v as Unavailable).status === 'unavailable';

// ------------------------------------------------------------------ STAC scene list

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const StacResponse = z.object({
  features: z.array(z.object({
    id: z.string(),
    properties: z.object({
      datetime: z.string(),
      'eo:cloud_cover': z.number().min(0).max(100).optional(),
      's2:processing_baseline': z.string().max(16).optional(),
      's2:mgrs_tile': z.string().max(16).optional(),
      platform: z.string().max(40).optional(),
    }),
  })).max(1000),
  links: z.array(z.object({rel: z.string()}).loose()).optional(),
});

export interface ListScenesInput { bbox: Bbox; from: string; to: string; fetchImpl?: Sentinel2Fetch | undefined; limit?: number | undefined; maxCloudPct?: number | undefined }
export type ListScenesResult = {status: 'ok'; scenes: SceneSummary[]; truncated: boolean; duplicatesSkipped: number} | Unavailable;

/**
 * Scenes intersecting the bbox between two calendar dates (UTC), newest first. A lenient scene-cloud filter is
 * applied only to skip fully overcast scenes; plot-level clarity is decided later by the SCL mask.
 * Identical acquisition times from overlapping MGRS tiles are reduced to one, preferring the most common tile.
 */
export async function listScenes(input: ListScenesInput): Promise<ListScenesResult> {
  const bbox: Bbox = [floor4(input.bbox[0]), floor4(input.bbox[1]), ceil4(input.bbox[2]), ceil4(input.bbox[3])];
  const problem = bboxProblem(bbox);
  if (problem) return unavailable(problem);
  if (!isoDay.test(input.from) || !isoDay.test(input.to) || input.from > input.to) return unavailable('invalid_window');
  const limit = Math.max(1, Math.min(250, Math.trunc(input.limit ?? 200)));
  const maxCloud = Math.max(1, Math.min(100, input.maxCloudPct ?? DEFAULT_MAX_SCENE_CLOUD_PCT));
  const body = JSON.stringify({
    collections: [S2_COLLECTION], bbox, datetime: `${input.from}T00:00:00Z/${input.to}T23:59:59Z`,
    ...(maxCloud < 100 ? {query: {'eo:cloud_cover': {lt: maxCloud}}} : {}),
    sortby: [{field: 'datetime', direction: 'desc'}], limit,
    fields: {include: ['id', 'properties.datetime', 'properties.eo:cloud_cover', 'properties.s2:processing_baseline', 'properties.s2:mgrs_tile', 'properties.platform'], exclude: ['assets', 'links', 'geometry', 'bbox']},
  });
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  return memoProvider(`search|${body}`, SEARCH_MEMO_TTL_MS, fetchImpl, () => searchScenes(body, limit, fetchImpl));
}

async function searchScenes(body: string, limit: number, fetchImpl: Sentinel2Fetch): Promise<ListScenesResult> {
  const res = await boundedFetch(fetchImpl, STAC_SEARCH_URL, {method: 'POST', body, accept: 'application/geo+json, application/json'}, MAX_STAC_BYTES);
  if (isUnavailable(res)) return res;
  let parsed: z.infer<typeof StacResponse>;
  try {
    const result = StacResponse.safeParse(JSON.parse(new TextDecoder().decode(res.bytes)));
    if (!result.success) return unavailable('invalid_provider_response');
    parsed = result.data;
  } catch { return unavailable('invalid_provider_response'); }
  const scenes: SceneSummary[] = [];
  for (const f of parsed.features) {
    const t = Date.parse(f.properties.datetime);
    if (!ITEM_ID_RE.test(f.id) || !Number.isFinite(t)) continue;
    scenes.push({id: f.id, datetime: new Date(t).toISOString(), cloudPct: f.properties['eo:cloud_cover'] ?? null, baseline: f.properties['s2:processing_baseline'] ?? null, tileId: f.properties['s2:mgrs_tile'] ?? null, platform: f.properties.platform ?? null});
  }
  const tileCounts = new Map<string, number>();
  for (const s of scenes) tileCounts.set(s.tileId ?? '', (tileCounts.get(s.tileId ?? '') ?? 0) + 1);
  const byTime = new Map<string, SceneSummary>();
  for (const s of scenes) {
    const prev = byTime.get(s.datetime);
    const better = !prev || (tileCounts.get(s.tileId ?? '')! > tileCounts.get(prev.tileId ?? '')!) || (tileCounts.get(s.tileId ?? '') === tileCounts.get(prev.tileId ?? '') && s.id < prev.id);
    if (better) byTime.set(s.datetime, s);
  }
  const unique = [...byTime.values()].sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : a.id.localeCompare(b.id)));
  return {status: 'ok', scenes: unique, truncated: !!parsed.links?.some((l) => l.rel === 'next') || parsed.features.length >= limit, duplicatesSkipped: scenes.length - unique.length};
}

// ------------------------------------------------------------------ band reads

export type BandsResult = {status: 'ok'; stats: NdviStats; offset: number; shape: [number, number]; bbox: Bbox} | Unavailable;

function featureBands(itemId: string, ring: readonly LonLat[], baseline: string | null, fetchImpl: Sentinel2Fetch): Promise<BandsResult> {
  return memoProvider(`bands|${itemId}|${baseline}|${JSON.stringify(ring)}`, BAND_MEMO_TTL_MS, fetchImpl, () => readFeatureBands(itemId, ring, baseline, fetchImpl));
}

async function readFeatureBands(itemId: string, ring: readonly LonLat[], baseline: string | null, fetchImpl: Sentinel2Fetch): Promise<BandsResult> {
  if (!ITEM_ID_RE.test(itemId)) return unavailable('invalid_item_id');
  const offset = baselineOffset(baseline);
  if (offset === null) return unavailable('processing_baseline_unknown');
  const bbox = ringBbox(ring);
  const problem = bboxProblem(bbox);
  if (problem) return unavailable(problem);
  const params = new URLSearchParams([['collection', S2_COLLECTION], ['item', itemId], ...FEATURE_ASSETS.map((a): [string, string] => ['assets', a]), ['asset_as_band', 'true']]);
  const feature = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [ring.map((p) => [round4(p[0]), round4(p[1])])]}};
  const res = await boundedFetch(fetchImpl, `${DATA_API_URL}/item/feature.npy?${params}`, {method: 'POST', body: JSON.stringify(feature), accept: 'application/x-binary, application/octet-stream'}, MAX_NPY_BYTES);
  if (isUnavailable(res)) return res;
  let stack: BandArrays | null, shape: [number, number];
  try {
    const npy = parseNpy(res.bytes);
    // Only the layout this request asked for: a (4, H, W) answer here would put B02 where B04 is expected.
    stack = npy.shape[0] === FEATURE_BAND_COUNT ? bandStack(npy) : null;
    shape = [npy.shape[1] ?? 0, npy.shape[2] ?? 0];
  } catch { return unavailable('invalid_provider_response'); }
  if (!stack) return unavailable('unexpected_band_layout');
  return {status: 'ok', stats: ndviStats(stack, offset), offset, shape, bbox};
}

export interface PolygonBandsInput { itemId: string; polygon: readonly (readonly number[])[]; baseline: string | null; fetchImpl?: Sentinel2Fetch | undefined }

/** Field statistics: FEATURE_ASSETS and the polygon mask from `item/feature.npy` on the 10 m grid (20 m bands resampled). */
export async function polygonBands(input: PolygonBandsInput): Promise<BandsResult> {
  const ring = prepareRing(input.polygon);
  if (!ring) return unavailable('polygon_degenerate');
  return featureBands(input.itemId, ring, input.baseline, input.fetchImpl ?? defaultFetch);
}

/** Same statistics over the polygon's bbox buffered by `bufferMeters` (default 1 km); field pixels stay included. */
export async function neighbourhoodBands(input: PolygonBandsInput & {bufferMeters?: number | undefined}): Promise<BandsResult> {
  const ring = prepareRing(input.polygon);
  if (!ring) return unavailable('polygon_degenerate');
  const bbox = bufferBbox(ringBbox(ring), input.bufferMeters ?? 1000);
  if (bboxProblem(bbox) === 'bbox_too_large') return unavailable('neighbourhood_too_large');
  return featureBands(input.itemId, bboxRing(bbox), input.baseline, input.fetchImpl ?? defaultFetch);
}

// ------------------------------------------------------------------ rendered images (display only; values come from bands)

export interface RenderSceneInput { itemId: string; bbox: Bbox; kind: ImageKind; baseline?: string | null | undefined; fetchImpl?: Sentinel2Fetch | undefined; size?: number | undefined }
export type RenderSceneResult = {status: 'ok'; bytes: Buffer; contentType: 'image/png'; bbox: Bbox} | Unavailable;

/**
 * PNG from the Data API bbox endpoint. `visual` is the true-colour TCI asset. `ndvi` is an offset-aware server
 * expression with rescale -0.2..0.9 and the rdylgn colormap; colours are for display and never read back as values.
 */
export async function renderScene(input: RenderSceneInput): Promise<RenderSceneResult> {
  if (!ITEM_ID_RE.test(input.itemId)) return unavailable('invalid_item_id');
  if (input.kind !== 'visual' && input.kind !== 'ndvi') return unavailable('invalid_image_kind');
  const bbox: Bbox = [floor4(input.bbox[0]), floor4(input.bbox[1]), ceil4(input.bbox[2]), ceil4(input.bbox[3])];
  const problem = bboxProblem(bbox);
  if (problem) return unavailable(problem);
  const size = Math.max(RENDER_SIZE_MIN, Math.min(RENDER_SIZE_MAX, Math.trunc(input.size ?? 512)));
  const params = new URLSearchParams([['collection', S2_COLLECTION], ['item', input.itemId]]);
  if (input.kind === 'visual') {
    params.append('assets', 'visual'); params.append('asset_bidx', 'visual|1,2,3');
  } else {
    const offset = baselineOffset(input.baseline);
    if (offset === null) return unavailable('processing_baseline_unknown');
    params.append('assets', 'B04'); params.append('assets', 'B08'); params.append('asset_as_band', 'true');
    params.append('expression', offset ? `(B08-B04)/(B08+B04-${2 * offset})` : '(B08-B04)/(B08+B04)');
    params.append('rescale', '-0.2,0.9'); params.append('colormap_name', 'rdylgn');
  }
  // `resampling` is a documented Data API parameter (RasterIO algorithm, default nearest): stated so a native-size field render
  // keeps hard 10 m pixel edges even if the service default changes. The wide render is a downscale, where nearest is also fine.
  params.append('resampling', 'nearest');
  params.append('nodata', '0'); params.append('coord_crs', 'EPSG:4326'); params.append('dst_crs', 'EPSG:4326');
  const url = `${DATA_API_URL}/item/bbox/${bbox.map(fmt).join(',')}/${size}x${size}.png?${params}`;
  const res = await boundedFetch(input.fetchImpl ?? defaultFetch, url, {method: 'GET', accept: 'image/png'}, MAX_PNG_BYTES);
  if (isUnavailable(res)) return res;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!res.contentType.startsWith('image/png') || !png.every((b, i) => res.bytes[i] === b)) return unavailable('invalid_provider_response');
  return {status: 'ok', bytes: Buffer.from(res.bytes), contentType: 'image/png', bbox};
}
