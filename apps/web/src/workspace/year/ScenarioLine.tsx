import { Show } from "solid-js";
import { Chip } from "../ui/Chip";
import type { SelectionStatus } from "./model";

/**
 * One line that says what the plan covers ("Sep 2026 to Sep 2027 · Paddy growing until mid-Nov"), plus the status
 * chips: Planning (with the resolved model name when the server reports one), out of date with Refresh, and how the
 * plans were chosen when that needs saying (`selection`: "Model unavailable, showing calculated plans" only when the
 * model failed or was missing; "No space for another crop" with a line when saved seasons fill the year). A later
 * horizon adds an action beside the line that opens the year before ("Open year 1").
 */
export function ScenarioLine(props: {
  text: string;
  pending: boolean;
  /** Resolved model name from `modelInvocation.model`; null while unknown. */
  model: string | null;
  stale: boolean;
  /** From `selectionStatus(review)`; null when nothing needs saying. */
  selection: SelectionStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  action?: { label: string; onClick: () => void; disabled?: boolean } | undefined;
}) {
  return (
    <div class="yp-scenario">
      <p class="yp-scenario-line">
        {props.text}
        <Show when={props.action}>
          {(action) => (
            <>
              {" "}
              <button type="button" class="yp-link-button yp-scenario-action" disabled={action().disabled} onClick={() => action().onClick()}>
                {action().label}
              </button>
            </>
          )}
        </Show>
      </p>
      <Show when={props.pending || props.stale || props.selection}>
        <div class="yp-scenario-status" role="status" aria-live="polite">
          <Show when={props.pending}>
            <Chip tone="model" pulse>
              Planning…
            </Chip>
            <Show when={props.model}>
              {(model) => <span class="yp-model-activity">Planning with {model()}</span>}
            </Show>
          </Show>
          <Show when={props.selection}>{(selection) => <Chip tone={selection().tone}>{selection().chip}</Chip>}</Show>
          <Show when={props.stale && !props.pending}>
            <Chip tone="watch">Out of date</Chip>
            <button type="button" class="yp-link-button" disabled={props.refreshing} onClick={() => props.onRefresh()}>
              {props.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </Show>
          <Show when={props.selection?.line}>{(line) => <p class="yp-selection-line">{line()}</p>}</Show>
        </div>
      </Show>
    </div>
  );
}
