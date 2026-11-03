import { z } from 'zod';

const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
type Position = z.infer<typeof position>;
const cross = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Position, b: Position, p: Position) => cross(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function intersects(a: Position, b: Position, c: Position, d: Position): boolean {
  const x = cross(a, b, c), y = cross(a, b, d), u = cross(c, d, a), v = cross(c, d, b);
  return (x * y < 0 && u * v < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

// ------------------------------------------------------------------ field geometry (fields inside a farm, 2026-11-03)

/**
 * Planar tolerance for the field checks below, in degrees (about 1.1 cm). A vertex within this distance of an edge counts
 * as on that edge, so strips clipped from the farm polygon pass even though their cut vertices are computed in floating
 * point (round them to 7 or more decimals). Design choice, not a survey accuracy.
 */
export const FIELD_GEOMETRY_TOLERANCE_DEG = 1e-7;
/** Inward probe distance used by ringsOverlap to tell a shared edge (interiors on opposite sides) from a doubled one, in degrees (about 11 cm). */
const PROBE_DEG = 1e-6;
type Pt = readonly [number, number];
/** The ring's distinct vertices: a closed GeoJSON ring loses its repeated last vertex. */
const openRing = (ring: readonly Pt[]): Pt[] => (ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : [...ring]);
const edgesOf = (r: readonly Pt[]): [Pt, Pt][] => r.map((p, i) => [p, r[(i + 1) % r.length]!]);
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const onRingEdge = (p: Pt, r: readonly Pt[]) => edgesOf(r).some(([a, b]) => segmentDistance(p, a, b) <= FIELD_GEOMETRY_TOLERANCE_DEG);
/** Two segments cross at a single interior point of both; touching, a shared endpoint or a collinear overlap is not a crossing. */
function properlyCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const tol = FIELD_GEOMETRY_TOLERANCE_DEG;
  if (segmentDistance(c, a, b) <= tol || segmentDistance(d, a, b) <= tol || segmentDistance(a, c, d) <= tol || segmentDistance(b, c, d) <= tol) return false;
  const x = cross(a as Position, b as Position, c as Position), y = cross(a as Position, b as Position, d as Position);
  const u = cross(c as Position, d as Position, a as Position), v = cross(c as Position, d as Position, b as Position);
  return x * y < 0 && u * v < 0;
}
const bboxOf = (r: readonly Pt[]) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))] as const;
const bboxesTouch = (a: readonly Pt[], b: readonly Pt[]) => {
  const p = bboxOf(a), q = bboxOf(b), t = FIELD_GEOMETRY_TOLERANCE_DEG;
  return p[0] <= q[2] + t && q[0] <= p[2] + t && p[1] <= q[3] + t && q[1] <= p[3] + t;
};
/** Sub-segments of edge a-b split at every vertex of `other` that lies on it (within the tolerance). */
function subSegments(a: Pt, b: Pt, other: readonly Pt[]): [Pt, Pt][] {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  if (len2 === 0) return [];
  const ts = [0, 1];
  for (const v of other) {
    if (segmentDistance(v, a, b) > FIELD_GEOMETRY_TOLERANCE_DEG) continue;
    const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
    if (t > 0 && t < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const at = (t: number): Pt => [a[0] + t * dx, a[1] + t * dy];
  const out: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < ts.length; i++) if (ts[i + 1]! - ts[i]! > 0) out.push([at(ts[i]!), at(ts[i + 1]!)]);
  return out;
}

/**
 * Point in polygon by ray casting (WGS84 degrees treated as planar, adequate at field scale). A point on an edge (within
 * FIELD_GEOMETRY_TOLERANCE_DEG) counts as inside unless `includeBoundary` is false. Accepts a closed or open ring.
 */
export function pointInRing(point: readonly [number, number], ring: readonly (readonly [number, number])[], includeBoundary = true): boolean {
  const r = openRing(ring);
  if (r.length < 3) return false;
  if (onRingEdge(point, r)) return includeBoundary;
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The inner ring lies within the outer ring: every inner vertex is inside or on the outer polygon, no inner edge crosses an
 * outer edge, and every piece of an inner edge between outer vertices it touches stays inside or on the outer polygon
 * (so an edge cannot leave through a notch of a concave farm). Shared edges with the outer ring are allowed.
 */
export function ringWithin(outer: readonly (readonly [number, number])[], inner: readonly (readonly [number, number])[]): boolean {
  const o = openRing(outer), n = openRing(inner);
  if (o.length < 3 || n.length < 3) return false;
  if (!n.every((p) => pointInRing(p, o))) return false;
  const oe = edgesOf(o);
  for (const [a, b] of edgesOf(n)) {
    if (oe.some(([c, d]) => properlyCross(a, b, c, d))) return false;
    for (const [p, q] of subSegments(a, b, o)) if (!pointInRing([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], o)) return false;
  }
  return true;
}

/** Signed shoelace area sign: 1 counter-clockwise, -1 clockwise (planar degrees). */
function orientation(r: readonly Pt[]): 1 | -1 {
  const o = r[0]!;
  let twice = 0;
  for (let i = 1; i + 1 < r.length; i++) twice += cross(o as Position, r[i]! as Position, r[i + 1]! as Position);
  return twice >= 0 ? 1 : -1;
}
/** Some part of ring a's interior is inside ring b, seen from a's edges (vertices, edge pieces and just inside each edge piece). */
function interiorReaches(a: readonly Pt[], b: readonly Pt[]): boolean {
  if (a.some((p) => pointInRing(p, b, false))) return true;
  const turn = orientation(a);
  for (const [p0, p1] of edgesOf(a)) {
    for (const [p, q] of subSegments(p0, p1, b)) {
      const m: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (pointInRing(m, b, false)) return true;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len <= 2 * PROBE_DEG) continue;
      // Just inside a, beside the middle of this piece: inside b too means both interiors lie on the same side of it.
      const probe: Pt = [m[0] - (turn * (q[1] - p[1]) / len) * PROBE_DEG, m[1] + (turn * (q[0] - p[0]) / len) * PROBE_DEG];
      if (pointInRing(probe, b, false)) return true;
    }
  }
  return false;
}

/**
 * The interiors of two rings overlap. Shared edges and shared vertices are allowed (adjacent strips pass); a vertex of one
 * strictly inside the other, a crossing of edges, or an edge with both interiors on the same side (a doubled field) is an
 * overlap.
 */
export function ringsOverlap(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): boolean {
  const p = openRing(a), q = openRing(b);
  if (p.length < 3 || q.length < 3 || !bboxesTouch(p, q)) return false;
  const qe = edgesOf(q);
  for (const [s, t] of edgesOf(p)) if (qe.some(([c, d]) => properlyCross(s, t, c, d))) return true;
  return interiorReaches(p, q) || interiorReaches(q, p);
}

/** A field boundary in WGS84 longitude/latitude. Never accepts normalized photo geometry. */
export const GeographicBoundary = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(position).min(4).max(201)).length(1),
}).strict().superRefine((p, ctx) => {
  const r = p.coordinates[0]!;
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['coordinates'] });
  if (r[0]![0] !== r.at(-1)![0] || r[0]![1] !== r.at(-1)![1]) return fail('boundary ring must be closed');
  const vertices = r.slice(0, -1);
  if (new Set(vertices.map((v) => v.join(','))).size !== vertices.length) return fail('boundary vertices must be distinct');
  if (Math.max(...vertices.map((v) => v[0])) - Math.min(...vertices.map((v) => v[0])) > 180) return fail('boundary may not cross the antimeridian');
  // Shift origin before the shoelace calculation to retain precision on small fields.
  const a = r[0]!;
  const area = r.slice(0, -1).reduce((sum, b, i) => sum + cross(a, b, r[i + 1]!), 0);
  if (Math.abs(area) < 1e-14) return fail('boundary must enclose a nonzero area');
  for (let i = 0; i < r.length - 1; i++) {
    for (let j = i + 1; j < r.length - 1; j++) {
      if (j === i + 1 || (i === 0 && j === r.length - 2)) continue;
      if (intersects(r[i]!, r[i + 1]!, r[j]!, r[j + 1]!)) return fail('boundary may not intersect itself');
    }
  }
});
export type GeographicBoundary = z.infer<typeof GeographicBoundary>;

const crop = { cropId: z.string().trim().min(1).max(120), cropName: z.string().trim().min(1).max(120).optional() };
export const PreviousHarvest = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('known'), ...crop, harvestDate: z.iso.date() }).strict(),
]);
/**
 * Field id (2026-11-03): letters, digits, '_', '.', '-' only, so it travels unencoded in `?fieldId=` image paths that the
 * Today view returns (SceneRef paths stay short). The web generates these ids.
 */
export const FieldId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/, 'field id may use letters, digits, "_", "." and "-" only');
/**
 * The companion crop of an intercrop (main crop ids live on the cycle or plan). Shared by RotationPlan and CropCycle. Named
 * WorkspaceCompanion because year-plan.ts already exports a different IntercropCompanion (the scored candidate's companion).
 */
export const WorkspaceCompanion = z.object({
  systemId: z.string().trim().min(1).max(120).optional(),
  cropId: z.string().trim().min(1).max(120),
  cropName: z.string().trim().min(1).max(120).optional(),
  productId: z.string().trim().min(1).max(200).optional(),
  productName: z.string().trim().min(1).max(120).optional(),
  rowRatio: z.string().trim().min(1).max(20),
}).strict();
export type WorkspaceCompanion = z.infer<typeof WorkspaceCompanion>;

/** The farmer's own field check interval, whole days (FIELD_OPERATIONS_SPEC.md 2: default 7, 3 to 30). Not an agronomic claim. */
export const CheckIntervalDays = z.number().int().min(3).max(30);
/** A named field inside the farm (2026-11-03, FIELDS_MULTICROP_SOIL_SPEC.md section 2.1). */
export const FarmField = z.object({
  id: FieldId,
  name: z.string().trim().min(1).max(80),
  boundary: GeographicBoundary,
  notes: z.string().trim().max(500).optional(),
  /** 2026-11-03 (FIELD_OPERATIONS_SPEC.md 3): the farmer's own field check interval in days ("Your check interval"); absent = the farm's, else 7. */
  checkIntervalDays: CheckIntervalDays.optional(),
}).strict();
export type FarmField = z.infer<typeof FarmField>;

export const CropCycle = z.object({
  id: z.string().trim().min(1).max(120), ...crop,
  sowingDate: z.iso.date(),
  /** Establishment date and method are explicit; legacy sowingDate alone cannot imply transplanting. */
  establishmentDate: z.iso.date().optional(),
  establishmentMethod: z.string().trim().min(1).max(80).optional(),
  productId: z.string().trim().min(1).max(200).optional(),
  productName: z.string().trim().min(1).max(120).optional(),
  stage: z.enum(['sowed', 'growing', 'flowering', 'harvested']),
  harvestDate: z.iso.date().optional(),
  notes: z.string().trim().max(2000).optional(),
  rootPlanId: z.uuid().optional(),
  latestPlanId: z.uuid().optional(),
  /** 2026-11-03: the field the crop grows on; absent = a farm-wide (legacy) cycle. Must name a field of the workspace. */
  fieldId: FieldId.optional(),
  /** 2026-11-03: the companion crop when this cycle is an intercrop (same shape as RotationPlan.companion). */
  companion: WorkspaceCompanion.optional(),
}).strict().superRefine((c, ctx) => {
  if(c.productName&&!c.productId)ctx.addIssue({code:'custom',message:'productName requires productId',path:['productId']});
  if (c.establishmentDate && c.establishmentDate !== c.sowingDate) ctx.addIssue({code:'custom',message:'Compatibility sowingDate must match establishmentDate',path:['establishmentDate']});
  if (c.harvestDate && c.harvestDate < c.sowingDate) ctx.addIssue({ code: 'custom', message: 'harvest must be on or after sowing', path: ['harvestDate'] });
  if (c.stage === 'harvested' && !c.harvestDate) ctx.addIssue({ code: 'custom', message: 'harvested cycles need a harvest date', path: ['harvestDate'] });
});
export const RotationPlan = z.object({
  id: z.string().trim().min(1).max(120), year: z.number().int().min(1900).max(2200),
  season: z.string().trim().min(1).max(80), ...crop,
  productId: z.string().trim().min(1).max(200).optional(),
  productName: z.string().trim().min(1).max(120).optional(),
  plannedSowingDate: z.iso.date().optional(), plannedHarvestDate: z.iso.date().optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Round 3: establishment method the plan assumed (year-plan apply writes it); the season preview dates care steps from it. */
  establishmentMethod: z.string().trim().min(1).max(80).optional(),
  /** Round 3: a green manure or an intercrop season (ROUND3_SPEC.md section 8); absent = a sole crop. */
  kind: z.enum(['crop', 'green_manure', 'intercrop']).optional(),
  /** Round 3: the companion crop of an intercrop season; cropId/productId above are the main crop's. */
  companion: WorkspaceCompanion.optional(),
  /** 2026-11-03: the field this season is planned for; absent = the whole farm. Must name a field of the workspace. */
  fieldId: FieldId.optional(),
}).strict().superRefine((r, ctx) => {
  if(r.productName&&!r.productId)ctx.addIssue({code:'custom',message:'productName requires productId',path:['productId']});
  if (r.plannedSowingDate && Number(r.plannedSowingDate.slice(0, 4)) !== r.year) ctx.addIssue({ code: 'custom', message: 'year must match the planned sowing year', path: ['year'] });
  if (r.plannedSowingDate && r.plannedHarvestDate && r.plannedHarvestDate < r.plannedSowingDate) ctx.addIssue({ code: 'custom', message: 'planned harvest must follow sowing', path: ['plannedHarvestDate'] });
});

type StateShape = { boundary: GeographicBoundary | null; cycles: { id: string; fieldId?: string | undefined }[]; rotationPlans: { id: string; fieldId?: string | undefined }[]; fields?: FarmField[] | undefined };
type Ctx = { addIssue: (issue: { code: 'custom'; message: string; path: (string | number)[] }) => void };
/**
 * Field rules (2026-11-03): unique ids and case-insensitive names; every cycle and plan fieldId names a field; with a farm
 * boundary every field lies within it; no two fields overlap (shared edges and vertices allowed). `fields` undefined (a PUT
 * that leaves the fields unchanged) skips them; the service re-checks the merged state.
 */
function refineFields(w: StateShape, ctx: Ctx) {
  if (!w.fields) return;
  const fields = w.fields;
  const ids = new Set(fields.map((f) => f.id));
  if (ids.size !== fields.length) ctx.addIssue({ code: 'custom', message: 'field ids must be unique within the farm', path: ['fields'] });
  if (new Set(fields.map((f) => f.name.toLowerCase())).size !== fields.length) ctx.addIssue({ code: 'custom', message: 'field names must be unique within the farm', path: ['fields'] });
  for (const key of ['cycles', 'rotationPlans'] as const) {
    w[key].forEach((r, i) => { if (r.fieldId !== undefined && !ids.has(r.fieldId)) ctx.addIssue({ code: 'custom', message: `fieldId ${r.fieldId} does not name a field of this farm`, path: [key, i, 'fieldId'] }); });
  }
  const rings = fields.map((f) => (f.boundary?.coordinates?.[0] ?? []) as [number, number][]);
  const farmRing = w.boundary?.coordinates?.[0] as [number, number][] | undefined;
  rings.forEach((ring, i) => {
    if (ring.length < 4) return;
    if (farmRing && farmRing.length >= 4 && !ringWithin(farmRing, ring)) ctx.addIssue({ code: 'custom', message: `field ${fields[i]!.name} must lie within the farm boundary`, path: ['fields', i, 'boundary'] });
    for (let j = 0; j < i; j++) {
      if (rings[j]!.length >= 4 && ringsOverlap(rings[j]!, ring)) ctx.addIssue({ code: 'custom', message: `fields ${fields[j]!.name} and ${fields[i]!.name} overlap`, path: ['fields', i, 'boundary'] });
    }
  });
}

const stateShape = {
  boundary: GeographicBoundary.nullable(),
  previousHarvest: PreviousHarvest,
  cycles: z.array(CropCycle).max(100),
  rotationPlans: z.array(RotationPlan).max(100),
  /** 2026-11-03: fields inside the farm, in drawn order. Old rows without the key read back as []. */
  fields: z.array(FarmField).max(50).default([]),
  /** 2026-11-03 (FIELD_OPERATIONS_SPEC.md 3): the farm-wide check interval (a farm without fields, and fields without their own); absent = 7. */
  checkIntervalDays: CheckIntervalDays.optional(),
};
const refineState = (w: StateShape, ctx: Ctx) => {
  for (const key of ['cycles', 'rotationPlans'] as const) {
    if (new Set(w[key].map((r) => r.id)).size !== w[key].length) ctx.addIssue({ code: 'custom', message: 'ids must be unique within the farm', path: [key] });
  }
  refineFields(w, ctx);
};
export const FarmWorkspaceState = z.object(stateShape).strict().superRefine(refineState);
/**
 * PUT body. `fields` is optional WITHOUT a default here: a writer that omits it (the year-plan apply, older web saves)
 * leaves the stored fields unchanged instead of deleting them; the service merges and re-validates the whole state.
 */
export const PutFarmWorkspace = z.object({ ...stateShape, fields: z.array(FarmField).max(50).optional(), expectedVersion: z.number().int().nonnegative() }).strict().superRefine(refineState);
export const FarmWorkspace = FarmWorkspaceState.safeExtend({ farmId: z.uuid(), version: z.number().int().nonnegative(), updatedAt: z.iso.datetime().nullable() });
export type FarmWorkspaceState = z.infer<typeof FarmWorkspaceState>;
export type PutFarmWorkspace = z.infer<typeof PutFarmWorkspace>;
export type FarmWorkspace = z.infer<typeof FarmWorkspace>;
