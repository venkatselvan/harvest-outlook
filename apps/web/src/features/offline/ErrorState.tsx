import { Show } from "solid-js";

/**
 * Reusable failure pattern: keeps the user's content on screen (render it next to this, never instead of it), shows the
 * error code and message, and offers a retry. Screens that adopt it should keep their form state in place.
 */
export function ErrorState(props: { code?: string | undefined; message: string; onRetry?: (() => void) | undefined; retryLabel?: string; busy?: boolean; kept?: string }) {
  return (
    <div class="error-state" role="alert" data-testid="error-state">
      <p class="error-state-message">{props.message}</p>
      <Show when={props.kept}>
        <p class="error-state-kept">{props.kept}</p>
      </Show>
      <Show when={props.code}>
        <p class="error-state-code">Error code: <code>{props.code}</code></p>
      </Show>
      <Show when={props.onRetry}>
        <button type="button" class="btn secondary" onClick={() => props.onRetry!()} disabled={props.busy}>{props.busy ? "Trying…" : (props.retryLabel ?? "Try again")}</button>
      </Show>
    </div>
  );
}
