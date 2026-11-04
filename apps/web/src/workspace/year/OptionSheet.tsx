import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { PriceTrend, ScoreComponents, YearPlanOccupant, YearPlanOption, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
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
  cultivationCostPerHa,
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
  OCCUPANT_PILL_LABEL,
  OCCUPANT_STRIP_LABEL,
  occupantEndText,
  occupantName,
  occupantPickChanges,
  occupantPickerCurrent,
  occupantSwapContext,
  pickChangesDraft,
  pickerCurrent,
  priceBasisText,
  realisationTag,
  useInsteadText,
  profitText,
  ratioStated,
  sheetItems,
  shareBasisText,
  shareText,
  swapContext,
  yieldBasisText,
  type CropChoice,
  type DraftSlot,
  type YearPlanReplacement,
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
  /**
   * Set when the option is one of `review.alternatives` (EVARA_ACTIONS_SPEC.md 1.3). The sheet then has no slot edit, no
   * re-score and no swap: a 'replace' alternative is applied as it is ("Use instead of ...", the seasons it takes over
   * are named), a 'comparison' only shows what could have fitted. `occupied` replaces the review's saved seasons.
   */
  alternative?: { kind: "replace" | "comparison"; replaces: readonly YearPlanReplacement[]; occupied: readonly YearPlanOccupant[] } | undefined;
  /** The field the plan is for; passed on to the crop pickers of the editor and the swap sheets. */
  fieldId?: string | null | undefined;
  review: YearPlanReview;
  option: YearPlanOption;
  slotId: string | null;
  /** A saved season to show instead of a crop of the plan (the strip that was tapped, or the pill picked). */
  occupantId: string | null;
  applied: boolean;
  editing: boolean;
  choices: readonly CropChoice[];
  rescoreBusy: boolean;
  rescoreError: string;
  trend: (slot: YearPlanSlot) => TrendState | undefined;
  onSelectSlot: (slotId: string) => void;
  onSelectOccupant: (occupantId: string) => void;
  /** Swap a saved season's crop for a picked candidate: the view saves the workspace, then rebuilds the plan and closes the sheet. */
  onSwapOccupant: (occupant: YearPlanOccupant, candidate: CropFitCandidate) => void;
  /** Cleared when the swap picker closes without a pick. */
  onSwapReset: () => void;
  swapBusy: boolean;
  swapError: string;
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
  // Saved seasons: pills and panel beside the plan's own crops; the swap edits the saved season, not this option.
  const occupied = () => (props.alternative ? props.alternative.occupied : (props.review.scenario.occupied ?? []));
  const occupant = () => (props.occupantId ? occupied().find((o) => o.id === props.occupantId) : undefined);
  const items = () => sheetItems(props.option, occupied());
  const [occupantSwapId, setOccupantSwapId] = createSignal<string | null>(null);
  const occupantSwap = () => {
    const target = occupied().find((o) => o.id === occupantSwapId());
    if (!target) return undefined;
    const context = occupantSwapContext(target.id, props.option, occupied(), props.review.scenario.previousCropId);
    return context ? { target, context, current: occupantPickerCurrent(target) } : undefined;
  };
  const closeOccupantSwap = () => {
    setOccupantSwapId(null);
    props.onSwapReset();
  };
  /** Picking what the saved season already is only closes the picker; anything else is saved by the view. */
  const onOccupantPick = (candidate: CropFitCandidate) => {
    const picker = occupantSwap();
    if (!picker) return;
    if (!occupantPickChanges(picker.target, candidate)) return closeOccupantSwap();
    props.onSwapOccupant(picker.target, candidate);
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
          <Show when={props.alternative || editedFrom(props.option) || props.applied || warnings().short.length}>
            <div class="yp-sheet-chips">
              <Show when={props.alternative?.kind === "replace"}>
                <Chip tone="info">Alternative to your planned seasons</Chip>
              </Show>
              <Show when={props.alternative?.kind === "comparison"}>
                <Chip tone="neutral">For comparison only</Chip>
              </Show>
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
        <Show when={!props.editing && props.alternative?.kind !== "comparison"}>
          <Show when={props.option.editable && !props.alternative}>
            <button type="button" class="btn secondary" onClick={() => props.onEdit()}>
              Edit
            </button>
          </Show>
          <button type="button" class="btn" disabled={props.applied} onClick={() => props.onUse()}>
            {props.applied
              ? "Already in saved seasons"
              : props.alternative
                ? useInsteadText(props.alternative.replaces)
                : "Use this plan"}
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
            fieldId={props.fieldId}
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
        <Show when={items().length > 1}>
          <div class="yp-slot-tabs" role="group" aria-label="Crops in this plan">
            <For each={items()}>
              {(item) =>
                item.kind === "slot" ? (
                  <button
                    type="button"
                    class="yp-slot-tab"
                    aria-pressed={!occupant() && item.slot.slotId === slot().slotId}
                    onClick={() => props.onSelectSlot(item.slot.slotId)}
                  >
                    {item.slot.cropName}
                    <Show when={item.slot.fixed}>
                      <small>growing now</small>
                    </Show>
                    <Show when={isGreenManure(item.slot)}>
                      <small>green manure</small>
                    </Show>
                  </button>
                ) : (
                  <button
                    type="button"
                    class="yp-slot-tab is-saved"
                    aria-pressed={occupant()?.id === item.occupant.id}
                    onClick={() => props.onSelectOccupant(item.occupant.id)}
                  >
                    {item.occupant.cropName}
                    <small>{realisationTag(item.occupant) ?? OCCUPANT_PILL_LABEL[item.occupant.source]}</small>
                  </button>
                )
              }
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
        <Show
          when={occupant()}
          fallback={
            <SlotDetail
              slot={slot()}
              areaHa={props.option.fieldAreaHa}
              trend={props.trend(slot())}
              onSwap={props.option.editable && !slot().fixed && !props.alternative ? () => setSwapKey(slot().slotId) : undefined}
              swapDisabled={props.rescoreBusy}
            />
          }
        >
          {(o) => (
            <OccupantDetail
              occupant={o()}
              onSwap={o().source === "saved_season" && !props.alternative ? () => setOccupantSwapId(o().id) : undefined}
              swapDisabled={props.rescoreBusy || props.swapBusy}
              stale={props.review.stale}
            />
          )}
        </Show>
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
            fieldId={props.fieldId}
            context={picker().context}
            current={picker().current}
            onPick={onSwapPick}
            onClose={() => setSwapKey(null)}
          />
        )}
      </Show>
      <Show when={occupantSwap()}>
        {(picker) => (
          <SwapSheet
            title={`Swap ${picker().target.cropName}`}
            farmId={props.farmId}
            fieldId={props.fieldId}
            context={picker().context}
            current={picker().current}
            note="After you pick, the saved season on your field is changed and the year plan is rebuilt by code, not by AI."
            busy={props.swapBusy}
            error={props.swapError}
            onPick={onOccupantPick}
            onClose={closeOccupantSwap}
          />
        )}
      </Show>
    </Sheet>
  );
}

const BASIS_TEXT: Record<YearPlanOccupant["occupancyBasis"], string> = {
  recorded: "from the recorded dates",
  planned: "from your planned dates",
  sourced_duration: "harvest worked out from the crop's sourced duration",
  assumed_duration: "harvest worked out from an assumed duration",
};

const OCCUPANT_TONE = { saved_season: "info", recorded_cycle: "observed", assumed_plan: "typical" } as const;

/**
 * A saved season, recorded crop or assumed plan that the open plan works around: name, what kind it is, its dates, the
 * kind line (intercrop or green manure), the farmer's note, and what can be done with it. Only a saved season can be
 * swapped here; a recorded crop is changed in Farm details, the assumed plan by saving or changing last year's plan.
 */
export function OccupantDetail(props: {
  occupant: YearPlanOccupant;
  /** Opens the swap picker; given for a saved season only. */
  onSwap?: (() => void) | undefined;
  swapDisabled?: boolean | undefined;
  /** The plan is out of date: the saved season may have changed since it was built, so the swap waits for a refresh. */
  stale?: boolean | undefined;
}) {
  const o = () => props.occupant;
  const kindLine = () => {
    const c = o().companion;
    if (o().kind === "intercrop" && c)
      return `Intercrop · ${o().cropName} + ${c.cropName}${ratioStated(c.rowRatio) ? `, rows ${c.rowRatio}` : ""}`;
    if (o().kind === "green_manure") return "Green manure · grown and ploughed in, not harvested or sold";
    return null;
  };
  return (
    <section class="yp-slot-detail yp-occupant-detail" aria-labelledby="yp-slot-title">
      <div class="yp-slot-heading">
        <h3 id="yp-slot-title">{occupantName(o())}</h3>
        <Chip tone={OCCUPANT_TONE[o().source]}>{OCCUPANT_STRIP_LABEL[o().source]}</Chip>
        <Show when={realisationTag(o())}>{(tag) => <Chip tone={o().realisation === "overdue" ? "overdue" : "due"}>{tag()}</Chip>}</Show>
        <Show when={props.onSwap}>
          {(swap) => (
            <button
              type="button"
              class="yp-swap-button"
              disabled={props.swapDisabled || props.stale}
              aria-label={props.stale ? undefined : `Swap crop, ${o().cropName}`}
              onClick={() => swap()()}
            >
              <Icon name="swap" size={16} />
              <span>{props.stale ? "Refresh the plan first" : "Swap crop"}</span>
            </button>
          )}
        </Show>
      </div>
      <p class="yp-slot-dates">
        Sow {longDate(o().sowing)} · {occupantEndText(o())}
      </p>
      <div class="yp-occupant-facts">
        <Show when={kindLine()}>{(line) => <p>{line()}</p>}</Show>
        <Show when={o().note}>{(note) => <p>{note()}</p>}</Show>
        <p>
          The field counts as busy to {longDate(o().occupancy.to)} ({BASIS_TEXT[o().occupancyBasis]}).
        </p>
      </div>
      <p class="yp-occupant-keeps">
        <Show
          when={o().source === "assumed_plan"}
          fallback={
            <>
              {o().source === "saved_season"
                ? "This season is saved on your field; the plan keeps it and works around it."
                : "This crop is recorded on your field; the plan keeps it and works around it."}
              <Show when={o().source === "recorded_cycle"}> Change it in Farm details.</Show>
            </>
          }
        >
          Assumed from the previous year's plan; save or change that plan to change this.
        </Show>
      </p>
    </section>
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
            <Show when={cultivationCostPerHa(s().cost) != null} fallback={<strong>Cost not sourced</strong>}>
              <strong>{formatInr(cultivationCostPerHa(s().cost)!)} per ha</strong>
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
