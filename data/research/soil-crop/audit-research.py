"""Audit identity coverage, provenance, species joins and non-executable evidence."""
import json,collections,csv
from pathlib import Path
R=Path(__file__).resolve().parent
x=json.loads((R/'crop-profiles.json').read_text());inv=json.loads((R.parents[1]/'manifests/agmarknet-priced-inventory-2026-10-30.json').read_text())
assert {i['sourceCommodity'] for i in x['commodityIdentities']}=={i['sourceCommodity'] for i in inv['entries']}
assert len(x['commodityIdentities'])==len({i['sourceCommodity'] for i in x['commodityIdentities']})==257
raw={r['EcoPortCode']:r for r in csv.DictReader((R/'ecocrop/EcoCrop_DB.csv').open(encoding='cp1252'))}
ps={p['profileId']:p for p in x['profiles']};assert len(ps)==177
categories=collections.Counter();facts=collections.Counter();gap=[]
for p in ps.values():
 refs=([p['ecocrop']] if p['ecocrop'] else [])+[v['reference'] for v in p.get('ecocropVariants',[])]
 for v in p.get('ecocropVariants',[]):assert v['identitySelected'] is False
 for e in refs:
  assert e['matchingEligible'] is False and e['sourceUrl'].startswith('https://ecocrop.apps.fao.org/')
  original=raw[e['ecoportCode']]
  for target,source in [('temperatureC',['TOPMN','TOPMX','TMIN','TMAX']),('annualRainfallMm',['ROPMN','ROPMX','RMIN','RMAX']),('soilPh',['PHOPMN','PHOPMX','PHMIN','PHMAX'])]:
   for field,col in zip(['optimalMin','optimalMax','absoluteMin','absoluteMax'],source):
    value=original[col].strip();expected=None if value in ('','NA') else float(value)
    assert e['parameters'][target][field]==expected,(e['ecoportCode'],target,field)
  for k in ['temperatureC','annualRainfallMm','soilPh']:
   vals=e['parameters'][k]
   if all(v is not None for v in vals.values()) and not(vals['absoluteMin']<=vals['optimalMin']<=vals['optimalMax']<=vals['absoluteMax']):assert e['qualityFlags']
 for e in p['regionalEvidence']:
  assert e['sourceUrl'].startswith('https://') and e['locator'] and e['scope'] and e['executableRecommendation'] is False
  facts[e['parameter']]+=1
 if not(refs or p['regionalEvidence']):gap.append({'profileId':p['profileId'],'botanicalCandidate':p['botanicalName'],'sourceCommodities':p['sourceCommodities'],'identityStatus':p['identityStatus']})
for i in x['commodityIdentities']:categories[i['classification']]+=1
assert len(x['soilTypeReferences'])==8
assert all(e['matchingEligible'] is False and e['measuredValueInferenceAllowed'] is False for e in x['soilTypeReferences'])
out={'checkedAt':'2026-10-30','checksPassed':['257exact inventory identities','177unique profiles','all regional facts have source/locator/scope','all evidence non-executable','species alternatives unselected','numeric envelopes validated and equal preserved source cells','soil groups cannot create measurements'], 'coverage':x['coverage'],'commodityClassifications':dict(categories),'regionalFactsByParameter':dict(facts),'profileGroupsWithoutAnyAgronomicReference':gap,'limitations':['Current available daily price snapshot is not the full historical AGMARKNET universe.','Full cultivar/geography/method-specific agronomic coverage is incomplete.','No universal numerical OC/N/P/K/micronutrient soil targets or automatic fertilizer prescription.','Source references include historical material and uneven expert ecological envelopes.']}
(R/'coverage-audit.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'checks':'passed','profilesWithoutAnyAgronomicReference':len(gap),'coverage':x['coverage']}))
