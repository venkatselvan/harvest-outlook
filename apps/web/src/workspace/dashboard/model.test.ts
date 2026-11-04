import { describe, it, expect } from 'vitest';
import { farmTotals, farmArea, cropLabels, farmPoint, loadFarmWorkspaces } from './model';
import type { GeoFarm } from '../state';
import type { FarmWorkspace as Workspace } from '@harvest/contracts';
const farm = (id: string, area: number | null = null): GeoFarm => ({
  id,
  name: id,
  location: {
    districtId: null,
    districtName: null,
    stateCode: null,
    precision: 'district'
  },
  areaHectares: area,
  facts: {}
});
const workspace = (id: string): Workspace => ({
  farmId: id,
  version: 0,
  updatedAt: null,
  boundary: null,
  previousHarvest: {
    status: 'unknown'
  },
  cycles: [],
  rotationPlans: [],
  fields: []
});
const ids = Array.from({
  length: 6
}, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
describe('all farm records', () => {
  it('keeps unavailable workspace counts partial and preserves unknown area', () => {
    const totals = farmTotals([farm(ids[0]!, 2), farm(ids[1]!), farm(ids[2]!, 3)], {
      [ids[0]!]: {
        status: 'ready',
        workspace: workspace(ids[0]!)
      },
      [ids[1]!]: {
        status: 'error'
      },
      [ids[2]!]: {
        status: 'loading'
      }
    });
    expect(totals).toMatchObject({
      farms: 3,
      loaded: 1,
      failed: 1,
      fields: 0,
      areaKnown: 2,
      areaHa: 5
    });
    expect(farmArea(farm('x'))).toBeNull();
  });
  it('labels actual unharvested main and companion crops without synthesizing health', () => {
    const w = workspace(ids[0]!);
    w.cycles = [{
      id: '1',
      cropId: 'ginger',
      sowingDate: '2026-01-01',
      stage: 'growing',
      companion: {
        cropId: 'maize',
        rowRatio: '1:1'
      }
    }, {
      id: '2',
      cropId: 'rice',
      sowingDate: '2025-01-01',
      stage: 'harvested',
      harvestDate: '2025-06-01'
    }];
    expect(cropLabels(w, id => id.toUpperCase())).toEqual(['GINGER', 'MAIZE']);
  });
  it('locates only explicit valid coordinates, including saved location facts', () => {
    const f = farm('x');
    expect(farmPoint(f)).toBeNull();
    f.location.lat = 120;
    f.location.lon = 77;
    expect(farmPoint(f)).toBeNull();
    f.facts.location = {
      value: {
        point: {
          coordinates: [77, 12]
        }
      },
      unit: null,
      basis: 'farmer_reported',
      confirmed: true
    };
    expect(farmPoint(f)).toEqual([12, 77]);
  });
  it('limits dispatch to three concurrent reads and isolates invalid farm responses', async () => {
    let live = 0,
      max = 0;
    const published: Record<string, string> = {};
    await loadFarmWorkspaces(ids, (id, state) => {
      published[id] = state.status;
    }, () => true, async id => {
      live++;
      max = Math.max(max, live);
      await new Promise(r => setTimeout(r, 2));
      live--;
      return workspace(id === ids[0] ? ids[1]! : id);
    });
    expect(max).toBe(3);
    expect(published[ids[0]!]).toBe('error');
    expect(Object.values(published).filter(v => v === 'ready')).toHaveLength(5);
  });
  it('drops stale private responses and stops queued reads after a session change', async () => {
    let active = true,
      reads = 0;
    const published: string[] = [];
    await loadFarmWorkspaces(ids, id => published.push(id), () => active, async id => {
      reads++;
      active = false;
      return workspace(id);
    });
    expect(published).toEqual([]);
    expect(reads).toBe(1);
  });
});
