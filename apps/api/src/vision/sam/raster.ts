export type Pt = [number, number];

export interface RasterPolygon {
  /** Corner coordinates in raster space: x in 0..W, y in 0..H (pixel edges, not centres). */
  polygon: Pt[];
  componentPixels: number;
  foregroundPixels: number;
  /** componentPixels / (W*H) */
  areaFraction: number;
}

/** Largest 8-connected foreground component as a membership mask; null when the raster is empty. */
export function largestComponent(bits: Uint8Array, W: number, H: number): { mask: Uint8Array; size: number; foreground: number } | null {
  const label = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  let foreground = 0;
  for (let s = 0; s < bits.length; s++) {
    if (!bits[s]) continue;
    foreground++;
    if (label[s]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = next;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W || (dx === 0 && dy === 0)) continue;
          const q = ny * W + nx;
          if (bits[q] && !label[q]) {
            label[q] = next;
            queue[tail++] = q;
          }
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = next;
    }
  }
  if (!best) return null;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === best ? 1 : 0;
  return { mask, size: bestSize, foreground };
}

/**
 * Outer boundary of a binary component by following pixel edges (crack following), interior on the right,
 * so the polygon sits exactly on pixel edges (a 20x20 block yields its four corners). At a pinch vertex
 * (two outgoing edges) the left turn is taken so diagonally touching pixels stay in one outline.
 */
export function traceOuterBoundary(mask: Uint8Array, W: number, H: number): Pt[] {
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const stride = W + 1;
  // Directed edges: key = start vertex index; value = list of end vertices.
  const out = new Map<number, number[]>();
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const k = y1 * stride + x1;
    const arr = out.get(k);
    const e = y2 * stride + x2;
    if (arr) arr.push(e);
    else out.set(k, [e]);
  };
  let sx = -1;
  let sy = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!fg(x, y)) continue;
      if (sx < 0) {
        sx = x;
        sy = y;
      }
      if (!fg(x, y - 1)) add(x, y, x + 1, y); // top, heading east
      if (!fg(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right, heading south
      if (!fg(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom, heading west
      if (!fg(x - 1, y)) add(x, y + 1, x, y); // left, heading north
    }
  }
  if (sx < 0) return [];
  const startV = sy * stride + sx;
  const loop: number[] = [startV];
  let prev = startV;
  let cur = out.get(startV)![0]!;
  let steps = 0;
  const maxSteps = (W + 1) * (H + 1) * 2 + 8;
  while (cur !== startV && steps++ < maxSteps) {
    loop.push(cur);
    const cands = out.get(cur);
    if (!cands || cands.length === 0) break;
    let nextV = cands[0]!;
    if (cands.length > 1) {
      const dx = (cur % stride) - (prev % stride);
      const dy = Math.floor(cur / stride) - Math.floor(prev / stride);
      let bestCross = Infinity;
      for (const c of cands) {
        const nx = (c % stride) - (cur % stride);
        const ny = Math.floor(c / stride) - Math.floor(cur / stride);
        const cross = dx * ny - dy * nx; // y-down image coordinates: negative = left turn
        if (cross < bestCross) {
          bestCross = cross;
          nextV = c;
        }
      }
    }
    prev = cur;
    cur = nextV;
  }
  return loop.map((v) => [v % stride, Math.floor(v / stride)] as Pt);
}

/** Drops vertices lying on a straight segment between neighbours (and exact duplicates). */
export function dropCollinear(p: Pt[]): Pt[] {
  let pts = p;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const keep: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross === 0) changed = true;
      else keep.push(b);
    }
    pts = keep;
  }
  return pts;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdpOpen(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  let idx = -1;
  let dmax = 0;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i]!, a, b);
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  if (dmax <= eps || idx < 0) return [a, b];
  const l = rdpOpen(pts.slice(0, idx + 1), eps);
  const r = rdpOpen(pts.slice(idx), eps);
  return [...l.slice(0, -1), ...r];
}

/** Ramer-Douglas-Peucker for a closed ring: split at the vertex farthest from vertex 0, simplify both halves. */
export function rdpClosed(ring: Pt[], eps: number): Pt[] {
  if (ring.length <= 3) return ring;
  let far = 0;
  let dmax = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
    if (d > dmax) {
      dmax = d;
      far = i;
    }
  }
  const h1 = rdpOpen(ring.slice(0, far + 1), eps);
  const h2 = rdpOpen([...ring.slice(far), ring[0]!], eps);
  return [...h1.slice(0, -1), ...h2.slice(0, -1)];
}

/** Simplify to at most maxPoints by growing the tolerance geometrically. */
export function simplifyRing(ring: Pt[], maxPoints: number, startEps: number): Pt[] {
  let pts = dropCollinear(ring);
  let eps = startEps;
  for (let i = 0; i < 40 && (pts.length > maxPoints || i === 0); i++) {
    const s = dropCollinear(rdpClosed(pts, eps));
    if (s.length >= 3 || i > 0) pts = s.length >= 3 ? s : pts;
    if (pts.length <= maxPoints) break;
    eps *= 1.4;
  }
  return pts;
}

/** Threshold-free (bits already binary): largest component, outer boundary, RDP to <= maxPoints. */
export function maskToPolygon(bits: Uint8Array, W: number, H: number, maxPoints = 64): RasterPolygon | null {
  const comp = largestComponent(bits, W, H);
  if (!comp) return null;
  const ring = traceOuterBoundary(comp.mask, W, H);
  const eps = Math.max(0.5, 0.004 * Math.hypot(W, H));
  const polygon = simplifyRing(ring, maxPoints, eps);
  return { polygon, componentPixels: comp.size, foregroundPixels: comp.foreground, areaFraction: comp.size / (W * H) };
}
