import { createRoot, createSignal } from "solid-js";
import { createIdb } from "../../lib/idb";
import { syncQueue } from "../../lib/sync/journal";
import type { QueueItem } from "../../lib/sync/queue";
import { SnapshotStore, StaleRegistry } from "../plan-cache/store";
import { getOwnerScope } from "./scope";

/** Singletons shared by the fetch wrapper, the banner, the decorator and the journal sync panel. */
export const snapshots = new SnapshotStore(createIdb("harvest-cache"), () => getOwnerScope());
export const staleRegistry = new StaleRegistry();

const s = createRoot(() => {
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine);
  const [staleKeys, setStaleKeys] = createSignal<string[]>([]);
  const [queue, setQueue] = createSignal<QueueItem[]>([]);
  const [now, setNow] = createSignal(Date.now());
  return { online, setOnline, staleKeys, setStaleKeys, queue, setQueue, now, setNow };
});

export const isOnline = s.online;
export const staleKeys = s.staleKeys;
export const queueItems = s.queue;
export const clockNow = s.now;

export function staleAt(key: string): number | undefined {
  s.staleKeys(); // subscribe
  return staleRegistry.get(key);
}

export async function refreshQueue(): Promise<void> {
  try {
    s.setQueue(await syncQueue.list());
  } catch {
    s.setQueue([]);
  }
}

let started = false;
/** Wires browser connectivity, the stale registry and the queue into signals. Idempotent. */
export function startStatus(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => s.setOnline(true));
  window.addEventListener("offline", () => s.setOnline(false));
  staleRegistry.subscribe(() => s.setStaleKeys(staleRegistry.keys()));
  syncQueue.subscribe(() => void refreshQueue());
  void refreshQueue();
  setInterval(() => s.setNow(Date.now()), 30_000);
}
