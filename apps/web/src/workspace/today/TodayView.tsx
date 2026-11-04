import { SeasonPredictionStatus } from './SeasonPredictionStatus';
import { FieldImage } from "./FieldImage";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, untrack, type JSX } from "solid-js";
import type { CareTask, CompleteCheck, FarmAlert, FieldSummary, PricePoint, TodayView as TodayData, UpcomingStep, WeatherPoint } from "@harvest/contracts";
import { useLocation, useNavigate } from "@solidjs/router";
import { boundaryArea, useWorkspace, today as browserToday, type Field } from "../state";
import { newEntryId } from "../../features/photo-region/http";
import { Icon } from "../icons";
import type { FieldBoundary } from "../fieldGeometry";
import type { TodayViewProps } from "./types";
import {
  completeCare,
  describeTodayError,
  dismissAlert,
  loadToday,
  pollPrediction,
  PREDICTION_RELOAD_REASONS,
  predictionErrorReason,
  predictionMessage,
  requestPrediction,
  type TodayErrorInfo,
} from "./todayApi";
import {
  conditionAt,
  createSeasonPlayer,
  dateAtIndex,
  formatDay,
  growthProgress,
  predictionBlockedReason,
  predictionSourceScene,
  priceAt,
  sceneMarks,
  sliderModel,
  stageAt,
  stageTicks,
  weatherAt,
  withoutDismissed,
} from "./model";
import { heroFieldOf, TodayHero, type FarmHero, type HeroField, type HeroMode, type HeroPrediction } from "./TodayHero";
import { StageSlider } from "./StageSlider";
import { healthHeadline, TodayCards, type CardKind } from "./TodayCards";
import { TodayOverview } from "./TodayOverview";
import { TodayCropArea } from "./TodayCropArea";
import { AlertsList, isFarmWide } from "./AlertsList";
import { UpcomingSteps, stepDomId } from "./UpcomingSteps";
import { AttentionPanel, EvaraPanel, GaugesPanel, GlancePanel, MapCentre, ThisWeekPanel, TodayHeadline, TodayMapLayout, WeekPanel } from "./TodayMapLayout";
import { TodayOutlook } from "./TodayOutlook";
import { ActionsBoard } from "./ActionsBoard";
import { attentionItems, glanceFacts, greennessGauge, stageGauge, waterGauge, weekAhead, weekPlan, weekTakeaway } from "./todayMapModel";
import { farmHref } from "../farmTabs";
import { ASSISTANT_PROMPTS } from "../../features/ask/model";
import { TodayEmpty } from "./TodayEmpty";
import { TodaySheet, type SheetKind } from "./TodaySheet";
import TodaySoil, { createSoilCardController, SoilCardContext } from "./TodaySoil";
import { FieldChips, FieldsLegend, FieldsTable, type FieldChipItem } from "../fields/FieldsToday";
import { boundsPolygon, defaultPlantField, type FieldCycleLike } from "../fields/fieldsModel";
import { completeCheck } from "../scouting/scoutingApi";
import { checkCompletionNotice, clearScoutingDraft, issueFromSearch, runCheckCompletion, withId, withIssueParam, withoutId } from "../scouting/scoutingModel";
import { scoutingStore } from "../scouting/scoutingStore";
import { CheckCompleteSheet, checkSlot } from "../scouting/CheckCompleteSheet";
import { IssueSheet } from "../scouting/IssueSheet";
import { ISSUES_SECTION_ID, IssuesLine, IssuesSection } from "../scouting/IssuesList";
import type { FieldOption } from "../scouting/IssueForm";
import type { Boundary } from "../state";
import "./today.css";
import "./today-glass.css";
import "./today-cards-compact.css";
import "./today-layout.css";

/** `fieldId` is the field the request asked for (null: no field, the farm view or the "All fields" overview). */
type LoadState =
  | { status: "idle" }
  | { status: "loading"; farmId: string; fieldId: string | null }
  | { status: "ready"; farmId: string; fieldId: string | null; view: TodayData }
  | { status: "error"; farmId: string; fieldId: string | null; error: TodayErrorInfo };

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
 * Present the daily brief first, keep condition with the field, and group weather, soil and harvest economics.
 * These are the same cards and callbacks; their data and detail sheets have a single owner.
 */
export function TodaySide(props: {
  view: TodayData;
  farmId: string;
  epoch: number;
  date: string;
  price: PricePoint | null;
  weather: WeatherPoint | null;
  onDetails: (kind: CardKind) => void;
  onUpload: () => void;
  onRecords: () => void;
  primary?: JSX.Element;
}) {
  return (
    <>
      <TodayOverview overview={props.view.overview} onDetails={props.onDetails} />
      <div class="today-primary">
        {props.primary}
      </div>
      <div class="today-side">
        <TodayCards group="conditions" view={props.view} date={props.date} price={props.price} weather={props.weather} onDetails={props.onDetails} />
        <TodayCards group="field" view={props.view} date={props.date} price={props.price} weather={props.weather} onDetails={props.onDetails} />
        <TodaySoil farmId={props.farmId} epoch={props.epoch} onUpload={props.onUpload} onRecords={props.onRecords} />
      </div>
      <TodayCards group="outlook" view={props.view} date={props.date} price={props.price} weather={props.weather} onDetails={props.onDetails} />
      <TodayCropArea fields={props.view.fields ?? []} />
      <Show when={props.view.energyFootprint || props.view.carbonFootprint}>
        <TodayCards group="planning" view={props.view} date={props.date} price={props.price} weather={props.weather} onDetails={props.onDetails} />
      </Show>
    </>
  );
}

/**
 * Which Today layout a farm gets (FIELDS_MULTICROP_SOIL_SPEC.md 6.3): "none" on a farm without fields (exactly the view it
 * had before fields existed), "all" for the "All fields" overview, "field" for one selected field. Fields come from the
 * loaded view, else from the stored workspace (so the chips show while the view loads).
 */
export type FieldsMode = "none" | "all" | "field";
export function fieldsMode(summaries: readonly unknown[], workspaceFields: readonly unknown[], selected: string | null | undefined): FieldsMode {
  if (!summaries.length && !workspaceFields.length) return "none";
  return selected ? "field" : "all";
}

/** The chips row, shown only on a farm with fields. */
export function TodayFieldChips(props: { mode: FieldsMode; items: readonly FieldChipItem[]; selected: string | null | undefined; onSelect: (fieldId: string | null) => void }) {
  return (
    <Show when={props.mode !== "none"}>
      <FieldChips items={props.items} selected={props.selected} onSelect={props.onSelect} />
    </Show>
  );
}

/** Crop names by crop id from the field summaries (main and companion), for the scene labels. */
export function summaryCropNames(fields: readonly FieldSummary[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const field of fields) {
    if (!field.cycle) continue;
    names[field.cycle.cropId] = field.cycle.cropName;
    if (field.cycle.companion) names[field.cycle.companion.cropId] = field.cycle.companion.cropName;
  }
  return names;
}

/**
 * The "All fields" hero input: the farm boundary (else the box around the fields, when the farm has no outer boundary) and
 * every field summary. Null without summaries.
 */
export function farmHeroOf(view: Pick<TodayData, "fields" | "farmBoundary" | "field">, fallbackBoundary?: FieldBoundary | null): FarmHero | null {
  const fields = view.fields ?? [];
  if (!fields.length) return null;
  const boundary = (view.farmBoundary ?? fallbackBoundary ?? boundsPolygon(fields.map((f) => f.boundary))) as FieldBoundary | null;
  return boundary ? { boundary, fields, selectedId: view.field?.id ?? null } : null;
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
  /** Field operations (FIELD_OPERATIONS_SPEC.md 4, 5): the check being completed, and a reload counter for the issue list. */
  const [checkStep, setCheckStep] = createSignal<UpcomingStep | null>(null);
  const [issuesReload, setIssuesReload] = createSignal(0);
  const location = useLocation();
  const navigate = useNavigate();
  /** Play the season (spec section 10.1 item 6): one day per 120 ms to the end; any slider interaction pauses. */
  const [playing, setPlaying] = createSignal(false);
  /** "Predict with AI" (spec 11.4): the request in flight or its last message, keyed to the farm and field it was made on. */
  const [predicting, setPredicting] = createSignal<{ farmId: string; fieldId: string | null; busy: boolean; message: string | null } | null>(null);
  /** One prediction request in flight per farm: a double tap, or a tap while polling, is ignored. */
  const predictionsInFlight = new Set<string>();
  /** Quiet refreshes while the server reports a look being made (see the pending effect below). */
  const PENDING_REFRESH_MS = 20_000;
  const PENDING_REFRESH_LIMIT = 9;
  let pendingRefreshes = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const careEntries = new Map<string, string>();
  let request = 0;
  /** Workspace version this view last saw for the selected farm; undefined until the first version is known. */
  let seenVersion: number | undefined;

  const farmId = createMemo(() => s.farm()?.id);
  /** The shell's field selection: an id, null (no field / All fields), or undefined while it cannot tell yet (the view waits). */
  // Only a resolved field change resets this controller; unrelated URL parameters (such as the presentation tab) do not.
  const fieldKey = createMemo(() => props.field());
  const state = (): LoadState => {
    const current = load();
    if (current.status === "idle") return current;
    const field = fieldKey();
    return current.farmId === farmId() && field !== undefined && current.fieldId === field ? current : { status: "idle" };
  };
  const view = () => {
    const current = state();
    return current.status === "ready" ? current.view : undefined;
  };
  const stale = (target: string, epoch: number) => target !== farmId() || epoch !== s.sessionEpoch();

  async function fetchView(target: string, fieldId: string | null, epoch: number, quiet: boolean) {
    const id = ++request;
    if (!quiet) setLoad({ status: "loading", farmId: target, fieldId });
    try {
      const next = await loadToday(target, undefined, fieldId);
      if (id !== request || stale(target, epoch) || fieldKey() !== fieldId) return;
      setLoad({ status: "ready", farmId: target, fieldId, view: next });
    } catch (error) {
      if (id !== request || stale(target, epoch) || fieldKey() !== fieldId) return;
      // A failed background refresh keeps the view that is already on screen, unless that view is the empty prompt
      // while the farm now has a crop: showing "nothing growing" would be wrong, so the error with Retry takes over.
      const staleEmpty = view() && !view()!.cycle && props.cycles().length > 0;
      if (quiet && state().status === "ready" && !staleEmpty) return;
      setLoad({ status: "error", farmId: target, fieldId, error: describeTodayError(error) });
    }
  }
  const errorInfo = () => {
    const current = state();
    return current.status === "error" ? current.error : null;
  };
  const retry = () => {
    const target = farmId(),
      field = fieldKey();
    if (target && field !== undefined) void fetchView(target, field, s.sessionEpoch(), false);
  };

  // Farm or session change: drop everything that belonged to the previous farm, then load the next one. A field change
  // (FIELDS_MULTICROP_SOIL_SPEC.md 6.3) keeps the farm's local overrides (dismissed alerts, optimistic Done) and only
  // resets the slider and the open sheet before loading that field.
  let lastFarm: string | undefined;
  let lastEpoch: number | undefined;
  createEffect(
    on([farmId, s.sessionEpoch, fieldKey], ([target, epoch, field]) => {
      const farmChanged = target !== lastFarm || epoch !== lastEpoch;
      lastFarm = target;
      lastEpoch = epoch;
      ++request;
      player.stop();
      setPick(null);
      setSheet(null);
      setCheckStep(null);
      setPredicting(null);
      pendingRefreshes = 0;
      if (farmChanged) {
        setCompleted(new Set<string>());
        setDismissed(new Set<string>());
        setBusyStep("");
        setStepError("");
        setAlertError("");
        careEntries.clear();
        seenVersion = undefined;
      }
      if (!target) {
        setLoad({ status: "idle" });
        return;
      }
      // The shell is still resolving a `?field=` link against the farm's fields: wait (the skeleton shows).
      if (field === undefined) return;
      void fetchView(target, field, epoch, false);
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
      const field = fieldKey();
      if (!target || version === undefined || previous === undefined || version === previous || field === undefined) return;
      void fetchView(target, field, s.sessionEpoch(), true);
    });
  });
  // Compare stable identities, not refreshed response objects: polling must keep the selected day.
  const cycleId = createMemo(() => view()?.cycle?.id);
  // A different cycle starts the slider at today again.
  createEffect(
    on(
      cycleId,
      () => {
        player.stop();
        setPick(null);
      },
      { defer: true },
    ),
  );

  // ---------------------------------------------------------------- slider-driven values
  const slider = createMemo(() => {
    const current = view();
    if (!current) return null;
    const harvest = current.cycle?.harvestDate;
    return sliderModel(harvest && current.slider && harvest > current.slider.to
      ? {...current,slider:{...current.slider,to:harvest}} : current);
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
    return model ? stageTicks(view()?.timeline, model, view()?.cycle?.harvestDate) : [];
  });
  const marks = createMemo(() => {
    const model = slider();
    return model ? sceneMarks(view()?.scenes ?? [], model) : [];
  });
  // The slider day's field condition, without alerts dismissed on this screen.
  const condition = createMemo(() => withoutDismissed(conditionAt(view()?.conditions, date()), dismissed()));
  const player = createSeasonPlayer({
    position: index,
    total: () => slider()?.total ?? 0,
    step: (next) => setPick(next),
    onChange: setPlaying,
  });
  onCleanup(() => player.stop());
  // Actions shares this controller, but hidden playback must not move the selected day.
  createEffect(() => {
    if (props.presentation === "actions") player.stop();
  });
  const togglePlay = () => (player.playing ? player.stop() : player.start());
  const mode = (): HeroMode => (props.scene() === "field-image" ? "field-image" : props.scene() === "satellite" ? "satellite" : "illustration");

  // ---------------------------------------------------------------- fields (FIELDS_MULTICROP_SOIL_SPEC.md 5, 6.3)
  const workspaceFields = (): Field[] => (props.workspace() as { fields?: Field[] } | undefined)?.fields ?? [];
  const summaries = (): FieldSummary[] => view()?.fields ?? [];
  /** The farm has fields: chips, the overview and field views apply. A farm without fields looks exactly as before. */
  const layout = () => fieldsMode(summaries(), workspaceFields(), fieldKey());
  const hasFields = () => layout() !== "none";
  const selectedId = () => (layout() === "field" ? (fieldKey() ?? null) : null);
  const overview = () => layout() === "all";
  const fieldNamed = (id: string | null | undefined) =>
    id ? (summaries().find((f) => f.id === id)?.name ?? workspaceFields().find((f) => f.id === id)?.name ?? null) : null;
  /** The field the loaded view describes (its name labels the hero, the overlay and the empty state). */
  const viewField = () => view()?.field ?? null;
  const fieldName = () => viewField()?.name ?? fieldNamed(selectedId());
  const fieldBoundaryOf = (id: string) =>
    (summaries().find((f) => f.id === id)?.boundary ?? workspaceFields().find((f) => f.id === id)?.boundary ?? null) as FieldBoundary | null;
  const farmBoundary = () => (view()?.farmBoundary ?? props.workspace()?.boundary ?? null) as FieldBoundary | null;
  /** The polygon the view describes: the selected field's own ring, else the farm boundary (unchanged for farms without fields). */
  const boundary = () => {
    const id = viewField()?.id;
    return (id && !overview() ? fieldBoundaryOf(id) : null) ?? farmBoundary();
  };
  const farmHero = createMemo(() => {
    const current = view();
    return overview() && current ? farmHeroOf(current, farmBoundary()) : null;
  });
  const otherFields = (): HeroField[] => {
    const id = viewField()?.id;
    return summaries().filter((f) => f.id !== id).map(heroFieldOf);
  };
  const cropNames = () => summaryCropNames(summaries());
  /** The field the plant dialog will choose by default when nothing is selected (named on the empty state). */
  const plantFieldName = () => fieldName() ?? fieldNamed(defaultPlantField(workspaceFields(), (props.workspace()?.cycles ?? []) as FieldCycleLike[], null));
  // One soil load per farm and epoch, owned by the view root: the card under the loading branches reads it, so a field
  // switch or a reload does not repeat GET /soil-review.
  // It follows the selected field (the review the Farm tab shows for it); "All fields" keeps the farm-wide review.
  const soilCard = createSoilCardController(farmId, () => s.sessionEpoch(), undefined, fieldKey);
  const soilProps = () => ({ onUpload: () => props.showTool("soil"), onRecords: () => props.openSoilRecords() });
  const cropName = () => {
    const current = view();
    if (!current?.cycle) return "";
    return current.product?.cropName ?? current.cycle.cropName ?? s.cropName(current.cycle.cropId);
  };
  // On a farm with fields the chips name every field's crop, so the "Also growing" line is not needed.
  const otherCycles = () => {
    const current = view()?.cycle?.id;
    return current && !hasFields() ? props.cycles().filter((entry) => entry.cycle.id !== current) : [];
  };

  // ---------------------------------------------------------------- AI-predicted looks (FIELDS_MULTICROP_SOIL_SPEC.md 11.4)
  const reloadQuiet = (target: string, epoch: number) => {
    const field = fieldKey();
    if (!stale(target, epoch) && field !== undefined) void fetchView(target, field, epoch, true);
  };
  /**
   * POSTs a gap look for the slider date from the latest real scene, polls the asset every 3 s for up to 3 minutes, then
   * reloads the view quietly so the new predicted scene arrives through `scenes`. A tap while a request for this farm is in
   * flight does nothing. A changed latest scene reloads the view; every other refusal leaves a short message.
   */
  async function predict(targetDate: string, opts: { regenerate?: boolean } = {}) {
    const target = farmId(),
      epoch = s.sessionEpoch(),
      current = view(),
      field = fieldKey() ?? null;
    const source = current ? predictionSourceScene(current.scenes) : null;
    if (!target || !current?.cycle || !source?.itemId || predictionsInFlight.has(target)) return;
    predictionsInFlight.add(target);
    const mine = () => {
      const now = predicting();
      return !stale(target, epoch) && now?.farmId === target && now.fieldId === field;
    };
    setPredicting({ farmId: target, fieldId: field, busy: true, message: null });
    let reason: string | null = null;
    try {
      const result = await requestPrediction(target, source.itemId, targetDate, current.cycle.id, undefined, opts);
      if (result.status !== "ready" && result.assetId) {
        const outcome = await pollPrediction(target, result.assetId, { cancelled: () => !mine() });
        if (outcome.status === "cancelled") return;
        if (outcome.status !== "ready") reason = outcome.reason;
      }
    } catch (error) {
      reason = predictionErrorReason(error);
    } finally {
      predictionsInFlight.delete(target);
    }
    if (!mine()) return;
    setPredicting(reason ? { farmId: target, fieldId: field, busy: false, message: predictionMessage(reason) } : null);
    if (!reason || PREDICTION_RELOAD_REASONS.has(reason)) reloadQuiet(target, epoch);
  }
  /**
   * While the server reports a look being made (an automatic one for today, or one from another tab), the view refreshes
   * quietly every 20 s, at most 9 times per pending stretch (3 minutes), so the look appears without a manual reload.
   */
  createEffect(() => {
    const current = view(),
      target = farmId(),
      epoch = s.sessionEpoch();
    clearTimeout(pendingTimer);
    const pending = (current?.predictions?.pending ?? 0) > 0;
    if (!pending || !target) {
      pendingRefreshes = 0;
      return;
    }
    if (pendingRefreshes >= PENDING_REFRESH_LIMIT || untrack(() => predictionsInFlight.has(target))) return;
    pendingTimer = setTimeout(() => {
      pendingRefreshes++;
      reloadQuiet(target, epoch);
    }, PENDING_REFRESH_MS);
  });
  onCleanup(() => clearTimeout(pendingTimer));
  /** The hero's prediction state: live views only (a real scene with an item id), never on the farm overview. */
  const heroPrediction = (): HeroPrediction | null => {
    const current = view();
    if (!current?.cycle || !predictionSourceScene(current.scenes)) return null;
    const local = predicting();
    const mine = local && local.farmId === farmId() && local.fieldId === (fieldKey() ?? null) ? local : null;
    return {
      pending: !!mine?.busy || (current.predictions?.pending ?? 0) > 0,
      blocked: predictionBlockedReason(current.predictions?.reason, date(), current.today),
      message: mine?.message ?? null,
      onPredict: (target, opts) => void predict(target, opts),
    };
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
      const field = fieldKey();
      if (state().status === "ready" && field !== undefined) void fetchView(target, field, epoch, true);
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

  // ---------------------------------------------------------------- field checks and issues (FIELD_OPERATIONS_SPEC.md 4, 5)
  /** The workspace fields as issue-form choices (name and polygon, for the location checks). */
  const fieldOptions = (): FieldOption[] => workspaceFields().map((f) => ({ id: f.id, name: f.name, boundary: f.boundary }));
  const formToday = () => view()?.today ?? browserToday();
  /** `?issue=<id>` opens the issue sheet (a deep link, a list row, a recheck step); closing it removes the parameter. */
  const issueParam = () => issueFromSearch(location.search);
  const setIssueParam = (issueId: string | null) => navigate(withIssueParam(location.pathname, location.search, issueId), { replace: true });
  const scoutingChanged = () => {
    setIssuesReload((n) => n + 1);
    const target = farmId();
    if (target) reloadQuiet(target, s.sessionEpoch());
  };
  /**
   * A field check's completion, optimistic like a care task: the step shows Done at once and rolls back when the server
   * refuses or cannot be reached (the sheet's draft stays on the device, so reopening Done restores it).
   */
  async function completeFieldCheck(step: UpcomingStep, body: CompleteCheck) {
    const target = farmId(),
      epoch = s.sessionEpoch();
    if (!target || busyStep()) return;
    setCheckStep(null);
    setBusyStep(step.id);
    setStepError("");
    const outcome = await runCheckCompletion(body, {
      mark: () => setCompleted((previous) => withId(previous, step.id)),
      unmark: () => {
        if (!stale(target, epoch)) setCompleted((previous) => withoutId(previous, step.id));
      },
      send: (payload) => completeCheck(target, payload),
      clearDraft: () => clearScoutingDraft(scoutingStore(), "check", target, checkSlot(body.checkId), body.clientEntryId),
    });
    if (stale(target, epoch)) return;
    setBusyStep("");
    if (outcome.ok) {
      s.setNotice(checkCompletionNotice(outcome.result));
      scoutingChanged();
    } else setStepError(`Could not record "${step.title}". ${outcome.error.message}${outcome.kept ? ` ${outcome.kept}.` : " Your answers are kept; tap Done to try again."}`);
  }
  const showIssues = () => {
    const node = document.getElementById(ISSUES_SECTION_ID);
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
    node?.focus({ preventScroll: true });
  };

  const showStep = (alert: FarmAlert) => {
    const step = steps().find((item) => item.alertId === alert.id);
    const node = step ? document.getElementById(stepDomId(step.id)) : null;
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
    node?.focus({ preventScroll: true });
  };
  const openDetails = (kind: CardKind) => setSheet(kind);
  const canPlant = () => !!props.data();

  // ---------------------------------------------------------------- full-map layout (TODAY_MAP_LAYOUT_SPEC.md)
  const farmName = () => s.farm()?.name ?? "Your farm";
  /** The headline names a selected field ("Strip 2 today."); a farm without fields and "All fields" read "Your farm today.". */
  const headlineField = () => (layout() === "field" ? fieldName() : null);
  /** Open alerts and due or overdue steps (an alert and its own suggested step count once); the headline counts the same list. */
  const attention = createMemo(() => {
    const current = view();
    return current ? attentionItems(alerts(), steps(), current.today) : { items: [], total: 0 };
  });
  const tabHref = (tab: "actions" | "modify") => farmHref(tab, undefined, fieldKey() ?? null);
  /** The drawn farm's area, for a whole-farm crop on a farm without fields (map area, not a survey). */
  const farmAreaHa = () => {
    const area = boundaryArea((view()?.farmBoundary ?? props.workspace()?.boundary ?? null) as Boundary | null);
    return area > 0 ? area : null;
  };
  /** What the gauges describe: the described field and crop ("North strip · Maize"), else the crop or the field. */
  const gaugeSubject = () => {
    const current = view();
    if (!current?.cycle) return fieldName();
    return viewField()?.name ? `${viewField()!.name} · ${cropName()}` : cropName();
  };
  const gaugeDate = () => (date() === view()?.today ? "Today" : formatDay(date(), false));
  const viewToday = () => view()?.today ?? browserToday();
  /** Where the five days come from: the forecast source, and the model label when a day shows a rain chance. */
  const weekBasis = () => {
    const days = new Set(weekAhead([], viewToday()).map((day) => day.date));
    const points = (view()?.weatherTrack ?? []).filter((point) => days.has(point.date));
    const sources = [...new Set(points.filter((p) => p.kind === "forecast" || p.kind === "observed").map((p) => p.basis.source))];
    const parts: string[] = [];
    if (sources.length) parts.push(`Weather: ${sources.join(", ")}`);
    if (points.some((p) => p.kind !== "unavailable" && p.agro?.rainProbabilityPct != null)) parts.push("rain chance is an Open-Meteo model estimate for the grid cell");
    if (points.some((p) => p.kind === "typical")) parts.push("typical days are seasonal averages, not a forecast");
    return parts.length ? `${parts.join("; ")}.` : null;
  };
  const weekTitle = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  /**
   * The Today frame over the map (TODAY_REFINEMENT_SPEC.md): the headline; the main column (at a glance, the hero, the
   * layered harvest outlook card, then any extra content); the right pane (attention, Today for you, the week, field
   * signals, Evara). Every slot reads the same view, slider day and callbacks as before.
   */
  const mapLayout = (parts: { hero: JSX.Element; extra?: JSX.Element; outlookSubject?: string | null; testid?: string; class?: string }) => (
    <TodayMapLayout
      testid={parts.testid}
      class={parts.class}
      headline={<TodayHeadline date={view()?.today} fieldName={headlineField()} count={attention().total} />}
      centre={<MapCentre farmName={farmName()} exploreHref={tabHref("modify")} />}
      glance={
        <GlancePanel
          facts={glanceFacts({ fields: summaries(), farmAreaHa: farmAreaHa(), hasCycle: !!view()?.cycle, model: slider() })}
          cropName={view()?.cycle ? cropName() : null}
          hasCycle={!!view()?.cycle}
          canPlant={canPlant()}
          onPlant={() => props.openPlant()}
          exploreHref={tabHref("modify")}
        />
      }
      hero={parts.hero}
      outlook={<TodayOutlook view={view()!} subject={parts.outlookSubject ?? null} onDetails={openDetails} {...soilProps()} />}
      extra={parts.extra}
      overview={<TodayOverview overview={view()?.overview} onDetails={openDetails} />}
      gauges={
        <GaugesPanel
          gauges={[
            greennessGauge(view()?.health, view()?.health ? healthHeadline(view()!.health!) : null, !!view()?.ndvi?.smallField),
            waterGauge(condition()),
            stageGauge(slider(), index(), stage(), view()?.timeline?.harvest ?? null),
          ]}
          subject={gaugeSubject()}
          dateLabel={gaugeDate()}
          onOpen={(kind) => setSheet(kind)}
        />
      }
      attention={<AttentionPanel items={attention().items} total={attention().total} actionsHref={tabHref("actions")} />}
      week={
        <WeekPanel
          days={weekAhead(view()?.weatherTrack ?? [], viewToday())}
          takeaway={weekTakeaway(alerts(), viewToday())}
          basis={(() => {
            const text = weekBasis();
            return text ? weekTitle(text) : null;
          })()}
          onDetails={() => setSheet("weather")}
        />
      }
      evara={<EvaraPanel question={view()?.cycle ? ASSISTANT_PROMPTS[0] : ASSISTANT_PROMPTS[1]} />}
    />
  );
  const aboutButton = () => (
    <button type="button" class="text-button today-about" onClick={() => setSheet("about")}>
      <Icon name="info" size={14} /> About this view
    </button>
  );

  // ---------------------------------------------------------------- Actions tab action cards (TODAY_MAP_LAYOUT_SPEC.md)
  /** "Farm-wide" on a farm with fields, "Whole farm" without; a named field otherwise. */
  const wideLabel = () => (hasFields() ? "Farm-wide" : "Whole farm");
  const alertEyebrow = (alert: FarmAlert) =>
    `${farmName()} · ${alert.fieldId && !isFarmWide(alert) ? (fieldNamed(alert.fieldId) ?? "A field") : wideLabel()}`;
  const stepEyebrow = (step: UpcomingStep) => {
    const fieldId = step.fieldCheck?.fieldId ?? null;
    return `${farmName()} · ${fieldId ? (fieldNamed(fieldId) ?? "A field") : step.fieldCheck?.scope === "farm" ? wideLabel() : (viewField()?.name ?? wideLabel())}`;
  };

  /**
   * Today keeps the Alerts and Upcoming steps lists below the frame; Actions shows the same alerts and steps as one board of
   * action cards (TODAY_REFINEMENT_SPEC.md 1). The issue log is a sibling outside the switch, so it keeps its load and
   * state when the presentation changes.
   */
  const lists = (current: TodayData) => (
    <div class="today-lists">
      <Show
        when={props.presentation === "actions"}
        fallback={
          <>
            <AlertsList
              alerts={alerts()}
              newsReview={current.newsReview}
              today={current.today}
              stepAlertIds={stepAlertIds()}
              onDismiss={(alert) => void dismiss(alert)}
              onSuggested={showStep}
              error={alertError()}
              fieldView={hasFields()}
            />
            <IssuesLine issues={current.issues} onShow={showIssues} />
            <Show when={current.cycle}>
              <UpcomingSteps
                steps={steps()}
                nextAction={current.nextAction ?? null}
                today={current.today}
                busyId={busyStep()}
                onDone={(step) => void markDone(step)}
                error={stepError()}
                sources={props.data()?.sources}
                onCheck={(step) => setCheckStep(step)}
                onOpenIssue={(issueId) => setIssueParam(issueId)}
              />
            </Show>
          </>
        }
      >
        <ActionsBoard
          labelledBy="today-actions-title"
          alerts={alerts()}
          newsReview={current.newsReview}
          today={current.today}
          stepAlertIds={stepAlertIds()}
          onDismiss={(alert) => void dismiss(alert)}
          onSuggested={showStep}
          alertError={alertError()}
          steps={current.cycle ? steps() : []}
          nextAction={current.nextAction ?? null}
          busyId={busyStep()}
          onDone={(step) => void markDone(step)}
          stepError={stepError()}
          sources={props.data()?.sources}
          onCheck={(step) => setCheckStep(step)}
          onOpenIssue={(issueId) => setIssueParam(issueId)}
          alertEyebrow={alertEyebrow}
          stepEyebrow={stepEyebrow}
        />
        <IssuesLine issues={current.issues} onShow={showIssues} />
      </Show>
      <IssuesSection
        farmId={current.farmId}
        fieldId={hasFields() ? (selectedId() ?? null) : null}
        fields={fieldOptions()}
        farmBoundary={farmBoundary() as Boundary | null}
        today={current.today}
        onOpenIssue={(issueId) => setIssueParam(issueId)}
        onChanged={scoutingChanged}
        reloadKey={issuesReload()}
      />
    </div>
  );

  return (
    <SoilCardContext.Provider value={soilCard}>
    <div class="today-view" data-presentation={props.presentation ?? "today"} aria-busy={state().status === "loading"} data-fields={hasFields() ? (overview() ? "all" : "field") : undefined}>
      {/* The field chips row lives in the shell under the tab bar since 12.6 (FIELDS_MULTICROP_SOIL_SPEC.md); not repeated here. */}
      <Switch>
        <Match when={state().status === "idle" || state().status === "loading"}>
          <Show when={props.presentation !== "actions"}>
            <TodayHeadline date={null} fieldName={headlineField()} count={null} />
          </Show>
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
          <Show when={props.presentation !== "actions"}>
            <TodayHeadline date={null} fieldName={headlineField()} count={null} />
          </Show>
          <div class="today-layout">
            <div class="today-primary">
              <Show
                when={props.cycles().length || !props.data()}
                fallback={<TodayEmpty onPlant={() => props.openPlant()} canPlant={canPlant()} fieldName={plantFieldName()} />}
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
        <Match when={view() && props.presentation === "actions"}>
          <div class="today-actions-layout" data-testid="today-actions">
            <header class="today-actions-heading">
              <span class="today-eyebrow">Field work</span>
              <h2 id="today-actions-title" tabIndex={-1}>
                Alerts &amp; tasks
              </h2>
              <p>What needs attention{fieldName() ? ` on ${fieldName()}` : " on this farm"}, and what comes next.</p>
            </header>
          </div>
        </Match>
        <Match when={view() && overview()}>
          {mapLayout({
            testid: "today-farm-overview",
            class: "is-farm",
            outlookSubject: view()!.field ? `${view()!.field!.name} · ${cropName()} (first field with a crop)` : view()!.cycle ? `Whole farm · ${cropName()}` : null,
            hero: (
              <FarmOverviewHero
                view={view()!}
                hero={farmHero()}
                mode={mode()}
                onMode={(next) => props.setScene(next === "field-image" ? "field-image" : next === "satellite" ? "satellite" : "growth")}
                date={date()}
                stage={stage()}
                progress={progress()}
                cropName={cropName()}
                condition={condition()}
                cropNames={cropNames()}
                onSelect={(id) => props.selectField(id)}
                onCurveDetails={() => setSheet("curve")}
                onAbout={() => setSheet("about")}
              />
            ),
            extra: (
              <>
                <FieldsTable fields={summaries()} selected={view()!.field?.id ?? null} onSelect={(id) => props.selectField(id)} />
                <Show when={!view()!.cycle}>
                  <TodayEmpty onPlant={() => props.openPlant()} canPlant={canPlant()} fieldName={plantFieldName()} />
                </Show>
              </>
            ),
          })}
        </Match>
        <Match when={view() && !view()!.cycle}>
          {mapLayout({
            class: "is-empty",
            hero: (
              <div class="today-primary">
                <TodayEmpty onPlant={() => props.openPlant()} canPlant={canPlant()} fieldName={hasFields() ? fieldName() : null} />
                {aboutButton()}
              </div>
            ),
          })}
        </Match>
        <Match when={view()?.cycle}>
          {mapLayout({
            outlookSubject: gaugeSubject(),
            hero: (
              <div class="today-primary">
                <TodayHero
                  mode={mode()}
                  onMode={(next) => props.setScene(next === "field-image" ? "field-image" : next === "satellite" ? "satellite" : "growth")}
                  date={date()}
                  today={view()!.today}
                  stage={stage()}
                  progress={progress()}
                  cropId={view()!.cycle!.cropId}
                  cropName={cropName()}
                  boundary={boundary()}
                  scenes={view()!.scenes}
                  imageBbox={view()!.ndvi?.imageBbox ?? null}
                  indexStage={view()!.indexStage ?? null}
                  onCurveDetails={() => setSheet("curve")}
                  condition={condition()}
                  hasConditions={!!view()!.conditions}
                  fieldImageBbox={view()!.fieldImageBbox ?? null}
                  fieldName={hasFields() ? fieldName() : null}
                  companionCropId={view()!.cycle!.companion?.cropId ?? null}
                  rowRatio={view()!.cycle!.companion?.rowRatio ?? null}
                  cropNames={cropNames()}
                  otherFields={hasFields() ? otherFields() : null}
                  prediction={heroPrediction()}
                  timeline={() => (
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
                          marks={marks()}
                          playing={playing()}
                          onPlay={togglePlay}
                          onInteract={() => player.stop()}
                        />
                      )}
                    </Show>
                  )}
                  fieldImage={() => <Show when={`${s.sessionEpoch()}|${view()!.farmId}|${view()!.cycle!.id}`} keyed>{(_key) => <FieldImage farmId={view()!.farmId} cycleId={view()!.cycle!.id} date={date()} today={view()!.today} fieldName={fieldName()}/>}</Show>}
                  notes={() => <Show when={`${s.sessionEpoch()}|${view()!.farmId}|${view()!.cycle!.id}`} keyed>{(_key) => <SeasonPredictionStatus farmId={view()!.farmId} cycleId={view()!.cycle!.id} onRefresh={() => reloadQuiet(view()!.farmId,s.sessionEpoch())}/>}</Show>}
                  onAbout={() => setSheet("about")}
                />
                <Show when={otherCycles().length}>
                  <p class="today-note">
                    Also growing: {otherCycles().map((entry) => entry.cycle.cropName ?? s.cropName(entry.cycle.cropId)).join(", ")}. This view
                    shows {cropName()}.
                  </p>
                </Show>
              </div>
            ),
          })}
        </Match>
      </Switch>
      {/* A single stable list owner keeps issue loading and list expansion intact across Today / Actions. */}
      <Show when={view()}>
        {(current) => (
          <div class="today-shared-lists" classList={{ "is-actions": props.presentation === "actions" }}>
            {lists(current())}
            <Show when={props.presentation === "actions"}>
              <ThisWeekPanel rows={weekPlan(steps(), current().today)} today={current().today} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={sheet() && view()}>
        <TodaySheet kind={sheet()!} view={view()!} date={date()} price={price()} weather={weather()} onClose={() => setSheet(null)} />
      </Show>
      <Show when={checkStep() && farmId() ? { step: checkStep()!, farmId: farmId()! } : null}>
        {(open) => (
          <CheckCompleteSheet
            farmId={open().farmId}
            step={open().step}
            today={formToday()}
            fields={fieldOptions()}
            farmBoundary={farmBoundary() as Boundary | null}
            onSubmit={(body) => void completeFieldCheck(open().step, body)}
            onIssueCreated={() => setIssuesReload((n) => n + 1)}
            onClose={() => setCheckStep(null)}
          />
        )}
      </Show>
      <Show when={issueParam() && farmId() ? `${farmId()}|${issueParam()}` : null} keyed>
        {(key) => (
          <IssueSheet
            farmId={key.split("|")[0]!}
            issueId={key.split("|")[1]!}
            today={formToday()}
            fieldName={(id) => fieldNamed(id)}
            onChanged={scoutingChanged}
            onClose={() => setIssueParam(null)}
          />
        )}
      </Show>
    </div>
    </SoilCardContext.Provider>
  );
}

/** Props of the "All fields" overview, shared by its hero half and its fields half. */
export interface FarmOverviewProps {
  view: TodayData;
  hero: FarmHero | null;
  mode: HeroMode;
  onMode: (mode: HeroMode) => void;
  date: string;
  stage: ReturnType<typeof stageAt>;
  progress: number;
  cropName: string;
  condition: ReturnType<typeof conditionAt>;
  cropNames: Record<string, string>;
  onSelect: (fieldId: string) => void;
  onCurveDetails?: () => void;
  empty: JSX.Element;
  side: JSX.Element;
  lists: JSX.Element;
  onAbout?: () => void;
}

/** The farm hero (every field in its crop colour, or the wide satellite image with outlines) and the legend. */
export function FarmOverviewHero(props: Omit<FarmOverviewProps, "empty" | "side" | "lists">) {
  const fields = () => props.view.fields ?? [];
  return (
    <div class="today-primary">
      <Show when={props.hero} fallback={<p class="today-note">The farm outline is not available, so the farm picture is hidden. Your fields are listed below.</p>}>
        {(hero) => (
          <TodayHero
            mode={props.mode}
            onMode={props.onMode}
            date={props.date}
            today={props.view.today}
            stage={props.stage}
            progress={props.progress}
            cropId={props.view.cycle?.cropId ?? ""}
            cropName={props.cropName}
            boundary={hero().boundary}
            scenes={props.view.scenes}
            imageBbox={props.view.ndvi?.imageBbox ?? null}
            indexStage={null}
            onCurveDetails={props.onCurveDetails}
            condition={props.condition}
            hasConditions={!!props.view.conditions}
            fieldImageBbox={props.view.fieldImageBbox ?? null}
            cropNames={props.cropNames}
            farm={hero()}
            onAbout={props.onAbout}
            fieldImage={() => <div class="field-images"><div class="field-images-empty"><span class="field-images-eyebrow">Field photos</span><h3>Choose a field</h3><p>Open a field with a crop to upload photos and preview its growth through the season.</p><For each={fields().filter(field => field.cycle)}>{field => <button type="button" class="btn secondary" onClick={() => props.onSelect(field.id)}>{field.name}</button>}</For></div></div>}
          />
        )}
      </Show>
      <FieldsLegend fields={fields()} />
    </div>
  );
}

/** The "Your fields" table where a row opens that field, then the described field's cards under a heading naming it. */
export function FarmOverviewFields(props: Pick<FarmOverviewProps, "view" | "cropName" | "onSelect" | "empty" | "side" | "lists">) {
  const fields = () => props.view.fields ?? [];
  const described = () => props.view.field ?? null;
  const heading = () =>
    described() ? `${described()!.name}: ${props.cropName}` : props.view.cycle ? `Whole farm: ${props.cropName}` : "No crop on any field yet";
  return (
    <>
      <div class="today-side">
        <FieldsTable fields={fields()} selected={described()?.id ?? null} onSelect={props.onSelect} />
      </div>
      <section class="today-first-field" aria-labelledby="today-first-field-title" data-testid="today-first-field">
        <h2 id="today-first-field-title">{heading()}</h2>
        <p class="today-note">
          {described()
            ? "The first field with a crop. Choose a field above for its own season slider, satellite close-up and steps."
            : props.view.cycle
              ? "This crop was recorded for the whole farm, before fields were drawn."
              : "Plant a crop on a field to start its stage dates, prices and care steps."}
        </p>
        <div class="today-first-field-body">
          <Show when={props.view.cycle} fallback={props.empty}>
            {props.side}
          </Show>
          {props.lists}
        </div>
      </section>
    </>
  );
}

/**
 * "All fields" (FIELDS_MULTICROP_SOIL_SPEC.md 6.3): the farm hero (every field in its crop colour, illustration or the wide
 * satellite image with outlines), the legend, the "Your fields" table where a row opens that field, then the cards, soil,
 * alerts and steps of the field the server described (the first field with a current crop), under a heading naming it.
 * Without a crop anywhere, the planting entry takes that place. Today's full-map layout places the two halves in its own
 * frame (the hero in the left column, the fields behind "More from Today"); this composition keeps the original order.
 */
export function FarmOverview(props: FarmOverviewProps) {
  return (
    <div class="today-layout is-farm" data-testid="today-farm-overview">
      <FarmOverviewHero {...props} />
      <FarmOverviewFields {...props} />
      <Show when={props.onAbout}>
        <button type="button" class="text-button today-about" onClick={() => props.onAbout?.()}>
          <Icon name="info" size={14} /> About this view
        </button>
      </Show>
    </div>
  );
}
