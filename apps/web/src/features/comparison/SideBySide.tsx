import { For } from "solid-js";
import { CropCard } from "./CropCard";
import { itemKey } from "./logic";
import type { CompareItem } from "./types";

export function SideBySide(props: { items: CompareItem[]; assumedPriceFor: (productId: string) => boolean; onChoose: (i: CompareItem) => void; onRemove: (i: CompareItem) => void }) {
  return (
    <section aria-labelledby="sbs-title" class="cmp-sbs" data-testid="side-by-side">
      <h2 id="sbs-title">Side by side ({props.items.length} of 3)</h2>
      <p class="cmp-muted">On a narrow screen the cards scroll sideways. Each card keeps its own evidence labels.</p>
      <div class="cmp-sbs-track" role="group" aria-label="Selected crops">
        <For each={props.items}>
          {(i) => (
            <div class="cmp-sbs-cell" data-key={itemKey(i)}>
              <CropCard item={i} assumedPriceUsed={props.assumedPriceFor(i.productId)} onChoose={props.onChoose} onRemove={props.onRemove} />
            </div>
          )}
        </For>
      </div>
    </section>
  );
}
