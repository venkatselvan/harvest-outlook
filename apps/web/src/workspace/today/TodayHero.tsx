import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { FieldConditionPoint, FieldSummary, IndexStageReading, NdviSeries, SceneRef } from "@harvest/contracts";
import { createReducedMotion, FieldGrowthScene } from "../FieldGrowthScene";
import { conditionLayers, normalizeWithin, rainStreaks, type ConditionEvent, type ConditionLayers, type FieldBoundary, type SceneField, type WaterLook } from "../fieldGeometry";
import { Icon } from "../icons";
import { AiSpark, AiSparkIcon } from "../ui/AiSpark";
import {
  conditionAriaCaption,
  conditionCaption,
  conditionKindChip,
  cropColor,
  CROSS_FADE_MS,
  crossFadeMs,
  curveAsOfNote,
  curveLine,
  formatDay,
  futureImageLabel,
  PREDICTED_DISCLAIMER,
  predictedCaption,
  predictedDate,
  predictionSourceDate,
  rangeLabel,
  satelliteImage,
  sceneAgeCaption,
  sceneDate,
  sceneFor,
  type SatelliteImage,
  type ScenePick,
  type StageAt,
  wetnessBadge,
} from "./model";
import { sceneImageUrl } from "./todayApi";
import { createHeroNotes, HeroNotesButton, HeroNotesPanel } from "./TodayHeroNotes";

export type HeroMode = "illustration" | "satellite" | "field-image";

export interface TodayHeroProps {
  fieldImage?: () => JSX.Element;
  timeline?: () => JSX.Element;
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
  /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 6.3): the field this view describes, named in the label and the stage overlay. */
  fieldName?: string | null | undefined;
  /** The companion crop of an intercrop: the illustration alternates rows by `rowRatio` (spec 4.1). */
  companionCropId?: string | null | undefined;
  rowRatio?: string | null | undefined;
  /** Display names by crop id for the scene's labels. */
  cropNames?: Readonly<Record<string, string>> | null | undefined;
  /** The farm's other fields, outlined faintly over the wide satellite view so the farmer sees where this field sits (spec 5). */
  otherFields?: readonly HeroField[] | null | undefined;
  /**
   * "All fields" mode (spec 5 and 6.3): the farm boundary and every field. The illustration draws the whole farm, one crop
   * per field at its own stage today; the satellite view is the wide image with every field outlined in its crop colour and
   * labelled. The stage overlay names the farm instead of a stage.
   */
  farm?: FarmHero | null | undefined;
  /**
   * 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 11.4): "Predict with AI" on the dimmed latest image of a future date. Absent
   * (null) outside live mode and on the farm overview, which uses the real wide image only.
   */
  prediction?: HeroPrediction | null | undefined;
  /**
   * 2026-11-04 (TODAY_REFINEMENT_SPEC.md 2): extra notes for the "About this view" popover, after the hero's own notes
   * (the automatic milestone previews status), and the action that opens the monitoring and limitations sheet.
   */
  notes?: (() => JSX.Element) | undefined;
  onAbout?: (() => void) | undefined;
}

/** State of the AI-predicted look for the satellite hero, from the view's `predictions` and the request in flight. */
export interface HeroPrediction {
  /** A look is being made (the view's `predictions.pending > 0`, or this screen's own request is in flight). */
  pending: boolean;
  /** Why the button is disabled (cycle cap, budget, provider, too far ahead), or null. */
  blocked: string | null;
  /** Short message from the last request that did not produce a look, or null. */
  message: string | null;
  /** Requests a predicted look for the slider date (TodayView keeps one request in flight per farm). */
  onPredict: (date: string) => void;
}

/** A field outline for the hero: id, name, drawn polygon and crop (for the colour). */
export interface HeroField {
  id: string;
  name: string;
  boundary: FieldBoundary;
  cropId: string | null;
}
export interface FarmHero {
  boundary: FieldBoundary;
  fields: readonly FieldSummary[];
  /** The field whose cards are shown below (drawn with a brighter edge), or null. */
  selectedId: string | null;
}

/** One polygon over the satellite image: points in 0..1 image units, crop colour, and an optional label at its centre. */
export interface OutlineShape {
  id: string;
  points: string;
  color: string;
  selected: boolean;
  faint: boolean;
  label: string | null;
  /** Label position, 0..100 percent of the image. */
  cx: number;
  cy: number;
  /** Width of the field's bounding box in the image, 0..100 percent of the image width. */
  width: number;
  /** 1-based position in the stored field order: the number on the badge, the legend and the Your fields table. */
  index: number;
}

/** Nominal image width in px when the real frame has not been measured (server render, first paint). */
export const NOMINAL_FRAME_PX = 640;
/**
 * Label rule. A field gets its full chip when its bounding box in the image is at least as wide as the chip: the chip is
 * estimated at 7 px per character plus 16 px padding (capped at 42% of the frame, the CSS max-width, where the text is cut
 * with an ellipsis), the box width being its 0..100 image share times the frame width in px. A narrower field gets a small
 * numbered badge instead (the same number sits before its name in the legend and the Your fields table), so chips never
 * overlap on narrow strips.
 */
export function chipFits(label: string, widthPct: number, framePx = NOMINAL_FRAME_PX): boolean {
  const chipPx = Math.min(label.length * 7 + 16, framePx * 0.42);
  return (widthPct / 100) * framePx >= chipPx;
}

/** Bounding-box width in 0..100 image units of a polygon given as `outlinePoints(..., 100)`. */
function pointsWidth(points: string): number {
  const xs = points.split(" ").map((pair) => Number(pair.split(",")[0]));
  return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
}

/** Mean of the ring's vertices inside the image bbox, in 0..100 percent (clamped so a label stays on the image). */
export function ringCentre(boundary: FieldBoundary, bbox: NdviSeries["imageBbox"] | null | undefined): { cx: number; cy: number } | null {
  const ring = boundary.coordinates[0]?.slice(0, -1) ?? [];
  if (!ring.length || !bbox) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (!(maxLon > minLon && maxLat > minLat)) return null;
  const lon = ring.reduce((sum, p) => sum + (p[0] ?? 0), 0) / ring.length;
  const lat = ring.reduce((sum, p) => sum + (p[1] ?? 0), 0) / ring.length;
  const clamp = (v: number) => Math.max(6, Math.min(94, v));
  return { cx: clamp(((lon - minLon) / (maxLon - minLon)) * 100), cy: clamp(((maxLat - lat) / (maxLat - minLat)) * 100) };
}

/**
 * Field outlines over an image bbox. Farm mode: every field in its crop colour with a name label, the selected one thicker.
 * Field mode: the other fields only, faint and unlabelled (the field itself keeps the white outline).
 */
export function fieldOutlines(
  fields: readonly HeroField[],
  bbox: NdviSeries["imageBbox"] | null | undefined,
  options: { selectedId?: string | null; faint?: boolean; labels?: Readonly<Record<string, string>> },
): OutlineShape[] {
  return fields.flatMap((field, index) => {
    const points = outlinePoints(field.boundary, bbox);
    const centre = ringCentre(field.boundary, bbox);
    if (!points || !centre) return [];
    return [
      {
        id: field.id,
        points,
        color: cropColor(field.cropId),
        selected: !options.faint && options.selectedId === field.id,
        faint: !!options.faint,
        label: options.faint ? null : (options.labels?.[field.id] ?? field.name),
        width: pointsWidth(outlinePoints(field.boundary, bbox, 100) ?? ""),
        index: index + 1,
        ...centre,
      },
    ];
  });
}

/**
 * Farm-mode scene fields: each field's ring in the farm's normalised frame, its crop and its share of the season today.
 * `water` is the described field's own water look from the day's condition point; it is set on that field alone.
 */
export function sceneFields(farm: FarmHero, water: WaterLook = "none"): SceneField[] {
  return farm.fields.map((field) => ({
    id: field.id,
    name: field.name,
    ring: normalizeWithin(farm.boundary, field.boundary as FieldBoundary),
    cropId: field.cycle?.cropId ?? null,
    // Share of the season elapsed today; a crop without stage dates is drawn just established rather than guessed.
    progress: field.cycle?.stage?.progress ?? 0,
    companionCropId: field.cycle?.companion?.cropId ?? null,
    selected: field.id === farm.selectedId,
    // The day's condition belongs to the described field only: standing water is drawn in it, and only when it has a crop.
    ...(water !== "none" && field.id === farm.selectedId && field.cycle ? { water } : {}),
  }));
}
export const heroFieldOf = (field: FieldSummary): HeroField => ({ id: field.id, name: field.name, boundary: field.boundary as FieldBoundary, cropId: field.cycle?.cropId ?? null });

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
  /** Field outlines in crop colours (farm mode: all fields; field mode: the other fields, faint, wide view only). */
  outlines?: readonly OutlineShape[] | undefined;
  /** Farm mode: the described field is one of many, so the single white outline is not drawn. */
  farmMode?: boolean | undefined;
  /** Names the field in the image description. */
  fieldName?: string | null | undefined;
  prediction?: HeroPrediction | null | undefined;
}) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const [framePx, setFramePx] = createSignal(NOMINAL_FRAME_PX);
  let box: HTMLDivElement | undefined;
  onMount(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setFramePx(width);
    });
    observer.observe(box);
    onCleanup(() => observer.disconnect());
  });
  const reduced = createReducedMotion();
  const scene = () => (props.pick.mode === "none" ? null : props.pick.scene);
  const src = () => sceneImageUrl(props.image.path);
  const field = () => props.image.zoom === "field";
  const bbox = () => (field() ? props.fieldImageBbox : props.imageBbox);
  // A predicted look is an edit inside the field outline of the real wide image, so the outline is drawn as on that image.
  const outline = () => (props.pick.mode === "illustration" || props.farmMode ? null : outlinePoints(props.boundary, bbox()));
  const shapes = () => (props.pick.mode === "illustration" ? [] : (props.outlines ?? []));
  const subject = () => (props.farmMode ? "your farm with your field outlines" : props.fieldName ? props.fieldName : "your field");
  const dimmed = () => props.pick.mode === "latest";
  const alt = () => {
    const pick = props.pick;
    if (pick.mode === "illustration")
      return `Illustration of a typical ${stageName(props.stage)}, made from the satellite image of ${formatDay(pick.derivedFrom ? sceneDate(pick.derivedFrom) : null)}. Not an observation.`;
    if (pick.mode === "none") return "";
    if (pick.mode === "predicted") {
      const source = predictionSourceDate(pick);
      return `Predicted look of ${subject()} for ${formatDay(predictedDate(pick.scene))}, made with AI from the real satellite image of ${source ? formatDay(source) : "an earlier date"}. Not an observation.`;
    }
    const cloud = pick.scene.cloudPct != null ? `, ${Math.round(pick.scene.cloudPct)}% cloud in the scene` : "";
    const what = props.image.layer === "ndvi" ? "greenness colour map (NDVI)" : "image";
    const latest = pick.mode === "latest";
    const lead = `${latest ? "Latest satellite" : "Satellite"} ${what} of ${subject()}`;
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
        <div class="today-sat-box" ref={box} classList={{ "is-dimmed": dimmed(), "is-field": field() }} data-zoom={props.image.zoom} data-layer={props.image.layer}>
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
          <Show when={shapes().length}>
            <svg class="today-sat-fields" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" data-testid="today-sat-fields">
              <For each={shapes()}>
                {(shape) => (
                  <polygon
                    points={shape.points}
                    vector-effect="non-scaling-stroke"
                    style={{ stroke: shape.color }}
                    classList={{ "is-selected": shape.selected, "is-faint": shape.faint }}
                    data-field-outline={shape.id}
                  />
                )}
              </For>
            </svg>
            <For each={shapes().filter((shape) => shape.label)}>
              {(shape) => (
                <Show
                  when={chipFits(shape.label!, shape.width, framePx())}
                  fallback={
                    <span
                      class="today-sat-field-badge"
                      style={{ left: `${shape.cx.toFixed(1)}%`, top: `${shape.cy.toFixed(1)}%`, "border-color": shape.color }}
                      data-field-badge={shape.index}
                      aria-hidden="true"
                    >
                      {shape.index}
                    </span>
                  }
                >
                  <span class="today-sat-field-label" style={{ left: `${shape.cx.toFixed(1)}%`, top: `${shape.cy.toFixed(1)}%`, "border-color": shape.color }} aria-hidden="true">
                    {shape.label}
                  </span>
                </Show>
              )}
            </For>
          </Show>
          <Show when={outline()}>
            <svg class="today-sat-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={outline()!} vector-effect="non-scaling-stroke" />
            </svg>
          </Show>
          <SatelliteConditions layers={props.layers} water={props.water} />
          <Show when={futureImageLabel(props.pick)}>
            {(label) => <FutureImageLabel label={label()} date={props.date} prediction={props.prediction ?? null} />}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The label on the dimmed latest image of a future date (spec 11.4): "Predicting with AI…" while a look is being made,
 * else "No image yet for this date; latest image …" with "Predict with AI" in live mode (disabled with its reason when a cap
 * stops it) and the last request's message. The status line is a polite live region.
 */
export function FutureImageLabel(props: { label: string; date: string; prediction: HeroPrediction | null }) {
  const pending = () => !!props.prediction?.pending;
  return (
    <div class="today-sat-future" data-testid="today-sat-future" data-predicting={pending() ? "true" : undefined}>
      <p class="today-sat-future-text" role="status" aria-live="polite">
        <Show when={pending()} fallback={props.label}>
          <AiSparkIcon size={14} class="today-predicting-icon" />
          <span data-testid="today-predicting">Predicting with AI…</span>
        </Show>
      </p>
      <Show when={props.prediction && !pending() ? props.prediction : null}>
        {(prediction) => (
          <>
            <button
              type="button"
              class="btn compact secondary today-predict"
              data-testid="today-predict"
              disabled={!!prediction().blocked}
              aria-describedby={prediction().blocked ? "today-predict-blocked" : undefined}
              onClick={() => prediction().onPredict(props.date)}
            >
              <AiSparkIcon size={14} />
              <span>Predict with AI</span>
            </button>
            <Show when={prediction().blocked}>
              <span id="today-predict-blocked" class="today-predict-note">
                {prediction().blocked}
              </span>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.prediction?.message}>
        <span class="today-predict-note is-error" role="alert" data-testid="today-predict-message">
          {props.prediction!.message}
        </span>
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
/**
 * The day's alerts as badges over the scene (both modes): severity colour, icon and title; at most two, then a count.
 * 2026-11-03 (WEATHER_DEPTH_SPEC.md 6.4): with `condition`, a wetness badge follows the alerts when the day's modelled
 * wetness is high or moderate; it is context from the grid-cell model estimate, not an alert and never a diagnosis.
 */
export function EventBadges(props: { events: ConditionEvent[]; condition?: FieldConditionPoint | null | undefined }) {
  const shown = () => props.events.slice(0, 2);
  const more = () => Math.max(0, props.events.length - 2);
  const wetness = () => wetnessBadge(props.condition ?? null);
  return (
    <Show when={props.events.length || wetness()}>
      <ul class="today-events" aria-label={wetness() ? "Alerts and conditions on this date" : "Alerts on this date"} data-testid="today-events">
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
        <Show when={wetness()}>
          {(badge) => (
            <li
              class={`today-event today-wetness ${badge().wetness === "high" ? "severity info" : "more"}`}
              title={badge().description}
              aria-label={badge().description}
              data-testid="today-wetness"
              data-wetness={badge().wetness}
            >
              <Icon name="leaf" size={13} />
              <span>{badge().label}</span>
            </li>
          )}
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
      <Show when={chip()}>
        {(c) => (
          <span class={`today-chip ${c().tone}`} title={c().note} aria-label={c().note}>
            {c().label}
          </span>
        )}
      </Show>
      <span>{conditionCaption(props.point, props.date)}</span>
    </p>
  );
}

/**
 * Notes for the satellite image, on one line right under the frame so they never cover the field: the 10 m pixel
 * caption for the close-up, the NDVI legend under Greenness, and the label for the weather overlay.
 */
export function SatelliteNotes(props: { image: SatelliteImage; overlay: boolean; predicted?: boolean | undefined }) {
  return (
    <Show when={props.image.zoom === "field" || props.image.layer === "ndvi" || props.overlay || props.predicted}>
      <p class="today-sat-notes" data-testid="today-sat-notes">
        <Show when={props.predicted}>
          <span class="today-sat-predicted-note" data-testid="today-sat-predicted-note">
            {PREDICTED_DISCLAIMER}
          </span>
        </Show>
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
      <Match when={props.pick.mode === "predicted"}>
        {(() => {
          const pick = () => props.pick as Extract<ScenePick, { mode: "predicted" }>;
          return (
            <span class="today-hero-caption" data-testid="today-predicted-caption">
              <span class="today-chip predicted">Predicted with AI</span>
              <AiSpark use="future_look" size={14} />
              <span class="today-scene-date">{predictedCaption(pick())}</span>
            </span>
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
  const farm = () => (props.farm && props.farm.fields.length ? props.farm : null);
  const overlay = createMemo(() => stageOverlay(props.stage));
  // The farm overview uses the real wide image only (spec 11.2): predicted looks belong to one field's cycle.
  const scenes = () => (farm() ? props.scenes.filter((scene) => scene.kind !== "predicted") : props.scenes);
  const pick = createMemo(() => sceneFor(scenes(), props.date, props.today, stageIdOf(props.stage)));
  const isToday = () => props.date === props.today;
  const satellite = () => props.mode === "satellite";
  const point = () => (props.hasConditions ? props.condition ?? null : null);
  const layers = createMemo(() => conditionLayers(point()));
  // The canvas label carries the grid-cell label when the day used the deeper model values (section 7).
  const caption = () => (props.hasConditions ? conditionAriaCaption(point(), props.date) : null);
  // Satellite image choices persist while the farmer moves the slider: field close-up by default, Wider view and Greenness on demand.
  const [wide, setWide] = createSignal(false);
  const [greenness, setGreenness] = createSignal(false);
  // The farm overview always uses the wide image: the 10 m close-up covers one field only.
  const image = createMemo(() => satelliteImage(pick(), { wide: wide() || !!farm(), greenness: greenness() }));
  const shownBbox = () => (image().zoom === "field" ? props.fieldImageBbox ?? null : props.imageBbox);
  // Water is tinted only over the field polygon of an observed image or a predicted look of it; an illustration gets rain only.
  const waterPoints = () =>
    pick().mode === "observed" || pick().mode === "latest" || pick().mode === "predicted" ? outlinePoints(props.boundary, shownBbox(), 100) : null;
  const overlayDrawn = () => pick().mode !== "none" && (layers().rain.count > 0 || (layers().water.look !== "none" && !!waterPoints()));
  const outlines = createMemo(() => {
    const current = farm();
    if (current)
      return fieldOutlines(current.fields.map(heroFieldOf), props.imageBbox, {
        selectedId: current.selectedId,
        labels: Object.fromEntries(current.fields.map((f) => [f.id, `${f.name} · ${f.cycle ? f.cycle.cropName : "no crop"}`])),
      });
    return image().zoom === "wide" && props.otherFields?.length ? fieldOutlines(props.otherFields, props.imageBbox, { faint: true }) : [];
  });
  const scene = createMemo(() => (farm() ? sceneFields(farm()!, layers().water.look) : null));
  const heroLabel = () => (farm() ? "Your farm" : props.fieldName ? `Your field ${props.fieldName}` : "Your field");
  const actualScene = createMemo(() => satellite() ? props.scenes.find(scene => scene.kind === 'observed' && sceneDate(scene) === props.date && scene.imagePath) : null);
  const expectedScene = createMemo(() => actualScene() ? props.scenes.filter(scene => scene.kind === 'predicted' && predictedDate(scene) === props.date && scene.imagePath)
    .sort((a,b) => (a.generatedAt ?? '').localeCompare(b.generatedAt ?? ''))[0] : null);
  const fieldCount = () => farm()?.fields.length ?? 0;
  const notes = createHeroNotes();
  return (
    <section class="today-hero" aria-label={heroLabel()} data-hero-mode={farm() ? "farm" : "field"}>
      <div class="today-hero-frame" classList={{ satellite: satellite(), "field-photo-mode": props.mode === "field-image", "has-season-timeline": !!props.timeline }}>
        <div class="today-hero-top">
          <div class="today-hero-toggle" role="group" aria-label="Field view">
            <button type="button" aria-pressed={props.mode === "illustration"} onClick={() => props.onMode("illustration")}>
              Illustration
            </button>
            <button type="button" aria-pressed={props.mode === "satellite"} onClick={() => props.onMode("satellite")}>
              Satellite
            </button>
            <Show when={props.fieldImage}>
              <button type="button" class="field-image-tab" aria-pressed={props.mode === "field-image"} onClick={() => props.onMode("field-image")}>Field Image</button>
            </Show>
          </div>
          <div class="today-hero-corner">
            <span class="today-date-chip" data-testid="today-date-chip">
              <Show when={isToday()}>
                <span class="today-date-chip-today">Today</span>
              </Show>
              {formatDay(props.date)}
            </span>
            <HeroNotesButton notes={notes} />
          </div>
        </div>
        <Show when={props.timeline}><div class="today-hero-timeline">{props.timeline?.()}</div></Show>
        <div class="today-hero-visual">
        <Show when={props.mode !== "field-image"} fallback={props.fieldImage?.()}>
        <Show
          when={satellite()}
          fallback={
            <Show
              when={farm()}
              fallback={
                <FieldGrowthScene
                  cropId={props.cropId}
                  cropName={props.cropName}
                  boundary={props.boundary}
                  progress={props.progress}
                  date={props.date}
                  condition={point()}
                  conditionCaption={caption()}
                  companionCropId={props.companionCropId ?? null}
                  rowRatio={props.rowRatio ?? null}
                  cropNames={props.cropNames ?? null}
                  compact
                />
              }
            >
              {(current) => (
                <FieldGrowthScene
                  farmBoundary={current().boundary}
                  fields={scene()}
                  cropNames={props.cropNames ?? null}
                  progress={props.progress}
                  date={props.date}
                  condition={point()}
                  conditionCaption={caption()}
                  compact
                />
              )}
            </Show>
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
            outlines={outlines()}
            farmMode={!!farm()}
            fieldName={props.fieldName}
            prediction={farm() ? null : props.prediction}
          />
        </Show>
        </Show>
        <div class="today-hero-second" classList={{ "has-tools": satellite() && ((image().fieldAvailable && !farm()) || image().ndviAvailable) }}>
          <EventBadges events={layers().events} condition={point()} />
          <Show when={satellite() && ((image().fieldAvailable && !farm()) || image().ndviAvailable)}>
            <div class="today-sat-tools" role="group" aria-label="Satellite image options">
              <Show when={image().ndviAvailable}>
                <button type="button" aria-pressed={image().layer === "ndvi"} onClick={() => setGreenness((on) => !on)}>
                  Greenness
                </button>
              </Show>
              <Show when={image().fieldAvailable && !farm()}>
                <button type="button" aria-pressed={wide()} onClick={() => setWide((on) => !on)}>
                  Wider view
                </button>
              </Show>
            </div>
          </Show>
        </div>
        <div class="today-hero-overlay" data-testid="today-stage">
          <Show
            when={!farm()}
            fallback={
              <p class="today-stage-line">
                <strong>Your farm</strong>
                <span>
                  {" "}
                  · {fieldCount()} {fieldCount() === 1 ? "field" : "fields"}
                </span>
              </p>
            }
          >
            <p class="today-stage-line">
              <Show when={props.fieldName}>
                <span class="today-hero-field" data-testid="today-hero-field">
                  {props.fieldName}
                </span>
              </Show>
              <strong>{overlay().name}</strong>
              <Show when={overlay().range}>
                <span> · {overlay().range}</span>
              </Show>
              <Show when={isToday() && props.stage.kind === "stage"}>
                <span class="today-chip growing">Growing</span>
              </Show>
            </p>
          </Show>
          <Show
            when={satellite()}
            fallback={
              <Show when={farm() ? "Each field drawn at its own stage today" : overlay().caption}>
                {(text) => (
                  <span class="today-hero-caption">
                    <span class="today-chip illustration">Illustration</span>
                    <span class="today-scene-date">{text()}</span>
                  </span>
                )}
              </Show>
            }
          >
            <SatelliteCaption pick={pick()} stage={props.stage} date={props.date} />
          </Show>
        </div>
        </div>
      </div>
      <Show when={actualScene() && expectedScene()}>
        <details class="field-image-evidence"><summary>AI estimate vs actual satellite observation · {formatDay(props.date)}</summary>
          <p>Compare the saved AI image with the real satellite observation. The estimate was generated {expectedScene()?.generatedAt?.slice(0,10) ?? 'at an unrecorded time'}.</p>
          <div class="field-image-compare-grid"><figure><img src={sceneImageUrl(expectedScene()?.imagePath) ?? undefined} alt="Expected satellite appearance"/><figcaption>Saved AI estimate</figcaption></figure><figure><img src={sceneImageUrl(actualScene()?.imagePath) ?? undefined} alt="Actual satellite observation"/><figcaption>Actual satellite observation</figcaption></figure></div>
        </details>
      </Show>
      <Show when={props.mode === "illustration" && !farm() && props.date > props.today && props.prediction}>
        <div class="today-illustration-prediction" data-testid="today-illustration-prediction">
          <Show when={pick().mode === "predicted"} fallback={<FutureImageLabel label="Create an indicative satellite look for this date. The illustration is schematic, not an observation." date={props.date} prediction={props.prediction ?? null} />}>
            <button type="button" class="today-predicted-link" onClick={() => props.onMode("satellite")}>
              <AiSparkIcon size={16} /> AI-predicted look available for {formatDay(props.date)}. View satellite look →
            </button>
          </Show>
        </div>
      </Show>
      {/* The notes that used to sit in strips under the scene, verbatim, behind the corner info button. */}
      <HeroNotesPanel notes={notes} onAbout={props.onAbout}>
        <Show when={satellite()}>
          <SatelliteNotes image={image()} overlay={overlayDrawn()} predicted={pick().mode === "predicted"} />
        </Show>
        <Show when={props.hasConditions}>
          <ConditionsLine point={point()} date={props.date} />
        </Show>
        <Show when={!farm()}>
          <CurveLine reading={props.indexStage} date={props.date} today={props.today} onDetails={props.onCurveDetails} />
        </Show>
        {props.notes?.()}
      </HeroNotesPanel>
    </section>
  );
}
