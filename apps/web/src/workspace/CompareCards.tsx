import { For, Show } from "solid-js";
import type { CompareItem, Outcome } from "../features/comparison/types";
import { CHIP_TITLE, cardRows } from "./compare-cards";
import "./compare-cards.css";

const OUTCOME_TEXT: Record<Outcome, string> = {
  eligible: "Matches sourced rules",
  requires_review: "Needs review",
  unknown: "Evidence incomplete",
  ineligible: "Outside requirements",
  excluded_by_farmer: "Excluded",
};

/**
 * "Compare crops · N of 3" (SEASON_STRIP_COMPARE_SPEC.md part 2): the selected crops as equal-width cards, up to three in a
 * row and one column on narrow containers. Each card names the crop (with a remove control), shows Season, Planting window,
 * Duration and Water need with the source of each figure, keeps the screening outcome the comparison already shows, and
 * opens the existing detail (the evidence sheet). The crop picker stays above, in the page.
 */
export function CompareCards(props: {
  items: readonly CompareItem[];
  max?: number;
  onRemove: (item: CompareItem) => void;
  onDetail: (item: CompareItem) => void;
}) {
  const max = () => props.max ?? 3;
  return (
    <section class="cmp-cards" aria-labelledby="cmp-cards-heading" data-testid="compare-cards">
      <h2 id="cmp-cards-heading" class="cmp-cards-title">
        Compare crops · {props.items.length} of {max()}
      </h2>
      <div class="cmp-cards-grid">
        <For each={props.items}>
          {(item) => (
            <article class="cmp-card" aria-labelledby={`cmp-card-${item.productId}`} data-product={item.productId}>
              <header class="cmp-card-head">
                <div class="cmp-card-name">
                  <h3 id={`cmp-card-${item.productId}`}>{item.cropName}</h3>
                  <small>{item.productName}</small>
                </div>
                <button
                  type="button"
                  class="cmp-card-remove"
                  aria-label={`Remove ${item.cropName} from comparison`}
                  onClick={() => props.onRemove(item)}
                >
                  ×
                </button>
              </header>
              <span class={`outcome-tag ${item.outcome}`}>{OUTCOME_TEXT[item.outcome]}</span>
              <dl class="cmp-card-rows">
                <For each={cardRows(item)}>
                  {(row) => (
                    <div class="cmp-card-row" data-row={row.key}>
                      <dt>{row.label}</dt>
                      <dd>
                        <span class="cmp-card-value" classList={{ "is-missing": row.chip === null }}>
                          {row.value}
                        </span>
                        <Show when={row.chip}>{(chip) => <span class="cmp-chip" data-chip={chip()} title={CHIP_TITLE[chip()]}>{chip()}</span>}</Show>
                        <Show when={row.note}>{(note) => <small class="cmp-card-note">{note()}</small>}</Show>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
              <button type="button" class="btn compact secondary cmp-card-detail" onClick={() => props.onDetail(item)}>
                View detail
              </button>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}
