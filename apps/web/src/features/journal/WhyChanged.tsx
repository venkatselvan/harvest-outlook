import { For, Show } from "solid-js";
import { changeLines, economicLines, type ChangeSummaryLike } from "./model";

/** Old to new, changed tasks and economic delta, all taken from the plan engine's own change summary. */
export function WhyChanged(props: { changes: ChangeSummaryLike["changes"]; summary: ChangeSummaryLike | null; stageNames: Record<string, string>; heading?: string | null }) {
  const lines = () => (props.summary ? changeLines(props.changes, props.summary.oldAssumptions.confirmedInputs, props.summary.newAssumptions.confirmedInputs, props.stageNames) : changeLines(props.changes, [], [], props.stageNames));
  const tasks = () => (props.summary ? [...props.summary.changedTaskIds, ...props.summary.addedTaskIds] : []);
  return (
    <div class="jr-why" data-testid="why-changed">
      <Show when={props.heading !== null}>
        <h4>{props.heading ?? "Why this changed"}</h4>
      </Show>
      <ul class="jr-lines">
        <For each={lines()}>
          {(l) => (
            <li>
              <strong>{l.label}:</strong> {l.from} <span aria-hidden="true">→</span>
              <span class="jr-sr"> changed to </span> {l.to}
            </li>
          )}
        </For>
      </ul>
      <Show when={props.summary}>
        {(s) => (
          <>
            <p>
              <strong>Tasks that move:</strong> {tasks().length === 0 ? "none" : `${tasks().length} (${tasks().join(", ")})`}
              {s().removedTaskIds.length > 0 ? `. Removed: ${s().removedTaskIds.join(", ")}` : ""}
            </p>
            <Show when={economicLines(s()).length > 0} fallback={<p>Money effect: not available (no price outlook is connected for this plan).</p>}>
              <ul class="jr-lines">
                <For each={economicLines(s())}>{(t) => <li>{t}</li>}</For>
              </ul>
            </Show>
            <p class="jr-small">Scenario figures, not a promise of income. The earlier plan version stays saved.</p>
          </>
        )}
      </Show>
    </div>
  );
}
