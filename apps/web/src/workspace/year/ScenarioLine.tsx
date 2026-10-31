import { Show } from "solid-js";
import { Chip } from "../ui/Chip";

/**
 * One line that says what the plan covers ("Sep 2026 to Sep 2027 · Paddy growing until mid-Nov"), plus the status
 * chips: Planning (with the resolved model name when the server reports one), out of date with Refresh, and the
 * model-unavailable notice when only code-built plans are shown.
 */
export function ScenarioLine(props: {
  text: string;
  pending: boolean;
  /** Resolved model name from `modelInvocation.model`; null while unknown. */
  model: string | null;
  stale: boolean;
  modelUnavailable: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div class="yp-scenario">
      <p class="yp-scenario-line">{props.text}</p>
      <Show when={props.pending || props.stale || props.modelUnavailable}>
        <div class="yp-scenario-status" role="status" aria-live="polite">
          <Show when={props.pending}>
            <Chip tone="model" pulse>
              Planning…
            </Chip>
            <Show when={props.model}>
              {(model) => <span class="yp-model-activity">Planning with {model()}</span>}
            </Show>
          </Show>
          <Show when={props.modelUnavailable}>
            <Chip tone="watch">Model unavailable, showing calculated plans</Chip>
          </Show>
          <Show when={props.stale && !props.pending}>
            <Chip tone="watch">Out of date</Chip>
            <button type="button" class="yp-link-button" disabled={props.refreshing} onClick={() => props.onRefresh()}>
              {props.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
