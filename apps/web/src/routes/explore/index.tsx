import "../../features/comparison/comparison.css";
import "./explore.css";
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ProfileForm } from "../../features/profile/ProfileForm";
import { hasErrors, loadProfile, saveProfile, toRequest, validateProfile, type ProfileErrors, type ProfileField, type ProfileInput } from "../../features/profile/model";
import { ResultsList } from "../../features/comparison/ResultsList";
import { SideBySide } from "../../features/comparison/SideBySide";
import { SELECTED_CROP_KEY, farmHref, itemKey, selectionStorageValue, sortItems, toggleSelection } from "../../features/comparison/logic";
import type { ApiWarning, CompareItem, ComparisonRequest, ComparisonResult } from "../../features/comparison/types";
import { classifyFailure, compareCrops, listCrops, listDistricts, listStates, type Failure } from "../../lib/catalogue-api";
import { refreshCapabilities } from "../../lib/capabilities";

const FIELD_ID: Record<ProfileField, string> = {
  state: "pf-state", district: "pf-district", month: "pf-month", date: "pf-date", irrigation: "pf-irrigation", area: "pf-area", price: "pf-price", priceProduct: "pf-price-product", narrative: "pf-narrative",
};
const FIELD_ORDER: ProfileField[] = ["state", "month", "date", "irrigation", "area", "priceProduct", "price", "narrative", "district"];

type Run =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; failure: Failure }
  | { status: "ready"; result: ComparisonResult; warnings: ApiWarning[]; request: ComparisonRequest };

/** Explore: farmer profile, screening results, up to three crop cards side by side. Render-only: all numbers come from the API. */
export function ExplorePage() {
  const navigate = useNavigate();
  const [profile, setProfile] = createSignal<ProfileInput>(loadProfile());
  const [errors, setErrors] = createSignal<ProfileErrors>({});
  const [submitted, setSubmitted] = createSignal(false);
  const [run, setRun] = createSignal<Run>({ status: "idle" });
  const [selected, setSelected] = createSignal<string[]>([]);
  const [blocked, setBlocked] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  let seq = 0;
  let resultsRef: HTMLDivElement | undefined;

  onMount(() => void refreshCapabilities());

  const [states, { refetch: refetchStates }] = createResource(() => listStates());
  const [crops] = createResource(() => listCrops());
  const [districts] = createResource(
    () => profile().stateId || null,
    (s) => listDistricts(s),
  );

  createEffect(() => {
    const d = districts();
    const cur = profile().districtId;
    if (d && cur && d.available && !d.districts.some((x) => x.id === cur)) setProfile({ ...profile(), districtId: "" });
  });
  createEffect(() => {
    const st = states();
    const cur = profile().stateId;
    if (st && cur && !st.some((x) => x.id === cur)) setProfile({ ...profile(), stateId: "", districtId: "" });
  });

  const refsError = () => (states.error || crops.error ? "Could not load the state and crop lists. The form may be incomplete." : null);

  const change = (patch: Partial<ProfileInput>) => {
    const next = { ...profile(), ...patch };
    setProfile(next);
    if (submitted()) setErrors(validateProfile(next));
    if (run().status === "ready") setStale(true);
    saveProfile(next);
  };

  const submit = async () => {
    setSubmitted(true);
    const errs = validateProfile(profile());
    setErrors(errs);
    if (hasErrors(errs)) {
      const first = FIELD_ORDER.find((f) => errs[f]);
      if (first) document.getElementById(FIELD_ID[first])?.focus();
      return;
    }
    const mine = ++seq;
    const request = toRequest(profile());
    saveProfile(profile());
    setRun({ status: "loading" });
    setSelected([]);
    setBlocked(false);
    setStale(false);
    try {
      const { result, warnings } = await compareCrops(request);
      if (mine !== seq) return;
      setRun({ status: "ready", result, warnings, request });
      queueMicrotask(() => resultsRef?.focus());
    } catch (e) {
      if (mine !== seq) return;
      setRun({ status: "error", failure: classifyFailure(e) });
    }
  };

  const ready = createMemo(() => {
    const r = run();
    return r.status === "ready" ? r : null;
  });
  const sorted = createMemo(() => sortItems(ready()?.result.items ?? []));
  const chosen = createMemo<CompareItem[]>(() => selected().flatMap((k) => sorted().find((i) => itemKey(i) === k) ?? []));

  const toggle = (key: string) => {
    const r = toggleSelection(selected(), key);
    setSelected(r.selected);
    setBlocked(r.blocked);
  };
  const choose = (item: CompareItem) => {
    try {
      sessionStorage.setItem(SELECTED_CROP_KEY, selectionStorageValue(item));
    } catch {
      /* private mode: the query string still carries the choice */
    }
    navigate(farmHref(item));
  };
  const assumedPriceFor = (productId: string) => !!ready()?.request.assumedPrices.some((p) => p.productId === productId);

  return (
    <div class="explore">
      <h1>Explore crops</h1>
      <p class="explore-intro">Tell us where and when you plan to plant. We screen the crop catalogue against sourced rules and show what the evidence can and cannot say.</p>
      <Show when={states.error}>
        <button type="button" class="btn" onClick={() => void refetchStates()}>Retry loading states</button>
      </Show>
      <div class="card">
        <ProfileForm
          profile={profile()}
          onChange={change}
          errors={errors()}
          states={states() ?? []}
          districts={districts()?.districts ?? []}
          districtNote={districts()?.note ?? null}
          districtsLoading={districts.loading}
          crops={crops() ?? []}
          refsError={refsError()}
          submitting={run().status === "loading"}
          onSubmit={() => void submit()}
        />
      </div>

      <div class="explore-results" ref={resultsRef} tabindex="-1" aria-label="Comparison results">
        <Switch>
          <Match when={run().status === "loading"}>
            <p role="status" class="explore-status">Comparing crops…</p>
          </Match>
          <Match when={run().status === "error"}>
            <p role="alert" class="cmp-error" data-testid="compare-error" data-kind={(run() as { failure: Failure }).failure.kind}>{(run() as { failure: Failure }).failure.message}</p>
          </Match>
          <Match when={ready()}>
            {(r) => (
              <>
                <Show when={stale()}>
                  <p class="cmp-warn" role="status">Your answers changed after this comparison. Press Compare crops to refresh.</p>
                </Show>
                <Show when={r().warnings.length}>
                  <ul class="explore-warnings" aria-label="Notices from the server">
                    <For each={r().warnings}>{(w) => <li>{w.message}</li>}</For>
                  </ul>
                </Show>
                <Show when={sorted().length} fallback={<p data-testid="empty-results">No crops matched these inputs. Try a different state or planting month, or clear excluded crops.</p>}>
                  <p class="cmp-muted">
                    {r().result.counts.eligible} eligible, {r().result.counts.requires_review} need review, {r().result.counts.unknown} unknown, {r().result.counts.ineligible} not eligible
                    {r().result.counts.excluded_by_farmer ? `, ${r().result.counts.excluded_by_farmer} excluded by you` : ""}. Unknown means the evidence cannot say, not that a crop will fail.
                  </p>
                  <ResultsList items={sorted()} selected={selected()} blockedNotice={blocked()} onToggle={toggle} />
                  <Show when={chosen().length}>
                    <SideBySide items={chosen()} assumedPriceFor={assumedPriceFor} onChoose={choose} onRemove={(i) => toggle(itemKey(i))} />
                  </Show>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
