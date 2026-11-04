import {describe,expect,it} from 'vitest';
import type {NdviSeries} from '@harvest/contracts';
import {satelliteStatus} from './satelliteStatus';
import {costBasisText,cultivationCostPerHa} from '../year/model';
import {costValue} from './model';
const reading=(date:string,usable:boolean,rejection:string|null=null)=>({date,acquiredAt:`${date}T05:00:00Z`,usable,field:{rejection}});
const series=(readings:unknown[],latestUsable:unknown)=>({status:'available',reason:null,readings,latestUsable}) as NdviSeries;
describe('satellite freshness explanation',()=>{
  it('distinguishes a rejected newer acquisition from the last usable image',()=>{
    const good=reading('2026-10-27',true);
    const text=satelliteStatus(series([good,reading('2026-11-01',false,'low_clear_fraction')],good));
    expect(text).toContain('1 Nov');expect(text).toContain('27 Oct');expect(text).toContain('too few clear pixels');expect(text).toContain('checked daily');
  });
  it('describes band-quality failure without claiming cloud cover',()=>{
    expect(satelliteStatus(series([reading('2026-10-29',false,'implausible_band_values')],null))).toContain('image data failed quality checks');
  });
  it('does not claim checks in synthetic mode',()=>{
    expect(satelliteStatus({...series([],null),reason:'live_mode_required'})).toBeNull();
  });
});
describe('cost display matches the amount deducted',()=>{
  it('shows C2 when A2+FL is absent',()=>{
    const cost={a2flPerHa:null,c2PerHa:319455,authority:'des' as const,region:'IN-KL',year:'2021-22'};
    expect(cultivationCostPerHa(cost)).toBe(319455);expect(costBasisText(cost)).toContain('C2-type');
  });
  it('keeps a cash budget distinct from A2+FL and scales it to field area',()=>{
    const cost={a2flPerHa:null,c2PerHa:null,reportedPerHa:15000,authority:'sau' as const,region:'IN-TN',year:'2015'};
    expect(cultivationCostPerHa(cost)).toBe(15000);expect(costBasisText(cost)).toContain('may exclude');
    expect(costValue({cost,fieldAreaHa:2})).toEqual({label:'Reported cultivation cost',scope:'field',value:30000});
  });
});
