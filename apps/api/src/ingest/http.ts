import { redactSecrets } from "./redact";

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Pick<Response, "ok" | "status" | "text" | "headers">>;

export type HttpFailureReason = "timeout" | "network_error" | "http_error" | "rate_limited" | "invalid_json";

export type HttpResult =
  | { ok: true; status: number; json: unknown; attempts: number }
  | { ok: false; reason: HttpFailureReason; status?: number; message: string; body?: unknown; attempts: number };

export interface HttpOptions {
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  /** Retries after the first attempt; clamped to [0, 2]. */
  retries?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  headers?: Record<string, string> | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET JSON with a timeout and bounded retries (network errors, timeouts, 429, 5xx). 4xx other than 429
 * is final. Every message is passed through `redactSecrets`; callers never see an api-key.
 */
export async function getJson(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxAttempts = 1 + Math.max(0, Math.min(2, opts.retries ?? 2));
  const sleep = opts.sleep ?? defaultSleep;
  let last: HttpResult = { ok: false, reason: "network_error", message: "no attempt made", attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let retryable = false;
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: "application/json", ...opts.headers } });
      const text = await res.text();
      let json: unknown;
      let parsed = true;
      try {
        json = JSON.parse(text);
      } catch {
        parsed = false;
      }
      if (res.ok && parsed) return { ok: true, status: res.status, json, attempts: attempt };
      if (res.ok) {
        last = { ok: false, reason: "invalid_json", status: res.status, message: "response was not valid JSON", attempts: attempt };
      } else if (res.status === 429) {
        retryable = true;
        last = { ok: false, reason: "rate_limited", status: 429, message: "HTTP 429", attempts: attempt };
      } else {
        retryable = res.status >= 500;
        last = {
          ok: false,
          reason: "http_error",
          status: res.status,
          message: redactSecrets(`HTTP ${res.status}`),
          body: parsed ? json : undefined,
          attempts: attempt,
        };
      }
    } catch (e) {
      const aborted = (e as Error).name === "AbortError" || ac.signal.aborted;
      retryable = true;
      last = {
        ok: false,
        reason: aborted ? "timeout" : "network_error",
        message: aborted ? `timed out after ${timeoutMs} ms` : redactSecrets((e as Error).message),
        attempts: attempt,
      };
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === maxAttempts) break;
    await sleep(250 * 2 ** (attempt - 1));
  }
  return last;
}
