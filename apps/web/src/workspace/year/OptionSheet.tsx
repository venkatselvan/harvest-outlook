import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { PriceTrend, ScoreComponents, YearPlanOption, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { PriceTrendChart } from "../ui/PriceTrendChart";
import { ScoreRing } from "../ui/ScoreRing";
import { Sheet } from "../ui/Sheet";
import { formatInr, formatInrRange, formatKgRange, formatPerKgRange, longDate, longSpan, parseIso } from "./format";
import {
  costBasisText,
  displayLabel,
  editedFrom,
  isLegume,
  priceBasisText,
  yieldBasisText,
  type CropChoice,
  type DraftSlot,
} from "./model";
import { profitText } from "./PlanCalendar";
import { SlotEditor } from "./SlotEditor";

export type TrendState =
  | { status: "loading" }
  | { status: "ready"; trend: PriceTrend }
  | { status: "error"; message: string };

const COMPONENTS: { key: keyof ScoreComponents; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "yield", label: "Yield" },
  { key: "soilRotation", label: "Soil and rotation" },
  { key: "water", label: "Water and climate" },
  { key: "confidence", label: "Data confidence" },
];

/** First slot to show: the requested one, else the first crop still to be sown, else the first slot. */
export function initialSlot(option: YearPlanOption, slotId: string | null): YearPlanSlot {
  return (
    option.slots.find((s) => s.slotId === slotId) ?? option.slots.find((s) => !s.fixed) ?? option.slots[0]!
  );
}

/**
 * Detail sheet for one option: reasons, the chosen crop's yield, price at harvest (with the 36-month trend), cost and
 * profit as ranges with one basis line each, the score build-up with its fixed weights, what could change the result,
 * and the sources. Edit swaps the body for the inline editor; Use this plan opens the confirmation.
 */
export function OptionSheet(props: {
  review: YearPlanReview;
  option: YearPlanOption;
  slotId: string | null;
  applied: boolean;
  editing: boolean;
  choices: readonly CropChoice[];
  rescoreBusy: boolean;
  rescoreError: string;
  trend: (slot: YearPlanSlot) => TrendState | undefined;
  onSelectSlot: (slotId: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onRescore: (drafts: DraftSlot[]) => void;
  onUse: () => void;
  onClose: () => void;
}) {
  const slot = () => initialSlot(props.option, props.slotId);
  const profit = () => profitText(props.option);
  return (
    <Sheet
      title={props.editing ? `Edit ${displayLabel(props.option).toLowerCase()}` : displayLabel(props.option)}
      closeLabel="Close plan details"
      onClose={() => props.onClose()}
      class="yp-sheet"
      subtitle={
        <Show when={!props.editing}>
          <div class="yp-sheet-summary">
            <ScoreRing score={props.option.score} size={44} />
            <div>
              <strong>{profit().value}</strong>
              <span>{profit().caption} over the 12 months</span>
            </div>
          </div>
          <Show when={editedFrom(props.option) || props.applied || props.option.warnings.length}>
            <div class="yp-sheet-chips">
              <Show when={editedFrom(props.option)}>{(from) => <Chip tone="info">Edited from {from()}</Chip>}</Show>
              <Show when={props.applied}>
                <Chip tone="done">In saved seasons</Chip>
              </Show>
              <For each={props.option.warnings}>{(w) => <Chip tone="watch">{w}</Chip>}</For>
            </div>
          </Show>
        </Show>
      }
      footer={
        <Show when={!props.editing}>
          <Show when={props.option.editable}>
            <button type="button" class="btn secondary" onClick={() => props.onEdit()}>
              Edit
            </button>
          </Show>
          <button type="button" class="btn" disabled={props.applied} onClick={() => props.onUse()}>
            {props.applied ? "Already in saved seasons" : "Use this plan"}
          </button>
        </Show>
      }
    >
      <Show
        when={!props.editing}
        fallback={
          <SlotEditor
            option={props.option}
            horizon={props.review.scenario.horizon}
            choices={props.choices}
            busy={props.rescoreBusy}
            error={props.rescoreError}
            onCancel={() => props.onCancelEdit()}
            onSubmit={(drafts) => props.onRescore(drafts)}
          />
        }
      >
        <Show when={props.option.reasons.length}>
          <section class="yp-sheet-section" aria-labelledby="yp-why">
            <h3 id="yp-why">Why this plan</h3>
            <ul class="yp-reasons">
              <For each={props.option.reasons}>{(reason) => <li>{reason.text}</li>}</For>
            </ul>
          </section>
        </Show>
        <Show when={props.option.slots.length > 1}>
          <div class="yp-slot-tabs" role="group" aria-label="Crops in this plan">
            <For each={props.option.slots}>
              {(s) => (
                <button
                  type="button"
                  class="yp-slot-tab"
                  aria-pressed={s.slotId === slot().slotId}
                  onClick={() => props.onSelectSlot(s.slotId)}
                >
                  {s.cropName}
                  <Show when={s.fixed}>
                    <small>growing now</small>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <SlotDetail slot={slot()} trend={props.trend(slot())} />
        <section class="yp-sheet-section" aria-labelledby="yp-score">
          <h3 id="yp-score">How the score is built</h3>
          <ul class="yp-bars">
            <For each={COMPONENTS}>
              {(c) => {
                const value = () => Math.round(props.option.components[c.key] * 100);
                return (
                  <li>
                    <span class="yp-bar-label">
                      {c.label}
                      <small>weight {props.review.weights[c.key]}</small>
                    </span>
                    <span class="yp-bar" role="img" aria-label={`${c.label}: ${value()} out of 100, weight ${props.review.weights[c.key]}`}>
                      <span style={{ width: `${value()}%` }} />
                    </span>
                    <span class="yp-bar-value" aria-hidden="true">
                      {value()}
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        </section>
      </Show>
    </Sheet>
  );
}

function SlotDetail(props: { slot: YearPlanSlot; trend: TrendState | undefined }) {
  const s = () => props.slot;
  const price = () => s().price;
  const harvestMonth = () => parseIso(s().harvest.latest).m;
  const trendReady = () => (props.trend?.status === "ready" ? props.trend.trend : undefined);
  const trendError = () => (props.trend?.status === "error" ? props.trend.message : undefined);
  // Keep the open "What could change this" state per slot.
  const [openRisks, setOpenRisks] = createSignal(false);
  createEffect(on(() => s().slotId, () => setOpenRisks(false), { defer: true }));
  return (
    <section class="yp-slot-detail" aria-labelledby="yp-slot-title">
      <div class="yp-slot-heading">
        <h3 id="yp-slot-title">
          {s().cropName} · {s().productName}
        </h3>
        <Show when={s().fixed}>
          <Chip tone="growing">Growing now</Chip>
        </Show>
        <Show when={!s().fixed && isLegume(s().cropId)}>
          <Chip tone="legume">Legume</Chip>
        </Show>
      </div>
      <p class="yp-slot-dates">
        {s().fixed ? "Growing since" : "Sow"} {longDate(s().sowing)} · harvest {longSpan(s().harvest.earliest, s().harvest.latest)}
      </p>
      <Show when={s().transitionNote}>
        <p class="yp-slot-note">{s().transitionNote}</p>
      </Show>
      <dl class="yp-estimates">
        <div>
          <dt>Yield</dt>
          <dd>
            <Show when={s().yieldKgPerHa} fallback={<strong>Yield not sourced</strong>}>
              {(y) => <strong>{formatKgRange(y())} per ha</strong>}
            </Show>
            <span class="yp-basis">{yieldBasisText(s())}</span>
          </dd>
        </div>
        <div>
          <dt>Price at harvest</dt>
          <dd>
            <Show
              when={price()?.status === "available" && price()?.range ? price() : undefined}
              fallback={
                <>
                  <strong>No price series yet</strong>
                  <span class="yp-basis">Too few recent mandi quotes to give a range</span>
                </>
              }
            >
              {(p) => (
                <>
                  <strong>{formatPerKgRange(p().range!)}</strong>
                  <span class="yp-basis">{priceBasisText(p())}</span>
                  <Show when={props.trend?.status === "loading"}>
                    <span class="yp-basis" role="status">
                      Loading the 36-month price trend…
                    </span>
                  </Show>
                  <Show when={trendError()}>{(message) => <span class="yp-basis">{message()}</span>}</Show>
                  <Show when={trendReady()}>
                    {(trend) => (
                      <PriceTrendChart
                        trend={trend()}
                        productLabel={`${s().cropName} (${s().productName.toLowerCase()})`}
                        highlightMonth={harvestMonth()}
                      />
                    )}
                  </Show>
                </>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <Show when={s().cost?.a2flPerHa != null} fallback={<strong>Cost not sourced</strong>}>
              <strong>{formatInr(s().cost!.a2flPerHa!)} per ha</strong>
            </Show>
            <span class="yp-basis">{costBasisText(s().cost)}</span>
          </dd>
        </div>
        <div>
          <dt>Profit</dt>
          <dd>
            <Show when={s().profitPerHa} fallback={<strong>Not calculated</strong>}>
              {(p) => <strong>{formatInrRange(p())} per ha</strong>}
            </Show>
            <span class="yp-basis">
              {s().profitPerHa ? "Yield times price, minus the A2+FL cost" : "Needs both a price range and a sourced cost"}
            </span>
          </dd>
        </div>
      </dl>
      <Show when={s().uncertainties.length}>
        <details class="yp-details" open={openRisks()} onToggle={(e) => setOpenRisks(e.currentTarget.open)}>
          <summary>What could change this</summary>
          <ul>
            <For each={s().uncertainties}>{(u) => <li>{u}</li>}</For>
          </ul>
        </details>
      </Show>
      <Show when={s().basis.length}>
        <details class="yp-details">
          <summary>Sources</summary>
          <ul class="yp-sources">
            <For each={s().basis}>
              {(b) => (
                <li>
                  <Show when={b.url} fallback={<span>{b.label}</span>}>
                    {(url) => (
                      <a href={url()} target="_blank" rel="noreferrer">
                        {b.label}
                      </a>
                    )}
                  </Show>
                  <Show when={b.scope}>{(scope) => <small> · {scope()}</small>}</Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}
