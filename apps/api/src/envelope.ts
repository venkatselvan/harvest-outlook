import type { Config } from "./config";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface Envelope<T> {
  requestId: string;
  mode: Config["RUNTIME_MODE"];
  asOf: string;
  data: T | null;
  warnings: string[];
  error: ApiErrorBody | null;
}

export function envelope<T>(
  requestId: string,
  mode: Config["RUNTIME_MODE"],
  data: T,
  warnings: string[] = [],
): Envelope<T> {
  return { requestId, mode, asOf: new Date().toISOString(), data, warnings, error: null };
}

export function errorEnvelope(
  requestId: string,
  mode: Config["RUNTIME_MODE"],
  error: ApiErrorBody,
): Envelope<null> {
  return { requestId, mode, asOf: new Date().toISOString(), data: null, warnings: [], error };
}
