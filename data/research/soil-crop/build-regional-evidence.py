"""Compile manually reviewed crop-specific facts; no inferred global targets."""
from pathlib import Path
import csv,json,collections
R=Path(__file__).resolve().parent
idx={r['label']:r for r in json.loads((R/'tnau-source-index.json').read_text())['sources'] if r['status']=='retrieved_unreviewed'}
profiles=collections.defaultdict(list)
for i,r in enumerate(csv.DictReader((R/'tnau-reviewed-facts.tsv').open(),delimiter='\t')):
 s=idx[r['sourceLabel']];v=r['value']
 if r['parameter'].endswith('_range'):v=[float(t) for t in v.split(',')]
 elif r['parameter']=='temperature_reference':v=float(v)
 profiles[r['profileId']].append({'id':f'tnau-{r["profileId"]}-{i+1}','parameter':r['parameter'],'value':v,'unit':r['unit'] or None,'scope':{'geography':'Tamil Nadu extension reference unless the scope note identifies another area','cropOrProductAsPublished':r['sourceLabel'],'conditions':r['scopeNote']},'sourceUrl':s['url'],'locator':r['locator'],'sourceSha256':s['sha256'],'retrievedAt':'2026-10-30','evidenceType':'published_regional_extension_reference','reviewStatus':'source_reviewed_reference_only','executableRecommendation':False})
out={'schemaVersion':'1.0','note':'Manually summarized facts from retrieved official TNAU pages. Historic regional references, not live field observations. Quantities retain original nutrient labels; no current farm prescription. Pesticide treatment text was not imported.','profiles':[{'profileId':k,'evidence':v} for k,v in sorted(profiles.items())]}
(R/'tnau-regional-evidence.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print('profiles',len(profiles),'facts',sum(map(len,profiles.values())))
