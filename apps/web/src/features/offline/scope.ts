/**
 * Owner scope: a random per-session id kept in sessionStorage. It namespaces everything this device stores for the
 * signed-in guest workspace (plan snapshots, queued journal entries). It is never the server-side owner id, and it is
 * dropped (rotated) on logout or farm deletion, which makes the old namespace unreachable; `purge*` then deletes it.
 */
const KEY = "ho.ownerScope";

let memoryScope: string | null = null;

function randomId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getOwnerScope(storage: Pick<Storage, "getItem" | "setItem"> | null = safeSession()): string {
  try {
    const existing = storage?.getItem(KEY);
    if (existing) return existing;
    const fresh = randomId();
    storage?.setItem(KEY, fresh);
    return storage ? fresh : (memoryScope ??= fresh);
  } catch {
    return (memoryScope ??= randomId());
  }
}

/** Forget the scope; the next getOwnerScope() mints a different one. */
export function rotateOwnerScope(storage: Pick<Storage, "removeItem"> | null = safeSession()): void {
  memoryScope = null;
  try {
    storage?.removeItem(KEY);
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
