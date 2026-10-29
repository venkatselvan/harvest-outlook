export type Pt = [number, number];
export interface Size {
  w: number;
  h: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas backing-store geometry. All boxes are in DEVICE pixels. */
export interface SceneLayout {
  cssW: number;
  cssH: number;
  dpr: number;
  canvasW: number;
  canvasH: number;
  /** Where the base photo (object-fit: contain) sits on the canvas, in device pixels. */
  box: Box;
}

/** Backing-store dpr is capped so a 3x phone does not allocate an oversized canvas. */
export const MAX_DPR = 3;

export function computeSceneLayout(container: Size, image: Size, dpr: number): SceneLayout {
  const d = Math.min(MAX_DPR, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  const cssW = Math.max(0, container.w);
  const cssH = Math.max(0, container.h);
  const canvasW = Math.round(cssW * d);
  const canvasH = Math.round(cssH * d);
  if (canvasW <= 0 || canvasH <= 0 || image.w <= 0 || image.h <= 0) return { cssW, cssH, dpr: d, canvasW, canvasH, box: { x: 0, y: 0, w: 0, h: 0 } };
  const k = Math.min(canvasW / image.w, canvasH / image.h);
  const w = image.w * k;
  const h = image.h * k;
  return { cssW, cssH, dpr: d, canvasW, canvasH, box: { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h } };
}

/** Normalized (0..1, orientation-corrected normalized photo) polygon -> canvas device pixels, honouring letterboxing. */
export function polygonToCanvas(polygon: readonly Pt[], box: Box): Pt[] {
  return polygon.map(([x, y]) => [box.x + x * box.w, box.y + y * box.h] as Pt);
}

export function bounds(pts: readonly Pt[]): Box {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
