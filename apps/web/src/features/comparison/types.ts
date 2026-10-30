/** Wire types for the T06b crop routes. The client renders these fields; it never recomputes agronomy or economics. */

export type Outcome = "eligible" | "requires_review" | "unknown" | "ineligible" | "excluded_by_farmer";
export type Irrigation = "rainfed" | "supplemental" | "irrigated" | "unknown";
export type DimensionKey = "waterFit" | "timeToFirstIncome" | "harvestWindows" | "evidenceQuality" | "marketAccess" | "economics";

export interface Dimension {
  status: "known" | "unknown" | "unavailable";
  value: unknown;
  basis: string | null;
  missingReason: string | null;
  evidenceIds: string[];
}

export interface RuleLine {
  ruleId: string;
  effect: string;
  truth: string;
  reasonCodes: string[];
  appliedExceptionId: string | null;
  reviewStatus: string;
  reviewer: string | null;
  regionIds: string[];
  evidenceIds: string[];
  unknownFields: string[];
}

export interface ScenarioRow {
  name: string;
  grossHarvestValueInrPerHa: string;
  marketableKgPerHa: string;
  totalGrossInr: string | null;
}

export interface CompareItem {
  rank: number;
  cropId: string;
  productId: string;
  cropName: string;
  productName: string;
  productBasis: string;
  group: string;
  localNames: string[];
  outcome: Outcome;
  screening: { reasons: RuleLine[]; unknownFields: string[]; appliedRuleIds: string[]; evidenceIds: string[]; candidateRuleIds: string[]; noApplicableRule: boolean };
  context: { contextId: string; regionIds: string[]; season: string; irrigation: string; regionMatch: "state_or_region" | "national"; plantingMonthInWindow: boolean } | null;
  referenceContexts: { contextId: string; regionIds: string[]; season: string; note: string }[];
  season: string | null;
  plantingWindow: { fromMonth: number; toMonth: number; evidenceIds: string[] } | null;
  repeatedPicking: boolean | null;
  harvestPattern: string | null;
  dimensions: Record<DimensionKey, Dimension>;
  completeness: { known: number; total: number };
  yieldReference: { minKgPerHa: number; maxKgPerHa: number; basis: string; productId: string; appliesToProduct: boolean; label: string; evidenceIds: string[] } | null;
  costBasis: { state: "unavailable"; label: string };
  priceReference: PriceReference;
  downside: { computable: boolean; text: string };
  mostConsequentialMissingInput: { field: string; why: string } | null;
  evidenceCoverage: { sourcedRequirements: number; evidenceRecords: number; validationPending: boolean };
}

/** Mirrors the API PriceReferenceBlock. Historical mandi reference from stored quotes; never a forecast. */
export type PriceReference =
  | { state: "unavailable"; label: string; missingReason: string; text?: string }
  | {
      state: "historical_reference";
      evidenceState: "observed";
      label: string;
      notForecast: true;
      marketId: string;
      marketName: string;
      stateName: string | null;
      lastQuote: { inrPerKg: string; date: string; variety: string | null; grade: string | null; sourceUnit: string | null; evidenceState: "observed"; evidenceIds: string[] };
      weeklyRange: { lowInrPerKg: string; highInrPerKg: string; label: string; weeks: number; evidenceState: "derived" } | null;
      fallbackNote: string | null;
      otherMarkets: number;
    };

export interface ComparisonResult {
  asOf: string;
  mode: string;
  input: { assumedPrices?: { productId: string; amountInrPerKg: number }[]; area?: { amount: number; unit: "ha" | "acre" } | null };
  rulePolicy: { executed: string[]; candidateRulesExecuted: boolean };
  rankingBasis: string;
  items: CompareItem[];
  counts: Record<Outcome, number>;
  unsupportedDimensions: { key: string; missingReason: string }[];
}

export interface ApiWarning {
  code: string;
  message: string;
}

export interface ComparisonRequest {
  location: { stateId: string; districtId?: string };
  planting: { month: number; date?: string };
  irrigation: Irrigation;
  area?: { amount: number; unit: "ha" | "acre" };
  excludedCropIds: string[];
  assumedPrices: { productId: string; amountInrPerKg: number }[];
}

export interface Area {
  id: string;
  level: string;
  stateId: string | null;
  names: Record<string, string>;
  validationStatus: string;
}

export interface CropSummary {
  cropId: string;
  name: string;
  products: { productId: string; name: string; productBasis: string }[];
}

export interface EvidenceCitation {
  id: string;
  excerpt: string | null;
  locator: { page?: number | string; section?: string } | null;
  citation: { publisher: string; documentTitle: string; documentVersion: string | null; sourceUrl: string | null };
  validationStatus: string;
  licence: { accessStatus: string; redistributable: boolean };
}
