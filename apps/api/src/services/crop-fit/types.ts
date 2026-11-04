import type { CropFitRequest, CropSeason } from '@harvest/contracts';
import type { EvaluatedSlot } from '../year-plan/assemble';
import type { RotationScoreResult } from '../year-plan/scoring';
import type { SlotPlan } from '../year-plan/types';

/**
 * Crop fit v2 (ROUND2_SPEC.md section 4). Internal shapes shared by the pure ranking (rank.ts), the soil comparison
 * (soil-compare.ts), the Meta picks (select.ts) and the persisted review (service.ts).
 */
// v3.2 (2026-11-04, EVARA_ACTIONS_SPEC.md 1.2): replace pass, default field on a farm with fields, realisation-aware occupancy.
export const CROP_FIT_ENGINE_VERSION = 'crop-fit-v3.2-2026-11-04';
export const CROP_FIT_JOB_TYPE = 'farm.crop-fit';
/** Largest distance from the requested sowing date to the nearest day of a sourced window (ROUND2_SPEC 4.1). */
export const MAX_SHIFT_DAYS = 21;
/** Reason code added by crop fit (not a year-plan code): the sowing date was moved into the nearest sourced window. */
export const WINDOW_SHIFTED = 'window_shifted';
export const WINDOW_SHIFTED_TEXT = 'The sowing date was moved to the nearest day inside a sourced sowing window.';

/** The normalised request plus what the mode resolved to (ROUND2_SPEC 4.1). */
export interface ResolvedMode {
  request: CropFitRequest;
  /** Sowing target for `next` and `date`; null for `season` (each crop uses its own window start). */
  target: string | null;
  /** Earliest day a candidate may be sown (a shift into the nearest window never goes before it). */
  floor: string;
  /** Previous crop for the target date (`next`, `date`); for `season` it is resolved per candidate. */
  previousCropId: string | null;
  season: CropSeason | null;
  notes: string[];
  /** Round 3: `after` of a date request; replaces the field's own previous crop for every candidate. */
  previousOverride?: string | null | undefined;
}

/** One crop/product placed and evaluated with the year-plan slot scoring; the best method and duration class is kept. */
export interface RankedCandidate {
  plan: SlotPlan;
  ev: EvaluatedSlot;
  rotation: RotationScoreResult;
  previousCropId: string | null;
  shiftedDays: number;
  /** 0..100, the year-plan per-slot display score (all five weights). */
  score: number;
  /** Round 3 (ROUND3_SPEC 5): idle days before this sowing (from the field release, the season floor or the requested date). */
  waitDays: number | null;
  /** Score points deducted for the wait (next mode only; 0 elsewhere). */
  waitPenalty: number;
  /** score - waitPenalty, the ranking key (0..100). */
  rankScore: number;
  components: { price: number; yield: number; soilRotation: number; water: number; confidence: number };
  reasonCodes: string[];
  uncertainties: string[];
  occupancyConflict: string | null;
}

/** A pool crop/product that was not ranked, with the reason. */
export interface Unplaced { cropId: string; productId: string | null; reason: string }

export interface RankResult {
  candidates: RankedCandidate[];
  unplaced: Unplaced[];
  /** Every evaluated plan (all methods and duration classes), for the price lookups and the normaliser. */
  plansConsidered: number;
}
