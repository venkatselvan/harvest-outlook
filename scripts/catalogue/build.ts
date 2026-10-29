// Build catalogue artefacts from authoring.ts + saved raw pages (data/raw/crops, gitignored).
// Usage: packages/contracts/node_modules/.bin/tsx scripts/catalogue/build.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_DIR, MANIFEST_DIR, PROFILE_DIR, RAW_DIR, normaliseForMatch, SCHEMA_VERSION } from './common.ts';
import { CROPS, type Crop } from './authoring.ts';
import { SOURCES } from './sources.ts';
import type { CropProfile } from './profile-schema.ts';

const NOW = new Date().toISOString();
const wordCount = (s: string) => s.trim().split(/\s+/).length;
const srcByKey = new Map(SOURCES.map((s) => [s.key, s]));
const cache = new Map<string, { meta: any; text: string; pages: string[] }>();
function loadSrc(key: string) {
  if (!cache.has(key)) {
    const meta = JSON.parse(readFileSync(join(RAW_DIR, `${key}.meta.json`), 'utf8'));
    const text = readFileSync(join(RAW_DIR, `${key}.txt`), 'utf8');
    cache.set(key, { meta, text, pages: text.split('\f').map(normaliseForMatch) });
  }
  return cache.get(key)!;
}

let checked = 0;
const failures: string[] = [];
const evId = (c: string, k: string) => `cat.${c}.${k}`;

function buildEvidence(c: Crop) {
  return Object.entries(c.ev).map(([k, ev]) => {
    const s = srcByKey.get(ev.src);
    if (!s) throw new Error(`unknown source ${ev.src}`);
    const { meta, pages } = loadSrc(ev.src);
    const needle = normaliseForMatch(ev.text);
    const pageIdx = pages.findIndex((p) => p.includes(needle));
    checked++;
    if (pageIdx < 0 || wordCount(ev.text) > 60) failures.push(`${c.id}.${k} [${ev.src}] ${pageIdx < 0 ? 'NOT FOUND' : '>60 words'}: ${ev.text.slice(0, 80)}`);
    const isPdf = /pdf/i.test(meta.contentType) || meta.url.endsWith('.pdf');
    const geoLevel = s.scope.level;
    return {
      schemaVersion: SCHEMA_VERSION,
      id: evId(c.id, k),
      mode: 'live',
      sourceUrl: s.url,
      publisher: s.publisher,
      documentTitle: s.title,
      documentVersion: s.key.startsWith('aau-') ? '2021' : null,
      contentHash: meta.sha256,
      locator: isPdf && pageIdx >= 0 ? { page: pageIdx + 1, section: ev.section } : { section: ev.section },
      content: { kind: 'excerpt', text: ev.text, language: 'en' },
      publishedAt: null,
      availability: { effectiveAvailableAt: meta.fetchedAt, basis: 'first_observed' },
      ingestedAt: meta.fetchedAt,
      revisedAt: null,
      geography: { level: geoLevel, ids: s.scope.ids },
      cropIds: [c.id],
      productIds: [],
      units: [],
      sourceUnits: [],
      licence: { licence: 'Public web page; publisher copyright. Excerpt (<=60 words) kept for provenance, full page not redistributed.', accessStatus: 'open', redistributable: false, attribution: s.publisher },
      extraction: { method: isPdf ? 'native_text' : 'manual', version: 'catalogue-build-1', reviewedBy: 'rule_check' },
      validationStatus: 'pending',
    };
  });
}

function buildProfile(c: Crop): CropProfile {
  const id = (k: string) => evId(c.id, k);
  const used = new Set<string>();
  const ids = (ks: string[]) => ks.map((k) => { if (!c.ev[k]) throw new Error(`${c.id}: missing ev ${k}`); used.add(k); return id(k); });
  const contexts = c.contexts.map((x) => {
    const stateId = x.geo[0] === 'state' && x.geo[1].length === 1 ? x.geo[1][0] : null;
    const prod = (suffix: string) => { if (!c.products.some((p) => p[0] === suffix)) throw new Error(`${c.id}: bad product ${suffix}`); return suffix; };
    return {
      contextId: x.id,
      geography: { level: x.geo[0], ids: x.geo[1] },
      stateId,
      districtIds: null,
      season: x.season,
      plantingWindow: { fromMonth: x.plant[0], toMonth: x.plant[1], evidenceIds: ids([x.plant[2]]) },
      durationDays: x.dur ? { min: x.dur[0], max: x.dur[1], evidenceIds: ids(x.dur[2]) } : null,
      irrigation: x.irr,
      irrigationEvidenceIds: x.irrEv ? ids([x.irrEv]) : [],
      waterNeedClass: null,
      soilNotes: x.soil ? { text: x.soil[0], evidenceIds: ids([x.soil[1]]) } : null,
      yieldReference: x.yld ? { min: x.yld[0], max: x.yld[1], unit: 'kg/ha' as const, basis: 'regional_reference' as const, productId: prod(x.yld[3]), evidenceIds: ids([x.yld[2]]) } : null,
      labourClass: null,
      harvestPattern: x.harvest ?? 'single',
      notes: x.notes ?? '',
    };
  });
  const cautions = (c.cautions ?? []).map(([text, k]) => ({ text, evidenceIds: ids([k]) }));
  // Requirement types per context: duration, soil, water/irrigation evidence, yield.
  const reqCount = (x: (typeof contexts)[number]) => [x.durationDays, x.soilNotes, x.irrigationEvidenceIds.length ? 1 : null, x.yieldReference].filter(Boolean).length;
  const hasReq = contexts.some((x) => reqCount(x) >= 2);
  const hasCtx = contexts.length > 0;
  const hasSeason = contexts.some((x) => x.plantingWindow.evidenceIds.length > 0);
  const missing: string[] = [];
  if (!hasCtx) missing.push('regional_context');
  if (!hasReq) missing.push('sourced_requirements: need >=2 of duration/soil/irrigation/yield in one context (have max ' + Math.max(0, ...contexts.map(reqCount)) + ')');
  if (!hasSeason) missing.push('season_info');
  for (const k of Object.keys(c.ev)) if (!used.has(k)) console.warn(`note: ${c.id} evidence ${k} supports harvestPattern/notes only`);
  return {
    cropId: c.id,
    identityRef: c.id,
    group: c.group,
    products: c.products.map(([productId, name, productBasis]) => ({ productId, name, productBasis })),
    regionalContexts: contexts,
    exclusionsOrCautions: cautions,
    marketCoverageStatus: 'unavailable_pending_price_access',
    evidenceIds: Object.keys(c.ev).map(id),
    qualification: { identityResolved: true, hasRegionalContext: hasCtx, hasSourcedRequirements: hasReq, hasSeasonInfo: hasSeason, marketStatusExplicit: true, qualified: hasCtx && hasReq && hasSeason, missing },
  } as CropProfile;
}

function buildIdentities() {
  const products: any[] = [];
  const identities = CROPS.map((c) => {
    const aliasObjs = (c.aliases ?? []).map(([text, kind, src]) => ({ text, language: 'en', kind, sourceIds: [src] }));
    for (const [productId, name, basis] of c.products) {
      products.push({ schemaVersion: SCHEMA_VERSION, id: productId, cropId: c.id, name, productBasis: basis, grade: null, aliases: [], massUnit: 'kg', priceUnit: 'INR/kg', sourceMappings: [], mode: 'live' });
    }
    return {
      schemaVersion: SCHEMA_VERSION, id: c.id, botanicalName: c.botanical,
      commonNames: [{ text: c.name, language: 'en', kind: 'common', sourceIds: [] }],
      aliases: aliasObjs, varieties: [], productIds: c.products.map((p) => p[0]), sourceMappings: [], mode: 'live',
    };
  });
  return { identities, products };
}

function buildCoverage(profiles: CropProfile[]) {
  const rows: any[] = [];
  const common = (cropId: string) => ({ schemaVersion: SCHEMA_VERSION, mode: 'live', cropId, assessedAt: NOW, reviewBy: '2027-04-30', expiresAt: null, modelVersions: [] as string[] });
  const hashes = (c: Crop) => [...new Set(Object.values(c.ev).map((e) => loadSrc(e.src).meta.sha256.slice(0, 16)))].map((h) => `sha256:${h}`);
  for (const p of profiles) {
    const c = CROPS.find((x) => x.id === p.cropId)!;
    for (const x of p.regionalContexts) {
      const n = [x.durationDays, x.soilNotes, x.irrigationEvidenceIds.length ? 1 : null, x.yieldReference].filter(Boolean).length;
      const ok = n >= 2;
      rows.push({
        ...common(p.cropId), id: `cov.screening.${x.contextId}`, capability: 'screening_supported', productId: null,
        region: { level: x.geography.level, ids: x.geography.ids }, season: x.season, irrigation: x.irrigation, marketId: null, horizonDays: null,
        supportStatus: ok ? 'partial' : 'unknown', sourceVersions: hashes(c),
        measuredQuality: ok ? { approvedRules: 0, candidateRules: 0, labelledChecksPassed: 0, labelledChecksTotal: 0 } : null,
        missingReason: ok ? 'agronomy_sourced_rules_not_yet_encoded_or_labelled' : 'fewer_than_two_sourced_requirements_in_context',
      });
    }
    for (const prod of p.products) {
      for (const [cap, reason] of [['historical_reference_available', 'price_access_key_gated'], ['forecast_evaluated', 'no_evaluated_model_and_no_price_history']] as const) {
        rows.push({
          ...common(p.cropId), id: `cov.${cap}.${prod.productId}`, capability: cap, productId: prod.productId,
          region: { level: 'national', ids: ['IN'] }, season: null, irrigation: null, marketId: null, horizonDays: null,
          supportStatus: 'unsupported', sourceVersions: [], measuredQuality: null, missingReason: reason,
        });
      }
    }
    const ginger = p.cropId === 'ginger';
    rows.push({
      ...common(p.cropId), id: `cov.visual_journey_supported.${p.cropId}`, capability: 'visual_journey_supported', productId: null,
      region: { level: 'national', ids: ['IN'] }, season: null, irrigation: null, marketId: null, horizonDays: null,
      supportStatus: ginger ? 'partial' : 'unsupported', sourceVersions: [],
      measuredQuality: ginger ? { stagesSourced: 0, stagesTotal: 0, assetsQaPassed: 0, assetsTotal: 0 } : null,
      missingReason: ginger ? 'ginger_visual_journey_pending_T11_and_T05b_stage_sources' : 'no_sourced_stage_definitions_or_assets',
    });
    rows.push({
      ...common(p.cropId), id: `cov.observation_interpretation_experimental.${p.cropId}`, capability: 'observation_interpretation_experimental', productId: null,
      region: { level: 'national', ids: ['IN'] }, season: null, irrigation: null, marketId: null, horizonDays: null,
      supportStatus: 'unsupported', sourceVersions: [], measuredQuality: null, missingReason: 'pending_evaluation',
    });
  }
  return rows;
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });
const profiles: CropProfile[] = [];
let evCount = 0;
for (const c of CROPS) {
  const evidence = buildEvidence(c);
  evCount += evidence.length;
  const profile = buildProfile(c);
  profiles.push(profile);
  writeFileSync(join(PROFILE_DIR, `${c.id}.json`), JSON.stringify(profile, null, 2) + '\n');
  writeFileSync(join(EVIDENCE_DIR, `${c.id}.json`), JSON.stringify(evidence, null, 2) + '\n');
}
const { identities, products } = buildIdentities();
writeFileSync(join(MANIFEST_DIR, 'crop-identities.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedBy: 'scripts/catalogue/build.ts', note: 'Botanical names are standard taxonomy; they are not individually sourced records (see docs/CROP_CATALOGUE.md). Supersedes the T01 draft.', identities, products }, null, 2) + '\n');
writeFileSync(join(MANIFEST_DIR, 'coverage.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedBy: 'scripts/catalogue/build.ts', assessedAt: NOW, records: buildCoverage(profiles) }, null, 2) + '\n');
console.log(`evidence records ${evCount}; excerpt checks ${checked - failures.length}/${checked} pass`);
if (failures.length) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
