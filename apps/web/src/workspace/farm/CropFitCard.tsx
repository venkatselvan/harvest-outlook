import { For, Show } from "solid-js";
import type { CropFitCandidate } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { ScoreRing } from "../ui/ScoreRing";
import {
  cardChecks,
  displayName,
  harvestText,
  priceHarvestText,
  priceNowText,
  profitText,
  soilChipText,
  sowingText,
  verdictTone,
  yieldText,
  type PickCard,
} from "./cropFitModel";

/** Soil match chips ("N low · needs high") in the verdict colour; a fallback chip when no report is confirmed. */
export function SoilChips(props: { candidate: CropFitCandidate; max?: number }) {
  return (
    <span class="cf-soil-chips">
      <Show when={props.candidate.soil.status === "compared"} fallback={<Chip tone="neutral">No confirmed soil report</Chip>}>
        <For each={cardChecks(props.candidate, props.max ?? 4)}>{(s) => <Chip tone={verdictTone(s.verdict)}>{soilChipText(s)}</Chip>}</For>
        <Show when={props.candidate.soil.checks.length > (props.max ?? 4)}>
          <span class="cf-more">+{props.candidate.soil.checks.length - (props.max ?? 4)} more</span>
        </Show>
      </Show>
    </span>
  );
}

/**
 * One top pick (ROUND2_SPEC.md 4.2): crop, headline, score ring, up to three reasons and the four rows (price now and at
 * harvest, yield, profit for the field, soil match). The crop name is the button that opens the detail sheet; its
 * click area covers the card.
 */
export function CropFitCard(props: { card: PickCard; fieldAreaHa: number | null; onOpen: () => void }) {
  const c = () => props.card.candidate;
  const profit = () => profitText(c(), props.fieldAreaHa);
  return (
    <article class="cf-card">
      <div class="cf-card-head">
        <div class="cf-card-titles">
          <p class="cf-card-rank">Pick {props.card.pick.rank}</p>
          <h3>
            <button type="button" class="cf-card-open" onClick={() => props.onOpen()}>
              {displayName(c())}
            </button>
          </h3>
          <p class="cf-card-headline">{props.card.pick.headline}</p>
        </div>
        <ScoreRing score={c().score} size={48} label={`Fit score ${Math.round(c().score)} out of 100`} />
      </div>
      <Show when={props.card.pick.reasons.length}>
        <ul class="cf-reasons">
          <For each={props.card.pick.reasons.slice(0, 3)}>{(r) => <li>{r.text}</li>}</For>
        </ul>
      </Show>
      <dl class="cf-rows">
        <div>
          <dt>Price</dt>
          <dd>
            Now {priceNowText(c())}
            <span class="cf-sub">{priceHarvestText(c())}</span>
          </dd>
        </div>
        <div>
          <dt>Yield</dt>
          <dd>{yieldText(c())}</dd>
        </div>
        <div>
          <dt>{props.fieldAreaHa && c().profitForField ? "Profit for your field" : "Profit"}</dt>
          <dd>
            {profit().text}
            <Show when={profit().caption}>
              <span class="cf-sub">{profit().caption}</span>
            </Show>
          </dd>
        </div>
        <div>
          <dt>Soil match</dt>
          <dd>
            <SoilChips candidate={c()} />
          </dd>
        </div>
      </dl>
      <p class="cf-card-dates">
        {sowingText(c())} · {harvestText(c())}
      </p>
    </article>
  );
}
