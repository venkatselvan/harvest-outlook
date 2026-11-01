import { Match, Show, Switch, batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { A } from "@solidjs/router";
import type { YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { newEntryId } from "../../features/photo-region/http";
import { Planner } from "../Planner";
import { today, useWorkspace } from "../state";
import { ApplyConfirm } from "./ApplyConfirm";
import { OptionSheet, initialSlot, type TrendState } from "./OptionSheet";
import { PlanCalendar, PlanCalendarSkeleton } from "./PlanCalendar";
import { ScenarioLine } from "./ScenarioLine";
import {
  cropChoices,
  draftProblems,
  isActive,
  isApplied,
  mergeServerReview,
  modelUnavailable,
  planningModel,
  replaceOption,
  rescoreBody,
  scenarioText,
  slotsToApply,
  type DraftSlot,
} from "./model";
import {
  apply,
  classifyYearPlanError,
  ensureYearPlan,
  loadYearPlan,
  pollYearPlan,
  priceTrend,
  rescore,
  type YearPlanFailure,
} from "./yearPlanApi";
import "./year-plan.css";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "needs_location" }
  | { kind: "ready" }
  | { kind: "failed"; failure: YearPlanFailure };

/**
 * Year plan tab (UI_BRIEF 3.2, round 2): up to four scored 12-month crop sequences on a month calendar (three picked by
 * Meta, a fourth "Green manure first" built by code), a detail sheet per option, inline edit with code re-scoring, and
 * apply into the saved seasons, which stay listed below by the existing Planner.
 *
 * Degrades without the backend: a 404 on GET and on the follow-up POST shows "not available on this server yet", a
 * network failure shows a retry card, a payload that fails the zod contract shows an error card; the saved seasons
 * below keep working in every case. All requests are tied to the selected farm and session and are dropped when the
 * farm changes or the view unmounts.
 */
export function YearPlanView() {
  const s = useWorkspace();
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" });
  const [review, setReview] = createSignal<YearPlanReview>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal("");
  const [open, setOpen] = createSignal<{ optionId: string; slotId: string | null } | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [rescoreBusy, setRescoreBusy] = createSignal(false);
  const [rescoreError, setRescoreError] = createSignal("");
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [applyBusy, setApplyBusy] = createSignal(false);
  const [applyError, setApplyError] = createSignal("");
  const [applyAdded, setApplyAdded] = createSignal<number | null>(null);
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
      setTrends({});
    });
  }

  /**
   * Read the review; generate once when nothing exists yet (or when the GET route is missing, in case the server only
   * answers POST); poll while pending. `force` regenerates (Refresh, Retry).
   */
  async function load(id: string, force: boolean) {
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    const gen = generation;
    const ok = () => !ctrl.signal.aborted && live(gen, id);
    const show = (next: YearPlanReview) => {
      if (!ok()) return;
      batch(() => {
        setReview(next);
        setPhase({ kind: "ready" });
      });
    };
    const opts = { signal: ctrl.signal, onUpdate: show };
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
      if (review() && failure.kind !== "missing_endpoint") setRefreshError(failure.message);
      else setPhase({ kind: "failed", failure });
    } finally {
      if (controller === ctrl) {
        controller = undefined;
        if (live(gen, id)) setRefreshing(false);
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
  createEffect(
    on([farmKey, s.sessionEpoch], ([key]) => {
      resetForFarm();
      const [id, state] = key.split("|");
      if (!id) return setPhase({ kind: "idle" });
      if (!state) return setPhase({ kind: "needs_location" });
      setPhase({ kind: "loading" });
      void load(id, false);
    }),
  );
  onCleanup(() => {
    generation++;
    controller?.abort();
  });

  // Saved seasons changed (added here or edited below): re-read the review quietly so "Out of date" can appear.
  createEffect(
    on(
      () => s.workspace()?.version,
      (version, previous) => {
        const id = farmId();
        const current = review();
        if (version == null || previous == null || version === previous) return;
        if (!id || !current || controller || isActive(current)) return;
        const gen = generation;
        void loadYearPlan(id)
          .then((next) => {
            if (live(gen, id) && !controller) setReview(mergeServerReview(review(), next));
          })
          .catch(() => {
            /* Background check only; the plan on screen stays usable. */
          });
      },
      { defer: true },
    ),
  );

  function refresh() {
    const id = farmId();
    if (!id || refreshing()) return;
    setRefreshing(true);
    setRefreshError("");
    void load(id, true);
  }
  function retry() {
    const id = farmId();
    if (!id) return;
    setPhase({ kind: "loading" });
    void load(id, true);
  }

  const options = () => review()?.options ?? [];
  const openOption = () => {
    const o = open();
    return o ? options().find((x) => x.optionId === o.optionId) : undefined;
  };
  const confirmingOption = () => {
    const id = confirming();
    return id ? options().find((x) => x.optionId === id) : undefined;
  };
  const choices = createMemo(() => cropChoices(review(), s.crops()));

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
    if (!o || !target || editing()) return;
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
    if (!current.reviewId) return setRescoreError("This plan is not saved on the server yet. Refresh, then edit again.");
    const problems = draftProblems(drafts, current.scenario.horizon);
    if (problems.length) return setRescoreError(problems.join(" "));
    const gen = generation;
    batch(() => {
      setRescoreBusy(true);
      setRescoreError("");
    });
    try {
      const next = await rescore(id, rescoreBody(current.reviewId, option.optionId, drafts));
      if (!live(gen, id) || review()?.reviewId !== current.reviewId) return;
      const previousSlot = open()?.slotId ?? null;
      batch(() => {
        setReview(replaceOption(review()!, option.optionId, next));
        setOpen({ optionId: next.optionId, slotId: next.slots.some((x) => x.slotId === previousSlot) ? previousSlot : null });
        setEditing(false);
      });
    } catch (error) {
      if (!live(gen, id)) return;
      const failure = classifyYearPlanError(error);
      setRescoreError(
        failure.kind === "missing_endpoint" ? "Re-scoring is not available on this server yet. Your plan is unchanged." : failure.message,
      );
    } finally {
      if (live(gen, id)) setRescoreBusy(false);
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
    const key = applyKeys.get(optionId) ?? newEntryId("year-plan-apply");
    applyKeys.set(optionId, key);
    const gen = generation;
    batch(() => {
      setApplyBusy(true);
      setApplyError("");
    });
    try {
      const before = workspace.rotationPlans.length;
      const result = await apply(
        id,
        {
          reviewId: current.reviewId,
          optionId,
          slotIds: slotsToApply(option).map((x) => x.slotId),
          expectedWorkspaceVersion: workspace.version,
        },
        { idempotencyKey: key },
      );
      if (!live(gen, id)) return;
      setReview(mergeServerReview(review(), result.review));
      setApplyAdded(Math.max(0, result.workspace.rotationPlans.length - before));
      await s.refreshWorkspace();
    } catch (error) {
      if (!live(gen, id)) return;
      const failure = classifyYearPlanError(error);
      if (failure.kind === "conflict") void s.refreshWorkspace();
      setApplyError(
        failure.kind === "missing_endpoint" ? "Saving a year plan is not available on this server yet. Nothing was added." : failure.message,
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
        ? { title: "Could not reach the server", body: "Check the connection, then try again. Your saved seasons are kept." }
        : { title: "The year plan could not be shown", body: failure.message };

  return (
    <div class="farm-tab-scroll yp-view">
      <section class="yp-panel" aria-labelledby="yp-heading" aria-busy={phase().kind === "loading"}>
        <h2 id="yp-heading" class="yp-title">
          Year plan
        </h2>
        <Switch>
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
                <ScenarioLine
                  text={scenarioText(r().scenario, r().options, todayIso, s.cropName)}
                  pending={isActive(r())}
                  model={planningModel(r())}
                  stale={r().stale}
                  modelUnavailable={modelUnavailable(r())}
                  refreshing={refreshing()}
                  onRefresh={refresh}
                />
                <Show when={refreshError()}>
                  <p class="yp-inline-error" role="alert">
                    {refreshError()}{" "}
                    <button type="button" class="yp-link-button" onClick={refresh}>
                      Try again
                    </button>
                  </p>
                </Show>
                <Switch>
                  <Match when={r().options.length > 0}>
                    <PlanCalendar
                      horizonFrom={r().scenario.horizon.from}
                      todayIso={todayIso}
                      options={r().options}
                      appliedOptionIds={r().appliedOptionIds}
                      onOpen={(optionId, slotId) =>
                        batch(() => {
                          setEditing(false);
                          setRescoreError("");
                          setOpen({ optionId, slotId });
                        })
                      }
                    />
                  </Match>
                  <Match when={isActive(r())}>
                    <PlanCalendarSkeleton />
                  </Match>
                  <Match when={true}>
                    <div class="yp-card">
                      <h3>{r().status === "error" ? "The plan could not be built right now" : "No crop sequence fits yet"}</h3>
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
              </>
            )}
          </Match>
        </Switch>
      </section>
      <section class="yp-saved embedded-tool" aria-labelledby="yp-saved-heading">
        <h2 id="yp-saved-heading" class="yp-title">
          Saved seasons
        </h2>
        <Planner />
      </section>
      <Show when={openOption()} keyed>
        {(option) => (
          <OptionSheet
            review={review()!}
            option={option}
            slotId={open()?.slotId ?? null}
            applied={!!review() && isApplied(review()!, option.optionId)}
            editing={editing()}
            choices={choices()}
            rescoreBusy={rescoreBusy()}
            rescoreError={rescoreError()}
            trend={trendFor}
            onSelectSlot={(slotId) => setOpen((o) => (o ? { ...o, slotId } : o))}
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
              })
            }
          />
        )}
      </Show>
      <Show when={confirmingOption()} keyed>
        {(option) => (
          <ApplyConfirm
            option={option}
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
