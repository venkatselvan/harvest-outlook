// Validate catalogue artefacts. Run: packages/contracts/node_modules/.bin/tsx scripts/catalogue/validate.ts
// (the repo root has no tsx/zod dependency; `pnpm tsx scripts/catalogue/validate.ts` works once the root adds tsx and this dir is a workspace member.)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CoverageRecord, CropIdentity, CropProduct, EvidenceRecord, EVIDENCE_DIR, MANIFEST_DIR, PROFILE_DIR, RAW_DIR, normaliseForMatch, readJson } from './common.ts';
import { CropProfile } from './profile-schema.ts';
import { SOURCES } from './sources.ts';

// data/raw/ (saved source pages) is gitignored; without it the excerpt-in-source check is skipped, everything else still runs.
const rawAvailable = existsSync(RAW_DIR);
const errors: string[] = [];
const err = (m: string) => errors.push(m);

const idf = readJson<any>(join(MANIFEST_DIR, 'crop-identities.json'));
const cov = readJson<any>(join(MANIFEST_DIR, 'coverage.json'));
const identities = new Map<string, any>();
for (const i of idf.identities) { const r = CropIdentity.safeParse(i); if (!r.success) err(`identity ${i.id}: ${r.error.message.slice(0, 300)}`); identities.set(i.id, i); }
const productIds = new Set<string>();
for (const p of idf.products) { const r = CropProduct.safeParse(p); if (!r.success) err(`product ${p.id}: ${r.error.message.slice(0, 300)}`); productIds.add(p.id); if (!identities.get(p.cropId)?.productIds.includes(p.id)) err(`product ${p.id} not listed on identity ${p.cropId}`); }
for (const i of idf.identities) for (const pid of i.productIds) if (!productIds.has(pid)) err(`identity ${i.id} references missing product ${pid}`);
const covIds = new Set<string>();
for (const r of cov.records) {
  const v = CoverageRecord.safeParse(r); if (!v.success) err(`coverage ${r.id}: ${v.error.message.slice(0, 300)}`);
  if (covIds.has(r.id)) err(`duplicate coverage id ${r.id}`); covIds.add(r.id);
  if (!identities.has(r.cropId)) err(`coverage ${r.id}: unknown crop`);
  if (r.productId && !productIds.has(r.productId)) err(`coverage ${r.id}: unknown product`);
}

// Evidence
const evidence = new Map<string, any>();
let exOk = 0, exTotal = 0;
const textCache = new Map<string, string>();
const srcText = (url: string) => {
  if (!rawAvailable) return null;
  const s = SOURCES.find((x) => x.url === url)!; if (!s) return null;
  if (!textCache.has(s.key)) textCache.set(s.key, normaliseForMatch(readFileSync(join(RAW_DIR, `${s.key}.txt`), 'utf8')));
  return textCache.get(s.key)!;
};
for (const f of readdirSync(EVIDENCE_DIR).filter((x) => x.endsWith('.json'))) {
  for (const e of readJson<any[]>(join(EVIDENCE_DIR, f))) {
    const r = EvidenceRecord.safeParse(e); if (!r.success) err(`evidence ${e.id}: ${r.error.message.slice(0, 300)}`);
    if (evidence.has(e.id)) err(`duplicate evidence ${e.id}`); evidence.set(e.id, e);
    exTotal++;
    const t = srcText(e.sourceUrl);
    const words = e.content.text.trim().split(/\s+/).length;
    if (!rawAvailable) continue;
    if (t && t.includes(normaliseForMatch(e.content.text)) && words <= 60) exOk++; else err(`excerpt check failed: ${e.id}`);
  }
}
// Profiles
const rows: string[][] = [];
let qualified = 0;
const profileFiles = readdirSync(PROFILE_DIR).filter((x) => x.endsWith('.json'));
for (const f of profileFiles) {
  const p = readJson<any>(join(PROFILE_DIR, f));
  const r = CropProfile.safeParse(p); if (!r.success) { err(`profile ${f}: ${r.error.message.slice(0, 400)}`); continue; }
  if (!identities.has(p.identityRef)) err(`profile ${p.cropId}: identityRef missing`);
  const idProducts = identities.get(p.cropId)?.productIds ?? [];
  if (JSON.stringify(p.products.map((x: any) => x.productId)) !== JSON.stringify(idProducts)) err(`profile ${p.cropId}: products differ from identity`);
  const refs: string[] = [...p.evidenceIds];
  for (const c of p.regionalContexts) {
    refs.push(...c.plantingWindow.evidenceIds, ...c.irrigationEvidenceIds, ...(c.durationDays?.evidenceIds ?? []), ...(c.soilNotes?.evidenceIds ?? []), ...(c.yieldReference?.evidenceIds ?? []));
    if (c.stateId === 'IN-TN' && evidence.get(c.plantingWindow.evidenceIds[0])?.geography.ids[0] !== 'IN-TN') err(`${c.contextId}: TN stateId without TN-scoped evidence`);
    for (const eid of c.plantingWindow.evidenceIds) { const g = evidence.get(eid)?.geography; if (g && c.geography.level === 'state' && g.level === 'state' && g.ids[0] !== c.stateId) err(`${c.contextId}: evidence geography ${g.ids} != context ${c.stateId}`); }
    if (c.durationDays && c.durationDays.min !== null && c.durationDays.max !== null && c.durationDays.min > c.durationDays.max) err(`${c.contextId}: duration min>max`);
    if (c.yieldReference && c.yieldReference.min > c.yieldReference.max) err(`${c.contextId}: yield min>max`);
  }
  for (const c of p.exclusionsOrCautions) refs.push(...c.evidenceIds);
  for (const id of refs) if (!evidence.has(id)) err(`profile ${p.cropId}: dangling evidenceId ${id}`);
  const q = p.qualification; if (q.qualified) qualified++;
  const tnOnly = p.regionalContexts.every((c: any) => c.stateId === 'IN-TN');
  const nonTn = p.regionalContexts.filter((c: any) => c.stateId !== 'IN-TN').length;
  rows.push([p.cropId, q.qualified ? 'y' : 'n', q.missing.join('; ') || '-', String(p.regionalContexts.length), tnOnly ? 'TN-only' : `${nonTn} non-TN`]);
}
// Botanical name presence in saved pages (informational)
const botanicalHits: string[] = [];
for (const [id, i] of identities) {
  const bin = normaliseForMatch((i.botanicalName as string).split(' ').slice(0, 2).join(' '));
  const hit = SOURCES.filter((s) => s.cropIds.includes(id) && existsSync(join(RAW_DIR, `${s.key}.txt`))).some((s) => normaliseForMatch(readFileSync(join(RAW_DIR, `${s.key}.txt`), 'utf8')).includes(bin));
  botanicalHits.push(`${id}:${hit ? 'on-page' : 'unsourced'}`);
}
if (identities.size !== 25 || profileFiles.length !== 25) err(`expected 25 crops/profiles, got ${identities.size}/${profileFiles.length}`);
console.log('crop | qualified | missing | contexts | coverage');
for (const r of rows.sort((a, b) => a[0].localeCompare(b[0]))) console.log(r.join(' | '));
console.log(`\nqualified ${qualified}/${profileFiles.length}; identities ${identities.size}; products ${productIds.size}; coverage rows ${cov.records.length}; evidence ${evidence.size}`);
if (rawAvailable) console.log(`excerpt check ${exOk}/${exTotal} pass`);
else console.log(`excerpt check skipped: data/raw/crops not present (private source pages; see RUN_LOCAL.md); grounding count: skipped (${exTotal} excerpts not checked)`);
if (rawAvailable) console.log(`botanical name found on a saved page: ${botanicalHits.filter((x) => x.endsWith('on-page')).length}/${botanicalHits.length}; unsourced -> ${botanicalHits.filter((x) => x.endsWith('unsourced')).map((x) => x.split(':')[0]).join(', ')}`);
if (errors.length) { console.log(`\nERRORS (${errors.length}):\n` + errors.join('\n')); process.exit(1); }
console.log('validation OK');
