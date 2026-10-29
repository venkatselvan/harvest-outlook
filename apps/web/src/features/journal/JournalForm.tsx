import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { PhotoUploader } from "../photo-region/PhotoUploader";
import { newEntryId } from "../photo-region/http";
import { normalizedUrl, type MediaInfo } from "../photo-region/types";
import { ApiError } from "../../lib/api";
import { ErrorState } from "../offline/ErrorState";
import { SyncPanel } from "../offline/SyncPanel";
import { flushJournalQueue, onFlushed, syncQueue } from "../../lib/sync/journal";
import { VoiceInput } from "../speech/VoiceInput";
import type { SpeechLang } from "../speech/speechMachine";
import type { JournalEntry } from "./api";
import {
  ACTIVITIES,
  MAX_PHOTOS,
  QUANTITY_UNITS,
  clearDraft,
  draftIssues,
  draftToBody,
  idempotencyKeyFor,
  loadCurrentDraft,
  newDraft,
  saveDraft,
  todayLocal,
  type Activity,
  type Draft,
  type KeyValueStore,
  type QuantityUnit,
} from "./model";

/**
 * Entry form. Every change is written to the device (IndexedDB) at once, keyed by the client entry id, so a reload or a
 * dropped connection loses nothing. The same id is sent on every retry; the server never creates a second entry for it.
 */
export function JournalForm(props: { farmId: string; stages: { stageId: string; name: string }[]; store: KeyValueStore & { persistent?: boolean | undefined }; onSaved: (e: JournalEntry) => void }) {
  const [draft, setDraft] = createSignal<Draft>(newDraft(props.farmId, newEntryId("entry")));
  const [restored, setRestored] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<{ code?: string; message: string } | null>(null);
  const [queued, setQueued] = createSignal<string | null>(null);
  const [showIssues, setShowIssues] = createSignal(false);
  const [addingPhoto, setAddingPhoto] = createSignal(false);
  const [device, setDevice] = createSignal<"idle" | "saved" | "failed">("idle");

  // Entries reach the server through the sync queue (also when it flushes in the background after a reconnect).
  const stop = onFlushed((items) => {
    for (const it of items) {
      if (it.farmId !== props.farmId) continue;
      void syncQueue.acknowledge(it.clientEntryId);
      setQueued(null);
      props.onSaved(it.serverEntry as JournalEntry);
    }
  });
  onCleanup(stop);

  onMount(async () => {
    void flushJournalQueue();
    try {
      const d = await loadCurrentDraft(props.store, props.farmId);
      if (d) {
        setDraft(d);
        setRestored(true);
      }
    } catch {
      /* unreadable draft store: start empty */
    }
  });

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft(), ...patch };
    setDraft(next);
    setDevice("idle");
    saveDraft(props.store, next).then(
      () => setDevice("saved"),
      () => setDevice("failed"),
    );
  };

  const issues = () => draftIssues(draft(), todayLocal());

  const submit = async (ev: Event) => {
    ev.preventDefault();
    setShowIssues(true);
    if (issues().length > 0) return;
    setSaving(true);
    setError(null);
    const sent = draft();
    try {
      // Write to the durable queue first; the queue owns the entry from here (the same clientEntryId and
      // Idempotency-Key are used on every retry, so the server never creates a duplicate).
      await syncQueue.enqueue({ clientEntryId: sent.clientEntryId, farmId: sent.farmId, body: draftToBody(sent), idempotencyKey: idempotencyKeyFor(sent) });
      await clearDraft(props.store, sent).catch(() => undefined);
      setDraft(newDraft(props.farmId, newEntryId("entry")));
      setRestored(false);
      setShowIssues(false);
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      setQueued(online ? null : "Saved on this device. It will be sent when you are back online.");
      if (online) await flushJournalQueue({ force: true });
    } catch (e) {
      setError({ message: "Could not save the entry on this device. Your draft is still in the form.", ...(e instanceof ApiError ? { code: e.code } : {}) });
    } finally {
      setSaving(false);
    }
  };

  const onPhoto = (m: MediaInfo) => {
    setAddingPhoto(false);
    if (!draft().mediaIds.includes(m.id)) update({ mediaIds: [...draft().mediaIds, m.id].slice(0, MAX_PHOTOS) });
  };
  const removePhoto = (id: string) => update({ mediaIds: draft().mediaIds.filter((x) => x !== id) });

  return (
    <>
    <SyncPanel />
    <form class="card jr-form" onSubmit={submit} aria-labelledby="jr-form-title" noValidate>
      <h2 id="jr-form-title">New journal entry</h2>
      <Show when={restored()}>
        <p class="jr-note" role="status">Restored your unsent draft from this device.</p>
      </Show>

      <label for="jr-date">Date you saw this</label>
      <input id="jr-date" type="date" value={draft().observedOn} max={todayLocal()} onInput={(e) => update({ observedOn: e.currentTarget.value })} />

      <label for="jr-activity">What did you do or see?</label>
      <select id="jr-activity" value={draft().activity} onChange={(e) => update({ activity: e.currentTarget.value as Activity | "" })}>
        <For each={ACTIVITIES}>{(a) => <option value={a.value} selected={draft().activity === a.value}>{a.label}</option>}</For>
      </select>

      <div class="jr-photos-edit">
        <p class="jr-label" id="jr-photos-label">Photos ({draft().mediaIds.length} of {MAX_PHOTOS})</p>
        <ul class="jr-thumbs" aria-labelledby="jr-photos-label">
          <For each={draft().mediaIds}>
            {(id, i) => (
              <li>
                <img src={normalizedUrl(id)} alt={`Photo ${i() + 1} for this entry`} width="96" />
                <button type="button" class="btn secondary" onClick={() => removePhoto(id)} aria-label={`Remove photo ${i() + 1}`}>Remove</button>
              </li>
            )}
          </For>
        </ul>
        <Show when={draft().mediaIds.length < MAX_PHOTOS}>
          <Show when={draft().mediaIds.length === 0 || addingPhoto()} fallback={<button type="button" class="btn secondary" onClick={() => setAddingPhoto(true)}>Add another photo</button>}>
            <PhotoUploader farmId={props.farmId} onUploaded={onPhoto} {...(addingPhoto() ? { onCancel: () => setAddingPhoto(false) } : {})} />
          </Show>
        </Show>
      </div>

      <label for="jr-note">Note</label>
      <textarea id="jr-note" rows="3" lang={draft().language} value={draft().note} onInput={(e) => update({ note: e.currentTarget.value })} placeholder="What did you notice? You can type or use your voice." />
      <details class="jr-voice">
        <summary>Add a voice note (optional)</summary>
        <label for="jr-lang">Language</label>
        <select id="jr-lang" value={draft().language} onChange={(e) => update({ language: e.currentTarget.value as SpeechLang })}>
          <option value="en" selected={draft().language === "en"}>English</option>
          <option value="ta" selected={draft().language === "ta"}>Tamil</option>
          <option value="hi" selected={draft().language === "hi"}>Hindi</option>
        </select>
        <VoiceInput language={draft().language} farmId={props.farmId} onConfirmText={(t) => update({ note: draft().note.trim() ? `${draft().note.trimEnd()}\n${t}` : t })} />
      </details>

      <fieldset class="jr-row">
        <legend>Quantity (optional)</legend>
        <label for="jr-qty">Amount</label>
        <input id="jr-qty" inputmode="decimal" value={draft().quantityValue} onInput={(e) => update({ quantityValue: e.currentTarget.value })} />
        <label for="jr-unit">Unit</label>
        <select id="jr-unit" value={draft().quantityUnit} onChange={(e) => update({ quantityUnit: e.currentTarget.value as QuantityUnit })}>
          <For each={QUANTITY_UNITS}>{(u) => <option value={u} selected={draft().quantityUnit === u}>{u}</option>}</For>
        </select>
      </fieldset>

      <fieldset class="jr-row">
        <legend>Expense (optional)</legend>
        <label for="jr-exp">Amount in rupees</label>
        <input id="jr-exp" inputmode="decimal" value={draft().expenseInr} onInput={(e) => update({ expenseInr: e.currentTarget.value })} />
        <label for="jr-exp-cat">What for</label>
        <input id="jr-exp-cat" value={draft().expenseCategory} onInput={(e) => update({ expenseCategory: e.currentTarget.value })} />
      </fieldset>

      <Show when={props.stages.length > 0}>
        <label for="jr-stage">Growth stage you see (optional)</label>
        <select id="jr-stage" value={draft().stageId} onChange={(e) => update({ stageId: e.currentTarget.value })}>
          <option value="" selected={draft().stageId === ""}>Not sure</option>
          <For each={props.stages}>{(s) => <option value={s.stageId} selected={draft().stageId === s.stageId}>{s.name}</option>}</For>
        </select>
        <p class="jr-small">Crop: from your plan. A stage you choose here changes your plan only after you confirm it.</p>
      </Show>

      <Show when={showIssues() && issues().length > 0}>
        <ul role="alert" class="jr-error">
          <For each={issues()}>{(i) => <li>{i.message}</li>}</For>
        </ul>
      </Show>
      <Show when={error()}>
        {(e) => <ErrorState code={e().code} message={e().message} onRetry={() => void submit(new Event("submit"))} busy={saving()} />}
      </Show>
      <Show when={queued()}>
        <p class="jr-note" role="status" data-testid="journal-queued">{queued()}</p>
      </Show>
      <button class="btn" type="submit" disabled={saving()}>{saving() ? "Saving…" : "Save entry"}</button>
      <p class="jr-small" role="status">
        {device() === "saved" ? "Draft saved on this device." : device() === "failed" ? "Could not save a draft on this device." : props.store.persistent === false ? "Drafts are not kept after a reload in this browser." : "Your draft is kept on this device until you save."}
      </p>
    </form>
    </>
  );
}
