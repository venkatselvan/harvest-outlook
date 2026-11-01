import type { BasisRef, FarmWorkspaceState, StageTimeline, YearPlanScenario } from '@harvest/contracts';
import { agronomyCrop, agronomySources, durationFor, poolEntry, seasonOfMonth, windowsFor } from './data';
import { addDays, addYears, daysBetween, isCalendarDate, monthOf, overlaps } from './dates';
import type { StageTimelineInput } from '../today/stage-timeline';
import { placeWindows } from './windows';
import { ASSUMPTIONS, assumptionBasis, irrigationClass } from './scoring';
import type { EngineContext, FixedSlot, HarvestRange, OccupiedInterval } from './types';

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
}

function factValue(farm: ScenarioFarm, key: string): unknown {
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
    const o = occupancyFor(p.cropId, p.productId ?? null, null, p.plannedSowingDate, p.plannedHarvestDate ?? null, stateId);
    occupied.push({ id: p.id, cropId: p.cropId, source: 'rotation_plan', from: p.plannedSowingDate, to: o.to, basis: o.basis === 'recorded' ? 'planned' : o.basis, note: o.notes[0] ?? null });
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
    kind: current ? 'occupied' : 'fresh', horizon, currentCycleId: current?.id ?? null, previousCropId,
    fieldAreaHa: farm.areaHectares, irrigationCategory: irrigationText, stateId, districtId,
    soilSummary: args.soilSummary ?? null, neighbourhoodActiveMonths: args.neighbourhoodActiveMonths ?? null,
  };
  if (!stateId) warnings.push('The farm has no state; no sourced windows, yields or costs can be matched.');
  if (!districtId) warnings.push('The farm has no resolved district; district windows and yields cannot be used.');
  return {
    scenario, horizon, asOf, stateId, districtId, irrigation, fixedSlot, occupied: inHorizon, previousCropId,
    transitionFromCropId: current ? current.cropId : previousCropId, excludedCropIds, earliestSowing: starts.at(-1)!, warnings, names: args.names,
  };
}
