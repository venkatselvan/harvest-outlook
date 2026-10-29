import sharp, { type Metadata } from "sharp";

/**
 * Deterministic, code-owned scene QA for generated keyframes (PRD 8.3: "if an edit alters the background,
 * do not conceal the discrepancy"). Thresholds are engineering heuristics, NOT validated on real provider
 * output; they exist so a clearly wrong scene is flagged and a no-op edit is noticed.
 */

export const QA_VERSION = "scene-qa-1";
export const QA_GRID_WIDTH = 128;
/** Mean absolute grayscale difference (0..1) allowed outside the region. */
export const OUTSIDE_DIFF_MAX = 0.08;
/** Mean absolute grayscale difference (0..1) the region must show, else nothing visibly changed. */
export const INSIDE_DIFF_MIN = 0.03;
/** Max relative difference between output and base aspect ratios. */
export const ASPECT_TOLERANCE = 0.02;
/** Pixels (on the analysis grid) around the polygon edge ignored for the outside check, since edits bleed at the boundary. */
export const BOUNDARY_MARGIN_PX = 3;
/** Outside check is skipped (not failed) when less than this fraction of the image is outside the region. */
export const MIN_OUTSIDE_FRACTION = 0.05;

export type QaReason = "output_undecodable" | "aspect_mismatch" | "scene_changed_outside_region" | "region_unchanged";

export interface QaResult {
  version: string;
  passed: boolean;
  reasons: QaReason[];
  scores: {
    outsideMeanAbsDiff: number | null;
    insideMeanAbsDiff: number | null;
    aspectError: number | null;
    outsideFraction: number | null;
    outputWidth: number | null;
    outputHeight: number | null;
  };
  thresholds: { outsideMax: number; insideMin: number; aspectTolerance: number; grid: string };
}

type Pt = [number, number];

/** Even-odd point-in-polygon on normalized coordinates. */
export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rasterises the polygon on a w x h grid (pixel centres). Returns 1 inside, 0 outside. */
export function rasterizePolygon(poly: Pt[], w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = pointInPolygon((x + 0.5) / w, (y + 0.5) / h, poly) ? 1 : 0;
  return m;
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && mask[yy * w + xx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  return out;
}

async function gray(buf: Buffer, w: number, h: number): Promise<Uint8Array> {
  const { data } = await sharp(buf).removeAlpha().resize({ width: w, height: h, fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

export async function evaluateScene(input: { base: Buffer; output: Buffer; polygon: Pt[] }): Promise<QaResult> {
  const thresholds = { outsideMax: OUTSIDE_DIFF_MAX, insideMin: INSIDE_DIFF_MIN, aspectTolerance: ASPECT_TOLERANCE, grid: `${QA_GRID_WIDTH}px wide, grayscale` };
  const empty = { outsideMeanAbsDiff: null, insideMeanAbsDiff: null, aspectError: null, outsideFraction: null, outputWidth: null, outputHeight: null };
  let outMeta: Metadata;
  let baseMeta: Metadata;
  try {
    outMeta = await sharp(input.output, { failOn: "error" }).metadata();
    await sharp(input.output, { failOn: "error" }).stats(); // forces a full decode
    baseMeta = await sharp(input.base).metadata();
  } catch {
    return { version: QA_VERSION, passed: false, reasons: ["output_undecodable"], scores: empty, thresholds };
  }
  if (!outMeta.width || !outMeta.height || !baseMeta.width || !baseMeta.height) {
    return { version: QA_VERSION, passed: false, reasons: ["output_undecodable"], scores: empty, thresholds };
  }
  const baseAspect = baseMeta.width / baseMeta.height;
  const aspectError = Math.abs(outMeta.width / outMeta.height - baseAspect) / baseAspect;
  const scores = { ...empty, aspectError, outputWidth: outMeta.width, outputHeight: outMeta.height };
  if (aspectError > ASPECT_TOLERANCE) return { version: QA_VERSION, passed: false, reasons: ["aspect_mismatch"], scores, thresholds };

  const w = QA_GRID_WIDTH;
  const h = Math.max(1, Math.round(w / baseAspect));
  const [a, b] = await Promise.all([gray(input.base, w, h), gray(input.output, w, h)]);
  const inMask = rasterizePolygon(input.polygon, w, h);
  const guard = dilate(inMask, w, h, BOUNDARY_MARGIN_PX);
  let inSum = 0;
  let inN = 0;
  let outSum = 0;
  let outN = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!) / 255;
    if (inMask[i]) {
      inSum += d;
      inN++;
    } else if (!guard[i]) {
      outSum += d;
      outN++;
    }
  }
  const outsideFraction = outN / a.length;
  const reasons: QaReason[] = [];
  const inside = inN > 0 ? inSum / inN : null;
  const outside = outsideFraction >= MIN_OUTSIDE_FRACTION && outN > 0 ? outSum / outN : null;
  if (outside !== null && outside > OUTSIDE_DIFF_MAX) reasons.push("scene_changed_outside_region");
  if (inside !== null && inside < INSIDE_DIFF_MIN) reasons.push("region_unchanged");
  return {
    version: QA_VERSION,
    passed: reasons.length === 0,
    reasons,
    scores: { ...scores, outsideMeanAbsDiff: outside, insideMeanAbsDiff: inside, outsideFraction },
    thresholds,
  };
}
