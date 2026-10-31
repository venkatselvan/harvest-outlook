import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  type JSX,
} from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import {
  FarmCommandCenter as commandSchema,
  PlantCropResult,
  type FarmCommandCenter as CommandData,
  type FocusedCrop,
  type CareTask,
  type PlantCrop,
} from "@harvest/contracts";
import {
  apiRequest,
  jsonInit,
  newEntryId,
} from "../features/photo-region/http";
import { useWorkspace, today, dateLabel } from "./state";
import { ApiError } from "../lib/api";
import { FarmWorkspace, HistoryDialog } from "./FarmPage";
import { CompareWorkspace } from "./Compare";
import { Outlook } from "./Outlook";
import { JournalWorkspace } from "./Journal";
import { FarmSettings } from "./FarmSettings";
import { PlanningReviewPanel } from "./PlanningReview";
import { MarketContextPanel } from "./MarketContextPanel";
import { Icon } from "./icons";
import { Evara } from "./Evara";
import { TodayView } from "./today/TodayView";
import type { Tool } from "./today/types";
import { YearPlanView } from "./year/YearPlanView";
import "./farm-command.css";

type Tab = "today" | "soil" | "year" | "harvest" | "activity";
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "grid" },
  { id: "soil", label: "Soil & crop fit", icon: "leaf" },
  { id: "year", label: "Year plan", icon: "calendar" },
  { id: "harvest", label: "Harvest outlook", icon: "trend" },
  { id: "activity", label: "Activity", icon: "journal" },
];
const words = (value: string) =>
  value.replace(/_/g, " ").replace(/^\w/, (s) => s.toUpperCase());
const fitLabel = (status: string) =>
  ({
    needs_soil_report: "Soil report needed",
    insufficient_compatible_measurements: "Compatible readings needed",
    within_published_ph_range: "pH within source range",
    outside_published_ph_range: "pH outside source range",
  })[status] ?? "Check source requirements";
const selectedTab = (path: string, query?: string): Tab => {
  if (tabs.some((tab) => tab.id === query)) return query as Tab;
  if (path === "/planner") return "year";
  if (path === "/explore" || path === "/farm/settings") return "soil";
  if (path === "/outlook") return "harvest";
  if (path === "/journal") return "activity";
  return "today";
};

/** Keep the setup mounted through the history step when the very first farm is created. */
export function FarmHome() {
  const s = useWorkspace();
  const [setup, setSetup] = createSignal<boolean>();
  createEffect(on(s.sessionEpoch, () => setSetup(undefined)));
  createEffect(() => {
    if (!s.farms.loading && !s.farms.error && setup() === undefined)
      setSetup(!s.farm());
  });
  return (
    <Show
      when={!s.farms.loading || setup() !== undefined}
      fallback={
        <div class="command-loading" role="status">
          <Evara size={42} /> Loading your farm…
        </div>
      }
    >
      <Show
        when={setup() === false && s.farm()}
        fallback={<FarmWorkspace onReady={() => setSetup(false)} />}
      >
        <FarmCommandCenter />
      </Show>
    </Show>
  );
}
export function FarmSetup() {
  const navigate = useNavigate();
  return (
    <div class="farm-setup-page">
      <A href="/farm" class="text-link">
        <Icon name="arrow" size={15} /> Back to farm
      </A>
      <FarmWorkspace startAdding onReady={() => navigate("/farm")} />
    </div>
  );
}

function SourceLinks(props: {
  refs: { sourceId: string; locator: string }[];
  data?: CommandData | undefined;
}) {
  return (
    <For each={props.refs}>
      {(ref) => {
        const source = () =>
          props.data?.sources.find((source) => source.id === ref.sourceId);
        return (
          <Show when={source()} fallback={<span>{ref.locator}</span>}>
            {(item) => (
              <a href={item().url} target="_blank" rel="noreferrer">
                {item().publisher} · {ref.locator} ↗
              </a>
            )}
          </Show>
        );
      }}
    </For>
  );
}

export function FarmCommandCenter() {
  const s = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const query = () => new URLSearchParams(location.search);
  const tab = () =>
    selectedTab(location.pathname, query().get("tab") ?? undefined);
  const tool = (): Tool =>
    query().get("tool") === "compare" || location.pathname === "/explore"
      ? "compare"
      : query().get("tool") === "soil"
        ? "soil"
        : null;
  const [scene, setScene] = createSignal<"growth" | "satellite">("growth");
  const [cycleId, setCycleId] = createSignal("");
  const [planting, setPlanting] = createSignal(false);
  const [plantCrop, setPlantCrop] = createSignal("");
  const [method, setMethod] = createSignal("");
  const [product, setProduct] = createSignal("");
  const [plantDate, setPlantDate] = createSignal(today());
  const [plantNote, setPlantNote] = createSignal("");
  const [plantBusy, setPlantBusy] = createSignal(false);
  const [plantPayload, setPlantPayload] = createSignal<PlantCrop | null>(null);
  const [error, setError] = createSignal("");
  const [careBusy, setCareBusy] = createSignal("");
  const [allCare, setAllCare] = createSignal(false);
  const [history, setHistory] = createSignal(false);
  let plantEntry = "",
    editorFarm = "",
    editorEpoch = 0,
    plantRequest = 0;
  const careEntries = new Map<string, string>();
  const key = () =>
    s.farm()?.id &&
    !s.workspace.loading &&
    s.workspace()?.farmId === s.farm()?.id
      ? `${s.sessionEpoch()}|${s.farm()!.id}|${s.workspace()?.farmId === s.farm()?.id ? s.workspace()?.version : "loading"}`
      : false;
  const [resource, { refetch }] = createResource(key, async (key) => {
    const target = key.split("|")[1]!;
    const data = commandSchema.parse(
      (await apiRequest(`/api/v1/farms/${target}/command-center`)).data,
    );
    return key ===
      `${s.sessionEpoch()}|${s.farm()?.id}|${s.workspace()?.farmId === s.farm()?.id ? s.workspace()?.version : "loading"}`
      ? data
      : undefined;
  });
  const data = () =>
    !resource.error && resource()?.farmId === s.farm()?.id
      ? resource()
      : undefined;
  const workspace = () => {
    const stored =
      s.workspace()?.farmId === s.farm()?.id ? s.workspace() : undefined;
    const unified = data()?.workspace;
    return stored && (!unified || stored.version > unified.version)
      ? stored
      : unified;
  };
  const cycles = () =>
    data()?.currentCycles.filter(
      (entry) => entry.cycle.stage !== "harvested",
    ) ??
    workspace()
      ?.cycles.filter((cycle) => cycle.stage !== "harvested")
      .map((cycle) => ({
        cycle,
        careTasks: [] as CareTask[],
        referenceGuidance: [],
        stageGuidance: [],
        limitations: [
          "Care evidence is still loading or unavailable. Your recorded crop is preserved.",
        ],
      })) ??
    [];
  const active = () =>
    cycles().find((entry) => entry.cycle.id === cycleId()) ?? cycles()[0];
  const tasks = () =>
    [...(active()?.careTasks ?? [])]
      .filter((task) => task.status !== "completed")
      .sort((a, b) => a.dueFrom.localeCompare(b.dueFrom));
  const dueCount = () =>
    tasks().filter((task) => task.status === "due" || task.status === "overdue")
      .length;
  const chosenCrop = () =>
    data()?.focusedCrops.find((crop) => crop.cropId === plantCrop());
  const showTool = (tool: Tool) =>
    navigate(`/farm?tab=${tab()}${tool ? `&tool=${tool}` : ""}`);
  createEffect(
    on([() => s.farm()?.id, s.sessionEpoch], () => {
      ++plantRequest;
      setPlanting(false);
      setPlantBusy(false);
      setCareBusy("");
      setError("");
      setCycleId("");
      setAllCare(false);
      setHistory(false);
      careEntries.clear();
    }),
  );
  createEffect(() => {
    if (query().get("history") === "1" && s.farm()) setHistory(true);
  });
  function openPlant(cropId?: string) {
    ++plantRequest;
    setPlantBusy(false);
    editorFarm = s.farm()?.id ?? "";
    editorEpoch = s.sessionEpoch();
    plantEntry = newEntryId("planting");
    setPlantPayload(null);
    setPlantDate(today());
    setPlantNote("");
    setError("");
    setPlanting(true);
    chooseCrop(cropId ?? "");
  }
  function chooseCrop(id: string) {
    setPlantCrop(id);
    const crop = data()?.focusedCrops.find((crop) => crop.cropId === id);
    setMethod(
      crop?.establishmentMethods.length === 1
        ? crop.establishmentMethods[0]!
        : "",
    );
    setProduct(crop?.products.length === 1 ? crop.products[0]!.productId : "");
  }
  async function recordPlanting(event: SubmitEvent) {
    event.preventDefault();
    if (
      plantBusy() ||
      editorFarm !== s.farm()?.id ||
      editorEpoch !== s.sessionEpoch()
    )
      return;
    const snapshot = workspace(),
      selected = chosenCrop();
    if (s.workspace.loading || resource.loading) {
      setError("Farm context is refreshing. Try again when it finishes.");
      return;
    }
    if (!snapshot || !selected || !method() || !plantDate()) {
      setError("Choose a crop, establishment method and date.");
      return;
    }
    if (plantDate() > today()) {
      setError(
        "Record a date today or earlier. Future crops belong in your year plan.",
      );
      return;
    }
    if (selected.products.length > 1 && !product()) {
      setError("Choose the product you are growing.");
      return;
    }
    const target = editorFarm,
      epoch = editorEpoch,
      request = ++plantRequest;
    setPlantBusy(true);
    setError("");
    try {
      const payload = plantPayload() ?? {
        clientEntryId: plantEntry,
        cropId: selected.cropId,
        ...(product() ? { productId: product() } : {}),
        establishmentMethod: method(),
        establishmentDate: plantDate(),
        expectedWorkspaceVersion: snapshot.version,
        ...(plantNote().trim() ? { notes: plantNote().trim() } : {}),
      };
      setPlantPayload(payload);
      const result = PlantCropResult.parse(
        (
          await apiRequest(
            `/api/v1/farms/${target}/cycles`,
            jsonInit("POST", payload, { "idempotency-key": plantEntry }),
          )
        ).data,
      );
      if (
        target !== s.farm()?.id ||
        epoch !== s.sessionEpoch() ||
        request !== plantRequest
      )
        return;
      setPlanting(false);
      setCycleId(result.cycle.id);
      await Promise.resolve(s.refreshWorkspace()).catch(() => undefined);
      await Promise.resolve(refetch()).catch(() => undefined);
      s.setNotice(
        `${selected.displayName} recorded. Source-based care is ready where evidence is available.`,
      );
    } catch (issue) {
      if (
        target === s.farm()?.id &&
        epoch === s.sessionEpoch() &&
        request === plantRequest
      ) {
        setError((issue as Error).message);
        if (issue instanceof ApiError && issue.status === 409) {
          setPlantPayload(null);
          void s.refreshWorkspace();
        }
      }
    } finally {
      if (request === plantRequest) setPlantBusy(false);
    }
  }
  async function complete(task: CareTask) {
    const target = s.farm()?.id,
      epoch = s.sessionEpoch();
    if (!target || careBusy()) return;
    const key = `${target}|${task.cycleId}|${task.id}`;
    const clientEntryId = careEntries.get(key) ?? newEntryId("care");
    careEntries.set(key, clientEntryId);
    setCareBusy(task.id);
    setError("");
    try {
      await apiRequest(
        `/api/v1/farms/${target}/cycles/${encodeURIComponent(task.cycleId)}/care/${encodeURIComponent(task.id)}/complete`,
        jsonInit(
          "POST",
          { clientEntryId, completedOn: today() },
          { "idempotency-key": clientEntryId },
        ),
      );
      if (target !== s.farm()?.id || epoch !== s.sessionEpoch()) return;
      await Promise.resolve(refetch()).catch(() => undefined);
      s.setNotice("Care activity recorded in your field journal.");
    } catch (issue) {
      if (target === s.farm()?.id && epoch === s.sessionEpoch())
        setError((issue as Error).message);
    } finally {
      if (target === s.farm()?.id && epoch === s.sessionEpoch())
        setCareBusy("");
    }
  }

  return (
    <div class={`farm-command tab-${tab()}`}>
      <header class="farm-command-heading">
        <div class="farm-command-identity">
          <span class="command-farm-icon">
            <Icon name="leaf" size={22} />
          </span>
          <div>
            <h1>{s.farm()?.name ?? "Your farm"}</h1>
            <p>
              <Icon name="pin" size={12} />
              {s.farm()?.location.districtName ?? "Location not recorded"}
              <span>·</span>
              {s.farm()?.areaHectares != null
                ? `${s.farm()!.areaHectares!.toFixed(2)} ha`
                : "Area unknown"}
              <Show when={s.farm()?.facts.demo_prefilled?.value === true}>
                <span class="command-demo">Demo boundary</span>
              </Show>
            </p>
          </div>
        </div>
        <div class="farm-command-actions">
          <A
            href="/farm/manage"
            class="command-icon-button"
            aria-label="Manage farm boundary"
            title="Manage farm boundary"
          >
            <Icon name="settings" size={18} />
          </A>
          <button
            class="btn compact"
            onClick={() => openPlant()}
            disabled={!data()}
          >
            <Icon name="plus" size={16} /> Plant crop
          </button>
        </div>
      </header>
      <nav class="farm-context-tabs" aria-label="Farm views">
        <For each={tabs}>
          {(item) => (
            <A
              href={`/farm?tab=${item.id}`}
              aria-label={item.label}
              classList={{ active: tab() === item.id }}
              aria-current={tab() === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
              <Show when={item.id === "today" && dueCount()}>
                <small>{dueCount()}</small>
              </Show>
            </A>
          )}
        </For>
      </nav>
      <Show when={s.planningSetupPending()}>
        <div class="command-data-warning" role="status">
          <Icon name="history" size={16} />
          <span>
            <strong>One step to go.</strong> Confirm the previous harvest, first
            season, or unknown history to start local planning.
          </span>
          <button class="text-button" onClick={() => setHistory(true)}>
            Confirm harvest history
          </button>
        </div>
      </Show>
      <Show when={resource.error}>
        <div class="command-data-warning" role="status">
          <Icon name="info" size={15} />
          <span>
            Some farm context is unavailable. Saved records remain accessible.
          </span>
          <button class="text-button" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      </Show>
      <Show when={error() && !planting()}>
        <p class="inline-error command-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={tab() === "today"}>
        <TodayView
          data={data}
          resource={resource}
          workspace={workspace}
          cycles={cycles}
          active={active}
          tasks={tasks}
          dueCount={dueCount}
          scene={scene}
          setScene={setScene}
          allCare={allCare}
          setAllCare={setAllCare}
          careBusy={careBusy}
          setCycleId={setCycleId}
          complete={complete}
          openPlant={openPlant}
          showTool={showTool}
        />
      </Show>
      <Show when={tab() === "soil" && location.pathname !== "/farm/settings"}>
        <div class="farm-tab-scroll soil-fit-workspace">
          <div class="context-view-heading">
            <div>
              <p class="eyebrow">YOUR FIELD · SOURCE-BASED CHECKS</p>
              <h2>Match the crop to what you know.</h2>
              <p>
                Measurements, local growing windows and evidence gaps stay
                visible.
              </p>
            </div>
            <div>
              <button
                class="btn secondary compact"
                onClick={() => showTool("soil")}
              >
                <Icon name="journal" size={16} /> Soil reports
              </button>
              <button class="btn compact" onClick={() => showTool("compare")}>
                <Icon name="compare" size={16} /> Compare crops
              </button>
            </div>
          </div>
          <PlanningReviewPanel compact />
          <div class="focused-crop-heading">
            <h2>Focused crop collection</h2>
            <span>
              {data()?.focusedCrops.length ?? "—"} crops · sourced requirements
            </span>
          </div>
          <div class="focused-crop-grid">
            <For each={data()?.focusedCrops ?? []}>
              {(item) => {
                const fit = () =>
                  data()?.soil.fit.find((fit) => fit.cropId === item.cropId);
                return (
                  <article class="focused-crop-card">
                    <div class="focused-crop-card-top">
                      <span class="focused-crop-icon">
                        <Icon name="leaf" size={23} />
                      </span>
                      <span class="tiny-pill">
                        {words(item.productionType)}
                      </span>
                    </div>
                    <h3>{item.displayName}</h3>
                    <p class="crop-botanical">{item.botanicalName}</p>
                    <Show when={item.soilEffects?.length}>
                      <div class="crop-soil-effects">
                        <span class="eyebrow">
                          SOIL INTERACTIONS · QUALITATIVE
                        </span>
                        <For each={item.soilEffects}>
                          {(effect) => (
                            <div>
                              <h4>{words(effect.topic)}</h4>
                              <p>{effect.text}</p>
                              <details>
                                <summary>Conditions & source</summary>
                                <For each={effect.conditions}>
                                  {(line) => <p>{line}</p>}
                                </For>
                                <SourceLinks
                                  refs={effect.sourceRefs}
                                  data={data()}
                                />
                              </details>
                            </div>
                          )}
                        </For>
                        <p class="effect-caveat">
                          Conditional source descriptions, not measured changes
                          in your field.
                        </p>
                      </div>
                    </Show>
                    <Show when={item.sequenceConstraints?.length}>
                      <details class="crop-sequence-constraints">
                        <summary>Before the next crop</summary>
                        <For each={item.sequenceConstraints}>
                          {(constraint) => (
                            <div>
                              <p>{constraint.text}</p>
                              <For each={constraint.conditions}>
                                {(line) => <p>{line}</p>}
                              </For>
                              <SourceLinks
                                refs={constraint.sourceRefs}
                                data={data()}
                              />
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>
                    <span
                      class={`crop-fit-status ${fit()?.status ?? "unknown"}`}
                    >
                      {fitLabel(fit()?.status ?? "")}
                    </span>
                    <p>
                      {fit()?.summary ??
                        "No compatible field assessment is available yet."}
                    </p>
                    <Show when={fit()?.requirements.length}>
                      <details>
                        <summary>Published requirements</summary>
                        <For each={fit()?.requirements}>
                          {(requirement) => (
                            <div class="crop-source-requirement">
                              <strong>{words(requirement.parameter)}</strong>
                              <p>
                                {typeof requirement.value === "string" ||
                                typeof requirement.value === "number"
                                  ? String(requirement.value)
                                  : JSON.stringify(requirement.value)}{" "}
                                {requirement.unit}
                              </p>
                              <For each={requirement.conditions}>
                                {(line) => <p>{line}</p>}
                              </For>
                              <SourceLinks
                                refs={requirement.sourceRefs}
                                data={data()}
                              />
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>
                    <button
                      class="text-button"
                      onClick={() => openPlant(item.cropId)}
                    >
                      Plant {item.displayName}
                      <Icon name="plus" size={14} />
                    </button>
                  </article>
                );
              }}
            </For>
          </div>
          <Show when={!data() && resource.loading}>
            <p class="command-loading" role="status">
              Loading supported crops and field evidence…
            </p>
          </Show>
        </div>
      </Show>
      <Show when={location.pathname === "/farm/settings"}>
        <div class="farm-tab-scroll embedded-tool">
          <FarmSettings />
        </div>
      </Show>
      <Show when={tab() === "year"}>
        <YearPlanView />
      </Show>
      <Show when={tab() === "harvest"}>
        <div class="farm-tab-scroll embedded-tool">
          <section class="harvest-context-panel">
            <div class="context-view-heading">
              <div>
                <p class="eyebrow">HARVEST CONTEXT</p>
                <h2>Dates and markets, with their limits.</h2>
                <p>
                  Historical prices are context, not a future sale-price
                  forecast.
                </p>
              </div>
            </div>
            <Show when={data()?.priorYearMarkets.length}>
              <div class="prior-market-grid">
                <For each={data()?.priorYearMarkets}>
                  {(item) => (
                    <article class="command-panel">
                      <span class="tiny-pill">Same period · previous year</span>
                      <h3>
                        {s
                          .crops()
                          ?.flatMap((c) =>
                            c.products.map((p) => ({
                              id: p.productId,
                              name: `${c.name} · ${p.name}`,
                            })),
                          )
                          .find((p) => p.id === item.productId)?.name ??
                          words(item.productId)}
                      </h3>
                      <p>
                        {dateLabel(item.period.from)} –{" "}
                        {dateLabel(item.period.to)}
                      </p>
                      <Show
                        when={item.observations[0]}
                        fallback={
                          <p>
                            No dated comparison quote is available for this
                            period.
                          </p>
                        }
                      >
                        {(quote) => (
                          <>
                            <strong class="prior-market-value">
                              ₹
                              {quote().modalInrPerKg != null
                                ? Number(quote().modalInrPerKg).toLocaleString(
                                    "en-IN",
                                  )
                                : "—"}
                              <small>/kg</small>
                            </strong>
                            <p>
                              {quote().marketName} · {quote().district},{" "}
                              {quote().state}
                            </p>
                            <p>
                              {dateLabel(quote().date)} · {words(item.scope)}{" "}
                              coverage
                            </p>
                            <p>
                              Reported modal: {quote().modal ?? "Unknown"}{" "}
                              INR/quintal ·{" "}
                              {quote().unitBasis === "provider_declared"
                                ? "provider-declared unit"
                                : "Agmarknet unit convention"}
                            </p>
                            <a
                              class="text-link"
                              href={quote().source}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Market source ↗
                            </a>
                          </>
                        )}
                      </Show>
                      <details>
                        <summary>Coverage & limitations</summary>
                        <p>
                          {item.coverageDays} observed days. This is not a
                          complete seasonal price history.
                        </p>
                        <For each={item.limitations}>
                          {(line) => <p>{line}</p>}
                        </For>
                      </details>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>
          <MarketContextPanel
            cropIds={[
              ...new Set([
                ...(workspace()?.cycles.map((c) => c.cropId) ?? []),
                ...(workspace()?.rotationPlans.map((p) => p.cropId) ?? []),
              ]),
            ]}
          />
          <Outlook />
        </div>
      </Show>
      <Show when={tab() === "activity"}>
        <div class="farm-tab-scroll embedded-tool">
          <JournalWorkspace />
        </div>
      </Show>
      <Show when={tool()}>
        <div class="modal-backdrop command-drawer-backdrop">
          <section
            class={`command-tool-drawer ${tool() === "soil" ? "soil-drawer" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              tool() === "soil"
                ? "Farm soil reports"
                : "Compare crops for this farm"
            }
          >
            <header class="command-drawer-heading">
              <div>
                <span class="eyebrow">{s.farm()?.name}</span>
                <h2>
                  {tool() === "soil"
                    ? "Soil reports & measurements"
                    : "Compare crop choices"}
                </h2>
              </div>
              <button
                class="icon-button"
                aria-label="Close farm tool"
                onClick={() => showTool(null)}
              >
                <Icon name="close" size={20} />
              </button>
            </header>
            <div class="command-drawer-content embedded-tool">
              <Show
                when={tool() === "soil"}
                fallback={
                  <Show
                    when={data()?.focusedCrops.length}
                    fallback={
                      <p class="command-loading" role="status">
                        Loading this farm’s supported crop collection…
                      </p>
                    }
                  >
                    <CompareWorkspace
                      focused
                      cropIds={data()?.focusedCrops.map((crop) => crop.cropId)}
                    />
                  </Show>
                }
              >
                <FarmSettings />
              </Show>
            </div>
          </section>
        </div>
      </Show>
      <Show when={planting()}>
        <div class="modal-backdrop plant-crop-backdrop">
          <section
            class="plant-crop-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="What did you plant?"
          >
            <header>
              <div>
                <p class="eyebrow">{s.farm()?.name} · NEW CROP</p>
                <h2 id="plant-title">What did you plant?</h2>
                <p>A dated field record starts your crop-care schedule.</p>
              </div>
              <button
                class="icon-button"
                aria-label="Close planting record"
                onClick={() => setPlanting(false)}
              >
                <Icon name="close" size={20} />
              </button>
            </header>
            <form onSubmit={(event) => void recordPlanting(event)}>
              <fieldset
                class="plant-choice-grid"
                disabled={plantBusy() || !!plantPayload()}
              >
                <legend>Choose a crop</legend>
                <For each={data()?.focusedCrops ?? []}>
                  {(item) => (
                    <label classList={{ chosen: plantCrop() === item.cropId }}>
                      <input
                        type="radio"
                        name="plant-crop"
                        value={item.cropId}
                        checked={plantCrop() === item.cropId}
                        onChange={() => chooseCrop(item.cropId)}
                        required
                      />
                      <Icon name="leaf" size={19} />
                      <span>{item.displayName}</span>
                      <Show when={plantCrop() === item.cropId}>
                        <Icon name="check" size={13} />
                      </Show>
                    </label>
                  )}
                </For>
              </fieldset>
              <Show when={chosenCrop()}>
                {(item) => (
                  <fieldset
                    class="plant-date-fields"
                    disabled={plantBusy() || !!plantPayload()}
                  >
                    <div class="form-grid">
                      <label>
                        How was it established?
                        <select
                          required
                          value={method()}
                          onChange={(e) => setMethod(e.currentTarget.value)}
                        >
                          <option value="">Select method</option>
                          <For each={item().establishmentMethods}>
                            {(value) => (
                              <option value={value}>{words(value)}</option>
                            )}
                          </For>
                        </select>
                      </label>
                      <label>
                        Establishment date
                        <input
                          type="date"
                          required
                          max={today()}
                          value={plantDate()}
                          onInput={(e) => setPlantDate(e.currentTarget.value)}
                        />
                      </label>
                    </div>
                    <Show when={item().products.length > 1}>
                      <label>
                        Harvest product
                        <select
                          value={product()}
                          required
                          onChange={(e) => setProduct(e.currentTarget.value)}
                        >
                          <option value="">Choose the product</option>
                          <For each={item().products}>
                            {(value) => (
                              <option value={value.productId}>
                                {value.productName}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    </Show>
                    <label>
                      Field note <small>optional</small>
                      <textarea
                        rows="2"
                        maxlength="2000"
                        value={plantNote()}
                        onInput={(e) => setPlantNote(e.currentTarget.value)}
                        placeholder="Variety, planting details, or what you observed…"
                      />
                    </label>
                    <Show when={item().limitations.length}>
                      <details>
                        <summary>Source coverage for this crop</summary>
                        <For each={item().limitations}>
                          {(line) => <p>{line}</p>}
                        </For>
                      </details>
                    </Show>
                  </fieldset>
                )}
              </Show>
              <Show when={error()}>
                <p class="inline-error" role="alert">
                  {error()}
                </p>
              </Show>
              <footer>
                <span>
                  <Icon name="journal" size={14} /> Saves a planting event in
                  Activity
                </span>
                <button
                  class="btn"
                  type="submit"
                  disabled={plantBusy() || !chosenCrop()}
                >
                  {plantBusy() ? "Recording…" : "Record planting"}
                  <Icon name="arrow" size={16} />
                </button>
              </footer>
            </form>
          </section>
        </div>
      </Show>
      <Show when={history()}>
        <HistoryDialog
          onClose={() => {
            setHistory(false);
            navigate(`/farm?tab=${tab()}`);
          }}
        />
      </Show>
    </div>
  );
}
