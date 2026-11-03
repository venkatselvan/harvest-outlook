import {
  ApplyYearPlan as applySchema,
  ApplyYearPlanResult as applyResultSchema,
  PriceTrend as priceTrendSchema,
  RescoreYearPlan as rescoreSchema,
  YearPlanOption as optionSchema,
  YearPlanReview as reviewSchema,
  type ApplyYearPlan,
  type ApplyYearPlanResult,
  type PriceTrend,
  type RescoreYearPlan,
  type YearPlanOption,
  type YearPlanReview,
} from "@harvest/contracts";
import { apiRequest, jsonInit, newEntryId } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";
import { isActive } from "./model";

/**
 * Client for the Year plan endpoints (UI_BRIEF section 4). Every response is validated against the shared zod contract;
 * a payload that does not match raises YearPlanContractError so the view shows an error state instead of rendering
 * partial data.
 */

export const YEAR_PLAN_POLL_MS = 1500;
/** Upper bound on one polling run (about 4.5 minutes at 1.5 s); the view then offers Refresh. */
export const YEAR_PLAN_MAX_POLLS = 180;

export interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * The field the plan is for (FIELDS_MULTICROP_SOIL_SPEC.md 12.2). On a farm with fields every year-plan call names it
 * (`?fieldId=` on GET and POST, `fieldId` in the rescore and apply bodies; the server answers 400 field_required without
 * it). Null or omitted on a farm without fields, whose plan stays farm-wide.
 */
export interface FieldOption {
  fieldId?: string | null | undefined;
}

export class YearPlanContractError extends Error {
  constructor(what: string) {
    super(`The server's ${what} does not match this version of the app.`);
    this.name = "YearPlanContractError";
  }
}

function parse<T>(schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } }, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new YearPlanContractError(what);
  return result.data;
}

const withSignal = (init: RequestInit | undefined, signal?: AbortSignal): RequestInit | undefined =>
  signal ? { ...(init ?? {}), signal } : init;

const planPath = (farmId: string, suffix = "") => `/api/v1/farms/${encodeURIComponent(farmId)}/year-plan${suffix}`;

export interface HorizonOptions extends RequestOptions, FieldOption {
  /**
   * A later 12-month horizon (round 3): one of the server's `navigation` dates (year index 1 to 3). Omitted for the
   * current horizon; the server answers 400 for any other date.
   */
  from?: string | null | undefined;
}

/** `?from=&fieldId=` for the GET (from omitted on the current horizon), `?fieldId=` for the POST (from rides in its body). */
export function yearPlanPath(farmId: string, query: { from?: string | null | undefined; fieldId?: string | null | undefined } = {}): string {
  const q = new URLSearchParams();
  if (query.from) q.set("from", query.from);
  if (query.fieldId) q.set("fieldId", query.fieldId);
  const text = q.toString();
  return planPath(farmId, text ? `?${text}` : "");
}

/** GET the farm's (or the field's) review for one horizon (may be pending, stale, or an empty shell when nothing was generated yet). */
export async function loadYearPlan(farmId: string, opts: HorizonOptions = {}): Promise<YearPlanReview> {
  const path = yearPlanPath(farmId, { from: opts.from, fieldId: opts.fieldId });
  const env = await apiRequest<unknown>(path, withSignal(undefined, opts.signal), opts.fetchImpl);
  return parse<YearPlanReview>(reviewSchema, env.data, "year plan");
}

export interface GenerateOptions extends HorizonOptions {
  /** Refresh / Try again: replace a finished plan now instead of waiting out the server's provider-error cooldown. */
  force?: boolean;
}

/** POST: ask the server to (re)generate the review of one horizon. Returns immediately with a pending or finished review. */
export async function generateYearPlan(farmId: string, opts: GenerateOptions = {}): Promise<YearPlanReview> {
  const body = { ...(opts.force === true ? { force: true } : {}), ...(opts.from ? { from: opts.from } : {}) };
  const env = await apiRequest<unknown>(yearPlanPath(farmId, { fieldId: opts.fieldId }), withSignal(jsonInit("POST", body), opts.signal), opts.fetchImpl);
  return parse<YearPlanReview>(reviewSchema, env.data, "year plan");
}

/** Resolves after `ms`, or early (without error) when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface PollOptions extends GenerateOptions {
  onUpdate?: (review: YearPlanReview) => void;
  intervalMs?: number;
  maxPolls?: number;
}

/**
 * GET every `intervalMs` while the review is pending or running. Stops when it settles, when the signal aborts (unmount
 * or farm change), or after `maxPolls`. Returns the last review seen; callers check `signal.aborted` before using it.
 */
export async function pollYearPlan(farmId: string, initial: YearPlanReview, opts: PollOptions = {}): Promise<YearPlanReview> {
  let review = initial;
  const interval = opts.intervalMs ?? YEAR_PLAN_POLL_MS;
  for (let i = 0; i < (opts.maxPolls ?? YEAR_PLAN_MAX_POLLS) && isActive(review); i++) {
    await pause(interval, opts.signal);
    if (opts.signal?.aborted) return review;
    review = await loadYearPlan(farmId, opts);
    if (opts.signal?.aborted) return review;
    opts.onUpdate?.(review);
  }
  return review;
}

/** POST to generate, report the first answer, then poll until it settles (see pollYearPlan). */
export async function ensureYearPlan(farmId: string, opts: PollOptions = {}): Promise<YearPlanReview> {
  const first = await generateYearPlan(farmId, opts);
  if (opts.signal?.aborted) return first;
  opts.onUpdate?.(first);
  return pollYearPlan(farmId, first, opts);
}

/** The rescore or apply body with the field it is for (12.2); unchanged when there is no field (a farm without fields). */
export function withFieldId<T extends object>(body: T, fieldId: string | null | undefined): T & { fieldId?: string } {
  return fieldId ? { ...body, fieldId } : body;
}

/** Farmer edit: code re-scores the changed option without a model call. The body is validated before sending. */
export async function rescore(farmId: string, body: RescoreYearPlan, opts: RequestOptions = {}): Promise<YearPlanOption> {
  const valid = rescoreSchema.safeParse(body);
  if (!valid.success) throw new YearPlanContractError("re-score request");
  const env = await apiRequest<unknown>(planPath(farmId, "/rescore"), withSignal(jsonInit("POST", valid.data), opts.signal), opts.fetchImpl);
  return parse<YearPlanOption>(optionSchema, env.data, "re-scored plan");
}

/**
 * Append the option's seasons through the append-only workspace path. `idempotencyKey` must be reused across retries
 * of the same tap so a retried request cannot add the seasons twice.
 */
export async function apply(
  farmId: string,
  body: ApplyYearPlan,
  opts: RequestOptions & { idempotencyKey?: string } = {},
): Promise<ApplyYearPlanResult> {
  const valid = applySchema.safeParse(body);
  if (!valid.success) throw new YearPlanContractError("apply request");
  const env = await apiRequest<unknown>(
    planPath(farmId, "/apply"),
    withSignal(jsonInit("POST", valid.data, { "idempotency-key": opts.idempotencyKey ?? newEntryId("year-plan-apply") }), opts.signal),
    opts.fetchImpl,
  );
  return parse<ApplyYearPlanResult>(applyResultSchema, env.data, "saved plan");
}

export interface PriceTrendParams {
  productId: string;
  /** State id ("IN-KA") or name; the server resolves both. */
  state?: string | null;
  /** District name as stored on the farm. */
  district?: string | null;
  months?: number;
}

export const priceTrendPath = (params: PriceTrendParams) => {
  const q = new URLSearchParams({ productId: params.productId, months: String(params.months ?? 36) });
  if (params.state) q.set("state", params.state);
  if (params.district) q.set("district", params.district);
  return `/api/v1/price-trend?${q.toString()}`;
};

/** 36-month monthly mandi trend for one product (detail sheet sparkline). */
export async function priceTrend(params: PriceTrendParams, opts: RequestOptions = {}): Promise<PriceTrend> {
  const env = await apiRequest<unknown>(priceTrendPath(params), withSignal(undefined, opts.signal), opts.fetchImpl);
  return parse<PriceTrend>(priceTrendSchema, env.data, "price trend");
}

export type YearPlanFailure =
  | { kind: "missing_endpoint"; message: string }
  | { kind: "needs_location"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "server"; message: string };

/** Farmer-readable classification of a thrown error. Never throws. */
export function classifyYearPlanError(error: unknown): YearPlanFailure {
  if (error instanceof YearPlanContractError) return { kind: "invalid", message: error.message };
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "network_error")
      return { kind: "offline", message: "Could not reach the server. Check the connection and try again." };
    if (/location|district|state_unknown/i.test(error.code))
      return { kind: "needs_location", message: error.message };
    if (error.status === 404 || error.status === 405 || error.status === 501)
      return { kind: "missing_endpoint", message: "Year plans are not available on this server yet." };
    if (error.status === 409)
      return { kind: "conflict", message: "Your saved seasons changed in the meantime. They have been reloaded; check them and try again." };
    if (error.status === 400 || error.status === 422)
      return { kind: "invalid", message: error.message || "The server did not accept this plan." };
    return { kind: "server", message: `The year plan could not be loaded (${error.code}). Try again shortly.` };
  }
  return { kind: "server", message: "Something unexpected went wrong. Try again shortly." };
}
