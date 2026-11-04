import { FarmWorkspaceState, type FarmField, type FarmWorkspace, type GeographicBoundary, type PutFarmWorkspace } from '@harvest/contracts';
import { withTransaction, type Pool } from '../db/pool';
import { ApiError, notFound } from './errors';
import type {PoolClient} from 'pg';
import { appendFact } from './farms';

/** Spherical area (WGS84 radius) and planar centroid at field scale; not a cadastral survey. */
export function boundaryMetrics(boundary: GeographicBoundary) {
  const ring=boundary.coordinates[0]!;const origin=ring[0]!;
  let spherical=0,twiceArea=0,x=0,y=0;
  for(let i=0;i<ring.length-1;i++){
    const a=ring[i]!,b=ring[i+1]!;
    spherical+=(b[0]-a[0])*Math.PI/180*(2+Math.sin(a[1]*Math.PI/180)+Math.sin(b[1]*Math.PI/180));
    const ax=a[0]-origin[0],ay=a[1]-origin[1],bx=b[0]-origin[0],by=b[1]-origin[1];
    const cross=ax*by-bx*ay;twiceArea+=cross;x+=(ax+bx)*cross;y+=(ay+by)*cross;
  }
  return { areaHectares:Math.abs(spherical*6378137**2/2)/10000, lon:origin[0]+x/(3*twiceArea),lat:origin[1]+y/(3*twiceArea) };
}

interface WorkspaceRow { version: number; state: unknown; updated_at: Date }
const emptyState = () => ({ boundary: null, previousHarvest: { status: 'unknown' as const }, cycles: [], rotationPlans: [], fields: [] });

/** The named field of the workspace, else 404 field_not_found (2026-11-03). */
export function fieldOf(workspace: Pick<FarmWorkspace, 'fields'>, fieldId: string): FarmField {
  const field = workspace.fields.find((f) => f.id === fieldId);
  if (!field) throw new ApiError(404, 'field_not_found', 'Field not found on this farm');
  return field;
}

/**
 * Field-scoped workspace (FIELDS_MULTICROP_SOIL_SPEC.md 12.1, 2026-11-03). With `fieldId` on a farm: the cycles and saved
 * seasons naming that field PLUS the farm-wide (legacy) records without a fieldId, because a cycle recorded before the fields
 * were drawn occupies the whole farm until harvested; `boundary` is the field's polygon; `fields` and every other key are
 * kept. Without `fieldId` (null or undefined) the workspace is returned unchanged, so a farm without fields behaves exactly as
 * before. An unknown `fieldId` (including any fieldId on a farm without fields) is 404 field_not_found.
 */
export function fieldView<W extends Pick<FarmWorkspace, 'fields' | 'boundary' | 'cycles' | 'rotationPlans'>>(workspace: W, fieldId?: string | null): W {
  if (fieldId === undefined || fieldId === null) return workspace;
  const field = fieldOf(workspace, fieldId);
  const onField = (r: { fieldId?: string | undefined }) => r.fieldId === undefined || r.fieldId === field.id;
  return { ...workspace, boundary: field.boundary, cycles: workspace.cycles.filter(onField), rotationPlans: workspace.rotationPlans.filter(onField) };
}

/** The field's spherical area in hectares (boundaryMetrics of its drawn polygon; not a survey). 404 field_not_found when unknown. */
export function fieldAreaHa(workspace: Pick<FarmWorkspace, 'fields'>, fieldId: string): number {
  return boundaryMetrics(fieldOf(workspace, fieldId).boundary).areaHectares;
}

/**
 * The field a per-field call works on (12.2): null on a farm without fields when none is named; 400 field_required when the
 * farm has fields and none is named; 404 field_not_found for an unknown one.
 */
export function requireField(workspace: Pick<FarmWorkspace, 'fields'>, fieldId: string | null | undefined): FarmField | null {
  if (fieldId === undefined || fieldId === null) {
    if (workspace.fields.length) throw new ApiError(400, 'field_required', 'This farm has fields; choose the field (fieldId)');
    return null;
  }
  return fieldOf(workspace, fieldId);
}

/** Unharvested cycles of a field view that were recorded for the whole farm before fields were drawn (no fieldId). */
export function legacyCycles(view: Pick<FarmWorkspace, 'cycles'>): FarmWorkspace['cycles'] {
  return view.cycles.filter((c) => c.fieldId === undefined && c.stage !== 'harvested');
}
export const LEGACY_CYCLE_NOTE = 'recorded for the whole farm before fields were drawn';

const assemble = (farmId: string, row?: WorkspaceRow): FarmWorkspace => ({
  ...(row ? FarmWorkspaceState.parse(row.state) : emptyState()),
  farmId, version: row?.version ?? 0, updatedAt: row?.updated_at.toISOString() ?? null,
});

export async function getWorkspace(pool: Pool | PoolClient, ownerId: string, farmId: string): Promise<FarmWorkspace> {
  const r = await pool.query<WorkspaceRow & { farm_id: string }>(
    `SELECT f.id AS farm_id, w.version, w.state, w.updated_at FROM farms f
     LEFT JOIN farm_workspaces w ON w.farm_id=f.id WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`, [farmId, ownerId]);
  if (!r.rows[0]) throw notFound('Farm');
  return assemble(farmId, r.rows[0].state ? r.rows[0] : undefined);
}

export async function putWorkspace(pool: Pool, ownerId: string, farmId: string, body: PutFarmWorkspace, guard?: {farmVersion?:number;afterSave?:(client:PoolClient,workspace:FarmWorkspace)=>Promise<void>}): Promise<FarmWorkspace> {
  return withTransaction(pool, async (c) => {
    // Parent lock serializes even the first workspace write and farm deletion.
    const farm = await c.query<{id:string;version:number}>('SELECT id,version FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [farmId, ownerId]);
    if (!farm.rows[0]) throw notFound('Farm');
    if(guard?.farmVersion!==undefined&&farm.rows[0].version!==guard.farmVersion)throw new ApiError(409,'review_context_changed','Farm facts or location changed; reload the planning review');
    const current = await c.query<WorkspaceRow>('SELECT version, state, updated_at FROM farm_workspaces WHERE farm_id=$1', [farmId]);
    const version = current.rows[0]?.version ?? 0;
    if (body.expectedVersion !== version) throw new ApiError(409, 'version_conflict', 'Farm workspace was changed elsewhere; reload before saving', { currentVersion: version });
    const { expectedVersion: _, ...rawState } = body;
    // A PUT without `fields` keeps the stored fields (2026-11-03): writers built before fields existed (the year-plan apply,
    // older web saves) must not delete them. The merged state is validated as a whole (fields inside the boundary, no
    // overlap, every cycle and plan fieldId naming a field), so deleting a field a cycle still names is refused here.
    // The farm-wide `checkIntervalDays` is kept the same way (the year-plan apply and older saves do not send it).
    const stored = current.rows[0] ? FarmWorkspaceState.parse(current.rows[0].state) : undefined;
    const storedFields = stored?.fields ?? [];
    const storedInterval = stored?.checkIntervalDays;
    const parsed = FarmWorkspaceState.safeParse({ ...rawState, fields: rawState.fields ?? storedFields, ...(rawState.checkIntervalDays === undefined && storedInterval !== undefined ? { checkIntervalDays: storedInterval } : {}) });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new ApiError(400, 'validation_error', issue.message, { field: issue.path.join('.') });
    }
    const state = parsed.data;
    for(const rotation of [...state.rotationPlans,...state.cycles]){
      if(!rotation.productId)continue;
      const product=(await c.query<{slug:string;name:string}>(`SELECT p.slug,p.name FROM crop_products p JOIN crop_identities crop ON crop.id=p.crop_id
        WHERE (p.slug=$1 OR p.id::text=$1) AND (crop.slug=$2 OR crop.id::text=$2)`,[rotation.productId,rotation.cropId])).rows[0];
      if(!product)throw new ApiError(400,'validation_error','Selected product does not belong to the rotation crop',{field:'rotationPlans.productId'});
      rotation.productId=product.slug;rotation.productName=product.name;
    }
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    if ((state.previousHarvest.status === 'known' && state.previousHarvest.harvestDate > today) || state.cycles.some((cycle) => cycle.sowingDate > today || (cycle.harvestDate !== undefined && cycle.harvestDate > today))) {
      throw new ApiError(400, 'validation_error', 'Actual sowing and harvest dates cannot be in the future; use rotation plans for future crops');
    }
    const oldBoundary=current.rows[0]?FarmWorkspaceState.parse(current.rows[0].state).boundary:null;
    if(state.boundary&&JSON.stringify(state.boundary)!==JSON.stringify(oldBoundary)){
      const metrics=boundaryMetrics(state.boundary);
      if(!Number.isFinite(metrics.areaHectares)||metrics.areaHectares<0.0001||metrics.areaHectares>1_000_000)throw new ApiError(400,'validation_error','Boundary area must be between one square metre and one million hectares');
      // Update the existing plan/comparison inputs inside the SAME transaction as the outline.
      // Coordinates are derived from a farmer-drawn boundary, not a measured GPS fix.
      await c.query(`UPDATE farms SET area_hectares=$3,lat=$4,lon=$5,location_geojson=$6::jsonb,location_precision='precise',version=version+1 WHERE id=$1 AND owner_id=$2`,[farmId,ownerId,metrics.areaHectares,metrics.lat,metrics.lon,JSON.stringify({type:'Point',coordinates:[metrics.lon,metrics.lat]})]);
      const areaFact=(await c.query<{id:string}>("SELECT id FROM farm_facts WHERE farm_id=$1 AND owner_id=$2 AND fact_key='area_hectares' AND superseded_by IS NULL FOR UPDATE",[farmId,ownerId])).rows[0];
      await appendFact(c,ownerId,farmId,'area_hectares',{value:metrics.areaHectares,unit:'ha',basis:'derived',confirmed:false,source:'Spherical area calculated from farmer-drawn WGS84 boundary; not a survey'},areaFact?.id??null);
    }
    // Plan IDs are optional links, and can never attach another owner's/farm's data.
    const planIds = [...new Set(state.cycles.flatMap((cycle) => [cycle.rootPlanId, cycle.latestPlanId].filter((id): id is string => !!id)))];
    if (planIds.length) {
      const plans = await c.query<{ id: string }>('SELECT id FROM plans WHERE id = ANY($1::uuid[]) AND owner_id=$2 AND farm_id=$3', [planIds, ownerId, farmId]);
      if (plans.rows.length !== planIds.length) throw notFound('Plan');
    }
    const result = await c.query<WorkspaceRow>(
      `INSERT INTO farm_workspaces (farm_id,version,state) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (farm_id) DO UPDATE SET version=EXCLUDED.version, state=EXCLUDED.state RETURNING version,state,updated_at`,
      [farmId, version + 1, JSON.stringify(state)]);
    const saved=assemble(farmId,result.rows[0]);
    await guard?.afterSave?.(c,saved);
    return saved;
  });
}
