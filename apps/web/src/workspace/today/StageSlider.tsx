import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatDay, type SceneMark, type SliderModel } from "./model";

import { Icon } from '../icons';
import { AiSparkIcon } from '../ui/AiSpark';
import { mediaClusters, type MediaKind } from './timelineMedia';

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

/** Daily season slider with one compact media row; nearby dates share a date picker. */
export function StageSlider(props: StageSliderProps) {
  let input: HTMLInputElement | undefined, mediaTrack: HTMLDivElement | undefined;
  const [trackWidth,setTrackWidth] = createSignal(2000);
  onMount(() => {
    if (!mediaTrack) return;
    const measure = () => setTrackWidth(Math.max(1, mediaTrack!.clientWidth - 22));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(mediaTrack);
    onCleanup(() => observer.disconnect());
  });
  const icon = (kind: MediaKind) => kind === 'predicted' ? <AiSparkIcon size={17}/> : <Icon name={kind === 'photo' ? 'camera' : 'satellite'} size={17}/>;
  const groups = createMemo(() => mediaClusters(props.marks ?? [],trackWidth()));
  const markKey = (mark: SceneMark) => `${mark.kind}|${mark.date}`;
  const selectMark = (mark: SceneMark) => { props.onInteract?.(); props.onChange(Math.round(mark.fraction * props.model.total)); };

  const fraction = (index: number) => (props.model.total ? index / props.model.total : 0);
  const atToday = () => props.value === props.model.todayIndex;
  const observedMarks = () => (props.marks ?? []).filter((mark) => mark.kind === "observed").length;
  const predictedMarks = () => (props.marks ?? []).filter((mark) => mark.kind === "predicted" || mark.kind === "illustration").length;
  const photoMarks = () => (props.marks ?? []).filter(mark => mark.kind === "photo").length;
  const markTitle = (mark: SceneMark) =>
    `${mark.kind === "observed" ? "Satellite image" : mark.kind === "photo" ? "Photo taken" : "AI image for"} ${formatDay(mark.date)}${mark.note ? ` · ${mark.note}` : ""}`;
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
          aria-describedby={observedMarks() || predictedMarks() || photoMarks() ? "today-slider-marks-note" : undefined}
          onPointerDown={() => props.onInteract?.()}
          onKeyDown={() => props.onInteract?.()}
          onInput={(event) => {
            props.onInteract?.();
            props.onChange(Number(event.currentTarget.value));
          }}
        />
      </div>
      <div class="today-slider-media" ref={mediaTrack}>
        <Show when={groups().length}>
          <div class="today-media-row" role="group" aria-label="Image dates">
            <For each={groups()}>{group => {
              const symbols = () => <><For each={group.kinds}>{kind => <span class={`today-media-symbol ${kind}`} data-media-kind={kind}>{icon(kind)}</span>}</For><Show when={group.dates > 1}><small>{group.dates}</small></Show></>;
              const position = () => ({left:`${group.left / trackWidth() * 100}%`,width:`${group.width}px`});
              return <Show when={group.marks.length > 1} fallback={
                <button type="button" class={`today-slider-mark ${group.marks[0]!.kind}`} style={position()}
                  data-date={group.marks[0]!.date} data-scene-kind={group.marks[0]!.kind} title={markTitle(group.marks[0]!)} aria-label={markTitle(group.marks[0]!)}
                  aria-pressed={props.valueDate === group.marks[0]!.date} onClick={() => selectMark(group.marks[0]!)}>{symbols()}</button>
              }>
                <label class="today-slider-mark is-cluster" classList={{'is-selected':group.marks.some(mark => mark.date === props.valueDate)}} style={position()} title={group.marks.map(markTitle).join('; ')}>
                  {symbols()}
                  <select aria-label={`Image dates: ${group.marks.map(markTitle).join('; ')}`} value=""
                    onChange={event => { const mark=group.marks.find(mark=>markKey(mark)===event.currentTarget.value); if(mark)selectMark(mark);event.currentTarget.value=''; }}>
                    <option value="" disabled selected>Choose an image date</option>
                    <For each={group.marks}>{mark => <option value={markKey(mark)}>{markTitle(mark)}</option>}</For>
                  </select>
                </label>
              </Show>;
            }}</For>
          </div>
        </Show>
      </div>
      <Show when={observedMarks() || predictedMarks() || photoMarks()}>
        <div class="today-sr" id="today-slider-marks-note">
          Satellite icons mark {observedMarks()} dates. AI sparks mark {predictedMarks()} generated image dates, not observations. Photo camera icons mark {photoMarks()} capture dates. Select an icon group to choose its exact date.
        </div>
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
