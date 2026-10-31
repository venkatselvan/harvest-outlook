import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { CostEstimate } from '@harvest/contracts';
import { REPO_ROOT } from '../../catalogue/files';
import { ASSUMPTIONS, type CropLink, type LegumeCredit, type RotationFacts, type RotationRole } from './scoring';
import type { Season, WindowScope } from './types';

/**
 * Research data for the year-plan engine (read-only): the crop pool decision, crop agronomy (R1) and yield/cost
 * references (R2). Schemas are tolerant: unknown fields are ignored, a malformed row is skipped and recorded in
 * loadIssues(), and nothing is repaired or invented. Parsed data is cached in module scope; invalidate() clears it and
 * can inject fixtures (tests) in place of the files.
 */
export const DATA_FILES = {
  pool: 'data/research/rotation/crop-pool.json',
  agronomy: 'data/research/rotation/crop-agronomy.json',
  yieldCost: 'data/research/rotation/yield-cost.json',
} as const;

const issues: string[] = [];
export const loadIssues = (): readonly string[] => issues;

function tolerantArray<T extends z.ZodType>(schema: T, label: string) {
  return z.array(z.unknown()).default([]).transform((xs) => xs.flatMap((x, i) => {
    const r = schema.safeParse(x);
    if (r.success) return [r.data as z.output<T>];
    issues.push(`${label}[${i}] skipped: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim());
    return [];
  }));
}
/** Optional nested object: a malformed value becomes null and is recorded instead of failing the record. */
function soft<T extends z.ZodType>(schema: T, label: string) {
  return z.unknown().optional().transform((v): z.output<T> | null => {
    if (v === null || v === undefined) return null;
    const r = schema.safeParse(v);
    if (r.success) return r.data as z.output<T>;
    issues.push(`${label} ignored: ${r.error.issues[0]?.message ?? 'invalid'}`);
    return null;
  });
}
const optStr = z.string().nullable().optional();
const optNum = z.number().nullable().optional();
const yearText = z.union([z.string(), z.number()]).transform(String);

// ------------------------------------------------------------------ schemas
const PoolEntry = z.object({ cropId: z.string().min(1), productIds: z.array(z.string().min(1)).default([]), rotationRole: optStr, why: optStr });
const PoolFile = z.object({ pool: tolerantArray(PoolEntry, 'crop-pool.pool') });

const SourceInfo = z.object({ id: z.string().min(1), url: optStr, title: optStr, publisher: optStr, locator: optStr });
const DurationRow = z.object({ method: z.string().default('any'), cultivar: optStr, productId: optStr, min: optNum, max: optNum, source: optStr, note: optStr });
const WindowRow = z.object({
  region: z.string().min(1), sourceDistrict: optStr, season: z.string(),
  from: z.string().regex(/^\d{2}-\d{2}$/), to: z.string().regex(/^\d{2}-\d{2}$/),
  condition: z.string().default('any'), source: optStr, note: optStr,
  reviewStatus: optStr, evidenceType: optStr, stateFallback: z.boolean().optional(), candidateFor: optStr,
});
const LinkRow = z.object({ cropId: optStr, family: optStr, source: optStr, context: optStr, candidate: z.boolean().optional() });
const StageRow = z.object({ id: z.string(), name: z.string(), startDay: z.number(), endDay: z.number(), description: optStr });
const PhRow = z.object({ min: z.number(), max: z.number(), source: optStr });
const AgronomyCrop = z.object({
  cropId: z.string().min(1),
  family: optStr,
  botanicalName: optStr,
  productIds: z.array(z.string()).default([]),
  rotationRole: soft(z.object({ value: optStr, method: optStr, basis: optStr, sources: z.array(z.string()).optional() }), 'rotationRole'),
  nitrogenCreditKgPerHa: soft(z.object({ min: optNum, max: optNum, specificity: optStr, successorCrop: optStr, region: optStr, source: optStr, note: optStr }), 'nitrogenCreditKgPerHa'),
  waterNeedMm: soft(z.object({ min: optNum, max: optNum, source: optStr, note: optStr }), 'waterNeedMm'),
  rainfedSuitable: z.boolean().nullable().optional().catch(null),
  durationDays: tolerantArray(DurationRow, 'durationDays'),
  stages: tolerantArray(StageRow, 'stages'),
  stagesBasis: soft(z.object({ type: optStr, source: optStr, note: optStr }), 'stagesBasis'),
  sowingWindows: tolerantArray(WindowRow, 'sowingWindows'),
  recommendedPredecessors: tolerantArray(LinkRow, 'recommendedPredecessors'),
  recommendedSuccessors: tolerantArray(LinkRow, 'recommendedSuccessors'),
  avoidAfter: tolerantArray(LinkRow, 'avoidAfter'),
  phRange: soft(PhRow, 'phRange'),
  soilPhRange: soft(PhRow, 'soilPhRange'),
  sources: tolerantArray(SourceInfo, 'sources'),
});
const AgronomyFile = z.object({ sourceCatalog: tolerantArray(SourceInfo, 'sourceCatalog'), crops: tolerantArray(AgronomyCrop, 'crop-agronomy.crops') });

const YieldRow = z.object({
  region: z.string().min(1), level: optStr, season: z.string().default(''), cropYear: yearText, yieldKgPerHa: z.number().nullable(),
  basis: z.string().default(''), note: optStr, stale: z.boolean().optional(), districtYieldIndependent: z.boolean().optional(), sourceId: optStr, estimateStatus: optStr,
});
const CostRow = z.object({
  region: z.string().min(1), district: optStr, season: optStr, year: yearText.nullable().optional(), a2flPerHa: optNum, c2PerHa: optNum,
  authority: optStr, reliability: optStr, sourceId: optStr, locator: optStr, basis: optStr, figureType: optStr, costIncludes: optStr,
});
const YieldCostCrop = z.object({
  cropId: z.string().min(1),
  yields: tolerantArray(YieldRow, 'yields'),
  costs: tolerantArray(CostRow, 'costs'),
  postHarvestLossPct: soft(z.object({ value: optNum, sourceId: optStr, note: optStr }), 'postHarvestLossPct'),
  marketingCostNote: optStr,
});
const SourceMeta = z.object({ url: optStr, title: optStr, publisher: optStr, locator: optStr });
const YieldCostFile = z.object({
  crops: tolerantArray(YieldCostCrop, 'yield-cost.crops'),
  sources: z.record(z.string(), z.unknown()).default({}).transform((rec) => new Map(Object.entries(rec).flatMap(([k, v]) => {
    const r = SourceMeta.safeParse(v);
    return r.success ? [[k, r.data] as const] : [];
  }))),
  conversions: z.object({ riceToPaddy: soft(z.object({ paddyKgPerKgRiceRaw: z.number().positive(), riceKgPerKgPaddyRaw: optNum, sourceId: optStr, locator: optStr, basis: optStr }), 'riceToPaddy') }).default({ riceToPaddy: null }),
});

export type PoolEntry = z.output<typeof PoolEntry>;
export type AgronomyCrop = z.output<typeof AgronomyCrop>;
export type WindowRow = z.output<typeof WindowRow>;
export type DurationRow = z.output<typeof DurationRow>;
export type YieldRow = z.output<typeof YieldRow>;
export type CostRow = z.output<typeof CostRow>;
export type YieldCostCrop = z.output<typeof YieldCostCrop>;
type PoolData = z.output<typeof PoolFile>;
type AgronomyData = z.output<typeof AgronomyFile>;
type YieldCostData = z.output<typeof YieldCostFile>;

// ------------------------------------------------------------------ cache and fixtures
export interface DataFixtures { pool?: unknown; agronomy?: unknown; yieldCost?: unknown }
let fixtures: DataFixtures | null = null;
let cache: { pool?: PoolData; agronomy?: AgronomyData; yieldCost?: YieldCostData; agronomyIndex?: Map<string, AgronomyCrop>; ycIndex?: Map<string, YieldCostCrop>; poolIndex?: Map<string, PoolEntry>; sourceIndex?: Map<string, z.output<typeof SourceInfo>> } = {};

/** Clears the module cache. With `next`, later loads use those raw objects instead of the files (tests and replays). */
export function invalidate(next?: DataFixtures | null): void {
  cache = {};
  fixtures = next ?? null;
  issues.length = 0;
}
const readJson = (rel: string): unknown => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
export function loadPool(): PoolData { return (cache.pool ??= PoolFile.parse(fixtures?.pool ?? readJson(DATA_FILES.pool))); }
export function loadAgronomy(): AgronomyData { return (cache.agronomy ??= AgronomyFile.parse(fixtures?.agronomy ?? readJson(DATA_FILES.agronomy))); }
export function loadYieldCost(): YieldCostData { return (cache.yieldCost ??= YieldCostFile.parse(fixtures?.yieldCost ?? readJson(DATA_FILES.yieldCost))); }

const agronomyIndex = () => (cache.agronomyIndex ??= new Map(loadAgronomy().crops.map((c) => [c.cropId, c])));
const ycIndex = () => (cache.ycIndex ??= new Map(loadYieldCost().crops.map((c) => [c.cropId, c])));
const poolIndex = () => (cache.poolIndex ??= new Map(loadPool().pool.map((p) => [p.cropId, p])));
export const poolEntries = (): readonly PoolEntry[] => loadPool().pool;
export const agronomyCrop = (cropId: string): AgronomyCrop | null => agronomyIndex().get(cropId) ?? null;
export const yieldCostCrop = (cropId: string): YieldCostCrop | null => ycIndex().get(cropId) ?? null;
export const poolEntry = (cropId: string): PoolEntry | null => poolIndex().get(cropId) ?? null;

// ------------------------------------------------------------------ sources
export interface SourceRef { id: string; url: string | null; title: string | null; locator: string | null }
const validUrl = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try { return new URL(u).protocol.startsWith('http') ? u : null; } catch { return null; }
};
function sourceIndex() {
  if (cache.sourceIndex) return cache.sourceIndex;
  const m = new Map<string, z.output<typeof SourceInfo>>();
  for (const s of loadAgronomy().sourceCatalog) m.set(s.id, s);
  for (const c of loadAgronomy().crops) for (const s of c.sources) if (!m.has(s.id)) m.set(s.id, s);
  return (cache.sourceIndex = m);
}
/** Splits an agronomy source string ("CRIDA-HAS pp13-14; TNAU-ORG-ROT") into catalogue ids with locators. */
export function agronomySources(text: string | null | undefined): SourceRef[] {
  if (!text) return [];
  const ids = [...sourceIndex().keys()].sort((a, b) => b.length - a.length);
  return text.split(';').map((p) => p.trim()).filter(Boolean).map((part) => {
    const id = ids.find((k) => part === k || part.startsWith(`${k} `) || part.startsWith(`${k},`)) ?? part.split(/\s+/)[0]!;
    const info = sourceIndex().get(id);
    const locator = part.slice(id.length).replace(/^[\s,]+/, '') || null;
    return { id, url: validUrl(info?.url), title: info?.title ?? null, locator };
  });
}
export function yieldCostSource(id: string | null | undefined): SourceRef | null {
  if (!id) return null;
  const s = loadYieldCost().sources.get(id);
  return { id, url: validUrl(s?.url), title: s?.title ?? null, locator: s?.locator ?? null };
}

// ------------------------------------------------------------------ names
const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
export const cropDisplayName = (cropId: string): string => capitalise(cropId.replace(/-/g, ' '));
export function productDisplayName(cropId: string, productId: string): string {
  const rest = productId.startsWith(`${cropId}-`) ? productId.slice(cropId.length + 1) : productId;
  return capitalise(rest.replace(/-/g, ' '));
}

// ------------------------------------------------------------------ seasons and districts
export function asSeason(s: string | null | undefined): Season | null {
  const v = (s ?? '').trim().toLowerCase();
  return v === 'kharif' || v === 'rabi' || v === 'summer' ? v : null;
}
/** Season from the sowing month, per crop-agronomy.json methods.seasonLabel: Feb-Apr summer, May-Aug kharif, Sep-Jan rabi. */
export function seasonOfMonth(month: number): Season {
  return month >= 2 && month <= 4 ? 'summer' : month >= 5 && month <= 8 ? 'kharif' : 'rabi';
}
const DISTRICT_ALIASES: Record<string, string> = { mysore: 'mysuru', tumkur: 'tumakuru', shimoga: 'shivamogga', chamrajnagar: 'chamarajanagar', bellary: 'ballari', belgaum: 'belagavi', gulbarga: 'kalaburagi', bijapur: 'vijayapura', chikmagalur: 'chikkamagaluru', davangere: 'davanagere' };
/** Registry slug of a district name ("Dakshina Kannada" -> "dakshina-kannada", "Mysore" -> "mysuru"). */
export function districtSlug(name: string): string {
  const s = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
  return DISTRICT_ALIASES[s] ?? s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const districtPart = (districtId: string, stateId: string) => (districtId.startsWith(`${stateId}-`) ? districtId.slice(stateId.length + 1) : districtId);

// ------------------------------------------------------------------ sowing windows
export interface Where { stateId: string | null; districtId: string | null }
export interface ScopedWindow {
  row: WindowRow;
  scope: WindowScope | 'region';
  season: Season | null;
  /** 'sourced' when the row carries no reviewStatus. */
  reviewStatus: string;
  provisional: boolean;
  usable: boolean;
  reason: string | null;
  /** Neighbouring district whose plan supplies a state-level window. */
  neighbour: string | null;
}

function windowScope(row: WindowRow, w: Where): { scope: WindowScope | 'region'; neighbour: string | null } | null {
  const { stateId, districtId } = w;
  if (!stateId) return null;
  if (districtId && row.region === districtId && !row.sourceDistrict) return { scope: 'district', neighbour: null };
  if (row.region === stateId || row.region.startsWith(`${stateId}-`)) {
    const named = row.sourceDistrict ? row.sourceDistrict.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean) : row.region !== stateId ? [districtPart(row.region, stateId)] : [];
    const own = districtId !== null && named.some((n) => districtSlug(n) === districtPart(districtId, stateId));
    if (own) return { scope: 'district', neighbour: null };
    // stateFallback:false rows apply only to their own sourceDistrict (coordinator decision 2026-11-01).
    if (row.stateFallback === false) return null;
    return { scope: 'state', neighbour: row.sourceDistrict ?? (row.region !== stateId ? districtPart(row.region, stateId) : null) };
  }
  if (row.candidateFor === stateId) return { scope: 'region', neighbour: null };
  return null;
}

/**
 * Sowing windows that apply to the field, with scope (district > state > region) and review status. District rows
 * count for that district; state rows and neighbouring-district rows count as state-level evidence; rows with
 * stateFallback:false only count for their own district. A state window is set aside (usable false) when a
 * non-provisional district window exists for the same season. pending_user_decision and region-only rows are listed
 * but not usable.
 */
export function windowsFor(cropId: string, where: Where): ScopedWindow[] {
  const crop = agronomyCrop(cropId);
  if (!crop) return [];
  const out: ScopedWindow[] = [];
  for (const row of crop.sowingWindows) {
    const placed = windowScope(row, where);
    if (!placed) continue;
    const reviewStatus = row.reviewStatus ?? 'sourced';
    const season = asSeason(row.season);
    const provisional = reviewStatus === 'provisional';
    let usable = true;
    let reason: string | null = null;
    if (reviewStatus === 'pending_user_decision') { usable = false; reason = `Window from ${row.source ?? 'an unreviewed source'} awaits a user decision on where it applies; not used.`; }
    else if (reviewStatus !== 'sourced' && !provisional) { usable = false; reason = `Window review status "${reviewStatus}" is not usable.`; }
    else if (placed.scope === 'region') { usable = false; reason = `Regional window (${row.region}) is not specific to this state; not used.`; }
    else if (!season) { usable = false; reason = `Unknown season label "${row.season}".`; }
    out.push({ row, scope: placed.scope, season, reviewStatus, provisional, usable, reason, neighbour: placed.neighbour });
  }
  const districtSeasons = new Set(out.filter((w) => w.usable && w.scope === 'district' && !w.provisional).map((w) => w.season));
  for (const w of out) {
    if (w.usable && w.scope === 'state' && w.season && districtSeasons.has(w.season)) { w.usable = false; w.reason = 'A district window exists for this season.'; }
  }
  return out;
}

// ------------------------------------------------------------------ durations
const NOT_MODELLED_METHOD = /rice_fallow|relay/;
const METHOD_TOKENS: Record<string, string> = { transplant: 'transplant', transplanted: 'transplant', transplanting: 'transplant', direct: 'direct', rhizome: 'rhizome', bulb: 'bulb', sett: 'sett', broadcast: 'broadcast', relay: 'relay' };
const methodTokens = (m: string) => new Set(m.toLowerCase().split(/[^a-z]+/).map((t) => METHOD_TOKENS[t]).filter((t): t is string => !!t));
/** 'any' or an unrecognised method matches everything; otherwise the methods must share a token (transplant, direct, ...). */
export function methodMatches(rowMethod: string, wanted: string | null): boolean {
  if (wanted === null || rowMethod === 'any' || wanted === 'any') return true;
  const a = methodTokens(rowMethod);
  const b = methodTokens(wanted);
  if (!a.size || !b.size) return true;
  return [...a].some((t) => b.has(t));
}
/** Establishment methods with a sourced duration; rice-fallow relay sowing is not modelled. */
export function methodsFor(cropId: string): string[] {
  const rows = (agronomyCrop(cropId)?.durationDays ?? []).filter((r) => !NOT_MODELLED_METHOD.test(r.method) && r.max != null);
  const specific = [...new Set(rows.map((r) => r.method).filter((m) => m !== 'any'))];
  return specific.length ? specific.sort() : rows.length ? ['any'] : [];
}
function durationRegion(row: DurationRow): string | null {
  const text = `${row.cultivar ?? ''} ${row.source ?? ''}`;
  if (/\bTN\b|TNAU|Tamil Nadu/.test(text)) return 'IN-TN';
  if (/\bKA\b|Karnataka|Hassan|UASB?\b|CRIDA-HAS/.test(text)) return 'IN-KA';
  return null;
}
export interface DurationClass { method: string; min: number; max: number; sources: string[]; regionMatch: 'state' | 'other_state' | 'unspecified'; notes: string[] }

/**
 * Sourced duration classes (days from sowing or planting to harvest) for one method. When rows named for the farm's
 * state exist, rows named for another state are dropped (rows without a stated region stay); otherwise all rows are
 * used and flagged. Rows of one method merge into a class when their ranges are
 * within ASSUMPTIONS.durationClassMergeDays; a row without a lower bound uses its upper bound; a row without an upper
 * bound (no completion duration) or longer than a year (perennial) is not used.
 */
export function durationFor(cropId: string, method: string | null, region: string | null, productId?: string | null): DurationClass[] {
  const all = (agronomyCrop(cropId)?.durationDays ?? []).filter((r) => !NOT_MODELLED_METHOD.test(r.method) || (method !== null && r.method === method));
  const forProduct = productId && all.some((r) => r.productId === productId) ? all.filter((r) => r.productId === productId) : all.filter((r) => !r.productId);
  const rows = forProduct.filter((r) => methodMatches(r.method, method));
  const notes: string[] = [];
  const stateRows = region ? rows.filter((r) => durationRegion(r) === region) : [];
  // Rows named for another state are dropped when rows for this state exist; rows with no stated region always stay.
  const chosen = stateRows.length ? rows.filter((r) => durationRegion(r) === region || durationRegion(r) === null) : rows;
  const regionMatch: DurationClass['regionMatch'] = stateRows.length ? 'state' : chosen.some((r) => durationRegion(r) !== null) ? 'other_state' : 'unspecified';
  const usable: { min: number; max: number; row: DurationRow }[] = [];
  for (const r of chosen) {
    if (r.max == null || r.max <= 0) { notes.push(`No completion duration published for ${r.cultivar ?? 'one cultivar group'}; not used.`); continue; }
    if (r.max > 365) { notes.push(`${r.cultivar ?? 'A cultivar group'} runs longer than a year (perennial for this plan); not used.`); continue; }
    if (r.min == null) notes.push(`Lower bound not published for ${r.cultivar ?? 'one cultivar group'}; its upper bound is used.`);
    usable.push({ min: Math.min(r.min ?? r.max, r.max), max: r.max, row: r });
  }
  usable.sort((a, b) => a.min - b.min || a.max - b.max);
  const classes: DurationClass[] = [];
  for (const u of usable) {
    const cur = classes.at(-1);
    const src = u.row.source ?? '';
    if (cur && u.min <= cur.max + ASSUMPTIONS.durationClassMergeDays.value) {
      cur.max = Math.max(cur.max, u.max);
      if (src && !cur.sources.includes(src)) cur.sources.push(src);
    } else classes.push({ method: method ?? 'any', min: u.min, max: u.max, sources: src ? [src] : [], regionMatch, notes: [...notes] });
  }
  return classes;
}

export function stagesFor(cropId: string): { stages: { id: string; name: string; startDay: number; endDay: number }[]; basis: { type: string | null; source: string | null; note: string | null } | null } {
  const crop = agronomyCrop(cropId);
  if (!crop) return { stages: [], basis: null };
  return {
    stages: crop.stages.map((s) => ({ id: s.id, name: s.name, startDay: s.startDay, endDay: s.endDay })),
    basis: crop.stagesBasis ? { type: crop.stagesBasis.type ?? null, source: crop.stagesBasis.source ?? null, note: crop.stagesBasis.note ?? null } : null,
  };
}

// ------------------------------------------------------------------ yields
export type YieldForm = 'rice_milled' | 'lint' | 'dry' | 'fresh' | 'main' | 'unstated';
/** Product form of a yield row, read from its basis text only (never guessed from the number). */
export function yieldRowForm(row: Pick<YieldRow, 'basis' | 'note'>): YieldForm {
  const b = `${row.basis} ${row.note ?? ''}`.toLowerCase();
  if (/rice \(milled\)|in terms of rice/.test(b)) return 'rice_milled';
  if (/\blint\b/.test(b)) return 'lint';
  if (/consistent with dry|dry chilli inferred|cured\/dry|cured \(processed\)/.test(b)) return 'dry';
  if (/fresh rhizome|consistent with fresh|fresh produce|^tubers/.test(b)) return 'fresh';
  if (/main product as published|^grain\b|^seed\b|^cane\b/.test(b)) return 'main';
  return 'unstated';
}
/**
 * Products whose crop is published in more than one form: only the listed forms match the product. paddy-grain also
 * accepts rice (milled) rows through the sourced out-turn ratio. Kapas has no sourced lint-to-kapas ratio, so lint
 * rows never become kapas yields. Any other product accepts main, fresh or unstated rows (single marketed form).
 */
const MULTI_FORM_PRODUCTS: Record<string, YieldForm[]> = {
  'paddy-grain': ['main'], 'paddy-milled-rice': ['rice_milled'], 'cotton-kapas': [], 'cotton-lint': ['lint'],
  'chilli-dry': ['dry'], 'chilli-green': ['fresh'], 'ginger-fresh': ['fresh'], 'ginger-dry': ['dry'], 'turmeric-fresh': ['fresh'], 'turmeric-dry': ['dry'],
};
const MULTI_FORM_CROPS = new Set(['paddy', 'cotton', 'chilli', 'ginger', 'turmeric']);
interface Accepted { row: YieldRow; value: number; form: YieldForm; factor: number }
function acceptYieldRow(cropId: string, productId: string, row: YieldRow): Accepted | null {
  if (row.yieldKgPerHa === null || !(row.yieldKgPerHa > 0)) return null;
  const form = yieldRowForm(row);
  const conv = loadYieldCost().conversions.riceToPaddy;
  if (productId === 'paddy-grain' && form === 'rice_milled') return conv ? { row, value: row.yieldKgPerHa * conv.paddyKgPerKgRiceRaw, form, factor: conv.paddyKgPerKgRiceRaw } : null;
  const accept = MULTI_FORM_PRODUCTS[productId] ?? (MULTI_FORM_CROPS.has(cropId) ? [] : ['main', 'fresh', 'unstated']);
  return accept.includes(form) ? { row, value: row.yieldKgPerHa, form, factor: 1 } : null;
}
const yearKey = (y: string | null | undefined): number => { const m = /(\d{4})/.exec(y ?? ''); return m ? Number(m[1]) : Number.NEGATIVE_INFINITY; };
const COMBINED_SEASON = /total|all seasons|whole year|&|combined/i;
const quantile7 = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo]! + (h - lo) * (s[lo + 1]! - s[lo]!) : s[lo]!;
};
function lastYears(list: Accepted[], n: number): { year: string; value: number; rows: Accepted[] }[] {
  const byYear = new Map<string, Accepted[]>();
  for (const a of list) byYear.set(a.row.cropYear, [...(byYear.get(a.row.cropYear) ?? []), a]);
  return [...byYear.entries()].sort((a, b) => yearKey(b[0]) - yearKey(a[0])).slice(0, n)
    .map(([year, rows]) => ({ year, value: quantile7(rows.map((r) => r.value), 0.5), rows }));
}

export interface YieldRef {
  p50: number;
  low: number;
  high: number;
  referenceKgPerHa: number;
  basis: 'district' | 'state' | 'reference';
  /** Region id of the rows used (district or state). */
  region: string;
  years: string[];
  season: string;
  seasonMatch: 'exact' | 'combined';
  stale: boolean;
  sourceIds: string[];
  conversion: { factor: number; sourceId: string | null; locator: string | null } | null;
  notes: string[];
}

/**
 * Regional yield (kg/ha of the product's own form) for a season: median and P25-P75 of the last 3 available years at
 * the most specific level with at least ASSUMPTIONS.minYieldYears years (district, then state); a single published
 * year is returned with basis 'reference' and no spread. Exact season rows are preferred over season-combined rows.
 * District rows that restate the state average (districtYieldIndependent false) are not district evidence. Rice
 * (milled) rows for paddy-grain are converted with conversions.riceToPaddy and carry a note. Reference yield is the
 * best state year of the same form. Returns null when no row of the product's form exists for the state.
 */
export function yieldFor(cropId: string, productId: string, where: Where & { season: Season | null }): YieldRef | null {
  if (!where.stateId) return null;
  const accepted = (yieldCostCrop(cropId)?.yields ?? []).map((r) => acceptYieldRow(cropId, productId, r)).filter((a): a is Accepted => a !== null);
  const district = where.districtId ? accepted.filter((a) => a.row.region === where.districtId && a.row.districtYieldIndependent !== false) : [];
  const state = accepted.filter((a) => a.row.region === where.stateId);
  const seasonSets = (set: Accepted[]) => [
    { match: 'exact' as const, list: where.season ? set.filter((a) => a.row.season.trim().toLowerCase() === where.season) : [] },
    { match: 'combined' as const, list: set.filter((a) => COMBINED_SEASON.test(a.row.season)) },
  ];
  const notes: string[] = [];
  const rawDistrict = where.districtId ? (yieldCostCrop(cropId)?.yields ?? []).filter((r) => r.region === where.districtId) : [];
  if (rawDistrict.length && !district.length) notes.push(rawDistrict.every((r) => r.districtYieldIndependent === false) ? 'District rows restate the state average; the state yield is used.' : 'District yield rows are not published in this product form; the state yield is used.');
  const nYears = ASSUMPTIONS.yieldYears.value;
  let chosen: { level: 'district' | 'state' | 'reference'; match: 'exact' | 'combined'; years: ReturnType<typeof lastYears> } | null = null;
  for (const [level, set] of [['district', district], ['state', state]] as const) {
    for (const s of seasonSets(set)) {
      const ys = lastYears(s.list, nYears);
      if (ys.length >= ASSUMPTIONS.minYieldYears.value) { chosen = { level, match: s.match, years: ys }; break; }
    }
    if (chosen) break;
  }
  if (chosen?.level === 'state' && district.length) notes.push('District yield has fewer than two usable years for this season; the state yield is used.');
  if (!chosen) {
    for (const set of [district, state]) for (const s of seasonSets(set)) {
      if (!chosen && s.list.length) chosen = { level: 'reference', match: s.match, years: lastYears(s.list, 1) };
    }
    if (chosen) notes.push('Only one published year is available; the yield has no year-to-year range.');
  }
  if (!chosen) return null;
  const values = chosen.years.map((y) => y.value);
  const rows = chosen.years.flatMap((y) => y.rows);
  const stateBestSet = seasonSets(state).find((s) => s.list.length)?.list ?? [];
  const reference = Math.max(...(stateBestSet.length ? stateBestSet : rows).map((a) => a.value));
  const stale = rows.some((a) => a.row.stale === true);
  if (stale) notes.push(`District yields are from ${chosen.years.map((y) => y.year).sort().join(', ')} (latest published for the district; stale).`);
  if (chosen.match === 'combined') notes.push(`Season-combined yield ("${rows[0]!.row.season}") is used; no ${where.season ?? 'season'} rows.`);
  if (rows.some((a) => a.form === 'unstated')) notes.push('The source does not state the product form; it is read as the marketed product.');
  const converted = rows.find((a) => a.factor !== 1);
  const conv = loadYieldCost().conversions.riceToPaddy;
  if (converted && conv) notes.push(`Published as rice (milled); converted to paddy at ${conv.paddyKgPerKgRiceRaw} kg paddy per kg rice (official out-turn norm, a policy figure, not a measured mill recovery).`);
  return {
    p50: Math.round(quantile7(values, 0.5)),
    low: Math.round(quantile7(values, 0.25)),
    high: Math.round(quantile7(values, 0.75)),
    referenceKgPerHa: Math.round(reference),
    basis: chosen.level,
    region: rows[0]!.row.region,
    years: chosen.years.map((y) => y.year),
    season: rows[0]!.row.season,
    seasonMatch: chosen.match,
    stale,
    sourceIds: [...new Set(rows.map((a) => a.row.sourceId).filter((s): s is string => !!s))],
    conversion: converted && conv ? { factor: conv.paddyKgPerKgRiceRaw, sourceId: conv.sourceId ?? null, locator: conv.locator ?? null } : null,
    notes,
  };
}
/** Why yieldFor returned null, for the slot's uncertainty list. */
export function yieldGapReason(cropId: string, productId: string, stateId: string | null): string {
  const rows = (yieldCostCrop(cropId)?.yields ?? []).filter((r) => r.region === stateId || (stateId !== null && r.region.startsWith(`${stateId}-`)));
  if (!rows.length) return `No ${cropDisplayName(cropId).toLowerCase()} yield rows are sourced for this state.`;
  const forms = [...new Set(rows.map((r) => yieldRowForm(r)))];
  if (productId === 'cotton-kapas' && forms.includes('lint')) return 'Cotton yields are published as lint; no sourced lint-to-kapas ratio, so no kapas yield is shown.';
  return `Yield rows for this state are published as ${forms.join(', ')}, not as ${productDisplayName(cropId, productId).toLowerCase()}.`;
}

// ------------------------------------------------------------------ costs
const AUTHORITY_RANK: Record<string, number> = { cacp: 0, des: 1, sau: 2, other: 3 };
const authorityOf = (a: string | null | undefined): CostEstimate['authority'] => (a === 'cacp' || a === 'des' || a === 'sau' ? a : 'other');
const lowReliability = (r: string | null | undefined): boolean => !!r && /^\s*low\b/i.test(r);
export interface CostRef { estimate: CostEstimate; deductionPerHa: number; deductionBasis: 'a2fl' | 'c2'; sourceId: string | null; locator: string | null; notes: string[] }

/**
 * Cost of cultivation for the state: rows with a per-hectare A2+FL or C2 figure, excluding reliability "low", preferring
 * CACP > DES > SAU > other and then the most recent year. Rows with only per-quintal or cash-cost totals are not
 * per-hectare A2+FL/C2 and are not used. Profit deducts A2+FL, else the published C2-type total (flagged).
 */
export function costFor(cropId: string, where: { stateId: string | null }): CostRef | null {
  if (!where.stateId) return null;
  const st = where.stateId;
  const rows = (yieldCostCrop(cropId)?.costs ?? []).filter((r) => (r.region === st || r.region.startsWith(`${st}-`)) && !lowReliability(r.reliability) && ((r.a2flPerHa ?? 0) > 0 || (r.c2PerHa ?? 0) > 0));
  rows.sort((a, b) => (AUTHORITY_RANK[authorityOf(a.authority)!] ?? 9) - (AUTHORITY_RANK[authorityOf(b.authority)!] ?? 9) || yearKey(b.year) - yearKey(a.year) || Number((b.a2flPerHa ?? 0) > 0) - Number((a.a2flPerHa ?? 0) > 0));
  const r = rows[0];
  if (!r) return null;
  const a2fl = r.a2flPerHa && r.a2flPerHa > 0 ? Math.round(r.a2flPerHa) : null;
  const c2 = r.c2PerHa && r.c2PerHa > 0 ? Math.round(r.c2PerHa) : null;
  const notes: string[] = [];
  if (a2fl === null) notes.push('Only a C2-type total cost (includes land rent and interest) is published; profit uses it and is conservative.');
  if (r.district) notes.push(`Cost is a ${r.district} district survey figure, used for the state.`);
  if (!r.year) notes.push('The cost source does not print its survey year.');
  if (r.reliability) notes.push(`Source reliability noted by research: ${r.reliability.split('.')[0]}.`);
  return {
    estimate: { a2flPerHa: a2fl, c2PerHa: c2, authority: authorityOf(r.authority), year: r.year ? r.year.slice(0, 20) : null, region: (r.district ? `${r.region} ${r.district}` : r.region).slice(0, 40) },
    deductionPerHa: (a2fl ?? c2)!,
    deductionBasis: a2fl !== null ? 'a2fl' : 'c2',
    sourceId: r.sourceId ?? null,
    locator: r.locator ?? null,
    notes,
  };
}
export function costGapReason(cropId: string, stateId: string | null): string {
  const rows = (yieldCostCrop(cropId)?.costs ?? []).filter((r) => stateId !== null && (r.region === stateId || r.region.startsWith(`${stateId}-`)));
  if (!rows.length) return 'No cost-of-cultivation row is sourced for this crop in this state.';
  if (rows.every((r) => lowReliability(r.reliability) || !((r.a2flPerHa ?? 0) > 0 || (r.c2PerHa ?? 0) > 0))) {
    return rows.some((r) => lowReliability(r.reliability)) ? 'The only per-hectare cost row is marked low reliability and is not used.' : 'Cost rows give per-quintal or cash-cost figures only, not per-hectare A2+FL or C2.';
  }
  return 'No usable cost row.';
}

export function postHarvestLoss(cropId: string): { pct: number; sourceId: string | null } | null {
  const p = yieldCostCrop(cropId)?.postHarvestLossPct;
  return p && typeof p.value === 'number' && p.value >= 0 && p.value < 100 ? { pct: p.value, sourceId: p.sourceId ?? null } : null;
}

// ------------------------------------------------------------------ rotation facts
const ROLES: readonly RotationRole[] = ['nitrogen_fixer', 'heavy_feeder', 'moderate_feeder', 'light_feeder'];
const asRole = (v: string | null | undefined): RotationRole | null => (ROLES as readonly string[]).includes(v ?? '') ? (v as RotationRole) : null;
/** Agronomy role (rule v1, cited N figure) first; else the crop-pool classification, flagged as the pool's. */
export function rotationRole(cropId: string): { value: RotationRole | null; source: 'agronomy' | 'pool' | null; sources: string[] } {
  const a = agronomyCrop(cropId)?.rotationRole;
  const v = asRole(a?.value);
  if (v) return { value: v, source: 'agronomy', sources: a?.sources ?? [] };
  const p = asRole(poolEntry(cropId)?.rotationRole);
  return p ? { value: p, source: 'pool', sources: [] } : { value: null, source: null, sources: [] };
}
/** Cited residual N credit of a nitrogen-fixing crop (kg N/ha), or null. */
export function legumeCredit(cropId: string): LegumeCredit | null {
  const crop = agronomyCrop(cropId);
  const c = crop?.nitrogenCreditKgPerHa;
  if (!crop || rotationRole(cropId).value !== 'nitrogen_fixer' || !c || !c.source) return null;
  const min = c.min ?? c.max;
  const max = c.max ?? c.min;
  if (min == null || max == null) return null;
  return { min, max, specificity: c.specificity ?? null, successorCrop: c.successorCrop ?? null, source: c.source };
}
const toLink = (l: z.output<typeof LinkRow>): CropLink => ({ cropId: l.cropId ?? null, family: l.family ?? null, source: l.source ?? null, context: l.context ?? null });
export const avoidAfter = (cropId: string): CropLink[] => (agronomyCrop(cropId)?.avoidAfter ?? []).filter((l) => l.cropId || l.family).map(toLink);
export const recommendedSuccessors = (cropId: string): CropLink[] => (agronomyCrop(cropId)?.recommendedSuccessors ?? []).filter((l) => l.cropId && l.candidate !== false).map(toLink);
export const recommendedPredecessors = (cropId: string): CropLink[] => (agronomyCrop(cropId)?.recommendedPredecessors ?? []).filter((l) => l.cropId && l.candidate !== false).map(toLink);
export function waterNeedMm(cropId: string): { min: number; max: number; source: string | null } | null {
  const w = agronomyCrop(cropId)?.waterNeedMm;
  const min = w?.min ?? w?.max;
  const max = w?.max ?? w?.min;
  return w && min != null && max != null && max > 0 ? { min, max, source: w.source ?? null } : null;
}
export const rainfedSuitable = (cropId: string): boolean | null => agronomyCrop(cropId)?.rainfedSuitable ?? null;
export const family = (cropId: string): string | null => agronomyCrop(cropId)?.family ?? null;
export function phRange(cropId: string): { min: number; max: number; source: string | null } | null {
  const crop = agronomyCrop(cropId);
  const r = crop?.phRange ?? crop?.soilPhRange ?? null;
  return r && r.source && r.min < r.max ? { min: r.min, max: r.max, source: r.source } : null;
}
export function rotationFacts(cropId: string): RotationFacts {
  const role = rotationRole(cropId);
  return { cropId, family: family(cropId), role: role.value, roleSource: role.source, avoidAfter: avoidAfter(cropId), successors: recommendedSuccessors(cropId), predecessors: recommendedPredecessors(cropId), phRange: phRange(cropId) };
}
