/**
 * Shared polygon and transform maths for the photo-region editor.
 *
 * Coordinate frames:
 *  - normalized: 0..1 in x and y of the orientation-corrected, normalized derivative image
 *    (the frame PUT /media/:id/region stores);
 *  - container: CSS pixels inside the stage element that shows the image with object-fit: contain
 *    (letterboxed on one axis when aspect ratios differ);
 *  - client: viewport CSS pixels (pointer events).
 * Device pixel ratio never enters the mapping (pointer events and layout are CSS pixels); it only matters when
 * snapping drawn strokes to device pixels, see snapToDevice.
 */

export type Pt = [number, number];
export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** Where the image content sits inside its container, in container CSS pixels. */
export interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_POINTS = 3;
export const MAX_POINTS = 64;
/** Smallest polygon area (fraction of the image) accepted as a region; the server's floor is 1e-6. */
export const MIN_AREA = 0.001;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Rectangle that object-fit: contain gives an image of `image` size inside `container`. */
export function containBox(container: Size, image: Size): ContentBox {
  if (container.w <= 0 || container.h <= 0 || image.w <= 0 || image.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const k = Math.min(container.w / image.w, container.h / image.h);
  const w = image.w * k;
  const h = image.h * k;
  return { x: (container.w - w) / 2, y: (container.h - h) / 2, w, h };
}

export function normalizedToContainer(p: Pt, box: ContentBox): Pt {
  return [box.x + p[0] * box.w, box.y + p[1] * box.h];
}

export function containerToNormalized(p: Pt, box: ContentBox, clamp = false): Pt | null {
  if (box.w <= 0 || box.h <= 0) return null;
  const nx = (p[0] - box.x) / box.w;
  const ny = (p[1] - box.y) / box.h;
  if (!clamp && (nx < 0 || nx > 1 || ny < 0 || ny > 1)) return null;
  return [clamp01(nx), clamp01(ny)];
}

/** Pointer position (viewport CSS px) -> normalized, given the stage's bounding rect. null = in the letterbox margin. */
export function clientToNormalized(client: Pt, stage: Rect, image: Size, clamp = false): Pt | null {
  const box = containBox({ w: stage.width, h: stage.height }, image);
  return containerToNormalized([client[0] - stage.left, client[1] - stage.top], box, clamp);
}

export function normalizedToClient(p: Pt, stage: Rect, image: Size): Pt {
  const box = containBox({ w: stage.width, h: stage.height }, image);
  const [x, y] = normalizedToContainer(p, box);
  return [stage.left + x, stage.top + y];
}

/** Rounds a CSS-pixel coordinate to a whole device pixel so 1px strokes stay crisp on high-DPI screens. */
export const snapToDevice = (css: number, dpr: number): number => Math.round(css * dpr) / dpr;

/** True when two sizes have the same aspect ratio within `tol` (relative). Used to detect rotated/cropped images. */
export function sameAspect(a: Size, b: Size, tol = 0.01): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  return Math.abs(a.w / a.h / (b.w / b.h) - 1) <= tol;
}

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function orient(a: Pt, b: Pt, c: Pt): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : -1;
}
const onSeg = (a: Pt, b: Pt, c: Pt) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
}

/** True if any two non-adjacent edges of the closed polygon touch or cross. */
export function selfIntersects(p: Pt[]): boolean {
  const n = p.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(p[i]!, p[(i + 1) % n]!, p[j]!, p[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

export type PolygonProblem = "too_few_points" | "too_many_points" | "out_of_range" | "no_area" | "self_intersecting";

export const PROBLEM_TEXT: Record<PolygonProblem, string> = {
  too_few_points: "Add at least 3 points to outline the planting area.",
  too_many_points: "An outline can have at most 64 points. Remove some points.",
  out_of_range: "A point is outside the photo.",
  no_area: "The outline is too small or flat. Spread the points apart.",
  self_intersecting: "The outline crosses itself. Move a point so the edges do not cross.",
};

export function validatePolygon(p: Pt[]): { ok: boolean; problems: PolygonProblem[] } {
  const problems: PolygonProblem[] = [];
  if (p.length < MIN_POINTS) problems.push("too_few_points");
  if (p.length > MAX_POINTS) problems.push("too_many_points");
  if (p.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)) problems.push("out_of_range");
  if (p.length >= MIN_POINTS && !problems.includes("out_of_range")) {
    if (selfIntersects(p)) problems.push("self_intersecting");
    else if (polygonArea(p) < MIN_AREA) problems.push("no_area");
  }
  return { ok: problems.length === 0, problems };
}

export type MoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
export const KEY_STEP = 0.01;
export const KEY_STEP_FINE = 0.002;

/** Keyboard move of one handle, clamped to the image. Returns a new array, or null for an invalid index. */
export function moveHandle(p: Pt[], index: number, key: MoveKey, fine = false): Pt[] | null {
  const cur = p[index];
  if (!cur) return null;
  const s = fine ? KEY_STEP_FINE : KEY_STEP;
  const [x, y] = cur;
  const next: Pt = key === "ArrowLeft" ? [x - s, y] : key === "ArrowRight" ? [x + s, y] : key === "ArrowUp" ? [x, y - s] : [x, y + s];
  const out = p.slice();
  out[index] = [round6(clamp01(next[0])), round6(clamp01(next[1]))];
  return out;
}

export const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Keyboard "Enter": adds a point at the image centre (nudged if a point already sits there). Null when full. */
export function addCentrePoint(p: Pt[]): Pt[] | null {
  if (p.length >= MAX_POINTS) return null;
  let c: Pt = [0.5, 0.5];
  while (p.some((q) => Math.abs(q[0] - c[0]) < 0.005 && Math.abs(q[1] - c[1]) < 0.005) && c[0] < 0.95) c = [c[0] + 0.03, c[1] + 0.03];
  return [...p, c];
}

export function addPoint(p: Pt[], pt: Pt): Pt[] | null {
  if (p.length >= MAX_POINTS) return null;
  return [...p, [round6(clamp01(pt[0])), round6(clamp01(pt[1]))]];
}

/** Four-corners quick mode: an inset rectangle whose corners the farmer then drags. Clockwise from top-left. */
export function cornersRectangle(inset = 0.12): Pt[] {
  return [
    [inset, inset],
    [1 - inset, inset],
    [1 - inset, 1 - inset],
    [inset, 1 - inset],
  ];
}

export function removePoint(p: Pt[], index: number): Pt[] {
  return p.filter((_, i) => i !== index);
}
