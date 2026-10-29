import "../../features/photo-region/photo-region.css";
import { For, Match, Show, Switch, createEffect, createResource, createSignal, onMount } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { CreatePlanStep } from "../../features/plan-create";
import { RegionEditor } from "../../features/photo-region/RegionEditor";
import { PhotoUploader } from "../../features/photo-region/PhotoUploader";
import { apiRequest } from "../../features/photo-region/http";
import type { MediaInfo } from "../../features/photo-region/types";
import { ApiError } from "../../lib/api";
import { refreshCapabilities } from "../../lib/capabilities";
import { FarmForm } from "./FarmForm";
import { MONTHS, stateLabel } from "./formModel";
import type { Farm } from "./types";

const SELECTED_KEY = "ho.selectedFarm";

/** Label for the crop chosen in Explore: prefers the stored names when they match the query ids, else the ids themselves. */
function selectedCropLabel(cropId: string, productId: string | null): string {
  let cropName = cropId;
  let productName = productId;
  try {
    const raw = sessionStorage.getItem("ho.selectedCrop");
    const st = raw ? (JSON.parse(raw) as { cropId?: string; productId?: string; cropName?: string; productName?: string }) : null;
    if (st && st.cropId === cropId && (productId === null || st.productId === productId)) {
      cropName = st.cropName ?? cropName;
      productName = st.productName ?? productName;
    }
  } catch {
    /* storage unavailable or malformed: fall back to ids */
  }
  return productName ? `Selected crop: ${cropName} (${productName})` : `Selected crop: ${cropName}`;
}

async function loadFarms(): Promise<Farm[]> {
  const env = await apiRequest<{ farms: Farm[] }>("/api/v1/farms");
  return env.data!.farms;
}

function FarmSummary(props: { farm: Farm }) {
  const f = () => props.farm;
  const state = () => stateLabel(f().location.stateCode) ?? "State not given";
  const fact = (k: string) => f().facts[k]?.value;
  const window = () => {
    const a = Number(fact("planting_window_start_month"));
    const b = Number(fact("planting_window_end_month"));
    return a >= 1 && b >= 1 ? `${MONTHS[a - 1]} to ${MONTHS[b - 1]}` : "Not decided";
  };
  const irrigation = () => {
    const v = fact("irrigation_category");
    return v === "rainfed" ? "Rain only" : v === "supplemental" ? "Rain plus some irrigation" : v === "irrigated" ? "Irrigated" : "Unknown";
  };
  const area = () => {
    const r = f().facts["area_reported"];
    if (r && typeof r.value === "number") return `${r.value} ${r.unit === "acre" ? "acre" : "hectare"}`;
    return f().areaHectares ? `${f().areaHectares} hectare` : "Unknown";
  };
  return (
    <div class="card" data-testid="farm-summary">
      <h2>{f().location.districtName ?? f().name}</h2>
      <Show when={f().location.districtId === null}>
        <p class="pr-help" role="status" data-testid="district-unresolved">
          {f().warnings?.[0]?.message ?? "This district is kept as you wrote it; it is not matched to the district list, so checks use the state."}
        </p>
      </Show>
      <dl class="facts">
        <dt>State</dt><dd>{state()}</dd>
        <dt>Planting window</dt><dd>{window()}</dd>
        <dt>Water</dt><dd>{irrigation()}</dd>
        <dt>Area</dt><dd>{area()}</dd>
      </dl>
    </div>
  );
}

function PhotoSection(props: { farm: Farm; onRegion?: (has: boolean) => void }) {
  const [media, { mutate }] = createResource(
    () => props.farm.id,
    async (id) => (await apiRequest<{ media: MediaInfo[] }>(`/api/v1/farms/${id}/media`)).data!.media[0] ?? null,
  );
  const [replacing, setReplacing] = createSignal(false);
  createEffect(() => props.onRegion?.(!media.loading && !!media()?.region));
  return (
    <>
      <Switch>
        <Match when={media.error}>
          <p role="alert" class="pr-error">
            Could not load your photo{media.error instanceof ApiError ? `: ${media.error.message}` : ""}. <button type="button" class="btn secondary" onClick={() => location.reload()}>Reload</button>
          </p>
        </Match>
        <Match when={media.loading}>
          <p role="status">Loading your photo…</p>
        </Match>
        <Match when={!media() || replacing()}>
          <PhotoUploader
            farmId={props.farm.id}
            onUploaded={(m) => {
              mutate(m);
              setReplacing(false);
            }}
            {...(media() ? { onCancel: () => setReplacing(false) } : {})}
          />
        </Match>
        <Match when={media()}>
          {(m) => (
            <>
              <RegionEditor media={m()} onSaved={(saved) => mutate(saved)} />
              <p>
                <button type="button" class="btn secondary" onClick={() => setReplacing(true)}>Use a different photo</button>
              </p>
            </>
          )}
        </Match>
      </Switch>
    </>
  );
}

export function FarmPage() {
  const [farms, { mutate, refetch }] = createResource(loadFarms);
  const [selected, setSelected] = createSignal<string | null>(localStorage.getItem(SELECTED_KEY));
  const [query] = useSearchParams<{ cropId?: string; productId?: string }>();
  const [hasRegion, setHasRegion] = createSignal(false);
  const [skipPhoto, setSkipPhoto] = createSignal(false);
  onMount(() => {
    document.title = "My farm · Harvest Outlook";
    void refreshCapabilities();
  });
  const current = () => {
    const list = farms() ?? [];
    return list.find((f) => f.id === selected()) ?? list[0] ?? null;
  };
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" tabindex="-1">My farm</h1>
      <Show when={query.cropId}>{(cropId) => <p class="muted" data-testid="selected-crop">{selectedCropLabel(cropId(), query.productId ?? null)}</p>}</Show>
      <Switch>
        <Match when={farms.error}>
          <div class="card">
            <p role="alert" class="pr-error">Could not load your farm{farms.error instanceof ApiError ? `: ${farms.error.message}` : ""}. Check that the server is running.</p>
            <button type="button" class="btn" onClick={() => void refetch()}>Try again</button>
          </div>
        </Match>
        <Match when={farms.loading}>
          <p role="status">Loading your farm…</p>
        </Match>
        <Match when={!current()}>
          <FarmForm
            onCreated={(f) => {
              mutate([f, ...(farms() ?? [])]);
              setSelected(f.id);
              localStorage.setItem(SELECTED_KEY, f.id);
            }}
          />
        </Match>
        <Match when={current()}>
          {(farm) => (
            <>
              <Show when={(farms() ?? []).length > 1}>
                <div class="field">
                  <label for="farm-select">Farm</label>
                  <select
                    id="farm-select"
                    value={farm().id}
                    onChange={(e) => {
                      setSelected(e.currentTarget.value);
                      localStorage.setItem(SELECTED_KEY, e.currentTarget.value);
                    }}
                  >
                    <For each={farms() ?? []}>{(f) => <option value={f.id}>{f.location.districtName ?? f.name}</option>}</For>
                  </select>
                </div>
              </Show>
              <FarmSummary farm={farm()} />
              <PhotoSection farm={farm()} onRegion={setHasRegion} />
              <Show when={query.cropId}>
                {(cropId) => (
                  <>
                  <Show
                    when={hasRegion() || skipPhoto()}
                    fallback={
                      <div class="card">
                        <p>Confirm your planting region above to continue to the season plan.</p>
                        <button type="button" class="btn secondary" onClick={() => setSkipPhoto(true)}>Plan without a photo</button>
                      </div>
                    }
                  >
                    <CreatePlanStep farm={farm()} cropId={cropId()} productId={query.productId ?? null} />
                  </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </section>
  );
}
