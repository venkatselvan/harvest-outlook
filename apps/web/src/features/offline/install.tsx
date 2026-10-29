import { render } from "solid-js/web";
import { OfflineBanner } from "../../components/OfflineBanner";
import { flushJournalQueue } from "../../lib/sync/journal";
import { createCachingFetch } from "../plan-cache/fetch";
import { startDecorator } from "./decorate";
import { purgeLocalData } from "./purge";
import { snapshots, staleRegistry, startStatus } from "./status";

/**
 * One call from index.tsx: wraps window.fetch with the snapshot cache, renders the offline banner in its own root,
 * starts the offline cues, and flushes the journal queue on app open, `online` and when the tab becomes visible.
 * Local data is purged when the server session or the farm is deleted (the fetch wrapper detects the successful DELETE;
 * session.ts has no event of its own).
 */
export function installOffline(): void {
  window.fetch = createCachingFetch({
    base: window.fetch.bind(window),
    snapshots,
    stale: staleRegistry,
    onWorkspaceDeleted: () => void purgeLocalData(),
  });
  startStatus();
  const host = document.createElement("div");
  host.id = "offline-root";
  document.body.prepend(host);
  render(() => <OfflineBanner />, host);
  startDecorator();

  const flush = () => void flushJournalQueue();
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flush();
  });
  flush();
}
