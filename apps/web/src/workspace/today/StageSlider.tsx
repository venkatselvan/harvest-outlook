import { For, Show } from "solid-js";
import { formatDay, type SliderModel } from "./model";

export interface StageSliderTick {
  id: string;
  name: string;
  date: string;
  /** 0..1 along the slider. */
  fraction: number;
}

export interface StageSliderProps {
  model: SliderModel;
  /** Controlled value: day index 0..model.total. */
  value: number;
  onChange: (index: number) => void;
  /** Date shown and announced for the current value (aria-valuetext). */
  valueDate: string;
  ticks: StageSliderTick[];
  /** Resets the slider to the Today marker. */
  onBackToToday: () => void;
  /** Labels under the two ends, for example "Sown 15 Sep" and "Harvest by 13 Jan". */
  startLabel: string;
  endLabel: string;
}

/**
 * Season slider: one step per day from `slider.from` to `slider.to`. A native range input, so arrows, Home, End and
 * Page keys work everywhere; ticks mark stage boundaries and a marker shows today.
 */
export function StageSlider(props: StageSliderProps) {
  let input: HTMLInputElement | undefined;
  const fraction = (index: number) => (props.model.total ? index / props.model.total : 0);
  const atToday = () => props.value === props.model.todayIndex;
  return (
    <div class="today-slider">
      <div class="today-slider-head">
        <label for="today-season-slider">Move through the season</label>
        <Show when={!atToday()}>
          <button
            type="button"
            class="text-button"
            onClick={() => {
              props.onBackToToday();
              input?.focus();
            }}
          >
            Back to today
          </button>
        </Show>
      </div>
      <div class="today-slider-track">
        <div class="today-slider-rail" aria-hidden="true">
          <span class="today-slider-fill" style={{ width: `${fraction(props.value) * 100}%` }} />
          <For each={props.ticks}>
            {(tick) => <span class="today-slider-tick" style={{ left: `${tick.fraction * 100}%` }} title={`${tick.name} from ${formatDay(tick.date)}`} />}
          </For>
          <span class="today-slider-today" style={{ left: `${fraction(props.model.todayIndex) * 100}%` }}>
            <span>Today</span>
          </span>
        </div>
        <input
          ref={input}
          id="today-season-slider"
          type="range"
          min="0"
          max={props.model.total}
          step="1"
          value={props.value}
          aria-valuetext={formatDay(props.valueDate)}
          onInput={(event) => props.onChange(Number(event.currentTarget.value))}
        />
      </div>
      <div class="today-slider-ends" aria-hidden="true">
        <span>{props.startLabel}</span>
        <span>{props.endLabel}</span>
      </div>
    </div>
  );
}
