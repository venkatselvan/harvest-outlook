import type {SoilMarkerDraft,SoilCanonicalValue} from '@harvest/contracts';
/** Explicit confirmation acknowledges the routine scan-review notice, not scientific or repeated-reading conflicts. */
export function hasUnresolvedSoilWarnings(marker:Pick<SoilMarkerDraft,'warnings'>):boolean{
 return marker.warnings.some(w=>w!=='Verify this result and sample assignment against the original page before confirming.');
}
/** Unit transformations preserve analyte/method; they never infer a nutrient dose or a soil rating. */
export function normalizeSoilMarker(marker:SoilMarkerDraft):SoilCanonicalValue{
 const missing=(reason:string):SoilCanonicalValue=>({value:null,unit:null,conversion:null,missingReason:reason});
 if(marker.numericValue===null||!['exact','less_than','less_or_equal','greater_than','greater_or_equal'].includes(marker.qualifier))return missing('No single legible numeric result; retain the printed qualifier or range.');
 const value=marker.numericValue;const unit=(marker.rawUnit??'').trim().replace(/μ/g,'µ').replace(/\s+/g,'');
 if(marker.parameter==='ph'&&!['','-','--','pH'].includes(unit))return missing('Printed pH has a contradictory unit; review the parameter and original unit.');
 const boundedPercent=['organic_carbon','organic_matter','sand','silt','clay','moisture_volumetric','base_saturation','esp'];
 if(value<0&&(marker.parameter!=='unknown_other'||['mg/kg','mg/Kg','kg/ha','Kg/Ha','µg/g','ppm','%'].includes(unit)))return missing('Negative concentration or physical soil value requires review; raw result is retained.');
 if(boundedPercent.includes(marker.parameter)&&['%','percent'].includes(unit)&&value>100)return missing('Percentage exceeds the physical fraction bound; review the original result and unit.');
 if(['organic_carbon','organic_matter'].includes(marker.parameter)&&['g/kg','gkg-1'].includes(unit)&&value>1000)return missing('Mass fraction exceeds the physical bound; review the original result and unit.');
 if(marker.parameter==='bulk_density'&&value===0)return missing('Zero bulk density requires review; raw result is retained.');
 const result=(factor:number,canonical:string,formula:string|null):SoilCanonicalValue=>value*factor<0?missing('Negative canonical concentration or physical value requires review.') : !Number.isFinite(value*factor)?missing('Conversion exceeds supported numeric range.') : ({value:value*factor,unit:canonical,conversion:formula?{formula,version:'soil-unit-v1'}:null,missingReason:null});
 if(marker.parameter==='ph')return value>=0&&value<=14?result(1,'pH',null):missing('Printed pH is outside the supported range; review the report.');
 if(marker.parameter==='electrical_conductivity'){
  if(unit==='ds/m')return result(1,'dS/m','dS/m = printed ds/m (conductivity-specific spelling alias; original unit retained)');
  if(['dS/m','mS/cm'].includes(unit))return result(1,'dS/m',unit==='mS/cm'?'dS/m = mS/cm':null);
  if(['µS/cm','uS/cm'].includes(unit))return result(.001,'dS/m','dS/m = µS/cm ÷ 1000');
  return missing('EC unit is missing or unsupported; extract method and soil:water ratio stay distinct.');
 }
 if(['organic_carbon','organic_matter','sand','silt','clay','moisture_gravimetric','moisture_volumetric','base_saturation','esp'].includes(marker.parameter)){
  if(['%','percent'].includes(unit))return result(1,'%',null);
  if(['g/kg','gkg-1'].includes(unit)&&['organic_carbon','organic_matter'].includes(marker.parameter))return result(.1,'%','% = g/kg ÷ 10');
 }
 if(['mg/kg','mg/Kg','mgkg-1','µg/g','ug/g'].includes(unit))return result(1,'mg/kg',['µg/g','ug/g'].includes(unit)?'mg/kg = µg/g':null);
 if(['kg/ha','Kg/Ha','Kg/ha','kgha-1'].includes(unit))return result(1,'kg/ha',null);
 if(['lb/acre','lbs/acre'].includes(unit))return result(1.12085,'kg/ha','kg/ha = lb/acre × 1.12085');
 if(unit==='ppm')return missing('ppm matrix and measurement basis require review; no concentration conversion was inferred.');
 if(['cmol(+)/kg','cmolc/kg','meq/100g'].includes(unit))return result(1,'cmol(+)/kg',unit==='meq/100g'?'cmol(+)/kg = meq/100g':null);
 if(marker.parameter==='bulk_density'&&['g/cm3','g/cm³','g/cc','Mg/m3','Mg/m³'].includes(unit))return result(1,'g/cm³',null);
 return missing('No supported exact dimensional conversion; original value and unit are retained.');
}
