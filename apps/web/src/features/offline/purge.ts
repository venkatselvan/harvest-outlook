import { createIdb } from "../../lib/idb";
import { syncQueue } from "../../lib/sync/journal";
import { rotateOwnerScope } from "./scope";
import { snapshots, staleRegistry } from "./status";

/** localStorage / sessionStorage keys that hold workspace data (all owned by features that cannot import this file). */
export const WORKSPACE_STORAGE_KEYS = {
  local: ["ho.exploreProfile.v1", "ho.selectedFarm"],
  session: ["ho.selectedCrop"],
} as const;

export const SESSION_ENDED_EVENT = "ho:session-ended";
export const FARM_DELETED_EVENT = "ho:farm-deleted";

function removeKeys(storage: () => Storage | undefined, keys: readonly string[]): void {
  try {
    const s = storage();
    for (const k of keys) s?.removeItem(k);
  } catch {
    /* storage blocked */
  }
}

/** Deletes every key of the journal draft database (drafts and per-farm "current draft" pointers). */
export async function clearJournalDrafts(name = "harvest-journal"): Promise<void> {
  const db = createIdb(name);
  for (const k of await db.keys()) await db.delete(k);
}

/**
 * Removes everything this device stored for the workspace: plan/journal snapshots, queued journal entries, journal
 * drafts, the explore profile, the selected farm and crop, and the owner scope itself (a new one is minted on next use).
 * Runs after DELETE /session, DELETE /farms/:id succeeds, or the session check reports a different identity.
 */
export async function purgeLocalData(): Promise<void> {
  staleRegistry.clearAll();
  await Promise.allSettled([snapshots.clearAll(), syncQueue.clearAll(), clearJournalDrafts()]);
  removeKeys(() => (typeof localStorage === "undefined" ? undefined : localStorage), WORKSPACE_STORAGE_KEYS.local);
  removeKeys(() => (typeof sessionStorage === "undefined" ? undefined : sessionStorage), WORKSPACE_STORAGE_KEYS.session);
  rotateOwnerScope();
  if (typeof caches !== "undefined") await caches.delete("ho-api-public").catch(() => false);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ho:local-data-purged"));
}

/** Purge when session.ts or the fetch wrapper reports that the workspace ended. Returns the unsubscribe function. */
export function installPurgeListeners(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, purge: () => Promise<void> = purgeLocalData): () => void {
  const on = () => void purge();
  target.addEventListener(SESSION_ENDED_EVENT, on);
  target.addEventListener(FARM_DELETED_EVENT, on);
  return () => {
    target.removeEventListener(SESSION_ENDED_EVENT, on);
    target.removeEventListener(FARM_DELETED_EVENT, on);
  };
}
