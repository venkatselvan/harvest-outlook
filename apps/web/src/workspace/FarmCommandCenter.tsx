import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
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
import { plantCropChoices, plantGroups, ROLE_LABEL, type PlantChoice } from "./cropPool";
import { Chip } from "./ui/Chip";
import { FarmWorkspace, HistoryDialog } from "./FarmPage";
import { CompareWorkspace } from "./Compare";
import { JournalWorkspace } from "./Journal";
import { FarmSettings } from "./FarmSettings";
import { MarketContextPanel } from "./MarketContextPanel";
import MarketView from "./market/MarketView";
import CropFitView from "./farm/CropFitView";
import SoilReviewPanel from "./farm/SoilReviewPanel";
import { Icon } from "./icons";
import { Evara } from "./Evara";
import { TodayView } from "./today/TodayView";
import type { Tool } from "./today/types";
import { YearPlanView } from "./year/YearPlanView";
import {
  FarmTabNav,
  farmHref,
  farmSections,
  selectedSection,
  selectedTab,
  setDueBadge,
} from "./farmTabs";
import "./farm-command.css";

const words = (value: string) =>
  value.replace(/_/g, " ").replace(/^\w/, (s) => s.toUpperCase());
const fitLabel = (status: string) =>
  ({
    needs_soil_report: "Soil report needed",
    insufficient_compatible_measurements: "Compatible readings needed",
    within_published_ph_range: "pH within source range",
    outside_published_ph_range: "pH outside source range",
  })[status] ?? "Check source requirements";

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
  /** The Farm tab's secondary toggle: crop fit, soil records (FarmSettings) or Activity (Journal). */
  const section = () =>
    selectedSection(
      location.pathname,
      query().get("tab") ?? undefined,
      query().get("view") ?? undefined,
    );
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
  // Pool crops (grouped by rotation role), crops with a care schedule, and anything already recorded on this farm.
  const plantChoices = createMemo<PlantChoice[]>(() =>
    plantCropChoices({
      focused: data()?.focusedCrops,
      catalogue: s.crops(),
      recorded: workspace()?.cycles,
    }),
  );
  const plantChoiceGroups = createMemo(() => plantGroups(plantChoices()));
  const chosenCrop = () => plantChoices().find((crop) => crop.cropId === plantCrop());
  const showTool = (tool: Tool) =>
    navigate(
      `${farmHref(tab(), section())}${tool ? `&tool=${tool}` : ""}`,
    );
  // The tab bars live in the shell, outside this component: publish the due count for the Today badge.
  createEffect(() => setDueBadge(dueCount()));
  onCleanup(() => setDueBadge(0));
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
    const crop = plantChoices().find((crop) => crop.cropId === id);
    setMethod(crop?.methods.length === 1 ? crop.methods[0]! : "");
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
        `${selected.name} recorded. Source-based care is ready where evidence is available.`,
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
      <FarmTabNav variant="top" current={tab} />
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
      <Show when={tab() === "soil"}>
        <nav class="farm-subnav" aria-label="Farm sections">
          <For each={farmSections}>
            {(item) => (
              <a
                href={farmHref("soil", item.id)}
                classList={{ active: section() === item.id }}
                aria-current={section() === item.id ? "page" : undefined}
              >
                {item.label}
              </a>
            )}
          </For>
        </nav>
      </Show>
      <Show when={tab() === "soil" && section() === "fit"}>
        <div class="farm-tab-scroll soil-fit-workspace">
          <div class="crop-fit-toolbar">
            <button class="btn secondary compact" onClick={() => showTool("soil")}>
              <Icon name="journal" size={16} /> Soil reports
            </button>
            <button class="btn compact" onClick={() => showTool("compare")}>
              <Icon name="compare" size={16} /> Compare crops
            </button>
          </div>
          <Show when={s.farm()?.id}>{(id) => <CropFitView farmId={id()} />}</Show>
        </div>
      </Show>
      <Show when={tab() === "soil" && section() === "records"}>
        <div class="farm-tab-scroll embedded-tool">
          <Show when={s.farm()?.id}>{(id) => <SoilReviewPanel farmId={id()} />}</Show>
          <div id="soil-report-values">
            <FarmSettings />
          </div>
        </div>
      </Show>
      <Show when={tab() === "year"}>
        <YearPlanView />
      </Show>
      <Show when={tab() === "harvest"}>
        <div class="farm-tab-scroll embedded-tool market-tab">
          <Show when={s.farm()?.id}>{(id) => <MarketView farmId={id()} />}</Show>
          <details class="market-context-details">
            <summary>Wider market context (FAO monthly bulletin)</summary>
            <MarketContextPanel
              cropIds={[
                ...new Set([
                  ...(workspace()?.cycles.map((c) => c.cropId) ?? []),
                  ...(workspace()?.rotationPlans.map((p) => p.cropId) ?? []),
                ]),
              ]}
            />
          </details>
        </div>
      </Show>
      <Show when={tab() === "soil" && section() === "activity"}>
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
                <For each={plantChoiceGroups()}>
                  {(group) => (
                    <>
                      <p
                        class="eyebrow plant-choice-heading"
                        style={{ "grid-column": "1 / -1", margin: "6px 0 0" }}
                        data-testid={`plant-group-${group.role}`}
                      >
                        {group.role === "other" ? "Other crops" : ROLE_LABEL[group.role]}{" "}
                        <Show when={group.role === "nitrogen_fixer"}>
                          <Chip tone="legume">Legume</Chip>
                        </Show>
                      </p>
                      <For each={group.crops}>
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
                            <span>{item.name}</span>
                            <Show when={plantCrop() === item.cropId}>
                              <Icon name="check" size={13} />
                            </Show>
                          </label>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </fieldset>
              <Show when={chosenCrop()}>
                {(item) => (
                  <fieldset
                    class="plant-date-fields"
                    disabled={plantBusy() || !!plantPayload()}
                  >
                    <Show when={item().legume}>
                      <p>
                        <Chip tone="legume">Legume, adds nitrogen</Chip>
                      </p>
                    </Show>
                    <Show when={!item().careSchedule}>
                      <p class="inline-note">
                        This crop has no reviewed care schedule yet. Your planting is still recorded in your field journal,
                        Today view and year plan.
                      </p>
                    </Show>
                    <div class="form-grid">
                      <label>
                        How was it established?
                        <select
                          required
                          value={method()}
                          onChange={(e) => setMethod(e.currentTarget.value)}
                        >
                          <option value="">Select method</option>
                          <For each={item().methods}>
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
                                {value.name}
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
            navigate(farmHref(tab(), section()));
          }}
        />
      </Show>
    </div>
  );
}
