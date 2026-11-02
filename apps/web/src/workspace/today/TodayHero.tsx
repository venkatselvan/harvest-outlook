import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { FieldConditionPoint, IndexStageReading, NdviSeries, SceneRef } from "@harvest/contracts";
import { createReducedMotion, FieldGrowthScene } from "../FieldGrowthScene";
import { conditionLayers, rainStreaks, type ConditionEvent, type ConditionLayers, type FieldBoundary } from "../fieldGeometry";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import {
  conditionCaption,
  conditionKindChip,
  CROSS_FADE_MS,
  crossFadeMs,
  curveAsOfNote,
  curveLine,
  formatDay,
  futureImageLabel,
  rangeLabel,
  satelliteImage,
  sceneAgeCaption,
  sceneDate,
  sceneFor,
  type SatelliteImage,
  type ScenePick,
  type StageAt,
} from "./model";
import { sceneImageUrl } from "./todayApi";

export type HeroMode = "illustration" | "satellite";

export interface TodayHeroProps {
  mode: HeroMode;
  onMode: (mode: HeroMode) => void;
  /** Slider date (YYYY-MM-DD). */
  date: string;
  /** Server's today (Asia/Kolkata). */
  today: string;
  stage: StageAt;
  /** Schematic growth progress 0..1 for the illustration. */
  progress: number;
  cropId: string;
  cropName: string;
  boundary: FieldBoundary | null;
  scenes: SceneRef[];
  /** Bbox of the rendered scene images, for drawing the field outline over observed images. */
  imageBbox: NdviSeries["imageBbox"] | null;
  /** Code-only reading of the field's own NDVI curve, shown as evidence beside the calendar stage (never moves it). */
  indexStage?: IndexStageReading | null | undefined;
  /** Opens the curve sheet from the info button. */
  onCurveDetails?: (() => void) | undefined;
  /** The slider day's field condition (spec section 10); null when the series has no point for the day. */
  condition?: FieldConditionPoint | null | undefined;
  /** The view carries a conditions series: the caption line shows (a missing day reads "No weather record for this day"). */
  hasConditions?: boolean | undefined;
  /** Bbox of the field-zoom renders (`TodayView.fieldImageBbox`), for the outline over the crisp 10 m image. */
  fieldImageBbox?: [number, number, number, number] | null | undefined;
}

/** Stage name and date range for the bottom overlay ("Tillering · 12 Nov to 3 Dec"), plus its basis caption. */
export function stageOverlay(stage: StageAt): { name: string; range: string | null; caption: string | null } {
  switch (stage.kind) {
    case "stage":
      return {
        name: stage.stage.name,
        range: rangeLabel(stage.stage.from, stage.stage.to),
        caption:
          stage.stage.basis === "fao_generic"
            ? "Stage estimate from standard crop coefficients"
            : stage.stage.basis === "estimate"
              ? "Stage estimate"
              : "Calendar estimate from your sowing date",
      };
    case "harvest":
      return { name: "Harvest window", range: rangeLabel(stage.from, stage.to), caption: "Calendar estimate from your sowing date" };
    case "before":
      return { name: "Before sowing", range: stage.firstStage ? `Sown ${formatDay(stage.firstStage.from, false)}` : null, caption: null };
    case "after":
      return { name: "After the expected harvest", range: stage.lastDate ? `Harvest by ${formatDay(stage.lastDate)}` : null, caption: null };
    default:
      return { name: "Stage dates not available", range: null, caption: null };
  }
}

const stageName = (stage: StageAt) =>
  stage.kind === "stage" ? stage.stage.name : stage.kind === "harvest" ? "harvest window" : "crop";
const stageIdOf = (stage: StageAt) => (stage.kind === "stage" ? stage.stage.id : null);

/** Polygon points (0..scale, default 0..1) of the field boundary inside the rendered image bbox (EPSG:4326, square PNG). */
export function outlinePoints(boundary: FieldBoundary | null, bbox: NdviSeries["imageBbox"] | null | undefined, scale = 1): string | null {
  const ring = boundary?.coordinates[0];
  if (!ring || ring.length < 4 || !bbox) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (!(maxLon > minLon && maxLat > minLat)) return null;
  return ring
    .slice(0, -1)
    .map(([lon, lat]) => `${((((lon ?? 0) - minLon) / (maxLon - minLon)) * scale).toFixed(4)},${(((maxLat - (lat ?? 0)) / (maxLat - minLat)) * scale).toFixed(4)}`)
    .join(" ");
}

/** CSS `url()` for a same-origin image path already checked by `sceneImageUrl`. */
const cssUrl = (src: string) => `url("${src.replace(/["\\\n]/g, encodeURIComponent)}")`;

function SatelliteScene(props: {
  pick: ScenePick;
  image: SatelliteImage;
  date: string;
  stage: StageAt;
  boundary: FieldBoundary | null;
  imageBbox: NdviSeries["imageBbox"] | null;
  fieldImageBbox: [number, number, number, number] | null;
  layers: ConditionLayers;
  /** Field polygon in 0..100 image units for the water tint, or null (no outline, or an illustration). */
  water: string | null;
}) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const reduced = createReducedMotion();
  const scene = () => (props.pick.mode === "none" ? null : props.pick.scene);
  const src = () => sceneImageUrl(props.image.path);
  const field = () => props.image.zoom === "field";
  const bbox = () => (field() ? props.fieldImageBbox : props.imageBbox);
  const outline = () => (props.pick.mode === "illustration" ? null : outlinePoints(props.boundary, bbox()));
  const dimmed = () => props.pick.mode === "latest";
  const alt = () => {
    const pick = props.pick;
    if (pick.mode === "illustration")
      return `Illustration of a typical ${stageName(props.stage)}, made from the satellite image of ${formatDay(pick.derivedFrom ? sceneDate(pick.derivedFrom) : null)}. Not an observation.`;
    if (pick.mode === "none") return "";
    const cloud = pick.scene.cloudPct != null ? `, ${Math.round(pick.scene.cloudPct)}% cloud in the scene` : "";
    const what = props.image.layer === "ndvi" ? "greenness colour map (NDVI)" : "image";
    const latest = pick.mode === "latest";
    const lead = `${latest ? "Latest satellite" : "Satellite"} ${what} of your field`;
    return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}, observed ${formatDay(sceneDate(pick.scene))}${cloud}${field() ? ". Close-up at 10 m pixels" : ""}${latest ? ". No image yet for this date" : ""}`;
  };
  // Cross-fade: the previous image stays on top for 150 ms and fades out (none under reduced motion).
  const [previous, setPrevious] = createSignal<{ src: string; pixel: boolean } | null>(null);
  let last: { src: string; pixel: boolean } | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const next = src(),
      pixel = field();
    untrack(() => {
      const ms = crossFadeMs(reduced());
      if (last && next && last.src !== next && ms > 0) {
        setPrevious({ ...last });
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => setPrevious(null), ms);
      }
      last = next ? { src: next, pixel } : null;
    });
  });
  onCleanup(() => clearTimeout(fadeTimer));
  return (
    <div class="today-sat">
      <Show
        when={src() && failed() !== src()}
        fallback={
          <div class="today-hero-message" role="status">
            <Icon name="layers" size={22} />
            <strong>Satellite unavailable today</strong>
            <span>
              {props.pick.mode === "none"
                ? props.pick.reason === "no_scenes"
                  ? "No clear satellite image of this field yet."
                  : `No clear image on or before ${formatDay(props.date)}.`
                : "The image could not load. Try again later."}
            </span>
          </div>
        }
      >
        <div class="today-sat-box" classList={{ "is-dimmed": dimmed(), "is-field": field() }} data-zoom={props.image.zoom} data-layer={props.image.layer}>
          <img
            src={src()!}
            alt={alt()}
            data-scene-kind={props.pick.mode}
            data-zoom={props.image.zoom}
            style={field() ? { "image-rendering": "pixelated" } : undefined}
            onError={() => setFailed(src())}
          />
          <Show when={previous()} keyed>
            {(prev) => (
              <div
                class="today-sat-prev"
                classList={{ "is-field": prev.pixel }}
                style={{ "background-image": cssUrl(prev.src), "animation-duration": `${CROSS_FADE_MS}ms` }}
                aria-hidden="true"
              />
            )}
          </Show>
          <Show when={outline()}>
            <svg class="today-sat-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={outline()!} vector-effect="non-scaling-stroke" />
            </svg>
          </Show>
          <SatelliteConditions layers={props.layers} water={props.water} />
          <Show when={futureImageLabel(props.pick)}>
            {(label) => (
              <p class="today-sat-future" data-testid="today-sat-future">
                {label()}
              </p>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The day's conditions over the satellite image, as a labelled SVG layer on top (never drawn into the image): a water
 * tint over the field polygon when ponded or flooded, and rain streaks by class (dashed for forecast and typical days).
 * The streaks are the same deterministic set the illustration uses; they fall by CSS animation, static under reduced motion.
 */
export function SatelliteConditions(props: { layers: ConditionLayers; water: string | null }) {
  const streaks = createMemo(() => rainStreaks(props.layers.rain.count));
  const rain = () => props.layers.rain;
  const water = () => (props.water && props.layers.water.look !== "none" ? props.water : null);
  return (
    <Show when={rain().count > 0 || water()}>
      <svg
        class="today-sat-conditions"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        data-rain-count={rain().count}
        data-water={water() ? props.layers.water.look : "none"}
      >
        <Show when={water()}>
          <polygon class={`today-sat-water ${props.layers.water.look}`} points={water()!} />
        </Show>
        <Show when={rain().count > 0}>
          <g
            class="today-sat-rain"
            classList={{ "is-dashed": rain().dashed }}
            style={{ "animation-duration": `${(1.6 / Math.max(0.3, rain().speed)).toFixed(2)}s` }}
            stroke-width={(rain().width * 0.32).toFixed(2)}
          >
            <For each={streaks()}>
              {(s) => {
                const len = (rain().length * s.len * 0.32).toFixed(2);
                const x = (s.x * 100).toFixed(2),
                  y = (s.y * 100).toFixed(2);
                return (
                  <>
                    <line x1={x} y1={y} x2={(Number(x) - Number(len) * 0.22).toFixed(2)} y2={(Number(y) + Number(len)).toFixed(2)} />
                    <line x1={x} y1={(Number(y) - 100).toFixed(2)} x2={(Number(x) - Number(len) * 0.22).toFixed(2)} y2={(Number(y) - 100 + Number(len)).toFixed(2)} />
                  </>
                );
              }}
            </For>
          </g>
        </Show>
      </svg>
    </Show>
  );
}

/** Small legend for the NDVI colour map the API renders (rescale -0.2 to 0.9, red to yellow to green). */
export function NdviLegend() {
  return (
    <span class="today-ndvi-legend" role="img" aria-label="Greenness colour map: red at NDVI −0.2 or lower, yellow in the middle, green at 0.9 or higher" data-testid="today-ndvi-legend">
      <span aria-hidden="true">−0.2</span>
      <span class="today-ndvi-bar" aria-hidden="true" />
      <span aria-hidden="true">0.9</span>
    </span>
  );
}

const EVENT_ICON: Record<string, string> = { weather: "rain", price: "trend", market_event: "trend", crop_threat: "leaf", satellite: "layers" };
/** The day's alerts as badges over the scene (both modes): severity colour, icon and title; at most two, then a count. */
export function EventBadges(props: { events: ConditionEvent[] }) {
  const shown = () => props.events.slice(0, 2);
  const more = () => Math.max(0, props.events.length - 2);
  return (
    <Show when={props.events.length}>
      <ul class="today-events" aria-label="Alerts on this date" data-testid="today-events">
        <For each={shown()}>
          {(event) => (
            <li class={`today-event severity ${event.severity}`} title={event.title} data-alert-id={event.alertId}>
              <Icon name={EVENT_ICON[event.type] ?? "sun"} size={13} />
              <span>{event.title}</span>
            </li>
          )}
        </For>
        <Show when={more()}>
          <li class="today-event more">+{more()} more</li>
        </Show>
      </ul>
    </Show>
  );
}

/** The conditions caption under the hero: the weather-basis chip and the day's conditions in words. */
export function ConditionsLine(props: { point: FieldConditionPoint | null; date: string }) {
  const chip = () => conditionKindChip(props.point);
  return (
    <p class="today-conditions" data-testid="today-conditions" data-kind={props.point?.kind ?? "none"}>
      <Show when={chip()}>{(c) => <span class={`today-chip ${c().tone}`}>{c().label}</span>}</Show>
      <span>{conditionCaption(props.point, props.date)}</span>
    </p>
  );
}

/**
 * Notes for the satellite image, on one line right under the frame so they never cover the field: the 10 m pixel
 * caption for the close-up, the NDVI legend under Greenness, and the label for the weather overlay.
 */
export function SatelliteNotes(props: { image: SatelliteImage; overlay: boolean }) {
  return (
    <Show when={props.image.zoom === "field" || props.image.layer === "ndvi" || props.overlay}>
      <p class="today-sat-notes" data-testid="today-sat-notes">
        <Show when={props.image.zoom === "field"}>
          <span data-testid="today-sat-pixels">Sentinel-2, 10 m pixels: each square is 10 m</span>
        </Show>
        <Show when={props.image.layer === "ndvi"}>
          <NdviLegend />
        </Show>
        <Show when={props.overlay}>
          <span class="today-chip illustration" title="Rain and standing water drawn over the image from weather records and forecasts">
            Weather overlay
          </span>
        </Show>
      </p>
    </Show>
  );
}

/** Caption chips for the satellite view: kind, which image and how old, and cloud; or the illustration label. */
function SatelliteCaption(props: { pick: ScenePick; stage: StageAt; date: string }) {
  return (
    <Switch>
      <Match when={props.pick.mode === "observed" || props.pick.mode === "latest"}>
        {(() => {
          const scene = () => (props.pick as Extract<ScenePick, { scene: SceneRef }>).scene;
          return (
            <>
              <span class="today-hero-caption">
                <span class="today-chip observed">Observed</span>
                <span class="today-scene-date" data-testid="today-scene-age">
                  {sceneAgeCaption(props.pick, props.date)}
                </span>
                <Show when={scene().cloudPct != null}>
                  <span class="today-chip">Cloud {Math.round(scene().cloudPct!)}%</span>
                </Show>
              </span>
            </>
          );
        })()}
      </Match>
      <Match when={props.pick.mode === "illustration"}>
        {(() => {
          const pick = () => props.pick as Extract<ScenePick, { mode: "illustration" }>;
          return (
            <span class="today-hero-caption">
              <span class="today-chip illustration">Illustration</span>
              <span class="today-scene-date">
                Illustration of a typical {stageName(props.stage)}
                <Show when={pick().derivedFrom}> · from image of {formatDay(sceneDate(pick().derivedFrom!), false)}</Show>
              </span>
              <AiSpark use="future_look" size={14} />
            </span>
          );
        })()}
      </Match>
    </Switch>
  );
}

/**
 * One line under the hero image: what the field's own satellite curve looks like, beside the calendar stage above.
 * Hidden when the reader was unavailable or the view carries no reading. The text states the comparison for the latest
 * clear image, so a slider date other than today, or a latest image more than 10 days old, names that image's date
 * instead of implying it describes the date.
 */
export function CurveLine(props: { reading: IndexStageReading | null | undefined; date: string; today: string; onDetails?: (() => void) | undefined }) {
  const line = () => curveLine(props.reading);
  const asOfNote = () => curveAsOfNote(props.reading, props.date, props.today);
  return (
    <Show when={line()}>
      {(text) => (
        <div class="today-curve" data-testid="today-curve-line" data-curve-status={props.reading!.status}>
          <Icon name="layers" size={15} class="today-curve-icon" />
          <p class="today-curve-text">
            {text()}
            <Show when={asOfNote()}>
              <span class="today-curve-asof"> · {asOfNote()}</span>
            </Show>
          </p>
          <button
            type="button"
            class="today-curve-info"
            aria-label="About the satellite curve reading"
            aria-haspopup="dialog"
            onClick={() => props.onDetails?.()}
          >
            <Icon name="info" size={16} />
          </button>
        </div>
      )}
    </Show>
  );
}

export function TodayHero(props: TodayHeroProps) {
  const overlay = createMemo(() => stageOverlay(props.stage));
  const pick = createMemo(() => sceneFor(props.scenes, props.date, props.today, stageIdOf(props.stage)));
  const isToday = () => props.date === props.today;
  const satellite = () => props.mode === "satellite";
  const point = () => (props.hasConditions ? props.condition ?? null : null);
  const layers = createMemo(() => conditionLayers(point()));
  const caption = () => (props.hasConditions ? conditionCaption(point(), props.date) : null);
  // Satellite image choices persist while the farmer moves the slider: field close-up by default, Wider view and Greenness on demand.
  const [wide, setWide] = createSignal(false);
  const [greenness, setGreenness] = createSignal(false);
  const image = createMemo(() => satelliteImage(pick(), { wide: wide(), greenness: greenness() }));
  const shownBbox = () => (image().zoom === "field" ? props.fieldImageBbox ?? null : props.imageBbox);
  // Water is tinted only over the field polygon of an observed image; an illustration gets rain only.
  const waterPoints = () => (pick().mode === "observed" || pick().mode === "latest" ? outlinePoints(props.boundary, shownBbox(), 100) : null);
  const overlayDrawn = () => pick().mode !== "none" && (layers().rain.count > 0 || (layers().water.look !== "none" && !!waterPoints()));
  return (
    <section class="today-hero" aria-label="Your field">
      <div class="today-hero-frame" classList={{ satellite: satellite() }}>
        <Show
          when={satellite()}
          fallback={
            <FieldGrowthScene
              cropId={props.cropId}
              cropName={props.cropName}
              boundary={props.boundary}
              progress={props.progress}
              date={props.date}
              condition={point()}
              conditionCaption={caption()}
              compact
            />
          }
        >
          <SatelliteScene
            pick={pick()}
            image={image()}
            date={props.date}
            stage={props.stage}
            boundary={props.boundary}
            imageBbox={props.imageBbox}
            fieldImageBbox={props.fieldImageBbox ?? null}
            layers={layers()}
            water={waterPoints()}
          />
        </Show>
        <div class="today-hero-top">
          <div class="today-hero-toggle" role="group" aria-label="Field view">
            <button type="button" aria-pressed={props.mode === "illustration"} onClick={() => props.onMode("illustration")}>
              Illustration
            </button>
            <button type="button" aria-pressed={props.mode === "satellite"} onClick={() => props.onMode("satellite")}>
              Satellite
            </button>
          </div>
          <span class="today-date-chip" data-testid="today-date-chip">
            <Show when={isToday()}>
              <span class="today-date-chip-today">Today</span>
            </Show>
            {formatDay(props.date)}
          </span>
        </div>
        <div class="today-hero-second" classList={{ "has-tools": satellite() && (image().fieldAvailable || image().ndviAvailable) }}>
          <EventBadges events={layers().events} />
          <Show when={satellite() && (image().fieldAvailable || image().ndviAvailable)}>
            <div class="today-sat-tools" role="group" aria-label="Satellite image options">
              <Show when={image().ndviAvailable}>
                <button type="button" aria-pressed={image().layer === "ndvi"} onClick={() => setGreenness((on) => !on)}>
                  Greenness
                </button>
              </Show>
              <Show when={image().fieldAvailable}>
                <button type="button" aria-pressed={wide()} onClick={() => setWide((on) => !on)}>
                  Wider view
                </button>
              </Show>
            </div>
          </Show>
        </div>
        <div class="today-hero-overlay" data-testid="today-stage">
          <p class="today-stage-line">
            <strong>{overlay().name}</strong>
            <Show when={overlay().range}>
              <span> · {overlay().range}</span>
            </Show>
            <Show when={isToday() && props.stage.kind === "stage"}>
              <span class="today-chip growing">Growing</span>
            </Show>
          </p>
          <Show
            when={satellite()}
            fallback={
              <Show when={overlay().caption}>
                <span class="today-hero-caption">
                  <span class="today-chip illustration">Illustration</span>
                  <span class="today-scene-date">{overlay().caption}</span>
                </span>
              </Show>
            }
          >
            <SatelliteCaption pick={pick()} stage={props.stage} date={props.date} />
          </Show>
        </div>
      </div>
      <Show when={satellite()}>
        <SatelliteNotes image={image()} overlay={overlayDrawn()} />
      </Show>
      <Show when={props.hasConditions}>
        <ConditionsLine point={point()} date={props.date} />
      </Show>
      <CurveLine reading={props.indexStage} date={props.date} today={props.today} onDetails={props.onCurveDetails} />
    </section>
  );
}
