import { Show, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./ui.css";

/**
 * Bottom sheet (mobile) / side panel (wide screens), rendered in a portal on <body>.
 *
 * Focus handling is the app-wide trap from `workspace/modalFocus.ts`, which the shell installs once
 * (`Shell.tsx` -> `installModalFocus()`). It activates for the newest `[role="dialog"][aria-modal="true"]`, focuses the
 * first control, keeps Tab and Shift+Tab inside, closes on Escape by clicking a button whose aria-label starts with
 * "Close", and restores focus to the trigger when the dialog leaves the DOM. This component conforms to that contract
 * instead of installing a second trap (two traps would both handle Escape).
 */
export function Sheet(props: {
  title: string;
  /** Optional line under the title. */
  subtitle?: JSX.Element;
  /** Accessible name of the close button; must start with "Close" for the shared trap. */
  closeLabel?: string;
  onClose: () => void;
  footer?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  const titleId = createUniqueId();
  let panel: HTMLElement | undefined;
  onMount(() => {
    // Keep the page behind the sheet from scrolling on touch devices; restored on close.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previous;
    });
    // Fallback when the shared trap is not installed (isolated rendering): move focus into the sheet.
    queueMicrotask(() => {
      if (panel && !panel.contains(document.activeElement))
        panel.querySelector<HTMLElement>("button, [href], input, select, textarea")?.focus();
    });
  });
  return (
    <Portal>
      <div
        class="ui-sheet-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <section
          ref={panel}
          class={`ui-sheet${props.class ? ` ${props.class}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div class="ui-sheet-handle" aria-hidden="true" />
          <header class="ui-sheet-head">
            <div class="ui-sheet-titles">
              <h2 id={titleId}>{props.title}</h2>
              <Show when={props.subtitle}>
                <div class="ui-sheet-subtitle">{props.subtitle}</div>
              </Show>
            </div>
            <button
              type="button"
              class="ui-sheet-close"
              aria-label={props.closeLabel ?? `Close ${props.title}`}
              onClick={() => props.onClose()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6 6 18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>
          <div class="ui-sheet-body">{props.children}</div>
          <Show when={props.footer}>
            <footer class="ui-sheet-foot">{props.footer}</footer>
          </Show>
        </section>
      </div>
    </Portal>
  );
}
