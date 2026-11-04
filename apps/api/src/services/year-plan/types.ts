import type { BasisRef, YearPlanScenario } from '@harvest/contracts';
import type { IntercropSystem } from './data';

/** Season labels used by the agronomy research (crop-agronomy.json methods.seasonLabel). */
export type Season = 'kharif' | 'rabi' | 'summer';
/** Irrigation allowance classes of ROTATION_SCORING.md 5.1 (none 0, protective 150, assured 600 mm per season). */
export type IrrigationClass = 'none' | 'protective' | 'assured';
export type WindowScope = 'district' | 'state';

/** Half-open [from, to): `to` is the first day the field is free again. */
export interface DateRange { from: string; to: string }
export interface HarvestRange { earliest: string; latest: string }

/** A sourced sowing window placed on the calendar for one year. */
export interface PlacedWindow {
  from: string;
  /** Last sowing day (inclusive). */
  to: string;
  season: Season;
  scope: WindowScope;
  provisional: boolean;
  condition: string;
  source: string | null;
  sourceDistrict: string | null;
  note: string | null;
}

export interface SlotFlags {
  stateWindowFallback: boolean;
  provisionalWindow: boolean;
  outsideWindow: boolean;
  landPrepGapAssumed: boolean;
  /** The window assumes irrigation the field may not have. */
  conditional: boolean;
  /** Duration rows come from cultivars named for another state. */
  durationOtherState: boolean;
  /** Harvest end is an engine assumption (no recorded date, no sourced duration). */
  harvestAssumed: boolean;
}

/** A crop placed on the calendar: a generated candidate, the fixed current cycle, or a farmer edit. */
export interface SlotPlan {
  key: string;
  /** Round 2: 'green_manure' slots are grown and ploughed in (no product, no price, revenue 0). Absent = 'crop'. */
  kind?: 'crop' | 'green_manure' | 'intercrop' | undefined;
  /**
   * Round 3 (ROUND3_SPEC 8.2): an intercrop slot; cropId/productId/method/harvest are the main crop's, the companion's
   * harvest may run later (ASSUMPTIONS.intercropCompanionHarvest) and the occupancy then covers it.
   */
  intercrop?: IntercropPlan | undefined;
  cropId: string;
  productId: string;
  /** Establishment method of the duration rows used; null when the source says 'any' or the method is unknown. */
  method: string | null;
  season: Season;
  fixed: boolean;
  sowing: string;
  harvest: HarvestRange;
  occupancy: DateRange;
  durationDays: { low: number; high: number };
  durationSourced: boolean;
  window: PlacedWindow | null;
  windowFit: number;
  flags: SlotFlags;
  uncertainties: string[];
  basis: BasisRef[];
}

export interface IntercropPlan {
  systemId: string;
  system: IntercropSystem;
  companionHarvest: HarvestRange;
  /** Sourced duration class of the companion used for its harvest; null when it is harvested with the main crop. */
  companionDurationDays: { low: number; high: number } | null;
}

export interface Candidate extends SlotPlan {
  candidateId: string;
  /** Index of the duration class (cultivar group) within the method. */
  durationClass: number;
}

export interface OccupiedInterval extends DateRange {
  id: string;
  cropId: string;
  source: 'cycle' | 'rotation_plan';
  basis: 'recorded' | 'planned' | 'sourced_duration' | 'assumed_duration';
  note: string | null;
  /**
   * 2026-11-04 (EVARA_ACTIONS_SPEC.md 1.1): a saved season's realisation, 'planned' or 'overdue' (replaceable); set on
   * rotation_plan intervals built from saved seasons only. A saved season a recorded cycle realises ('sown') is not an
   * interval at all (the cycle is). Absent on cycles and on the assumed previous-year plan (neither is replaceable).
   */
  realisation?: 'planned' | 'overdue' | undefined;
}

export interface FixedSlot extends SlotPlan {
  cycleId: string;
  harvestBasis: 'recorded' | 'sourced_duration' | 'assumed_duration';
  /** The harvest window is the crop's stage-timeline window (the Today view's), not the older duration rule. */
  timelineEstimate?: boolean | undefined;
}

/** Everything the deterministic engine needs about the field; produced by buildScenario. */
export interface EngineContext {
  scenario: YearPlanScenario;
  /** Half-open horizon [from, to): 12 months from the current cycle's sowing (occupied) or from asOf (fresh). */
  horizon: DateRange;
  asOf: string;
  stateId: string | null;
  districtId: string | null;
  irrigation: IrrigationClass | null;
  fixedSlot: FixedSlot | null;
  occupied: OccupiedInterval[];
  /** Last harvested crop before the plan (fresh) or before the current cycle (occupied). */
  previousCropId: string | null;
  /** Crop the first suggested slot follows: the current cycle (occupied) or previousCropId (fresh). */
  transitionFromCropId: string | null;
  excludedCropIds: string[];
  /** First day a suggested slot may be sown: max(asOf, horizon start, fixed slot release). */
  earliestSowing: string;
  warnings: string[];
  names?: { crop?: Record<string, string> | undefined; product?: Record<string, string> | undefined } | undefined;
  /** Round 3 (ROUND3_SPEC 1): 0 for the current horizon, 1..3 for later 12-month horizons. */
  yearIndex?: number | undefined;
  /** Start of the current horizon and of the three later ones (from_k = current.to + (k - 1) years). */
  horizonStarts?: { current: DateRange; futures: string[] } | undefined;
  /** A future horizon that follows the previous horizon's unsaved first plan: that review and its crop signature (hashed). */
  assumed?: { reviewId: string; signature: string } | null | undefined;
}

/** A suggested crop sequence (fixed slot excluded; it is taken from the context). */
export interface Sequence { sequenceId: string; slots: Candidate[] }
