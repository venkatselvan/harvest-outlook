import { For, Show } from "solid-js";
import type { YearPlanOccupant, YearPlanOption } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { longDate, longSpan } from "./format";
import {
  alternativeBasisText,
  displayLabel,
  intercropName,
  isGreenManure,
  isIntercrop,
  profitText,
  replacedByOption,
  slotProfitLine,
  useInsteadText,
  type YearPlanAlternatives,
} from "./model";

/**
 * "Alternatives" under "Your current plan" (EVARA_ACTIONS_SPEC.md 1.3). The server computed these by code when the growing
 * crop and the saved seasons leave no free window. One card per option: its label, a basis chip, its crops with sowing,
 * harvest window and profit for the field, and the buttons. A `replace_planned` card can be used ("Use instead of Pigeon
 * pea": the planned, unsown seasons it takes over are removed when it is applied); a `sown_comparison` card is for
 * comparison only, the sown crop stays, and it has no use button.
 */
export function AlternativesSection(props: {
  alternatives: YearPlanAlternatives;
  /** The review's saved seasons, to name which planned seasons an option takes over. */
  occupied: readonly YearPlanOccupant[];
  appliedOptionIds: readonly string[];
  /** The crop growing now (from the review's own plan), named on a comparison card. */
  growingCropName?: string | null | undefined;
  onOpen: (optionId: string) => void;
  onUse: (optionId: string) => void;
}) {
  const replace = () => props.alternatives.basis === "replace_planned";
  return (
    <Show when={props.alternatives.options.length > 0}>
      <section class="yp-alts" aria-labelledby="yp-alts-heading">
        <h3 class="yp-subhead" id="yp-alts-heading">
          Alternatives
        </h3>
        <p class="yp-alts-intro">
          {replace()
            ? "Other ways to use the year if you give up a season you have planned but not sown yet."
            : "What could have fitted this field from the sowing date. The crop you sowed stays; these are not saved."}
        </p>
        <div class="yp-alt-list" role="list">
          <For each={props.alternatives.options}>
            {(option) => (
              <div role="listitem">
                <AlternativeCard
                  option={option}
                  alternatives={props.alternatives}
                  occupied={props.occupied}
                  growingCropName={props.growingCropName}
                  applied={props.appliedOptionIds.includes(option.optionId)}
                  onOpen={() => props.onOpen(option.optionId)}
                  onUse={() => props.onUse(option.optionId)}
                />
              </div>
            )}
          </For>
        </div>
        <Show when={props.alternatives.limitations.length}>
          <details class="yp-details yp-alts-limits">
            <summary>What these plans leave out</summary>
            <ul>
              <For each={props.alternatives.limitations}>{(l) => <li>{l}</li>}</For>
            </ul>
          </details>
        </Show>
      </section>
    </Show>
  );
}

function AlternativeCard(props: {
  option: YearPlanOption;
  alternatives: YearPlanAlternatives;
  occupied: readonly YearPlanOccupant[];
  growingCropName?: string | null | undefined;
  applied: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  const replaced = () => replacedByOption(props.alternatives, props.option, props.occupied);
  const profit = () => profitText(props.option);
  const canUse = () => props.alternatives.basis === "replace_planned";
  return (
    <article class="yp-alt-card" data-option-id={props.option.optionId}>
      <header class="yp-alt-head">
        <h4>{displayLabel(props.option)}</h4>
        <span class="yp-alt-profit">
          <strong>{profit().value}</strong> <small>{profit().caption}</small>
        </span>
      </header>
      <div class="yp-alt-chips">
        <Chip tone={canUse() ? "info" : "neutral"}>{alternativeBasisText(props.alternatives, props.option, props.occupied, props.growingCropName)}</Chip>
        <Show when={props.applied}>
          <Chip tone="done">In saved seasons</Chip>
        </Show>
      </div>
      <ul class="yp-alt-slots">
        <For each={props.option.slots}>
          {(slot) => (
            <li>
              <strong>
                {isIntercrop(slot) ? intercropName(slot) : slot.cropName}
                <Show when={slot.fixed}>
                  <small> · growing now</small>
                </Show>
                <Show when={isGreenManure(slot)}>
                  <small> · green manure</small>
                </Show>
              </strong>
              <span>
                {slot.fixed ? "Since" : "Sow"} {longDate(slot.sowing)} ·{" "}
                {isGreenManure(slot) ? `ploughed in by ${longDate(slot.harvest.latest)}` : `harvest ${longSpan(slot.harvest.earliest, slot.harvest.latest)}`}
              </span>
              <span class="yp-alt-slot-profit">{slotProfitLine(slot)}</span>
            </li>
          )}
        </For>
      </ul>
      <div class="yp-alt-actions">
        <button type="button" class="btn compact secondary" onClick={() => props.onOpen()}>
          See details
        </button>
        <Show when={canUse()}>
          <button type="button" class="btn compact" disabled={props.applied} onClick={() => props.onUse()}>
            {props.applied ? "Already in saved seasons" : useInsteadText(replaced())}
          </button>
        </Show>
      </div>
    </article>
  );
}
