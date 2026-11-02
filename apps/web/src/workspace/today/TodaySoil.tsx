import { For, Match, Show, Switch, batch, createContext, createEffect, createSignal, on, onCleanup, useContext, type Accessor, type JSX } from "solid-js";
import type { SoilReading, SoilReview } from "@harvest/contracts";
import { AiSpark } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { BiomarkerBar } from "../farm/SoilBiomarkers";
import { loadSoilReview, pollSoilReview, refreshSoilReview } from "../farm/soilReviewApi";
import { ratingChipTone, ratingLabel, showAiMark, valueText } from "../farm/soilReviewModel";
import {
  headlineOf,
  pickReadings,
  provenanceOf,
  readDismissed,
  runSoilCard,
  sharedProvenance,
  summaryFailed,
  writeDismissed,
  zoneLabels,
  type SoilCardApi,
  type SoilCardState,
} from "./todaySoilModel";
import "./today.css";
import "./today-soil.css";

/**
 * "Soil for this farm": up to five confirmed soil values as range bars with the zone names under each bar, or, when the
 * farm has no confirmed soil report, a prompt to upload one. Ratings, zones and axes come from the server; the AI mark
 * shows only beside model-written text or text still being written. The farm-level review is loaded once per farm and
 * session epoch.
 */
const PROMPT_TITLE = "Upload a soil report for better crop rotation planning";
const TITLE_ID = "today-soil-title";

function ZoneNames(props: { reading: SoilReading }) {
  return (
    <ol class="today-soil-zones" aria-hidden="true">
      <For each={zoneLabels(props.reading)}>
        {(zone) => (
          <li class={`today-soil-zone${zone.current ? " is-current" : ""}`} data-tone={zone.tone} style={{ left: `${zone.left * 100}%`, width: `${zone.width * 100}%` }}>
            {zone.label}
          </li>
        )}
      </For>
    </ol>
  );
}

function Row(props: { reading: SoilReading; review: SoilReview; showProvenance: boolean }) {
  const r = () => props.reading;
  return (
    <li class="today-soil-row" data-parameter={r().parameter}>
      <div class="today-soil-row-head">
        <span class="today-soil-label">{r().label}</span>
        <span class="today-soil-value">{valueText(r())}</span>
      </div>
      <BiomarkerBar reading={r()} />
      <ZoneNames reading={r()} />
      <div class="today-soil-row-foot">
        <Chip tone={ratingChipTone(r().rating)}>{ratingLabel(r().rating)}</Chip>
        <Show when={r().assumption}>
          <Chip tone="info">Assumed form</Chip>
        </Show>
        <Show when={props.showProvenance}>
          <span class="today-soil-prov">{provenanceOf(r(), props.review)}</span>
        </Show>
      </div>
    </li>
  );
}

function Shell(props: { class?: string; busy?: boolean; ai?: boolean; children: JSX.Element }) {
  return (
    <section class={`today-overview today-soil${props.class ? ` ${props.class}` : ""}`} aria-labelledby={TITLE_ID} aria-busy={props.busy ? "true" : undefined} data-testid="today-soil">
      <div class="today-overview-head">
        <h2 id={TITLE_ID}>Soil for this farm</h2>
        <Show when={props.ai}>
          <AiSpark use="soil_review" size={14} />
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** The card for a known state. Pure: the wiring (loading, polling, storage) lives in `TodaySoil`. */
export function TodaySoilView(props: { state: SoilCardState; dismissed: boolean; onUpload: () => void; onRecords: () => void; onRetry: () => void; onDismiss: () => void }) {
  return (
    <Switch>
      <Match when={props.state.kind === "loading" && !props.dismissed}>
        <Shell busy>
          <p class="today-soil-pending" aria-live="polite" data-testid="today-soil-loading">
            Loading your soil values…
          </p>
        </Shell>
      </Match>
      <Match when={props.state.kind === "failed"}>
        <Shell class="is-failed">
          <div class="today-soil-failed">
            <p role="alert" data-testid="today-soil-error">
              {(props.state as { reason: string }).reason === "review" ? "The soil values are not available right now." : "The soil values could not be loaded."}
            </p>
            <button type="button" class="btn compact secondary" onClick={() => props.onRetry()}>
              Retry
            </button>
          </div>
        </Shell>
      </Match>
      <Match when={props.state.kind === "review" && (props.state as { review: SoilReview }).review.status === "no_report" && !props.dismissed}>
        <Shell class="is-prompt">
          <p class="today-overview-headline">{PROMPT_TITLE}</p>
          <p class="today-soil-why">Soil ratings and what the next crop needs come from the values on a confirmed report.</p>
          <div class="today-soil-actions">
            <button type="button" class="btn compact" onClick={() => props.onUpload()}>
              Upload soil report
            </button>
            <button type="button" class="text-button" onClick={() => props.onDismiss()}>
              Not now
            </button>
          </div>
        </Shell>
      </Match>
      <Match when={props.state.kind === "review" && (props.state as { review: SoilReview }).review.status !== "no_report"}>
        {(() => {
          const view = () => props.state as Extract<SoilCardState, { kind: "review" }>;
          const review = () => view().review;
          const rows = () => pickReadings(review().readings);
          const headline = () => headlineOf(review());
          const shared = () => sharedProvenance(rows(), review());
          return (
            <Shell class={review().status} ai={showAiMark(review())}>
              <Show when={summaryFailed(review())}>
                <div class="today-soil-failed" data-testid="today-soil-summary-failed">
                  <p>The written soil summary could not be made.</p>
                  <button type="button" class="btn compact secondary" onClick={() => props.onRetry()}>
                    Retry
                  </button>
                </div>
              </Show>
              <Show when={!summaryFailed(review()) && headline().text}>
                <p class="today-overview-headline">{headline().text}</p>
              </Show>
              <Show when={headline().pending}>
                <p class="today-soil-pending" aria-live="polite" data-testid="today-soil-pending">
                  The ratings below are already calculated.
                </p>
              </Show>
              <Show when={headline().note}>
                <p class="today-soil-note" data-testid="today-soil-code-note">
                  {headline().note}
                </p>
              </Show>
              <Show when={rows().length > 0} fallback={<p class="today-soil-why">None of the confirmed values could be rated against a cited band.</p>}>
                <ul class="today-soil-list">
                  <For each={rows()}>{(reading) => <Row reading={reading} review={review()} showProvenance={shared() === null} />}</For>
                </ul>
                <Show when={shared()}>
                  <p class="today-soil-prov today-soil-shared" data-testid="today-soil-provenance">
                    {shared()}
                  </p>
                </Show>
              </Show>
              <div class="today-soil-actions">
                <button type="button" class="text-button" onClick={() => props.onRecords()}>
                  All soil values
                </button>
              </div>
            </Shell>
          );
        })()}
      </Match>
    </Switch>
  );
}

const defaultApi: SoilCardApi = {
  load: (farmId, opts) => loadSoilReview(farmId, opts),
  refresh: (farmId, opts) => refreshSoilReview(farmId, opts),
  poll: (farmId, initial, opts) => pollSoilReview(farmId, initial, opts),
};

/** The loaded card state and its actions, owned above the loading `Switch` so field switches and reloads reuse it. */
export type SoilCardController = {
  state: Accessor<SoilCardState>;
  dismissed: Accessor<boolean>;
  retry: () => void;
  dismiss: () => void;
};

/**
 * One soil review load per farm and session epoch. Create it once in a stable owner (the Today view root) and share it
 * through `SoilCardContext`; the card itself can then mount and unmount under the view's loading branches without
 * repeating `GET /soil-review`. "Not now" is kept in session storage per farm.
 */
export function createSoilCardController(farmId: Accessor<string | undefined>, epoch: Accessor<number>, api: SoilCardApi = defaultApi): SoilCardController {
  const [state, setState] = createSignal<SoilCardState>({ kind: "loading" });
  const [dismissed, setDismissed] = createSignal(false);
  let controller: AbortController | undefined;

  function start(id: string, force: boolean) {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    void runSoilCard(id, api, (next) => !ctrl.signal.aborted && setState(next), ctrl.signal, force);
  }

  // The previous farm's review is dropped at once and its late answer is aborted.
  createEffect(
    on(
      () => [farmId(), epoch()] as const,
      ([id]) => {
        batch(() => {
          setState({ kind: "loading" });
          setDismissed(id ? readDismissed(id) : false);
        });
        if (id) start(id, false);
        else controller?.abort();
      },
    ),
  );
  onCleanup(() => controller?.abort());

  return {
    state,
    dismissed,
    retry: () => {
      const id = farmId();
      if (!id) return;
      const current = state();
      setState({ kind: "loading" });
      start(id, (current.kind === "failed" && current.reason === "review") || (current.kind === "review" && summaryFailed(current.review)));
    },
    dismiss: () => {
      const id = farmId();
      if (id) writeDismissed(id);
      setDismissed(true);
    },
  };
}

export const SoilCardContext = createContext<SoilCardController>();

export default function TodaySoil(props: { farmId: string; epoch: number; onUpload: () => void; onRecords: () => void }) {
  // Inside the Today view the controller comes from the view root; standalone it loads for its own farm and epoch.
  const card = useContext(SoilCardContext) ?? createSoilCardController(() => props.farmId, () => props.epoch);
  return <TodaySoilView state={card.state()} dismissed={card.dismissed()} onUpload={props.onUpload} onRecords={props.onRecords} onRetry={card.retry} onDismiss={card.dismiss} />;
}
