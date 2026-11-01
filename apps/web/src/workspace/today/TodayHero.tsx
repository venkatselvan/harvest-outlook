import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import type { NdviSeries, SceneRef } from "@harvest/contracts";
import { FieldGrowthScene } from "../FieldGrowthScene";
import type { FieldBoundary } from "../fieldGeometry";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import { formatDay, rangeLabel, sceneDate, sceneFor, type ScenePick, type StageAt } from "./model";
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

/** Normalised polygon points (0..1) of the field boundary inside the rendered image bbox (EPSG:4326, square PNG). */
function outlinePoints(boundary: FieldBoundary | null, bbox: NdviSeries["imageBbox"] | null): string | null {
  const ring = boundary?.coordinates[0];
  if (!ring || ring.length < 4 || !bbox) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (!(maxLon > minLon && maxLat > minLat)) return null;
  return ring
    .slice(0, -1)
    .map(([lon, lat]) => `${(((lon ?? 0) - minLon) / (maxLon - minLon)).toFixed(4)},${((maxLat - (lat ?? 0)) / (maxLat - minLat)).toFixed(4)}`)
    .join(" ");
}

function SatelliteScene(props: {
  pick: ScenePick;
  date: string;
  stage: StageAt;
  boundary: FieldBoundary | null;
  imageBbox: NdviSeries["imageBbox"] | null;
}) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const scene = () => (props.pick.mode === "none" ? null : props.pick.scene);
  const src = () => sceneImageUrl(scene()?.imagePath);
  const outline = () => (props.pick.mode === "illustration" ? null : outlinePoints(props.boundary, props.imageBbox));
  const alt = () => {
    const pick = props.pick;
    if (pick.mode === "illustration")
      return `Illustration of a typical ${stageName(props.stage)}, made from the satellite image of ${formatDay(pick.derivedFrom ? sceneDate(pick.derivedFrom) : null)}. Not an observation.`;
    if (pick.mode === "none") return "";
    const cloud = pick.scene.cloudPct != null ? `, ${Math.round(pick.scene.cloudPct)}% cloud in the scene` : "";
    return `${pick.mode === "latest" ? "Latest satellite" : "Satellite"} image of your field, observed ${formatDay(sceneDate(pick.scene))}${cloud}`;
  };
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
        <div class="today-sat-box">
          <img
            src={src()!}
            alt={alt()}
            data-scene-kind={props.pick.mode}
            onError={() => setFailed(src())}
          />
          <Show when={outline()}>
            <svg class="today-sat-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={outline()!} vector-effect="non-scaling-stroke" />
            </svg>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Caption chips for the satellite view: kind, date and cloud, or the illustration label. */
function SatelliteCaption(props: { pick: ScenePick; stage: StageAt }) {
  return (
    <Switch>
      <Match when={props.pick.mode === "observed" || props.pick.mode === "latest"}>
        {(() => {
          const scene = () => (props.pick as Extract<ScenePick, { scene: SceneRef }>).scene;
          return (
            <span class="today-hero-caption">
              <span class="today-chip observed">Observed</span>
              <span class="today-scene-date">
                {props.pick.mode === "latest" ? "Latest image " : ""}
                {formatDay(sceneDate(scene()))}
              </span>
              <Show when={scene().cloudPct != null}>
                <span class="today-chip">Cloud {Math.round(scene().cloudPct!)}%</span>
              </Show>
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

export function TodayHero(props: TodayHeroProps) {
  const overlay = createMemo(() => stageOverlay(props.stage));
  const pick = createMemo(() => sceneFor(props.scenes, props.date, props.today, stageIdOf(props.stage)));
  const isToday = () => props.date === props.today;
  return (
    <section class="today-hero" aria-label="Your field">
      <div class="today-hero-frame" classList={{ satellite: props.mode === "satellite" }}>
        <Show
          when={props.mode === "satellite"}
          fallback={
            <FieldGrowthScene
              cropId={props.cropId}
              cropName={props.cropName}
              boundary={props.boundary}
              progress={props.progress}
              date={props.date}
              compact
            />
          }
        >
          <SatelliteScene pick={pick()} date={props.date} stage={props.stage} boundary={props.boundary} imageBbox={props.imageBbox} />
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
            when={props.mode === "satellite"}
            fallback={
              <Show when={overlay().caption}>
                <span class="today-hero-caption">
                  <span class="today-chip illustration">Illustration</span>
                  <span class="today-scene-date">{overlay().caption}</span>
                </span>
              </Show>
            }
          >
            <SatelliteCaption pick={pick()} stage={props.stage} />
          </Show>
        </div>
      </div>
    </section>
  );
}
