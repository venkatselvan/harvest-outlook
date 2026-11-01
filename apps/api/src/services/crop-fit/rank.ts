import type { CropFitRequest, CropSeason } from '@harvest/contracts';
import * as data from '../year-plan/data';
import { addDays, daysBetween, isCalendarDate, overlaps } from '../year-plan/dates';
import { makeSlotPlan, predecessorOf, type CandidateSet, type WindowHit } from '../year-plan/candidates';
import { evaluateSlot, marginNormaliser, type ScoringNorm } from '../year-plan/assemble';
import { ASSUMPTIONS, clip, reasonCodes, slotDisplayScore, soilRotationScore, type ReasonCode } from '../year-plan/scoring';
import type { Inputs } from '../year-plan/inputs';
import type { EngineContext, PlacedWindow, SlotPlan } from '../year-plan/types';
import { irrigationCompat, placeWindows, windowFitOf, windowForDate } from '../year-plan/windows';
import { MAX_SHIFT_DAYS, WINDOW_SHIFTED, type RankedCandidate, type ResolvedMode, type Unplaced } from './types';

/**
 * Pure crop-fit ranking (ROUND2_SPEC.md 4.1): resolve the sowing date from the mode, place every pool crop and product
 * with a sourced duration at that date (or the nearest day of a sourced window within 21 days), and score each placement
 * with the year-plan slot scoring (evaluateSlot with the shared inputs, marginNormaliser over the candidate set and the
 * year-plan rotation rule). Nothing here reads the database, the network or a model; the engine modules are reused, not
 * copied.
 */

const cropName = (cropId: string) => data.cropDisplayName(cropId);
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Crop ids are lower-case slugs (catalogue and research files). Round 3 review: `ic:<systemId>` is also accepted, the
 * rotation token the year plan stores as the previous crop after an intercrop with a sourced nitrogen credit
 * (candidates.ts rotationId, scenario.previousCropId); data.rotationFacts and data.legumeCredit read it as the system's
 * main crop plus the cited credit, as the year plan does.
 */
export const AFTER_PATTERN = /^(?:ic:)?[a-z0-9][a-z0-9_.-]{0,119}$/;

/**
 * Effective request: `season` keeps only the season, `date` only the sowing date (defaulting to today), `next` neither.
 * With no mode the default is `next` when a crop is growing and `date` (today) on a fresh field.
 */
export function normaliseRequest(raw: { mode?: CropFitRequest['mode'] | undefined; season?: CropSeason | undefined | null; sowing?: string | undefined | null; after?: string | undefined | null }, hasCycle: boolean, today: string): CropFitRequest {
  const mode = raw.mode ?? (hasCycle ? 'next' : 'date');
  if (mode === 'season') {
    if (!raw.season) throw new Error('season is required when mode is season');
    return { mode, season: raw.season, sowing: null };
  }
  if (mode === 'date') {
    const sowing = raw.sowing ?? today;
    if (!isCalendarDate(sowing)) throw new Error('sowing must be a calendar date (YYYY-MM-DD)');
    // Round 3: `after` (previous-crop override) applies to date mode only; absent (not null) keeps older requests' shape.
    const after = raw.after?.trim() || null;
    if (after !== null && !AFTER_PATTERN.test(after)) throw new Error('after must be a crop id');
    return after ? { mode, season: null, sowing, after } : { mode, season: null, sowing };
  }
  return { mode, season: null, sowing: null };
}

/**
 * Previous crop for a sowing date: the latest crop the field carried before it (current cycle, saved seasons) by the
 * year-plan rule; a date inside the growing crop's occupancy falls back to that crop.
 */
export function previousFor(ctx: EngineContext, sowing: string): string | null {
  return predecessorOf(ctx, [], sowing) ?? ctx.transitionFromCropId ?? null;
}

/**
 * Mode resolution (ROUND2_SPEC 4.1). `next`: the field release date of the growing crop as the year plan computes it
 * (buildScenario: latest harvest + land preparation gap), previous crop = the growing crop; on a field with no growing
 * crop, the first free day. `season`: each crop uses the first day of its earliest sourced window of that season on or
 * after the first free day (today on a fresh field, the release date when a crop is growing). `date`: the farmer's date.
 */
export function resolveMode(ctx: EngineContext, request: CropFitRequest): ResolvedMode {
  const notes: string[] = [];
  if (request.mode === 'next') {
    const fx = ctx.fixedSlot;
    if (!fx) notes.push('No crop is recorded as growing on this field, so "Next crop" starts from the first free day.');
    else if (fx.occupancy.to < ctx.asOf) notes.push(`The growing ${cropName(fx.cropId).toLowerCase()} was expected to free the field by ${fmt(fx.occupancy.to)}; record its harvest. Sowing is placed from today.`);
    const target = ctx.earliestSowing;
    return { request, target, floor: target, previousCropId: previousFor(ctx, target), season: null, notes };
  }
  if (request.mode === 'season') {
    return { request, target: null, floor: ctx.earliestSowing, previousCropId: null, season: request.season, notes };
  }
  const target = request.sowing ?? ctx.asOf;
  const fx = ctx.fixedSlot;
  if (fx && target < fx.occupancy.to) notes.push(`The field is expected to be under ${cropName(fx.cropId).toLowerCase()} until ${fmt(fx.occupancy.to)}; crops sown before then overlap it.`);
  const after = request.after ?? null;
  if (after) notes.push(`Scored after ${cropName(after).toLowerCase()} (the crop before this slot in the plan), not the field's own history.`);
  return { request, target, floor: ctx.asOf < target ? ctx.asOf : target, previousCropId: after ?? previousFor(ctx, target), season: null, notes, previousOverride: after };
}

export interface Placement { sowing: string; hit: WindowHit; shiftedDays: number }

const compatible = (placed: readonly PlacedWindow[], ctx: EngineContext) =>
  placed.map((w) => ({ w, c: irrigationCompat(w.condition, ctx.irrigation) })).filter((x) => x.c.ok);

/**
 * Sowing day for one crop: the target date when it lies inside a compatible sourced window, else the nearest window day
 * within MAX_SHIFT_DAYS that is not before the floor (smallest shift, then the better window, an unconditional window,
 * a later rather than an earlier day). `season`: the first day of the earliest compatible window of that season that is
 * still open on or after the floor. Returns the reason when nothing fits.
 */
export function placeCrop(ctx: EngineContext, cropId: string, resolved: ResolvedMode): Placement | { reason: string } {
  const scoped = data.windowsFor(cropId, { stateId: ctx.stateId, districtId: ctx.districtId });
  const usable = scoped.filter((w) => w.usable && w.season && w.scope !== 'region');
  if (!usable.length) return { reason: scoped.some((w) => w.reviewStatus === 'pending_user_decision') ? 'Only windows awaiting a user decision exist for this state.' : 'No sourced sowing window for this district or state.' };
  if (resolved.target === null) {
    const season = resolved.season!;
    const placed = placeWindows(scoped, { from: resolved.floor, to: addDays(resolved.floor, 366) }).filter((w) => w.season === season && w.to >= resolved.floor);
    const options = compatible(placed, ctx).map((x) => ({ ...x, day: x.w.from > resolved.floor ? x.w.from : resolved.floor }))
      .sort((a, b) => a.day.localeCompare(b.day) || windowFitOf(b.w) - windowFitOf(a.w) || Number(a.c.conditional) - Number(b.c.conditional) || (a.w.source ?? '').localeCompare(b.w.source ?? ''));
    const best = options[0];
    if (!best) return { reason: placed.length ? `The ${season} windows near here need irrigation the field lacks.` : `No sourced ${season} sowing window for this crop on this field.` };
    return { sowing: best.day, hit: { window: best.w, conditional: best.c.conditional, note: best.c.note }, shiftedDays: 0 };
  }
  const target = resolved.target;
  const placed = placeWindows(scoped, { from: addDays(target, -MAX_SHIFT_DAYS - 1), to: addDays(target, MAX_SHIFT_DAYS + 2) });
  const direct = target >= resolved.floor ? windowForDate(target, placed, ctx.irrigation) : null;
  if (direct) return { sowing: target, hit: direct, shiftedDays: 0 };
  const options = compatible(placed, ctx).map((x) => {
    const day = target < x.w.from ? x.w.from : target > x.w.to ? x.w.to : target;
    return { ...x, day, shift: daysBetween(target, day) };
  }).filter((x) => x.day >= resolved.floor && Math.abs(x.shift) <= MAX_SHIFT_DAYS)
    .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift) || windowFitOf(b.w) - windowFitOf(a.w) || Number(a.c.conditional) - Number(b.c.conditional) || b.shift - a.shift || (a.w.source ?? '').localeCompare(b.w.source ?? ''));
  const best = options[0];
  if (!best) return { reason: placed.length && !compatible(placed, ctx).length ? 'The sowing windows near this date need irrigation the field lacks.' : `No sourced sowing window within ${MAX_SHIFT_DAYS} days of ${fmt(target)}.` };
  return { sowing: best.day, hit: { window: best.w, conditional: best.c.conditional, note: best.c.note }, shiftedDays: best.shift };
}

export interface PlacedPlan { plan: SlotPlan; shiftedDays: number; target: string | null }

/**
 * Every pool crop, product, establishment method and sourced duration class placed at its sowing day (one placement per
 * crop; durations decide the harvest window). Crops with no window near the date, no sourced duration or excluded by
 * the farmer are listed in `unplaced` with the reason.
 */
export function placeCandidates(ctx: EngineContext, resolved: ResolvedMode): { placed: PlacedPlan[]; unplaced: Unplaced[] } {
  const placed: PlacedPlan[] = [];
  const unplaced: Unplaced[] = [];
  for (const entry of data.poolEntries()) {
    const { cropId } = entry;
    if (!entry.productIds.length) continue; // no marketed product (for example a green manure): not a crop-fit candidate
    if (ctx.excludedCropIds.includes(cropId)) { unplaced.push({ cropId, productId: null, reason: 'Excluded by the farmer.' }); continue; }
    if (!data.agronomyCrop(cropId)) { unplaced.push({ cropId, productId: null, reason: 'No agronomy record.' }); continue; }
    const methods = data.methodsFor(cropId);
    if (!methods.length) { unplaced.push({ cropId, productId: null, reason: 'No sourced crop-completion duration.' }); continue; }
    const where = placeCrop(ctx, cropId, resolved);
    if ('reason' in where) { unplaced.push({ cropId, productId: null, reason: where.reason }); continue; }
    for (const productId of entry.productIds) {
      let any = false;
      for (const method of methods) {
        data.durationFor(cropId, method, ctx.stateId, productId).forEach((cls, ci) => {
          any = true;
          const sowing = where.sowing;
          const plan = makeSlotPlan(ctx, {
            key: `fit:${cropId}|${productId}|${method}|d${ci}|${sowing}`, cropId, productId, method, sowing,
            harvest: { earliest: addDays(sowing, cls.min), latest: addDays(sowing, cls.max) }, season: where.hit.window.season,
            durationDays: { low: cls.min, high: cls.max }, duration: cls, hit: where.hit,
          });
          placed.push({ plan, shiftedDays: where.shiftedDays, target: resolved.target });
        });
      }
      if (!any) unplaced.push({ cropId, productId, reason: 'No sourced duration for this product.' });
    }
  }
  return { placed, unplaced };
}

/** Overlap with the growing crop or a saved season, as a plain sentence; null when the field is free. */
export function occupancyConflict(ctx: EngineContext, plan: SlotPlan): string | null {
  const fx = ctx.fixedSlot;
  if (fx && overlaps(plan.occupancy.from, plan.occupancy.to, fx.occupancy.from, fx.occupancy.to)) return `The field is expected to be under ${cropName(fx.cropId).toLowerCase()} until ${fmt(fx.occupancy.to)}.`;
  const o = ctx.occupied.find((x) => overlaps(plan.occupancy.from, plan.occupancy.to, x.from, x.to));
  return o ? `Overlaps a saved season or another crop on this field (${cropName(o.cropId).toLowerCase()}, ${fmt(o.from)} to ${fmt(o.to)}).` : null;
}

const round4 = (x: number) => Math.round(clip(x, 0, 1) * 10000) / 10000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Round 3 (ROUND3_SPEC 5 item 2): score points deducted for the idle days before a sowing, from the year-plan idle
 * penalty (ASSUMPTIONS.idlePenalty, an engine assumption): 100 x perMonth x max(0, waitDays / daysPerMonth - freeMonths).
 */
export function waitPenaltyFor(waitDays: number): number {
  const { perMonth, freeMonths } = ASSUMPTIONS.idlePenalty.value;
  return round2(100 * perMonth * Math.max(0, waitDays / ASSUMPTIONS.daysPerMonth.value - freeMonths));
}

/** Intercrop system id of a plan (round 3, P1's SlotPlan.intercrop); read defensively so this works before P1 lands. */
export const intercropSystemOf = (plan: SlotPlan): string | null => {
  const ic = (plan as { kind?: string; intercrop?: { systemId?: unknown } | null }).intercrop;
  return (plan as { kind?: string }).kind === 'intercrop' && ic && typeof ic.systemId === 'string' ? ic.systemId : null;
};
const candidateKey = (plan: SlotPlan) => `${plan.cropId}|${plan.productId}|${intercropSystemOf(plan) ?? ''}`;

/**
 * Round 3 (ROUND3_SPEC 5 items 1-2): `next` and `season` use the year plan's own candidates (enumerateCandidates: every
 * weekly sowing date inside a usable sourced window, after the field release, harvested inside the horizon, clear of
 * saved seasons; intercrops included, green manures excluded). `next` keeps them all; `season` keeps that season's
 * dates within 12 months of the floor. Pool crops that produced no candidate are listed with the reason.
 */
export function planCandidates(ctx: EngineContext, resolved: ResolvedMode, set: CandidateSet): { placed: PlacedPlan[]; unplaced: Unplaced[] } {
  const poolCrops = new Set(data.poolEntries().filter((e) => e.productIds.length).map((e) => e.cropId));
  const until = addDays(resolved.floor, 365);
  const crops = set.candidates.filter((c) => c.kind !== 'green_manure');
  const kept = resolved.request.mode === 'season'
    ? crops.filter((c) => c.season === resolved.season && c.sowing >= resolved.floor && c.sowing < until)
    : crops.filter((c) => c.sowing >= resolved.floor);
  const placed = kept.map((plan) => ({ plan, shiftedDays: 0, target: null }));
  // Skips of the green manure loop carry productId = cropId; a crop fit lists marketed pool crops only.
  const unplaced: Unplaced[] = set.skipped.filter((x) => poolCrops.has(x.cropId) && !(data.isGreenManure(x.cropId) && x.productId === x.cropId)).map((x) => ({ cropId: x.cropId, productId: x.productId, reason: x.reason }));
  const listed = new Set([...placed.map((p) => p.plan.cropId), ...unplaced.map((u) => u.cropId)]);
  for (const entry of data.poolEntries()) {
    if (!entry.productIds.length || listed.has(entry.cropId)) continue;
    unplaced.push({ cropId: entry.cropId, productId: null, reason: resolved.request.mode === 'season'
      ? `No sourced ${resolved.season} sowing week between ${fmt(resolved.floor)} and ${fmt(until)} that is harvested by ${fmt(addDays(ctx.horizon.to, -1))} and fits the free months of the field.`
      : 'No sowing date fits the free months of the field within the year plan horizon.' });
  }
  return { placed, unplaced };
}

/**
 * Round 3 decision (orchestrator, 2026-11-01): `season` covers 12 months from the floor as before. The year plan's
 * context is widened to horizon.to = max(plan horizon end, floor + 366 days) with the same earliestSowing, adding the
 * occupied intervals (cycles, saved seasons) of the next horizon (`next`, buildScenario for the next horizon start) that
 * start before the new end. Candidates past the plan horizon are then enumerated and scored by the same functions.
 */
export function seasonContext(ctx: EngineContext, floor: string, next: EngineContext | null): EngineContext {
  const end = addDays(floor, 366);
  if (end <= ctx.horizon.to) return ctx;
  const known = new Set(ctx.occupied.map((o) => `${o.source}:${o.id}`));
  const extra = (next?.occupied ?? []).filter((o) => !known.has(`${o.source}:${o.id}`) && o.id !== ctx.fixedSlot?.cycleId && o.from < end);
  const occupied = [...ctx.occupied, ...extra].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
  return { ...ctx, horizon: { from: ctx.horizon.from, to: end }, occupied };
}

export interface RankOptions {
  /** Normaliser to score with (the year plan's: marginNormaliser over its candidate set); default: over the placements. */
  norm?: ScoringNorm | undefined;
  /** Day the wait is counted from (next: ctx.earliestSowing; season: the floor; date: the requested date); null = no wait. */
  waitFrom?: string | null | undefined;
  /** Deduct the wait penalty from the score for the ranking (next mode). */
  penaliseWait?: boolean | undefined;
  /** Previous crop for every placement (date mode `after`); default the field's own history (predecessorOf). */
  previousOverride?: string | null | undefined;
}

/**
 * Scores every placement with evaluateSlot (shared inputs and normaliser) plus the year-plan transition score from the
 * previous crop: score = slotDisplayScore (price 40, yield 30, soil and rotation 15, water 10, confidence 5) on 0..100,
 * the same figure the year plan shows for that slot (its first suggested slot uses the same predecessorOf rule).
 */
export function scorePlacements(ctx: EngineContext, inputs: Inputs, placed: readonly PlacedPlan[], opts: RankOptions = {}): RankedCandidate[] {
  const norm = opts.norm ?? marginNormaliser(ctx, placed.map((p) => p.plan), inputs);
  return placed.map((p) => {
    const ev = evaluateSlot(ctx, inputs, p.plan, norm);
    const previousCropId = opts.previousOverride ?? previousFor(ctx, p.plan.sowing);
    const rotation = soilRotationScore(previousCropId ? data.rotationFacts(previousCropId) : null, data.rotationFacts(p.plan.cropId), data.legumeCredit, inputs.soilPh);
    const components = { price: ev.price.value, yield: ev.yield.value, soilRotation: rotation.value, water: ev.water.value, confidence: ev.confidence.value };
    const conflict = occupancyConflict(ctx, p.plan);
    const codes: string[] = reasonCodes({ codes: [...ev.codes, ...rotation.reasonCodes, ...(conflict ? ['occupancy_conflict' as ReasonCode] : [])], flags: p.plan.flags, windowScope: p.plan.window?.scope ?? null, fixed: false }, components);
    if (conflict && !codes.includes('occupancy_conflict')) codes.push('occupancy_conflict');
    if (p.shiftedDays !== 0) codes.push(WINDOW_SHIFTED);
    const uncertainties: string[] = [];
    if (p.shiftedDays !== 0 && p.target) uncertainties.push(`Sowing moved ${Math.abs(p.shiftedDays)} day${Math.abs(p.shiftedDays) === 1 ? '' : 's'} ${p.shiftedDays > 0 ? 'later' : 'earlier'}, from ${fmt(p.target)} to ${fmt(p.plan.sowing)}, to fall inside the sourced ${p.plan.season} window (window_shifted).`);
    if (conflict) uncertainties.push(conflict);
    uncertainties.push(...ev.uncertainties);
    const score = Math.round(clip(slotDisplayScore(components), 0, 1) * 10000) / 100;
    // The wait counts from the field's real release before this sowing: the later of waitFrom and the end of the last
    // occupied interval (a saved season, a cycle) that frees the field on or before the sowing day (orchestrator, 2026-11-01).
    const release = ctx.occupied.filter((o) => o.to <= p.plan.sowing && (!opts.waitFrom || o.to > opts.waitFrom)).map((o) => o.to).sort().at(-1) ?? opts.waitFrom ?? null;
    const waitDays = release ? Math.max(0, daysBetween(release, p.plan.sowing)) : null;
    const waitPenalty = opts.penaliseWait && waitDays !== null ? waitPenaltyFor(waitDays) : 0;
    return {
      plan: p.plan, ev, rotation, previousCropId, shiftedDays: p.shiftedDays, score, waitDays, waitPenalty, rankScore: round2(clip(score - waitPenalty, 0, 100)),
      components: { price: round4(components.price), yield: round4(components.yield), soilRotation: round4(components.soilRotation), water: round4(components.water), confidence: round4(components.confidence) },
      reasonCodes: codes.slice(0, 10), uncertainties: [...new Set(uncertainties)].slice(0, 10).map((u) => u.slice(0, 600)), occupancyConflict: conflict,
    };
  });
}

/**
 * Best placement per crop and product (an intercrop system is its own entry) by rankScore (= score less the wait
 * penalty; equal to the score outside next mode), then the smaller window shift, the earlier sowing and the key; sorted
 * by rankScore, then score, crop and product.
 */
export function rankCandidates(ctx: EngineContext, inputs: Inputs, placed: readonly PlacedPlan[], opts: RankOptions = {}): RankedCandidate[] {
  const best = new Map<string, RankedCandidate>();
  for (const c of scorePlacements(ctx, inputs, placed, opts)) {
    const key = candidateKey(c.plan);
    const cur = best.get(key);
    const better = !cur || c.rankScore > cur.rankScore || (c.rankScore === cur.rankScore && (c.score > cur.score || (c.score === cur.score && (Math.abs(c.shiftedDays) < Math.abs(cur.shiftedDays)
      || (Math.abs(c.shiftedDays) === Math.abs(cur.shiftedDays) && (c.plan.sowing < cur.plan.sowing || (c.plan.sowing === cur.plan.sowing && c.plan.key < cur.plan.key)))))));
    if (better) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.plan.cropId.localeCompare(b.plan.cropId) || a.plan.productId.localeCompare(b.plan.productId) || a.plan.key.localeCompare(b.plan.key));
}
