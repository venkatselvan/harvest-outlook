import { Show } from "solid-js";
import { dateToPos, formatDate, markerPercent, type TimelineIndex } from "./model";

export interface DateSliderProps {
  index: TimelineIndex;
  selectedDate: string;
  today: string;
  daysAfterPlanting: number;
  onSelect: (date: string) => void;
  onStep: (days: number) => void;
  onPos: (pos: number) => void;
}

/**
 * The one season slider. Position = index into the prepared timeline (one position per calendar day). Native range
 * semantics give arrow keys; Page Up/Down step a week and Home/End jump to the ends. A date input is the alternative.
 * Every handler is local: none of them performs a request.
 */
export function DateSlider(props: DateSliderProps) {
  const last = () => props.index.days.length - 1;
  const pos = () => dateToPos(props.index, props.selectedDate);
  const planting = () => markerPercent(props.index, props.index.plantingDate);
  const todayPct = () => markerPercent(props.index, props.today);
  const dapText = () => (props.daysAfterPlanting < 0 ? `${-props.daysAfterPlanting} days before planting` : `day ${props.daysAfterPlanting} after planting`);
  return (
    <div class="se-slider" data-testid="date-slider">
      <label for="se-range" class="se-slider__label">
        Season day: <strong data-testid="selected-date-text">{formatDate(props.selectedDate)}</strong>, <span data-testid="selected-dap-text">{dapText()}</span>
      </label>
      <div class="se-slider__track">
        <input
          id="se-range"
          type="range"
          min="0"
          max={String(last())}
          step="1"
          value={pos()}
          aria-valuetext={`${formatDate(props.selectedDate)}, ${dapText()}`}
          onInput={(e) => props.onPos(Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (e.key === "PageUp") { e.preventDefault(); props.onStep(7); }
            else if (e.key === "PageDown") { e.preventDefault(); props.onStep(-7); }
          }}
        />
        <Show when={planting() !== null}>
          <span class="se-marker se-marker--planting" style={{ left: `${planting()}%` }} data-testid="marker-planting" aria-hidden="true">Planting</span>
        </Show>
        <Show when={todayPct() !== null}>
          <span class="se-marker se-marker--today" style={{ left: `${todayPct()}%` }} data-testid="marker-today" aria-hidden="true">Today</span>
        </Show>
      </div>
      <div class="se-slider__row">
        <label for="se-date">Or enter a date</label>
        <input
          id="se-date"
          type="date"
          min={props.index.from}
          max={props.index.to}
          value={props.selectedDate}
          onChange={(e) => e.currentTarget.value && props.onSelect(e.currentTarget.value)}
        />
        <button type="button" class="btn secondary" onClick={() => props.onSelect(props.today)} disabled={props.today < props.index.from || props.today > props.index.to}>Today</button>
        <button type="button" class="btn secondary" onClick={() => props.onSelect(props.index.plantingDate)}>Planting day</button>
      </div>
      <p class="se-help">
        Markers: planting {formatDate(props.index.plantingDate)}; today {formatDate(props.today)} (India time). Page Up and Page Down move a week.
      </p>
    </div>
  );
}
