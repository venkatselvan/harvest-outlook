import type { Pt } from "./raster";

export const MIN_AREA_FRACTION = 0.02;
export const MAX_AREA_FRACTION = 0.98;

export type GateReason = "empty_mask" | "too_small" | "too_large" | "degenerate_polygon";

export interface GateInput {
  polygon: Pt[] | null;
  /** Fraction of the image covered by the (largest component of the) mask or box. */
  areaFraction: number;
}

export function polygonAreaFraction(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Rejects empty masks, masks under 2% or over 98% of the image, and polygons under 3 points or without area. */
export function qualityGate(g: GateInput): { ok: true } | { ok: false; reason: GateReason } {
  if (!g.polygon || g.areaFraction <= 0) return { ok: false, reason: "empty_mask" };
  if (g.areaFraction < MIN_AREA_FRACTION) return { ok: false, reason: "too_small" };
  if (g.areaFraction > MAX_AREA_FRACTION) return { ok: false, reason: "too_large" };
  if (g.polygon.length < 3 || polygonAreaFraction(g.polygon) < 1e-4) return { ok: false, reason: "degenerate_polygon" };
  return { ok: true };
}
