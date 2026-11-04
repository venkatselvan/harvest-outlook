import type { BasisRef, FarmWorkspaceState, StageTimeline, YearPlanOccupant, YearPlanScenario } from '@harvest/contracts';
import { agronomyCrop, agronomySources, cropDisplayName, durationFor, IC_PREFIX, intercropSystem, poolEntry, seasonOfMonth, windowsFor } from './data';
import { addDays, addYears, daysBetween, isCalendarDate, monthOf, overlaps } from './dates';
import type { StageTimelineInput } from '../today/stage-timeline';
import { placeWindows } from './windows';
import { ASSUMPTIONS, assumptionBasis, irrigationClass } from './scoring';
import type { DateRange, EngineContext, FixedSlot, HarvestRange, OccupiedInterval } from './types';

/** Round 3 (ROUND3_SPEC 1): later horizons 1..3 after the current one. */
export const MAX_YEAR_INDEX = 3;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "Oct 2026" from an ISO date. */
export const monthYear = (d: string): string => `${MONTH_ABBR[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** `from` is not the start of the current or a later horizon; `allowed` lists the valid dates (current first). */
export class HorizonError extends Error {
  constructor(readonly allowed: string[]) { super(`from must be one of ${allowed.join(', ')}`); this.name = 'HorizonError'; }
}
/** The previous horizon's first plan, used as the predecessor when nothing recorded or saved ends in that horizon. */
export interface AssumedPredecessorInput { cropId: string; cropName?: string | undefined; occupancy: DateRange; optionLabel: string | null; horizonFrom: string; reviewId: string; signature: string }

/** Minimal farm view (FarmOut-compatible). Facts follow farm_facts: only farmer-reported, lab or confirmed values count. */
export interface ScenarioFarm {
  location: { stateCode: string | null; districtId: string | null };
  areaHectares: number | null;
  facts?: Record<string, { value: unknown; basis?: string | null | undefined; confirmed?: boolean | undefined }> | undefined;
}
/** The Today view's stage timeline (`stageTimeline` in services/today/stage-timeline.ts); injected so tests stay synthetic. */
export type TimelineFn = (input: StageTimelineInput) => StageTimeline;
export interface BuildScenarioArgs {
  workspace: Pick<FarmWorkspaceState, 'previousHarvest' | 'cycles' | 'rotationPlans'>;
  farm: ScenarioFarm;
  /** Review date (farm-local calendar day). */
  asOf: string;
  soilSummary?: string | null | undefined;
  neighbourhoodActiveMonths?: number[] | null | undefined;
  names?: EngineContext['names'];
  /**
   * Stage timeline source for the current cycle. When given and the cycle has no recorded harvest date, the fixed slot uses
   * the timeline's harvest window (ASSUMPTIONS.timelineHarvestBufferDays). Omitted: the duration rule is used. The year-plan
   * service always passes the real `stageTimeline`.
   */
  timeline?: TimelineFn | undefined;
  /** Round 3: start of a later horizon (from_1..from_3); null, absent or the current start = the current horizon. */
  horizonFrom?: string | null | undefined;
  /** Round 3: resolved by the service from the previous horizon's ready review (future horizons only). */
  assumedPredecessor?: AssumedPredecessorInput | null | undefined;
}

/** A farm fact value that counts (farmer-reported, lab or confirmed); exported for the Today footprint (no behaviour change). */
export function factValue(farm: ScenarioFarm, key: string): unknown {
  const f = farm.facts?.[key];
  if (!f || f.basis === 'unknown') return undefined;
  return f.basis === 'farmer_reported' || f.basis === 'lab_test' || f.confirmed ? f.value : undefined;
}

interface Occupancy { harvest: HarvestRange; to: string; basis: 'recorded' | 'sourced_duration' | 'assumed_duration'; durationDays: { low: number; high: number }; sources: string[]; notes: string[]; timelineBasis?: BasisRef | undefined }

/**
 * Field occupancy of a cycle or saved season. Recorded harvest: until harvest + land preparation gap. Otherwise the
 * sourced duration envelope gives the harvest window and the field is held conservatively until sowing + longest
 * duration + 15 days + gap; with no sourced duration an assumed 180 days is used instead and flagged.
 */
export function occupancyFor(cropId: string, productId: string | null, method: string | null, sowing: string, recordedHarvest: string | null, stateId: string | null): Occupancy {
  const gap = ASSUMPTIONS.landPrepGapDays.value;
  if (recordedHarvest) {
    const d = Math.max(0, Math.round((Date.parse(recordedHarvest) - Date.parse(sowing)) / 86_400_000));
    return { harvest: { earliest: recordedHarvest, latest: recordedHarvest }, to: addDays(recordedHarvest, gap), basis: 'recorded', durationDays: { low: d, high: d }, sources: [], notes: [] };
  }
  const classes = durationFor(cropId, method, stateId, productId);
  const buffer = ASSUMPTIONS.unknownHarvestBufferDays.value;
  if (classes.length) {
    const min = Math.min(...classes.map((c) => c.min));
    const max = Math.max(...classes.map((c) => c.max));
    return {
      harvest: { earliest: addDays(sowing, min), latest: addDays(sowing, max) }, to: addDays(sowing, max + buffer + gap), basis: 'sourced_duration', durationDays: { low: min, high: max },
      sources: [...new Set(classes.flatMap((c) => c.sources))],
      notes: [`No harvest date recorded: harvest is the sourced ${min}-${max} day range, and the field is held until ${buffer} days after the latest date plus a ${gap}-day land preparation gap.`],
    };
  }
  const days = ASSUMPTIONS.unknownDurationDays.value;
  return {
    harvest: { earliest: addDays(sowing, days), latest: addDays(sowing, days) }, to: addDays(sowing, days + buffer + gap), basis: 'assumed_duration', durationDays: { low: days, high: days }, sources: [],
    notes: [`No harvest date recorded and no sourced duration for ${cropId}: the engine assumes ${days} days plus ${buffer} days and a ${gap}-day gap. Record the expected harvest date to replace this.`],
  };
}

/**
 * Occupancy from the crop's stage timeline (the harvest window the Today view shows): the field is held until the latest
 * harvest date + ASSUMPTIONS.timelineHarvestBufferDays + the land preparation gap. Null when the timeline has no harvest window.
 */
export function timelineOccupancy(tl: StageTimeline, sowing: string): Occupancy | null {
  if (!tl.harvest) return null;
  const gap = ASSUMPTIONS.landPrepGapDays.value;
  const buffer = ASSUMPTIONS.timelineHarvestBufferDays.value;
  const { earliest, latest } = tl.harvest;
  const to = addDays(latest, buffer + gap);
  return {
    harvest: { earliest, latest }, to, basis: tl.basis.sourceId ? 'sourced_duration' : 'assumed_duration',
    durationDays: { low: Math.max(0, daysBetween(sowing, earliest)), high: Math.max(0, daysBetween(sowing, latest)) }, sources: [],
    notes: [`Harvest date not recorded; estimated from the recorded sowing date and the crop's stage model (${earliest} to ${latest}). The field is held until ${buffer ? `${buffer} days after the latest date plus ` : 'the latest date plus '}a ${gap}-day land preparation gap.`],
    timelineBasis: tl.basis,
  };
}

function fixedSlotFor(cycle: FarmWorkspaceState['cycles'][number], stateId: string | null, districtId: string | null, timeline: TimelineFn | undefined, warnings: string[]): FixedSlot {
  const productId = cycle.productId ?? poolEntry(cycle.cropId)?.productIds[0] ?? agronomyCrop(cycle.cropId)?.productIds[0] ?? cycle.cropId;
  const method = cycle.establishmentMethod ?? null;
  let occ: Occupancy | null = null;
  if (!cycle.harvestDate && timeline) {
    // Same inputs as the Today view (services/today/view.ts), so the displayed harvest window is identical.
    try {
      occ = timelineOccupancy(timeline({ cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: cycle.establishmentDate ?? cycle.sowingDate, stateId, districtId }), cycle.sowingDate);
    } catch (e) {
      warnings.push(`The stage timeline for ${cycle.cropId} could not be computed (${(e as Error).message.slice(0, 120)}); the longest sourced duration plus a precaution is used for the harvest date instead.`);
    }
  }
  const timelineUsed = occ !== null;
  occ ??= occupancyFor(cycle.cropId, productId, method, cycle.sowingDate, cycle.harvestDate ?? null, stateId);
  const scoped = windowsFor(cycle.cropId, { stateId, districtId }).filter((w) => w.usable);
  const hit = placeWindows(scoped, { from: addDays(cycle.sowingDate, -400), to: addDays(cycle.sowingDate, 400) }).find((p) => p.from <= cycle.sowingDate && cycle.sowingDate <= p.to) ?? null;
  const basis: BasisRef[] = [];
  for (const s of occ.sources.flatMap((x) => agronomySources(x)).slice(0, 3)) basis.push({ kind: 'duration', label: s.title ?? s.id, sourceId: s.id, url: s.url, scope: null, note: s.locator });
  if (occ.timelineBasis) { basis.push(occ.timelineBasis); basis.push(assumptionBasis('timelineHarvestBufferDays')); }
  else if (occ.basis !== 'recorded') basis.push(assumptionBasis(occ.basis === 'assumed_duration' ? 'unknownDurationDays' : 'unknownHarvestBufferDays'));
  basis.push(assumptionBasis('landPrepGapDays'));
  // The current crop is already in the ground: window fit 1 and no outside_window reason (ASSUMPTIONS.fixedSlotWindowFit).
  basis.push(assumptionBasis('fixedSlotWindowFit'));
  const windowFit = ASSUMPTIONS.fixedSlotWindowFit.value;
  return {
    key: `fixed:${cycle.id}`, cycleId: cycle.id, cropId: cycle.cropId, productId, method, season: hit?.season ?? seasonOfMonth(monthOf(cycle.sowingDate)), fixed: true,
    sowing: cycle.sowingDate, harvest: occ.harvest, occupancy: { from: cycle.sowingDate, to: occ.to }, durationDays: occ.durationDays,
    durationSourced: occ.basis === 'sourced_duration', window: hit, windowFit, harvestBasis: occ.basis, timelineEstimate: timelineUsed,
    flags: { stateWindowFallback: hit?.scope === 'state', provisionalWindow: !!hit?.provisional, outsideWindow: false, landPrepGapAssumed: true, conditional: false, durationOtherState: false, harvestAssumed: occ.basis !== 'recorded' },
    uncertainties: occ.notes, basis,
  };
}

/**
 * 2026-11-04 (docs/research/EVARA_ACTIONS_SPEC.md 1.1): a saved season counts as sown when a recorded cycle of the same crop
 * on the same field (or a cycle recorded for the whole farm, or the season itself saved for the whole farm) was sown within
 * this many days of its planned sowing date. Orchestrator decision in the spec; not an agronomic figure.
 */
export const REALISED_WITHIN_DAYS = 45;
export type SeasonRealisation = 'planned' | 'overdue' | 'sown';
type CycleLike = Pick<FarmWorkspaceState['cycles'][number], 'id' | 'cropId' | 'sowingDate'> & { fieldId?: string | undefined };
type SeasonLike = Pick<FarmWorkspaceState['rotationPlans'][number], 'cropId' | 'plannedSowingDate'> & { fieldId?: string | undefined };

/**
 * The recorded cycle that realises a saved season (EVARA_ACTIONS_SPEC 1.1): same cropId (an intercrop season's main crop),
 * sowing within REALISED_WITHIN_DAYS of the planned date, and the same field, or either side recorded for the whole farm
 * (no fieldId). Any stage counts, a harvested cycle too. The closest sowing wins, then the cycle id; null when none (or the
 * season has no planned date).
 */
export function realisingCycle<C extends CycleLike>(season: SeasonLike, cycles: readonly C[]): C | null {
  const planned = season.plannedSowingDate;
  if (!planned) return null;
  const hits = cycles.filter((c) => c.cropId === season.cropId && (c.fieldId === undefined || season.fieldId === undefined || c.fieldId === season.fieldId)
    && Math.abs(daysBetween(c.sowingDate, planned)) <= REALISED_WITHIN_DAYS);
  return hits.sort((a, b) => Math.abs(daysBetween(a.sowingDate, planned)) - Math.abs(daysBetween(b.sowingDate, planned)) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Realisation of a saved season on a field view (EVARA_ACTIONS_SPEC 1.1): 'sown' when a recorded cycle realises it
 * (realisingCycle); otherwise 'planned' when its planned sowing date is `today` (the IST calendar date) or later, 'overdue'
 * when it has passed. planned and overdue are replaceable. Null for a season without a planned sowing date.
 */
export function seasonRealisation(season: SeasonLike, cycles: readonly CycleLike[], today: string): SeasonRealisation | null {
  if (!season.plannedSowingDate) return null;
  if (realisingCycle(season, cycles)) return 'sown';
  return season.plannedSowingDate >= today ? 'planned' : 'overdue';
}
export const isReplaceable = (o: Pick<OccupiedInterval, 'source' | 'realisation'>): boolean => o.source === 'rotation_plan' && (o.realisation === 'planned' || o.realisation === 'overdue');

/** Contract cap of YearPlanScenario.occupied. */
export const MAX_OCCUPANTS = 24;
/** Id prefix of the occupied interval futureScenario adds for the previous year's unsaved plan. */
export const ASSUMED_PREFIX = 'assumed:';
/** A rotation token 'ic:<systemId>' resolved to the system's main crop (the occupant shows the real crop). */
export const realCropId = (id: string): string => (id.startsWith(IC_PREFIX) ? intercropSystem(id.slice(IC_PREFIX.length))?.mainCropId ?? id.slice(IC_PREFIX.length) : id);

/**
 * Saved-season follow-up (docs/research/YEAR_PLAN_SAVED_SEASONS.md, 2026-11-01): the occupied intervals of a horizon as the
 * review's occupants, in the given order (callers pass them sorted by sowing, then id), at most MAX_OCCUPANTS. A saved season
 * carries its own crop (an intercrop's main crop, never the engine's 'ic:' rotation token), product, kind, companion, method
 * and planned dates; a cycle its recorded dates; the assumed previous-year plan its crop and occupancy start. `occupancy` and
 * `occupancyBasis` are the engine's interval, unclipped. Names: crops the engine's name map first, then the farmer's own name,
 * then the catalogue display name; products and the companion the farmer's own name first (a product without one: the map,
 * else null). Strings are cut to the contract's lengths.
 */
export function occupantsOf(intervals: readonly OccupiedInterval[], workspace: Pick<FarmWorkspaceState, 'cycles' | 'rotationPlans'>, names: EngineContext['names'], assumed: AssumedPredecessorInput | null | undefined): YearPlanOccupant[] {
  const cropName = (id: string, own?: string | undefined) => (names?.crop?.[id] ?? own ?? cropDisplayName(id)).slice(0, 120);
  const productName = (id: string | null, own?: string | undefined) => { const n = own ?? (id ? names?.product?.[id] : undefined); return n ? n.slice(0, 120) : null; };
  const out: YearPlanOccupant[] = [];
  for (const o of intervals) {
    if (out.length >= MAX_OCCUPANTS) break;
    const shared = { occupancy: { from: o.from, to: o.to }, occupancyBasis: o.basis, note: o.note ? o.note.slice(0, 1000) : null };
    if (o.source === 'cycle') {
      const c = workspace.cycles.find((x) => x.id === o.id);
      if (!c) continue;
      const productId = c.productId ? c.productId.slice(0, 200) : null;
      out.push({
        id: c.id.slice(0, 160), source: 'recorded_cycle', cropId: c.cropId.slice(0, 120), productId, cropName: cropName(c.cropId, c.cropName), productName: productName(c.productId ?? null, c.productName),
        kind: 'crop', companion: null, establishmentMethod: c.establishmentMethod ? c.establishmentMethod.slice(0, 80) : null, sowing: c.sowingDate, harvestDate: c.harvestDate ?? null, ...shared,
        // EVARA_ACTIONS_SPEC 1.1: a recorded cycle is sown and never replaceable.
        realisation: 'sown',
      });
    } else if (assumed && o.id === `${ASSUMED_PREFIX}${assumed.reviewId}`) {
      const cropId = realCropId(assumed.cropId);
      // Same name the scenario's assumedPredecessor shows.
      out.push({
        id: o.id.slice(0, 160), source: 'assumed_plan', cropId: cropId.slice(0, 120), productId: null, cropName: (assumed.cropName ?? cropName(cropId)).slice(0, 120), productName: null,
        kind: 'crop', companion: null, establishmentMethod: null, sowing: o.from, harvestDate: null, ...shared,
      });
    } else {
      const p = workspace.rotationPlans.find((x) => x.id === o.id);
      if (!p?.plannedSowingDate) continue;
      const productId = p.productId ? p.productId.slice(0, 200) : null;
      const comp = p.companion;
      out.push({
        id: p.id.slice(0, 160), source: 'saved_season', cropId: p.cropId.slice(0, 120), productId, cropName: cropName(p.cropId, p.cropName), productName: productName(p.productId ?? null, p.productName),
        kind: p.kind ?? 'crop',
        companion: comp ? { systemId: comp.systemId ? comp.systemId.slice(0, 120) : null, cropId: comp.cropId.slice(0, 120), cropName: (comp.cropName ?? names?.crop?.[comp.cropId] ?? cropDisplayName(comp.cropId)).slice(0, 120), rowRatio: comp.rowRatio.slice(0, 20) } : null,
        establishmentMethod: p.establishmentMethod ? p.establishmentMethod.slice(0, 80) : null, sowing: p.plannedSowingDate, harvestDate: p.plannedHarvestDate ?? null, ...shared,
        // A saved-season interval is never 'sown' (a realised season is not an interval); absent only on hand-built intervals.
        ...(o.realisation ? { realisation: o.realisation } : {}),
      });
    }
  }
  return out;
}

/**
 * Scenario for the year plan (spec section 2). Occupied: the latest active cycle sown on or before asOf is fixed as
 * slot 1 and the horizon runs 12 months from its sowing. Fresh: the horizon runs 12 months from asOf. Other active
 * cycles and saved seasons with a planned sowing date become occupied intervals that no suggestion may overlap.
 */
export function buildScenario(args: BuildScenarioArgs): EngineContext {
  const { workspace, farm, asOf } = args;
  if (!isCalendarDate(asOf)) throw new Error(`asOf must be a calendar date (YYYY-MM-DD), got ${asOf}`);
  const stateId = farm.location.stateCode;
  const districtId = farm.location.districtId;
  const warnings: string[] = [];
  const irrigationRaw = factValue(farm, farm.facts?.irrigation_category ? 'irrigation_category' : 'irrigation');
  const irrigationText = typeof irrigationRaw === 'string' ? irrigationRaw.slice(0, 80) : null;
  const irrigation = irrigationClass(irrigationText);
  if (irrigationText && !irrigation) warnings.push(`Irrigation category "${irrigationText}" is not recognised; no irrigation allowance is applied.`);
  const excludedRaw = factValue(farm, 'excluded_crop_ids');
  // Fact values are scalars in farm_facts; accept an array (API payloads) or a comma-separated string.
  const excludedCropIds = Array.isArray(excludedRaw) ? excludedRaw.filter((x): x is string => typeof x === 'string') : typeof excludedRaw === 'string' ? excludedRaw.split(',').map((x) => x.trim()).filter(Boolean) : [];

  const active = workspace.cycles.filter((c) => c.stage !== 'harvested');
  const current = [...active].filter((c) => c.sowingDate <= asOf).sort((a, b) => b.sowingDate.localeCompare(a.sowingDate) || a.id.localeCompare(b.id))[0] ?? null;
  const from = current ? current.sowingDate : asOf;
  const horizon = { from, to: addYears(from, 1) };
  const fixedSlot = current ? fixedSlotFor(current, stateId, districtId, args.timeline, warnings) : null;

  const occupied: OccupiedInterval[] = [];
  for (const c of active) {
    if (c.id === current?.id) continue;
    const o = occupancyFor(c.cropId, c.productId ?? null, c.establishmentMethod ?? null, c.sowingDate, c.harvestDate ?? null, stateId);
    occupied.push({ id: c.id, cropId: c.cropId, source: 'cycle', from: c.sowingDate, to: o.to, basis: o.basis, note: o.notes[0] ?? null });
  }
  for (const p of workspace.rotationPlans) {
    if (!p.plannedSowingDate) { warnings.push(`Saved season ${p.season} ${p.year} (${p.cropId}) has no planned sowing date and cannot be placed on the calendar.`); continue; }
    // EVARA_ACTIONS_SPEC 1.1: a saved season a recorded cycle realises is that cycle (fixed slot or occupant); not drawn twice.
    const realisation = seasonRealisation(p, workspace.cycles, asOf);
    if (realisation === 'sown') continue;
    const o = occupancyFor(p.cropId, p.productId ?? null, null, p.plannedSowingDate, p.plannedHarvestDate ?? null, stateId);
    // An intercrop season with a sourced system nitrogen credit is a legume predecessor for rotation (token ic:<systemId>).
    const rotId = p.kind === 'intercrop' && p.companion?.systemId && intercropSystem(p.companion.systemId)?.nitrogenCredit?.sourced ? `${IC_PREFIX}${p.companion.systemId}` : p.cropId;
    occupied.push({ id: p.id, cropId: rotId, source: 'rotation_plan', from: p.plannedSowingDate, to: o.to, basis: o.basis === 'recorded' ? 'planned' : o.basis, note: o.notes[0] ?? null, realisation: realisation ?? undefined });
  }
  const futures = Array.from({ length: MAX_YEAR_INDEX }, (_, i) => addYears(horizon.to, i));
  const horizonStarts = { current: { ...horizon }, futures };
  if (args.horizonFrom && args.horizonFrom !== horizon.from) {
    const k = futures.indexOf(args.horizonFrom);
    if (k < 0) throw new HorizonError([horizon.from, ...futures]);
    return futureScenario(args, { yearIndex: k + 1, horizonStarts, current, fixedSlot, occupied, stateId, districtId, irrigation, irrigationText, excludedCropIds, warnings });
  }
  const inHorizon = occupied.filter((o) => overlaps(o.from, o.to, horizon.from, horizon.to)).sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));

  const before = current ? current.sowingDate : asOf;
  const harvested = [
    ...workspace.cycles.filter((c) => c.stage === 'harvested' && c.harvestDate && c.harvestDate <= before).map((c) => ({ cropId: c.cropId, date: c.harvestDate! })),
    ...(workspace.previousHarvest.status === 'known' && workspace.previousHarvest.harvestDate <= before ? [{ cropId: workspace.previousHarvest.cropId, date: workspace.previousHarvest.harvestDate }] : []),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.cropId.localeCompare(b.cropId));
  const previousCropId = harvested[0]?.cropId ?? null;

  const starts = [asOf, horizon.from, ...(fixedSlot ? [fixedSlot.occupancy.to] : [])].sort();
  const scenario: YearPlanScenario = {
    kind: current ? 'occupied' : 'fresh', horizon, yearIndex: 0, currentCycleId: current?.id ?? null, previousCropId,
    fieldAreaHa: farm.areaHectares, irrigationCategory: irrigationText, stateId, districtId,
    soilSummary: args.soilSummary ?? null, neighbourhoodActiveMonths: args.neighbourhoodActiveMonths ?? null,
    // The current cycle is the fixed slot and is never in `occupied`.
    occupied: occupantsOf(inHorizon, workspace, args.names, null),
  };
  if (!stateId) warnings.push('The farm has no state; no sourced windows, yields or costs can be matched.');
  if (!districtId) warnings.push('The farm has no resolved district; district windows and yields cannot be used.');
  return {
    scenario, horizon, asOf, stateId, districtId, irrigation, fixedSlot, occupied: inHorizon, previousCropId,
    transitionFromCropId: current ? current.cropId : previousCropId, excludedCropIds, earliestSowing: starts.at(-1)!, warnings, names: args.names,
    yearIndex: 0, horizonStarts, assumed: null,
  };
}

interface FutureParts {
  yearIndex: number; horizonStarts: { current: DateRange; futures: string[] }; current: FarmWorkspaceState['cycles'][number] | null; fixedSlot: FixedSlot | null;
  occupied: OccupiedInterval[]; stateId: string | null; districtId: string | null; irrigation: EngineContext['irrigation']; irrigationText: string | null; excludedCropIds: string[]; warnings: string[];
}

/**
 * Round 3 (ROUND3_SPEC 1.1 item 2): a later 12-month horizon. No fixed slot; occupied = cycles (the current one with the
 * release the current plan uses) and saved seasons overlapping the horizon; earliestSowing = max(horizon start, today,
 * release of anything that started before it). Previous crop: the latest-ending recorded or saved crop that ends inside the
 * previous horizon (the current cycle counts only when it runs into this horizon, since the current plan follows it);
 * otherwise the last slot of the previous horizon's first plan (assumed, occupied with basis 'planned'); otherwise none.
 */
function futureScenario(args: BuildScenarioArgs, p: FutureParts): EngineContext {
  const { workspace, farm, asOf } = args;
  const from = p.horizonStarts.futures[p.yearIndex - 1]!;
  const horizon = { from, to: addYears(from, 1) };
  const prevFrom = p.yearIndex === 1 ? p.horizonStarts.current.from : p.horizonStarts.futures[p.yearIndex - 2]!;
  const all: OccupiedInterval[] = [
    ...(p.current && p.fixedSlot ? [{ id: p.current.id, cropId: p.current.cropId, source: 'cycle' as const, from: p.fixedSlot.occupancy.from, to: p.fixedSlot.occupancy.to, basis: p.fixedSlot.harvestBasis, note: null }] : []),
    ...p.occupied,
  ];
  let earliest = horizon.from > asOf ? horizon.from : asOf;
  for (const o of all) if (o.from < horizon.from && o.to > earliest) earliest = o.to;
  type Ended = { cropId: string; end: string; basis: 'current_cycle' | 'saved_season' | 'previous_harvest' };
  const ended: Ended[] = [
    ...workspace.cycles.filter((c) => c.stage === 'harvested' && c.harvestDate).map((c): Ended => ({ cropId: c.cropId, end: c.harvestDate!, basis: 'previous_harvest' })),
    ...(workspace.previousHarvest.status === 'known' ? [{ cropId: workspace.previousHarvest.cropId, end: workspace.previousHarvest.harvestDate, basis: 'previous_harvest' as const }] : []),
    ...all.filter((o) => !(p.current && o.id === p.current.id && o.to <= horizon.from)).map((o): Ended => ({ cropId: o.cropId, end: o.to, basis: o.source === 'cycle' ? 'current_cycle' : 'saved_season' })),
  ].filter((e) => e.end > prevFrom && e.end <= earliest).sort((a, b) => b.end.localeCompare(a.end) || a.cropId.localeCompare(b.cropId));
  const occupied = all.filter((o) => overlaps(o.from, o.to, horizon.from, horizon.to));
  const nameOf = (id: string) => (args.names?.crop?.[id] ?? cropDisplayName(id)).slice(0, 120);
  let previousCropId: string | null = ended[0]?.cropId ?? null;
  let assumedPredecessor: YearPlanScenario['assumedPredecessor'] = ended[0] ? { cropId: ended[0].cropId.slice(0, 120), cropName: nameOf(ended[0].cropId), basis: ended[0].basis, optionLabel: null, horizonFrom: null } : null;
  let assumed: EngineContext['assumed'] = null;
  const a = args.assumedPredecessor;
  if (!ended.length && a) {
    previousCropId = a.cropId;
    assumedPredecessor = { cropId: a.cropId.slice(0, 120), cropName: (a.cropName ?? nameOf(a.cropId)).slice(0, 120), basis: 'year_plan_option', optionLabel: a.optionLabel ? a.optionLabel.slice(0, 60) : null, horizonFrom: a.horizonFrom };
    assumed = { reviewId: a.reviewId, signature: a.signature };
    if (overlaps(a.occupancy.from, a.occupancy.to, horizon.from, horizon.to)) occupied.push({ id: `${ASSUMED_PREFIX}${a.reviewId}`, cropId: a.cropId, source: 'rotation_plan', from: a.occupancy.from, to: a.occupancy.to, basis: 'planned', note: `Assumed from the ${a.optionLabel ?? 'first'} plan of the previous year (not saved).` });
    if (a.occupancy.from < horizon.from && a.occupancy.to > earliest) earliest = a.occupancy.to;
  } else if (!ended.length) {
    p.warnings.push(`Nothing is recorded or saved for ${monthYear(prevFrom)} to ${monthYear(horizon.from)} and that year has no finished plan: generate the plan for that year first so this one can follow it. The rotation part is neutral.`);
  }
  occupied.sort((x, y) => x.from.localeCompare(y.from) || x.id.localeCompare(y.id));
  const scenario: YearPlanScenario = {
    kind: 'future', horizon, yearIndex: p.yearIndex, currentCycleId: null, previousCropId, assumedPredecessor,
    fieldAreaHa: farm.areaHectares, irrigationCategory: p.irrigationText, stateId: p.stateId, districtId: p.districtId,
    soilSummary: args.soilSummary ?? null, neighbourhoodActiveMonths: args.neighbourhoodActiveMonths ?? null,
    // A later horizon has no fixed slot: the current cycle is listed when its occupancy runs into this horizon.
    occupied: occupantsOf(occupied, workspace, args.names, a),
  };
  if (!p.stateId) p.warnings.push('The farm has no state; no sourced windows, yields or costs can be matched.');
  if (!p.districtId) p.warnings.push('The farm has no resolved district; district windows and yields cannot be used.');
  return {
    scenario, horizon, asOf, stateId: p.stateId, districtId: p.districtId, irrigation: p.irrigation, fixedSlot: null, occupied, previousCropId,
    transitionFromCropId: previousCropId, excludedCropIds: p.excludedCropIds, earliestSowing: earliest, warnings: p.warnings, names: args.names,
    yearIndex: p.yearIndex, horizonStarts: p.horizonStarts, assumed,
  };
}
