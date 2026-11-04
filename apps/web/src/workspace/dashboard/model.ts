import { FarmWorkspace as workspaceSchema, type FarmWorkspace as Workspace } from '@harvest/contracts';
import type { GeoFarm } from '../state';
import { boundaryArea } from '../state';
import { apiRequest } from '../../features/photo-region/http';
export type FarmLoad = {
  status: 'loading';
} | {
  status: 'ready';
  workspace: Workspace;
} | {
  status: 'error';
};
export type FarmLoads = Record<string, FarmLoad>;
export function farmArea(farm: GeoFarm, load?: FarmLoad): {
  ha: number;
  basis: 'drawn boundary' | 'recorded area';
} | null {
  if (load?.status === 'ready' && load.workspace.boundary) return {
    ha: boundaryArea(load.workspace.boundary),
    basis: 'drawn boundary'
  };
  return farm.areaHectares != null && Number.isFinite(farm.areaHectares) && farm.areaHectares > 0 ? {
    ha: farm.areaHectares,
    basis: 'recorded area'
  } : null;
}
export function farmTotals(farms: readonly GeoFarm[], loads: FarmLoads) {
  const ready = farms.filter(f => loads[f.id]?.status === 'ready');
  const areas = farms.map(f => farmArea(f, loads[f.id])).filter(a => a !== null);
  return {
    farms: farms.length,
    loaded: ready.length,
    failed: farms.filter(f => loads[f.id]?.status === 'error').length,
    fields: ready.reduce((n, f) => {
      const r = loads[f.id];
      return n + (r?.status === 'ready' ? r.workspace.fields?.length ?? 0 : 0);
    }, 0),
    areaHa: areas.reduce((n, a) => n + a.ha, 0),
    areaKnown: areas.length
  };
}
export function cropLabels(workspace: Workspace, name: (id: string) => string): string[] {
  return [...new Set(workspace.cycles.filter(c => c.stage !== 'harvested').flatMap(c => [c.cropName ?? name(c.cropId), ...(c.companion ? [c.companion.cropName ?? name(c.companion.cropId)] : [])]))];
}
/** Three concurrent database reads at most; stop dispatching and publishing as soon as the cohort/session changes. */
export async function loadFarmWorkspaces(ids: readonly string[], publish: (id: string, state: FarmLoad) => void, current: () => boolean, read: (id: string) => Promise<unknown> = async id => (await apiRequest(`/api/v1/farms/${encodeURIComponent(id)}/workspace`)).data) {
  let cursor = 0;
  await Promise.all(Array.from({
    length: Math.min(3, ids.length)
  }, async () => {
    while (current()) {
      const id = ids[cursor++];
      if (!id) return;
      try {
        const workspace = workspaceSchema.parse(await read(id));
        if (workspace.farmId !== id) throw Error('Farm mismatch');
        if (current()) publish(id, {
          status: 'ready',
          workspace
        });
      } catch {
        if (current()) publish(id, {
          status: 'error'
        });
      }
    }
  }));
}
export function isDemo(farm: GeoFarm): boolean {
  return farm.facts.demo_prefilled?.value === true || farm.facts.demo_illustrative?.value === true;
}
/** Only explicitly saved coordinates can locate a farm. District precision alone is never a geographic pin. */
export function farmPoint(farm: GeoFarm): [number, number] | null {
  const valid = (lat: unknown, lon: unknown): lat is number => typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const {
    lat,
    lon
  } = farm.location;
  if (valid(lat, lon)) return [lat, lon as number];
  const value = farm.facts.location?.value;
  if (value && typeof value === 'object') {
    const point = (value as {
      point?: {
        coordinates?: unknown;
      };
    }).point?.coordinates;
    if (Array.isArray(point) && point.length === 2 && valid(point[1], point[0])) return [point[1], point[0] as number];
  }
  return null;
}
