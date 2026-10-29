import { ApiErrorCode, SCHEMA_VERSION, type ApiError, type ApiWarning } from "@harvest/contracts";
import type { Config } from "./config";

/** Wire shape of an error: structurally the contract ApiError, but `code` may be any string before normalisation. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

export interface Envelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  mode: Config["RUNTIME_MODE"];
  asOf: string;
  data: T | null;
  warnings: ApiWarning[];
  error: ApiError | null;
}

const RETRYABLE: ReadonlySet<string> = new Set(["rate_limited", "provider_unavailable", "provider_rate_limited", "idempotency_in_progress", "internal_error"]);

/**
 * Normalises to the exported ApiError contract: known code (unknown codes become
 * `bad_request` with the original preserved in details.originalCode), boolean
 * `retryable`, and `details` as a record.
 */
export function toApiError(error: ApiErrorBody): ApiError {
  const known = ApiErrorCode.safeParse(error.code);
  const code = known.success ? known.data : "bad_request";
  let details: Record<string, unknown> | undefined;
  if (error.details !== undefined && error.details !== null) {
    details = typeof error.details === "object" && !Array.isArray(error.details) ? { ...(error.details as Record<string, unknown>) } : { value: error.details };
  }
  if (!known.success) details = { ...(details ?? {}), originalCode: error.code };
  return {
    code,
    message: error.message || "Request failed",
    retryable: error.retryable ?? RETRYABLE.has(code),
    ...(details ? { details } : {}),
  };
}

/** Plain-string warnings become contract ApiWarnings: snake_case codes are kept, sentences get a slug code. */
export function toApiWarning(w: string): ApiWarning {
  if (/^[a-z][a-z0-9_]{1,80}$/.test(w)) return { code: w, message: w.replace(/_/g, " ") };
  const slug = w.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/g, "");
  return { code: /^[a-z]/.test(slug) && slug.length >= 2 ? slug : "notice", message: w };
}

export function envelope<T>(
  requestId: string,
  mode: Config["RUNTIME_MODE"],
  data: T,
  warnings: string[] = [],
): Envelope<T> {
  return { schemaVersion: SCHEMA_VERSION, requestId, mode, asOf: new Date().toISOString(), data, warnings: warnings.map(toApiWarning), error: null };
}

export function errorEnvelope(
  requestId: string,
  mode: Config["RUNTIME_MODE"],
  error: ApiErrorBody,
): Envelope<null> {
  return { schemaVersion: SCHEMA_VERSION, requestId, mode, asOf: new Date().toISOString(), data: null, warnings: [], error: toApiError(error) };
}
