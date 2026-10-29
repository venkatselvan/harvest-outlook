// Derive screening rules from the crop-catalogue profiles (T06b).
// Usage: pnpm --filter @harvest/scripts exec tsx catalogue/derive-rules.ts
//
// Rule semantics (a sourced planting window is not proof that planting outside it is impossible):
//   in window      -> effect `eligible`
//   outside window -> effect `requires_review` (never `ineligible`)
// Contexts are grouped by (crop, region scope, irrigation scope) and their months unioned, so a crop with
// several seasons in one place yields ONE eligible rule and ONE complementary review rule. Separate rules per season
// would contradict each other (the engine lets any requires_review override eligible).
// Review status: `approved` only by the mechanical rule "derived 1:1 from a verified excerpt that names the window's
// start and end month"; reviewer 'mechanical_derivation'. Irrigation rules rest on interpretation of the text
// and stay `candidate`. Ginger already has reviewed rules (ginger.rules.json), so it is skipped here.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CropRule, EVIDENCE_DIR, MANIFEST_DIR, PROFILE_DIR, ROOT, readJson, SCHEMA_VERSION } from './common.ts';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SKIP_CROPS = new Set(['ginger']);
type Ctx = any;

const span = (from: number, to: number) => {
  const out: number[] = [];
  for (let m = from; ; m = (m % 12) + 1) { out.push(m); if (m === to) break; }
  return out;
};
const namesMonth = (text: string, m: number) => new RegExp(`\\b${MONTHS[m - 1]}`, 'i').test(text);
const irrScope = (irr: string): string[] => (irr === 'rainfed' || irr === 'irrigated' || irr === 'supplemental' ? [irr] : []);

interface Group { cropId: string; regionIds: string[]; irrigation: string[]; months: Set<number>; evidenceIds: Set<string>; contextIds: string[]; allMonthsExplicit: boolean }
const groups = new Map<string, Group>();
const irrRows = new Map<string, { cropId: string; regionIds: string[]; irr: Set<string>; evidenceIds: Set<string>; contextIds: string[] }>();
const skipped: string[] = [];
const evText = new Map<string, string>();
for (const f of readdirSync(EVIDENCE_DIR).filter((x) => x.endsWith('.json'))) for (const e of readJson<any[]>(join(EVIDENCE_DIR, f))) evText.set(e.id, e.content.text);

for (const f of readdirSync(PROFILE_DIR).filter((x) => x.endsWith('.json'))) {
  const p = readJson<any>(join(PROFILE_DIR, f));
  if (SKIP_CROPS.has(p.cropId)) { skipped.push(`${p.cropId}: reviewed rules exist (ginger.rules.json)`); continue; }
  for (const c of p.regionalContexts as Ctx[]) {
    const regionIds: string[] = c.geography.ids;
    if (regionIds.some((r) => r.startsWith('IN-region-'))) { skipped.push(`${c.contextId}: agro-region ${regionIds.join(',')} has no sourced member list, cannot match a state or district`); continue; }
    const w = c.plantingWindow;
    const key = [p.cropId, [...regionIds].sort().join('+'), irrScope(c.irrigation).join('') || 'any'].join('|');
    const g = groups.get(key) ?? { cropId: p.cropId, regionIds: [...regionIds].sort(), irrigation: irrScope(c.irrigation), months: new Set<number>(), evidenceIds: new Set<string>(), contextIds: [], allMonthsExplicit: true };
    span(w.fromMonth, w.toMonth).forEach((m) => g.months.add(m));
    w.evidenceIds.forEach((e: string) => g.evidenceIds.add(e));
    g.contextIds.push(c.contextId);
    const text = w.evidenceIds.map((e: string) => evText.get(e) ?? '').join(' ');
    if (!(namesMonth(text, w.fromMonth) && namesMonth(text, w.toMonth))) g.allMonthsExplicit = false;
    groups.set(key, g);
    const rk = [p.cropId, [...regionIds].sort().join('+')].join('|');
    const row = irrRows.get(rk) ?? { cropId: p.cropId, regionIds: [...regionIds].sort(), irr: new Set<string>(), evidenceIds: new Set<string>(), contextIds: [] };
    row.irr.add(c.irrigation); c.irrigationEvidenceIds.forEach((e: string) => row.evidenceIds.add(e)); row.contextIds.push(c.contextId);
    irrRows.set(rk, row);
  }
}

const rules: any[] = [];
const provenance: Record<string, any> = {};
const slugKey = (ids: string[]) => ids.map((i) => i.replace(/^IN-/, '').toLowerCase()).join('_');
// States that have their own group for a crop: the national group must not also apply there.
const specificStates = (cropId: string) => [...new Set([...groups.values()].filter((g) => g.cropId === cropId && !g.regionIds.includes('IN')).flatMap((g) => g.regionIds))];

const base = (g: { cropId: string }, id: string, scope: any, when: any, effect: any, evidenceIds: string[], reviewStatus: string) => ({
  schemaVersion: SCHEMA_VERSION, id, version: 1, mode: 'live', cropId: g.cropId, productId: null, scope, when, exceptions: [], effect, alternatives: [], evidenceIds, reviewStatus,
});

for (const g of groups.values()) {
  const months = [...g.months].sort((a, b) => a - b);
  const tag = `rule.cat.${g.cropId}.${slugKey(g.regionIds)}${g.irrigation.length ? '.' + g.irrigation[0] : ''}`;
  const scope = { regionIds: g.regionIds, seasons: [], irrigation: g.irrigation };
  const inWin = { field: 'planting.month', op: 'in', value: months };
  const guard = g.regionIds.includes('IN') ? specificStates(g.cropId) : [];
  const notElsewhere = guard.length ? { not: { field: 'location.stateId', op: 'in', value: guard } } : null;
  const wrap = (c: any) => (notElsewhere ? { all: [notElsewhere, c] } : c);
  const status = g.allMonthsExplicit ? 'approved' : 'candidate';
  const ev = [...g.evidenceIds].sort();
  rules.push(base(g, `${tag}.planting-in-window`, scope, wrap(inWin), { type: 'eligible', reasonCode: 'planting_in_sourced_window' }, ev, status));
  rules.push(base(g, `${tag}.planting-outside-window`, scope, wrap({ not: inWin }), { type: 'requires_review', reasonCode: 'planting_outside_sourced_window' }, ev, status));
  for (const id of [`${tag}.planting-in-window`, `${tag}.planting-outside-window`]) {
    provenance[id] = { reviewer: status === 'approved' ? 'mechanical_derivation' : null, derivedFromContexts: g.contextIds, months, basis: status === 'approved' ? 'derived 1:1 from verified excerpts that name the start and end month of each context window' : 'excerpt does not name start and end months explicitly; needs human review' };
  }
}
for (const r of irrRows.values()) {
  if (r.regionIds.some((x) => x.startsWith('IN-region-'))) continue;
  const only = r.irr.size === 1 ? [...r.irr][0]! : null;
  const tag = `rule.cat.${r.cropId}.${slugKey(r.regionIds)}`;
  const scope = (irrigation: string[]) => ({ regionIds: r.regionIds, seasons: [], irrigation });
  const ev = [...r.evidenceIds].sort();
  if (only === 'irrigated') {
    const id = `${tag}.source-irrigated-only`;
    rules.push(base(r, id, scope(['rainfed']), { field: 'irrigation.category', op: 'eq', value: 'rainfed' }, { type: 'requires_review', reasonCode: 'source_describes_irrigated_cultivation_only' }, ev, 'candidate'));
    provenance[id] = { reviewer: null, derivedFromContexts: r.contextIds, basis: 'interpretation of the irrigation text; a source describing irrigated cultivation does not prove rainfed cultivation is impossible' };
  } else if (only === 'rainfed') {
    const id = `${tag}.source-rainfed-only`;
    rules.push(base(r, id, scope(['irrigated']), { field: 'irrigation.category', op: 'eq', value: 'irrigated' }, { type: 'caution', reasonCode: 'source_describes_rainfed_cultivation_only' }, ev, 'candidate'));
    provenance[id] = { reviewer: null, derivedFromContexts: r.contextIds, basis: 'interpretation of the irrigation text' };
  }
}

const bad: string[] = [];
const seen = new Set<string>();
for (const r of rules) {
  const v = CropRule.safeParse(r);
  if (!v.success) bad.push(`${r.id}: ${v.error.message.slice(0, 200)}`);
  if (seen.has(r.id)) bad.push(`duplicate ${r.id}`);
  seen.add(r.id);
  for (const e of r.evidenceIds) if (!evText.has(e)) bad.push(`${r.id}: unknown evidence ${e}`);
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
const count = (s: string) => rules.filter((r) => r.reviewStatus === s).length;
const summary = { total: rules.length, approved: count('approved'), candidate: count('candidate'), crops: new Set(rules.map((r) => r.cropId)).size, skipped };
writeFileSync(join(ROOT, 'data', 'curated', 'rules', 'catalogue.planting-window.rules.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedBy: 'scripts/catalogue/derive-rules.ts', reviewerOfApproved: 'mechanical_derivation', note: 'Approved = derived 1:1 from a verified excerpt naming the start and end months. Not human-reviewed. Outside-window and irrigation-mismatch effects are requires_review/caution, never ineligible.', summary, provenance, rules }, null, 1) + '\n');
console.log(JSON.stringify(summary, null, 1));

// Patch screening coverage rows (written by build.ts with zero rules) with the measured rule counts.
// Run order: build.ts -> derive-rules.ts. 'partial' stays: no labelled checks have passed.
const covPath = join(MANIFEST_DIR, 'coverage.json');
const cov = readJson<any>(covPath);
const gingerRules = readJson<any[]>(join(ROOT, 'data', 'curated', 'rules', 'ginger.rules.json'));
const allRules = [...rules, ...gingerRules];
let patched = 0;
for (const r of cov.records) {
  if (r.capability !== 'screening_supported' || !r.measuredQuality) continue;
  const applicable = allRules.filter((x) => x.cropId === r.cropId && x.scope.regionIds.some((id: string) => id === 'IN' || r.region.ids.includes(id)));
  r.measuredQuality = { ...r.measuredQuality, approvedRules: applicable.filter((x) => x.reviewStatus === 'approved').length, candidateRules: applicable.filter((x) => x.reviewStatus === 'candidate').length };
  r.missingReason = applicable.length ? 'rules_mechanically_derived_or_model_labelled_no_human_review_no_labelled_checks' : 'agronomy_sourced_rules_not_yet_encoded_or_labelled';
  patched++;
}
writeFileSync(covPath, JSON.stringify(cov, null, 2) + '\n');
console.log(`screening coverage rows patched: ${patched}`);
