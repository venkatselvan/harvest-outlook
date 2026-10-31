import { A } from "@solidjs/router";
import { Icon } from "../icons";

export interface TodayEmptyProps {
  /** Opens the shell's plant-crop dialog. */
  onPlant: () => void;
  /** False while the crop list behind the plant dialog has not loaded. */
  canPlant: boolean;
}

/** No current crop: the planting entry and the Year plan shortcut replace the hero and slider. */
export function TodayEmpty(props: TodayEmptyProps) {
  return (
    <section class="today-empty" aria-labelledby="today-empty-title">
      <span class="today-empty-icon" aria-hidden="true">
        <Icon name="leaf" size={30} />
      </span>
      <h2 id="today-empty-title">What's growing on this field?</h2>
      <p>Record what you planted and when. Stage dates, prices and care steps follow from that date.</p>
      <div class="today-empty-actions">
        <button type="button" class="btn" onClick={() => props.onPlant()} disabled={!props.canPlant}>
          <Icon name="plus" size={16} /> Plant a crop
        </button>
        <A href="/planner" class="text-link">
          See your year plan <Icon name="arrow" size={14} />
        </A>
      </div>
      <p class="today-empty-hint" hidden={props.canPlant}>
        The crop list is still loading.
      </p>
    </section>
  );
}
