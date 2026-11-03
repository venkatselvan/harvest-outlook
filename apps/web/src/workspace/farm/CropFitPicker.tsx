import { For, Match, Show, Switch, batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { CropFitCandidate, CropFitPick, CropFitReview } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { ScoreRing } from "../ui/ScoreRing";
import { CandidateChips, SoilChips } from "./CropFitCard";
import { PicksStatus } from "./CropFitView";
import { classifyCropFitError, loadCropFit, pollCropFit, refreshCropFit, type CropFitFailure } from "./cropFitApi";
import {
  candidateTitle,
  cropLabel,
  formatDate,
  harvestText,
  isActive,
  isIsoDate,
  pickCards,
  pickerControls,
  pickerSections,
  profitText,
  resolvedLine,
  rowAction,
  sowingText,
  waitLine,
  yieldFieldText,
  type CurrentCrop,
} from "./cropFitModel";
import "./crop-fit.css";

/**
 * Round 3 (ROUND3_SPEC.md section 3.1): reusable crop picker backed by crop fit in `date` mode with a previous-crop
 * override. The props are the contract with the year-plan swap sheet and the editor's "Suggest next crop": `current` is
 * shown first and pre-selected ("In this plan", rank and score when ranked) with a Keep button; every other row has
 * "Use this crop", which calls `onPick` with the scored candidate (its sowing date, product and intercrop companion).
 * Scoring is code; Meta only picks and explains three crops (the `crop_fit_picks` spark).
 */
export interface CropFitPickerProps {
  farmId: string;
  /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.6): rank for this field (area and rotation are the field's); null or omitted = the whole farm. */
  fieldId?: string | null | undefined;
  /** Sowing date the candidates are scored for (YYYY-MM-DD). */
  sowing: string;
  /** Crop before the slot being edited; null uses the field's own history. */
  after: string | null;
  /** The crop currently in the slot, shown first and pre-selected; null when adding a slot. */
  current: { cropId: string; productId: string; systemId?: string | null } | null;
  onPick: (candidate: CropFitCandidate) => void;
  onClose: () => void;
  /** A pick is being saved: "Use this crop" and "Try again" are disabled; Keep and Cancel stay usable (they only close). */
  busy?: boolean | undefined;
}

const useLabel = (c: CropFitCandidate) => `Use this crop: ${candidateTitle(c)}`;

/** One crop: title, rank and score, chips, the numbers that matter for a swap, and the Keep or Use button. */
export function PickerRow(props: { candidate: CropFitCandidate; fieldAreaHa: number | null; current: CurrentCrop | null; pick?: CropFitPick | undefined; showPickChip?: CropFitPick | undefined; onUse: () => void; onKeep: () => void; busy?: boolean | undefined }) {
  const c = () => props.candidate;
  const selected = () => rowAction(c(), props.current) === "keep";
  const profit = () => profitText(c(), props.fieldAreaHa);
  return (
    <article class="cf-pick-row" classList={{ "cf-selected": selected() }} aria-current={selected() ? "true" : undefined}>
      <div class="cf-pick-head">
        <div class="cf-pick-titles">
          <h4>{candidateTitle(c())}</h4>
          <p class="cf-pick-rank">
            Rank {c().rank} · Score {Math.round(c().score)}
          </p>
        </div>
        <ScoreRing score={c().score} size={44} label={`Fit score ${Math.round(c().score)} out of 100`} />
      </div>
      <span class="cf-chips">
        <Show when={selected()}>
          <Chip tone="growing">In this plan</Chip>
        </Show>
        <Show when={props.showPickChip}>{(p) => <Chip tone="model">Pick {p().rank}</Chip>}</Show>
      </span>
      <CandidateChips candidate={c()} />
      <Show when={props.pick}>
        {(p) => (
          <>
            <p class="cf-card-headline">{p().headline}</p>
            <Show when={p().reasons.length}>
              <ul class="cf-reasons">
                <For each={p().reasons.slice(0, 3)}>{(r) => <li>{r.text}</li>}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>
      <p class="cf-pick-line">
        {sowingText(c())} · {harvestText(c())}
      </p>
      <Show when={waitLine(c())}>{(t) => <p class="cf-wait">{t()}</p>}</Show>
      <p class="cf-pick-line">
        <span class="cf-pick-label">{props.fieldAreaHa && c().profitForField ? "Profit for your field" : "Profit"}</span> {profit().text}
        <Show when={yieldFieldText(c())}>{(t) => <span class="cf-sub">{t()}</span>}</Show>
      </p>
      <SoilChips candidate={c()} max={3} />
      <div class="cf-pick-actions">
        <button type="button" class={`btn compact ${selected() ? "secondary" : ""}`} disabled={!selected() && props.busy === true} aria-label={selected() ? `Keep ${candidateTitle(c())}` : useLabel(c())} onClick={() => (selected() ? props.onKeep() : props.onUse())}>
          {selected() ? "Keep" : "Use this crop"}
        </button>
      </div>
    </article>
  );
}

function PickerSkeleton() {
  return (
    <div class="cf-cards" aria-hidden="true">
      <For each={[1, 2, 3]}>{() => <div class="cf-card cf-card-skeleton" />}</For>
    </div>
  );
}

/** Presentational picker for one review (or none yet), so tests render it with fixtures. */
export function CropFitPickerView(props: {
  sowing: string;
  after: string | null;
  review: CropFitReview | undefined;
  failure: CropFitFailure | undefined;
  current: CurrentCrop | null;
  retrying: boolean;
  onPick: (candidate: CropFitCandidate) => void;
  onKeep: () => void;
  onRetry: () => void;
  onClose: () => void;
  busy?: boolean | undefined;
}) {
  const sections = () => (props.review ? pickerSections(props.review, props.current) : { current: null, picks: [], rest: [] });
  const cards = () => (props.review ? pickCards(props.review) : []);
  /** The pick that joined to this exact candidate (a pick names crop and product only; see pickCards). */
  const pickFor = (c: CropFitCandidate) => cards().find((card) => card.candidate === c)?.pick;
  const areaHa = () => props.review?.fieldAreaHa ?? null;
  const loading = () => !props.review && !props.failure;
  const broken = () => props.failure ?? (props.review?.status === "error" ? { kind: "server" as const, message: props.review.summary } : undefined);
  const nameOfCurrent = () => (props.current ? `${cropLabel(props.current.cropId)}${props.current.systemId ? " (intercrop)" : ""}` : "");
  return (
    <section class="cf-picker" aria-label="Choose a crop" aria-busy={loading() || (!!props.review && isActive(props.review))}>
      <header class="cf-picker-head">
        <h3>Crops for sowing on {isIsoDate(props.sowing) ? formatDate(props.sowing) : props.sowing}</h3>
        <p class="cf-muted">{props.review ? resolvedLine(props.review) : props.after ? `After ${cropLabel(props.after).toLowerCase()}` : "After the field's own history"}</p>
      </header>

      <Show when={props.current}>
        <section class="cf-picker-section" aria-label="In this plan">
          <Show
            when={sections().current}
            fallback={
              <article class="cf-pick-row cf-selected" aria-current="true">
                <div class="cf-pick-head">
                  <div class="cf-pick-titles">
                    <h4>{nameOfCurrent()}</h4>
                    <p class="cf-pick-rank">{loading() || (props.review && isActive(props.review) && !props.review.candidates.length) ? "Scoring this crop for the date…" : "Not ranked for this date"}</p>
                  </div>
                </div>
                <span class="cf-chips">
                  <Chip tone="growing">In this plan</Chip>
                </span>
                <div class="cf-pick-actions">
                  <button type="button" class="btn compact secondary" aria-label={`Keep ${nameOfCurrent()}`} onClick={() => props.onKeep()}>
                    Keep
                  </button>
                </div>
              </article>
            }
          >
            {(c) => <PickerRow candidate={c()} fieldAreaHa={areaHa()} current={props.current} pick={pickFor(c())} onUse={() => props.onPick(c())} onKeep={props.onKeep} busy={props.busy} />}
          </Show>
        </section>
      </Show>

      <Switch>
        <Match when={broken()}>
          {(f) => (
            <div class="cf-empty" role="alert">
              <h4>{f().kind === "offline" ? "Could not reach the server" : "Crops could not be scored right now"}</h4>
              <p>{f().message}</p>
              <button type="button" class="btn compact secondary" disabled={props.retrying || props.busy === true} onClick={() => props.onRetry()}>
                Try again
              </button>
            </div>
          )}
        </Match>
        <Match when={loading() || (props.review && isActive(props.review) && !props.review.candidates.length)}>
          <p class="cf-muted" role="status">
            Scoring crops for this date…
          </p>
          <PickerSkeleton />
        </Match>
        <Match when={props.review && !props.review.candidates.length}>
          <div class="cf-empty">
            <h4>No crop fits this sowing date</h4>
            <p>{props.review!.summary}</p>
            <p class="cf-muted">Try another date.</p>
          </div>
        </Match>
        <Match when={props.review}>
          {(r) => (
            <>
              <Show when={sections().picks.length}>
                <section class="cf-picker-section" aria-labelledby="cf-picker-picks">
                  <div class="cf-section-head">
                    <h3 id="cf-picker-picks">Top picks</h3>
                    <PicksStatus review={r()} />
                  </div>
                  <div class="cf-pick-list">
                    <For each={sections().picks}>
                      {(card) => <PickerRow candidate={card.candidate} fieldAreaHa={areaHa()} current={props.current} pick={card.pick} onUse={() => props.onPick(card.candidate)} onKeep={props.onKeep} busy={props.busy} />}
                    </For>
                  </div>
                </section>
              </Show>
              <section class="cf-picker-section" aria-labelledby="cf-picker-all">
                <div class="cf-section-head">
                  <h3 id="cf-picker-all">All ranked crops ({r().candidates.length})</h3>
                  <Show when={!sections().picks.length}>
                    <PicksStatus review={r()} />
                  </Show>
                </div>
                <div class="cf-pick-list">
                  <For each={sections().rest}>
                    {(c) => <PickerRow candidate={c} fieldAreaHa={areaHa()} current={props.current} showPickChip={pickFor(c)} onUse={() => props.onPick(c)} onKeep={props.onKeep} busy={props.busy} />}
                  </For>
                </div>
              </section>
            </>
          )}
        </Match>
      </Switch>
      <div class="cf-picker-footer">
        <button type="button" class="btn compact secondary" onClick={() => props.onClose()}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * One picker request: crop fit in `date` mode for the slot's sowing date and previous crop, for the field when `fieldId`
 * is given (its area and rotation) and for the whole farm otherwise. GET (or POST when `force`), then poll while the
 * review is pending or running; every review seen goes to `onUpdate`. Exported so the request itself is testable.
 */
export async function requestPickerReview(args: {
  farmId: string;
  fieldId: string | null;
  sowing: string;
  after: string | null;
  force: boolean;
  signal: AbortSignal;
  onUpdate: (review: CropFitReview) => void;
  isCurrent: () => boolean;
  fetchImpl?: typeof fetch | undefined;
  intervalMs?: number | undefined;
}): Promise<void> {
  if (!isIsoDate(args.sowing)) throw Object.assign(new Error("Pick a valid sowing date."), { name: "InvalidSowing" });
  const controls = pickerControls(args.sowing, args.after);
  const opts = { signal: args.signal, fieldId: args.fieldId, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) };
  const first = args.force ? await refreshCropFit(args.farmId, controls, opts) : await loadCropFit(args.farmId, controls, opts);
  args.onUpdate(first);
  if (args.isCurrent() && isActive(first)) {
    args.onUpdate(await pollCropFit(args.farmId, controls, first, { ...opts, onUpdate: args.onUpdate, ...(args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}) }));
  }
}

/**
 * Loads and polls `/crop-fit?mode=date&sowing=&after=` for the slot and renders the picker. A new `farmId`, `fieldId`, `sowing` or
 * `after` starts a fresh request and drops the old one. Keep calls `onClose` (the crop stays as it is).
 */
export function CropFitPicker(props: CropFitPickerProps) {
  const [review, setReview] = createSignal<CropFitReview>();
  const [failure, setFailure] = createSignal<CropFitFailure>();
  const [retrying, setRetrying] = createSignal(false);
  let generation = 0;
  let controller: AbortController | undefined;

  async function load(farmId: string, fieldId: string | null, sowing: string, after: string | null, force: boolean) {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const gen = generation;
    const ok = () => !ctrl.signal.aborted && gen === generation;
    const show = (next: CropFitReview) => {
      if (ok()) batch(() => { setFailure(undefined); setReview(next); });
    };
    try {
      await requestPickerReview({ farmId, fieldId, sowing, after, force, signal: ctrl.signal, onUpdate: show, isCurrent: ok });
    } catch (error) {
      if (ok()) setFailure(error instanceof Error && error.name === "InvalidSowing" ? { kind: "invalid", message: error.message } : classifyCropFitError(error));
    } finally {
      if (controller === ctrl) {
        controller = undefined;
        if (gen === generation) setRetrying(false);
      }
    }
  }

  createEffect(
    on(
      () => [props.farmId, props.fieldId ?? null, props.sowing, props.after] as const,
      ([farmId, fieldId, sowing, after]) => {
        generation++;
        batch(() => { setReview(undefined); setFailure(undefined); });
        if (farmId) void load(farmId, fieldId, sowing, after, false);
      },
    ),
  );
  onCleanup(() => {
    generation++;
    controller?.abort();
  });

  return (
    <CropFitPickerView
      sowing={props.sowing}
      after={props.after}
      review={review()}
      failure={failure()}
      current={props.current}
      retrying={retrying()}
      onPick={props.onPick}
      onKeep={props.onClose}
      onClose={props.onClose}
      busy={props.busy}
      onRetry={() => {
        if (retrying()) return;
        setRetrying(true);
        batch(() => { setFailure(undefined); setReview(undefined); });
        void load(props.farmId, props.fieldId ?? null, props.sowing, props.after, true);
      }}
    />
  );
}
