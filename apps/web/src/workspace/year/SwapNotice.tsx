import { Show } from "solid-js";

/**
 * The line under the scenario after a saved season's crop was swapped: what changed, then what became of the plan.
 * "Rebuilding the plan…" while the new plan is being built; "The plan has been rebuilt." only when the new review is a
 * plan (see `planRebuilt`); otherwise "The plan could not be rebuilt; see the message below." The wording after a failed
 * reload is left to the error line the view shows (`failed`), so the two never contradict each other.
 */
export function SwapNotice(props: {
  from: string;
  to: string;
  /** The plan is being (re)built: the reload is running or the review is still pending. */
  rebuilding: boolean;
  /** The reloaded review is a plan, or the server's answer that no space is left. */
  rebuilt: boolean;
  /** The reload itself failed; the view's error line explains it. */
  failed: boolean;
  onHide: () => void;
}) {
  return (
    <div class="yp-notice" role="status">
      <p>
        {props.from} swapped for {props.to} in your saved seasons.{" "}
        <Show
          when={props.rebuilding}
          fallback={
            <Show when={!props.failed}>
              {props.rebuilt ? "The plan has been rebuilt." : "The plan could not be rebuilt; see the message below."}
            </Show>
          }
        >
          Rebuilding the plan…
        </Show>
      </p>
      <button type="button" class="yp-link-button" aria-label="Hide this message" onClick={() => props.onHide()}>
        Hide
      </button>
    </div>
  );
}
