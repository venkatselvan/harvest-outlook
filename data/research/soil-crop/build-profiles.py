"""Build research evidence from preserved public-source data; no app/DB mutations."""
import csv,json,hashlib
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parent
raw=ROOT/'ecocrop/EcoCrop_DB.csv'
rows=list(csv.DictReader(raw.open(encoding='cp1252')))
byname={r['ScientificName'].casefold():r for r in rows}
identities=list(csv.DictReader((ROOT/'commodity-identities.tsv').open(),delimiter='\t'))
# Explicit reviewed legacy spelling/synonym joins; retain both names.
aliases={'Phyllanthus emblica':'Emblica officinalis','Citrus aurantiifolia':'Citrus aurantifolia','Brassica oleracea var. gongylodes':'Brassica oleracea var. gongyloides','Eleusine coracana':'Eleusine coracana ssp. coracana','Luffa aegyptiaca':'Luffa cylindrica','Solanum lycopersicum':'Lycopersicon esculentum','Brassica rapa var. rapa':'Brassica rapa var. rapifera','Prunus dulcis':'Prunus amygdalus','Citrus maxima':'Citrus grandis','Thysanolaena maxima':'Thysanolaena latifolia'}
# Broad/generic provider names stay groups; do not pick one species silently.
profiles={}
for i in identities:
 key=i['profileKey']
 if not key:continue
 if key not in profiles:profiles[key]={'profileId':key,'botanicalName':i['botanicalCandidate'] or None,'sourceCommodities':[],'identityStatus':'species_candidate' if i['botanicalCandidate'] and not ('spp.' in i['botanicalCandidate'] or i['classification']=='identity_pending') else 'identity_unresolved','ecocrop':None,'regionalEvidence':[],'gaps':[]}
 profiles[key]['sourceCommodities'].append(i['sourceCommodity'])
 if 'spp.' in i['botanicalCandidate']:
  profiles[key]['botanicalName']=i['botanicalCandidate'];profiles[key]['identityStatus']='identity_unresolved'
 if i['classification']=='identity_pending':profiles[key].setdefault('commodityIdentityWarnings',[]).append({'sourceCommodity':i['sourceCommodity'],'reason':i['identityNote']})
# Species-level alternatives for trade groups. None is selected as the commodity identity.
variant_names={
 'amaranth-leafy':['Amaranthus tricolor','Amaranthus dubius'],
 'amaranth-grain':['Amaranthus cruentus','Amaranthus hypochondriacus','Amaranthus caudatus'],
 'banana':['Musa acuminata','Musa acuminata x balbisiana'],
 'basil':['Ocimum basilicum','Ocimum tenuiflorum'],
 'cardamom-unspecified':['Elettaria cardamomum','Amomum subulatum'],
 'chilli':['Capsicum annuum','Capsicum frutescens'],
 'cinnamon':['Cinnamomum verum','Cinnamomum cassia'],
 'coffee':['Coffea arabica','Coffea canephora'],
 'cotton':['Gossypium hirsutum','Gossypium barbadense','Gossypium arboreum','Gossypium herbaceum'],
 'dhaincha':['Sesbania bispinosa','Sesbania cannabina'],
 'indian-colza':['Brassica campestris'],
 'jute':['Corchorus capsularis'],
 'kiwifruit':['Actinidia chinensis','Actinidia arguta'],
 'mint':['Mentha arvensis var. piperascens','Mentha piperita','Mentha spicata var. crispa'],
 'mustard':['Brassica juncea','Brassica napus','Brassica nigra'],
 'orange-unspecified':['Citrus sinensis','Citrus reticulata'],
 'pear':['Pyrus communis','Pyrus pyrifolia'],
 'plum':['Prunus salicina','Prunus domestica'],
 'pumpkin':['Cucurbita moschata','Cucurbita maxima','Cucurbita pepo'],
 'sugarcane':['Saccharum officinarum','Saccharum barberi','Saccharum sinense'],
 'wheat':['Triticum aestivum','Triticum durum'],
 'sweet-lime':['Citrus sinensis'],
 'capsicum-unspecified':['Capsicum annuum'],
 'yam':['Dioscorea alata','Dioscorea esculenta','Dioscorea rotundata']}
variant_keys={}
for parent,names in variant_names.items():
 for name in names:
  if name.casefold() not in byname:continue
  key='__variant__'+parent+'__'+name
  variant_keys[key]=parent
  profiles[key]={'profileId':key,'botanicalName':name,'sourceCommodities':[],'identityStatus':'species_reference_only','ecocrop':None,'regionalEvidence':[],'gaps':[]}
def num(r,k):
 s=r.get(k,'').strip()
 if s in ('','NA'):return None
 try:return float(s)
 except ValueError:return None
def rng(r,keys):return dict(zip(['optimalMin','optimalMax','absoluteMin','absoluteMax'],[num(r,k) for k in keys]))
def txt(r,k):return r.get(k,'').strip() or None
def cats(r,k,other):return {'optimal':txt(r,k),'absolute':txt(r,other)}
for p in profiles.values():
 n=p['botanicalName'] or '';r=byname.get(aliases.get(n,n).casefold())
 if r:
  q=[];pars={'temperatureC':rng(r,['TOPMN','TOPMX','TMIN','TMAX']),'annualRainfallMm':rng(r,['ROPMN','ROPMX','RMIN','RMAX']),'soilPh':rng(r,['PHOPMN','PHOPMX','PHMIN','PHMAX']),'soilTexture':cats(r,'TEXT','TEXTR'),'soilDepth':cats(r,'DEP','DEPR'),'soilSalinity':cats(r,'SAL','SALR'),'soilDrainage':cats(r,'DRA','DRAR'),'soilFertility':cats(r,'FER','FERR'),'soilAluminiumToxicity':cats(r,'TOX','TOXR'),'light':{'optimalMin':txt(r,'LIOPMN'),'optimalMax':txt(r,'LIOPMX'),'absoluteMin':txt(r,'LIMN'),'absoluteMax':txt(r,'LIMX')},'photoperiod':txt(r,'PHOTO'),'climateZones':txt(r,'CLIZ'),'lifeSpan':txt(r,'LISPA'),'cropCycleDays':{'min':num(r,'GMIN'),'max':num(r,'GMAX')},'altitudeMaxM':num(r,'ALTMX'),'killingTemperatureC':{'rest':num(r,'KTMPR'),'earlyGrowth':num(r,'KTMP')},'abioticTolerances':txt(r,'ABITOL'),'abioticSusceptibilities':txt(r,'ABISUS')}
  for key in ['temperatureC','annualRainfallMm','soilPh']:
   vals=pars[key]
   for a,b in [('optimalMin','optimalMax'),('absoluteMin','absoluteMax')]:
    if vals[a] is not None and vals[b] is not None and vals[a]>vals[b]:q.append(key+': reversed source bounds')
   if all(vals[v] is not None for v in ['optimalMin','optimalMax','absoluteMin','absoluteMax']) and not (vals['absoluteMin']<=vals['optimalMin']<=vals['optimalMax']<=vals['absoluteMax']):q.append(key+': optimal bounds not nested in absolute bounds')
   if key=='annualRainfallMm' and any(v is not None and v<0 for v in vals.values()):q.append('annualRainfallMm: negative source value')
   if key=='soilPh' and any(v is not None and not 0<=v<=14 for v in vals.values()):q.append('soilPh: outside physical bounds')
   if key=='temperatureC' and any(v is not None and not -60<=v<=70 for v in vals.values()):q.append('temperatureC: implausible source bound')
  if pars['cropCycleDays']['min'] is not None and pars['cropCycleDays']['min']<0:q.append('cropCycleDays: negative minimum')
  if pars['cropCycleDays']['max'] is not None and pars['cropCycleDays']['max']<0:q.append('cropCycleDays: negative maximum')
  if all(v is not None for v in pars['cropCycleDays'].values()) and pars['cropCycleDays']['min']>pars['cropCycleDays']['max']:q.append('cropCycleDays: reversed source bounds')
  p['ecocrop']={'matchingEligible':False,'matchingPolicy':'Reference envelope only; require a separately reviewed method/region/product-specific matching rule. Flagged source values must never drive matching.','ecoportCode':r['EcoPortCode'],'sourceUrl':'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id='+r['EcoPortCode'],'evidenceType':'legacy_global_ecological_reference','sourceScientificName':r['ScientificName'],'scientificNameJoin':'exact' if n==r['ScientificName'] else 'explicit_legacy_synonym_or_spelling','parameters':pars,'qualityFlags':q,'limitations':['Expert-compiled global ecological reference; maintenance discontinued around 2015, not a current local trial or parcel measurement.','Annual rainfall is not crop-cycle water need or net irrigation.','Crop-cycle envelope is not a cultivar/local planting calendar; perennial 365-day records do not mean first harvest in one year.','pH method and salinity extract are unspecified; do not compare blindly to laboratory-method-specific thresholds.','Qualitative fertility is not a numeric N/P/K/OC target or fertilizer dose.']}
  p['identityStatus']='species_reference_available' if p['identityStatus']=='species_candidate' else p['identityStatus']
 else:p['gaps'].append('No exact supported EcoCrop species join; a neighbouring species was not substituted.')
 p['gaps'].extend(['No universal crop-specific soil OC/N/P/K/micronutrient concentration target established.','No field-specific fertilizer prescription.','No measured farm soil or multi-year satellite study in this profile.'])
for key,parent in variant_keys.items():
 ref=profiles.pop(key)
 if ref['ecocrop']:
  profiles[parent].setdefault('ecocropVariants',[]).append({'botanicalName':ref['botanicalName'],'identitySelected':False,'applicability':'Species reference only; source commodity does not identify this species. Require species/product confirmation before matching.','reference':ref['ecocrop']})
regional=ROOT/'tnau-regional-evidence.json'
if regional.exists():
 for e in json.loads(regional.read_text())['profiles']:
  if e['profileId'] in profiles:profiles[e['profileId']]['regionalEvidence'].extend(e['evidence'])
 else:pass
additional=ROOT/'additional-primary-evidence.json'
if additional.exists():
 for e in json.loads(additional.read_text())['profiles']:
  if e['profileId'] not in profiles:raise ValueError('Unknown augmented profile '+e['profileId'])
  profiles[e['profileId']]['regionalEvidence'].extend(e['evidence'])
 for e in json.loads(additional.read_text()).get('identityEvidence',[]):
  profiles[e['profileId']].setdefault('identityEvidence',[]).append(e)
out={'schemaVersion':'1.0','retrievedAt':datetime.now(timezone.utc).isoformat(),'sources':[{'id':'fao-ecocrop-archive','publisher':'FAO','title':'EcoCrop legacy ecological requirements','origin':'https://www.fao.org/geospatial/data-and-tools/data-portals/ecocrop/','archiveUrl':'https://github.com/OpenCLIM/ecocrop/blob/ea43ecd418fd1a1ea08d32c7dce64b7fae02dec4/EcoCrop_DB.csv','processorMetadata':'https://cgiar-climate-data-hub.github.io/catalog/ecocrop/','license':'CC-BY-4.0 as stated by source processor metadata; retain FAO attribution and no-endorsement statement','attribution':'Source data from the FAO EcoCrop database, Food and Agriculture Organization of the United Nations.','rawSha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'rawRows':len(rows),'sourceMaintenance':'Discontinued around 2015; accessible archive, not live agronomic observations.'}],'profiles':sorted(profiles.values(),key=lambda x:x['profileId']),'commodityIdentities':identities,'coverage':{'observedCommodityNames':len(identities),'distinctProfileGroups':len(profiles),'profilesWithEcocrop':sum(p['ecocrop'] is not None for p in profiles.values()),'profilesWithEcocropVariants':sum(bool(p.get('ecocropVariants')) for p in profiles.values()),'profilesWithAnyEcologicalReference':sum(bool(p['ecocrop'] or p.get('ecocropVariants')) for p in profiles.values()),'profilesWithRegionalEvidence':sum(bool(p['regionalEvidence']) for p in profiles.values()),'profilesWithSourceQualityFlags':sum(bool((p['ecocrop'] and p['ecocrop']['qualityFlags']) or any(v['reference']['qualityFlags'] for v in p.get('ecocropVariants',[]))) for p in profiles.values()),'completeAgronomicCoverage':False}}
out['soilTypeReferences']=json.loads((ROOT/'soil-type-references.json').read_text())['references']
out['coverage']['soilTypeReferences']=len(out['soilTypeReferences'])
out['coverage']['regionalEvidenceFacts']=sum(len(p['regionalEvidence']) for p in profiles.values())
(ROOT/'crop-profiles.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(out['coverage']))
