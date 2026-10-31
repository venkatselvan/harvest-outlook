import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {FarmCommandCenter,PlantCropResult} from '@harvest/contracts';
import {loadCatalogueIntoDb} from '../src/catalogue/load';
import {farmBody,login,setupHarness,type Harness,type Client} from './helpers';
// Real focused research and catalogue (no mocked crop list): groundnut is a rotation-pool crop with no reviewed care schedule.
let h:Harness,a:Client,farmId:string;
beforeAll(async()=>{h=await setupHarness();await loadCatalogueIntoDb(h.pool);a=await login(h.app);farmId=(await a.call('POST','/api/v1/farms',{payload:farmBody({facts:{}})})).json().data.id});
afterAll(async()=>h?.close());
const plant=(payload:Record<string,unknown>)=>a.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:{clientEntryId:'pool-'+JSON.stringify(payload).length+'-'+Math.random().toString(36).slice(2,8),establishmentDate:'2026-10-01',expectedWorkspaceVersion:0,...payload}});
const version=async()=>(await a.call('GET',`/api/v1/farms/${farmId}/workspace`)).json().data.version as number;
describe('planting a rotation-pool crop outside the focused care catalogue',()=>{
 it('rejects ids that do not belong together before anything is written',async()=>{
  const before=await version();
  // wrong product for the crop, a method the general list does not offer, an unknown crop, and a focused-only method on a pool crop
  for(const patch of [{cropId:'groundnut',productId:'ginger-fresh',establishmentMethod:'direct_sowing'},{cropId:'groundnut',productId:'groundnut-pod',establishmentMethod:'guessed'},{cropId:'not-a-crop',establishmentMethod:'direct_sowing'},{cropId:'groundnut',productId:'groundnut-pod',establishmentMethod:'rhizome_planting'}])
   expect((await plant({...patch,expectedWorkspaceVersion:before})).statusCode,JSON.stringify(patch)).toBe(400);
  expect(await version()).toBe(before);expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('0');
 });
 it('records groundnut-pod, names the crop from the catalogue and reports that no reviewed care schedule exists',async()=>{
  const res=await plant({cropId:'groundnut',productId:'groundnut-pod',establishmentMethod:'direct_sowing',expectedWorkspaceVersion:await version()});
  expect(res.statusCode,res.body).toBe(201);const result=PlantCropResult.parse(res.json().data);
  expect(result.cycle).toMatchObject({cropId:'groundnut',productId:'groundnut-pod',establishmentMethod:'direct_sowing',sowingDate:'2026-10-01',stage:'sowed'});
  expect(result.cycle.cropName).toMatch(/groundnut/i);expect(result.workspace.cycles.map(c=>c.id)).toContain(result.cycle.id);
  expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('1');
  const center=FarmCommandCenter.parse((await a.call('GET',`/api/v1/farms/${farmId}/command-center`)).json().data);
  const entry=center.currentCycles.find(c=>c.cycle.id===result.cycle.id)!;
  expect(entry.careTasks).toEqual([]);expect(entry.limitations.join(' ')).toMatch(/no reviewed care schedule/i);
 });
 it('accepts any catalogue harvest form of a focused crop when the product is chosen explicitly, and keeps focused care dating',async()=>{
  // chilli is a focused crop whose market-mapped list is only chilli-green; chilli-dry is a second catalogue form of the same crop
  const res=await plant({cropId:'chilli',productId:'chilli-dry',establishmentMethod:'transplanting',expectedWorkspaceVersion:await version()});
  expect(res.statusCode,res.body).toBe(201);expect(res.json().data.cycle).toMatchObject({cropId:'chilli',productId:'chilli-dry'});
  const center=FarmCommandCenter.parse((await a.call('GET',`/api/v1/farms/${farmId}/command-center`)).json().data);
  const entry=center.currentCycles.find(c=>c.cycle.id===res.json().data.cycle.id)!;
  expect(entry.limitations.join(' ')).not.toMatch(/no reviewed care schedule/i);
 });
});
