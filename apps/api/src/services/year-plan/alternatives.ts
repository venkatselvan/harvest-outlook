import type { z } from 'zod';
import type { FarmWorkspaceState, YearPlanAlternatives as YearPlanAlternativesSchema, YearPlanOption, YearPlanReplacement as YearPlanReplacementSchema } from '@harvest/contracts';
import { cropDisplayName } from './data';
import { daysBetween, overlaps } from './dates';
import type { EngineRun } from './assemble';
import { isReplaceable } from './scenario';
import { deterministicSelection, selectionCandidates } from './select';
import type { EngineContext, OccupiedInterval } from './types';

/**
 * Year plan alternatives (docs/research/EVARA_ACTIONS_SPEC.md 1.3, 2026-11-04). Pure: no database, network or model call.
 * When the growing crop and the saved seasons leave no free window, the engine is run once more on a changed context and
 * code picks and labels up to three plans (deterministicSelection, the same labels as the main review):
 *
 * - 'replace_planned': the planned, unsown saved seasons (realisation planned or overdue) are set aside; the growing crop
 *   stays the fixed slot, recorded cycles and an assumed previous-year plan stay occupied. A slot that overlaps a set-aside
 *   season is what would replace it (ApplyYearPlan.alternative removes those seasons in the same write).
 * - 'sown_comparison': nothing is replaceable. The engine runs over the same horizon from the growing crop's sowing date with
 *   no fixed slot and the other recorded cycles occupied, after the crop the field carried before the growing one: what could
 *   have fitted the field from that date. Never appliable; the sown crop stays.
 */
// The contracts export these schemas without inferred types (proposed contract addition in the E1 report).
export type YearPlanAlternatives = z.infer<typeof YearPlanAlternativesSchema>;
export type YearPlanReplacement = z.infer<typeof YearPlanReplacementSchema>;
export const ALT_PREFIX = 'alt-';
export const MAX_ALTERNATIVES = 3;

export type AlternativesSetup =
  | { basis: 'replace_planned'; ctx: EngineContext; replaced: OccupiedInterval[] }
  | { basis: 'sown_comparison'; ctx: EngineContext; replaced: []; sownCropId: string; sownFrom: string }
  | { basis: null; reason: string };

/** The context the alternative run uses (see the module note), or why there is none. */
export function alternativesSetup(ctx: EngineContext): AlternativesSetup {
  const replaced = ctx.occupied.filter(isReplaceable);
  if (replaced.length) {
    const occupied = ctx.occupied.filter((o) => !isReplaceable(o));
    // Current horizon: earliestSowing never depends on saved seasons (buildScenario). A later horizon pushes it past intervals
    // that started before the horizon (futureScenario); recompute without the set-aside seasons, as fitsWithoutOccupants does.
    let earliestSowing = ctx.earliestSowing;
    if ((ctx.yearIndex ?? 0) > 0) {
      earliestSowing = ctx.horizon.from > ctx.asOf ? ctx.horizon.from : ctx.asOf;
      for (const o of occupied) if (o.from < ctx.horizon.from && o.to > earliestSowing) earliestSowing = o.to;
    }
    return { basis: 'replace_planned', ctx: { ...ctx, occupied, earliestSowing }, replaced };
  }
  const fx = ctx.fixedSlot;
  if (!fx) return { basis: null, reason: 'No crop is growing on this field and no saved season on it is planned but unsown, so there is no alternative plan to show.' };
  return {
    basis: 'sown_comparison', replaced: [], sownCropId: fx.cropId, sownFrom: fx.sowing,
    ctx: { ...ctx, fixedSlot: null, occupied: ctx.occupied.filter((o) => o.source === 'cycle'), earliestSowing: fx.sowing, transitionFromCropId: ctx.previousCropId },
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "12 Feb 2027" from an ISO date. */
export const dayMonthYear = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The saved season of a set-aside interval as the contract's replacement (names: the engine map, the farmer's name, the catalogue). */
export function replacementOf(o: Pick<OccupiedInterval, 'id'>, rotationPlans: FarmWorkspaceState['rotationPlans'], names?: EngineContext['names']): YearPlanReplacement | null {
  const p = rotationPlans.find((x) => x.id === o.id);
  if (!p) return null;
  return { rotationPlanId: p.id.slice(0, 160), cropId: p.cropId.slice(0, 120), cropName: (names?.crop?.[p.cropId] ?? p.cropName ?? cropDisplayName(p.cropId)).slice(0, 120), plannedSowingDate: p.plannedSowingDate ?? null };
}

/** "pigeon pea (planned 12 Feb 2027)" or "pigeon pea (planned 12 Feb 2026, not sown)" for an overdue one; joined with "and". */
export function replacesPhrase(rs: readonly YearPlanReplacement[], today: string): string {
  return list(rs.map((r) => `${r.cropName.toLowerCase()}${r.plannedSowingDate ? ` (planned ${dayMonthYear(r.plannedSowingDate)}${r.plannedSowingDate < today ? ', not sown' : ''})` : ''}`));
}

/** Option slots (fixed slot excluded) that overlap a replaced season's interval. */
export const overlapsInterval = (o: Pick<YearPlanOption, 'slots'>, iv: { from: string; to: string }): boolean =>
  o.slots.some((s) => !s.fixed && overlaps(s.occupancy.from, s.occupancy.to, iv.from, iv.to));

/** A suggested season counts as the saved season itself when sown within this many days of its planned sowing date. */
export const IDENTICAL_SOWING_DAYS = 7;
/**
 * The same crop and product sown within IDENTICAL_SOWING_DAYS of the saved season's planned sowing date (2026-11-04, seen on the
 * demo farm: the saved Maize offered as the replacement of itself). A saved season with no product names none, so the crop decides;
 * one with no planned sowing date is never identical.
 */
export function isSameAsSavedSeason(slot: { cropId: string; productId?: string | null | undefined; sowing: string }, plan: { cropId: string; productId?: string | undefined; plannedSowingDate?: string | undefined } | null | undefined): boolean {
  if (!plan?.plannedSowingDate || plan.cropId !== slot.cropId) return false;
  if (plan.productId && slot.productId && plan.productId !== slot.productId) return false;
  return Math.abs(daysBetween(plan.plannedSowingDate, slot.sowing)) <= IDENTICAL_SOWING_DAYS;
}

/** True when every non-fixed slot of the option is identical to one of the replaced saved seasons (an option with none is not). */
export function isTwinOfSavedSeasons(o: Pick<YearPlanOption, 'slots'>, replaced: readonly Pick<OccupiedInterval, 'id'>[], rotationPlans: FarmWorkspaceState['rotationPlans']): boolean {
  const plans = replaced.map((r) => rotationPlans.find((p) => p.id === r.id)).filter((p) => p !== undefined);
  const own = o.slots.filter((s) => !s.fixed);
  return own.length > 0 && own.every((s) => plans.some((p) => isSameAsSavedSeason(s, p)));
}

/** The shortlist without plans that only repeat the saved seasons (replace_planned basis only). */
function withoutTwins(setup: Exclude<AlternativesSetup, { basis: null }>, shortlist: readonly YearPlanOption[], rotationPlans: FarmWorkspaceState['rotationPlans']): YearPlanOption[] {
  return setup.basis === 'replace_planned' ? shortlist.filter((o) => !isTwinOfSavedSeasons(o, setup.replaced, rotationPlans)) : [...shortlist];
}

export const ONLY_SAVED_LIMITATION = 'The only plans that fit are the seasons already saved.';
/** True when the run found plans and every one of them only repeats the saved seasons (the limitation above explains no alternatives). */
export function onlySavedSeasonsFit(setup: Exclude<AlternativesSetup, { basis: null }>, run: Pick<EngineRun, 'sequencesConsidered' | 'shortlist'>, rotationPlans: FarmWorkspaceState['rotationPlans']): boolean {
  const own = run.shortlist.filter((o) => o.slots.some((s) => !s.fixed));
  return setup.basis === 'replace_planned' && run.sequencesConsidered > 0 && own.length > 0 && withoutTwins(setup, own, rotationPlans).length === 0;
}

/**
 * The alternatives from the run on the setup's context: up to three options picked and labelled by code (ids prefixed
 * 'alt-'), the replaced seasons, a code summary and limitations. Null when the run found no crop sequence or only plans that
 * repeat the saved seasons (same crop and product sown within a week of the planned date) which are dropped before labelling.
 */
export function alternativesFrom(ctx: EngineContext, setup: Exclude<AlternativesSetup, { basis: null }>, run: Pick<EngineRun, 'sequencesConsidered' | 'shortlist'>, rotationPlans: FarmWorkspaceState['rotationPlans']): YearPlanAlternatives | null {
  if (!run.sequencesConsidered) return null;
  const options = deterministicSelection(selectionCandidates(withoutTwins(setup, run.shortlist, rotationPlans)), MAX_ALTERNATIVES)
    .filter((o) => o.slots.some((s) => !s.fixed))
    .map((o) => ({ ...o, optionId: `${ALT_PREFIX}${o.optionId}`.slice(0, 120) }));
  if (!options.length) return null;
  const n = options.length;
  const plans = `${n} alternative plan${n > 1 ? 's' : ''}`;
  const limitations = [
    'Alternatives are picked and labelled by code from the scored crop sequences (no model selection); every date, range and score is calculated.',
  ];
  if (setup.basis === 'replace_planned') {
    const replaces = setup.replaced.map((o) => replacementOf(o, rotationPlans, ctx.names)).filter((r): r is YearPlanReplacement => r !== null).slice(0, 12);
    const phrase = replacesPhrase(replaces, ctx.asOf);
    const one = replaces.length === 1;
    limitations.push(`Each alternative keeps the growing crop and any recorded crop; a season that overlaps ${one ? 'the planned season' : 'a planned season'} would replace it, and using the plan removes ${one ? 'that season' : 'the seasons it overlaps'} from the saved seasons.`);
    if (options.some((o) => !setup.replaced.some((iv) => overlapsInterval(o, iv)))) limitations.push('A plan that overlaps no planned season fits around them and replaces nothing.');
    return {
      basis: 'replace_planned', replaces, horizon: { from: ctx.horizon.from, to: ctx.horizon.to }, options, limitations: limitations.map((l) => l.slice(0, 1000)),
      summary: `${capitalise(phrase)} ${one ? 'is' : 'are'} planned but not sown, so ${plans} below show what could grow instead; using one replaces the planned season${one ? '' : 's'} it overlaps.`.slice(0, 1000),
    };
  }
  const sown = (ctx.names?.crop?.[setup.sownCropId] ?? cropDisplayName(setup.sownCropId)).toLowerCase();
  limitations.push(`For comparison only: the plans start from the ${sown} sowing date (${dayMonthYear(setup.sownFrom)}) without the ${sown}, after the crop the field carried before it; they cannot be applied and the sown crop stays.`);
  if (setup.sownFrom < ctx.asOf) limitations.push('Sowing dates before today are shown for comparison; they have passed.');
  return {
    basis: 'sown_comparison', replaces: [], horizon: { from: setup.sownFrom, to: ctx.horizon.to }, options, limitations: limitations.map((l) => l.slice(0, 1000)),
    summary: `Every crop on this field is sown, so nothing new fits this year; for comparison, ${plans} below show what could have fitted the field from ${dayMonthYear(setup.sownFrom)}, and the sown ${sown} stays.`.slice(0, 1000),
  };
}
const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The review's own summary when alternatives exist: it points at them instead of reading as a dead end. */
export function reviewSummaryWithAlternatives(a: YearPlanAlternatives, hasGrowingCrop: boolean): string {
  const n = a.options.length;
  if (a.basis === 'replace_planned') {
    return `${hasGrowingCrop ? 'The growing crop and the planned seasons' : 'The planned seasons'} fill this year, so no new season fits around them; ${n} alternative plan${n > 1 ? 's' : ''} below would use the months of the planned, unsown season${a.replaces.length > 1 ? 's' : ''} instead.`;
  }
  return `The sown crops fill this year, so no new season fits; ${n} comparison plan${n > 1 ? 's' : ''} below show what could have fitted the field from ${dayMonthYear(a.horizon.from)}.`;
}
