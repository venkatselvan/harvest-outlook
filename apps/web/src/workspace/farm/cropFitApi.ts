import { CropFitReview as reviewSchema, type CropFitReview } from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";
import { isActive, queryFor, type ControlsState } from "./cropFitModel";

/**
 * Client for GET/POST /api/v1/farms/:id/crop-fit (ROUND2_SPEC.md 4.1). Every response is validated with the shared zod
 * contract; a payload that does not match raises CropFitContractError so the view shows an error instead of partial
 * data. Polling follows the year plan (yearPlanApi.ts): GET every 1.5 s while pending or running, abortable.
 */
export const CROP_FIT_POLL_MS = 1500;
export const CROP_FIT_MAX_POLLS = 160;

export interface RequestOptions { signal?: AbortSignal; fetchImpl?: typeof fetch }
export class CropFitContractError extends Error {
  constructor() {
    super("The server's crop fit review does not match this version of the app.");
    this.name = "CropFitContractError";
  }
}
const parse = (data: unknown): CropFitReview => {
  const r = reviewSchema.safeParse(data);
  if (!r.success) throw new CropFitContractError();
  return r.data;
};
const withSignal = (init: RequestInit | undefined, signal?: AbortSignal): RequestInit | undefined => (signal ? { ...(init ?? {}), signal } : init);
export const cropFitPath = (farmId: string, controls: ControlsState | null) => `/api/v1/farms/${encodeURIComponent(farmId)}/crop-fit${queryFor(controls)}`;

/** GET: the ready review for the current inputs, or a pending one the server has just started. `null` controls = server default mode. */
export async function loadCropFit(farmId: string, controls: ControlsState | null, opts: RequestOptions = {}): Promise<CropFitReview> {
  const env = await apiRequest<unknown>(cropFitPath(farmId, controls), withSignal(undefined, opts.signal), opts.fetchImpl);
  return parse(env.data);
}
/** POST with the same query: replace a finished review now (Refresh). */
export async function refreshCropFit(farmId: string, controls: ControlsState | null, opts: RequestOptions = {}): Promise<CropFitReview> {
  const env = await apiRequest<unknown>(cropFitPath(farmId, controls), withSignal(jsonInit("POST", {}), opts.signal), opts.fetchImpl);
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
export interface PollOptions extends RequestOptions { onUpdate?: (r: CropFitReview) => void; intervalMs?: number; maxPolls?: number }
/** GET every `intervalMs` while pending or running; stops on settle, abort or `maxPolls`. Returns the last review seen. */
export async function pollCropFit(farmId: string, controls: ControlsState | null, initial: CropFitReview, opts: PollOptions = {}): Promise<CropFitReview> {
  let review = initial;
  for (let i = 0; i < (opts.maxPolls ?? CROP_FIT_MAX_POLLS) && isActive(review); i++) {
    await pause(opts.intervalMs ?? CROP_FIT_POLL_MS, opts.signal);
    if (opts.signal?.aborted) return review;
    review = await loadCropFit(farmId, controls, opts);
    if (opts.signal?.aborted) return review;
    opts.onUpdate?.(review);
  }
  return review;
}

export type CropFitFailure = { kind: "missing_endpoint" | "offline" | "invalid" | "server"; message: string };
/** Farmer-readable classification of a thrown error. Never throws. */
export function classifyCropFitError(error: unknown): CropFitFailure {
  if (error instanceof CropFitContractError) return { kind: "invalid", message: error.message };
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "network_error") return { kind: "offline", message: "Could not reach the server. Check the connection and try again." };
    if (error.status === 404 || error.status === 405 || error.status === 501) return { kind: "missing_endpoint", message: "Crop fit is not available on this server yet." };
    if (error.status === 400 || error.status === 422) return { kind: "invalid", message: error.message || "The server did not accept this request." };
    return { kind: "server", message: `Crop fit could not be loaded (${error.code}). Try again shortly.` };
  }
  return { kind: "server", message: "Something unexpected went wrong. Try again shortly." };
}
