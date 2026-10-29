import { ApiError, request, type Envelope } from "../../lib/api";
import { clearSessionState, ensureSession } from "../../lib/session";

/**
 * request() with a guest session guaranteed: ensures one before the call and, on a 401 (expired or revoked
 * cookie), mints a fresh one and retries exactly once. Never loops.
 */
export async function apiRequest<T>(path: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Envelope<T>> {
  await ensureSession(fetchImpl);
  try {
    return await request<T>(path, init, fetchImpl);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    clearSessionState();
    if (!(await ensureSession(fetchImpl))) throw e;
    return request<T>(path, init, fetchImpl);
  }
}

export function jsonInit(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** Stable client-side entry id; reused across retries of the same user action. */
export function newEntryId(prefix: string): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}
