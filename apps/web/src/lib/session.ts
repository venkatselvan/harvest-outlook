/**
 * Guest-session bootstrap. The session itself lives in an HttpOnly cookie the page cannot read;
 * the CSRF token is kept in memory only and sent as X-CSRF-Token on state-changing requests.
 */

/** Window events consumed by features/offline/purge.ts (the string values are part of that contract). */
const SESSION_ENDED = "ho:session-ended";
const KNOWN_KEY = "ho.sessionKnown";

function emit(name: string, detail?: unknown): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* no window */
  }
}

function marker(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

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
      if (!data?.authenticated) {
        // The server answered "no session" for a device that had one: this is a different identity, so what is saved
        // locally belongs to a workspace that cannot be reached any more. (An unreachable server is not this case:
        // call() returns null for it, and a thrown network error skips the block.)
        const answered = data !== null;
        if (answered && marker()?.getItem(KNOWN_KEY)) {
          marker()?.removeItem(KNOWN_KEY);
          emit(SESSION_ENDED, { reason: "identity_changed" });
        }
        data = await call("POST", fetchImpl);
      }
      csrfToken = data?.authenticated && data.csrfToken ? data.csrfToken : null;
      if (csrfToken) {
        try {
          marker()?.setItem(KNOWN_KEY, "1");
        } catch {
          /* storage blocked */
        }
      }
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
    const res = await fetchImpl("/api/v1/session", { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json", ...csrfHeaders("DELETE") } });
    if (res.ok) {
      marker()?.removeItem(KNOWN_KEY);
      emit(SESSION_ENDED, { reason: "deleted" });
    }
  } finally {
    clearSessionState();
  }
}
