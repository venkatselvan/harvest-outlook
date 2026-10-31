import { z } from 'zod';

const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
type Position = z.infer<typeof position>;
const cross = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Position, b: Position, p: Position) => cross(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function intersects(a: Position, b: Position, c: Position, d: Position): boolean {
  const x = cross(a, b, c), y = cross(a, b, d), u = cross(c, d, a), v = cross(c, d, b);
  return (x * y < 0 && u * v < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
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
}).strict().superRefine((r, ctx) => {
  if(r.productName&&!r.productId)ctx.addIssue({code:'custom',message:'productName requires productId',path:['productId']});
  if (r.plannedSowingDate && Number(r.plannedSowingDate.slice(0, 4)) !== r.year) ctx.addIssue({ code: 'custom', message: 'year must match the planned sowing year', path: ['year'] });
  if (r.plannedSowingDate && r.plannedHarvestDate && r.plannedHarvestDate < r.plannedSowingDate) ctx.addIssue({ code: 'custom', message: 'planned harvest must follow sowing', path: ['plannedHarvestDate'] });
});

export const FarmWorkspaceState = z.object({
  boundary: GeographicBoundary.nullable(),
  previousHarvest: PreviousHarvest,
  cycles: z.array(CropCycle).max(100),
  rotationPlans: z.array(RotationPlan).max(100),
}).strict().superRefine((w, ctx) => {
  for (const key of ['cycles', 'rotationPlans'] as const) {
    if (new Set(w[key].map((r) => r.id)).size !== w[key].length) ctx.addIssue({ code: 'custom', message: 'ids must be unique within the farm', path: [key] });
  }
});
export const PutFarmWorkspace = FarmWorkspaceState.safeExtend({ expectedVersion: z.number().int().nonnegative() });
export const FarmWorkspace = FarmWorkspaceState.safeExtend({ farmId: z.uuid(), version: z.number().int().nonnegative(), updatedAt: z.iso.datetime().nullable() });
export type FarmWorkspaceState = z.infer<typeof FarmWorkspaceState>;
export type PutFarmWorkspace = z.infer<typeof PutFarmWorkspace>;
export type FarmWorkspace = z.infer<typeof FarmWorkspace>;
