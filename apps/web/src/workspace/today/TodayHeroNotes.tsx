import { createSignal, createUniqueId, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js";
import { Icon } from "../icons";
import { popoverNext, type PopoverEvent } from "./todayMapModel";

/**
 * "About this view" (TODAY_REFINEMENT_SPEC.md 2): the notes that used to sit in strips under the hero scene (the
 * AI-predicted look disclaimer, the 10 m pixel note, the greenness legend, the weather overlay label, the day's conditions
 * line, the satellite curve line and the automatic milestone previews) move behind one small info button in the hero
 * frame's corner. The text is unchanged and always in the DOM (hidden until opened), so the provenance sentence is one tap
 * away and screen readers reach it from the button.
 *
 * Interaction: the button (click, Enter or Space, or a tap) toggles the panel and says so with `aria-expanded`; opening
 * moves focus into the panel; Escape, the close button or a press outside close it, and Escape and the close button
 * return focus to the button. A press inside an open details sheet (opened from a note) does not close it.
 */
export interface HeroNotesController {
  open: Accessor<boolean>;
  send: (event: PopoverEvent, opts?: { focusButton?: boolean }) => void;
  buttonId: string;
  panelId: string;
  titleId: string;
  setButton: (node: HTMLButtonElement) => void;
  setPanel: (node: HTMLDivElement) => void;
}

/** Elements a press may land on without closing the notes: the button, the panel and any sheet opened from a note. */
const KEEP_OPEN = ".today-sheet, .today-sheet-backdrop, [role='dialog']";

export function createHeroNotes(): HeroNotesController {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const id = createUniqueId();
  const send = (event: PopoverEvent, opts: { focusButton?: boolean } = {}) => {
    const was = open();
    const next = popoverNext(was, event);
    setOpen(next);
    if (!was && next) queueMicrotask(() => panel?.focus({ preventScroll: true }));
    if (was && !next && opts.focusButton) button?.focus();
  };
  onMount(() => {
    const press = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target as Element | null;
      if (!target || button?.contains(target) || panel?.contains(target) || target.closest?.(KEEP_OPEN)) return;
      send("outside");
    };
    document.addEventListener("pointerdown", press);
    onCleanup(() => document.removeEventListener("pointerdown", press));
  });
  return {
    open,
    send,
    buttonId: `today-hero-notes-button-${id}`,
    panelId: `today-hero-notes-${id}`,
    titleId: `today-hero-notes-title-${id}`,
    setButton: (node) => (button = node),
    setPanel: (node) => (panel = node),
  };
}

/** The small info button in the hero frame's corner. */
export function HeroNotesButton(props: { notes: HeroNotesController }) {
  return (
    <button
      type="button"
      class="today-hero-info"
      id={props.notes.buttonId}
      ref={props.notes.setButton}
      aria-label="About this view"
      aria-expanded={props.notes.open()}
      aria-controls={props.notes.panelId}
      data-testid="today-hero-info"
      onClick={() => props.notes.send("toggle")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && props.notes.open()) {
          event.preventDefault();
          event.stopPropagation();
          props.notes.send("escape", { focusButton: true });
        }
      }}
    >
      <Icon name="info" size={16} />
    </button>
  );
}

/** The notes panel; rendered after the frame so the notes keep their place after the stage label in reading order. */
export function HeroNotesPanel(props: { notes: HeroNotesController; onAbout?: (() => void) | undefined; children: JSX.Element }) {
  return (
    <div
      class="today-hero-notes"
      id={props.notes.panelId}
      ref={props.notes.setPanel}
      role="group"
      aria-labelledby={props.notes.titleId}
      tabIndex={-1}
      hidden={!props.notes.open()}
      data-testid="today-hero-notes"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.notes.send("escape", { focusButton: true });
        }
      }}
    >
      <div class="today-hero-notes-head">
        <p class="today-hero-notes-title" id={props.notes.titleId}>
          About this view
        </p>
        <button type="button" class="today-hero-notes-close" aria-label="Close notes" onClick={() => props.notes.send("close", { focusButton: true })}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {props.children}
      <Show when={props.onAbout}>
        <button type="button" class="text-button today-hero-notes-more" onClick={() => props.onAbout?.()}>
          Monitoring, limitations and sources <Icon name="arrow" size={13} />
        </button>
      </Show>
    </div>
  );
}
