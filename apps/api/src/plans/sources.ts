import type { DateRange, ForecastArtifact, Mode, ValueRecord } from "@harvest/contracts";

/**
 * Injected data sources for the plan engine. The engine never performs network
 * or LLM calls itself; adapters (T05a weather/outlook, T11 visuals, T13 journal
 * completions) implement these interfaces. Each source declares the runtime
 * modes it may serve so a synthetic fixture can never feed a live plan.
 */

export interface WeatherScope {
  farmId: string;
  districtId: string | null;
  stateId: string | null;
  /** WGS84 longitude/latitude when the farm has coordinates. */
  point: { lon: number; lat: number } | null;
}

/** One calendar day of weather for the scope. Null = not measured / not provided (never filled). */
export interface DailyWeather {
  date: string;
  rainMm: number | null;
  et0Mm: number | null;
  tMaxC: number | null;
  tMinC: number | null;
  /** Source/dataset identifier (also used as ET0 source label). */
  sourceId: string;
}

export interface ForecastBundle {
  /** Forecast issue time (ISO with offset). */
  issuedAt: string;
  sourceId: string;
  days: DailyWeather[];
}

export interface ClimatologyBundle {
  /** Inclusive reference years used to compute the daily normals. */
  years: { from: number; to: number };
  /** Calendar years that actually met the row threshold, ascending; `years` spans only these (first..last). */
  qualifyingYears?: number[];
  sourceId: string;
  /** Normals mapped onto the requested calendar dates. */
  days: DailyWeather[];
}

export interface WeatherSource {
  readonly modes: readonly Mode[];
  /** Observations whose availability is at or before `availableBy` (replay boundary). */
  getDailyObservations(scope: WeatherScope, range: DateRange, opts: { availableBy: string }): Promise<DailyWeather[]>;
  /** Latest forecast issued at or before `issuedAtOrBefore`; null when none exists. */
  getForecast(scope: WeatherScope, opts: { issuedAtOrBefore: string }): Promise<ForecastBundle | null>;
  /** Daily climatological normals for the range; null when unavailable. Reference years must end before a replay cutoff year. */
  getClimatology(scope: WeatherScope, range: DateRange, opts?: { availableBy?: string }): Promise<ClimatologyBundle | null>;
  /** Cheap version token of the data that would be returned (no bulk fetch). Used as a timeline cache key component. */
  dataVersion(scope: WeatherScope, range: DateRange, asOf: string): Promise<string>;
}

/** Missing-price reasons (L3). `market_not_in_history` is also carried as a fallback note when state-level markets are shown instead. */
export type PriceMissingReason = "price_access_key_gated" | "price_history_not_ingested" | "price_history_insufficient" | "market_not_in_history";

/** Optional location hint so a requested market that is absent from history can fall back to state-level markets. */
export interface OutlookScopeHint {
  stateId?: string | null;
  stateName?: string | null;
  districtName?: string | null;
}

export interface MarketReferenceMarket {
  marketId: string;
  marketName: string;
  stateName: string | null;
  districtName: string | null;
  /** Last valid modal quote, INR/kg (source INR/quintal preserved in sourceUnit). evidenceState observed. */
  lastQuote: ValueRecord;
  lastQuoteMeta: { date: string; marketName: string; variety: string | null; grade: string | null; rowsOnDate: number };
  /** Range of weekly medians over the last 52 weeks. NOT a prediction interval; mandi min/max are not used. evidenceState derived. */
  weeklyRange: ValueRecord;
  weeklyRangeLabel: string;
  weeksInRange: number;
  validDaysLast365: number;
  /** Corresponding-season reference per harvest window: median of weekly medians in the same ISO weeks of prior years (>= 2 years). */
  seasonal: { window: DateRange; reference: ValueRecord; yearsUsed: number[]; weeklyMedianRange: { low: string; high: string } | null }[];
}

/** HISTORICAL REFERENCE from stored quotes. Never a forecast; `notForecast` is always true. */
export interface MarketReference {
  kind: "historical_reference";
  mode: Mode;
  productId: string;
  issueDate: string;
  label: string;
  notForecast: true;
  methodVersion: string;
  primaryMarketId: string;
  fallback: { reason: "market_not_in_history"; requestedMarketIds: string[]; scope: "state"; stateName: string | null; note: string } | null;
  markets: MarketReferenceMarket[];
  skippedMarkets: { marketId: string; reason: "price_history_insufficient" }[];
}

export type OutlookResult = ForecastArtifact | { state: "unavailable"; missingReason: string } | MarketReference;

export interface MarketOutlookSource {
  readonly modes: readonly Mode[];
  getOutlook(productId: string, marketIds: string[], harvestWindows: DateRange[], issueDate: string, hint?: OutlookScopeHint): Promise<OutlookResult>;
}

export interface VisualAssetRef {
  assetId: string;
  /** observed_photo = dated farmer photo (journal); illustrative = generated/reference image for a stage. */
  kind: "observed_photo" | "illustrative";
  /** Observation date for photos (YYYY-MM-DD, region timezone); null for illustrations. */
  date: string | null;
  stageId: string | null;
}

export interface VisualAssetSource {
  getAssets(ownerId: string, planId: string): Promise<VisualAssetRef[]>;
  version(ownerId: string, planId: string): Promise<string>;
}

export interface TaskCompletion {
  taskId: string;
  completedOn: string;
}

export interface TaskCompletionSource {
  getCompletions(ownerId: string, planId: string): Promise<TaskCompletion[]>;
  version(ownerId: string, planId: string): Promise<string>;
}

/** Idempotency storage hook (T04 implements storage; see services/idempotency.ts runIdempotent). */
export interface IdempotencyHook {
  run(
    opts: { ownerId: string; key: string | undefined; route: string; hashInput: unknown },
    exec: () => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown; replay: boolean }>;
}

export interface PlanSources {
  weather: WeatherSource;
  outlook: MarketOutlookSource;
  visuals: VisualAssetSource;
  completions: TaskCompletionSource;
}

const ALL_MODES: readonly Mode[] = ["live", "replay", "synthetic"];

/** Default weather source when no adapter is bound: everything unavailable, never filled. */
export const unavailableWeatherSource: WeatherSource = {
  modes: ALL_MODES,
  getDailyObservations: async () => [],
  getForecast: async () => null,
  getClimatology: async () => null,
  dataVersion: async () => "unavailable",
};

/** Current reality for live price outlooks: the price API key is gated (T01). */
export function unavailableOutlookSource(missingReason = "price_access_key_gated"): MarketOutlookSource {
  return { modes: ALL_MODES, getOutlook: async () => ({ state: "unavailable", missingReason }) };
}

export const noVisualAssets: VisualAssetSource = { getAssets: async () => [], version: async () => "none" };
export const noTaskCompletions: TaskCompletionSource = { getCompletions: async () => [], version: async () => "none" };

export function defaultSources(): PlanSources {
  return { weather: unavailableWeatherSource, outlook: unavailableOutlookSource(), visuals: noVisualAssets, completions: noTaskCompletions };
}
