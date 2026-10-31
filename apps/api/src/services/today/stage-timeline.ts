/**
 * Stage timeline for one crop cycle (Today view, Stream B). Pure calendar arithmetic from the recorded
 * establishment date; nothing here is an observation and no stage is ever marked "reached".
 *
 * Precedence (TODAY_VIEW_SPEC section 2):
 *  (a) a sourced catalogue stage model for the crop and the farm's district or state (ginger in IN-KA-hassan today),
 *      dated through `computeStageWindows`; stage basis `sourced`;
 *  (b) the crop's `stages` in data/research/rotation/crop-agronomy.json, dated as anchor + startDay/endDay;
 *      `sourced` for crop-specific stage lengths (IISR, TNAU), `fao_generic` for the FAO Kc split, `estimate` otherwise;
 *  (c) no stages but a published duration: a two-stage `estimate` (growing, maturing) ending at the duration;
 *  (d) otherwise `stages: []`, `harvest: null`, basis note "no sourced stage data".
 *
 * Harvest window: when a sourced catalogue stage model won (a), that model governs the harvest window too (orchestrator
 * decision 2026-11-01, so the slider end and the stage dates come from one source); published durations that disagree are
 * quoted in the basis note, not reconciled. Otherwise: published durations in crop-agronomy.json that match the
 * establishment method, region and product (envelope of min..max over the matching cultivar or season values), else the
 * focused-crop duration, else the end of the last stage. Stage dates in the catalogue case use the shortest source
 * durations (so stages tile the calendar without overlap) and the spread of the source ranges lives in the harvest window.
 *
 * The agronomy file is research_candidate_unreviewed and another worker appends to it: it is loaded once, per-crop
 * validation is tolerant (unknown fields ignored, a malformed crop is skipped and listed in `issues`), never written.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {StageDefinition, StageTimeline} from '@harvest/contracts';
import {addDays, computeStageWindows} from '@harvest/domain';
import {REPO_ROOT} from '../../catalogue/files';
import type {CatalogueSnapshot} from '../../catalogue/snapshot';
import {establishmentAnchor} from '../focused-crops';

export const ESTIMATE_GROWING_SHARE = 0.75;
const MAX_STAGES = 12;

type StageBasis = 'sourced' | 'fao_generic' | 'estimate';
type TimelineStage = StageTimeline['stages'][number];
type HarvestWindow = NonNullable<StageTimeline['harvest']>;

// ------------------------------------------------------------------ agronomy pool

export interface AgronomyDuration {
  method: string;
  min: number | null;
  max: number | null;
  cultivar: string | null;
  source: string | null;
  note: string | null;
  region: string | null;
  productId: string | null;
}
export interface AgronomyStageDef { id: string; name: string; startDay: number; endDay: number }
export interface AgronomyCrop {
  cropId: string;
  productIds: string[];
  durations: AgronomyDuration[];
  stagesBasis: { type: string; source: string | null; note: string | null } | null;
  stages: AgronomyStageDef[];
}
export interface AgronomyPool {
  crops: Map<string, AgronomyCrop>;
  /** Source catalogue ids mapped to their URL (null when the catalogue entry has none). */
  sources: Map<string, string | null>;
  /** Records or rows that failed validation and were left out. Never silently empty when something was dropped. */
  issues: string[];
}

const DurationRow = z.looseObject({
  method: z.string().optional(), min: z.number().min(0).nullish(), max: z.number().min(0).nullish(), cultivar: z.string().optional(),
  source: z.string().optional(), note: z.string().optional(), region: z.string().optional(), productId: z.string().optional(),
});
const StageRow = z.looseObject({id: z.string().min(1), name: z.string().min(1), startDay: z.number().int().min(0), endDay: z.number().int().min(0)});
const CropRow = z.looseObject({
  cropId: z.string().min(1),
  productIds: z.array(z.string()).optional(),
  durationDays: z.array(z.unknown()).optional(),
  stagesBasis: z.looseObject({type: z.string().optional(), source: z.string().optional(), note: z.string().optional()}).nullish(),
  stages: z.array(z.unknown()).optional(),
});
const SourceRow = z.looseObject({id: z.string().min(1), url: z.string().optional()});

/** Tolerant parse of the agronomy file shape. Exported so tests can inject small fixtures through the same code path. */
export function parseAgronomyPool(raw: unknown): AgronomyPool {
  const pool: AgronomyPool = {crops: new Map(), sources: new Map(), issues: []};
  const root = (raw && typeof raw === 'object' ? raw : {}) as {crops?: unknown; sourceCatalog?: unknown};
  if (!Array.isArray(root.crops)) {
    pool.issues.push('crops: not an array');
    return pool;
  }
  for (const s of Array.isArray(root.sourceCatalog) ? root.sourceCatalog : []) {
    const p = SourceRow.safeParse(s);
    if (p.success) pool.sources.set(p.data.id, p.data.url ?? null);
  }
  for (const [i, rawCrop] of root.crops.entries()) {
    const c = CropRow.safeParse(rawCrop);
    if (!c.success) {
      pool.issues.push(`crops[${i}]: ${c.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const id = c.data.cropId;
    const durations: AgronomyDuration[] = [];
    for (const d of c.data.durationDays ?? []) {
      const p = DurationRow.safeParse(d);
      if (!p.success) { pool.issues.push(`${id}: durationDays entry skipped (${p.error.issues[0]?.message ?? 'invalid'})`); continue; }
      const min = p.data.min ?? null, max = p.data.max ?? null;
      if (min === null && max === null) { pool.issues.push(`${id}: durationDays entry without min or max skipped`); continue; }
      if (min !== null && max !== null && min > max) { pool.issues.push(`${id}: durationDays entry with min > max skipped`); continue; }
      durations.push({method: p.data.method ?? 'any', min, max, cultivar: p.data.cultivar ?? null, source: p.data.source ?? null, note: p.data.note ?? null, region: p.data.region ?? null, productId: p.data.productId ?? null});
    }
    const stages: AgronomyStageDef[] = [];
    for (const s of c.data.stages ?? []) {
      const p = StageRow.safeParse(s);
      if (!p.success) { pool.issues.push(`${id}: stage skipped (${p.error.issues[0]?.message ?? 'invalid'})`); continue; }
      if (p.data.endDay <= p.data.startDay) { pool.issues.push(`${id}: stage ${p.data.id} has endDay <= startDay and was skipped`); continue; }
      stages.push({id: p.data.id, name: p.data.name, startDay: p.data.startDay, endDay: p.data.endDay});
    }
    stages.sort((a, b) => a.startDay - b.startDay);
    if (pool.crops.has(id)) { pool.issues.push(`${id}: duplicate crop record ignored`); continue; }
    pool.crops.set(id, {
      cropId: id, productIds: c.data.productIds ?? [], durations,
      stagesBasis: c.data.stagesBasis ? {type: c.data.stagesBasis.type ?? '', source: c.data.stagesBasis.source ?? null, note: c.data.stagesBasis.note ?? null} : null,
      stages,
    });
  }
  return pool;
}

// ------------------------------------------------------------------ focused-crop durations (sync, narrow)

export interface FocusedDuration { minDays: number | null; maxDays: number | null; anchor: string | null; kind: string | null; productIds: string[]; sourceId: string | null }
export interface FocusedPool {
  crops: Map<string, {cropId: string; duration: FocusedDuration | null; variants: FocusedDuration[]}>;
  sourceUrls: Map<string, string | null>;
}
const FocusedDurationRow = z.looseObject({
  minDays: z.number().nullish(), maxDays: z.number().nullish(), anchor: z.string().nullish(), kind: z.string().optional(),
  productIds: z.array(z.string()).optional(), productId: z.string().optional(), sourceRefs: z.array(z.looseObject({sourceId: z.string()})).optional(),
});
const normFocused = (d: z.infer<typeof FocusedDurationRow>): FocusedDuration => ({
  minDays: d.minDays ?? null, maxDays: d.maxDays ?? null, anchor: d.anchor ?? null, kind: d.kind ?? null,
  productIds: [...(d.productIds ?? []), ...(d.productId ? [d.productId] : [])], sourceId: d.sourceRefs?.[0]?.sourceId ?? null,
});

export function parseFocusedPool(raw: unknown): FocusedPool {
  const pool: FocusedPool = {crops: new Map(), sourceUrls: new Map()};
  const root = (raw && typeof raw === 'object' ? raw : {}) as {crops?: unknown; sources?: unknown};
  for (const s of Array.isArray(root.sources) ? root.sources : []) {
    const p = SourceRow.safeParse(s);
    if (p.success) pool.sourceUrls.set(p.data.id, p.data.url ?? null);
  }
  for (const c of Array.isArray(root.crops) ? root.crops : []) {
    const p = z.looseObject({cropId: z.string().min(1), duration: z.unknown().optional(), durationVariants: z.array(z.unknown()).optional()}).safeParse(c);
    if (!p.success) continue;
    const one = (v: unknown) => { const d = FocusedDurationRow.safeParse(v); return d.success ? normFocused(d.data) : null; };
    pool.crops.set(p.data.cropId, {cropId: p.data.cropId, duration: p.data.duration ? one(p.data.duration) : null, variants: (p.data.durationVariants ?? []).map(one).filter((d): d is FocusedDuration => d !== null)});
  }
  return pool;
}

// ------------------------------------------------------------------ caches

let agronomyCache: AgronomyPool | null = null;
let focusedCache: FocusedPool | null = null;
let stageDefCache: StageDefinition[] | null = null;

const readJson = (rel: string): unknown => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));

/** Loads data/research/rotation/crop-agronomy.json once per process (read only). A missing or unreadable file yields an empty pool with an issue. */
export function loadAgronomyPool(): AgronomyPool {
  if (agronomyCache) return agronomyCache;
  try {
    agronomyCache = parseAgronomyPool(readJson('data/research/rotation/crop-agronomy.json'));
  } catch (e) {
    agronomyCache = {crops: new Map(), sources: new Map(), issues: [`crop-agronomy.json unreadable: ${(e as Error).message}`]};
  }
  return agronomyCache;
}
/** Drops every module cache (agronomy file, focused durations, curated stage definitions). Tests only. */
export function invalidate(): void {
  agronomyCache = null;
  focusedCache = null;
  stageDefCache = null;
}
loadAgronomyPool.invalidate = invalidate;

function loadFocusedPool(): FocusedPool {
  if (focusedCache) return focusedCache;
  try {
    focusedCache = parseFocusedPool(readJson('data/research/soil-crop/focused-crop-care.json'));
  } catch {
    focusedCache = {crops: new Map(), sourceUrls: new Map()};
  }
  return focusedCache;
}

/** Curated stage definitions from data/curated/stages/*.stages.json (the files the catalogue seed loads); invalid files fail loudly here as they do in the seed. */
function loadStageDefinitions(): StageDefinition[] {
  if (stageDefCache) return stageDefCache;
  const dir = resolve(REPO_ROOT, 'data/curated/stages');
  const out: StageDefinition[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.stages.json')).sort()) {
      for (const rec of readJson(`data/curated/stages/${f}`) as unknown[]) out.push(StageDefinition.parse(rec));
    }
  }
  stageDefCache = out;
  return out;
}

// ------------------------------------------------------------------ small helpers

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const joinNote = (parts: (string | null | false | undefined)[]): string | null => {
  const t = parts.filter((p): p is string => !!p).join(' ');
  return t ? cap(t, 1000) : null;
};
const shortName = (name: string): string => cap(name.split(/[(;]/)[0]!.trim() || name.trim(), 80);
const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));

/** Method families. 'any' matches everything; null (unrecognised or not recorded) matches every entry. */
type MethodFamily = 'sow' | 'transplant' | 'plant';
function methodFamilies(method: string | null): Set<MethodFamily | '*'> | null {
  if (!method) return null;
  const out = new Set<MethodFamily | '*'>();
  for (const token of method.toLowerCase().split('_or_')) {
    if (token === 'any') out.add('*');
    else if (/transplant/.test(token)) out.add('transplant');
    else if (/sowing|^direct|^sow/.test(token)) out.add('sow');
    else if (/planting|^plant/.test(token)) out.add('plant');
  }
  return out.size ? out : null;
}
function methodMatches(entryMethod: string, cycleMethod: string | null): boolean {
  const cycle = methodFamilies(cycleMethod);
  if (!cycle) return true;
  const entry = methodFamilies(entryMethod);
  if (!entry || entry.has('*')) return true;
  return [...cycle].some((f) => entry.has(f));
}

// ------------------------------------------------------------------ duration (harvest window)

interface DurationChoice {
  lo: number;
  hi: number;
  origin: 'agronomy' | 'focused';
  sourceId: string | null;
  url: string | null;
  note: string;
}

interface Ctx { cropId: string; productId: string | null; method: string | null; stateId: string | null; districtId: string | null }

function sourceFromText(pool: AgronomyPool, text: string | null): {id: string | null; url: string | null} {
  if (!text) return {id: null, url: null};
  for (const token of text.split(/[\s;,]+/)) if (pool.sources.has(token)) return {id: token, url: pool.sources.get(token) ?? null};
  return {id: null, url: null};
}

function agronomyDuration(pool: AgronomyPool, crop: AgronomyCrop | null, ctx: Ctx): DurationChoice | null {
  if (!crop) return null;
  const regions = new Set([ctx.districtId, ctx.stateId, 'IN'].filter((x): x is string => !!x));
  const entries = crop.durations.filter((e) =>
    methodMatches(e.method, ctx.method) && (e.region === null || regions.has(e.region)) && (e.productId === null || e.productId === ctx.productId));
  if (!entries.length) return null;
  const bounds = entries.map((e) => ({lo: e.min ?? e.max!, hi: e.max ?? e.min!, open: e.min === null || e.max === null}));
  const lo = Math.min(...bounds.map((b) => b.lo)), hi = Math.max(...bounds.map((b) => b.hi));
  const anyOpen = bounds.some((b) => b.open);
  const nursery = methodFamilies(ctx.method)?.has('transplant') && entries.some((e) => /nursery|anchor sowing/i.test(e.note ?? ''));
  const src = sourceFromText(pool, entries[0]!.source);
  return {
    lo, hi, origin: 'agronomy', sourceId: src.id, url: src.url,
    note: joinNote([
      `Harvest window from ${entries.length} published duration value${entries.length > 1 ? 's' : ''} (${lo === hi ? `${lo}` : `${lo} to ${hi}`} days); cultivars and seasons differ.`,
      anyOpen && 'At least one source value is open-ended (only a lower or upper bound is published), so harvest may run past the latest date.',
      nursery && 'A source value includes the nursery period, so counted from transplanting harvest may come earlier.',
      ctx.method === null && 'Establishment method is not recorded, so durations for every method were considered.',
    ])!,
  };
}

function focusedDuration(pool: FocusedPool, ctx: Ctx, anchorOfMethod: string | null): DurationChoice | null {
  const crop = pool.crops.get(ctx.cropId);
  if (!crop) return null;
  const variant = ctx.productId ? crop.variants.find((v) => v.productIds.includes(ctx.productId!)) : undefined;
  const d = variant ?? crop.duration;
  if (!d || (d.minDays === null && d.maxDays === null)) return null;
  // The same guard the command centre uses: a duration counted from sowing is not a duration from transplanting.
  if (ctx.method !== null && anchorOfMethod !== null && d.anchor !== null && d.anchor !== anchorOfMethod) return null;
  const lo = d.minDays ?? d.maxDays!, hi = d.maxDays ?? d.minDays!;
  return {
    lo, hi, origin: 'focused', sourceId: d.sourceId, url: d.sourceId ? pool.sourceUrls.get(d.sourceId) ?? null : null,
    note: joinNote([`Harvest window from the focused-crop duration (${lo === hi ? `${lo}` : `${lo} to ${hi}`} days from ${d.anchor ?? 'the recorded anchor'}).`, d.kind === 'first_harvest' && 'This is the time to first harvest; later pickings may follow.', (d.minDays === null || d.maxDays === null) && 'Only one bound is published.'])!,
  };
}

// ------------------------------------------------------------------ catalogue stage model

/**
 * Same scope test as catalogue/compare.ts `stagesFor` (district or state id in the stage scope), with two refinements:
 * models are grouped by their record id prefix (so two seasons in one scope do not merge into one list) and a district-scoped
 * model wins over a state-scoped one. Returns [] when nothing matches.
 */
function catalogueModel(stages: readonly StageDefinition[], cropId: string, ctx: Ctx): StageDefinition[] {
  const groups = new Map<string, StageDefinition[]>();
  for (const s of stages) {
    if (s.cropId !== cropId) continue;
    const district = !!ctx.districtId && s.scope.ids.includes(ctx.districtId);
    const state = !!ctx.stateId && s.scope.ids.includes(ctx.stateId);
    if (!district && !state) continue;
    const key = `${district ? 0 : 1}|${s.id.endsWith(`.${s.stageId}`) ? s.id.slice(0, -(s.stageId.length + 1)) : `${s.scope.ids.join(',')}|${s.seasons.join(',')}|${s.varietyId ?? ''}`}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const best = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))[0];
  return best ? [...best[1]].sort((a, b) => a.order - b.order) : [];
}

function fromCatalogue(defs: StageDefinition[], anchor: string, ctx: Ctx, agronomyHarvest: DurationChoice | null): StageTimeline | null {
  const r = computeStageWindows(defs, {earliest: anchor, latest: anchor});
  if (r.status !== 'ok') return null;
  const stages: TimelineStage[] = [];
  for (const def of defs) {
    const ws = r.windows.filter((w) => w.stageId === def.stageId);
    if (!ws.length) continue;
    const from = ws[0]!.earliestStart;
    const to = def.isHarvest ? ws.map((w) => w.latestEnd).sort().at(-1)! : ws[0]!.earliestEnd;
    stages.push({id: def.stageId, name: shortName(def.name), from, to, basis: 'sourced'});
  }
  if (!stages.length) return null;
  const modelHarvest: HarvestWindow = r.harvestWindows.length
    ? {earliest: r.harvestWindows.map((w) => w.earliestStart).sort()[0]!, latest: r.harvestWindows.map((w) => w.latestEnd).sort().at(-1)!}
    : {earliest: r.windows.at(-1)!.earliestEnd, latest: r.windows.at(-1)!.latestEnd};
  const harvest: HarvestWindow = modelHarvest;
  const published: HarvestWindow | null = agronomyHarvest ? {earliest: addDays(anchor, agronomyHarvest.lo), latest: addDays(anchor, agronomyHarvest.hi)} : null;
  const spread = defs.some((d) => !d.isHarvest && d.durationDays.min !== d.durationDays.max);
  const first = defs[0]!;
  const prefix = first.id.endsWith(`.${first.stageId}`) ? first.id.slice(0, -(first.stageId.length + 1)) : first.id;
  const mismatch = published && (published.earliest !== modelHarvest.earliest || published.latest !== modelHarvest.latest) ? published : null;
  return {
    cropId: ctx.cropId, productId: ctx.productId, establishmentMethod: ctx.method, anchorDate: anchor,
    stages: stages.slice(0, MAX_STAGES), harvest,
    basis: {
      kind: 'duration', label: cap(`Sourced stage model for ${ctx.cropId} in ${first.scope.ids.join(', ')}`, 200), sourceId: cap(prefix, 200), url: null,
      scope: cap(first.scope.ids.join(','), 120),
      note: joinNote([
        'Calendar estimate from the recorded establishment date; not an observation.',
        r.limitations[0],
        `Stage model review status: ${first.reviewStatus}.`,
        spread && 'Stage boundaries use the shortest source durations; the spread of the source ranges is the harvest window.',
        `Harvest window from the stage model: ${modelHarvest.earliest} to ${modelHarvest.latest}.`,
        mismatch && `Published crop durations put harvest at ${mismatch.earliest} to ${mismatch.latest}; the stage model governs the harvest window here and the two are not reconciled.`,
        mismatch && agronomyHarvest?.note,
      ]),
    },
  };
}

// ------------------------------------------------------------------ agronomy stages

function classifyStageBasis(b: AgronomyCrop['stagesBasis']): StageBasis {
  if (!b) return 'estimate';
  const t = b.type.toLowerCase(), s = b.source ?? '';
  if (/fao/.test(t) || (!t && /^fao/i.test(s))) return 'fao_generic';
  if (/crop[_ -]?specific|cultivar|phenolog/.test(t)) return 'sourced';
  if (!t && /^(iisr|tnau|sb-|nhb|icar|crida)/i.test(s)) return 'sourced';
  return 'estimate';
}

function fromAgronomyStages(pool: AgronomyPool, crop: AgronomyCrop, anchor: string, ctx: Ctx, harvestChoice: DurationChoice | null): StageTimeline {
  const basis = classifyStageBasis(crop.stagesBasis);
  const stages: TimelineStage[] = crop.stages.slice(0, MAX_STAGES).map((s) => ({id: s.id, name: shortName(s.name), from: addDays(anchor, s.startDay), to: addDays(anchor, s.endDay), basis}));
  const lastEnd = crop.stages.slice(0, MAX_STAGES).at(-1)!.endDay;
  const harvest: HarvestWindow = harvestChoice
    ? {earliest: addDays(anchor, harvestChoice.lo), latest: addDays(anchor, harvestChoice.hi)}
    : {earliest: addDays(anchor, lastEnd), latest: addDays(anchor, lastEnd)};
  const src = sourceFromText(pool, crop.stagesBasis?.source ?? null);
  const srcText = crop.stagesBasis?.source ?? null;
  const label = basis === 'fao_generic' ? 'Stage estimate from standard crop coefficients' : basis === 'sourced' ? 'Crop-specific stage lengths' : 'Stage estimate (basis not classified)';
  return {
    cropId: ctx.cropId, productId: ctx.productId, establishmentMethod: ctx.method, anchorDate: anchor, stages, harvest,
    basis: {
      kind: 'duration', label: cap(srcText ? `${label} (${srcText})` : label, 200), sourceId: src.id, url: src.url, scope: null,
      note: joinNote([
        'Calendar estimate from the recorded establishment date; not an observation.',
        basis === 'fao_generic' && 'FAO crop-coefficient stage lengths are generic, not cultivar or district measurements.',
        crop.stagesBasis?.note,
        harvestChoice ? harvestChoice.note : 'No published duration matched; the harvest date is the end of the last stage.',
        harvestChoice && harvestChoice.hi !== lastEnd && `Stage lengths run to day ${lastEnd} while the published duration ends at day ${harvestChoice.hi}, so stage dates are approximate.`,
      ]),
    },
  };
}

// ------------------------------------------------------------------ duration-only estimate

function fromDurationOnly(d: DurationChoice, anchor: string, ctx: Ctx): StageTimeline {
  const split = Math.max(0, Math.min(Math.round(ESTIMATE_GROWING_SHARE * d.lo), d.hi - 1));
  return {
    cropId: ctx.cropId, productId: ctx.productId, establishmentMethod: ctx.method, anchorDate: anchor,
    stages: [
      {id: 'growing', name: 'Growing', from: anchor, to: addDays(anchor, split), basis: 'estimate'},
      {id: 'maturing', name: 'Maturing', from: addDays(anchor, split), to: addDays(anchor, d.hi), basis: 'estimate'},
    ],
    harvest: {earliest: addDays(anchor, d.lo), latest: addDays(anchor, d.hi)},
    basis: {
      kind: 'duration', label: 'Duration-only estimate (no sourced stage split)', sourceId: d.sourceId, url: d.url, scope: null,
      note: joinNote([
        'Calendar estimate from the recorded establishment date; not an observation.',
        `No sourced stage lengths exist for this crop. The split is an assumption: maturing starts at ${Math.round(ESTIMATE_GROWING_SHARE * 100)}% of the shortest published duration.`,
        d.note,
      ]),
    },
  };
}

// ------------------------------------------------------------------ public API

export interface StageTimelineInput {
  cropId: string;
  productId: string | null;
  establishmentMethod: string | null;
  /** Recorded establishment date (cycle `establishmentDate ?? sowingDate`), YYYY-MM-DD. */
  anchorDate: string;
  stateId: string | null;
  districtId: string | null;
  /** Catalogue snapshot (only `stages` is read). Default: data/curated/stages/*.stages.json. */
  snapshot?: Pick<CatalogueSnapshot, 'stages'> | undefined;
  /** Test injection points; production reads the repo files. */
  agronomy?: AgronomyPool | undefined;
  focused?: FocusedPool | undefined;
}

export function stageTimeline(input: StageTimelineInput): StageTimeline {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate) || Number.isNaN(Date.parse(`${input.anchorDate}T00:00:00Z`))) throw new RangeError('anchorDate must be a YYYY-MM-DD date');
  const ctx: Ctx = {cropId: input.cropId, productId: input.productId, method: input.establishmentMethod, stateId: input.stateId, districtId: input.districtId};
  const pool = input.agronomy ?? loadAgronomyPool();
  const crop = pool.crops.get(input.cropId) ?? null;
  const harvestChoice = agronomyDuration(pool, crop, ctx) ?? focusedDuration(input.focused ?? loadFocusedPool(), ctx, establishmentAnchor(input.establishmentMethod ?? undefined));
  const anchor = input.anchorDate;

  const model = catalogueModel(input.snapshot?.stages ?? loadStageDefinitions(), input.cropId, ctx);
  const catalogue = model.length ? fromCatalogue(model, anchor, ctx, harvestChoice) : null;
  let out: StageTimeline;
  if (catalogue) out = catalogue;
  else if (crop && crop.stages.length) out = fromAgronomyStages(pool, crop, anchor, ctx, harvestChoice);
  else if (harvestChoice) out = fromDurationOnly(harvestChoice, anchor, ctx);
  else {
    out = {
      cropId: ctx.cropId, productId: ctx.productId, establishmentMethod: ctx.method, anchorDate: anchor, stages: [], harvest: null,
      basis: {kind: 'duration', label: 'No sourced stage data', sourceId: null, url: null, scope: null, note: 'no sourced stage data'},
    };
  }
  return StageTimeline.parse(out);
}

// ------------------------------------------------------------------ slider position

export type TimelinePhase = 'unknown' | 'before_anchor' | 'growing' | 'harvest_window' | 'after_harvest';
export interface StageAt {
  /** Stage the date falls in; the last stage also covers the tail up to the end of the slider. Null before the anchor, after harvest, or without data. */
  stage: TimelineStage | null;
  index: number | null;
  /** 0..1 through anchor to the slider end (latest harvest, else the end of the last stage). */
  progress: number;
  phase: TimelinePhase;
}

/** Anchor to latest expected harvest (else end of last stage); null when the timeline has no data. */
export function timelineSpan(t: StageTimeline): {start: string; end: string} | null {
  const end = t.harvest?.latest ?? t.stages.at(-1)?.to ?? null;
  return end ? {start: t.anchorDate, end} : null;
}

export function stageAt(timeline: StageTimeline, date: string): StageAt {
  const span = timelineSpan(timeline);
  if (!span) return {stage: null, index: null, progress: 0, phase: 'unknown'};
  if (date < span.start) return {stage: null, index: null, progress: 0, phase: 'before_anchor'};
  if (date > span.end) return {stage: null, index: null, progress: 1, phase: 'after_harvest'};
  const total = daysBetween(span.start, span.end);
  const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, daysBetween(span.start, date) / total));
  let index: number | null = null;
  for (const [i, s] of timeline.stages.entries()) if (s.from <= date) index = i;
  const phase: TimelinePhase = timeline.harvest && date >= timeline.harvest.earliest ? 'harvest_window' : 'growing';
  return {stage: index === null ? null : timeline.stages[index]!, index, progress, phase};
}
