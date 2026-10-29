/**
 * Owner scope: a random id persisted in localStorage, so a new tab, a reopened PWA or a cold start offline all see the
 * same namespace as the tab that saved the data (plan snapshots, queued journal entries, journal drafts). It is never
 * the server-side owner id. It is dropped (rotated) when the workspace ends: DELETE /session, DELETE /farms/:id, or a
 * session check that reports a different identity (see lib/session.ts); `purgeLocalData` then deletes the old data.
 * A scope that an earlier build kept in sessionStorage is adopted once so data saved under it stays reachable.
 */
const KEY = "ho.ownerScope.v2";
const LEGACY_KEY = "ho.ownerScope";

let memoryScope: string | null = null;

function randomId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getOwnerScope(storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocal()): string {
  try {
    const existing = storage?.getItem(KEY);
    if (existing) return existing;
    const fresh = (storage === safeLocal() ? legacySessionScope() : null) ?? randomId();
    storage?.setItem(KEY, fresh);
    return storage ? fresh : (memoryScope ??= fresh);
  } catch {
    return (memoryScope ??= randomId());
  }
}

/** Forget the scope; the next getOwnerScope() mints a different one. */
export function rotateOwnerScope(storage: Pick<Storage, "removeItem"> | null = safeLocal()): void {
  memoryScope = null;
  try {
    storage?.removeItem(KEY);
    safeSession()?.removeItem(LEGACY_KEY);
  } catch {
    /* storage blocked */
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function legacySessionScope(): string | null {
  try {
    return safeSession()?.getItem(LEGACY_KEY) ?? null;
  } catch {
    return null;
  }
}
