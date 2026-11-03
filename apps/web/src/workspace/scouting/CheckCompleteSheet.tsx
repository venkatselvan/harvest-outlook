import { For, Show, createSignal, createUniqueId, onMount } from "solid-js";
import type { CompleteCheck, FieldIssue, UpcomingStep } from "@harvest/contracts";
import { newEntryId } from "../../features/photo-region/http";
import type { Boundary } from "../state";
import { Sheet } from "../ui/Sheet";
import { windowLabel } from "../today/model";
import { scoutingStore, type DraftStore } from "./scoutingStore";
import {
  checkBody,
  checkProblems,
  isCheckDraft,
  loadScoutingDraft,
  MAX_CHECK_ISSUES,
  newCheckDraft,
  saveScoutingDraft,
  type CheckDraft,
} from "./scoutingModel";
import { IssueForm, type FieldOption } from "./IssueForm";
import { VoiceNote, appendText } from "./VoiceNote";
import "./scouting.css";

export interface CheckCompleteProps {
  farmId: string;
  /** A `field_check` step with its check. */
  step: UpcomingStep;
  today: string;
  fields: readonly FieldOption[];
  farmBoundary?: Boundary | null | undefined;
  /** Sends the completion (the caller marks the step done at once and rolls back on failure). */
  onSubmit: (body: CompleteCheck) => void;
  onClose: () => void;
  /** An issue was logged from this check (the caller refreshes its lists). */
  onIssueCreated?: ((issue: FieldIssue) => void) | undefined;
  store?: DraftStore | undefined;
  initialDraft?: CheckDraft | undefined;
  showProblems?: boolean | undefined;
}

/** The draft slot of a check on its farm (the check id is deterministic, so a reload finds the same draft). */
export const checkSlot = (checkId: string) => checkId;

/**
 * "Done" on a field check (FIELD_OPERATIONS_SPEC.md 4.5): the date (today by default, never in the future), what was found,
 * an optional note (typed or by voice), and with "Issues found" any number of issues logged right here (each one is saved
 * at once; their ids go with the completion). The form is a device draft keyed by its client entry id.
 */
export function CheckCompleteForm(props: CheckCompleteProps) {
  const uid = createUniqueId();
  const id = (name: string) => `sc-check-${uid}-${name}`;
  const store = () => props.store ?? scoutingStore();
  const checkId = () => props.step.fieldCheck?.id ?? props.step.id;
  const fresh = () => newCheckDraft(props.farmId, checkId(), newEntryId("check"), props.today);
  const [draft, setDraft] = createSignal<CheckDraft>(props.initialDraft ?? fresh());
  const [restored, setRestored] = createSignal(false);
  const [showProblems, setShowProblems] = createSignal(!!props.showProblems);
  const [logging, setLogging] = createSignal(false);

  onMount(async () => {
    if (props.initialDraft) return;
    try {
      const saved = await loadScoutingDraft(store(), "check", props.farmId, checkSlot(checkId()), isCheckDraft);
      if (saved && saved.checkId === checkId()) {
        setDraft({ ...fresh(), ...saved, issueTitles: saved.issueTitles ?? {} });
        setRestored(true);
      }
    } catch {
      /* unreadable draft store: start empty */
    }
  });
  const update = (patch: Partial<CheckDraft>) => {
    const next = { ...draft(), ...patch };
    setDraft(next);
    void saveScoutingDraft(store(), "check", checkSlot(checkId()), next).catch(() => undefined);
  };
  const problems = () => checkProblems(draft(), props.today);
  const submit = (event: Event) => {
    event.preventDefault();
    setShowProblems(true);
    if (problems().length) return;
    props.onSubmit(checkBody(draft()));
  };
  const created = (issue: FieldIssue) => {
    setLogging(false);
    const d = draft();
    update({ result: "issues_found", issueIds: [...d.issueIds, issue.id], issueTitles: { ...d.issueTitles, [issue.id]: issue.title } });
    props.onIssueCreated?.(issue);
  };
  const isRecheck = () => props.step.fieldCheck?.kind === "recheck";

  return (
    <div class="sc-check-sheet" data-testid="sc-check-form">
      <p class="sc-small">
        {windowLabel(props.step.dueFrom, props.step.dueTo)}
        {isRecheck() ? " · a recheck you set" : " · your own check interval"}
      </p>
      <Show when={restored()}>
        <p class="sc-note" role="status">
          Restored your unsent check from this device.
        </p>
      </Show>
      <form class="sc-form" onSubmit={submit} noValidate aria-label="Record the field check">
        <label for={id("date")}>Date you walked the field</label>
        <input id={id("date")} type="date" max={props.today} value={draft().completedOn} onInput={(e) => update({ completedOn: e.currentTarget.value })} />

        <fieldset class="sc-radios">
          <legend>What did you find?</legend>
          <label class="sc-radio">
            <input type="radio" name={id("result")} value="nothing_found" checked={draft().result === "nothing_found"} onChange={() => update({ result: "nothing_found" })} />
            Nothing found
          </label>
          <label class="sc-radio">
            <input type="radio" name={id("result")} value="issues_found" checked={draft().result === "issues_found"} onChange={() => update({ result: "issues_found" })} />
            Issues found
          </label>
        </fieldset>

        <Show when={draft().result === "issues_found" || draft().issueIds.length}>
          <section class="sc-check-issues" aria-labelledby={id("issues-title")}>
            <h3 id={id("issues-title")}>Issues from this walk</h3>
            <Show when={draft().issueIds.length} fallback={<p class="sc-small">Log each issue you saw. You can also save the check without listing them.</p>}>
              <ul class="sc-check-issue-list" data-testid="sc-check-issues">
                <For each={draft().issueIds}>
                  {(issueId) => (
                    <li>
                      <span>{draft().issueTitles[issueId] ?? "Logged issue"}</span>
                      <button
                        type="button"
                        class="text-button"
                        aria-label={`Remove ${draft().issueTitles[issueId] ?? "this issue"} from this check`}
                        onClick={() => update({ issueIds: draft().issueIds.filter((x) => x !== issueId) })}
                      >
                        Remove from this check
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <p class="sc-small">Removing an issue from this check keeps it in your issue log.</p>
            </Show>
            <Show when={!logging() && draft().issueIds.length < MAX_CHECK_ISSUES}>
              <button type="button" class="btn compact secondary" onClick={() => setLogging(true)}>
                {draft().issueIds.length ? "Log another issue" : "Log an issue"}
              </button>
            </Show>
          </section>
        </Show>

        <label for={id("note")}>Note (optional)</label>
        <textarea id={id("note")} rows="3" maxlength="2000" value={draft().note} onInput={(e) => update({ note: e.currentTarget.value })} />
        <VoiceNote farmId={props.farmId} onText={(text) => update({ note: appendText(draft().note, text).slice(0, 2000) })} />

        <Show when={showProblems() && problems().length}>
          <ul class="sc-problems" role="alert" data-testid="sc-check-problems">
            <For each={problems()}>{(p) => <li>{p}</li>}</For>
          </ul>
        </Show>
        <div class="sc-actions">
          <button class="btn" type="submit" disabled={logging()}>
            Save check
          </button>
          <button type="button" class="btn secondary" onClick={() => props.onClose()}>
            Cancel
          </button>
        </div>
        <p class="sc-small">Your answers are kept on this device until the check is saved.</p>
      </form>
      {/* Outside the check's form: a form cannot nest inside another. */}
      <Show when={logging()}>
        <section class="sc-inline-issue" aria-label="Log an issue from this walk">
          <h3>Log an issue</h3>
          <IssueForm
            farmId={props.farmId}
            fields={props.fields}
            farmBoundary={props.farmBoundary}
            defaultFieldId={props.step.fieldCheck?.fieldId ?? null}
            today={props.today}
            slot={`check:${checkId()}`}
            store={props.store}
            onCreated={created}
            onCancel={() => setLogging(false)}
          />
        </section>
      </Show>
    </div>
  );
}

/** The completion form in a sheet (focus trap and Escape from the shared modal handler). */
export function CheckCompleteSheet(props: CheckCompleteProps) {
  return (
    <Sheet title={props.step.title} subtitle="Record your field check" closeLabel="Close field check" class="sc-sheet" onClose={props.onClose}>
      <CheckCompleteForm {...props} />
    </Sheet>
  );
}
