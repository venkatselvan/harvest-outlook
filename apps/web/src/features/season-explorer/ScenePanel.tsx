import { Match, Show, Switch, createMemo } from "solid-js";
import { SceneCanvas } from "../season-scene";
import { normalizedUrl } from "../photo-region/types";
import { toKeyframes } from "../../lib/plan-api";
import { SCHEMATIC_REASON_TEXT, type SeasonState } from "./controller";
import type { SceneChoice } from "./model";

/** Scene for the selected date: an actual journal photo wins; a past date without one stays empty; otherwise the labelled illustration. */
export function ScenePanel(props: { state: SeasonState; choice: SceneChoice; onGenerate: () => void }) {
  const base = () => (props.state.media ? normalizedUrl(props.state.media.id) : null);
  const keyframes = createMemo(() => toKeyframes(props.state.visuals));
  const polygon = () => props.state.media?.region?.polygon ?? [];
  const working = () => props.state.generate.status === "working";
  const hasStages = () => (props.state.visuals?.stages.length ?? 0) > 0;
  return (
    <section class="card se-panel" aria-labelledby="scene-h" data-testid="panel-scene">
      <h2 id="scene-h">Your field</h2>
      <Switch>
        <Match when={props.choice.kind === "photo" && props.choice}>
          {(c) => (
            <figure class="se-photo" data-testid="scene-photo">
              <img src={`/api/v1/media/${(c() as { assetId: string }).assetId}/content?variant=normalized`} alt="Your uploaded field photo for the selected date" />
              <figcaption data-testid="scene-photo-label">{(c() as { label: string }).label}</figcaption>
            </figure>
          )}
        </Match>
        <Match when={props.choice.kind === "absent" && props.choice}>
          {(c) => (
            <figure class="se-photo" data-testid="scene-absent">
              <Show when={base()} fallback={<div class="se-photo__empty">No photo for this date</div>}>
                {(u) => <img src={u()} alt="Your base farm photo, shown for reference only" />}
              </Show>
              <figcaption>{(c() as { message: string }).message}</figcaption>
            </figure>
          )}
        </Match>
        <Match when={props.choice.kind === "illustration" && props.choice}>
          {(c) => (
            <SceneCanvas
              baseImageUrl={base()}
              polygon={polygon()}
              keyframes={keyframes()}
              stageProgress={(c() as { progress: import("../season-scene").StageBlend }).progress}
              mode={props.state.mode ?? "synthetic"}
            />
          )}
        </Match>
      </Switch>
      <Show when={!props.state.media}>
        <p class="se-help">No farm photo was found for this farm, so a plain backdrop is used. Add a photo and region on the farm page.</p>
      </Show>
      <div class="se-generate">
        <button type="button" class="btn" onClick={props.onGenerate} disabled={working() || !props.state.media} data-testid="generate-illustrations">
          {hasStages() && props.state.visuals!.stages.some((s) => s.state === "ready") ? "Regenerate illustrations" : "Generate illustrations"}
        </button>
        <p role="status" aria-live="polite" data-testid="generate-status">
          {props.state.generate.message}
        </p>
        <Show when={props.state.generate.reasons.length > 0}>
          <ul class="se-list" data-testid="generate-reasons">
            {props.state.generate.reasons.map((r) => (
              <li>{SCHEMATIC_REASON_TEXT[r] ?? r.replace(/_/g, " ")}</li>
            ))}
          </ul>
        </Show>
        <p class="se-help">Illustrations are generated or drawn pictures of how a stage could look in your outlined area. They are not observations or predictions.</p>
      </div>
    </section>
  );
}
