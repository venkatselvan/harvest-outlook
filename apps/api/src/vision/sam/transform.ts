import type { Pt } from "./raster";
import type { SamBox, RawMask } from "./parser";
import { SamParseError } from "./parser";

/**
 * Geometry relationships (all explicit so they can be tested):
 *   normalized derivative (what the user sees; the frame PUT /media/:id/region uses; 0..1)
 *     -> derivative pixels (nW x nH)
 *     -> sent image pixels (sentW x sentH, scaleX = sentW/nW, scaleY = sentH/nH)
 *     -> mask raster pixels (W x H) covering the whole sent image
 */
export interface SentImagePlan {
  /** Normalized derivative size. */
  sourceWidth: number;
  sourceHeight: number;
  /** Size sent to SAM. */
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

export function planSentImage(sourceWidth: number, sourceHeight: number, maxSide: number): SentImagePlan {
  const k = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * k));
  const height = Math.max(1, Math.round(sourceHeight * k));
  return { sourceWidth, sourceHeight, width, height, scaleX: width / sourceWidth, scaleY: height / sourceHeight };
}

export function sentPxToNormalized(p: Pt, plan: SentImagePlan): Pt {
  // sent px -> derivative px -> normalized
  const dx = p[0] / plan.scaleX;
  const dy = p[1] / plan.scaleY;
  return [clamp01(dx / plan.sourceWidth), clamp01(dy / plan.sourceHeight)];
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Raster corner coordinates -> normalized. Mask must cover the whole sent image (x=y=0) with matching aspect. */
export function rasterToNormalized(polygon: Pt[], raster: { width: number; height: number }, mask: Pick<RawMask, "x" | "y">, plan: SentImagePlan): Pt[] {
  if (mask.x !== 0 || mask.y !== 0) throw new SamParseError("mask_geometry_unsupported", "mask offset other than 0,0 is not supported");
  const ar = raster.width / raster.height;
  const sar = plan.width / plan.height;
  if (Math.abs(ar / sar - 1) > 0.03) throw new SamParseError("mask_geometry_unsupported", "mask aspect ratio does not match the image sent");
  const sx = plan.width / raster.width;
  const sy = plan.height / raster.height;
  return polygon.map(([rx, ry]) => sentPxToNormalized([rx * sx, ry * sy], plan));
}

/** Box (inclusive x2/y2 in sent pixels) -> rectangle in normalized coordinates. */
export function boxToNormalizedPolygon(b: SamBox, plan: SentImagePlan): Pt[] {
  const c: Pt[] = [
    [b.x1, b.y1],
    [b.x2 + 1, b.y1],
    [b.x2 + 1, b.y2 + 1],
    [b.x1, b.y2 + 1],
  ];
  return c.map((p) => sentPxToNormalized([p[0] * (plan.width / b.w), p[1] * (plan.height / b.h)], plan));
}

export function round6(p: Pt[]): Pt[] {
  return p.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as Pt);
}
