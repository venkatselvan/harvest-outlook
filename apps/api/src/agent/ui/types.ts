import type { CropFitReview, FarmBriefing, ToolOutput, YearPlanReview } from "@harvest/contracts";

/**
 * The plain data the Evara UI resolver reads (docs/EVARA_LANG.md "Data"). The loop assembles it (load.ts) with read-only
 * queries; the resolver and the fallback composer are pure functions of it, so tests build it by hand without a database.
 */

export interface EvaraCropName {
  /** Catalogue slug (the id crop fit, the year plan, the briefing and screen_crops use). */
  slug: string;
  en: string;
  hi?: string | undefined;
  ta?: string | undefined;
}

/** A saved season of the viewed field (workspace rotation plan) with its realisation (EVARA_ACTIONS_SPEC.md 1.1). */
export interface EvaraOccupant {
  rotationPlanId: string;
  cropId: string;
  cropName: string;
  productId: string | null;
  productName: string | null;
  season: string;
  year: number;
  kind: string;
  plannedSowingDate: string | null;
  plannedHarvestDate: string | null;
  /**
   * planned / overdue are replaceable; sown is not; null = not a dated saved season (not replaceable). Always computed fresh
   * from the workspace (services/year-plan/scenario.ts seasonRealisation), never taken from a stored review (review fix E7c-1).
   */
  realisation: "planned" | "overdue" | "sown" | null;
  /** End of the months the season takes (year-plan occupancy for the same planned sowing date), when known. */
  occupancyTo: string | null;
}

/** One crop of the catalogue compare service (catalogue/compare.ts) reduced to what CropCompare shows. */
export interface EvaraCatalogueRow {
  cropId: string;
  cropName: string;
  outcome: "eligible" | "requires_review" | "unknown" | "ineligible" | "excluded_by_farmer";
  season: string | null;
  plantingWindow: { fromMonth: number; toMonth: number } | null;
  /** Every regional planting window the compare items of this crop carry (all its products), for the @AddSeason date check. */
  plantingWindows?: { fromMonth: number; toMonth: number }[] | undefined;
  durationDays: { min: number; max: number | null } | null;
  water: { fit: "matches" | "partial" | "mismatch"; needClass: string | null } | null;
  harvest: { earliest: string; latest: string } | null;
}

export interface EvaraTimeline {
  stages: { id: string; name: string; from: string; to: string; basis: string }[];
  harvest: { earliest: string; latest: string } | null;
}

export interface EvaraAnswerBlock {
  id: string;
  kind: "text" | "numeric" | "warning" | "limitation" | "evidence";
  text: string;
}

export interface EvaraResolveData {
  /** Turn language (en, hi, ta; anything else reads English). */
  language: string;
  /** IST calendar date of the turn. */
  today: string;
  intent: string | null;
  /** Gate-approved answer blocks (after templates), in answer order. */
  blocks: EvaraAnswerBlock[];
  /** The turn returns a clarification question (the web shows it under the tree). */
  hasClarification: boolean;
  briefing: FarmBriefing | null;
  screening: ToolOutput<"screen_crops"> | null;
  /** Crop ids resolve_crop_identity returned in this run (catalogue UUIDs or slugs), in call order. */
  resolvedCropIds: string[];
  /** Stored crop-fit review of the viewed field (status ready). */
  cropFit: CropFitReview | null;
  /** Stored year-plan review of the viewed field (with `alternatives` when present). */
  yearPlan: YearPlanReview | null;
  /** The viewed field (null: the whole farm). */
  fieldId: string | null;
  occupants: EvaraOccupant[];
  currentCycle: { cropId: string; productId: string | null; sowingDate: string } | null;
  /** Catalogue crops keyed by slug and by catalogue UUID (both point at the same entry). */
  crops: Record<string, EvaraCropName>;
  /** Catalogue compare rows by slug, computed for the crops the program and the composer need. */
  catalogueRows: Record<string, EvaraCatalogueRow>;
  /** Stage timelines keyed `${slug}|${sowing}`, computed for the journeys the program and the composer need. */
  timelines: Record<string, EvaraTimeline>;
}

export const timelineKey = (slug: string, sowing: string) => `${slug}|${sowing}`;

/** An empty data object (every source absent). */
export function emptyEvaraData(over: Partial<EvaraResolveData> = {}): EvaraResolveData {
  return {
    language: "en",
    today: new Date(Date.now() + 19_800_000).toISOString().slice(0, 10),
    intent: null,
    blocks: [],
    hasClarification: false,
    briefing: null,
    screening: null,
    resolvedCropIds: [],
    cropFit: null,
    yearPlan: null,
    fieldId: null,
    occupants: [],
    currentCycle: null,
    crops: {},
    catalogueRows: {},
    timelines: {},
    ...over,
  };
}
