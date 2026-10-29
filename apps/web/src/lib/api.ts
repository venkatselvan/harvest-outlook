import { csrfHeaders } from "./session";

export type RuntimeMode = "live" | "replay" | "synthetic";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface Envelope<T> {
  requestId: string;
  mode: RuntimeMode;
  asOf: string;
  data: T | null;
  warnings: { code: string; message: string }[];
  error: ApiErrorBody | null;
}

export interface Capabilities {
  mode: RuntimeMode;
  models: {
    text: string;
    escalation: string;
    image: string;
    segment: string;
    speechToText: string | null;
    textToSpeech: string | null;
  };
  providers: { meta: boolean; elevenlabs: boolean };
  languages: string[];
  database: { reachable: boolean; postgis: boolean };
  limits: { maxUploadImageBytes: number; maxVoiceSeconds: number };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const MODES: readonly string[] = ["live", "replay", "synthetic"];

/** Validates the standard response envelope. Throws ApiError if the payload is not one. */
export function parseEnvelope<T>(json: unknown, status = 200): Envelope<T> {
  const o = json as Record<string, unknown> | null;
  const ok =
    o !== null &&
    typeof o === "object" &&
    typeof o.requestId === "string" &&
    typeof o.mode === "string" &&
    MODES.includes(o.mode) &&
    typeof o.asOf === "string" &&
    Array.isArray(o.warnings) &&
    "data" in o &&
    "error" in o;
  if (!ok) throw new ApiError("invalid_envelope", "Server response was not a valid envelope", status);
  return o as unknown as Envelope<T>;
}

/** Returns the envelope for a successful call; throws ApiError for transport, HTTP or envelope errors. */
export async function request<T>(path: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Envelope<T>> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...csrfHeaders(init?.method), ...init?.headers },
    });
  } catch {
    throw new ApiError("network_error", "Could not reach the server", 0);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("invalid_response", `Server returned a non-JSON response (HTTP ${res.status})`, res.status);
  }
  const env = parseEnvelope<T>(json, res.status);
  if (!res.ok || env.error) {
    throw new ApiError(env.error?.code ?? "http_error", env.error?.message ?? `HTTP ${res.status}`, res.status, env.requestId);
  }
  if (env.data === null) throw new ApiError("empty_response", "Server returned no data", res.status, env.requestId);
  return env;
}

export function getCapabilities(fetchImpl?: typeof fetch): Promise<Envelope<Capabilities>> {
  return request<Capabilities>("/api/v1/capabilities", undefined, fetchImpl);
}
