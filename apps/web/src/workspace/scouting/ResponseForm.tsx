import { For, Show, createSignal, createUniqueId, onMount } from "solid-js";
import type { AddIssueEvent, FieldIssue, ResponseMethod } from "@harvest/contracts";
import { newEntryId } from "../../features/photo-region/http";
import { ErrorState } from "../../features/offline/ErrorState";
import { addIssueEvent, describeScoutingError, KEPT_ON_DEVICE, type ScoutingErrorInfo } from "./scoutingApi";
import { scoutingStore, type DraftStore } from "./scoutingStore";
import {
  clearScoutingDraft,
  isResponseDraft,
  LABEL_WAIT_HELP,
  loadScoutingDraft,
  METHOD_LABEL,
  METHODS,
  newResponseDraft,
  QUANTITY_UNITS,
  responseEvent,
  responseProblems,
  saveScoutingDraft,
  type QuantityUnit,
  type ResponseDraft,
} from "./scoutingModel";
import { VoiceNote, appendText } from "./VoiceNote";
import "./scouting.css";

export interface ResponseFormProps {
  farmId: string;
  issue: FieldIssue;
  today: string;
  onSaved: (issue: FieldIssue) => void;
  onCancel: () => void;
  store?: DraftStore | undefined;
  send?: ((farmId: string, issueId: string, body: AddIssueEvent) => Promise<FieldIssue>) | undefined;
  initialDraft?: ResponseDraft | undefined;
  showProblems?: boolean | undefined;
}

/**
 * "Record what you did" (FIELD_OPERATIONS_SPEC.md 6): method, what was done in the farmer's words, the product as the
 * farmer calls it (optional), a quantity (optional), the days before harvest the label says to wait (optional, the
 * farmer's own reading, never checked by the app) and a recheck date (default a week later). The app recommends nothing.
 */
export function ResponseForm(props: ResponseFormProps) {
  const uid = createUniqueId();
  const id = (name: string) => `sc-resp-${uid}-${name}`;
  const store = () => props.store ?? scoutingStore();
  const fresh = () => newResponseDraft(props.farmId, props.issue.id, newEntryId("response"), props.today);
  const [draft, setDraft] = createSignal<ResponseDraft>(props.initialDraft ?? fresh());
  const [showProblems, setShowProblems] = createSignal(!!props.showProblems);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<(ScoutingErrorInfo & { kept: string }) | null>(null);
  const [restored, setRestored] = createSignal(false);

  onMount(async () => {
    if (props.initialDraft) return;
    try {
      const saved = await loadScoutingDraft(store(), "response", props.farmId, props.issue.id, isResponseDraft);
      if (saved && saved.issueId === props.issue.id) {
        setDraft({ ...fresh(), ...saved });
        setRestored(true);
      }
    } catch {
      /* start empty */
    }
  });
  const update = (patch: Partial<ResponseDraft>) => {
    const next = { ...draft(), ...patch };
    setDraft(next);
    void saveScoutingDraft(store(), "response", props.issue.id, next).catch(() => undefined);
  };
  const problems = () => responseProblems(draft(), { today: props.today, observedOn: props.issue.observedOn });

  async function submit(event?: Event) {
    event?.preventDefault();
    setShowProblems(true);
    if (problems().length || saving()) return;
    setSaving(true);
    setError(null);
    const sent = draft();
    try {
      const issue = await (props.send ?? addIssueEvent)(props.farmId, props.issue.id, responseEvent(sent));
      await clearScoutingDraft(store(), "response", props.farmId, props.issue.id, sent.clientEntryId).catch(() => undefined);
      props.onSaved(issue);
    } catch (failure) {
      const info = describeScoutingError(failure);
      setError({ ...info, kept: info.kind === "network" ? KEPT_ON_DEVICE : "Your answers are still in the form." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form class="sc-form sc-response" onSubmit={(e) => void submit(e)} noValidate aria-label="Record what you did" data-testid="sc-response-form">
      <Show when={restored()}>
        <p class="sc-note" role="status">
          Restored your unsent answers from this device.
        </p>
      </Show>
      <p class="sc-small">Record what you did, in your own words. The app does not recommend a product, an amount or a timing.</p>

      <label for={id("date")}>Date you did it</label>
      <input id={id("date")} type="date" min={props.issue.observedOn} max={props.today} value={draft().occurredOn} onInput={(e) => update({ occurredOn: e.currentTarget.value })} />

      <label for={id("method")}>How you dealt with it</label>
      <select id={id("method")} value={draft().method} onChange={(e) => update({ method: e.currentTarget.value as ResponseMethod | "" })}>
        <option value="" selected={!draft().method}>
          Choose one
        </option>
        <For each={METHODS}>
          {(m) => (
            <option value={m} selected={draft().method === m}>
              {METHOD_LABEL[m]}
            </option>
          )}
        </For>
      </select>

      <label for={id("what")}>What you did</label>
      <textarea id={id("what")} rows="3" maxlength="1000" value={draft().description} onInput={(e) => update({ description: e.currentTarget.value })} />
      <VoiceNote farmId={props.farmId} onText={(text) => update({ description: appendText(draft().description, text).slice(0, 1000) })} />

      <label for={id("product")}>Product name as you call it (optional)</label>
      <input id={id("product")} type="text" maxlength="120" autocomplete="off" value={draft().productName} onInput={(e) => update({ productName: e.currentTarget.value })} />

      <fieldset class="sc-row">
        <legend>Quantity (optional)</legend>
        <div class="sc-row-fields">
          <label for={id("qty")}>Amount</label>
          <input id={id("qty")} inputmode="decimal" autocomplete="off" value={draft().quantityValue} onInput={(e) => update({ quantityValue: e.currentTarget.value })} />
          <label for={id("unit")}>Unit</label>
          <select id={id("unit")} value={draft().quantityUnit} onChange={(e) => update({ quantityUnit: e.currentTarget.value as QuantityUnit | "" })}>
            <option value="" selected={!draft().quantityUnit}>
              Unit
            </option>
            <For each={QUANTITY_UNITS}>
              {(u) => (
                <option value={u} selected={draft().quantityUnit === u}>
                  {u}
                </option>
              )}
            </For>
          </select>
        </div>
      </fieldset>

      <label for={id("wait")}>Days before harvest the label says to wait (optional)</label>
      <input
        id={id("wait")}
        type="number"
        inputmode="numeric"
        min="0"
        max="365"
        step="1"
        value={draft().labelWaitDays}
        aria-describedby={id("wait-help")}
        onInput={(e) => update({ labelWaitDays: e.currentTarget.value })}
      />
      <p id={id("wait-help")} class="sc-small" data-testid="sc-label-wait-help">
        {LABEL_WAIT_HELP}
      </p>

      <label for={id("recheck")}>Recheck on (optional)</label>
      <input id={id("recheck")} type="date" min={draft().occurredOn} value={draft().recheckOn} aria-describedby={id("recheck-help")} onInput={(e) => update({ recheckOn: e.currentTarget.value })} />
      <p id={id("recheck-help")} class="sc-small">
        A reminder to look again appears in your upcoming steps. Clear the date for none.
      </p>

      <Show when={showProblems() && problems().length}>
        <ul class="sc-problems" role="alert" data-testid="sc-response-problems">
          <For each={problems()}>{(p) => <li>{p}</li>}</For>
        </ul>
      </Show>
      <Show when={error()}>
        {(e) => (
          <ErrorState
            code={e().code}
            message={e().message}
            kept={e().kept}
            busy={saving()}
            retryLabel={e().kind === "conflict" ? "Send as a new entry" : "Try again"}
            onRetry={() => {
              if (e().kind === "conflict") update({ clientEntryId: newEntryId("response") });
              void submit();
            }}
          />
        )}
      </Show>
      <div class="sc-actions">
        <button class="btn" type="submit" disabled={saving()}>
          {saving() ? "Saving…" : "Save what you did"}
        </button>
        <button type="button" class="btn secondary" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
