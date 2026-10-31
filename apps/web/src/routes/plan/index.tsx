import { SoilContextSummary } from "../../workspace/SoilContextSummary";
import { useWorkspace } from "../../workspace/state";
import "../../features/season-explorer/season-explorer.css";
import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { A, useParams, useSearchParams } from "@solidjs/router";
import { refreshCapabilities } from "../../lib/capabilities";
import {
  SeasonController,
  type SeasonState,
} from "../../features/season-explorer/controller";
import { DateSlider } from "../../features/season-explorer/DateSlider";
import {
  OutlookPanel,
  SourcesPanel,
  StagePanel,
  TasksPanel,
  WeatherPanel,
  WhyPanel,
  Badge,
} from "../../features/season-explorer/panels";
import { ScenePanel } from "../../features/season-explorer/ScenePanel";
import {
  formatDate,
  recordAt,
  sceneChoice,
} from "../../features/season-explorer/model";
import type { Scenario } from "../../lib/plan-api";

/** Season plan screen (`/farm/plan/:planId`): one slider drives the scene and every panel from the timeline fetched once. */
export function PlanPage() {
  const workspace = useWorkspace();
  const params = useParams<{ planId: string }>();
  const [query] = useSearchParams<{ scenario?: string }>();
  const ctl = new SeasonController(params.planId ?? "", {
    scenario: query.scenario === "late" ? "late" : "early",
  });
  const [s, setS] = createSignal<SeasonState>(ctl.snapshot);
  const unsub = ctl.subscribe(setS);
  onCleanup(() => {
    unsub();
    ctl.dispose();
  });
  onMount(() => {
    document.title = "Season plan · Harvest Outlook";
    void refreshCapabilities();
    void ctl.load();
  });

  const planFarm = () =>
    workspace.farms()?.find((f) => f.id === s().plan?.snapshot.farmId);
  const isDemoPlan = () =>
    planFarm()?.facts.demo_prefilled?.value === true ||
    planFarm()?.facts.demo_illustrative?.value === true;
  const plantingBasis = () =>
    s().plan?.snapshot.confirmedInputs.find(
      (input) => input.key === "planting_date",
    )?.value.evidenceState;
  const index = createMemo(() => s().timelines[s().scenario] ?? null);
  const day = createMemo(() => {
    const ix = index();
    const d = s().selectedDate;
    return ix && d ? recordAt(ix, d) : null;
  });
  const dap = createMemo(() => day()?.daysAfterPlanting ?? 0);
  const choice = createMemo(() => {
    const ix = index();
    const d = day();
    return ix && d ? sceneChoice(ix, d) : null;
  });
  const assumedPrice = () => {
    const c = s().plan?.snapshot.confirmedInputs.find(
      (i) => i.key === "assumed_price",
    );
    return c ? `Rs ${String(c.value.value)} per kg (you entered this)` : null;
  };
  const version = () => {
    const n = s().history.status === "ready" ? s().history.items.length : null;
    return n
      ? `version ${n}`
      : s().plan?.lineage.parentId
        ? "revised version"
        : "first version";
  };

  return (
    <section aria-labelledby="page-title" class="se-page">
      <h1 id="page-title" tabindex="-1">
        Season plan
      </h1>
      <Switch>
        <Match when={s().status === "error"}>
          <div class="card" data-testid="plan-error">
            <p role="alert" class="pr-error">
              {s().error?.code === "not_found"
                ? "This plan was not found. It may belong to another device or have been deleted."
                : `Could not load the plan: ${s().error?.message}`}
            </p>
            <button type="button" class="btn" onClick={() => void ctl.load()}>
              Try again
            </button>
            <p>
              <A href="/farm">Back to my farm</A>
            </p>
          </div>
        </Match>
        <Match when={s().status !== "ready" || !index() || !day()}>
          <p role="status">Loading your season plan…</p>
        </Match>
        <Match when={true}>
          <div class="card se-summary" data-testid="plan-summary">
            <dl class="facts">
              <dt>Crop</dt>
              <dd>
                {s().plan!.snapshot.cropId} ({s().plan!.snapshot.productId})
              </dd>
              <dt>Planting</dt>
              <dd>
                {formatDate(s().plantingDate!)}{" "}
                <Show
                  when={planFarm()}
                  fallback={
                    <Badge state="unavailable">
                      {workspace.farms.loading
                        ? "Checking input provenance…"
                        : "Input provenance unavailable"}
                    </Badge>
                  }
                >
                  <Badge state={plantingBasis() ?? "unavailable"}>
                    {plantingBasis() === "farmer_reported"
                      ? "Farmer reported"
                      : plantingBasis() === "observed"
                        ? "Recorded observation"
                        : "Input source unconfirmed"}
                  </Badge>
                </Show>
              </dd>
              <dt>Plan</dt>
              <dd>
                {version()}, saved{" "}
                {formatDate(s().plan!.snapshot.createdAt.slice(0, 10))}; mode{" "}
                {s().mode}
              </dd>
              <dt>Data as of</dt>
              <dd>{formatDate(index()!.asOfDate)}</dd>
            </dl>
            <Show when={isDemoPlan()}>
              <p class="se-help demo-plan-note" role="note">
                {planFarm()?.name} has a prefilled demo boundary. Plan dates and
                crop inputs are recorded separately; confirm them against your
                field records.
              </p>
            </Show>
            <div class="field">
              <label for="se-scenario">Sourced stage timing range</label>
              <select
                id="se-scenario"
                value={s().scenario}
                disabled={s().scenarioLoading}
                onChange={(e) =>
                  void ctl.setScenario(e.currentTarget.value as Scenario)
                }
              >
                <option value="early">
                  Early (shortest sourced durations)
                </option>
                <option value="late">Late (longest sourced durations)</option>
              </select>
            </div>
            <Show when={s().warnings.length > 0}>
              <ul class="se-list se-warnings" data-testid="plan-warnings">
                {s().warnings.map((w) => (
                  <li>{w}</li>
                ))}
              </ul>
            </Show>
          </div>

          <DateSlider
            index={index()!}
            selectedDate={s().selectedDate!}
            today={s().today}
            daysAfterPlanting={dap()}
            onSelect={(d) => ctl.select(d)}
            onStep={(n) => ctl.step(n)}
            onPos={(p) => ctl.selectPos(p)}
          />

          <ScenePanel state={s()} choice={choice()!} />
          <StagePanel
            day={day()!}
            stageNames={s().stageNames}
            basisNote={null}
          />
          <TasksPanel
            day={day()!}
            tasksById={s().tasksById}
            citations={s().citations}
            skipped={s().outputs.tasks?.skipped ?? []}
            canComplete={false}
          />
          <WeatherPanel day={day()!} />
          <SoilContextSummary farmId={s().plan!.snapshot.farmId} />
          <OutlookPanel
            day={day()!}
            outputs={s().outputs}
            assumedPrice={assumedPrice()}
          />

          <WhyPanel
            history={s().history}
            stageNames={s().stageNames}
            onOpen={() => void ctl.loadHistory()}
          />
          <SourcesPanel
            day={day()!}
            citations={s().citations}
            onOpen={() => void ctl.loadCitations()}
            assumptions={(s().plan?.snapshot.assumptions ?? []).map((a) => ({
              id: a.id,
              description: a.description,
            }))}
          />
          <p class="se-help">
            Stage windows are estimates from the recorded planting date and
            sourced crop durations. Confirm actual growth with dated field
            observations.
          </p>
        </Match>
      </Switch>
    </section>
  );
}
