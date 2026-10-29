import { Show } from "solid-js";
import { isOnline, queueItems, staleKeys } from "../features/offline/status";
import { OFFLINE_NOTE } from "../features/plan-cache/freshness";
import "../features/offline/offline.css";

/** Connectivity, queue and stale-data notice. Rendered in its own root above the app (see features/offline/install.ts). */
export function OfflineBanner() {
  const waiting = () => queueItems().filter((i) => i.state === "queued" || i.state === "sending").length;
  const conflicts = () => queueItems().filter((i) => i.state === "conflict").length;
  return (
    <div class="offline-banner-wrap" role="status" aria-live="polite" data-testid="offline-banner-wrap">
      <Show when={!isOnline()}>
        <p class="offline-banner" data-testid="offline-banner">
          You are offline. {OFFLINE_NOTE} Journal entries you save are kept on this device and sent when you are back online.
        </p>
      </Show>
      <Show when={isOnline() && staleKeys().length > 0}>
        <p class="offline-banner" data-testid="stale-banner">The server could not be reached, so some data is a saved copy.</p>
      </Show>
      <Show when={waiting() > 0}>
        <p class="offline-banner sync" data-testid="sync-banner">{waiting()} journal {waiting() === 1 ? "entry is" : "entries are"} waiting to be sent.</p>
      </Show>
      <Show when={conflicts() > 0}>
        <p class="offline-banner conflict" data-testid="conflict-banner">{conflicts()} journal {conflicts() === 1 ? "entry needs" : "entries need"} your review on the Journal page.</p>
      </Show>
    </div>
  );
}
