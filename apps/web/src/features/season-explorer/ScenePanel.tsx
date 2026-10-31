import { Show } from "solid-js";
import type { SeasonState } from "./controller";
import type { SceneChoice } from "./model";

/** Show only the dated photo identified by the timeline; never substitute generated imagery or another date's photo. */
export function ScenePanel(props: {
  state: SeasonState;
  choice: SceneChoice;
  onGenerate?: () => void;
}) {
  const photo = () => (props.choice.kind === "photo" ? props.choice : null);
  return (
    <section
      class="card se-panel"
      aria-labelledby="scene-h"
      data-testid="panel-scene"
    >
      <h2 id="scene-h">Dated field photo</h2>
      <Show
        when={photo()}
        fallback={
          <div class="se-photo" data-testid="scene-absent">
            <p class="se-photo__empty">No photo recorded for this date</p>
            <p class="se-help">
              The stage estimate below uses your planting date and sourced crop
              durations. A field observation is needed to confirm the actual
              crop stage.
            </p>
            <a class="text-link" href="/journal">
              Add a dated field observation
            </a>
          </div>
        }
      >
        {(photo) => (
          <figure class="se-photo" data-testid="scene-photo">
            <img
              src={`/api/v1/media/${photo().assetId}/content?variant=normalized`}
              alt="Your uploaded field photo for the selected date"
            />
            <figcaption data-testid="scene-photo-label">
              {photo().label}
            </figcaption>
          </figure>
        )}
      </Show>
    </section>
  );
}
