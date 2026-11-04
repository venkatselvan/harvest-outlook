import {
  CompleteCareTaskResult,
  FarmAlert as farmAlertSchema,
  FutureLookAsset as futureLookAssetSchema,
  FutureLookRequestResult as futureLookRequestSchema,
  TodayView as todayViewSchema,
  type CareTask,
  type FarmAlert,
  type FutureLookAsset,
  type FutureLookRequestBody,
  type FutureLookRequestResult,
  type TodayView,
} from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Today view requests. Paths are fixed by docs/research/UI_BRIEF.md section 4. Every response is validated against
 * the shared contract and checked to belong to the requested farm before the view uses it.
 */
const farmPath = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}`;

/** Thrown when the server answers with data that does not match the contract or belongs to another farm. */
export class TodayDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodayDataError";
  }
}

/** `.../today`, or `.../today?fieldId=<id>` for one field of a farm with fields (FIELDS_MULTICROP_SOIL_SPEC.md 3.3). */
export const todayPath = (farmId: string, fieldId?: string | null) =>
  `${farmPath(farmId)}/today${fieldId ? `?fieldId=${encodeURIComponent(fieldId)}` : ""}`;

export async function loadToday(farmId: string, fetchImpl?: typeof fetch, fieldId?: string | null): Promise<TodayView> {
  const env = await apiRequest<unknown>(todayPath(farmId, fieldId), undefined, fetchImpl);
  const parsed = todayViewSchema.safeParse(env.data);
  if (!parsed.success) throw new TodayDataError("The Today view response did not match the expected format.");
  if (parsed.data.farmId !== farmId) throw new TodayDataError("The Today view response belongs to another farm.");
  // A field view must describe the field that was asked for (an older server without fields omits `field`).
  if (fieldId && parsed.data.field && parsed.data.field.id !== fieldId)
    throw new TodayDataError("The Today view response describes another field.");
  return parsed.data;
}

/** POST .../alerts/:alertId/dismiss. The route takes no body; dismissing twice is harmless. */
export async function dismissAlert(farmId: string, alertId: string, fetchImpl?: typeof fetch): Promise<FarmAlert> {
  const env = await apiRequest<unknown>(
    `${farmPath(farmId)}/alerts/${encodeURIComponent(alertId)}/dismiss`,
    { method: "POST" },
    fetchImpl,
  );
  const parsed = farmAlertSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.farmId !== farmId || parsed.data.id !== alertId)
    throw new TodayDataError("The dismiss response did not match this alert.");
  return parsed.data;
}

/**
 * The existing idempotent care completion (same path, body and idempotency header the previous Today tab used).
 * Reuse one `clientEntryId` for retries of the same tap so the journal gets one entry.
 */
export async function completeCare(
  farmId: string,
  task: Pick<CareTask, "id" | "cycleId">,
  clientEntryId: string,
  completedOn: string,
  fetchImpl?: typeof fetch,
): Promise<CareCompletion> {
  const env = await apiRequest<unknown>(
    `${farmPath(farmId)}/cycles/${encodeURIComponent(task.cycleId)}/care/${encodeURIComponent(task.id)}/complete`,
    jsonInit("POST", { clientEntryId, completedOn }, { "idempotency-key": clientEntryId }),
    fetchImpl,
  );
  return CompleteCareTaskResult.parse(env.data);
}
export type CareCompletion = ReturnType<typeof CompleteCareTaskResult.parse>;

/**
 * Same-origin URL for an owner-private scene image. Only relative `/api/v1/farms/...` paths are accepted, so a
 * third-party URL in a response can never be loaded; the browser sends the session cookie with same-origin images.
 */
export function sceneImageUrl(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/api/v1/farms/") || path.includes("//") || path.includes("\\")) return null;
  return path;
}

// ------------------------------------------------------------------ AI-predicted looks (FIELDS_MULTICROP_SOIL_SPEC.md 11.4)

/**
 * A "Predict with AI" request that did not produce a look. `reason` is the API's `details.reason` (target_too_far,
 * scene_not_latest, ...), the result's unavailable/failed reason (cycle_limit_reached, budget_exceeded, provider_*), or a
 * client reason (network, rate_limited, timeout, invalid).
 */
export class PredictionError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PredictionError";
  }
}

/**
 * POST path for a predicted look from one real scene. The cycle id is sent so a field view's request uses that field's
 * cycle and polygon; without it the API picks the farm's most recent cycle, which on a farm with fields can be another
 * field's (the route's query takes `stageId` and `cycleId` only, so a field id is never sent here).
 */
export const predictionPath = (farmId: string, itemId: string, cycleId?: string | null) =>
  `${farmPath(farmId)}/ndvi/${encodeURIComponent(itemId)}/future${cycleId ? `?cycleId=${encodeURIComponent(cycleId)}` : ""}`;
/** The strict request body of a gap look: the slider date (the API stores the start of its week). */
export const predictionBody = (targetDate: string, regenerate?: boolean): FutureLookRequestBody => ({ kind: "gap", targetDate, ...(regenerate ? { regenerate: true } : {}) });

/** The error envelope's `details.reason` of the last non-2xx response seen through this fetch (ApiError drops details). */
function reasonCapturingFetch(fetchImpl: typeof fetch = fetch) {
  const seen = { reason: null as string | null };
  const wrapped: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init);
    if (!res.ok) {
      seen.reason = null;
      try {
        const body = (await res.clone().json()) as { error?: { details?: { reason?: unknown } } } | null;
        const reason = body?.error?.details?.reason;
        if (typeof reason === "string" && reason.length <= 80) seen.reason = reason;
      } catch {
        // Not JSON: request() reports it as invalid_response.
      }
    }
    return res;
  };
  return { fetch: wrapped, seen };
}

/** Reason code for a failed prediction call: the API's details.reason when it gave one, else from the HTTP status. */
export function predictionErrorReason(error: unknown, detailsReason?: string | null): string {
  if (error instanceof PredictionError) return error.reason;
  if (detailsReason) return detailsReason;
  if (error instanceof TodayDataError) return "invalid";
  if (error instanceof ApiError) {
    if (error.status === 0) return "network";
    if (error.status === 429) return "rate_limited";
    if (error.code === "budget_exceeded") return "budget_exceeded";
    if (error.code === "mode_mismatch") return "live_mode_required";
    if (error.code === "invalid_envelope" || error.code === "invalid_response" || error.code === "empty_response") return "invalid";
    if (error.status === 404) return "not_found";
  }
  return "error";
}

/**
 * POST .../ndvi/:itemId/future with `{kind: 'gap', targetDate}`. Returns the result when a look is queued, running or
 * ready; throws PredictionError for an unavailable or failed result (cap, budget, provider) and for every API refusal.
 */
export async function requestPrediction(
  farmId: string,
  itemId: string,
  targetDate: string,
  cycleId?: string | null,
  fetchImpl?: typeof fetch,
  opts: { regenerate?: boolean } = {},
): Promise<FutureLookRequestResult> {
  const capture = reasonCapturingFetch(fetchImpl);
  let data: unknown;
  try {
    data = (await apiRequest<unknown>(predictionPath(farmId, itemId, cycleId), jsonInit("POST", predictionBody(targetDate, opts.regenerate)), capture.fetch)).data;
  } catch (error) {
    const reason = predictionErrorReason(error, capture.seen.reason);
    throw new PredictionError(reason, predictionMessage(reason));
  }
  const parsed = futureLookRequestSchema.safeParse(data);
  if (!parsed.success) throw new PredictionError("invalid", predictionMessage("invalid"));
  const result = parsed.data;
  if (result.status === "unavailable" || result.status === "failed" || (result.status !== "ready" && !result.assetId)) {
    const reason = result.reason ?? result.status;
    throw new PredictionError(reason, predictionMessage(reason));
  }
  return result;
}

/** GET .../future-look/:assetId, validated and checked to belong to the farm. */
export async function loadPrediction(farmId: string, assetId: string, fetchImpl?: typeof fetch): Promise<FutureLookAsset> {
  const env = await apiRequest<unknown>(`${farmPath(farmId)}/future-look/${encodeURIComponent(assetId)}`, undefined, fetchImpl);
  const parsed = futureLookAssetSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.farmId !== farmId || parsed.data.assetId !== assetId)
    throw new TodayDataError("The predicted look response did not match this request.");
  return parsed.data;
}

/** Poll every 3 s for up to 3 minutes (spec 11.4). */
export const PREDICTION_POLL_MS = 3_000;
export const PREDICTION_POLL_LIMIT_MS = 180_000;
export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Waits between polls (tests pass an instant one). */
  wait?: (ms: number) => Promise<void>;
  /** True once the result no longer matters (farm switch, sign-out): polling stops without another request. */
  cancelled?: () => boolean;
}
export type PollOutcome =
  | { status: "ready"; asset: FutureLookAsset }
  | { status: "failed" | "unavailable"; asset: FutureLookAsset; reason: string }
  | { status: "timeout" | "cancelled"; asset: FutureLookAsset | null; reason: string };

/**
 * Polls the asset until it is ready, failed or unavailable, at most `timeoutMs / intervalMs` requests (60 by default). A
 * transient failure (network, 5xx, 429) counts as one poll and polling goes on; any other API error ends it.
 */
export async function pollPrediction(farmId: string, assetId: string, options: PollOptions = {}): Promise<PollOutcome> {
  const interval = options.intervalMs ?? PREDICTION_POLL_MS;
  const attempts = Math.max(1, Math.floor((options.timeoutMs ?? PREDICTION_POLL_LIMIT_MS) / interval));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: FutureLookAsset | null = null;
  for (let i = 0; i < attempts; i++) {
    await wait(interval);
    if (options.cancelled?.()) return { status: "cancelled", asset: last, reason: "cancelled" };
    try {
      last = await loadPrediction(farmId, assetId, options.fetchImpl);
    } catch (error) {
      const transient = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!transient) throw new PredictionError(predictionErrorReason(error), predictionMessage(predictionErrorReason(error)));
      continue;
    }
    if (options.cancelled?.()) return { status: "cancelled", asset: last, reason: "cancelled" };
    if (last.status === "ready") return { status: "ready", asset: last };
    if (last.status === "failed" || last.status === "unavailable") return { status: last.status, asset: last, reason: last.failureReason ?? last.status };
  }
  return { status: "timeout", asset: last, reason: "timeout" };
}

/** Reasons after which the view is reloaded: the latest real scene changed since the view was loaded. */
export const PREDICTION_RELOAD_REASONS: ReadonlySet<string> = new Set(["scene_not_latest", "target_not_after_scene", "no_current_cycle"]);

/** Short message for a prediction that did not come through. */
export function predictionMessage(reason: string): string {
  if (reason === "daily_limit_reached") return "Today’s AI image allowance is used up. Try again tomorrow.";
  if (reason === "cycle_limit_reached") return "This crop has used all its AI predicted looks for the season.";
  if (reason === "target_too_far") return `That date is too far ahead to predict. Pick a date within 120 days of today.`;
  if (PREDICTION_RELOAD_REASONS.has(reason)) return "The satellite images changed since this view loaded. Reloading the view.";
  if (reason === "budget_exceeded") return "Today's AI budget is used up. Try again tomorrow.";
  if (reason === "provider_unavailable" || reason.startsWith("provider_")) return "The AI image service is unavailable right now. Try again later.";
  if (reason === "live_mode_required") return "Predicted looks need live satellite data.";
  if (reason === "no_usable_scene") return "There is no clear satellite image of this field to predict from yet.";
  if (reason === "rate_limited") return "Too many requests. Wait a minute and try again.";
  if (reason === "network") return "Could not reach the server. Check your connection and try again.";
  if (reason === "timeout") return "The predicted look is taking longer than usual. It will show here once it is ready.";
  return "The predicted look could not be made this time.";
}

export type TodayErrorKind = "not_available" | "network" | "invalid" | "server";
export interface TodayErrorInfo {
  kind: TodayErrorKind;
  message: string;
}
/** Plain-language error for the Today view. 404 means the endpoint (or this farm's view) is not available yet. */
export function describeTodayError(error: unknown): TodayErrorInfo {
  if (error instanceof TodayDataError)
    return { kind: "invalid", message: "Today's field view could not be read. Your saved records are unchanged." };
  if (error instanceof ApiError) {
    if (error.status === 404 && error.code === "field_not_found")
      return { kind: "not_available", message: "That field is no longer on this farm. Choose another field above." };
    if (error.status === 404)
      return { kind: "not_available", message: "Today's field view is not available on this server yet." };
    if (error.status === 0)
      return { kind: "network", message: "Could not reach the server. Check your connection and try again." };
    if (error.code === "invalid_envelope" || error.code === "invalid_response" || error.code === "empty_response")
      return { kind: "invalid", message: "Today's field view could not be read. Your saved records are unchanged." };
    return { kind: "server", message: error.message || "Today's field view could not load." };
  }
  return { kind: "server", message: "Today's field view could not load." };
}
