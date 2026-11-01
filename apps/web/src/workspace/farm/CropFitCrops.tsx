import { For, Show } from "solid-js";
import type { PricedCommodity } from "@harvest/contracts";
import type { CompareItem } from "../../features/comparison/types";
import { Icon } from "../icons";
import { Chip, type ChipTone } from "../ui/Chip";
import type { LibraryChipKind, LibraryRow } from "./cropFitLibrary";
import "./crop-fit.css";

const CHIP_TONE: Record<LibraryChipKind, ChipTone> = {
  growing: "growing",
  saved: "info",
  plan: "forecast",
  fit: "neutral",
  recorded: "observed",
};
/**
 * Default library view: one row per crop for this farm with its chips and, when the market inventory has the crop, the
 * existing profile link. In the Compare browser the row toggles the crop's comparison item instead.
 */
export function CropsForYourFarm(props: {
  rows: readonly LibraryRow[];
  entryFor?: ((row: LibraryRow) => PricedCommodity | undefined) | undefined;
  compareItem?: ((row: LibraryRow) => CompareItem | undefined) | undefined;
  selected?: string[] | undefined;
  onToggle?: ((item: CompareItem) => void) | undefined;
  onProfile?: ((entry: PricedCommodity) => void) | undefined;
}) {
  return (
    <div class="commodity-inventory-list farm-crop-list" role="list">
      <For each={props.rows}>
        {(row) => {
          const entry = () => props.entryFor?.(row);
          const item = () => props.compareItem?.(row);
          const isSelected = () => !!item() && !!props.selected?.includes(item()!.productId);
          const body = () => (
            <>
              <span class="crop-mini-icon">
                <Icon name="leaf" />
              </span>
              <span>
                <strong>{row.name}</strong>
                <small>{row.note}</small>
                <span class="farm-crop-chips">
                  <For each={row.chips}>{(chip) => <Chip tone={CHIP_TONE[chip.kind]}>{chip.text}</Chip>}</For>
                </span>
              </span>
              <Show when={item()}>
                <span class="crop-checkbox">
                  <Show when={isSelected()}>
                    <Icon name="check" size={14} />
                  </Show>
                </span>
              </Show>
            </>
          );
          return (
            <article
              role="listitem"
              class={`commodity-inventory-row ${isSelected() ? "selected" : ""}`}
            >
              <Show
                when={item() || entry()}
                fallback={<div class="crop-option">{body()}</div>}
              >
                <button
                  class={`crop-option ${isSelected() ? "selected" : ""}`}
                  onClick={() => {
                    const found = item();
                    if (found && props.onToggle) props.onToggle(found);
                    else if (entry()) props.onProfile?.(entry()!);
                  }}
                >
                  {body()}
                </button>
              </Show>
              <Show when={entry()}>
                <button
                  class="commodity-profile-button"
                  aria-label={`Open ${row.name} profile`}
                  onClick={() => props.onProfile?.(entry()!)}
                >
                  Profile
                  <Icon name="arrow" size={12} />
                </button>
              </Show>
            </article>
          );
        }}
      </For>
      <Show when={!props.rows.length}>
        <p class="small-empty">No crop matches this search.</p>
      </Show>
    </div>
  );
}
