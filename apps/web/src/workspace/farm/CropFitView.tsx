import { For, Match, Show, Switch, batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { CropFitReview } from "@harvest/contracts";
import { AiSparkInline } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { CandidateChips, CropFitCard } from "./CropFitCard";
import { CropFitControls } from "./CropFitControls";
import { CropFitSheet } from "./CropFitSheet";
import { classifyCropFitError, loadCropFit, pollCropFit, refreshCropFit, type CropFitFailure } from "./cropFitApi";
import {
  SAME_AS_PLAN_LINE,
  candidateKey,
  candidateTitle,
  controlsFromReview,
  defaultControls,
  formatInrRange,
  harvestText,
  isActive,
  localToday,
  pickCards,
  pickingModel,
  picksChip,
  rankedCandidates,
  resolvedLine,
  soilLine,
  sowingText,
  waitLine,
  type ControlsState,
} from "./cropFitModel";
import "./crop-fit.css";

/** Status next to "Top picks": the AI mark when Meta picked, otherwise what the picks are and why. */
export function PicksStatus(props: { review: CropFitReview }) {
  const chip = () => picksChip(props.review);
  return (
    <span class="cf-picks-status" role="status" aria-live="polite">
      <Switch>
        <Match when={chip() === "pending"}>
          <Chip tone="model" pulse>
            {props.review.status === "running" && props.review.candidates.length ? "Picking…" : "Scoring crops…"}
          </Chip>
          <Show when={pickingModel(props.review)}>{(m) => <span class="cf-muted">with {m()}</span>}</Show>
        </Match>
        <Match when={chip() === "model"}>
          <AiSparkInline use="crop_fit_picks" label="Picked by AI" />
        </Match>
        <Match when={chip() === "unavailable"}>
          <Chip tone="watch">Model unavailable, showing calculated picks</Chip>
        </Match>
        <Match when={chip() === "calculated"}>
          <Chip tone="neutral">Calculated picks</Chip>
        </Match>
      </Switch>
    </span>
  );
}

function SkeletonCards() {
  return (
    <div class="cf-cards" aria-hidden="true">
      <For each={[1, 2, 3]}>{() => <div class="cf-card cf-card-skeleton" />}</For>
    </div>
  );
}

/**
 * Everything below the controls for one review: top picks (three cards), the ranked list behind "See all n crops", and
 * the empty and error states. Presentational, so tests render it with fixtures.
 */
export function CropFitResults(props: { review: CropFitReview; showAll: boolean; onToggleAll: () => void; onOpen: (key: string) => void; onRetry: () => void; retrying: boolean }) {
  const cards = () => pickCards(props.review);
  const r = () => props.review;
  const ranked = () => rankedCandidates(r());
  return (
    <>
      <p class="cf-muted cf-explain">{SAME_AS_PLAN_LINE}.</p>
      <div class="cf-section-head">
        <h3 id="cf-picks-heading">Top picks</h3>
        <PicksStatus review={r()} />
      </div>
      <Switch>
        <Match when={cards().length > 0}>
          <div class="cf-cards" role="list" aria-labelledby="cf-picks-heading">
            <For each={cards()}>
              {(card) => (
                <div role="listitem">
                  <CropFitCard card={card} fieldAreaHa={r().fieldAreaHa} onOpen={() => props.onOpen(candidateKey(card.candidate))} />
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={isActive(r())}>
          <SkeletonCards />
        </Match>
        <Match when={r().status === "error"}>
          <div class="cf-empty" role="alert">
            <h4>Crop fit could not be calculated right now</h4>
            <p>{r().summary}</p>
            <button type="button" class="btn compact secondary" disabled={props.retrying} onClick={() => props.onRetry()}>
              Try again
            </button>
          </div>
        </Match>
        <Match when={true}>
          <div class="cf-empty">
            <h4>No crop fits this sowing date</h4>
            <p>{r().summary}</p>
            <For each={r().limitations.filter((l) => l.startsWith("Not ranked"))}>{(l) => <p class="cf-muted">{l}</p>}</For>
            <p class="cf-muted">Try another date or a season.</p>
          </div>
        </Match>
      </Switch>
      <Show when={r().candidates.length > 0}>
        <button type="button" class="cf-link cf-see-all" aria-expanded={props.showAll} aria-controls="cf-all-list" onClick={() => props.onToggleAll()}>
          {props.showAll ? "Hide the ranked list" : `See all ${r().candidates.length} crops`}
        </button>
        <Show when={props.showAll}>
          <ol id="cf-all-list" class="cf-list">
            <For each={ranked()}>
              {(c) => (
                <li>
                  <button type="button" class="cf-list-row" onClick={() => props.onOpen(candidateKey(c))}>
                    <span class="cf-list-rank">{c.rank}</span>
                    <span class="cf-list-main">
                      <span class="cf-list-name">{candidateTitle(c)}</span>
                      <CandidateChips candidate={c} />
                      <span class="cf-list-meta">
                        {sowingText(c)} · {harvestText(c)}
                      </span>
                      <Show when={waitLine(c)}>{(t) => <span class="cf-list-meta cf-wait">{t()}</span>}</Show>
                      <span class="cf-list-meta">
                        {c.profitForField && r().fieldAreaHa ? `${formatInrRange(c.profitForField.likely)} for your field` : c.profitPerHa ? `${formatInrRange(c.profitPerHa.likely)} per ha` : "Profit not shown"} · {soilLine(c)}
                      </span>
                    </span>
                    <span class="cf-list-score" aria-label={`Score ${Math.round(c.score)} out of 100`}>
                      {Math.round(c.score)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </>
  );
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; failure: CropFitFailure };

/**
 * Farm tab, crop fit (ROUND2_SPEC.md 4.2). The first GET sends no mode, so the server picks the default (next crop when
 * a crop is growing, today on a fresh field); the controls then follow the review. Changing a control GETs that
 * request (cached on the server by context hash); pending and running reviews are polled like the year plan.
 */
export default function CropFitView(props: {
  farmId: string;
  /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.3, 12.6): rank for this field (`?fieldId=`); null or omitted = the whole farm. */
  fieldId?: string | null | undefined;
  /** The field's name for the heading ("Strip 2"). */
  fieldName?: string | null | undefined;
}) {
  const field = () => props.fieldId ?? null;
  const todayIso = localToday();
  const [controls, setControls] = createSignal<ControlsState>(defaultControls(todayIso));
  const [review, setReview] = createSignal<CropFitReview>();
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" });
  const [refreshing, setRefreshing] = createSignal(false);
  const [dateError, setDateError] = createSignal<string | null>(null);
  const [showAll, setShowAll] = createSignal(false);
  const [open, setOpen] = createSignal<string | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;

  async function load(farmId: string, request: ControlsState | null, force: boolean) {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const gen = generation;
    const fieldId = field();
    const ok = () => !ctrl.signal.aborted && gen === generation && props.farmId === farmId && field() === fieldId;
    const show = (next: CropFitReview) => {
      if (!ok()) return;
      batch(() => {
        setReview(next);
        if (request === null) setControls((c) => controlsFromReview(next, c));
        setPhase({ kind: "ready" });
      });
    };
    try {
      const opts = { signal: ctrl.signal, fieldId };
      const first = force ? await refreshCropFit(farmId, request, opts) : await loadCropFit(farmId, request, opts);
      show(first);
      if (ok() && isActive(first)) show(await pollCropFit(farmId, request ?? controlsFromReview(first, controls()), first, { ...opts, onUpdate: show }));
    } catch (error) {
      if (!ok()) return;
      setPhase({ kind: "failed", failure: classifyCropFitError(error) });
    } finally {
      if (controller === ctrl) {
        controller = undefined;
        if (gen === generation) setRefreshing(false);
      }
    }
  }

  createEffect(
    on(
      () => [props.farmId, field()] as const,
      ([farmId]) => {
        generation++;
        controller?.abort();
        batch(() => {
          setReview(undefined);
          setOpen(null);
          setShowAll(false);
          setDateError(null);
          setControls(defaultControls(todayIso));
          setPhase({ kind: "loading" });
        });
        if (farmId) void load(farmId, null, false);
      },
    ),
  );
  onCleanup(() => {
    generation++;
    controller?.abort();
  });

  function change(next: ControlsState) {
    batch(() => {
      setControls(next);
      setOpen(null);
      setShowAll(false);
    });
    void load(props.farmId, next, false);
  }
  function refresh() {
    if (refreshing()) return;
    setRefreshing(true);
    void load(props.farmId, controls(), true);
  }

  const openCandidate = () => {
    const key = open();
    const r = review();
    return key && r ? r.candidates.find((c) => candidateKey(c) === key) : undefined;
  };
  const openPick = () => {
    const r = review();
    const candidate = openCandidate();
    return r && candidate ? pickCards(r).find((card) => card.candidate === candidate)?.pick : undefined;
  };
  const failure = () => {
    const p = phase();
    return p.kind === "failed" ? p.failure : undefined;
  };

  return (
    <section class="cf-view" aria-labelledby="cf-heading" aria-busy={phase().kind === "loading" || (!!review() && isActive(review()!))}>
      <div class="cf-head">
        <p class="eyebrow">{props.fieldName ? `${props.fieldName.toUpperCase()} · CROP FIT` : "YOUR FIELD · CROP FIT"}</p>
        <h2 id="cf-heading">Which crop fits next?</h2>
        <p class="cf-muted">Every crop is scored by code on price at harvest, yield, soil and rotation, water and data confidence.</p>
      </div>
      <CropFitControls
        state={controls()}
        todayIso={todayIso}
        resolved={review() ? resolvedLine(review()!) : "Working out the sowing date"}
        busy={!!review() && isActive(review()!)}
        stale={!!review()?.stale}
        refreshing={refreshing()}
        dateError={dateError()}
        onChange={change}
        onDateError={setDateError}
        onRefresh={refresh}
      />
      <Switch>
        <Match when={failure()}>
          {(f) => (
            <div class="cf-empty" role="alert">
              <h4>{f().kind === "missing_endpoint" ? "Crop fit is not available here yet" : f().kind === "offline" ? "Could not reach the server" : "Crop fit could not be shown"}</h4>
              <p>{f().message}</p>
              <button type="button" class="btn compact secondary" onClick={() => { setPhase({ kind: "loading" }); void load(props.farmId, review() ? controls() : null, false); }}>
                Try again
              </button>
            </div>
          )}
        </Match>
        <Match when={phase().kind === "loading" || !review()}>
          <p class="cf-muted" role="status">
            Loading crop fit…
          </p>
          <SkeletonCards />
        </Match>
        <Match when={review()}>
          {(r) => <CropFitResults review={r()} showAll={showAll()} onToggleAll={() => setShowAll((v) => !v)} onOpen={setOpen} onRetry={refresh} retrying={refreshing()} />}
        </Match>
      </Switch>
      <Show when={openCandidate()} keyed>
        {(candidate) => <CropFitSheet candidate={candidate} review={review()!} pick={openPick()} onClose={() => setOpen(null)} />}
      </Show>
    </section>
  );
}
