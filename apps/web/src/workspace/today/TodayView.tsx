import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, untrack } from "solid-js";
import type { CareTask, FarmAlert, TodayView as TodayData, UpcomingStep } from "@harvest/contracts";
import { useWorkspace, today as browserToday } from "../state";
import { newEntryId } from "../../features/photo-region/http";
import { Icon } from "../icons";
import type { FieldBoundary } from "../fieldGeometry";
import type { TodayViewProps } from "./types";
import { completeCare, describeTodayError, dismissAlert, loadToday, type TodayErrorInfo } from "./todayApi";
import {
  dateAtIndex,
  formatDay,
  growthProgress,
  priceAt,
  sliderModel,
  stageAt,
  stageTicks,
  weatherAt,
} from "./model";
import { TodayHero, type HeroMode } from "./TodayHero";
import { StageSlider } from "./StageSlider";
import { TodayCards, type CardKind } from "./TodayCards";
import { AlertsList } from "./AlertsList";
import { UpcomingSteps, stepDomId } from "./UpcomingSteps";
import { TodayEmpty } from "./TodayEmpty";
import { TodaySheet, type SheetKind } from "./TodaySheet";
import "./today.css";

type LoadState =
  | { status: "idle" }
  | { status: "loading"; farmId: string }
  | { status: "ready"; farmId: string; view: TodayData }
  | { status: "error"; farmId: string; error: TodayErrorInfo };

/** A command-center care task as an upcoming step (used only while the Today endpoint is unavailable). */
export function careTaskStep(task: CareTask): UpcomingStep {
  return {
    id: `care:${task.id}`,
    kind: "care_task",
    title: task.title,
    detail: task.action,
    dueFrom: task.dueFrom,
    dueTo: task.dueTo,
    status: task.status,
    careTask: task,
    alertId: null,
  };
}

/**
 * Today tab: `GET /api/v1/farms/:id/today` drives one stage slider shared by the illustration, the satellite scene,
 * the stage label and the price and weather cards (docs/research/UI_BRIEF.md section 3.1).
 *
 * Isolation: every request and every local override (slider position, optimistic Done, dismissed alerts) is keyed
 * to the selected farm and session epoch; a farm switch clears them before the next farm loads, and a late response
 * for another farm is dropped. Degrading: when the endpoint is missing (404), unreachable or malformed, the hero shows
 * an error with Retry, the planting entry still shows when the farm has no crop, and the care schedule the shell
 * already loaded stays usable as the step list.
 */
export function TodayView(props: TodayViewProps) {
  const s = useWorkspace();
  const [load, setLoad] = createSignal<LoadState>({ status: "idle" });
  /** Slider index the farmer picked; null means "today". */
  const [pick, setPick] = createSignal<number | null>(null);
  const [completed, setCompleted] = createSignal<ReadonlySet<string>>(new Set());
  const [busyStep, setBusyStep] = createSignal("");
  const [stepError, setStepError] = createSignal("");
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [alertError, setAlertError] = createSignal("");
  const [sheet, setSheet] = createSignal<SheetKind | null>(null);
  const careEntries = new Map<string, string>();
  let request = 0;
  /** Workspace version this view last saw for the selected farm; undefined until the first version is known. */
  let seenVersion: number | undefined;

  const farmId = () => s.farm()?.id;
  const state = (): LoadState => {
    const current = load();
    return current.status === "idle" || current.farmId === farmId() ? current : { status: "idle" };
  };
  const view = () => {
    const current = state();
    return current.status === "ready" ? current.view : undefined;
  };
  const stale = (target: string, epoch: number) => target !== farmId() || epoch !== s.sessionEpoch();

  async function fetchView(target: string, epoch: number, quiet: boolean) {
    const id = ++request;
    if (!quiet) setLoad({ status: "loading", farmId: target });
    try {
      const next = await loadToday(target);
      if (id !== request || stale(target, epoch)) return;
      setLoad({ status: "ready", farmId: target, view: next });
    } catch (error) {
      if (id !== request || stale(target, epoch)) return;
      // A failed background refresh keeps the view that is already on screen, unless that view is the empty prompt
      // while the farm now has a crop: showing "nothing growing" would be wrong, so the error with Retry takes over.
      const staleEmpty = view() && !view()!.cycle && props.cycles().length > 0;
      if (quiet && state().status === "ready" && !staleEmpty) return;
      setLoad({ status: "error", farmId: target, error: describeTodayError(error) });
    }
  }
  const errorInfo = () => {
    const current = state();
    return current.status === "error" ? current.error : null;
  };
  const retry = () => {
    const target = farmId();
    if (target) void fetchView(target, s.sessionEpoch(), false);
  };

  // Farm or session change: drop everything that belonged to the previous farm, then load the next one.
  createEffect(
    on([farmId, s.sessionEpoch], ([target, epoch]) => {
      ++request;
      setPick(null);
      setCompleted(new Set<string>());
      setDismissed(new Set<string>());
      setBusyStep("");
      setStepError("");
      setAlertError("");
      setSheet(null);
      careEntries.clear();
      seenVersion = undefined;
      if (!target) {
        setLoad({ status: "idle" });
        return;
      }
      void fetchView(target, epoch, false);
    }),
  );
  // A saved workspace (for example a crop planted from the shell's dialog) refreshes the view without a skeleton.
  // The previous version is kept in `seenVersion` rather than read from `on(..., { defer: true })`: with `defer`, Solid
  // never records the first value as "previous", so the first change after the tab mounted was silently skipped and the
  // empty "What's growing on this field?" state stayed until a reload.
  createEffect(() => {
    const target = farmId();
    const version = s.workspace()?.farmId === target ? s.workspace()?.version : undefined;
    untrack(() => {
      const previous = seenVersion;
      if (version !== undefined) seenVersion = version;
      if (!target || version === undefined || previous === undefined || version === previous) return;
      void fetchView(target, s.sessionEpoch(), true);
    });
  });
  // A different cycle starts the slider at today again.
  createEffect(on(() => view()?.cycle?.id, () => setPick(null), { defer: true }));

  // ---------------------------------------------------------------- slider-driven values
  const slider = createMemo(() => {
    const current = view();
    return current ? sliderModel(current) : null;
  });
  const index = () => {
    const model = slider();
    if (!model) return 0;
    const chosen = pick();
    return chosen == null ? model.todayIndex : Math.max(0, Math.min(model.total, chosen));
  };
  const date = () => {
    const model = slider();
    return model ? dateAtIndex(model, index()) : view()?.today ?? browserToday();
  };
  const stage = createMemo(() => stageAt(view()?.timeline, date()));
  const progress = () => growthProgress(view()?.timeline, date());
  const price = createMemo(() => priceAt(view()?.priceTrack ?? [], date()));
  const weather = createMemo(() => weatherAt(view()?.weatherTrack ?? [], date()));
  const ticks = createMemo(() => {
    const model = slider();
    return model ? stageTicks(view()?.timeline, model) : [];
  });
  const mode = (): HeroMode => (props.scene() === "satellite" ? "satellite" : "illustration");
  const boundary = () => (props.workspace()?.boundary ?? null) as FieldBoundary | null;
  const cropName = () => {
    const current = view();
    if (!current?.cycle) return "";
    return current.product?.cropName ?? current.cycle.cropName ?? s.cropName(current.cycle.cropId);
  };
  const otherCycles = () => {
    const current = view()?.cycle?.id;
    return current ? props.cycles().filter((entry) => entry.cycle.id !== current) : [];
  };

  // ---------------------------------------------------------------- steps and alerts
  const fallbackSteps = () =>
    state().status === "error" && props.data() ? props.tasks().map(careTaskStep) : [];
  const steps = createMemo(() => {
    const source = view()?.upcoming ?? fallbackSteps();
    const done = completed();
    return source.map((step) => (done.has(step.id) && step.status !== "completed" ? { ...step, status: "completed" as const } : step));
  });
  const alerts = () => (view()?.alerts ?? []).filter((alert) => !dismissed().has(alert.id));
  const stepAlertIds = () => new Set(steps().flatMap((step) => (step.alertId ? [step.alertId] : [])));

  async function markDone(step: UpcomingStep) {
    const task = step.careTask,
      target = farmId(),
      epoch = s.sessionEpoch();
    if (!task || !target || busyStep()) return;
    const key = `${target}|${task.cycleId}|${task.id}`;
    const entry = careEntries.get(key) ?? newEntryId("care");
    careEntries.set(key, entry);
    setBusyStep(step.id);
    setStepError("");
    setCompleted((previous) => new Set(previous).add(step.id));
    try {
      await completeCare(target, task, entry, view()?.today ?? browserToday());
      if (stale(target, epoch)) return;
      s.setNotice("Care activity recorded in your field journal.");
      if (state().status === "ready") void fetchView(target, epoch, true);
    } catch (error) {
      if (stale(target, epoch)) return;
      setCompleted((previous) => {
        const next = new Set(previous);
        next.delete(step.id);
        return next;
      });
      setStepError(`Could not record "${step.title}". ${(error as Error).message}`);
    } finally {
      if (!stale(target, epoch)) setBusyStep("");
    }
  }

  async function dismiss(alert: FarmAlert) {
    const target = farmId(),
      epoch = s.sessionEpoch();
    if (!target) return;
    setAlertError("");
    setDismissed((previous) => new Set(previous).add(alert.id));
    try {
      await dismissAlert(target, alert.id);
    } catch (error) {
      if (stale(target, epoch)) return;
      setDismissed((previous) => {
        const next = new Set(previous);
        next.delete(alert.id);
        return next;
      });
      setAlertError(`Could not dismiss "${alert.title}". ${(error as Error).message}`);
    }
  }

  const showStep = (alert: FarmAlert) => {
    const step = steps().find((item) => item.alertId === alert.id);
    const node = step ? document.getElementById(stepDomId(step.id)) : null;
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
    node?.focus({ preventScroll: true });
  };
  const openDetails = (kind: CardKind) => setSheet(kind);
  const canPlant = () => !!props.data();

  const lists = (current: TodayData) => (
    <div class="today-lists">
      <AlertsList
        alerts={alerts()}
        newsReview={current.newsReview}
        today={current.today}
        stepAlertIds={stepAlertIds()}
        onDismiss={(alert) => void dismiss(alert)}
        onSuggested={showStep}
        error={alertError()}
      />
      <Show when={current.cycle}>
        <UpcomingSteps
          steps={steps()}
          nextAction={current.nextAction ?? null}
          today={current.today}
          busyId={busyStep()}
          onDone={(step) => void markDone(step)}
          error={stepError()}
          sources={props.data()?.sources}
        />
      </Show>
    </div>
  );

  return (
    <div class="today-view" aria-busy={state().status === "loading"}>
      <Switch>
        <Match when={state().status === "idle" || state().status === "loading"}>
          <div class="today-layout" role="status" aria-label="Loading today's field view">
            <div class="today-primary">
              <div class="today-skeleton today-skeleton-hero" />
              <div class="today-skeleton today-skeleton-slider" />
            </div>
            <div class="today-cards" aria-hidden="true">
              <For each={[0, 1, 2, 3]}>{() => <div class="today-skeleton today-skeleton-card" />}</For>
            </div>
          </div>
        </Match>
        <Match when={state().status === "error"}>
          <div class="today-layout">
            <div class="today-primary">
              <Show
                when={props.cycles().length || !props.data()}
                fallback={<TodayEmpty onPlant={() => props.openPlant()} canPlant={canPlant()} />}
              >
                <section class="today-hero" aria-label="Your field">
                  <div class="today-hero-frame today-hero-error">
                    <div class="today-hero-message" role="alert">
                      <Icon name="info" size={22} />
                      <strong>Today's field view is unavailable</strong>
                      <span>{errorInfo()?.message}</span>
                      <Show when={props.active()}>
                        {(entry) => (
                          <span class="today-recorded-crop" data-testid="today-recorded-crop">
                            Recorded crop: {entry().cycle.cropName ?? s.cropName(entry().cycle.cropId)}, sown {formatDay(entry().cycle.sowingDate)}
                          </span>
                        )}
                      </Show>
                      <button type="button" class="btn compact secondary" onClick={retry}>
                        Retry
                      </button>
                    </div>
                  </div>
                </section>
              </Show>
            </div>
            <Show when={props.cycles().length}>
              <div class="today-lists">
                <UpcomingSteps
                  steps={steps()}
                  busyId={busyStep()}
                  onDone={(step) => void markDone(step)}
                  error={stepError()}
                  sources={props.data()?.sources}
                  note={props.data() ? "From your crop care schedule" : "Care schedule not loaded"}
                  today={browserToday()}
                />
              </div>
            </Show>
          </div>
        </Match>
        <Match when={view() && !view()!.cycle}>
          <div class="today-layout is-empty">
            <div class="today-primary">
              <TodayEmpty onPlant={() => props.openPlant()} canPlant={canPlant()} />
            </div>
            <TodayCards view={view()!} date={view()!.today} price={null} weather={weatherAt(view()!.weatherTrack, view()!.today)} weatherOnly onDetails={openDetails} />
            {lists(view()!)}
          </div>
        </Match>
        <Match when={view()?.cycle}>
          <div class="today-layout">
            <div class="today-primary">
              <TodayHero
                mode={mode()}
                onMode={(next) => props.setScene(next === "satellite" ? "satellite" : "growth")}
                date={date()}
                today={view()!.today}
                stage={stage()}
                progress={progress()}
                cropId={view()!.cycle!.cropId}
                cropName={cropName()}
                boundary={boundary()}
                scenes={view()!.scenes}
                imageBbox={view()!.ndvi?.imageBbox ?? null}
              />
              <Show
                when={slider()}
                fallback={<p class="today-note">Stage dates are not available for this crop yet, so the season slider is hidden.</p>}
              >
                {(model) => (
                  <StageSlider
                    model={model()}
                    value={index()}
                    onChange={(next) => setPick(next)}
                    valueDate={date()}
                    ticks={ticks()}
                    onBackToToday={() => setPick(null)}
                    startLabel={`Sown ${formatDay(view()!.cycle!.sowingDate, false)}`}
                    endLabel={`Harvest by ${formatDay(model().to, false)}`}
                  />
                )}
              </Show>
              <Show when={otherCycles().length}>
                <p class="today-note">
                  Also growing: {otherCycles().map((entry) => entry.cycle.cropName ?? s.cropName(entry.cycle.cropId)).join(", ")}. This view
                  shows {cropName()}.
                </p>
              </Show>
            </div>
            <TodayCards view={view()!} date={date()} price={price()} weather={weather()} onDetails={openDetails} />
            {lists(view()!)}
            <button type="button" class="text-button today-about" onClick={() => setSheet("about")}>
              <Icon name="info" size={14} /> About this view
            </button>
          </div>
        </Match>
      </Switch>
      <Show when={sheet() && view()}>
        <TodaySheet kind={sheet()!} view={view()!} date={date()} price={price()} weather={weather()} onClose={() => setSheet(null)} />
      </Show>
    </div>
  );
}
