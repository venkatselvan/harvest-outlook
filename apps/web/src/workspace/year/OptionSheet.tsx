import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { PriceTrend, ScoreComponents, YearPlanOption, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import type { CropFitCandidate } from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSparkInline } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { PriceTrendChart } from "../ui/PriceTrendChart";
import { ScoreRing } from "../ui/ScoreRing";
import { Sheet } from "../ui/Sheet";
import { EstimateBlocks } from "./Estimates";
import {
  formatInr,
  formatInrRange,
  formatKgRange,
  formatPerKgRange,
  longDate,
  longSpan,
  parseIso,
  shortSpan,
} from "./format";
import {
  CALENDAR_TEXT_MAX,
  applyPick,
  calendarWarnings,
  costBasisText,
  displayLabel,
  draftFromOption,
  editedFrom,
  fieldYieldText,
  greenManureName,
  intercropName,
  isGreenManure,
  isIntercrop,
  isLegume,
  nitrogenCreditText,
  pickChangesDraft,
  pickerCurrent,
  priceBasisText,
  profitText,
  shareBasisText,
  shareText,
  swapContext,
  yieldBasisText,
  type CropChoice,
  type DraftSlot,
} from "./model";
import { idlePenaltyText } from "./model";
import { SlotEditor } from "./SlotEditor";
import { SwapSheet } from "./SwapSheet";

export type TrendState =
  { status: "loading" } | { status: "ready"; trend: PriceTrend } | { status: "error"; message: string };

const COMPONENTS: { key: keyof ScoreComponents; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "yield", label: "Yield" },
  { key: "soilRotation", label: "Soil and rotation" },
  { key: "water", label: "Water and climate" },
  { key: "confidence", label: "Data confidence" },
];

/** First slot to show: the requested one, else the first crop still to be sown, else the first slot. */
export function initialSlot(option: YearPlanOption, slotId: string | null): YearPlanSlot {
  return option.slots.find((s) => s.slotId === slotId) ?? option.slots.find((s) => !s.fixed) ?? option.slots[0]!;
}

/**
 * Detail sheet for one option: the plan's profit (central, likely, possible; per hectare and for the field), reasons
 * with their AI mark, where the field rests, the chosen crop's yield, price at harvest (with the 36-month trend), cost
 * and profit with one basis line each, the score build-up with its fixed weights, what could change the result, and the
 * sources. Edit swaps the body for the inline editor; Use this plan opens the confirmation.
 */
export function OptionSheet(props: {
  farmId: string;
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
  const [swapKey, setSwapKey] = createSignal<string | null>(null);
  const nameOf = (cropId: string) => props.choices.find((c) => c.cropId === cropId)?.name ?? cropId;
  const swapDrafts = () => draftFromOption(props.option);
  const swapTarget = () => {
    const key = swapKey();
    return key ? swapDrafts().find((d) => d.key === key) : undefined;
  };
  const swapPicker = () => {
    const key = swapKey();
    const target = swapTarget();
    if (!key || !target) return undefined;
    const context = swapContext(
      swapDrafts(),
      key,
      props.review.scenario.previousCropId,
      props.review.scenario.horizon,
    );
    return context ? { context, current: pickerCurrent(target), key, target } : undefined;
  };
  /** Picking a crop swaps it into the draft and asks for the code re-score; picking what is already there only closes the sheet. */
  const onSwapPick = (candidate: CropFitCandidate) => {
    const picker = swapPicker();
    setSwapKey(null);
    if (!picker || !pickChangesDraft(picker.target, candidate)) return;
    props.onRescore(applyPick(swapDrafts(), picker.key, candidate));
  };
  const profit = () => profitText(props.option);
  const warnings = () => calendarWarnings(props.option.warnings);
  const longWarnings = () => props.option.warnings.filter((w) => w.length > CALENDAR_TEXT_MAX);
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
              <span>{profit().caption}</span>
            </div>
          </div>
          <Show when={editedFrom(props.option) || props.applied || warnings().short.length}>
            <div class="yp-sheet-chips">
              <Show when={editedFrom(props.option)}>{(from) => <Chip tone="info">Edited from {from()}</Chip>}</Show>
              <Show when={props.applied}>
                <Chip tone="done">In saved seasons</Chip>
              </Show>
              <For each={warnings().short}>{(w) => <Chip tone="watch">{w}</Chip>}</For>
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
            farmId={props.farmId}
            previousCropId={props.review.scenario.previousCropId}
            horizon={props.review.scenario.horizon}
            choices={props.choices}
            busy={props.rescoreBusy}
            error={props.rescoreError}
            onCancel={() => props.onCancelEdit()}
            onSubmit={(drafts) => props.onRescore(drafts)}
          />
        }
      >
        <Show when={props.option.totalProfitEstimate}>
          {(estimate) => (
            <section class="yp-sheet-section" aria-labelledby="yp-total">
              <h3 id="yp-total">Profit for the whole plan</h3>
              <EstimateBlocks
                perHa={estimate()}
                forField={props.option.totalProfitForField}
                areaHa={props.option.fieldAreaHa}
              />
            </section>
          )}
        </Show>
        <Show when={longWarnings().length}>
          <section class="yp-sheet-section" aria-labelledby="yp-notes">
            <h3 id="yp-notes">Notes on this plan</h3>
            <ul class="yp-notes">
              <For each={longWarnings()}>{(w) => <li>{w}</li>}</For>
            </ul>
          </section>
        </Show>
        <Show when={props.option.reasons.length}>
          <section class="yp-sheet-section" aria-labelledby="yp-why">
            <div class="yp-sheet-section-head">
              <h3 id="yp-why">Why this plan</h3>
              <Show when={props.option.origin === "model"}>
                <AiSparkInline use="year_plan_select" label="Reasons by AI" />
              </Show>
              <Show when={props.option.origin === "deterministic"}>
                <Chip tone="typical">Calculated</Chip>
              </Show>
            </div>
            <ul class="yp-reasons">
              <For each={props.option.reasons}>{(reason) => <li>{reason.text}</li>}</For>
            </ul>
          </section>
        </Show>
        <Show when={props.option.gaps?.length}>
          <section class="yp-sheet-section" aria-labelledby="yp-gaps">
            <h3 id="yp-gaps">Where the field rests</h3>
            <ul class="yp-gap-list">
              <For each={props.option.gaps}>
                {(gap) => (
                  <li>
                    <strong>
                      {shortSpan(gap.from, gap.to)} · {gap.days} days
                    </strong>
                    <span>{gap.reason}</span>
                  </li>
                )}
              </For>
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
                  <Show when={isGreenManure(s)}>
                    <small>green manure</small>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.rescoreBusy}>
          <p class="yp-basis" role="status">
            Re-scoring the plan…
          </p>
        </Show>
        <Show when={props.rescoreError}>
          <p class="yp-inline-error" role="alert">
            {props.rescoreError}
          </p>
        </Show>
        <SlotDetail
          slot={slot()}
          areaHa={props.option.fieldAreaHa}
          trend={props.trend(slot())}
          onSwap={props.option.editable && !slot().fixed ? () => setSwapKey(slot().slotId) : undefined}
          swapDisabled={props.rescoreBusy}
        />
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
                    <span
                      class="yp-bar"
                      role="img"
                      aria-label={`${c.label}: ${value()} out of 100, weight ${props.review.weights[c.key]}`}
                    >
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
          <Show when={idlePenaltyText(props.option)}>
            {(text) => <p class="yp-idle-penalty">{text()}</p>}
          </Show>
        </section>
      </Show>
      <Show when={swapPicker()}>
        {(picker) => (
          <SwapSheet
            title={`Swap ${picker().target.cropId ? nameOf(picker().target.cropId) : "this crop"}`}
            farmId={props.farmId}
            context={picker().context}
            current={picker().current}
            onPick={onSwapPick}
            onClose={() => setSwapKey(null)}
          />
        )}
      </Show>
    </Sheet>
  );
}

/** One crop of the open option: dates, the note, yield, price, cost, profit bands, risks and sources. */
export function SlotDetail(props: {
  slot: YearPlanSlot;
  areaHa: number | null | undefined;
  trend: TrendState | undefined;
  /** Opens the swap sheet for this crop; absent for the growing crop and for plans that cannot be edited. */
  onSwap?: (() => void) | undefined;
  swapDisabled?: boolean | undefined;
}) {
  const s = () => props.slot;
  const manure = () => isGreenManure(s());
  const price = () => s().price;
  const harvestMonth = () => parseIso(s().harvest.latest).m;
  const trendReady = () => (props.trend?.status === "ready" ? props.trend.trend : undefined);
  const trendError = () => (props.trend?.status === "error" ? props.trend.message : undefined);
  // Keep the open "What could change this" state per slot.
  const [openRisks, setOpenRisks] = createSignal(false);
  createEffect(
    on(
      () => s().slotId,
      () => setOpenRisks(false),
      { defer: true },
    ),
  );
  return (
    <section class="yp-slot-detail" aria-labelledby="yp-slot-title">
      <div class="yp-slot-heading">
        <h3 id="yp-slot-title">
          <Show
            when={isIntercrop(s())}
            fallback={
              <>
                {s().cropName} · {s().productName}
              </>
            }
          >
            {intercropName(s())}
          </Show>
        </h3>
        <Show when={s().fixed}>
          <Chip tone="growing">Growing now</Chip>
        </Show>
        <Show when={isIntercrop(s())}>
          <Chip tone="info">Intercrop</Chip>
        </Show>
        <Show when={manure()}>
          <Chip tone="legume">Green manure</Chip>
        </Show>
        <Show when={!s().fixed && !manure() && isLegume(s().cropId)}>
          <Chip tone="legume">Legume</Chip>
        </Show>
        <Show when={props.onSwap}>
          {(swap) => (
            <button
              type="button"
              class="yp-swap-button"
              disabled={props.swapDisabled}
              aria-label={`Swap crop, ${s().cropName}`}
              onClick={() => swap()()}
            >
              <Icon name="swap" size={16} />
              <span>Swap crop</span>
            </button>
          )}
        </Show>
      </div>
      <p class="yp-slot-dates">
        {s().fixed ? "Growing since" : "Sow"} {longDate(s().sowing)} ·{" "}
        {manure()
          ? `ploughed in by ${longDate(s().harvest.latest)}`
          : `harvest ${longSpan(s().harvest.earliest, s().harvest.latest)}`}
      </p>
      <Show when={s().transitionNote}>
        <p class="yp-slot-note">{s().transitionNote}</p>
      </Show>
      <dl class="yp-estimates">
        <Show
          when={!manure()}
          fallback={
            <div>
              <dt>Green manure</dt>
              <dd>
                <strong>{nitrogenCreditText(s().nitrogenCreditKgPerHa) ?? "Adds nitrogen"} for the next crop</strong>
                <span class="yp-basis">
                  Not harvested or sold: {greenManureName(s().cropName)} grows about {Math.round(s().durationDays.low)}{" "}
                  to {Math.round(s().durationDays.high)} days, then is ploughed in.
                </span>
              </dd>
            </div>
          }
        >
          <div>
            <dt>Yield</dt>
            <dd>
              <Show when={s().yieldKgPerHa} fallback={<strong>Yield not sourced</strong>}>
                {(y) => <strong>{formatKgRange(y())} per ha</strong>}
              </Show>
              <Show when={fieldYieldText(s(), props.areaHa)}>
                {(text) => <span class="yp-field-yield">{text()}</span>}
              </Show>
              <span class="yp-basis">{yieldBasisText(s())}</span>
            </dd>
          </div>
          <Show when={isIntercrop(s()) ? s().companion : undefined}>{(c) => <CompanionBlock companion={c()} />}</Show>
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
        </Show>
        <div>
          <dt>Cost</dt>
          <dd>
            <Show when={s().cost?.a2flPerHa != null} fallback={<strong>Cost not sourced</strong>}>
              <strong>{formatInr(s().cost!.a2flPerHa!)} per ha</strong>
            </Show>
            <span class="yp-basis">{manure() ? "Seed, sowing and ploughing in" : costBasisText(s().cost)}</span>
          </dd>
        </div>
        <div>
          <dt>Profit</dt>
          <dd>
            <Show
              when={s().profitEstimate}
              fallback={
                <>
                  <Show when={s().profitPerHa} fallback={<strong>Not calculated</strong>}>
                    {(p) => <strong>{formatInrRange(p())} per ha</strong>}
                  </Show>
                  <span class="yp-basis">
                    {s().profitPerHa
                      ? "Yield times price, minus the A2+FL cost"
                      : "Needs both a price range and a sourced cost"}
                  </span>
                </>
              }
            >
              {(estimate) => (
                <>
                  <EstimateBlocks perHa={estimate()} forField={s().profitForField} areaHa={props.areaHa} />
                  <span class="yp-basis">
                    {manure()
                      ? "No income; the cost is set against the nitrogen the next crop gets"
                      : "Yield times price, minus the A2+FL cost"}
                  </span>
                </>
              )}
            </Show>
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

const ARRANGEMENT: Record<NonNullable<NonNullable<YearPlanSlot["companion"]>["arrangement"]>, string> = {
  row: "in alternate rows",
  paired_row: "in paired rows",
  strip: "in strips",
  mixed: "mixed through the main crop",
};

/**
 * The companion of an intercrop slot: its name and row ratio, the sole-crop yield and price (the figures the server
 * scaled by the share), the yield shares with their basis chip, the nitrogen a legume companion leaves, and the source.
 */
export function CompanionBlock(props: { companion: NonNullable<YearPlanSlot["companion"]> }) {
  const c = () => props.companion;
  const price = () => (c().price?.status === "available" && c().price?.range ? c().price : undefined);
  return (
    <div class="yp-companion">
      <dt>Companion crop</dt>
      <dd>
        <strong>
          {c().cropName} · {c().productName}
        </strong>
        <span class="yp-basis">
          Rows {c().rowRatio} (main to companion)
          {c().arrangement ? `, ${ARRANGEMENT[c().arrangement!]}` : ""}
        </span>
        <ul class="yp-companion-facts">
          <li>
            <span>Companion yield</span>{" "}
            <Show when={c().yieldKgPerHa} fallback="not sourced">
              {(y) => <>{formatKgRange(y())} per ha as a sole crop</>}
            </Show>
          </li>
          <li>
            <span>Companion price</span>{" "}
            <Show when={price()} fallback="no price series yet">
              {(p) => <>{formatPerKgRange(p().range!)}</>}
            </Show>
          </li>
          <li>
            <span>Share of the sole-crop yield</span> main {shareText(c().yieldShare.main)}, companion{" "}
            {shareText(c().yieldShare.companion)}{" "}
            <Chip tone={c().shareBasis === "sourced" ? "info" : "watch"}>{shareBasisText(c().shareBasis)}</Chip>
          </li>
          <Show when={nitrogenCreditText(c().nitrogenCreditKgPerHa)}>
            {(text) => (
              <li>
                <span>Nitrogen for the next crop</span> {text()}
              </li>
            )}
          </Show>
        </ul>
        <Show when={price()}>{(p) => <span class="yp-basis">{priceBasisText(p())}</span>}</Show>
        <Show when={c().shareBasis === "assumed"}>
          <span class="yp-basis">
            The shares are a flagged research fallback for this row ratio, not a figure sourced for this system.
          </span>
        </Show>
        <Show when={c().source}>
          {(source) => (
            <span class="yp-basis">
              Source:{" "}
              <Show when={source().url} fallback={source().title}>
                {(url) => (
                  <a href={url()} target="_blank" rel="noreferrer">
                    {source().title}
                  </a>
                )}
              </Show>
              <Show when={source().locator}>{(locator) => <small> · {locator()}</small>}</Show>
            </span>
          )}
        </Show>
      </dd>
    </div>
  );
}
