import { createIdbStore } from "../../features/journal/idbStore";
import { scopedStore, type KeyValueStore } from "../../features/journal/model";
import { getOwnerScope } from "../../features/offline/scope";

export type DraftStore = KeyValueStore & { persistent?: boolean | undefined };
let shared: DraftStore | undefined;
/**
 * Scouting drafts live in the journal's draft database ("harvest-journal"), namespaced by the owner scope, under keys that
 * start with `scouting:` (FIELD_OPERATIONS_SPEC.md 8.4). Sign-out and farm deletion already purge that database, so a
 * draft never outlives the workspace it was written for. Without IndexedDB the store is memory-only.
 */
export function scoutingStore(): DraftStore {
  return (shared ??= scopedStore(createIdbStore(), () => getOwnerScope()));
}
