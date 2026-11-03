import { For, Match, Show, Switch, batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { SoilNarrative, SoilReview } from "@harvest/contracts";
import { AiSparkInline } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { SoilBiomarkers } from "./SoilBiomarkers";
import { SoilReviewContractError, loadSoilReview, pollSoilReview, refreshAndPoll } from "./soilReviewApi";
import { isActive, showAiMark } from "./soilReviewModel";
import "./soil-review.css";

/**
 * Soil review (ROUND2_SPEC.md 5.3): the Meta narrative (lines, "After this harvest", "For the next crop") over the
 * biomarker rows. The server rates every confirmed value in code and returns the readings at once; the narrative arrives
 * when the job finishes, so this panel polls while the review is pending and shows the pending indicator. The AI mark is
 * shown only beside model-written text or text still being written. A code-written narrative says so.
 */
const FARM_SETTINGS = (farmId: string) => `/farm/settings?farmId=${encodeURIComponent(farmId)}`;
const NEXT_SOURCE: Record<NonNullable<SoilReview["nextCrop"]>["source"], string> = { year_plan_applied: "your applied year plan", saved_season: "your saved seasons" };

function Lines(props: { items: readonly string[]; label: string }) {
  return (
    <ul class="sr-lines" aria-label={props.label}>
      <For each={props.items}>{(line) => <li>{line}</li>}</For>
    </ul>
  );
}

function Narrative(props: { narrative: SoilNarrative }) {
  return (
    <div class="sr-narrative">
      <Lines items={props.narrative.lines} label="What your soil values show" />
      <Show when={props.narrative.afterHarvest.length > 0}>
        <section class="sr-block" aria-label="After this harvest">
          <h3>After this harvest</h3>
          <Lines items={props.narrative.afterHarvest} label="After this harvest" />
        </section>
      </Show>
      <Show when={props.narrative.nextCrop.length > 0}>
        <section class="sr-block" aria-label="For the next crop">
          <h3>For the next crop</h3>
          <Lines items={props.narrative.nextCrop} label="For the next crop" />
        </section>
      </Show>
    </div>
  );
}

export interface SoilReviewViewProps {
  review: SoilReview;
  farmId: string;
  refreshing: boolean;
  refreshError: string;
  onRefresh: () => void;
}

/** The panel's markup for one loaded review (the wrapper below owns loading, polling and Refresh). */
export function SoilReviewView(props: SoilReviewViewProps) {
  const r = () => props.review;
  const busy = () => props.refreshing || isActive(r());
  return (
    <section class="sr-panel" aria-labelledby="sr-title">
      <header class="sr-head">
        <h2 id="sr-title" class="sr-title">
          Soil review
        </h2>
        <Show when={showAiMark(r())}>
          <AiSparkInline use="soil_review" />
        </Show>
        <Show when={r().status !== "no_report"}>
          <button type="button" class="text-button sr-refresh" disabled={busy()} onClick={() => props.onRefresh()}>
            Refresh
          </button>
        </Show>
      </header>
      <Switch>
        <Match when={r().status === "no_report"}>
          <div class="sr-empty">
            <p>No confirmed soil report for this field yet. Upload a report and confirm its values to see them rated against standard soil-test bands.</p>
            <a class="text-link" href={FARM_SETTINGS(props.farmId)}>
              Upload a soil report
            </a>
          </div>
        </Match>
        <Match when={true}>
          <Show when={r().currentCrop || r().nextCrop}>
            <p class="sr-context">
              <Show when={r().currentCrop}>
                <span>Growing now: {r().currentCrop!.cropName}</span>
              </Show>
              <Show when={r().nextCrop}>
                <span>
                  Next: {r().nextCrop!.cropName} (from {NEXT_SOURCE[r().nextCrop!.source]})
                </span>
              </Show>
            </p>
          </Show>
          <Show when={isActive(r())}>
            <div class="sr-pending" role="status" aria-live="polite">
              <Chip tone="model" pulse>
                Writing the review
              </Chip>
              <span>The ratings below are already calculated.</span>
            </div>
          </Show>
          <Show when={r().status === "error"}>
            <p class="sr-error" role="alert">
              The review text could not be written. The ratings below are still calculated; try Refresh.
            </p>
          </Show>
          <Show when={props.refreshError}>
            <p class="sr-error" role="alert">
              {props.refreshError}
            </p>
          </Show>
          <Show when={r().narrative}>
            <Narrative narrative={r().narrative!} />
            <p class="sr-origin">
              {r().narrativeOrigin === "model"
                ? "Written by Meta from the facts below. Every number is calculated by code."
                : "Written by code from the facts below."}
            </p>
          </Show>
          <SoilBiomarkers readings={r().readings} />
          <Show when={r().facts.length > 0}>
            <details class="sr-details">
              <summary>What this review is based on</summary>
              <ul>
                <For each={r().facts}>{(fact) => <li>{fact}</li>}</For>
              </ul>
            </details>
          </Show>
          <Show when={r().limitations.length > 0}>
            <details class="sr-details">
              <summary>About these ratings</summary>
              <ul>
                <For each={r().limitations}>{(line) => <li>{line}</li>}</For>
              </ul>
            </details>
          </Show>
          <p class="sr-full">
            <a class="text-link sr-full-link" href="#soil-report-values">
              Full report values
            </a>
          </p>
        </Match>
      </Switch>
    </section>
  );
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };
const failureText = (error: unknown): string =>
  error instanceof SoilReviewContractError ? error.message : "The soil review could not be loaded. Check your connection and try again.";

export default function SoilReviewPanel(props: {
  farmId: string;
  /**
   * 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.3, 12.6): the field whose current and next crop frame the review
   * (`?fieldId=`); the soil values stay farm-level and the server says so in a limitation line. Null or omitted = the whole farm.
   */
  fieldId?: string | null | undefined;
}) {
  const field = () => props.fieldId ?? null;
  const [review, setReview] = createSignal<SoilReview | null>(null);
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" });
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal("");
  let controller: AbortController | undefined;
  let generation = 0;

  /** GET (the server creates the review when none exists) and poll while pending; `force` is Refresh (POST, then poll). */
  async function load(id: string, force: boolean) {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const gen = generation;
    const fieldId = field();
    const ok = () => !ctrl.signal.aborted && gen === generation && props.farmId === id && field() === fieldId;
    const show = (next: SoilReview) => {
      if (!ok()) return;
      batch(() => {
        setReview(next);
        setPhase({ kind: "ready" });
      });
    };
    const opts = { signal: ctrl.signal, onUpdate: show, fieldId };
    try {
      if (force) {
        show(await refreshAndPoll(id, opts));
        return;
      }
      const current = await loadSoilReview(id, { signal: ctrl.signal, fieldId });
      show(current);
      if (isActive(current)) show(await pollSoilReview(id, current, opts));
    } catch (error) {
      if (!ok()) return;
      if (review()) setRefreshError(failureText(error));
      else setPhase({ kind: "failed", message: failureText(error) });
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
      ([id]) => {
        generation++;
        controller?.abort();
        batch(() => {
          setReview(null);
          setRefreshError("");
          setRefreshing(false);
          setPhase({ kind: "loading" });
        });
        if (id) void load(id, false);
      },
    ),
  );
  onCleanup(() => {
    generation++;
    controller?.abort();
  });

  const refresh = () => {
    batch(() => {
      setRefreshing(true);
      setRefreshError("");
    });
    void load(props.farmId, true);
  };

  return (
    <Switch>
      <Match when={phase().kind === "loading"}>
        <section class="sr-panel" aria-busy="true" aria-live="polite">
          <h2 class="sr-title">Soil review</h2>
          <p class="sr-muted">Reading your soil values...</p>
        </section>
      </Match>
      <Match when={phase().kind === "failed"}>
        <section class="sr-panel">
          <h2 class="sr-title">Soil review</h2>
          <p class="sr-error" role="alert">
            {(phase() as { message: string }).message}
          </p>
          <button type="button" class="text-button" onClick={() => { setPhase({ kind: "loading" }); void load(props.farmId, false); }}>
            Try again
          </button>
        </section>
      </Match>
      <Match when={review()}>
        <SoilReviewView review={review()!} farmId={props.farmId} refreshing={refreshing()} refreshError={refreshError()} onRefresh={refresh} />
      </Match>
    </Switch>
  );
}
