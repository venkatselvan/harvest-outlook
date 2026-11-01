import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { Chip } from "./Chip";
import { Sheet } from "./Sheet";
import {
  AI_PRIVACY_NOTE,
  AI_PROVIDER_NOTE,
  AI_USES,
  AI_USE_KEYS,
  type AiUse,
  type AiUseKey,
} from "./ai-uses";
import "./ui.css";

/**
 * The "AI spark": a small four-point sparkle that marks every place a model is used. Clicking it opens a sheet that says,
 * in a few lines, which AI is used, where, what code does instead and why it helps. The copy lives in `ai-uses.ts`;
 * a use whose status is "planned" is always shown with a "Planned" chip so the UI never claims it is running.
 */

/** Four-point sparkle plus a small companion star, drawn in currentColor. */
export function AiSparkIcon(props: { size?: number | undefined; class?: string | undefined }) {
  return (
    <svg
      class={`ai-spark-icon${props.class ? ` ${props.class}` : ""}`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M10 5Q10.9 13.1 19 14Q10.9 14.9 10 23Q9.1 14.9 1 14Q9.1 13.1 10 5Z" />
      <path d="M19.5 1.5Q20 5 23.5 5.5Q20 6 19.5 9.5Q19 6 15.5 5.5Q19 5 19.5 1.5Z" />
    </svg>
  );
}

function StatusChip(props: { status: AiUse["status"] }) {
  return (
    <Chip tone={props.status === "live" ? "done" : "typical"}>
      {props.status === "live" ? "Live" : "Planned"}
    </Chip>
  );
}

/** The three labelled blocks for one use, plus a status chip. */
export function AiUseBody(props: { use: AiUse }) {
  return (
    // Focusable so keyboard users can scroll the sheet body when the text is taller than the screen.
    <div class="ai-detail" tabindex="0" role="group" aria-label={`${props.use.title}: what the AI and the code do`}>
      <div class="ai-detail-status">
        <StatusChip status={props.use.status} />
        <Show when={props.use.status === "planned"}>
          <span>Not running in the app yet.</span>
        </Show>
      </div>
      <section class="ai-block">
        <h3>What the AI does</h3>
        <p>{props.use.does}</p>
      </section>
      <section class="ai-block">
        <h3>What the code does</h3>
        <p>{props.use.code}</p>
      </section>
      <section class="ai-block">
        <h3>Why it helps</h3>
        <p>{props.use.benefit}</p>
      </section>
    </div>
  );
}

/** Every registry entry as a compact row. */
export function AiUsesList() {
  return (
    <ul class="ai-list" aria-label="All AI uses in Harvest Outlook" tabindex="0">
      <For each={AI_USE_KEYS}>
        {(key) => {
          const use = AI_USES[key];
          return (
            <li class="ai-row" data-ai-use={use.key}>
              <AiSparkIcon size={16} class="ai-row-icon" />
              <div class="ai-row-main">
                <div class="ai-row-title">
                  <strong>{use.title}</strong>
                  <StatusChip status={use.status} />
                </div>
                <div class="ai-row-meta">
                  {use.model} · {use.where}
                </div>
                <div class="ai-row-line">{use.benefit}</div>
              </div>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

function AiNotes(props: { provider?: boolean }) {
  return (
    <div class="ai-notes">
      <Show when={props.provider}>
        <p>{AI_PROVIDER_NOTE}</p>
      </Show>
      <p>{AI_PRIVACY_NOTE}</p>
    </div>
  );
}

const ALL_TITLE = "AI in this app";
const ALL_SUBTITLE = "Where models are used, and what code does instead.";

function AllUsesIntro() {
  return (
    <p class="ai-intro">
      Models read, search and explain. Code does the arithmetic, scoring and checks.
    </p>
  );
}

/** The full list of AI uses, as a sheet. */
export function AiUsesSheet(props: { onClose: () => void }) {
  return (
    <Sheet
      title={ALL_TITLE}
      subtitle={ALL_SUBTITLE}
      onClose={props.onClose}
      class="ai-sheet"
      footer={<AiNotes provider />}
    >
      <AllUsesIntro />
      <AiUsesList />
    </Sheet>
  );
}

/** One use's explanation, switchable to the full list. Rendered by `AiSpark` when its button is clicked. */
function AiSparkSheet(props: { use: AiUseKey; onClose: () => void }) {
  const use = () => AI_USES[props.use];
  const [view, setView] = createSignal<"detail" | "all">("detail");
  let showAllButton: HTMLButtonElement | undefined;
  let backButton: HTMLButtonElement | undefined;
  // The focused button is removed when the view switches, so move focus to the new view's first control.
  const show = (next: "detail" | "all") => {
    setView(next);
    queueMicrotask(() => (next === "all" ? backButton : showAllButton)?.focus());
  };
  const footer = createMemo(() => (
    <Switch>
      <Match when={view() === "detail"}>
        <div class="ai-foot">
          <AiNotes />
          <button
            type="button"
            class="text-button"
            ref={(el) => (showAllButton = el)}
            onClick={() => show("all")}
          >
            See all AI uses
          </button>
        </div>
      </Match>
      <Match when={view() === "all"}>
        <div class="ai-foot">
          <AiNotes provider />
        </div>
      </Match>
    </Switch>
  ));
  return (
    <Sheet
      title={view() === "all" ? ALL_TITLE : use().title}
      subtitle={view() === "all" ? ALL_SUBTITLE : `${use().model} · ${use().where}`}
      onClose={props.onClose}
      class="ai-sheet"
      footer={footer()}
    >
      <Switch>
        <Match when={view() === "detail"}>
          <AiUseBody use={use()} />
        </Match>
        <Match when={view() === "all"}>
          <button
            type="button"
            class="text-button ai-back"
            ref={(el) => (backButton = el)}
            onClick={() => show("detail")}
          >
            Back to {use().title}
          </button>
          <AllUsesIntro />
          <AiUsesList />
        </Match>
      </Switch>
    </Sheet>
  );
}

/**
 * Small sparkle button for a place where a model is used. Pass `label` for a pill with visible text ("Picked by AI").
 * Clicks and keys inside the sheet are stopped here, so a spark inside a clickable card never triggers the card.
 */
export function AiSpark(props: {
  use: AiUseKey;
  size?: number | undefined;
  label?: string | undefined;
  class?: string | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  const use = () => AI_USES[props.use];
  const size = () => props.size ?? 16;
  return (
    <span class="ai-spark-host" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        class={`ai-spark${props.label ? " ai-spark-labelled" : ""}${props.class ? ` ${props.class}` : ""}`}
        style={{ "--ai-size": `${size()}px` }}
        aria-label={
          props.label ? `${props.label} (AI used: ${use().title})` : `AI used: ${use().title}`
        }
        title={`AI used: ${use().title}. Select to see what the AI does here.`}
        aria-haspopup="dialog"
        onClick={(event) => {
          // Stay inert inside labels, summaries and links.
          event.preventDefault();
          setOpen(true);
        }}
      >
        <AiSparkIcon size={size()} />
        <Show when={props.label}>
          <span class="ai-spark-label">{props.label}</span>
        </Show>
      </button>
      <Show when={open()}>
        <AiSparkSheet use={props.use} onClose={() => setOpen(false)} />
      </Show>
    </span>
  );
}

/** Sparkle followed by short label text, for section headers such as "Picked by AI". */
export function AiSparkInline(props: {
  use: AiUseKey;
  label?: string | undefined;
  size?: number | undefined;
  class?: string | undefined;
}) {
  return <AiSpark use={props.use} size={props.size} class={props.class} label={props.label ?? "AI"} />;
}

/** Header entry point: opens the full list of AI uses. */
export function AiUsesButton() {
  const [open, setOpen] = createSignal(false);
  return (
    <span class="ai-spark-host">
      <button
        type="button"
        class="ai-header-button"
        aria-label="AI in this app"
        title="AI in this app"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <AiSparkIcon size={18} />
      </button>
      <Show when={open()}>
        <AiUsesSheet onClose={() => setOpen(false)} />
      </Show>
    </span>
  );
}
