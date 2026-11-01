import { Show } from "solid-js";
import { addYearsIso, monthYear } from "./format";
import type { HorizonNavigation } from "./model";

/**
 * Horizon pager above the calendar (round 3): "‹ Oct 2026 to Oct 2027 ›" with "Year 1 of 4" under the span. Each
 * button steps one 12-month horizon; a button is disabled when there is no horizon in that direction or while an answer
 * is on its way. The view hides the pager entirely when the server sends no `navigation`.
 */
export function HorizonPager(props: {
  navigation: HorizonNavigation;
  /** End of the shown horizon (the review's own `horizon.to` when it matches, else a year after `from`). */
  to: string;
  busy: boolean;
  onStep: (direction: "previous" | "next") => void;
}) {
  const nav = () => props.navigation;
  const span = () => `${monthYear(nav().from)} to ${monthYear(props.to)}`;
  const previousSpan = () =>
    nav().previousFrom ? `${monthYear(nav().previousFrom!)} to ${monthYear(nav().from)}` : "";
  const nextSpan = () =>
    nav().nextFrom ? `${monthYear(nav().nextFrom!)} to ${monthYear(addYearsIso(nav().nextFrom!, 1))}` : "";
  return (
    <nav class="yp-pager" aria-label="Plan year" aria-busy={props.busy}>
      <button
        type="button"
        class="yp-pager-button"
        disabled={props.busy || !nav().previousFrom}
        aria-label={nav().previousFrom ? `Previous year, ${previousSpan()}` : "Previous year (none)"}
        onClick={() => props.onStep("previous")}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <p class="yp-pager-span" role="status">
        <strong>{span()}</strong>
        <small>
          Year {nav().yearIndex + 1} of {nav().maxYearIndex + 1}
        </small>
        <Show when={props.busy}>
          <small class="yp-pager-busy">Loading…</small>
        </Show>
      </p>
      <button
        type="button"
        class="yp-pager-button"
        disabled={props.busy || !nav().nextFrom}
        aria-label={nav().nextFrom ? `Next year, ${nextSpan()}` : "Next year (none)"}
        onClick={() => props.onStep("next")}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  );
}
