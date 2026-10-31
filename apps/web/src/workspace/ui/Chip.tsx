import { Show, type JSX } from "solid-js";
import "./ui.css";

/**
 * Status chip. Tones map to UI_BRIEF section 1: crop and data states (growing, due, overdue, done, forecast, typical,
 * illustration, observed) plus the three alert severities (info, watch, warning). `model` marks provider activity and
 * `legume` marks nitrogen-fixing crops. Colours come from theme tokens only.
 */
export type ChipTone =
  | "neutral"
  | "growing"
  | "due"
  | "overdue"
  | "done"
  | "forecast"
  | "typical"
  | "illustration"
  | "observed"
  | "info"
  | "watch"
  | "warning"
  | "model"
  | "legume";

export function Chip(props: {
  tone?: ChipTone;
  /** Shows a small animated dot before the text (for work in progress). */
  pulse?: boolean;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <span
      class={`ui-chip ui-chip-${props.tone ?? "neutral"}${props.class ? ` ${props.class}` : ""}`}
    >
      <Show when={props.pulse}>
        <i class="ui-chip-dot" aria-hidden="true" />
      </Show>
      {props.children}
    </span>
  );
}
