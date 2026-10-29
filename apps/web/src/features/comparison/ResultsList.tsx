import { For, Show } from "solid-js";
import { OutcomeBadge } from "./badges";
import { MAX_COMPARE, humanize, itemKey } from "./logic";
import type { CompareItem } from "./types";

export function ResultsList(props: { items: CompareItem[]; selected: string[]; blockedNotice: boolean; onToggle: (key: string) => void }) {
  return (
    <section aria-labelledby="results-title" data-testid="results">
      <h2 id="results-title">Crops for your inputs ({props.items.length})</h2>
      <p class="cmp-muted" id="results-help">Tick up to {MAX_COMPARE} to compare side by side. {props.selected.length} selected.</p>
      <Show when={props.blockedNotice}>
        <p role="alert" class="cmp-warn">You can compare at most {MAX_COMPARE} crops. Untick one first.</p>
      </Show>
      <ul class="cmp-results">
        <For each={props.items}>
          {(i) => {
            const key = itemKey(i);
            const checked = () => props.selected.includes(key);
            return (
              <li class="cmp-result" data-testid="result-row" data-product={i.productId}>
                <label class="cmp-pick">
                  <input type="checkbox" checked={checked()} onChange={(e) => { props.onToggle(key); e.currentTarget.checked = checked(); }} aria-describedby="results-help" />
                  <span class="cmp-pick-text">
                    <strong>{i.cropName}: {i.productName}</strong>
                    <span class="cmp-muted">{i.season ? `Season: ${humanize(i.season)}` : "Season: not sourced for your region"}</span>
                  </span>
                </label>
                <div class="cmp-result-meta">
                  <OutcomeBadge outcome={i.outcome} />
                  <span class="cmp-cov">Evidence coverage {i.completeness.known}/{i.completeness.total} dimensions</span>
                </div>
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}
