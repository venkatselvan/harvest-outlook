import { createIdb, type ListableStore } from "../../lib/idb";
import type { KeyValueStore } from "./model";

/**
 * Journal draft store. The IndexedDB implementation lives in lib/idb.ts (shared with the sync queue and the plan cache);
 * without IndexedDB it falls back to memory, which keeps the form usable but loses the draft on reload.
 */
export function createIdbStore(name = "harvest-journal"): KeyValueStore & ListableStore {
  return createIdb(name);
}
