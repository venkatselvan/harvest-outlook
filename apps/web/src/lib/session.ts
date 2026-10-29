/**
 * Guest-session bootstrap. The session itself lives in an HttpOnly cookie the page cannot read;
 * the CSRF token is kept in memory only and sent as X-CSRF-Token on state-changing requests.
 */

let csrfToken: string | null = null;
let pending: Promise<void> | null = null;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Headers to attach to a request: CSRF token for state-changing methods only. */
export function csrfHeaders(method?: string): Record<string, string> {
  if (csrfToken && UNSAFE.has((method ?? "GET").toUpperCase())) return { "x-csrf-token": csrfToken };
  return {};
}

export function hasSession(): boolean {
  return csrfToken !== null;
}

/** Test/logout helper. */
export function clearSessionState(): void {
  csrfToken = null;
  pending = null;
}

interface SessionData {
  authenticated: boolean;
  csrfToken?: string;
  caveat?: string;
}

async function call(method: "GET" | "POST", fetchImpl: typeof fetch): Promise<SessionData | null> {
  const res = await fetchImpl("/api/v1/session", { method, credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { data?: SessionData | null } | null;
  return json?.data ?? null;
}

/**
 * Ensures a guest session exists. Checks first (GET) so reloads do not mint new workspaces or
 * burn the per-IP creation limit, and creates one (POST) only if none is valid. Concurrent callers share one attempt.
 * Resolves to true when a session with a CSRF token is available.
 */
export function ensureSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (csrfToken) return Promise.resolve(true);
  pending ??= (async () => {
    try {
      let data = await call("GET", fetchImpl);
      if (!data?.authenticated) data = await call("POST", fetchImpl);
      csrfToken = data?.authenticated && data.csrfToken ? data.csrfToken : null;
    } catch {
      csrfToken = null;
    } finally {
      pending = null;
    }
  })();
  return pending.then(() => csrfToken !== null);
}

/** Revokes the server session and forgets the in-memory token. */
export async function endSession(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl("/api/v1/session", { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json", ...csrfHeaders("DELETE") } });
  } finally {
    clearSessionState();
  }
}
