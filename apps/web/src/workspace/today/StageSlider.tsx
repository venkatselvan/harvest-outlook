import { For, Show } from "solid-js";
import { formatDay, type SceneMark, type SliderModel } from "./model";

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
  /** Observed scene dates, illustration dates and AI-predicted look dates, drawn as small marks on the rail. */
  marks?: SceneMark[] | undefined;
  /** Play state: when `onPlay` is given a Play / Pause button sits beside "Back to today". */
  playing?: boolean | undefined;
  onPlay?: (() => void) | undefined;
  /** Any direct slider interaction (pointer, key, input); the parent pauses play. */
  onInteract?: (() => void) | undefined;
}

/**
 * Season slider: one step per day from `slider.from` to `slider.to`. A native range input, so arrows, Home, End and
 * Page keys work everywhere; ticks mark stage boundaries, small marks show the dates with a satellite image (dots), a
 * stage illustration (dashed rings) or an AI-predicted look (hollow rings), and a marker shows today. Play steps one day at a time; any slider interaction pauses it.
 */
export function StageSlider(props: StageSliderProps) {
  let input: HTMLInputElement | undefined;
  const fraction = (index: number) => (props.model.total ? index / props.model.total : 0);
  const atToday = () => props.value === props.model.todayIndex;
  const observedMarks = () => (props.marks ?? []).filter((mark) => mark.kind === "observed").length;
  const predictedMarks = () => (props.marks ?? []).filter((mark) => mark.kind === "predicted").length;
  const markTitle = (mark: SceneMark) =>
    `${mark.kind === "observed" ? "Satellite image" : mark.kind === "predicted" ? "AI-predicted look" : "Stage illustration"} ${formatDay(mark.date)}`;
  return (
    <div class="today-slider">
      <div class="today-slider-head">
        <label for="today-season-slider">Move through the season</label>
        <span class="today-slider-actions">
          <Show when={!atToday()}>
            <button
              type="button"
              class="text-button"
              onClick={() => {
                props.onInteract?.();
                props.onBackToToday();
                input?.focus();
              }}
            >
              Back to today
            </button>
          </Show>
          <Show when={props.onPlay}>
            <button
              type="button"
              class="today-play"
              classList={{ "is-playing": !!props.playing }}
              aria-pressed={!!props.playing}
              data-testid="today-play"
              onClick={() => props.onPlay?.()}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <Show when={props.playing} fallback={<path d="M3 1.5v9l7.5-4.5Z" fill="currentColor" />}>
                  <path d="M2.5 1.5h2.5v9H2.5Zm4.5 0h2.5v9H7Z" fill="currentColor" />
                </Show>
              </svg>
              <span>{props.playing ? "Pause" : "Play"}</span>
            </button>
          </Show>
        </span>
      </div>
      <div class="today-slider-track">
        <div class="today-slider-rail" aria-hidden="true">
          <span class="today-slider-fill" style={{ width: `${fraction(props.value) * 100}%` }} />
          <For each={props.ticks}>
            {(tick) => <span class="today-slider-tick" style={{ left: `${tick.fraction * 100}%` }} title={`${tick.name} from ${formatDay(tick.date)}`} />}
          </For>
          <For each={props.marks ?? []}>
            {(mark) => (
              <span
                class={`today-slider-mark ${mark.kind}`}
                style={{ left: `${mark.fraction * 100}%` }}
                data-date={mark.date}
                title={markTitle(mark)}
                data-scene-kind={mark.kind}
              />
            )}
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
          aria-describedby={observedMarks() || predictedMarks() ? "today-slider-marks-note" : undefined}
          onPointerDown={() => props.onInteract?.()}
          onKeyDown={() => props.onInteract?.()}
          onInput={(event) => {
            props.onInteract?.();
            props.onChange(Number(event.currentTarget.value));
          }}
        />
      </div>
      <Show when={observedMarks() || predictedMarks()}>
        <span id="today-slider-marks-note" class="today-sr">
          <Show when={observedMarks()}>Dots on the slider mark the {observedMarks()} dates with a satellite image.</Show>
          <Show when={predictedMarks()}>
            {" "}
            Hollow rings mark {predictedMarks()} {predictedMarks() === 1 ? "date" : "dates"} with an AI-predicted look, not an observation.
          </Show>
        </span>
      </Show>
      <div class="today-slider-milestones" role="group" aria-label="Approximate crop milestones">
        <For each={props.ticks}>{tick => <button type="button" class="today-milestone" aria-pressed={props.valueDate === tick.date}
          title={`${tick.name} · ${formatDay(tick.date)} · approximate calendar date`}
          onClick={() => { props.onInteract?.(); props.onChange(Math.round(tick.fraction * props.model.total)); }}>
          <span>{tick.name}</span><time>{formatDay(tick.date, false)}</time>
        </button>}</For>
      </div>
      <div class="today-slider-ends" aria-hidden="true">
        <span>{props.startLabel}</span>
        <span>{props.endLabel}</span>
      </div>
    </div>
  );
}
