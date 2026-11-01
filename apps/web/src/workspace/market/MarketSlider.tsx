import { Show } from "solid-js";
import type { MarketTimelinePoint } from "@harvest/contracts";
import { formatMonth, stepForKey, weekLabel } from "./model";

export const MARKET_SLIDER_LABEL = "Move through the weeks";

/**
 * Week slider under the chart: one step per ISO week across the whole timeline, opening at today. Arrow keys move one
 * week, Page keys four, Home and End the ends; the value is announced as the week label. "Back to today" returns the
 * thumb to the current week and keeps focus on the slider.
 */
export function MarketSlider(props: {
  points: MarketTimelinePoint[];
  index: number;
  todayIndex: number;
  onChange: (index: number) => void;
}) {
  let input: HTMLInputElement | undefined;
  const last = () => Math.max(0, props.points.length - 1);
  const fraction = (i: number) => (last() ? (i / last()) * 100 : 0);
  const point = () => props.points[props.index];
  return (
    <div class="market-slider">
      <div class="market-slider-head">
        <label for="market-week-slider">{MARKET_SLIDER_LABEL}</label>
        <Show when={props.index !== props.todayIndex}>
          <button
            type="button"
            class="text-button market-back"
            onClick={() => {
              props.onChange(props.todayIndex);
              input?.focus();
            }}
          >
            Back to today
          </button>
        </Show>
      </div>
      <div class="market-slider-track">
        <div class="market-slider-rail" aria-hidden="true">
          <span class="market-slider-today" style={{ left: `${fraction(props.todayIndex)}%` }} />
        </div>
        <input
          ref={input}
          id="market-week-slider"
          type="range"
          min="0"
          max={last()}
          step="1"
          value={props.index}
          aria-valuetext={point() ? weekLabel(point()!) : ""}
          onInput={(event) => props.onChange(Number(event.currentTarget.value))}
          onKeyDown={(event) => {
            const next = stepForKey(event.key, props.index, last());
            if (next === null) return;
            event.preventDefault();
            if (next !== props.index) props.onChange(next);
          }}
        />
      </div>
      <div class="market-slider-ends" aria-hidden="true">
        <span>{props.points[0] ? formatMonth(props.points[0].weekStart) : ""}</span>
        <span class="market-slider-week" data-testid="market-week">
          {point() ? weekLabel(point()!) : ""}
        </span>
        <span>{props.points.at(-1) ? formatMonth(props.points.at(-1)!.weekEnd) : ""}</span>
      </div>
    </div>
  );
}
