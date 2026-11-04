import { Match, Show, Switch, batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import type { CropFitCandidate, StageTimeline, YearPlanOccupant, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { newEntryId } from "../../features/photo-region/http";
import { Planner } from "../Planner";
import { today, useWorkspace } from "../state";
import type { FieldCycleLike } from "../fields/fieldsModel";
import { PlansByField, plansByField, type PlanFieldLike, type PlanSeasonLike } from "./PlansByField";
import { ApplyConfirm } from "./ApplyConfirm";
import { addYearsIso } from "./format";
import { HorizonPager } from "./HorizonPager";
import { OptionSheet, initialSlot, type TrendState } from "./OptionSheet";
import { PlanCalendar, PlanCalendarSkeleton, seasonsForField } from "./PlanCalendar";
import { ScenarioLine } from "./ScenarioLine";
import { SeasonStrip } from "./SeasonStrip";
import { loadStageTimeline } from "./seasonStripApi";
import { hasUsePlanParams, usePlanTarget, withoutUsePlanParams } from "./usePlanLink";
import { AlternativesSection } from "./AlternativesSection";
import {
  chosenOption,
  currentSpan,
  fieldStripMonths,
  fixedTarget,
  planSpans,
  savedSpans,
  seasonMonths,
  stripAnchor,
  type StripTarget,
} from "./seasonStripModel";
import { SwapNotice } from "./SwapNotice";
import {
  alternativeOccupants,
  alternativeOption,
  applyBody,
  cropChoices,
  draftProblems,
  horizonQuery,
  horizonStep,
  isActive,
  isApplied,
  mergeServerReview,
  planRebuilt,
  planningModel,
  replaceOption,
  replacedByOption,
  rescoreBody,
  scenarioText,
  selectionStatus,
  swapSavedSeason,
  type DraftSlot,
  type HorizonNavigation,
} from "./model";
import {
  apply,
  classifyYearPlanError,
  ensureYearPlan,
  loadYearPlan,
  pollYearPlan,
  priceTrend,
  rescore,
  withFieldId,
  type YearPlanFailure,
} from "./yearPlanApi";
import "./year-plan.css";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "needs_location" }
  | { kind: "ready" }
  | { kind: "by_field" }
  | { kind: "failed"; failure: YearPlanFailure };

/**
 * What the shell tells the Plan tab about fields (FIELDS_MULTICROP_SOIL_SPEC.md 12.6). Both omitted on a farm without
 * fields (and in older callers): the plan is farm-wide as before.
 */
export interface YearPlanViewProps {
  /** The field selected in the shell (`?field=`); null for "All fields" or a farm without fields. */
  fieldId?: string | null | undefined;
  /** The shell's workspace for the selected farm (the newer of the stored and command-center copies): fields, cycles, saved seasons. */
  workspace?:
    | {
        fields?: readonly PlanFieldLike[] | undefined;
        cycles: readonly FieldCycleLike[];
        rotationPlans: readonly PlanSeasonLike[];
      }
    | undefined;
  /** "Open plan" on a "Plans by field" row: select that field and stay on the Plan tab. */
  onOpenField?: (fieldId: string) => void;
}

/**
 * Year plan tab (UI_BRIEF 3.2, rounds 2 and 3): up to five scored 12-month crop sequences on a month calendar (three
 * picked by Meta, then "Best profit" and "Green manure first" built by code), a detail sheet per option, inline edit and
 * crop swaps with code re-scoring, and apply into the saved seasons, which stay listed below by the existing Planner.
 * A pager above the calendar steps through the horizons the server offers (`navigation`); every request, the
 * background re-read included, names the horizon on screen.
 *
 * Degrades without the backend: a 404 on GET and on the follow-up POST shows "not available on this server yet", a
 * network failure shows a retry card, a payload that fails the zod contract shows an error card; the saved seasons
 * below keep working in every case. All requests are tied to the selected farm and session and are dropped when the
 * farm changes or the view unmounts.
 */
export function YearPlanView(props: YearPlanViewProps = {}) {
  const s = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  /** The farm's fields as the shell knows them; an empty list is a farm without fields. */
  const farmFields = () => props.workspace?.fields ?? [];
  /** The field every request names: the selected field on a farm with fields, else null (farm-wide plan). */
  const planField = () => (farmFields().length && props.fieldId ? props.fieldId : null);
  /** "All fields" on a farm with fields: no farm-level plan, the per-field rows instead. */
  const byField = () => farmFields().length > 0 && !planField();
  const fieldRows = createMemo(() =>
    byField()
      ? plansByField(
          farmFields(),
          props.workspace?.cycles ?? [],
          props.workspace?.rotationPlans ?? [],
          today(),
          s.cropName,
        )
      : [],
  );
  const fieldName = () => farmFields().find((f) => f.id === planField())?.name ?? null;
  /** Calendar stage timelines for the season strips, by cycle id: absent until read, null when the read failed. */
  const [timelines, setTimelines] = createSignal<Record<string, StageTimeline | null>>({});
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" });
  const [review, setReview] = createSignal<YearPlanReview>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal("");
  const [open, setOpen] = createSignal<{
    optionId: string;
    slotId: string | null;
    /** A saved season of the scenario to show instead of a crop of the plan. */
    occupantId: string | null;
  } | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [rescoreBusy, setRescoreBusy] = createSignal(false);
  const [rescoreError, setRescoreError] = createSignal("");
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [applyBusy, setApplyBusy] = createSignal(false);
  const [applyError, setApplyError] = createSignal("");
  const [applyAdded, setApplyAdded] = createSignal<number | null>(null);
  /** Swapping a saved season's crop: saving the workspace, then the code rebuild of the plan. */
  const [swapBusy, setSwapBusy] = createSignal(false);
  const [swapError, setSwapError] = createSignal("");
  const [swapped, setSwapped] = createSignal<{ from: string; to: string } | null>(null);
  /** Horizon on screen: undefined is the current horizon, else one of the server's `navigation` dates. */
  const [viewFrom, setViewFrom] = createSignal<string | undefined>(undefined);
  /** True from a pager step until the server's first answer for that horizon. */
  const [navigating, setNavigating] = createSignal(false);
  /** The navigation the pager shows while the target horizon has not answered with its own. */
  const [pendingNav, setPendingNav] = createSignal<HorizonNavigation | null>(null);
  const [trends, setTrends] = createSignal<Record<string, TrendState>>({});
  const todayIso = today();
  /** Bumped on farm or session change; every async result checks it. */
  let generation = 0;
  let controller: AbortController | undefined;
  const applyKeys = new Map<string, string>();

  const farmId = () => s.farm()?.id;
  const live = (gen: number, id: string) => gen === generation && farmId() === id;

  function resetForFarm() {
    controller?.abort();
    controller = undefined;
    generation++;
    applyKeys.clear();
    batch(() => {
      setReview(undefined);
      setRefreshing(false);
      setRefreshError("");
      setOpen(null);
      setEditing(false);
      setRescoreBusy(false);
      setRescoreError("");
      setConfirming(null);
      setApplyBusy(false);
      setApplyError("");
      setApplyAdded(null);
      setSwapBusy(false);
      setSwapError("");
      setSwapped(null);
      setViewFrom(undefined);
      setNavigating(false);
      setPendingNav(null);
      setTrends({});
      setTimelines({});
    });
  }

  /**
   * Read the review; generate once when nothing exists yet (or when the GET route is missing, in case the server only
   * answers POST); poll while pending. `force` regenerates (Refresh, Retry).
   */
  async function load(id: string, force: boolean, from: string | undefined) {
    controller?.abort();
    const fieldId = planField();
    const ctrl = new AbortController();
    controller = ctrl;
    const gen = generation;
    const ok = () => !ctrl.signal.aborted && live(gen, id);
    const show = (next: YearPlanReview) => {
      if (!ok()) return;
      batch(() => {
        setReview(next);
        setPhase({ kind: "ready" });
        setNavigating(false);
        if (next.navigation) setPendingNav(null);
      });
    };
    const opts = { signal: ctrl.signal, onUpdate: show, from, fieldId };
    try {
      if (force) {
        show(await ensureYearPlan(id, { ...opts, force: true }));
        return;
      }
      let current: YearPlanReview | null = null;
      try {
        current = await loadYearPlan(id, opts);
      } catch (error) {
        if (classifyYearPlanError(error).kind !== "missing_endpoint") throw error;
      }
      if (!ok()) return;
      if (current && !isActiveOrEmpty(current)) {
        show(current);
        return;
      }
      if (current && isActive(current)) {
        show(current);
        show(await pollYearPlan(id, current, opts));
        return;
      }
      show(await ensureYearPlan(id, opts));
    } catch (error) {
      if (!ok()) return;
      const failure = classifyYearPlanError(error);
      const shown = review();
      // A failed step leaves the horizon that is still on screen as the one later requests name.
      if (shown?.navigation)
        batch(() => {
          setViewFrom(horizonQuery(shown.navigation!));
          setPendingNav(null);
        });
      if (shown && failure.kind !== "missing_endpoint") setRefreshError(failure.message);
      else setPhase({ kind: "failed", failure });
    } finally {
      if (controller === ctrl) {
        controller = undefined;
        if (live(gen, id))
          batch(() => {
            setRefreshing(false);
            setNavigating(false);
          });
      }
    }
  }
  const failure = () => {
    const p = phase();
    return p.kind === "failed" ? p.failure : undefined;
  };
  const isActiveOrEmpty = (r: YearPlanReview) => isActive(r) || (r.reviewId === null && r.options.length === 0);

  // Keyed by value so a refetch of the farm list (same farm, new object) does not restart the view.
  const farmKey = createMemo(() => {
    const f = s.farm();
    return f ? `${f.id}|${f.location.stateCode ?? ""}` : "";
  });
  /** Each field has its own review and horizon chain: switching fields (or to "All fields") starts over like a farm switch. */
  const fieldKey = createMemo(() => (byField() ? "*all" : (planField() ?? "")));
  createEffect(
    on([farmKey, fieldKey, s.sessionEpoch], ([key, field]) => {
      resetForFarm();
      const [id, state] = key.split("|");
      if (!id) return setPhase({ kind: "idle" });
      if (field === "*all") return setPhase({ kind: "by_field" });
      if (!state) return setPhase({ kind: "needs_location" });
      setPhase({ kind: "loading" });
      void load(id, false, undefined);
    }),
  );
  onCleanup(() => {
    generation++;
    controller?.abort();
  });

  // Saved seasons changed (added here or edited below): re-read the review quietly so "Out of date" can appear.
  // Observe the initial version: deferring would leave `previous` undefined on the first saved change.
  createEffect(
    on(
      () => s.workspace()?.version,
      (version, previous) => {
        const id = farmId();
        const current = review();
        if (version == null || previous == null || version === previous) return;
        if (!id || !current || controller || isActive(current)) return;
        const gen = generation;
        void loadYearPlan(id, { from: viewFrom(), fieldId: planField() })
          .then((next) => {
            if (live(gen, id) && !controller) setReview(mergeServerReview(review(), next));
          })
          .catch(() => {
            /* Background check only; the plan on screen stays usable. */
          });
      },
    ),
  );

  function refresh() {
    const id = farmId();
    if (!id || refreshing()) return;
    setRefreshing(true);
    setRefreshError("");
    void load(id, true, viewFrom());
  }
  function retry() {
    const id = farmId();
    if (!id) return;
    setPhase({ kind: "loading" });
    void load(id, true, viewFrom());
  }
  /**
   * After a swap the saved seasons have changed, so the context of the plan has changed with them: the server answers the
   * read for the new context with an empty shell and the ordinary (not forced) request builds the new plan. The refreshing
   * flag and the error line are the ones Refresh uses.
   */
  function rebuild() {
    const id = farmId();
    if (!id) return;
    batch(() => {
      setRefreshing(true);
      setRefreshError("");
    });
    void load(id, false, viewFrom());
  }

  /** Pager and "Open year N": show the horizon before or after this one, generating it when it has no plan yet. */
  function step(direction: "previous" | "next") {
    const id = farmId();
    const nav = navigation();
    const target = nav ? horizonStep(nav, direction) : null;
    if (!id || !target || navigating()) return;
    batch(() => {
      setOpen(null);
      setEditing(false);
      setRescoreError("");
      setConfirming(null);
      setApplyError("");
      setApplyAdded(null);
      setSwapError("");
      setSwapped(null);
      setRefreshError("");
      setRefreshing(false);
      setViewFrom(target.from);
      setPendingNav(target.navigation);
      setNavigating(true);
    });
    void load(id, false, target.from);
  }
  /** What the pager shows: the target while a step is on its way, else the review's own navigation (hidden when the server sends none). */
  const navigation = (): HorizonNavigation | undefined =>
    (navigating() ? pendingNav() : null) ?? review()?.navigation ?? pendingNav() ?? undefined;

  const options = () => review()?.options ?? [];
  /** The plans the server computed for a year its planned seasons (or the sown crop) fill; options ids start with "alt-". */
  const alternatives = () => review()?.alternatives ?? null;
  /** The crop growing now: the review's fixed slot, else a recorded crop among the saved seasons. */
  const growingCropName = () =>
    options().flatMap((o) => o.slots).find((x) => x.fixed)?.cropName ??
    review()?.scenario.occupied?.find((o) => o.source === "recorded_cycle")?.cropName ??
    null;
  const hasAlternatives = () => (alternatives()?.options.length ?? 0) > 0;
  /** An option id of the review itself, else one of its alternatives. */
  const findOption = (optionId: string | null | undefined) =>
    optionId
      ? (options().find((x) => x.optionId === optionId) ?? alternatives()?.options.find((x) => x.optionId === optionId))
      : undefined;
  const openOption = () => findOption(open()?.optionId);
  const confirmingOption = () => findOption(confirming());
  /** How the open or confirming option relates to the saved seasons: null for the review's own plans. */
  const alternativeFor = (optionId: string | null | undefined) => alternativeOption(review() ?? { alternatives: null }, optionId);
  const choices = createMemo(() => cropChoices(review(), s.crops()));
  // Evara's "use plan" link (?option=<id>[&alternative=1]): once the review has settled, open that option's sheet (alternative
  // mode for an alternatives option), then drop the two parameters from the URL (replace, not push) so a refresh does not
  // reopen it. An id the loaded review does not have opens nothing; the parameters are dropped the same way.
  createEffect(() => {
    const search = location.search;
    const r = review();
    if (phase().kind !== "ready" || !r || r.reviewId === null || isActive(r) || !hasUsePlanParams(search)) return;
    const target = usePlanTarget(search, r);
    untrack(() => {
      if (target)
        batch(() => {
          setEditing(false);
          setRescoreError("");
          setSwapError("");
          setOpen({ optionId: target.optionId, slotId: null, occupantId: null });
        });
      navigate(`${location.pathname}${withoutUsePlanParams(search)}`, { replace: true });
    });
  });
  /** The sheet's alternative mode: the saved seasons the option takes over (replace_planned), or a read-only comparison. */
  const sheetAlternative = (optionId: string) => {
    const alt = alternativeFor(optionId);
    if (!alt) return undefined;
    const occupied = review()?.scenario.occupied;
    return alt.alternatives.basis === "replace_planned"
      ? ({ kind: "replace", replaces: replacedByOption(alt.alternatives, alt.option, occupied), occupied: alternativeOccupants(alt.alternatives, alt.option, occupied) } as const)
      : ({ kind: "comparison", replaces: [], occupied: [] } as const);
  };
  /** The planned seasons applying this option removes; empty for the review's own options. */
  const confirmingReplaces = (optionId: string) => {
    const alt = alternativeFor(optionId);
    return alt ? replacedByOption(alt.alternatives, alt.option, review()?.scenario.occupied) : [];
  };

  // Season strip (SEASON_STRIP_COMPARE_SPEC.md): the stage names of the growing crop come from its calendar timeline (a code
  // route, no provider call). Read once per cycle; a failed read leaves the plan's own harvest window to label the months.
  function readTimeline(cycleId: string) {
    const id = farmId();
    if (!id || cycleId in timelines()) return;
    const gen = generation;
    void loadStageTimeline(id, cycleId).then((timeline) => {
      if (live(gen, id)) setTimelines((t) => ({ ...t, [cycleId]: timeline }));
    });
  }
  createEffect(() => {
    const r = review();
    const cycleId = phase().kind === "ready" ? r?.scenario.currentCycleId : null;
    if (cycleId) readTimeline(cycleId);
  });
  createEffect(() => {
    if (phase().kind !== "by_field") return;
    for (const row of fieldRows()) if (row.cycleId) readTimeline(row.cycleId);
  });
  const strip = createMemo(() => {
    const r = review();
    if (!r || phase().kind !== "ready") return [];
    const cycleId = r.scenario.currentCycleId;
    const { slot, target } = fixedTarget(r);
    const cycle = props.workspace?.cycles.find((c) => c.id === cycleId);
    const current = currentSpan({
      fixedSlot: slot,
      timeline: cycleId ? (timelines()[cycleId] ?? null) : null,
      cropName: cycle?.cropName ?? (cycle ? s.cropName(cycle.cropId) : ""),
      target,
    });
    const seasons = seasonsForField(props.workspace?.rotationPlans ?? [], planField());
    return seasonMonths(
      [...(current ? [current] : []), ...savedSpans(seasons, r.scenario.occupied, s.cropName), ...planSpans(r)],
      stripAnchor(todayIso, r.scenario),
      todayIso,
    );
  });
  /** "Plans by field": one compact strip per field once its growing crop's timeline has been read (a field without a crop needs none). */
  const fieldStrips = createMemo(() => {
    const out: Record<string, ReturnType<typeof seasonMonths>> = {};
    if (phase().kind !== "by_field") return out;
    for (const row of fieldRows()) {
      const timeline = row.cycleId ? timelines()[row.cycleId] : null;
      if (row.cycleId && !timeline) continue;
      out[row.id] = fieldStripMonths({
        cycleName: row.cycleName,
        timeline: timeline ?? null,
        seasons: seasonsForField(props.workspace?.rotationPlans ?? [], row.id),
        todayIso,
        cropName: s.cropName,
      });
    }
    return out;
  });
  /** The strip's "Open": the crop's sheet, a saved season's sheet (any option holds the same saved seasons), or the Saved seasons list. */
  function openFromStrip(target: StripTarget) {
    const r = review();
    const optionId = target.kind === "slot" ? target.optionId : (chosenOption(r)?.optionId ?? null);
    if (target.kind === "season" || !optionId) {
      document.getElementById("yp-saved-heading")?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    batch(() => {
      setEditing(false);
      setRescoreError("");
      setSwapError("");
      setOpen({
        optionId,
        slotId: target.kind === "slot" ? target.slotId : null,
        occupantId: target.kind === "occupant" ? target.occupantId : null,
      });
    });
  }

  // Price trends for the sheet, cached per product and place for this farm.
  const trendParams = (slot: YearPlanSlot) => ({
    productId: slot.productId,
    state: slot.price?.scope.stateName ?? review()?.scenario.stateId ?? s.farm()?.location.stateCode ?? null,
    district: slot.price?.scope.districtName ?? s.farm()?.location.districtName ?? null,
  });
  const trendKey = (slot: YearPlanSlot) => {
    const p = trendParams(slot);
    return `${p.productId}|${p.state ?? ""}|${p.district ?? ""}`;
  };
  const trendFor = (slot: YearPlanSlot) => trends()[trendKey(slot)];
  createEffect(() => {
    const o = openOption();
    const target = open();
    if (!o || !target || editing() || target.occupantId) return;
    const slot = initialSlot(o, target.slotId);
    if (slot.price?.status !== "available") return;
    const key = trendKey(slot);
    if (trends()[key]) return;
    const id = farmId();
    const gen = generation;
    setTrends((t) => ({ ...t, [key]: { status: "loading" } }));
    priceTrend({ ...trendParams(slot), months: 36 })
      .then((trend) => {
        if (id && live(gen, id)) setTrends((t) => ({ ...t, [key]: { status: "ready", trend } }));
      })
      .catch((error) => {
        if (!id || !live(gen, id)) return;
        const failure = classifyYearPlanError(error);
        setTrends((t) => ({
          ...t,
          [key]: {
            status: "error",
            message:
              failure.kind === "missing_endpoint" || failure.kind === "offline"
                ? "Price trend unavailable right now"
                : "Price trend could not be read",
          },
        }));
      });
  });

  async function submitRescore(drafts: DraftSlot[]) {
    const current = review();
    const option = openOption();
    const id = farmId();
    if (!current || !option || !id) return;
    if (!current.reviewId)
      return setRescoreError("This plan is not saved on the server yet. Refresh, then edit again.");
    const problems = draftProblems(drafts, current.scenario.horizon);
    if (problems.length) return setRescoreError(problems.join(" "));
    const gen = generation;
    batch(() => {
      setRescoreBusy(true);
      setRescoreError("");
    });
    try {
      const next = await rescore(id, withFieldId(rescoreBody(current.reviewId, option.optionId, drafts), planField()));
      if (!live(gen, id) || review()?.reviewId !== current.reviewId) return;
      const previousSlot = open()?.slotId ?? null;
      // Stay on the same crop: its slot id when it survived, else the slot in the same position (a swapped crop gets a new id).
      const sameId = next.slots.find((x) => x.slotId === previousSlot)?.slotId;
      const samePosition = next.slots[option.slots.findIndex((x) => x.slotId === previousSlot)]?.slotId;
      batch(() => {
        setReview(replaceOption(review()!, option.optionId, next));
        setOpen({
          optionId: next.optionId,
          slotId: sameId ?? samePosition ?? null,
          occupantId: null,
        });
        setEditing(false);
      });
    } catch (error) {
      if (!live(gen, id)) return;
      const failure = classifyYearPlanError(error);
      setRescoreError(
        failure.kind === "missing_endpoint"
          ? "Re-scoring is not available on this server yet. Your plan is unchanged."
          : failure.message,
      );
    } finally {
      if (live(gen, id)) setRescoreBusy(false);
    }
  }

  /**
   * Swap a saved season's crop: the matching saved season (by id) is replaced through the workspace save, which carries
   * the expected version, then both sheets close and the plan is rebuilt by code. A failure stays in the swap sheet.
   */
  async function swapOccupant(occupant: YearPlanOccupant, candidate: CropFitCandidate) {
    const id = farmId();
    const workspace = s.workspace();
    const current = review();
    if (!id || !current || swapBusy()) return;
    if (!workspace || workspace.farmId !== id || s.workspace.loading)
      return setSwapError("Your saved seasons are still loading. Try again in a moment.");
    if (current.stale) return setSwapError("The plan is out of date. Close this, refresh the plan, then try again.");
    const gen = generation;
    batch(() => {
      setSwapBusy(true);
      setSwapError("");
    });
    try {
      const result = await swapSavedSeason({
        occupant,
        candidate,
        rotationPlans: workspace.rotationPlans,
        // The checks the server's apply makes: the sowing date, the growing crop and the other saved seasons.
        todayIso: today(),
        fixedSlot: current.options.flatMap((o) => o.slots).find((x) => x.fixed) ?? null,
        occupied: current.scenario.occupied ?? [],
        save: (patch) => s.saveWorkspace(patch),
      });
      if (!live(gen, id)) return;
      if (result.kind === "unchanged") return; // the sheet closes the picker itself for this case
      if (result.kind !== "saved") return setSwapError(result.message);
      batch(() => {
        setSwapped({ from: result.from, to: result.to });
        setOpen(null);
        setEditing(false);
      });
      rebuild();
    } finally {
      if (live(gen, id)) setSwapBusy(false);
    }
  }

  async function confirmApply() {
    const current = review();
    const optionId = confirming();
    const id = farmId();
    const workspace = s.workspace();
    const option = confirmingOption();
    if (!current || !optionId || !id || !option || applyBusy()) return;
    if (isApplied(current, optionId)) return; // second apply is a no-op
    if (!current.reviewId) return setApplyError("This plan is not saved on the server yet. Refresh, then try again.");
    if (!workspace || workspace.farmId !== id || s.workspace.loading)
      return setApplyError("Your saved seasons are still loading. Try again in a moment.");
    const body = applyBody({ review: current, option, workspaceVersion: workspace.version });
    if (!body) return setApplyError("A comparison plan is not applied. It shows what could have fitted the field.");
    const key = applyKeys.get(optionId) ?? newEntryId("year-plan-apply");
    applyKeys.set(optionId, key);
    const gen = generation;
    batch(() => {
      setApplyBusy(true);
      setApplyError("");
    });
    try {
      const before = new Set(workspace.rotationPlans.map((r) => r.id));
      const result = await apply(id, withFieldId(body, planField()), { idempotencyKey: key });
      if (!live(gen, id)) return;
      setReview(mergeServerReview(review(), result.review));
      // A replacing apply removes seasons in the same write, so the length is no measure; count the seasons that are new.
      setApplyAdded(
        body.alternative
          ? result.workspace.rotationPlans.filter((r) => !before.has(r.id)).length
          : Math.max(0, result.workspace.rotationPlans.length - before.size),
      );
      await s.refreshWorkspace();
    } catch (error) {
      if (!live(gen, id)) return;
      const failure = classifyYearPlanError(error);
      if (failure.kind === "conflict") void s.refreshWorkspace();
      setApplyError(
        failure.kind === "missing_endpoint"
          ? "Saving a year plan is not available on this server yet. Nothing was added."
          : failure.message,
      );
    } finally {
      if (live(gen, id)) setApplyBusy(false);
    }
  }

  const failureCard = (failure: YearPlanFailure) =>
    failure.kind === "missing_endpoint"
      ? {
          title: "Year plans are not available here yet",
          body: "This server does not offer crop sequence plans yet. Your saved seasons below still work.",
        }
      : failure.kind === "offline"
        ? {
            title: "Could not reach the server",
            body: "Check the connection, then try again. Your saved seasons are kept.",
          }
        : { title: "The year plan could not be shown", body: failure.message };

  return (
    <div class="farm-tab-scroll yp-view">
      <section class="yp-panel" aria-labelledby="yp-heading" aria-busy={phase().kind === "loading"}>
        <h2 id="yp-heading" class="yp-title">
          Year plan
          <Show when={fieldName()}>{(name) => <span class="yp-title-field"> · {name()}</span>}</Show>
        </h2>
        <Switch>
          <Match when={phase().kind === "by_field"}>
            <PlansByField rows={fieldRows()} strips={fieldStrips()} onOpen={(id) => props.onOpenField?.(id)} />
          </Match>
          <Match when={phase().kind === "idle"}>
            <div class="yp-card">
              <h3>Add a farm first</h3>
              <p>Map your field, then the year plan suggests what to grow over the next 12 months.</p>
            </div>
          </Match>
          <Match when={phase().kind === "needs_location"}>
            <div class="yp-card">
              <h3>We need your farm's state and district</h3>
              <p>Sowing windows, yields and mandi prices all depend on where the field is.</p>
              <A class="btn compact" href="/farm/manage">
                Add the location
              </A>
            </div>
          </Match>
          <Match when={phase().kind === "loading"}>
            <p class="yp-scenario-line yp-muted" role="status">
              Loading your year plan…
            </p>
            <PlanCalendarSkeleton />
          </Match>
          <Match when={failure()}>
            {(f) => (
              <div class="yp-card" role="alert">
                <h3>{failureCard(f()).title}</h3>
                <p>{failureCard(f()).body}</p>
                <button type="button" class="btn compact secondary" onClick={() => retry()}>
                  Try again
                </button>
              </div>
            )}
          </Match>
          <Match when={phase().kind === "ready" && review()}>
            {(r) => (
              <>
                <Show when={!(isActive(r()) && r().options.length === 0)}>
                  <SeasonStrip months={strip()} onOpen={openFromStrip} />
                </Show>
                <Show when={navigation()}>
                  {(nav) => (
                    <HorizonPager
                      navigation={nav()}
                      to={
                        r().scenario.horizon.from === nav().from ? r().scenario.horizon.to : addYearsIso(nav().from, 1)
                      }
                      busy={navigating()}
                      onStep={step}
                    />
                  )}
                </Show>
                <ScenarioLine
                  text={scenarioText(r().scenario, r().options, todayIso, s.cropName)}
                  action={
                    r().scenario.kind === "future" && r().navigation?.previousFrom
                      ? {
                          label: `Open year ${r().navigation!.yearIndex}`,
                          onClick: () => step("previous"),
                          disabled: navigating(),
                        }
                      : undefined
                  }
                  pending={isActive(r())}
                  model={planningModel(r())}
                  stale={r().stale}
                  selection={selectionStatus(r())}
                  refreshing={refreshing()}
                  onRefresh={refresh}
                />
                <Show when={swapped()}>
                  {(done) => (
                    <SwapNotice
                      from={done().from}
                      to={done().to}
                      rebuilding={refreshing() || isActive(r())}
                      rebuilt={planRebuilt(r())}
                      failed={refreshError() !== ""}
                      onHide={() => setSwapped(null)}
                    />
                  )}
                </Show>
                <Show when={refreshError()}>
                  <p class="yp-inline-error" role="alert">
                    {refreshError()}{" "}
                    <button type="button" class="yp-link-button" onClick={refresh}>
                      Try again
                    </button>
                  </p>
                </Show>
                <Show when={hasAlternatives() && (r().options.length > 0 || (r().scenario.occupied ?? []).length > 0)}>
                  <h3 class="yp-subhead" id="yp-current-heading">
                    Your current plan
                  </h3>
                </Show>
                <Switch>
                  <Match when={r().options.length > 0}>
                    <PlanCalendar
                      horizonFrom={r().scenario.horizon.from}
                      todayIso={todayIso}
                      options={r().options}
                      appliedOptionIds={r().appliedOptionIds}
                      occupied={r().scenario.occupied ?? []}
                      onOpen={(optionId, slotId, occupantId) =>
                        batch(() => {
                          setEditing(false);
                          setRescoreError("");
                          setSwapError("");
                          setOpen({ optionId, slotId, occupantId: occupantId ?? null });
                        })
                      }
                    />
                  </Match>
                  <Match when={isActive(r())}>
                    <PlanCalendarSkeleton />
                  </Match>
                  <Match when={(r().scenario.occupied ?? []).length > 0}>
                    {/* No plan fits, but saved seasons take the year: show them, read-only, instead of an empty page. */}
                    <PlanCalendar
                      horizonFrom={r().scenario.horizon.from}
                      todayIso={todayIso}
                      options={[]}
                      appliedOptionIds={[]}
                      occupied={r().scenario.occupied ?? []}
                      onOpen={() => {}}
                    />
                    <Show when={!r().noFreeWindow && !hasAlternatives()}>
                      <div class="yp-card">
                        <h3>
                          {r().status === "error" ? "The plan could not be built right now" : "No crop sequence fits yet"}
                        </h3>
                        <p>
                          {r().status === "error"
                            ? "Something went wrong while building plans. Your saved seasons are unchanged."
                            : "No sourced sowing window fits this field in the next 12 months."}
                        </p>
                        <button type="button" class="btn compact secondary" disabled={refreshing()} onClick={refresh}>
                          Try again
                        </button>
                      </div>
                    </Show>
                  </Match>
                  <Match when={!hasAlternatives()}>
                    <div class="yp-card">
                      <h3>
                        {r().status === "error" ? "The plan could not be built right now" : "No crop sequence fits yet"}
                      </h3>
                      <p>
                        {r().status === "error"
                          ? "Something went wrong while building plans. Your saved seasons are unchanged."
                          : "No sourced sowing window fits this field in the next 12 months."}
                      </p>
                      <button type="button" class="btn compact secondary" disabled={refreshing()} onClick={refresh}>
                        Try again
                      </button>
                    </div>
                  </Match>
                </Switch>
                <Show when={alternatives()}>
                  {(alt) => (
                    <AlternativesSection
                      alternatives={alt()}
                      occupied={r().scenario.occupied ?? []}
                      appliedOptionIds={r().appliedOptionIds}
                      growingCropName={growingCropName()}
                      onOpen={(optionId) =>
                        batch(() => {
                          setEditing(false);
                          setRescoreError("");
                          setSwapError("");
                          setOpen({ optionId, slotId: null, occupantId: null });
                        })
                      }
                      onUse={(optionId) =>
                        batch(() => {
                          setOpen(null);
                          setEditing(false);
                          setApplyError("");
                          setApplyAdded(null);
                          setConfirming(optionId);
                        })
                      }
                    />
                  )}
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </section>
      <section class="yp-saved embedded-tool" aria-labelledby="yp-saved-heading">
        <h2 id="yp-saved-heading" class="yp-title">
          Saved seasons
        </h2>
        <Planner fieldId={planField()} fields={farmFields()} />
      </section>
      <Show when={openOption()} keyed>
        {(option) => (
          <OptionSheet
            farmId={farmId() ?? ""}
            fieldId={planField()}
            review={review()!}
            option={option}
            alternative={sheetAlternative(option.optionId)}
            slotId={open()?.slotId ?? null}
            occupantId={open()?.occupantId ?? null}
            applied={!!review() && isApplied(review()!, option.optionId)}
            editing={editing()}
            choices={choices()}
            rescoreBusy={rescoreBusy()}
            rescoreError={rescoreError()}
            trend={trendFor}
            onSelectSlot={(slotId) => setOpen((o) => (o ? { ...o, slotId, occupantId: null } : o))}
            onSelectOccupant={(occupantId) => setOpen((o) => (o ? { ...o, occupantId } : o))}
            onSwapOccupant={(occupant, candidate) => void swapOccupant(occupant, candidate)}
            onSwapReset={() => setSwapError("")}
            swapBusy={swapBusy()}
            swapError={swapError()}
            onEdit={() =>
              batch(() => {
                setRescoreError("");
                setEditing(true);
              })
            }
            onCancelEdit={() =>
              batch(() => {
                setRescoreError("");
                setEditing(false);
              })
            }
            onRescore={(drafts) => void submitRescore(drafts)}
            onUse={() =>
              batch(() => {
                setOpen(null);
                setEditing(false);
                setApplyError("");
                setApplyAdded(null);
                setConfirming(option.optionId);
              })
            }
            onClose={() =>
              batch(() => {
                setOpen(null);
                setEditing(false);
                setSwapError("");
              })
            }
          />
        )}
      </Show>
      <Show when={confirmingOption()} keyed>
        {(option) => (
          <ApplyConfirm
            option={option}
            replaces={confirmingReplaces(option.optionId)}
            alternative={alternativeFor(option.optionId)?.alternatives.basis === "replace_planned"}
            applied={!!review() && isApplied(review()!, option.optionId) && applyAdded() == null}
            busy={applyBusy()}
            error={applyError()}
            added={applyAdded()}
            onConfirm={() => void confirmApply()}
            onClose={() =>
              batch(() => {
                setConfirming(null);
                setApplyAdded(null);
                setApplyError("");
              })
            }
          />
        )}
      </Show>
    </div>
  );
}
