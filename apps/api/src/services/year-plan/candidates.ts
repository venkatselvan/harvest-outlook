import { createHash } from 'node:crypto';
import type { BasisRef } from '@harvest/contracts';
import { agronomyCrop, agronomySources, durationFor, legumeCredit, methodsFor, poolEntries, rotationFacts, windowsFor, type DurationClass } from './data';
import { addDays, clippedDays, daysBetween } from './dates';
import { ASSUMPTIONS, assumptionBasis, PRUNED_RULES, sequenceScore, soilRotationScore, type RotationScoreResult } from './scoring';
import type { Candidate, DateRange, EngineContext, HarvestRange, PlacedWindow, Season, Sequence, SlotPlan } from './types';
import { irrigationCompat, placeWindows, windowFitOf } from './windows';

export const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface WindowHit { window: PlacedWindow; conditional: boolean; note: string | null }
export interface PlanParts {
  key: string;
  cropId: string;
  productId: string;
  method: string | null;
  sowing: string;
  harvest: HarvestRange;
  season: Season;
  durationDays: { low: number; high: number };
  duration: Pick<DurationClass, 'sources' | 'notes' | 'regionMatch'> | null;
  hit: WindowHit | null;
}

function windowBasis(ctx: EngineContext, w: PlacedWindow): BasisRef {
  const s = agronomySources(w.source)[0];
  const scope = w.scope === 'district' ? ctx.districtId : w.sourceDistrict ? `${ctx.stateId ?? ''} (${w.sourceDistrict})` : ctx.stateId;
  return {
    kind: 'sowing_window', label: `Sowing window: ${s?.title ?? s?.id ?? 'source not catalogued'}`.slice(0, 200), sourceId: s?.id ?? null, url: s?.url ?? null,
    scope: scope ? scope.slice(0, 120) : null, note: `${w.season} window ${w.from.slice(5)} to ${w.to.slice(5)}${w.provisional ? ' (provisional)' : ''}${s?.locator ? `; ${s.locator}` : ''}`.slice(0, 1000),
  };
}

/** A slot on the calendar with its occupancy, window fit, flags, uncertainties and basis. Shared by candidates and edits. */
export function makeSlotPlan(ctx: EngineContext, p: PlanParts): SlotPlan {
  const gap = ASSUMPTIONS.landPrepGapDays.value;
  const w = p.hit?.window ?? null;
  const uncertainties: string[] = [];
  const basis: BasisRef[] = [];
  if (w) basis.push(windowBasis(ctx, w));
  if (w && w.scope === 'state' && !w.provisional) uncertainties.push(`No district sowing window for ${w.season}; the ${w.sourceDistrict ? `${w.sourceDistrict} district plan` : 'state'} window is used.`);
  if (w?.provisional) uncertainties.push('Provisional sowing window (contingency plan), pending review.');
  if (!w) uncertainties.push('The sowing date is outside every sourced window for this crop.');
  if (p.hit?.note) uncertainties.push(p.hit.note);
  if (p.duration) {
    for (const s of p.duration.sources.flatMap((x) => agronomySources(x)).slice(0, 2)) basis.push({ kind: 'duration', label: `Duration: ${s.title ?? s.id}`.slice(0, 200), sourceId: s.id, url: s.url, scope: null, note: `${p.durationDays.low}-${p.durationDays.high} days${s.locator ? `; ${s.locator}` : ''}` });
    if (p.duration.regionMatch === 'other_state') uncertainties.push('Durations are for cultivars named for another state.');
    uncertainties.push(...p.duration.notes);
  } else uncertainties.push('No sourced duration; the harvest date was entered by the farmer.');
  basis.push(assumptionBasis('landPrepGapDays'));
  return {
    key: p.key, cropId: p.cropId, productId: p.productId, method: p.method === 'any' ? null : p.method, season: p.season, fixed: false,
    sowing: p.sowing, harvest: p.harvest, occupancy: { from: p.sowing, to: addDays(p.harvest.latest, gap) }, durationDays: p.durationDays,
    durationSourced: p.duration !== null, window: w, windowFit: windowFitOf(w),
    flags: {
      stateWindowFallback: !!w && w.scope === 'state' && !w.provisional, provisionalWindow: !!w?.provisional, outsideWindow: !w, landPrepGapAssumed: true,
      conditional: !!p.hit?.conditional, durationOtherState: p.duration?.regionMatch === 'other_state', harvestAssumed: false,
    },
    uncertainties: [...new Set(uncertainties)], basis,
  };
}

export interface CandidateSet {
  candidates: Candidate[];
  /** Pool crops or products that produced no candidate, with the reason. */
  skipped: { cropId: string; productId: string | null; reason: string }[];
  /** Crop-level notes such as windows awaiting a user decision. */
  notes: string[];
}

const weeklyDates = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, ASSUMPTIONS.sowingStepDays.value)) out.push(d);
  return out;
};

/**
 * Candidates per spec section 4: for each pool crop, product, establishment method with a sourced duration and duration
 * class, weekly sowing dates inside usable sourced windows (district first, state fallback flagged, provisional windows
 * fit 0.5), harvest from the duration min/max, occupancy to the latest harvest plus the land preparation gap. A slot must
 * be sown on or after ctx.earliestSowing, harvested before the horizon ends and must not overlap an occupied interval.
 */
export function enumerateCandidates(ctx: EngineContext): CandidateSet {
  const byId = new Map<string, Candidate>();
  const skipped: CandidateSet['skipped'] = [];
  const notes: string[] = [];
  const where = { stateId: ctx.stateId, districtId: ctx.districtId };
  for (const entry of poolEntries()) {
    const { cropId } = entry;
    if (ctx.excludedCropIds.includes(cropId)) { skipped.push({ cropId, productId: null, reason: 'Excluded by the farmer.' }); continue; }
    if (!agronomyCrop(cropId)) { skipped.push({ cropId, productId: null, reason: 'No agronomy record.' }); continue; }
    const scoped = windowsFor(cropId, where);
    for (const w of scoped) if (w.reviewStatus === 'pending_user_decision') notes.push(`${cropId}: ${w.reason}`);
    const placed = placeWindows(scoped, { from: ctx.earliestSowing, to: ctx.horizon.to });
    if (!placed.length) {
      skipped.push({ cropId, productId: null, reason: scoped.some((w) => w.reviewStatus === 'pending_user_decision') ? 'Only windows awaiting a user decision exist for this state.' : scoped.length ? 'No usable sowing window in the plan horizon.' : 'No sourced sowing window for this district or state.' });
      continue;
    }
    const methods = methodsFor(cropId);
    if (!methods.length) { skipped.push({ cropId, productId: null, reason: 'No sourced crop-completion duration.' }); continue; }
    const before = byId.size;
    for (const productId of entry.productIds) {
      for (const method of methods) {
        durationFor(cropId, method, ctx.stateId, productId).forEach((cls, ci) => {
          for (const w of placed) {
            const compat = irrigationCompat(w.condition, ctx.irrigation);
            if (!compat.ok) continue;
            for (const sowing of weeklyDates(w.from, w.to)) {
              if (sowing < ctx.earliestSowing || sowing >= ctx.horizon.to) continue;
              const harvest = { earliest: addDays(sowing, cls.min), latest: addDays(sowing, cls.max) };
              if (harvest.latest >= ctx.horizon.to) continue;
              const plan = makeSlotPlan(ctx, { key: `${cropId}|${productId}|${method}|d${ci}|${sowing}`, cropId, productId, method, sowing, harvest, season: w.season, durationDays: { low: cls.min, high: cls.max }, duration: cls, hit: { window: w, conditional: compat.conditional, note: compat.note } });
              if (ctx.occupied.some((o) => o.from < plan.occupancy.to && plan.occupancy.from < o.to)) continue;
              const cand: Candidate = { ...plan, candidateId: plan.key, durationClass: ci };
              const prev = byId.get(cand.candidateId);
              if (!prev || cand.windowFit > prev.windowFit || (cand.windowFit === prev.windowFit && prev.flags.conditional && !cand.flags.conditional)) byId.set(cand.candidateId, cand);
            }
          }
        });
      }
    }
    if (byId.size === before) skipped.push({ cropId, productId: null, reason: 'No sowing date fits the free months of the field within the horizon.' });
  }
  const candidates = [...byId.values()].sort((a, b) => a.sowing.localeCompare(b.sowing) || a.candidateId.localeCompare(b.candidateId));
  return { candidates, skipped, notes: [...new Set(notes)] };
}

// ------------------------------------------------------------------ sequences

export interface EnumerateOptions {
  maxSequences?: number | undefined;
  maxSlots?: number | undefined;
  /** Sequences kept per crop/product/method signature at each depth (date variants), for diversity. */
  perSignature?: number | undefined;
  /** Sequence-independent slot score (0..1) used to rank partial sequences; defaults to 0.5 (coverage and rotation only). */
  slotValue?: ((c: Candidate) => number) | undefined;
}

/** Days of the horizon covered by the union of intervals. */
export function coveredDays(intervals: readonly DateRange[], horizon: DateRange): number {
  const xs = intervals.map((i) => ({ from: i.from > horizon.from ? i.from : horizon.from, to: i.to < horizon.to ? i.to : horizon.to })).filter((i) => i.from < i.to).sort((a, b) => a.from.localeCompare(b.from));
  let total = 0;
  let cur: DateRange | null = null;
  for (const i of xs) {
    if (cur && i.from <= cur.to) { if (i.to > cur.to) cur.to = i.to; continue; }
    if (cur) total += daysBetween(cur.from, cur.to);
    cur = { ...i };
  }
  if (cur) total += daysBetween(cur.from, cur.to);
  return total;
}

/**
 * Crop the field carried last before `sowing`: the latest-ending of the current cycle (or the previous harvested crop),
 * saved seasons and earlier suggested slots. Saved seasons are real predecessors, so rotation rules see them.
 */
export function predecessorOf(ctx: EngineContext, earlier: readonly SlotPlan[], sowing: string): string | null {
  const prior = [
    ...(ctx.transitionFromCropId ? [{ cropId: ctx.transitionFromCropId, end: ctx.fixedSlot?.occupancy.to ?? '' }] : []),
    ...ctx.occupied.map((o) => ({ cropId: o.cropId, end: o.to })),
    ...earlier.filter((s) => !s.fixed).map((s) => ({ cropId: s.cropId, end: s.occupancy.to })),
  ];
  let best: { cropId: string; end: string } | null = null;
  for (const p of prior) if (p.end <= sowing && (!best || p.end >= best.end)) best = p;
  return best?.cropId ?? null;
}

/** Memoised transition scores on crop facts only (no soil pH: pruning does not depend on the field's soil). */
export function transitionScorer(): (prev: string | null, next: string) => RotationScoreResult {
  const memo = new Map<string, RotationScoreResult>();
  return (prev, next) => {
    const k = `${prev ?? ''}>${next}`;
    let r = memo.get(k);
    if (!r) { r = soilRotationScore(prev ? rotationFacts(prev) : null, rotationFacts(next), legumeCredit, undefined); memo.set(k, r); }
    return r;
  };
}

interface Partial { slots: Candidate[]; value: number; id: string; signature: string }

function beam(items: Partial[], max: number, perSignature: number): Partial[] {
  items.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const counts = new Map<string, number>();
  const out: Partial[] = [];
  for (const p of items) {
    const n = counts.get(p.signature) ?? 0;
    if (n >= perSignature) continue;
    counts.set(p.signature, n + 1);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Sequences built depth by depth (spec 4.3-4.4): each next slot starts on or after the previous slot's release and
 * keeps clear of occupied intervals (candidates already do); transitions with a cited avoidAfter or the same family
 * (without a cited succession) are pruned, including the transition from the current or previous crop and from a
 * saved season that ends before the slot (predecessorOf). At each depth
 * only the best `maxSequences` partial sequences are expanded, at most `perSignature` per crop signature. Every
 * partial sequence is itself a valid plan (idle gaps are allowed). Deterministic for identical inputs.
 */
export function enumerateSequences(ctx: EngineContext, candidates: readonly Candidate[], opts: EnumerateOptions = {}): Sequence[] {
  const maxSequences = opts.maxSequences ?? 400;
  const maxSlots = opts.maxSlots ?? 4;
  const perSignature = opts.perSignature ?? 3;
  const value = opts.slotValue ?? (() => 0.5);
  const rot = transitionScorer();
  const sorted = [...candidates].sort((a, b) => a.sowing.localeCompare(b.sowing) || a.candidateId.localeCompare(b.candidateId));
  const horizonDays = daysBetween(ctx.horizon.from, ctx.horizon.to);
  const fixed = ctx.fixedSlot ? [ctx.fixedSlot.occupancy] : [];
  const firstAtOrAfter = (date: string) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m]!.sowing < date) lo = m + 1; else hi = m; } return lo; };
  const score = (slots: Candidate[]): number => {
    const transitions = slots.map((s, i) => rot(predecessorOf(ctx, slots.slice(0, i), s.sowing), s.cropId).value);
    return sequenceScore({
      slots: slots.map((s) => ({ weightDays: clippedDays(s.occupancy.from, s.occupancy.to, ctx.horizon.from, ctx.horizon.to), slotScore: value(s) })),
      horizonDays, rotationFit: transitions.reduce((a, b) => a + b, 0) / transitions.length,
      idleDays: horizonDays - coveredDays([...fixed, ...slots.map((s) => s.occupancy)], ctx.horizon),
    }).value;
  };
  let frontier: Partial[] = [{ slots: [], value: 0, id: '', signature: '' }];
  const done: Partial[] = [];
  for (let depth = 1; depth <= maxSlots && frontier.length; depth++) {
    const next: Partial[] = [];
    for (const p of frontier) {
      const last = p.slots.at(-1);
      for (let i = firstAtOrAfter(last ? last.occupancy.to : ctx.earliestSowing); i < sorted.length; i++) {
        const c = sorted[i]!;
        const prevCrop = predecessorOf(ctx, p.slots, c.sowing);
        if (prevCrop !== null && PRUNED_RULES.has(rot(prevCrop, c.cropId).rule)) continue;
        const slots = [...p.slots, c];
        next.push({ slots, value: score(slots), id: slots.map((s) => s.candidateId).join('>'), signature: slots.map((s) => `${s.cropId}/${s.productId}/${s.method ?? 'any'}`).join('>') });
      }
    }
    frontier = beam(next, maxSequences, perSignature);
    done.push(...frontier);
  }
  return beam(done, maxSequences, perSignature).map((p) => ({ sequenceId: `seq-${shortHash(p.id)}`, slots: p.slots }));
}
