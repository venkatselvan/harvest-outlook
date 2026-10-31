import { FarmStart } from "./FarmStart";
import { GeographicBoundary } from "@harvest/contracts";
import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { FarmMap } from "./FarmMap";
import { Icon } from "./icons";
import {
  useWorkspace,
  boundaryArea,
  dateLabel,
  today,
  type Boundary,
  type GeoFarm,
  type Workspace,
} from "./state";
import {
  apiRequest,
  jsonInit,
  newEntryId,
} from "../features/photo-region/http";
import { listDistricts, listStates } from "../lib/catalogue-api";
import { stateLabel } from "../routes/farm/formModel";
/** Response of POST /api/v1/boundary-context: administrative location for the drawn boundary. */
type BoundaryContext = {
  suggestedName?: string;
  location: {
    stateId: string | null;
    stateName: string | null;
    districtId: string | null;
    districtName: string | null;
  };
};
export function PageHeading(props: {
  eyebrow: string;
  title: string;
  description: string;
  children?: import("solid-js").JSX.Element;
}) {
  return (
    <div class="page-heading">
      <div>
        <p class="eyebrow">{props.eyebrow}</p>
        <h1>{props.title}</h1>
        <p class="page-description">{props.description}</p>
      </div>
      <div class="heading-actions">{props.children}</div>
    </div>
  );
}
export function HistoryDialog(props: { onClose: () => void }) {
  const s = useWorkspace();
  const capturedFarm = s.farm()?.id;
  const capturedEpoch = s.sessionEpoch();
  const [initialized, setInitialized] = createSignal(false);
  const [kind, setKind] = createSignal<"known" | "none" | "unknown">("unknown");
  const [crop, setCrop] = createSignal("");
  const [date, setDate] = createSignal("");
  const [error, setError] = createSignal("");
  const matchesTarget = () =>
    s.farm()?.id === capturedFarm && s.sessionEpoch() === capturedEpoch;
  const ready = () =>
    initialized() &&
    matchesTarget() &&
    !s.workspace.loading &&
    s.workspace()?.farmId === capturedFarm;
  createEffect(() => {
    const workspace = s.workspace();
    if (
      initialized() ||
      !matchesTarget() ||
      s.workspace.loading ||
      !workspace ||
      workspace.farmId !== capturedFarm
    )
      return;
    const initial = workspace.previousHarvest;
    setKind(initial.status);
    setCrop(initial.status === "known" ? initial.cropId : "");
    setDate(initial.status === "known" ? initial.harvestDate : "");
    setInitialized(true);
  });
  async function save() {
    if (!matchesTarget()) {
      setError(
        "Your selected farm changed. Close this dialog and reopen it for the current farm.",
      );
      return;
    }
    if (!ready()) {
      setError(
        "This farm’s history is still loading. Please wait and try again.",
      );
      return;
    }
    if (kind() === "known" && (!crop() || !date())) {
      setError("Choose a crop and the date of your last harvest.");
      return;
    }
    try {
      await s.saveWorkspace({
        previousHarvest:
          kind() === "known"
            ? {
                status: "known",
                cropId: crop(),
                cropName: s.cropName(crop()),
                harvestDate: date(),
              }
            : { status: kind() as "none" | "unknown" },
      });
      if (matchesTarget()) {
        props.onClose();
      }
    } catch (e) {
      if (matchesTarget()) setError((e as Error).message);
    }
  }
  return (
    <div class="modal-backdrop">
      <section
        class="modal-card history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
      >
        <button
          class="modal-close icon-button"
          onClick={props.onClose}
          aria-label="Close harvest history"
        >
          <Icon name="close" />
        </button>
        <span class="round-feature">
          <Icon name="history" size={27} />
        </span>
        <p class="eyebrow">GET TO KNOW YOUR LAND</p>
        <h2 id="history-title">What grew here last?</h2>
        <p class="muted">
          Keep a starting point for your crop rotation. Your own history is more
          useful than a guess.
        </p>
        <Show when={!ready()}>
          <p class="muted" role="status">
            {matchesTarget()
              ? "Loading this farm’s harvest history…"
              : "Your selected farm changed. Close this dialog and reopen it."}
          </p>
        </Show>
        <fieldset class="unstyled-fieldset" disabled={!ready() || s.saving()}>
          <div class="choice-stack">
            <button
              classList={{ selected: kind() === "known" }}
              onClick={() => setKind("known")}
            >
              <Icon name="leaf" />
              <span>
                <strong>I have a previous harvest</strong>
                <small>Record the most recent crop</small>
              </span>
              <i />
            </button>
            <button
              classList={{ selected: kind() === "none" }}
              onClick={() => setKind("none")}
            >
              <Icon name="sun" />
              <span>
                <strong>This is my first season</strong>
                <small>No previous harvest on this land</small>
              </span>
              <i />
            </button>
            <button
              classList={{ selected: kind() === "unknown" }}
              onClick={() => setKind("unknown")}
            >
              <Icon name="history" />
              <span>
                <strong>I don't know yet</strong>
                <small>Continue with history marked unknown</small>
              </span>
              <i />
            </button>
          </div>
          <Show when={kind() === "known"}>
            <div class="form-grid">
              <label>
                Previous crop
                <select
                  value={crop()}
                  onChange={(e) => setCrop(e.currentTarget.value)}
                  required
                >
                  <option value="">Choose a crop</option>
                  <For each={s.crops() ?? []}>
                    {(c) => <option value={c.cropId}>{c.name}</option>}
                  </For>
                </select>
              </label>
              <label>
                Harvested on
                <input
                  type="date"
                  max={today()}
                  value={date()}
                  onInput={(e) => setDate(e.currentTarget.value)}
                  required
                />
              </label>
            </div>
          </Show>
        </fieldset>
        <Show when={error()}>
          <p class="inline-error" role="alert">
            {error()}
          </p>
        </Show>
        <button
          class="btn full-width"
          onClick={() => void save()}
          disabled={s.saving() || !ready()}
        >
          {s.saving() ? "Saving…" : "Save harvest history"}
          <Icon name="arrow" size={17} />
        </button>
      </section>
    </div>
  );
}
export function FarmWorkspace(
  props: { startAdding?: boolean; onReady?: () => void } = {},
) {
  const s = useWorkspace();
  const [pageQuery] = useSearchParams<{ history?: string }>();
  const [adding, setAdding] = createSignal(false);
  const [setupMode, setSetupMode] = createSignal<"choose" | "real">("choose");
  const [boundaryComplete, setBoundaryComplete] = createSignal(false);
  const [savingBoundary, setSavingBoundary] = createSignal(false);
  const [demoBusy, setDemoBusy] = createSignal(false);
  // Bumped on every farm/session/boundary change so a slow location lookup cannot overwrite newer input.
  let prefillSequence = 0;
  const dirty = { name: false, state: false, district: false };
  const demoKey = newEntryId("demo");
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal<Boundary | null>(null);
  const [history, setHistory] = createSignal(false);
  createEffect(() => {
    if (pageQuery.history === "1" && s.farm()?.id) setHistory(true);
  });
  const [center, setCenter] = createSignal<[number, number]>();
  const [name, setName] = createSignal("");
  const [state, setState] = createSignal("");
  const [district, setDistrict] = createSignal("");
  const [districtText, setDistrictText] = createSignal("");
  const [water, setWater] = createSignal("unknown");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [pendingFarm, setPendingFarm] = createSignal<GeoFarm | null>(null);
  let createKey = newEntryId("farm");
  let preparedBody: Record<string, unknown> | null = null;
  const [places, setPlaces] = createSignal<
    {
      name: string;
      latitude: number;
      longitude: number;
      admin1?: string;
      admin2?: string;
    }[]
  >([]);
  let createdId: string | undefined;
  let previousFarmId = s.farm()?.id;
  let previousEpoch = s.sessionEpoch();
  createEffect(
    on([() => s.farm()?.id, s.sessionEpoch], ([id, epoch]) => {
      const identityChanged = epoch !== previousEpoch;
      if (previousFarmId !== id || identityChanged) {
        ++prefillSequence;
        setBoundaryComplete(false);
        setEditing(false);
        setDraft(null);
        setSavingBoundary(false);
        setAdding(false);
        setError("");
        if (id !== createdId || identityChanged) setHistory(false);
        if (identityChanged) {
          setSetupMode("choose");
          setPendingFarm(null);
          preparedBody = null;
          createKey = newEntryId("farm");
          setName("");
          setState("");
          setDistrict("");
          setDistrictText("");
          setWater("unknown");
          setCenter(undefined);
          setQuery("");
          setPlaces([]);
          for (const key of Object.keys(dirty) as (keyof typeof dirty)[])
            dirty[key] = false;
        }
      }
      previousFarmId = id;
      previousEpoch = epoch;
      createdId = undefined;
    }),
  );
  const [states] = createResource(() => listStates());
  const [districts] = createResource(
    () => state() || null,
    (id) => listDistricts(id),
  );
  const onboarding = () => (!s.farms.loading && !s.farm()) || adding();
  const choosing = () => onboarding() && setupMode() === "choose";
  const isDemo = () =>
    s.farm()?.facts.demo_prefilled?.value === true ||
    s.farm()?.facts.demo_illustrative?.value === true;
  const drawMode = () => (onboarding() ? !boundaryComplete() : editing());
  const visibleBoundary = () =>
    onboarding() || editing()
      ? draft()
      : s.workspace()?.farmId === s.farm()?.id
        ? (s.workspace()?.boundary ?? null)
        : null;
  async function search(e: SubmitEvent) {
    e.preventDefault();
    if (query().trim().length < 3) return;
    setSearching(true);
    setError("");
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query())}&count=6&language=en&countryCode=IN`,
      );
      if (!r.ok)
        throw Error(
          "Place search is unavailable. Pan the map or use your location.",
        );
      const d = (await r.json()) as { results?: ReturnType<typeof places> };
      setPlaces(d.results ?? []);
      if (!d.results?.length)
        setError("No matching place in India. Try a nearby town or district.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }
  async function saveFarm() {
    const epoch = s.sessionEpoch();
    setError("");
    const b = draft();
    if (!b || !boundaryComplete()) {
      setError("Finish a boundary with at least three points on the map.");
      return;
    }
    const validation = GeographicBoundary.safeParse(b);
    if (!validation.success) {
      setError(
        "This boundary crosses itself or does not enclose land. Clear it and draw corners around the field in order.",
      );
      return;
    }
    if (!name().trim() || !state() || (!district() && !districtText().trim())) {
      setError("Add a farm name, state, and district to save your land.");
      return;
    }
    setBusy(true);
    try {
      const points = b.coordinates[0]!.slice(0, -1);
      const lat = points.reduce((n, p) => n + p[1]!, 0) / points.length;
      const lon = points.reduce((n, p) => n + p[0]!, 0) / points.length;
      preparedBody ??= {
        name: name().trim(),
        location: {
          stateId: state(),
          ...(district()
            ? { districtId: district() }
            : { districtName: districtText().trim() }),
          lat,
          lon,
          precision: "precise",
        },
        areaHectares: Math.round(boundaryArea(b) * 10000) / 10000,
        facts:
          water() === "unknown"
            ? {}
            : {
                irrigation_category: {
                  value: water(),
                  basis: "farmer_reported",
                  confirmed: true,
                  source: "Farm setup: farmer selection",
                },
              },
      };
      const farm =
        pendingFarm() ??
        (
          await apiRequest<GeoFarm>(
            "/api/v1/farms",
            jsonInit("POST", preparedBody, { "idempotency-key": createKey }),
          )
        ).data!;
      if (epoch !== s.sessionEpoch()) return;
      setPendingFarm(farm);
      await apiRequest<Workspace>(
        `/api/v1/farms/${farm.id}/workspace`,
        jsonInit("PUT", {
          expectedVersion: 0,
          boundary: b,
          previousHarvest: { status: "unknown" },
          cycles: [],
          rotationPlans: [],
        }),
      );
      if (epoch !== s.sessionEpoch()) return;
      createdId = farm.id;
      s.setFarms([...(s.farms() ?? []), farm]);
      s.selectFarm(farm.id);
      setAdding(false);
      setDraft(null);
      setName("");
      setPendingFarm(null);
      preparedBody = null;
      createKey = newEntryId("farm");
      setHistory(true);
      s.setNotice("Your farm and boundary are saved.");
    } catch (e) {
      if (epoch === s.sessionEpoch())
        setError(
          `${pendingFarm() ? "Your farm was created; retry to finish saving its boundary. " : ""}${(e as Error).message}`,
        );
    } finally {
      setBusy(false);
    }
  }
  async function saveBoundary() {
    setError("");
    if (!draft()) return;
    try {
      await s.saveWorkspace({ boundary: draft() });
      setEditing(false);
      s.setNotice("Farm boundary updated.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const startAdd = () => {
    setPendingFarm(null);
    preparedBody = null;
    createKey = newEntryId("farm");
    ++prefillSequence;
    setSetupMode("choose");
    setBoundaryComplete(false);
    for (const key of Object.keys(dirty) as (keyof typeof dirty)[])
      dirty[key] = false;
    setName("");
    setState("");
    setDistrict("");
    setDistrictText("");
    setWater("unknown");
    setAdding(true);
    setEditing(false);
    setDraft(null);
    setError("");
  };
  let initialAddStarted = false;
  createEffect(() => {
    if (props.startAdding && !s.farms.loading && !initialAddStarted) {
      initialAddStarted = true;
      startAdd();
    }
  });
  async function loadDemo() {
    if (demoBusy()) return;
    const epoch = s.sessionEpoch();
    const originalFarm = s.farm()?.id;
    setDemoBusy(true);
    setError("");
    try {
      const data = (
        await apiRequest<{
          farm: GeoFarm;
          workspace: Workspace;
          demo: { prefilledBoundary?: boolean; label: string; source: string };
        }>(
          "/api/v1/farms/demo",
          jsonInit("POST", {}, { "idempotency-key": demoKey }),
        )
      ).data!;
      if (epoch !== s.sessionEpoch()) return;
      if (s.farm()?.id !== originalFarm) {
        void s.refreshFarms();
        return;
      }
      ++prefillSequence;
      createdId = data.farm.id;
      s.setFarms([
        ...(s.farms() ?? []).filter((f) => f.id !== data.farm.id),
        data.farm,
      ]);
      s.selectFarm(data.farm.id);
      // A repeated demo load may upgrade the same ID, so its resource key does not change.
      await s.refreshWorkspace();
      if (epoch !== s.sessionEpoch() || s.farm()?.id !== data.farm.id) return;
      setAdding(false);
      setSetupMode("real");
      setHistory(false);
      setDraft(null);
      setEditing(false);
      setCenter(undefined);
      s.setNotice(
        "Demo boundary ready. Evara will check live sources for this location.",
      );
      props.onReady?.();
    } catch (e) {
      if (epoch === s.sessionEpoch()) setError((e as Error).message);
    } finally {
      setDemoBusy(false);
    }
  }
  function finishBoundary(boundary: Boundary | null) {
    setError("");
    if (!boundary) {
      ++prefillSequence;
      setDraft(null);
      setBoundaryComplete(false);
      return;
    }
    const valid = GeographicBoundary.safeParse(boundary);
    if (!valid.success) {
      setError(
        "The boundary must surround an area without crossing itself. Your points are kept so you can edit them.",
      );
      return;
    }
    setDraft(boundary);
    if (onboarding()) {
      setBoundaryComplete(true);
      void prefillFromBoundary(boundary);
    } else void saveBoundaryFromMap(boundary);
  }
  /** Quick public-context lookup that prefills state, district and name; manual edits are never overwritten. */
  async function prefillFromBoundary(boundary: Boundary) {
    const epoch = s.sessionEpoch();
    const target = s.farm()?.id;
    const sequence = ++prefillSequence;
    const active = () =>
      epoch === s.sessionEpoch() &&
      target === s.farm()?.id &&
      sequence === prefillSequence;
    try {
      const context = (
        await apiRequest<BoundaryContext>(
          "/api/v1/boundary-context",
          jsonInit("POST", { boundary }),
        )
      ).data!;
      if (!active() || !onboarding()) return;
      if (!dirty.name)
        setName(
          context.suggestedName ??
            `${context.location.districtName ?? context.location.stateName ?? "Mapped"} farm`,
        );
      if (!dirty.state && context.location.stateId)
        setState(context.location.stateId);
      if (!dirty.district) {
        setDistrict(context.location.districtId ?? "");
        setDistrictText(context.location.districtName ?? "");
      }
    } catch {
      /* Prefill is a convenience; the farmer can enter the location manually. */
    }
  }
  return (
    <div class="workspace-page">
      <PageHeading
        eyebrow="YOUR LAND, IN PERSPECTIVE"
        title={
          onboarding()
            ? "Every good season starts with your farm."
            : "Your farm, at a glance."
        }
        description={
          onboarding()
            ? "Find your land, draw its boundary, and build a plan that belongs here."
            : "A clearer view of your land today. A better starting point for what comes next."
        }
      >
        <Show when={!onboarding()}>
          <button
            class="text-button demo-entry"
            disabled={demoBusy()}
            onClick={() => void loadDemo()}
          >
            <Icon name="leaf" size={16} />
            {demoBusy() ? "Loading demo…" : "Try demo farm"}
          </button>
          <button class="btn secondary" onClick={startAdd}>
            <Icon name="plus" size={17} /> Add farm
          </button>
          <A class="btn" href="/planner">
            Plan a season <Icon name="arrow" size={17} />
          </A>
        </Show>
      </PageHeading>
      <Show when={s.farms.error}>
        <div class="alert-card" role="alert">
          Your farms couldn't load. {(s.farms.error as Error).message}
          <button class="text-button" onClick={() => void s.refreshFarms()}>
            Try again
          </button>
        </div>
      </Show>
      <Show when={choosing()}>
        <FarmStart
          onReal={() => setSetupMode("real")}
          onDemo={() => void loadDemo()}
          busy={demoBusy()}
          error={error()}
        />
      </Show>
      <Show when={!choosing()}>
        <Show when={isDemo() && !onboarding()}>
          <div class="demo-banner">
            <Icon name="leaf" size={19} />
            <div>
              <strong>Demo field · prefilled boundary</strong>
              <p>
                Only the field outline is prefilled. Weather forecasts, dated
                market quotes, and crop recommendations come from available
                sources for this location. No harvest history or crop plans are
                prefilled.
              </p>
            </div>
            <A href="/planner" class="text-link">
              Review crop recommendations <Icon name="arrow" size={16} />
            </A>
          </div>
        </Show>
        <Show when={onboarding()}>
          <div class="setup-steps">
            <span class="active">
              <b>1</b> Map your farm
            </span>
            <i />
            <span>
              <b>2</b> Add harvest history
            </span>
            <i />
            <span>
              <b>3</b> Plan what comes next
            </span>
          </div>
        </Show>
        <div class="farm-workbench">
          <section class="map-card">
            <div class="section-heading">
              <div>
                <Icon name="map" />
                <h2>
                  {onboarding()
                    ? "Make it your land"
                    : (s.farm()?.name ?? "Your farms")}
                </h2>
                <Show when={!onboarding()}>
                  <span class="tiny-pill">
                    {s.farm()?.location.districtName ?? "District"}
                  </span>
                </Show>
              </div>
              <span class="subtle-caption">
                {drawMode() ? "BOUNDARY EDITOR" : "FARM OVERVIEW"}
              </span>
            </div>
            <div class="map-search">
              <form onSubmit={search}>
                <Icon name="pin" size={18} />
                <input
                  aria-label="Search for a town or village in India"
                  placeholder="Search village, town or district…"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
                <button type="submit" disabled={searching()}>
                  {searching() ? "Searching…" : "Find place"}
                </button>
              </form>
              <Show when={places().length}>
                <div class="place-results">
                  <For each={places()}>
                    {(p) => (
                      <button
                        onClick={() => {
                          setCenter([p.latitude, p.longitude]);
                          setQuery(`${p.name}, ${p.admin1 ?? "India"}`);
                          setPlaces([]);
                        }}
                      >
                        <Icon name="pin" size={16} />
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {[p.admin2, p.admin1].filter(Boolean).join(", ")}
                          </small>
                        </span>
                        <Icon name="arrow" size={15} />
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <FarmMap
              boundary={visibleBoundary()}
              {...(center()
                ? { center: center()! }
                : s.farm()?.location.lat != null &&
                    s.farm()?.location.lon != null
                  ? {
                      center: [
                        s.farm()!.location.lat!,
                        s.farm()!.location.lon!,
                      ] as [number, number],
                    }
                  : {})}
              editing={drawMode()}
              saving={savingBoundary()}
              onBoundary={finishBoundary}
              {...(onboarding()
                ? {
                    onEdit: () => {
                      setBoundaryComplete(false);
                    },
                  }
                : {
                    farmName: s.farm()?.name ?? "Your farm",
                    onEdit: () => {
                      setDraft(s.workspace()?.boundary ?? null);
                      setEditing(true);
                    },
                  })}
            />
            <div class="map-footer">
              <span>
                <Icon name="pin" size={14} />
                {onboarding()
                  ? "India · locate your land to begin"
                  : [
                      s.farm()?.location.districtName,
                      stateLabel(s.farm()?.location.stateCode),
                    ]
                      .filter(Boolean)
                      .join(", ")}
              </span>
              <span>Basemap imagery · not a crop-health observation</span>
            </div>
          </section>
          <aside class="farm-inspector">
            <Show
              when={onboarding()}
              fallback={
                <>
                  <div class="inspector-card">
                    <p class="eyebrow">FARM DETAILS</p>
                    <div class="farm-title-row">
                      <span class="farm-avatar">
                        <Icon name="leaf" size={26} />
                      </span>
                      <div>
                        <h2>{s.farm()?.name}</h2>
                        <p>
                          {s.farm()?.location.districtName},{" "}
                          {stateLabel(s.farm()?.location.stateCode)}
                        </p>
                      </div>
                    </div>
                    <div class="farm-metrics">
                      <div>
                        <span>Mapped area</span>
                        <strong>
                          {s.workspace()?.boundary
                            ? boundaryArea(s.workspace()!.boundary).toFixed(2)
                            : (s.farm()?.areaHectares ?? "—")}{" "}
                          <small>ha</small>
                        </strong>
                      </div>
                      <div>
                        <span>Water source</span>
                        <strong class="small-value">
                          {(
                            {
                              rainfed: "Rainfed",
                              irrigated: "Irrigated",
                              supplemental: "Supplemental",
                            } as Record<string, string>
                          )[
                            String(s.farm()?.facts.irrigation_category?.value)
                          ] ?? "Not recorded"}
                        </strong>
                      </div>
                    </div>
                    <div class="divider" />
                    <div class="detail-line">
                      <span>Boundary</span>
                      <strong
                        class={s.workspace()?.boundary ? "green-text" : "muted"}
                      >
                        {s.workspace()?.boundary
                          ? "Mapped & saved"
                          : "Not mapped"}
                      </strong>
                    </div>
                    <button
                      class="btn secondary full-width"
                      onClick={() => {
                        setDraft(s.workspace()?.boundary ?? null);
                        setEditing(true);
                      }}
                    >
                      <Icon name="draw" size={17} />
                      {s.workspace()?.boundary
                        ? "Edit farm boundary"
                        : "Draw farm boundary"}
                    </button>
                    <A
                      class="text-link farm-settings-link"
                      href="/farm/settings"
                    >
                      <Icon name="settings" size={15} />
                      Farm settings & soil reports
                      <Icon name="arrow" size={14} />
                    </A>
                    <A class="text-link farm-photo-link" href="/farm/details">
                      <Icon name="layers" size={15} />
                      Farm photos & planting region
                      <Icon name="arrow" size={14} />
                    </A>
                    <Show when={editing()}>
                      <button
                        class="text-button full-width"
                        onClick={() => setEditing(false)}
                      >
                        Cancel boundary edit
                      </button>
                    </Show>
                  </div>
                  <div class="inspector-card harvest-history-card">
                    <div class="section-heading">
                      <h2>Previous harvest</h2>
                      <button
                        class="text-button"
                        onClick={() => setHistory(true)}
                      >
                        {s.workspace()?.previousHarvest.status === "unknown"
                          ? "Add"
                          : "Edit"}
                      </button>
                    </div>
                    <span class="history-symbol">
                      <Icon name="history" size={24} />
                    </span>
                    <Show
                      when={s.workspace()?.previousHarvest.status === "known"}
                      fallback={
                        <>
                          <strong>
                            {s.workspace()?.previousHarvest.status === "none"
                              ? "A fresh start"
                              : "Your land has a story."}
                          </strong>
                          <p>
                            {s.workspace()?.previousHarvest.status === "none"
                              ? "No previous harvest. Your first season starts here."
                              : "Add your last harvest so your rotation has a starting point."}
                          </p>
                        </>
                      }
                    >
                      {(() => {
                        const h = s.workspace()?.previousHarvest;
                        return h?.status === "known" ? (
                          <>
                            <strong>
                              {h.cropName ?? s.cropName(h.cropId)}
                            </strong>
                            <p>Harvested {dateLabel(h.harvestDate)}</p>
                          </>
                        ) : null;
                      })()}
                    </Show>
                  </div>
                  <A class="next-step-card" href="/planner">
                    <div>
                      <p class="eyebrow">LOOK AHEAD</p>
                      <h3>One farm. Many seasons.</h3>
                      <p>Build your crop rotation, season by season.</p>
                    </div>
                    <Icon name="arrow" size={22} />
                  </A>
                </>
              }
            >
              <div class="inspector-card setup-inspector">
                <p class="eyebrow">STEP 01 / YOUR FARM</p>
                <h2>A place to grow.</h2>
                <p class="muted">
                  Draw your boundary on the map, then add a few details.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveFarm();
                  }}
                >
                  <fieldset
                    class="unstyled-fieldset farm-setup-fields"
                    disabled={busy() || preparedBody !== null}
                  >
                    <label>
                      Farm name
                      <input
                        placeholder="e.g. Riverside farm"
                        value={name()}
                        onInput={(e) => {
                          dirty.name = true;
                          setName(e.currentTarget.value);
                        }}
                        required
                        maxLength="120"
                      />
                    </label>
                    <div class="form-grid">
                      <label>
                        State
                        <select
                          value={state()}
                          onChange={(e) => {
                            dirty.state = true;
                            dirty.district = true;
                            setState(e.currentTarget.value);
                            setDistrict("");
                            setDistrictText("");
                          }}
                          required
                        >
                          <option value="">Select state</option>
                          <For each={states() ?? []}>
                            {(a) => (
                              <option value={a.id}>{a.names.en ?? a.id}</option>
                            )}
                          </For>
                        </select>
                      </label>
                      <label>
                        District
                        <Show
                          when={
                            districts()?.districts.length &&
                            !(districtText() && !district())
                          }
                          fallback={
                            <input
                              placeholder="District name"
                              value={districtText()}
                              onInput={(e) => (
                                (dirty.district = true),
                                setDistrictText(e.currentTarget.value)
                              )}
                              required
                            />
                          }
                        >
                          <select
                            value={district()}
                            onChange={(e) => {
                              dirty.district = true;
                              setDistrict(e.currentTarget.value);
                            }}
                            required
                          >
                            <option value="">Select district</option>
                            <For each={districts()?.districts ?? []}>
                              {(a) => (
                                <option value={a.id}>
                                  {a.names.en ?? a.id}
                                </option>
                              )}
                            </For>
                          </select>
                        </Show>
                      </label>
                    </div>
                    <label>
                      How is the land watered?
                      <select
                        value={water()}
                        onChange={(e) => setWater(e.currentTarget.value)}
                      >
                        <option value="unknown">Not sure yet</option>
                        <option value="rainfed">Rainfed</option>
                        <option value="supplemental">
                          Rain + supplemental irrigation
                        </option>
                        <option value="irrigated">Irrigated</option>
                      </select>
                    </label>
                  </fieldset>
                  <div class="boundary-summary">
                    <Icon name={boundaryComplete() ? "check" : "draw"} />
                    <span>
                      {draft() && boundaryComplete()
                        ? `${boundaryArea(draft()).toFixed(2)} ha · boundary finished`
                        : "Draw and finish your farm boundary"}
                    </span>
                  </div>
                  <button
                    class="btn full-width"
                    type="submit"
                    disabled={busy() || !draft() || !boundaryComplete()}
                  >
                    {busy() ? "Saving farm…" : "Save farm & continue"}
                    <Icon name="arrow" size={17} />
                  </button>
                  <Show when={!adding()}>
                    <button
                      class="text-button full-width"
                      type="button"
                      onClick={() => {
                        ++prefillSequence;
                        setDraft(null);
                        setBoundaryComplete(false);
                        setSetupMode("choose");
                      }}
                    >
                      Choose another way to start
                    </button>
                  </Show>
                  <Show when={adding()}>
                    <button
                      class="text-button full-width"
                      type="button"
                      onClick={() => {
                        ++prefillSequence;
                        setBoundaryComplete(false);
                        setAdding(false);
                        setDraft(null);
                      }}
                    >
                      Cancel
                    </button>
                  </Show>
                </form>
                <Show when={boundaryComplete()}>
                  <p class="prefill-note">
                    Location and name are prefilled where the boundary can be
                    matched. Edit any field; Evara will keep your changes.
                  </p>
                </Show>
                <p class="privacy-note">
                  Your farm is private to this workspace. Boundaries are
                  approximate, not a legal survey.
                </p>
              </div>
            </Show>
            <Show when={error()}>
              <p class="inline-error" role="alert">
                {error()}
              </p>
            </Show>
          </aside>
        </div>
        <Show when={!onboarding()}>
          <div class="overview-bottom">
            <div class="land-story">
              <span class="round-feature">
                <Icon name="calendar" size={23} />
              </span>
              <div>
                <p class="eyebrow">THE BIGGER PICTURE</p>
                <h3>
                  {s.workspace()?.rotationPlans.length
                    ? `${s.workspace()!.rotationPlans.length} seasons in your rotation`
                    : "Good farming looks beyond the next harvest."}
                </h3>
                <p>
                  Connect what grew before, what you're growing now, and what
                  comes next.
                </p>
              </div>
              <A href="/planner" class="text-link">
                Open rotation planner <Icon name="arrow" size={17} />
              </A>
            </div>
            <div class="farm-collection">
              <div class="section-heading">
                <h2>
                  Your farms{" "}
                  <span class="count-pill">{s.farms()?.length ?? 0}</span>
                </h2>
                <button class="text-button" onClick={startAdd}>
                  + Add another
                </button>
              </div>
              <div class="farm-chips">
                <For each={s.farms() ?? []}>
                  {(f) => (
                    <button
                      classList={{ selected: f.id === s.farm()?.id }}
                      onClick={() => {
                        s.selectFarm(f.id);
                        setEditing(false);
                        setCenter(undefined);
                      }}
                    >
                      <Icon name="leaf" />
                      <span>
                        <strong>{f.name}</strong>
                        <small>{f.location.districtName}</small>
                      </span>
                      <Show when={f.id === s.farm()?.id}>
                        <Icon name="check" size={17} />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={history()}>
        <HistoryDialog
          onClose={() => {
            setHistory(false);
            props.onReady?.();
          }}
        />
      </Show>
    </div>
  );
  async function saveBoundaryFromMap(b: Boundary) {
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    const check = GeographicBoundary.safeParse(b);
    if (!check.success) {
      setError(
        "Your boundary crosses itself or has no area. Draw the field corners in order.",
      );
      return;
    }
    if (savingBoundary()) return;
    setSavingBoundary(true);
    try {
      await s.saveWorkspace({ boundary: b });
      if (s.farm()?.id === farmId && s.sessionEpoch() === epoch) {
        setEditing(false);
        s.setNotice("Farm boundary finished and saved.");
      }
    } catch (e) {
      if (farmId === s.farm()?.id && epoch === s.sessionEpoch())
        setError((e as Error).message);
    } finally {
      setSavingBoundary(false);
    }
  }
}
