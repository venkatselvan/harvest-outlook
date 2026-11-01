import { SoilReview as reviewSchema, type SoilReview } from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { isActive } from "./soilReviewModel";

/**
 * Client for the soil review endpoints (ROUND2_SPEC.md 5.2). Every response is validated against the shared zod
 * contract; a payload that does not match raises SoilReviewContractError so the view shows an error instead of
 * rendering partial data. GET creates the review (pending) when none exists for the current soil values.
 */
export const SOIL_REVIEW_POLL_MS = 1500;
/** Upper bound on one polling run (about 3 minutes); the view then offers Refresh. */
export const SOIL_REVIEW_MAX_POLLS = 120;

export interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class SoilReviewContractError extends Error {
  constructor() {
    super("The server's soil review does not match this version of the app.");
    this.name = "SoilReviewContractError";
  }
}

const path = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}/soil-review`;
const withSignal = (init: RequestInit | undefined, signal?: AbortSignal): RequestInit | undefined =>
  signal ? { ...(init ?? {}), signal } : init;

function parse(data: unknown): SoilReview {
  const result = reviewSchema.safeParse(data);
  if (!result.success) throw new SoilReviewContractError();
  return result.data;
}

export async function loadSoilReview(farmId: string, opts: RequestOptions = {}): Promise<SoilReview> {
  const env = await apiRequest<unknown>(path(farmId), withSignal(undefined, opts.signal), opts.fetchImpl);
  return parse(env.data);
}

/** Refresh: a finished review is rebuilt (a pending one is returned as it is). */
export async function refreshSoilReview(farmId: string, opts: RequestOptions = {}): Promise<SoilReview> {
  const env = await apiRequest<unknown>(path(farmId), withSignal(jsonInit("POST", {}), opts.signal), opts.fetchImpl);
  return parse(env.data);
}

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

export interface PollOptions extends RequestOptions {
  onUpdate?: (review: SoilReview) => void;
  intervalMs?: number;
  maxPolls?: number;
}

/**
 * GET every `intervalMs` while the review is pending or running. Stops when it settles, when the signal aborts (unmount
 * or farm change), or after `maxPolls`. Returns the last review seen; callers check `signal.aborted` before using it.
 */
export async function pollSoilReview(farmId: string, initial: SoilReview, opts: PollOptions = {}): Promise<SoilReview> {
  let review = initial;
  const interval = opts.intervalMs ?? SOIL_REVIEW_POLL_MS;
  for (let i = 0; i < (opts.maxPolls ?? SOIL_REVIEW_MAX_POLLS) && isActive(review); i++) {
    await pause(interval, opts.signal);
    if (opts.signal?.aborted) return review;
    review = await loadSoilReview(farmId, opts);
    if (opts.signal?.aborted) return review;
    opts.onUpdate?.(review);
  }
  return review;
}

/** POST (refresh), report the first answer, then poll until it settles. */
export async function refreshAndPoll(farmId: string, opts: PollOptions = {}): Promise<SoilReview> {
  const first = await refreshSoilReview(farmId, opts);
  if (opts.signal?.aborted) return first;
  opts.onUpdate?.(first);
  return pollSoilReview(farmId, first, opts);
}
