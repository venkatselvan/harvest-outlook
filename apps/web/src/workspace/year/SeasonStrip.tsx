import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { Chip, type ChipTone } from "../ui/Chip";
import {
  STRIP_BASIS_LABEL,
  defaultMonthKey,
  monthLabel,
  nextMonthKey,
  stripRangeText,
  stripSummary,
  type StripBasis,
  type StripMonth,
  type StripTarget,
} from "./seasonStripModel";

const BASIS_TONE: Record<StripBasis, ChipTone> = { recorded: "growing", saved: "info", ai_plan: "model", estimate: "typical" };

const ACTION_TEXT: Record<StripTarget["kind"], string> = {
  slot: "Open in the plan",
  occupant: "Open saved season",
  season: "Go to Saved seasons",
};

/**
 * "Your growing season" (SEASON_STRIP_COMPARE_SPEC.md part 1): twelve months from the strip's anchor, a filled bar for a
 * covered month and a hollow one for a month that rests. The months are a radiogroup (arrow keys, Home and End); the chosen
 * month shows one card under the strip with the calendar's own sentence, the data basis and a way into the editor. The
 * strip summarises the calendar below it; it does not replace it. On narrow screens it scrolls inside its card and keeps the
 * chosen month in view.
 */
export function SeasonStrip(props: {
  months: readonly StripMonth[];
  fieldName?: string | null | undefined;
  /** Opens the editor for the month's crop or saved season. Without it the card has no action. */
  onOpen?: ((target: StripTarget) => void) | undefined;
}) {
  let scroller: HTMLDivElement | undefined;
  let group: HTMLDivElement | undefined;
  const [selected, setSelected] = createSignal(defaultMonthKey(props.months));
  // A new set of months (another field or horizon, new data) keeps the chosen month when it is still there.
  createEffect(
    on(
      () => props.months.map((m) => m.key).join("|"),
      () => {
        if (!props.months.some((m) => m.key === selected())) setSelected(defaultMonthKey(props.months));
      },
    ),
  );
  const current = createMemo(() => props.months.find((m) => m.key === selected()) ?? props.months[0]);

  function keepInView(key: string) {
    const cell = group?.querySelector<HTMLElement>(`[data-month="${key}"]`);
    if (!scroller || !cell) return;
    const left = cell.offsetLeft;
    const right = left + cell.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }
  function choose(key: string, focus = false) {
    setSelected(key);
    keepInView(key);
    if (focus) group?.querySelector<HTMLElement>(`[data-month="${key}"]`)?.focus();
  }

  return (
    <section class="ss" aria-labelledby="ss-heading" data-testid="season-strip">
      <header class="ss-head">
        <h3 id="ss-heading" class="ss-title">
          Your growing season
          <Show when={props.fieldName}>{(name) => <span class="ss-title-field"> · {name()}</span>}</Show>
        </h3>
        <span class="ss-range">{stripRangeText(props.months)}</span>
      </header>
      <div class="ss-scroll" ref={scroller}>
        <div
          class="ss-track"
          role="radiogroup"
          aria-label={`Month by month, ${stripRangeText(props.months)}`}
          ref={group}
          onKeyDown={(event) => {
            const next = nextMonthKey(props.months, selected(), event.key);
            if (!next) return;
            event.preventDefault();
            choose(next, true);
          }}
        >
          <For each={props.months}>
            {(m) => (
              <button
                type="button"
                role="radio"
                class="ss-cell"
                classList={{ [`is-${m.kind}`]: true, "is-selected": m.key === selected(), [`is-${m.word === "Harvest" ? "harvest" : "plain"}`]: m.covered }}
                aria-checked={m.key === selected()}
                aria-label={monthLabel(m)}
                tabindex={m.key === selected() ? 0 : -1}
                data-month={m.key}
                data-kind={m.kind}
                onClick={() => choose(m.key)}
              >
                <span class="ss-month" aria-hidden="true">
                  {m.label}
                  <Show when={m.label === "Jan" || m.key === props.months[0]?.key}>
                    <small>{m.year}</small>
                  </Show>
                </span>
                <span class="ss-bar" aria-hidden="true" />
                <span class="ss-word" aria-hidden="true">
                  {m.word}
                </span>
                <span class="ss-crop" aria-hidden="true">
                  {m.crop ?? " "}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={current()}>
        {(m) => (
          <div class="ss-detail" data-testid="season-strip-detail" aria-live="polite">
            <div class="ss-detail-text">
              <span class="ss-detail-month">
                {longMonth(m())}
              </span>
              <strong>{m().text}</strong>
            </div>
            <div class="ss-detail-side">
              <Show when={m().basis}>{(basis) => <Chip tone={BASIS_TONE[basis()]}>{STRIP_BASIS_LABEL[basis()]}</Chip>}</Show>
              <Show when={m().target && props.onOpen}>
                <button
                  type="button"
                  class="btn compact secondary"
                  data-testid="season-strip-open"
                  onClick={() => props.onOpen!(m().target!)}
                >
                  {ACTION_TEXT[m().target!.kind]}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longMonth = (m: Pick<StripMonth, "key" | "year">) => `${MONTH_LONG[Number(m.key.slice(5, 7)) - 1]} ${m.year}`;

/**
 * One compact strip for a row of "Plans by field": the twelve months as small bars, a hollow bar where nothing is recorded or
 * saved. A single image with a spoken summary, since the full strip with its detail card lives in the field's own plan.
 */
export function SeasonStripCompact(props: { months: readonly StripMonth[]; fieldName: string }) {
  const summary = () => stripSummary(props.months);
  return (
    <div class="ss-compact" role="img" aria-label={`${props.fieldName}, next twelve months. ${summary()}`} data-testid="season-strip-compact">
      <For each={props.months}>
        {(m) => (
          <span class="ss-compact-cell" classList={{ [`is-${m.kind}`]: true, [`is-${m.word === "Harvest" ? "harvest" : "plain"}`]: m.covered }} title={`${m.label} ${m.year}: ${m.text}`}>
            <i class="ss-bar" />
            <span class="ss-compact-month">{m.label.slice(0, 1)}</span>
          </span>
        )}
      </For>
    </div>
  );
}
