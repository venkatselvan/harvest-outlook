import { describe, expect, it } from 'vitest';
import { FarmWorkspaceState, GeographicBoundary, PutFarmWorkspace, pointInRing, ringWithin, ringsOverlap } from './workspace';

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

// ------------------------------------------------------------------ fields inside a farm (2026-11-03)
const sq = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const field = (id: string, name: string, boundary: { type: string; coordinates: number[][][] }) => ({ id, name, boundary });
describe('fields inside a farm', () => {
  it('reads an old row without fields as an empty list, and a PUT without fields leaves them unset for the service to merge', () => {
    const { expectedVersion: _, ...old } = state;
    expect(FarmWorkspaceState.parse(old).fields).toEqual([]);
    expect(PutFarmWorkspace.parse(state).fields).toBeUndefined();
  });
  it('accepts fields inside the farm, adjacent strips sharing an edge, and a cycle and plan naming a field', () => {
    const strips = [field('s1', 'Strip 1', sq(76, 13, 76.005, 13.01)), field('s2', 'Strip 2', sq(76.005, 13, 76.01, 13.01))];
    const cycle = { id: 'c1', cropId: 'paddy', sowingDate: '2026-06-01', stage: 'growing', fieldId: 's2', companion: { cropId: 'black-gram', rowRatio: '4:2' } };
    const plan = { id: 'p1', cropId: 'maize', year: 2027, season: 'Kharif', fieldId: 's1' };
    const parsed = PutFarmWorkspace.safeParse({ ...state, fields: strips, cycles: [cycle], rotationPlans: [plan] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // A T-junction: strip 3 and 4 split the right half, both touching strip 1's right edge at a vertex in its middle.
    const tee = [field('a', 'Left', sq(76, 13, 76.005, 13.01)), field('b', 'Right low', sq(76.005, 13, 76.01, 13.005)), field('c', 'Right high', sq(76.005, 13.005, 76.01, 13.01))];
    expect(PutFarmWorkspace.safeParse({ ...state, fields: tee }).success).toBe(true);
  });
  it('accepts strips whose cut vertices sit on a slanted farm edge only to floating-point precision', () => {
    const farm = { type: 'Polygon', coordinates: [[[76, 13], [76.01, 13], [76.01, 13.0123456], [76, 13.01], [76, 13]]] };
    const yAt = (x: number) => 13.01 + ((x - 76) / 0.01) * 0.0023456; // the slanted top edge
    const cut = 76 + 0.01 / 3;
    const left = { type: 'Polygon', coordinates: [[[76, 13], [cut, 13], [cut, Number(yAt(cut).toFixed(7))], [76, 13.01], [76, 13]]] };
    const right = { type: 'Polygon', coordinates: [[[cut, 13], [76.01, 13], [76.01, 13.0123456], [cut, Number(yAt(cut).toFixed(7))], [cut, 13]]] };
    const r = PutFarmWorkspace.safeParse({ ...state, boundary: farm, fields: [field('l', 'Left', left), field('r', 'Right', right)] });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('rejects a field outside the farm or crossing its edge, and a concave farm whose notch a field edge bridges', () => {
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [field('x', 'Out', sq(76.02, 13, 76.03, 13.01))] }).success).toBe(false);
    const crossing = PutFarmWorkspace.safeParse({ ...state, fields: [field('x', 'Edge', sq(76.005, 13.005, 76.015, 13.008))] });
    expect(crossing.success).toBe(false);
    expect(crossing.error!.issues[0]!.message).toMatch(/must lie within the farm boundary/);
    // U-shaped farm: the field spans both prongs, its top edge runs between the prong tips across the notch.
    const u = { type: 'Polygon', coordinates: [[[76, 13], [76.03, 13], [76.03, 13.02], [76.02, 13.02], [76.02, 13.01], [76.01, 13.01], [76.01, 13.02], [76, 13.02], [76, 13]]] };
    const bridge = { type: 'Polygon', coordinates: [[[76.01, 13.02], [76.01, 13.01], [76.02, 13.01], [76.02, 13.02], [76.01, 13.02]]] };
    expect(ringWithin(u.coordinates[0] as [number, number][], bridge.coordinates[0] as [number, number][])).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, boundary: u, fields: [field('b', 'Notch', bridge)] }).success).toBe(false);
    // With no farm boundary, fields are accepted as drawn.
    expect(PutFarmWorkspace.safeParse({ ...state, boundary: null, fields: [field('x', 'Out', sq(76.02, 13, 76.03, 13.01))] }).success).toBe(true);
  });
  it('rejects overlapping fields: a vertex inside, crossing edges, a doubled field and one inscribed on shared vertices', () => {
    const base = field('a', 'A', sq(76, 13, 76.006, 13.01));
    for (const other of [sq(76.005, 13.002, 76.008, 13.004), sq(76.002, 13.002, 76.004, 13.012), sq(76, 13, 76.006, 13.01)]) {
      expect(PutFarmWorkspace.safeParse({ ...state, boundary: null, fields: [base, field('b', 'B', other)] }).success, JSON.stringify(other)).toBe(false);
    }
    // Edges cross without any vertex inside (a plus sign).
    const wide = sq(76, 13.004, 76.01, 13.006), tall = sq(76.004, 13, 76.006, 13.01);
    expect(ringsOverlap(wide.coordinates[0] as [number, number][], tall.coordinates[0] as [number, number][])).toBe(true);
    // Triangle on three corners of the square: no vertex strictly inside, no crossing, but the diagonal runs through it.
    const tri = { type: 'Polygon', coordinates: [[[76, 13], [76.006, 13], [76.006, 13.01], [76, 13]]] };
    expect(PutFarmWorkspace.safeParse({ ...state, boundary: null, fields: [base, field('t', 'T', tri)] }).success).toBe(false);
    // Same square drawn the other way round is still a doubled field.
    const reversed = { type: 'Polygon', coordinates: [[[76, 13], [76, 13.01], [76.006, 13.01], [76.006, 13], [76, 13]]] };
    expect(ringsOverlap(base.boundary.coordinates[0] as [number, number][], reversed.coordinates[0] as [number, number][])).toBe(true);
    expect(pointInRing([76.003, 13.005], base.boundary.coordinates[0] as [number, number][])).toBe(true);
    expect(pointInRing([76, 13.005], base.boundary.coordinates[0] as [number, number][])).toBe(true);
    expect(pointInRing([76, 13.005], base.boundary.coordinates[0] as [number, number][], false)).toBe(false);
  });
  it('requires unique field ids and names, URL-safe ids, and that every cycle and plan fieldId names a field', () => {
    const a = field('a', 'North', sq(76, 13, 76.005, 13.01)), b = field('b', 'south', sq(76.005, 13, 76.01, 13.01));
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [a, { ...b, id: 'a' }] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [a, { ...b, name: ' north ' }] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [{ ...a, id: 'north field' }] }).success).toBe(false);
    const cycle = { id: 'c1', cropId: 'paddy', sowingDate: '2026-06-01', stage: 'growing', fieldId: 'gone' };
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [a, b], cycles: [cycle] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [a, b], rotationPlans: [{ id: 'p', cropId: 'maize', year: 2027, season: 'Rabi', fieldId: 'gone' }] }).success).toBe(false);
    expect(FarmWorkspaceState.safeParse({ boundary, previousHarvest: { status: 'unknown' }, cycles: [cycle], rotationPlans: [] }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, fields: [a, b], cycles: [{ ...cycle, fieldId: 'b' }] }).success).toBe(true);
  });
});
