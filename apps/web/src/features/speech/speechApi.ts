import { ApiError, parseEnvelope } from "../../lib/api";
import { csrfHeaders, ensureSession } from "../../lib/session";
import type { SpeechLang, TranscriptResult } from "./speechMachine";

interface TranscriptionData {
  transcript: string;
  detectedLanguage: string | null;
  languageProbability: number | null;
  synthetic: boolean;
  provider: { name: string };
}

export interface UploadHandle {
  promise: Promise<TranscriptResult>;
  abort: () => void;
}

interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(k: string, v: string): void;
  send(body: FormData): void;
  abort(): void;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null; onload: (() => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  withCredentials: boolean;
  status: number;
  responseText: string;
}

export interface UploadDeps {
  createXhr?: () => XhrLike;
}

/** Uploads one recording. XHR (not fetch) because only XHR reports upload progress. The audio is never kept by the client after this call. */
export function uploadTranscription(
  audio: Blob,
  language: SpeechLang,
  opts: { farmId?: string; onProgress?: (fraction: number) => void; onSent?: () => void } = {},
  deps: UploadDeps = {},
): UploadHandle {
  const xhr = (deps.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike))();
  const promise = (async () => {
    await ensureSession();
    return new Promise<TranscriptResult>((resolve, reject) => {
      const form = new FormData();
      form.append("language", language);
      if (opts.farmId) form.append("farmId", opts.farmId);
      form.append("audio", audio, "voice-note");
      xhr.open("POST", "/api/v1/speech/transcriptions");
      xhr.withCredentials = true;
      xhr.setRequestHeader("accept", "application/json");
      for (const [k, v] of Object.entries(csrfHeaders("POST"))) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
      };
      xhr.upload.onload = () => opts.onSent?.();
      xhr.onerror = () => reject(new ApiError("network_error", "Could not reach the server", 0));
      xhr.onabort = () => reject(new ApiError("client_cancelled", "Cancelled", 0));
      xhr.onload = () => {
        try {
          const env = parseEnvelope<TranscriptionData>(JSON.parse(xhr.responseText), xhr.status);
          if (xhr.status < 200 || xhr.status >= 300 || env.error || !env.data) {
            reject(new ApiError(env.error?.code ?? "http_error", env.error?.message ?? `HTTP ${xhr.status}`, xhr.status, env.requestId));
            return;
          }
          resolve({
            transcript: env.data.transcript,
            detectedLanguage: env.data.detectedLanguage,
            languageProbability: env.data.languageProbability,
            synthetic: env.data.synthetic,
            providerName: env.data.provider.name,
          });
        } catch (e) {
          reject(e instanceof ApiError ? e : new ApiError("invalid_response", "Server returned an unreadable response", xhr.status));
        }
      };
      xhr.send(form);
    });
  })();
  return { promise, abort: () => xhr.abort() };
}

/** Fetches audio for an approved answer; resolves to the audio Blob. */
export async function fetchSynthesis(
  req: { text: string; language: SpeechLang; approvedTextHash: string },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  await ensureSession(fetchImpl);
  let res: Response;
  try {
    res = await fetchImpl("/api/v1/speech/synthesis", {
      method: "POST",
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
      headers: { "content-type": "application/json", ...csrfHeaders("POST") },
      body: JSON.stringify(req),
    });
  } catch {
    throw new ApiError("network_error", "Could not reach the server", 0);
  }
  if (!res.ok) {
    let code = "http_error";
    try {
      const env = parseEnvelope<null>(await res.json(), res.status);
      code = env.error?.code ?? code;
    } catch {
      /* keep generic code */
    }
    throw new ApiError(code, `HTTP ${res.status}`, res.status);
  }
  return res.blob();
}
