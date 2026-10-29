import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { flushJournalQueue, newClientEntryId, syncQueue } from "../../lib/sync/journal";
import type { QueueItem } from "../../lib/sync/queue";
import { isOnline, queueItems, refreshQueue } from "./status";
import { ErrorState } from "./ErrorState";
import "./offline.css";

const label = (b: Record<string, unknown>) => ({
  date: String(b.observedOn ?? ""),
  activity: b.activity ? String(b.activity) : "-",
  note: typeof b.note === "string" ? b.note : "-",
  expense: b.expense ? `Rs ${(b.expense as { amountInr: string }).amountInr}` : "-",
  quantity: b.quantity ? `${(b.quantity as { value: number }).value} ${(b.quantity as { unit: string }).unit}` : "-",
  photos: Array.isArray(b.mediaIds) ? b.mediaIds.length : 0,
});

function Summary(props: { title: string; rows: Record<string, string | number> }) {
  return (
    <section class="sync-item" aria-label={props.title}>
      <h3>{props.title}</h3>
      <dl>
        <For each={Object.entries(props.rows)}>{([k, v]) => (<><dt>{k}</dt><dd>{String(v)}</dd></>)}</For>
      </dl>
    </section>
  );
}

function serverRows(e: unknown): Record<string, string | number> | null {
  const s = e as { observedOn?: string; activity?: string | null; note?: string | null; expense?: { amountInr: string } | null; quantity?: { value: number; unit: string } | null; media?: unknown[] } | null;
  if (!s || typeof s !== "object") return null;
  return {
    date: s.observedOn ?? "",
    activity: s.activity ?? "-",
    note: s.note ?? "-",
    expense: s.expense ? `Rs ${s.expense.amountInr}` : "-",
    quantity: s.quantity ? `${s.quantity.value} ${s.quantity.unit}` : "-",
    photos: s.media?.length ?? 0,
  };
}

/** Entries waiting to be sent, retrying, or in conflict. Conflicts get the review UI: server copy vs yours, and a choice. */
export function SyncPanel() {
  const [busy, setBusy] = createSignal(false);
  onMount(() => void refreshQueue());
  const pending = () => queueItems().filter((i) => i.state !== "done");
  const retryNow = async () => {
    setBusy(true);
    await flushJournalQueue({ force: true });
    setBusy(false);
  };
  // refresh when the queue changes elsewhere (another tab writes the same IndexedDB)
  const t = setInterval(() => void refreshQueue(), 5000);
  onCleanup(() => clearInterval(t));
  return (
    <Show when={pending().length > 0}>
      <section class="sync-panel" aria-labelledby="sync-title" data-testid="sync-panel">
        <h2 id="sync-title">Waiting to send</h2>
        <For each={pending()}>{(item) => <Item item={item} busy={busy()} onRetry={retryNow} />}</For>
      </section>
    </Show>
  );
}

function Item(props: { item: QueueItem; busy: boolean; onRetry: () => void }) {
  const l = () => label(props.item.body);
  return (
    <article class="sync-item" data-testid={`sync-item-${props.item.state}`} aria-label={`Journal entry for ${l().date}, ${props.item.state}`}>
      <Show when={props.item.state !== "conflict"}>
        <Summary title={`Entry for ${l().date}`} rows={{ activity: l().activity, note: l().note, expense: l().expense, quantity: l().quantity, photos: l().photos }} />
        <p class="offline-note" role="status">
          {props.item.state === "sending" ? "Sending…" : isOnline() ? `Not sent yet (attempt ${props.item.attempts}). It stays on this device and is retried automatically.` : "Saved on this device. It will be sent when you are back online."}
        </p>
        <Show when={props.item.lastError}>
          <ErrorState code={props.item.lastError!.code} message={props.item.lastError!.message} onRetry={props.onRetry} busy={props.busy} retryLabel="Send now" kept="Your entry is kept on this device." />
        </Show>
      </Show>
      <Show when={props.item.state === "conflict"}>
        <p role="alert" class="error-state"><strong>This entry could not be saved as sent.</strong> {props.item.conflict?.message} (code {props.item.conflict?.code}, HTTP {props.item.conflict?.status}). Choose which version to keep.</p>
        <div class="sync-compare">
          <Show when={serverRows(props.item.conflict?.serverEntry)} fallback={<p class="offline-note">The server did not return its copy. Its message is shown above.</p>}>
            {(rows) => <Summary title="On the server" rows={rows()} />}
          </Show>
          <Summary title="On this device" rows={{ activity: l().activity, note: l().note, expense: l().expense, quantity: l().quantity, photos: l().photos }} />
        </div>
        <div class="sync-actions">
          <button type="button" class="btn secondary" onClick={() => void syncQueue.keepServer(props.item.clientEntryId)}>Keep server version</button>
          <button type="button" class="btn" onClick={() => void syncQueue.resubmitAsNew(props.item.clientEntryId, newClientEntryId()).then(() => flushJournalQueue({ force: true }))}>Save mine as a new entry</button>
        </div>
      </Show>
    </article>
  );
}
