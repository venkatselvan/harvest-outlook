import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { CropJourney, CropJourneyStage, EvaraNode } from "@harvest/contracts";
import { FieldGrowthScene } from "../FieldGrowthScene";
import { loadSeasonPreview, withPreviewField } from "../season/seasonPreviewApi";
import type { EvaraContext } from "./actions";
import { JourneyDataError, illustratedIndexes, isTerminal, journeyErrorText, loadCropJourney, pollCropJourney, requestCropJourney, stageProgress } from "./journeyApi";
import { kitLabels, labelDate } from "./labels";
import "./evara-ui.css";

export type JourneyNode = Extract<EvaraNode, { type: "growth_journey" }>;

/** One stage as the strip draws it: the node's calendar stage until a journey exists, then the journey's stage with its image state. */
export interface StageView {
  stageId: string;
  name: string;
  from: string;
  to: string;
  targetDate: string | null;
  illustrated: boolean;
  status: CropJourneyStage["status"];
  reason: string | null;
  imagePath: string | null;
}

/** The strip's stages: the journey's when one exists, else the calendar stages (the first, last and up to three between are marked for an image). */
export function stageViews(nodeStages: readonly { stageId: string; name: string; from: string; to: string }[], journey: CropJourney | null): StageView[] {
  if (journey)
    return journey.stages.map((s) => ({ stageId: s.stageId, name: s.name, from: s.from, to: s.to, targetDate: s.targetDate, illustrated: s.illustrated, status: s.status, reason: s.reason, imagePath: s.status === "ready" ? s.imagePath : null }));
  const picked = illustratedIndexes(nodeStages.length);
  return nodeStages.map((s, i) => ({ ...s, targetDate: null, illustrated: picked.has(i), status: "schematic" as const, reason: null, imagePath: null }));
}

/** Plain explanation of a journey that cannot make images; null when it can. */
export function journeyNotice(journey: Pick<CropJourney, "status" | "reason">, language: EvaraContext["language"]): string | null {
  const t = kitLabels(language);
  if (journey.status === "unavailable") return (journey.reason && t.journeyUnavailable[journey.reason]) || t.journeyUnavailableOther;
  if (journey.status === "failed") return (journey.reason && (t.journeyUnavailable[journey.reason] ?? t.stageReason[journey.reason])) || t.journeyUnavailableOther;
  return null;
}

/** Reason line under a stage whose image failed or is unavailable; null for ready and schematic stages. */
export function stageNotice(stage: Pick<StageView, "status" | "reason">, language: EvaraContext["language"]): string | null {
  if (stage.status !== "failed" && stage.status !== "unavailable") return null;
  const t = kitLabels(language);
  return (stage.reason && (t.stageReason[stage.reason] ?? t.journeyUnavailable[stage.reason])) || t.stageReasonOther;
}

export type JourneyPhase = "idle" | "requesting" | "polling" | "timeout" | "error";

/**
 * The predict button's state. Hidden once the journey is ready or partial (and while a timed-out journey offers "Check again");
 * disabled, with the progress text, while a request is in flight or the journey is queued or running (even when the local
 * phase is idle, e.g. a journey resumed from a stored message); enabled again for an unavailable or failed journey, with the reason shown.
 */
export function predictControl(phase: JourneyPhase, journey: Pick<CropJourney, "status"> | null, stageCount: number): { show: boolean; disabled: boolean; retry: boolean; progress: boolean } {
  const running = phase === "requesting" || phase === "polling" || journey?.status === "queued" || journey?.status === "running";
  const done = journey?.status === "ready" || journey?.status === "partial";
  const show = stageCount > 0 && !done && phase !== "timeout";
  return { show, disabled: running, retry: phase === "error" || journey?.status === "failed" || journey?.status === "unavailable", progress: running && phase !== "timeout" && !done };
}

/** Mounts the schematic once the card is near the viewport, so a five-stage strip does not run five canvases at once. */
function LazyScene(props: { children: JSX.Element }) {
  const [shown, setShown] = createSignal(typeof IntersectionObserver === "undefined");
  let host: HTMLDivElement | undefined;
  onMount(() => {
    if (shown() || !host || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div class="ev-scene" ref={host}>
      <Show when={shown()}>{props.children}</Show>
    </div>
  );
}

/**
 * Growth journey (docs/research/EVARA_ACTIONS_SPEC.md 3.2): a stage strip drawn from the stage calendar (a code-drawn schematic
 * per illustrated stage), and a button that asks for generated stage images of the crop on this field. Images are illustrations,
 * always labelled so; failed or unavailable stages keep the schematic and say why. Polling cancels on unmount.
 */
export function GrowthJourney(props: { node: JourneyNode; ctx: EvaraContext }) {
  const lang = () => props.ctx.language;
  const t = () => kitLabels(lang());
  const [journey, setJourney] = createSignal<CropJourney | null>(null);
  const [phase, setPhase] = createSignal<JourneyPhase>("idle");
  const [error, setError] = createSignal("");
  let alive = true;
  let run = 0;
  onCleanup(() => {
    alive = false;
    run++;
  });

  // A tree without stages (an inserted journey) reads the stage calendar from the season preview, as the Plan sheet does.
  const [calendar] = createResource(
    () => (props.node.stages.length || !props.ctx.farmId ? null : { farmId: props.ctx.farmId, cropId: props.node.cropId, sowing: props.node.sowingDate, fieldId: props.ctx.fieldId, productId: props.node.productId }),
    async (key) => {
      const preview = await loadSeasonPreview(key.farmId, withPreviewField({ cropId: key.cropId, ...(key.productId ? { productId: key.productId } : {}), sowing: key.sowing }, key.fieldId), props.ctx.fetchImpl);
      return (preview.timeline?.stages ?? []).map((s) => ({ stageId: s.id, name: s.name, from: s.from, to: s.to }));
    },
  );
  const nodeStages = () => (props.node.stages.length ? props.node.stages : calendar.error ? [] : (calendar() ?? []));
  const stages = createMemo(() => stageViews(nodeStages(), journey()));
  const readyCount = () => stages().filter((s) => s.status === "ready").length;
  const illustratedCount = () => stages().filter((s) => s.illustrated).length;

  async function follow(initial: CropJourney, mine: number) {
    setJourney(initial);
    if (isTerminal(initial)) return setPhase("idle");
    setPhase("polling");
    try {
      const outcome = await pollCropJourney(props.ctx.farmId!, initial, {
        fetchImpl: props.ctx.fetchImpl,
        cancelled: () => !alive || mine !== run,
        onUpdate: (next) => alive && mine === run && setJourney(next),
      });
      if (!alive || mine !== run) return;
      setJourney(outcome.journey);
      setPhase(outcome.status === "timeout" ? "timeout" : "idle");
    } catch (e) {
      if (!alive || mine !== run) return;
      setError(journeyErrorText(e));
      setPhase("error");
    }
  }

  async function predict() {
    if (!props.ctx.farmId || predictControl(phase(), journey(), 1).disabled) return;
    const mine = ++run;
    setPhase("requesting");
    setError("");
    try {
      const created = await requestCropJourney(
        props.ctx.farmId,
        {
          cropId: props.node.cropId,
          ...(props.node.productId ? { productId: props.node.productId } : {}),
          ...((props.node.fieldId ?? props.ctx.fieldId) ? { fieldId: (props.node.fieldId ?? props.ctx.fieldId)! } : {}),
          sowingDate: props.node.sowingDate,
        },
        props.ctx.fetchImpl,
      );
      if (!alive || mine !== run) return;
      await follow(created, mine);
    } catch (e) {
      if (!alive || mine !== run) return;
      setError(journeyErrorText(e));
      setPhase("error");
    }
  }

  async function checkAgain() {
    const current = journey();
    if (!current || !props.ctx.farmId) return;
    const mine = ++run;
    setPhase("requesting");
    try {
      await follow(await loadCropJourney(props.ctx.farmId, current.journeyId, props.ctx.fetchImpl), mine);
    } catch (e) {
      if (!alive || mine !== run) return;
      setError(journeyErrorText(e));
      setPhase("error");
    }
  }

  // Resume a journey the tree already names (a stored message): one read, and polling when it is still running.
  onMount(() => {
    const id = props.node.journeyId;
    if (!id || !props.ctx.farmId) return;
    const mine = ++run;
    setPhase("requesting");
    void loadCropJourney(props.ctx.farmId, id, props.ctx.fetchImpl)
      .then((loaded) => (alive && mine === run ? follow(loaded, mine) : undefined))
      .catch((e) => {
        if (!alive || mine !== run) return;
        // A journey that is gone (expired) is not an error for the farmer: the button asks for a new one.
        setPhase(e instanceof JourneyDataError ? "error" : "idle");
        if (e instanceof JourneyDataError) setError(journeyErrorText(e));
      });
  });

  const control = () => predictControl(phase(), journey(), stages().length);
  const notice = () => (journey() ? journeyNotice(journey()!, lang()) : null);
  const sourceNote = () => {
    const j = journey();
    if (!j || !j.source.date || j.source.kind === "none") return null;
    return j.source.kind === "satellite" ? t().journeyFromSatellite(labelDate(j.source.date, lang())) : t().journeyFromPhoto(labelDate(j.source.date, lang()));
  };

  return (
    <section class="ev-journey" aria-label={t().journeyTitle(props.node.cropName)}>
      <header class="ev-journey-head">
        <h4>{t().journeyTitle(props.node.cropName)}</h4>
        <p class="ev-muted">
          {t().journeySowing} {labelDate(props.node.sowingDate, lang())}
        </p>
      </header>
      <Show when={props.node.note}>
        <p class="ev-muted">{props.node.note}</p>
      </Show>

      <Show when={stages().length} fallback={<p class="ev-muted" role="status">{calendar.loading ? t().journeyLoading : t().journeyNoStages}</p>}>
        <ol class="ev-journey-strip">
          <For each={stages()}>
            {(stage, index) => (
              <li class="ev-stage" classList={{ "is-ready": stage.status === "ready" }}>
                <Show
                  when={stage.status === "ready" && stage.imagePath}
                  fallback={
                    <Show when={stage.illustrated}>
                      <LazyScene>
                        <FieldGrowthScene cropId={props.node.cropId} cropName={props.node.cropName} progress={stageProgress(index(), stages().length)} boundary={props.ctx.fieldBoundary()} compact />
                      </LazyScene>
                    </Show>
                  }
                >
                  <figure class="ev-stage-figure">
                    <img src={stage.imagePath!} alt={`${props.node.cropName}, ${stage.name}. ${t().journeyIllustrative}`} loading="lazy" decoding="async" />
                    <figcaption>{t().journeyIllustrative}</figcaption>
                  </figure>
                </Show>
                <div class="ev-stage-text">
                  <strong>{stage.name}</strong>
                  <span>
                    {labelDate(stage.from, lang())} – {labelDate(stage.to, lang())}
                  </span>
                  <Show when={stage.status === "ready" && stage.targetDate}>
                    <span class="ev-muted">{labelDate(stage.targetDate!, lang())}</span>
                  </Show>
                  <Show when={stageNotice(stage, lang())}>{(text) => <span class="ev-stage-reason">{text()}</span>}</Show>
                </div>
              </li>
            )}
          </For>
        </ol>
        <p class="ev-muted ev-journey-note">{t().schematicNote}</p>
      </Show>

      <Show when={sourceNote() && readyCount() > 0}>
        <p class="ev-muted">{sourceNote()}</p>
      </Show>
      <Show when={notice()}>
        <p class="ev-journey-notice" role="status">
          {notice()}
        </p>
      </Show>
      <Show when={control().progress}>
        <p class="ev-journey-progress" role="status" aria-live="polite">
          {t().journeyPredicting}
          <Show when={journey() && illustratedCount() > 0}> {t().journeyStageReady(readyCount(), illustratedCount())}</Show>
        </p>
      </Show>
      <Show when={phase() === "timeout"}>
        <p class="ev-journey-notice" role="status">
          {t().journeyTimeout}
        </p>
      </Show>
      <Show when={phase() === "error"}>
        <p class="ev-journey-notice is-error" role="alert">
          {error()}
        </p>
      </Show>

      <div class="ev-actions">
        <Show when={phase() === "timeout"}>
          <button type="button" class="ev-btn" onClick={() => void checkAgain()}>
            {t().journeyAgain}
          </button>
        </Show>
        <Show when={control().show}>
          <button type="button" class="ev-btn primary" disabled={control().disabled || !props.ctx.farmId} aria-disabled={control().disabled || !props.ctx.farmId} onClick={() => void predict()}>
            {control().retry ? t().journeyRetry : t().journeyPredict}
          </button>
        </Show>
      </div>
    </section>
  );
}
