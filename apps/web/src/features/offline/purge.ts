import { syncQueue } from "../../lib/sync/journal";
import { rotateOwnerScope } from "./scope";
import { snapshots, staleRegistry } from "./status";

/**
 * Removes everything this device stored for the workspace: plan/journal snapshots, queued journal entries, and the
 * owner scope itself (a new one is minted on next use). Called after DELETE /session or DELETE /farms/:id succeeds.
 */
export async function purgeLocalData(): Promise<void> {
  staleRegistry.clearAll();
  await Promise.allSettled([snapshots.clearAll(), syncQueue.clearAll()]);
  rotateOwnerScope();
  if (typeof caches !== "undefined") await caches.delete("ho-api-public").catch(() => false);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ho:local-data-purged"));
}
