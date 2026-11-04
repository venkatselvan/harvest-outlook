import {afterEach, describe, expect, it} from 'vitest';
import * as data from '../src/services/year-plan/data';

afterEach(() => data.invalidate());
const row = (region: string, amount: number, extra = {}) => ({region, a2flPerHa: amount, authority: 'des', year: '2023-24', ...extra});
const fixture = (costs: unknown[], yields: unknown[] = []) => data.invalidate({yieldCost: {crops: [{cropId: 'maize', costs, yields}]}});
describe('cultivation reference fallbacks', () => {
  it('prefers district, then state, then India, before another region', () => {
    const all = [row('IN-TN', 400), row('IN', 300), row('IN-KA', 200), row('IN-KA-hassan', 100)];
    for (const [skip, expected] of [[0,100],[1,200],[2,300],[3,400]]) {
      fixture(all.slice(0, 4-skip!));
      expect(data.costFor('maize', {stateId:'IN-KA', districtId:'IN-KA-hassan'})?.deductionPerHa).toBe(expected);
    }
  });
  it('never treats a per-quintal cost or low-reliability row as a per-hectare cost', () => {
    fixture([{region:'IN-KA',costPerQuintal:3000},row('IN-KA',1,{reliability:'low'}),row('IN',300)]);
    expect(data.costFor('maize',{stateId:'IN-KA'})?.estimate.region).toBe('IN');
  });
  it('retains the distinct basis and omitted-cost warning for a published budget', () => {
    fixture([{region:'IN-TN',totalCostPerHa:15000,year:'2015',authority:'sau'}]);
    const cost=data.costFor('maize',{stateId:'IN-KA'})!;
    expect(cost).toMatchObject({deductionPerHa:15000,deductionBasis:'reported',estimate:{a2flPerHa:null,c2PerHa:null,reportedPerHa:15000,region:'IN-TN'}});
    expect(cost.notes.join(' ')).toContain('omitted costs are not deducted');
    expect(cost.notes.join(' ')).toContain('not inflation-adjusted');
  });
  it('offers a sourced cost for every catalogue crop even outside researched states', () => {
    data.invalidate();
    for(const crop of data.loadYieldCost().crops) {
      const cost=data.costFor(crop.cropId,{stateId:'IN-MH',districtId:'IN-MH-pune'});
      expect(cost, crop.cropId).not.toBeNull();
      expect(cost!.sourceId,crop.cropId).toBeTruthy();
      expect(data.yieldCostSource(cost!.sourceId!),crop.cropId).toBeTruthy();
    }
    expect(data.loadIssues()).toEqual([]);
  });
  it('uses an explicitly nonlocal national yield without converting cotton lint into kapas', () => {
    data.invalidate();
    const ref=data.yieldFor('maize','maize-grain',{stateId:'IN-MH',districtId:'IN-MH-pune',season:'kharif',asOf:'2026-11-04'});
    expect(ref).toMatchObject({basis:'reference',region:'IN',referenceBasis:'regional_reference'});
    expect(data.yieldFor('cotton','cotton-kapas',{stateId:'IN-MH',districtId:'IN-MH-pune',season:'kharif'})).toBeNull();
  });
});
