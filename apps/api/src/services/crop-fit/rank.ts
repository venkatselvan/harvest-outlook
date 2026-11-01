import type { CropFitRequest, CropSeason } from '@harvest/contracts';
import * as data from '../year-plan/data';
import { addDays, daysBetween, isCalendarDate, overlaps } from '../year-plan/dates';
import { makeSlotPlan, predecessorOf, type WindowHit } from '../year-plan/candidates';
import { evaluateSlot, marginNormaliser } from '../year-plan/assemble';
import { clip, reasonCodes, slotDisplayScore, soilRotationScore, type ReasonCode } from '../year-plan/scoring';
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
 * Effective request: `season` keeps only the season, `date` only the sowing date (defaulting to today), `next` neither.
 * With no mode the default is `next` when a crop is growing and `date` (today) on a fresh field.
 */
export function normaliseRequest(raw: { mode?: CropFitRequest['mode'] | undefined; season?: CropSeason | undefined | null; sowing?: string | undefined | null }, hasCycle: boolean, today: string): CropFitRequest {
  const mode = raw.mode ?? (hasCycle ? 'next' : 'date');
  if (mode === 'season') {
    if (!raw.season) throw new Error('season is required when mode is season');
    return { mode, season: raw.season, sowing: null };
  }
  if (mode === 'date') {
    const sowing = raw.sowing ?? today;
    if (!isCalendarDate(sowing)) throw new Error('sowing must be a calendar date (YYYY-MM-DD)');
    return { mode, season: null, sowing };
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
  return { request, target, floor: ctx.asOf < target ? ctx.asOf : target, previousCropId: previousFor(ctx, target), season: null, notes };
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

/**
 * Scores every placement with evaluateSlot (shared inputs, marginNormaliser over all placements) plus the year-plan
 * transition score from the previous crop, and keeps the best method and duration class per crop and product.
 * Score = slotDisplayScore (price 40, yield 30, soil and rotation 15, water 10, confidence 5) on 0..100.
 */
export function rankCandidates(ctx: EngineContext, inputs: Inputs, placed: readonly PlacedPlan[]): RankedCandidate[] {
  const norm = marginNormaliser(ctx, placed.map((p) => p.plan), inputs);
  const best = new Map<string, RankedCandidate>();
  for (const p of placed) {
    const ev = evaluateSlot(ctx, inputs, p.plan, norm);
    const previousCropId = previousFor(ctx, p.plan.sowing);
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
    const c: RankedCandidate = {
      plan: p.plan, ev, rotation, previousCropId, shiftedDays: p.shiftedDays, score,
      components: { price: round4(components.price), yield: round4(components.yield), soilRotation: round4(components.soilRotation), water: round4(components.water), confidence: round4(components.confidence) },
      reasonCodes: codes.slice(0, 10), uncertainties: [...new Set(uncertainties)].slice(0, 10).map((u) => u.slice(0, 600)), occupancyConflict: conflict,
    };
    const key = `${p.plan.cropId}|${p.plan.productId}`;
    const cur = best.get(key);
    if (!cur || c.score > cur.score || (c.score === cur.score && (Math.abs(c.shiftedDays) < Math.abs(cur.shiftedDays) || (Math.abs(c.shiftedDays) === Math.abs(cur.shiftedDays) && c.plan.key < cur.plan.key)))) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.plan.cropId.localeCompare(b.plan.cropId) || a.plan.productId.localeCompare(b.plan.productId));
}
