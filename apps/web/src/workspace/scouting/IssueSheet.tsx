import { For, Match, Show, Switch, createEffect, createResource, createSignal, createUniqueId, on } from "solid-js";
import type { AddIssueEvent, FieldIssue, IssueStatus } from "@harvest/contracts";
import { newEntryId } from "../../features/photo-region/http";
import { ErrorState } from "../../features/offline/ErrorState";
import { Sheet } from "../ui/Sheet";
import { addIssueEvent, describeScoutingError, loadIssue, type ScoutingErrorInfo } from "./scoutingApi";
import type { DraftStore } from "./scoutingStore";
import {
  CATEGORY_LABEL,
  CATEGORY_MARK,
  day,
  earliestHarvestLine,
  EVENT_LABEL,
  eventLines,
  eventProblems,
  FARMER_REPORTED,
  locationText,
  nextStatuses,
  noteEvent,
  placeName,
  seenBeforeLines,
  SEVERITY_LABEL,
  STATUS_LABEL,
  statusEvent,
  timeline,
} from "./scoutingModel";
import { PhotoMarks } from "./PhotoMarks";
import { ResponseForm } from "./ResponseForm";
import { VoiceNote, appendText } from "./VoiceNote";
import "./scouting.css";

type Send = (farmId: string, issueId: string, body: AddIssueEvent) => Promise<FieldIssue>;
type Action = "status" | "response" | "note" | null;

export interface IssueSheetBodyProps {
  farmId: string;
  issue: FieldIssue;
  today: string;
  fieldName: (fieldId: string) => string | null;
  /** The issue after an event was saved. */
  onIssue: (issue: FieldIssue) => void;
  store?: DraftStore | undefined;
  send?: Send | undefined;
  /** Open one action panel at first (tests). */
  initialAction?: Action | undefined;
}

/**
 * The whole issue (FIELD_OPERATIONS_SPEC.md 5, 6): what was reported, photos with their marks, the location, the events
 * timeline, "Seen before" lines (earlier issues of the same category on the same field; no prediction is made from them),
 * the earliest harvest date after the last application when the farmer entered a label wait (arithmetic only), and the
 * actions: change status, record what you did, add a note. Every action is one journal entry on the server.
 */
export function IssueSheetBody(props: IssueSheetBodyProps) {
  const uid = createUniqueId();
  const id = (name: string) => `sc-sheet-${uid}-${name}`;
  const [action, setAction] = createSignal<Action>(props.initialAction ?? null);
  const [occurredOn, setOccurredOn] = createSignal(props.today);
  const [status, setStatus] = createSignal<IssueStatus | "">("");
  const [note, setNote] = createSignal("");
  const [entryId, setEntryId] = createSignal(newEntryId("event"));
  const [saving, setSaving] = createSignal(false);
  const [showProblems, setShowProblems] = createSignal(false);
  const [error, setError] = createSignal<ScoutingErrorInfo | null>(null);
  const issue = () => props.issue;
  const place = () => placeName(issue().fieldId ?? null, props.fieldName);

  const open = (next: Action) => {
    setAction(action() === next ? null : next);
    setOccurredOn(props.today);
    setStatus("");
    setNote("");
    setEntryId(newEntryId("event"));
    setShowProblems(false);
    setError(null);
  };
  const problems = () =>
    action() === "status" || action() === "note"
      ? eventProblems(action() as "status" | "note", { today: props.today, observedOn: issue().observedOn, occurredOn: occurredOn(), status: status(), current: issue().status, note: note() })
      : [];

  async function submit(event?: Event) {
    event?.preventDefault();
    setShowProblems(true);
    const kind = action();
    if ((kind !== "status" && kind !== "note") || problems().length || saving()) return;
    setSaving(true);
    setError(null);
    const body = kind === "status" ? statusEvent(entryId(), occurredOn(), status() as IssueStatus, note()) : noteEvent(entryId(), occurredOn(), note());
    try {
      const updated = await (props.send ?? addIssueEvent)(props.farmId, issue().id, body);
      setAction(null);
      props.onIssue(updated);
    } catch (failure) {
      setError(describeScoutingError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="sc-issue" data-testid="sc-issue-sheet">
      <div class="sc-issue-head">
        <span class={`sc-cat cat-${issue().category}`}>
          <span class="sc-cat-mark" aria-hidden="true">
            {CATEGORY_MARK[issue().category]}
          </span>
          {CATEGORY_LABEL[issue().category]}
        </span>
        <span class={`sc-chip severity-${issue().severity}`}>Severity: {SEVERITY_LABEL[issue().severity]}</span>
        <span class={`sc-chip status-${issue().status}`}>{STATUS_LABEL[issue().status]}</span>
      </div>
      <p class="sc-meta">
        Seen {day(issue().observedOn)} · {place()}
        {issue().cropName ? ` · ${issue().cropName}` : ""}
      </p>
      <Show when={issue().detail}>
        <p class="sc-detail">{issue().detail}</p>
      </Show>
      <p class="sc-small">{FARMER_REPORTED}</p>

      <Show when={issue().mediaIds.length}>
        <div class="sc-photo-grid" aria-label="Photos">
          <For each={issue().mediaIds}>{(mediaId, i) => <PhotoMarks mediaId={mediaId} marks={issue().photoMarks} photoNumber={i() + 1} />}</For>
        </div>
      </Show>

      <ul class="sc-facts">
        <li data-testid="sc-issue-location">{issue().location ? `Location: ${locationText(issue().location!)}` : "No location recorded."}</li>
        <Show when={issue().recheckOn}>
          <li>Recheck on {day(issue().recheckOn)}</li>
        </Show>
        <Show when={earliestHarvestLine(issue())}>
          {(line) => (
            <li class="sc-label-wait" data-testid="sc-earliest-harvest">
              {line()}
              <span class="sc-small"> Not checked by the app.</span>
            </li>
          )}
        </Show>
        <For each={seenBeforeLines(issue())}>{(line) => <li data-testid="sc-seen-before">{line}</li>}</For>
      </ul>

      <section class="sc-timeline" aria-labelledby={id("events")}>
        <h3 id={id("events")}>What happened</h3>
        <ol data-testid="sc-events">
          <For each={timeline(issue())}>
            {(event) => (
              <li class={`sc-event kind-${event.kind}`}>
                <p class="sc-event-head">
                  <strong>{EVENT_LABEL[event.kind]}</strong> · {day(event.occurredOn)}
                </p>
                <For each={eventLines(event)}>{(line) => <p class="sc-event-line">{line}</p>}</For>
              </li>
            )}
          </For>
        </ol>
      </section>

      <div class="sc-actions sc-issue-actions" role="group" aria-label="Issue actions">
        <button type="button" class="btn compact secondary" aria-expanded={action() === "status"} onClick={() => open("status")}>
          Change status
        </button>
        <button type="button" class="btn compact" aria-expanded={action() === "response"} onClick={() => open("response")}>
          Record what you did
        </button>
        <button type="button" class="btn compact secondary" aria-expanded={action() === "note"} onClick={() => open("note")}>
          Add a note
        </button>
      </div>

      <Switch>
        <Match when={action() === "response"}>
          <ResponseForm
            farmId={props.farmId}
            issue={issue()}
            today={props.today}
            store={props.store}
            send={props.send}
            onCancel={() => setAction(null)}
            onSaved={(updated) => {
              setAction(null);
              props.onIssue(updated);
            }}
          />
        </Match>
        <Match when={action() === "status" || action() === "note"}>
          <form class="sc-form" onSubmit={(e) => void submit(e)} noValidate aria-label={action() === "status" ? "Change status" : "Add a note"} data-testid="sc-event-form">
            <Show when={action() === "status"}>
              <label for={id("status")}>New status</label>
              <select id={id("status")} value={status()} onChange={(e) => setStatus(e.currentTarget.value as IssueStatus | "")}>
                <option value="" selected={!status()}>
                  Choose one
                </option>
                <For each={nextStatuses(issue().status)}>
                  {(s) => (
                    <option value={s} selected={status() === s}>
                      {STATUS_LABEL[s]}
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <label for={id("date")}>Date</label>
            <input id={id("date")} type="date" min={issue().observedOn} max={props.today} value={occurredOn()} onInput={(e) => setOccurredOn(e.currentTarget.value)} />
            <label for={id("note")}>{action() === "status" ? "Note (optional)" : "Note"}</label>
            <textarea id={id("note")} rows="3" maxlength="2000" value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
            <VoiceNote farmId={props.farmId} onText={(text) => setNote(appendText(note(), text).slice(0, 2000))} />
            <Show when={showProblems() && problems().length}>
              <ul class="sc-problems" role="alert">
                <For each={problems()}>{(p) => <li>{p}</li>}</For>
              </ul>
            </Show>
            <Show when={error()}>
              {(e) => (
                <ErrorState
                  code={e().code}
                  message={e().message}
                  {...(e().kind === "network" ? { kept: "Not sent. Your note is still in the form; try again when online." } : {})}
                  busy={saving()}
                  retryLabel={e().kind === "conflict" ? "Send as a new entry" : "Try again"}
                  onRetry={() => {
                    if (e().kind === "conflict") setEntryId(newEntryId("event"));
                    void submit();
                  }}
                />
              )}
            </Show>
            <div class="sc-actions">
              <button class="btn" type="submit" disabled={saving()}>
                {saving() ? "Saving…" : action() === "status" ? "Save status" : "Save note"}
              </button>
              <button type="button" class="btn secondary" onClick={() => setAction(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Match>
      </Switch>
    </div>
  );
}

/**
 * The issue in a sheet, loaded by id (a deep link `?issue=<id>`, a list row or a recheck step). The shared modal handler
 * traps focus and closes it on Escape.
 */
export function IssueSheet(props: {
  farmId: string;
  issueId: string;
  today: string;
  fieldName: (fieldId: string) => string | null;
  onClose: () => void;
  onChanged?: ((issue: FieldIssue) => void) | undefined;
  /** The row the list already holds (shown at once while the full issue loads). */
  initial?: FieldIssue | null | undefined;
  store?: DraftStore | undefined;
}) {
  const [loaded, { refetch }] = createResource(
    () => ({ farmId: props.farmId, issueId: props.issueId }),
    ({ farmId, issueId }) => loadIssue(farmId, issueId),
  );
  const [local, setLocal] = createSignal<FieldIssue | null>(null);
  createEffect(on(() => props.issueId, () => setLocal(null), { defer: true }));
  const issue = () => local() ?? (loaded.state === "ready" ? loaded() : null) ?? (props.initial?.id === props.issueId ? props.initial : null);
  const title = () => issue()?.title ?? "Issue";
  return (
    <Sheet title={title()} subtitle="Farmer-reported issue" closeLabel="Close issue" class="sc-sheet" onClose={props.onClose}>
      <Switch>
        <Match when={issue()}>
          {(current) => (
            <IssueSheetBody
              farmId={props.farmId}
              issue={current()}
              today={props.today}
              fieldName={props.fieldName}
              store={props.store}
              onIssue={(updated) => {
                setLocal(updated);
                props.onChanged?.(updated);
              }}
            />
          )}
        </Match>
        <Match when={loaded.error}>
          <ErrorState
            code={describeScoutingError(loaded.error).code}
            message={describeScoutingError(loaded.error).kind === "not_found" ? "This issue was not found on this farm." : describeScoutingError(loaded.error).message}
            onRetry={() => void refetch()}
          />
        </Match>
        <Match when={true}>
          <p class="sc-small" aria-busy="true">
            Loading the issue…
          </p>
        </Match>
      </Switch>
    </Sheet>
  );
}
