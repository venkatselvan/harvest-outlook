import { describe, expect, it } from 'vitest';
import { GeographicBoundary, PutFarmWorkspace } from './workspace';

const boundary = { type: 'Polygon', coordinates: [[[76, 13], [76.01, 13], [76.01, 13.01], [76, 13.01], [76, 13]]] };
const state = { expectedVersion: 0, boundary, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [] };
describe('durable farm workspace validation', () => {
  it('accepts a real closed WGS84 boundary and explicit unknown history', () => expect(PutFarmWorkspace.safeParse(state).success).toBe(true));
  it.each([
    { type: 'Polygon', coordinates: [[[76, 13], [76.01, 13], [76, 13.01]]] },
    { type: 'Polygon', coordinates: [[[76, 13], [76.01, 13], [76.02, 13], [76, 13]]] },
    { type: 'Polygon', coordinates: [[[76, 13], [76.02, 13.02], [76, 13.02], [76.02, 13], [76, 13]]] },
    { type: 'Polygon', coordinates: [[[181, 13], [76.01, 13], [76, 13.01], [181, 13]]] },
  ])('rejects malformed, degenerate, crossing or out of range geometry %#', (value) => expect(GeographicBoundary.safeParse(value).success).toBe(false));
  it('rejects duplicate cycle ids, impossible dates and harvests before sowing', () => {
    const cycle = { id: 'first', cropId: 'ginger', sowingDate: '2026-05-01', stage: 'growing' };
    expect(PutFarmWorkspace.safeParse({ ...state, cycles: [cycle, cycle] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, cycles: [{ ...cycle, sowingDate: '2026-02-30' }] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, cycles: [{ ...cycle, harvestDate: '2026-01-01' }] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, cycles: [{ ...cycle, stage: 'harvested' }] }).success).toBe(false);
  });
  it('retains uniqueness refinement when extending the schema with expectedVersion', () => {
    const rotation = { id: 'a', cropId: 'ginger', year: 2027, season: 'Kharif' };
    expect(PutFarmWorkspace.safeParse({ ...state, rotationPlans: [rotation, rotation] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, rotationPlans: [{ ...rotation, plannedSowingDate: '2028-06-01' }] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, rotationPlans: [{ ...rotation, productId: 'ginger-fresh', productName: 'Fresh ginger' }] }).success).toBe(true);
    expect(PutFarmWorkspace.safeParse({ ...state, rotationPlans: [{ ...rotation, productName: 'Fresh ginger' }] }).success).toBe(false);
  });
});
