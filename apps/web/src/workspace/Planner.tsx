import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Icon } from "./icons";
import { useWorkspace, today, dateLabel, type Rotation } from "./state";
import { HistoryDialog, PageHeading } from "./FarmPage";
import { createPlan } from "../lib/plan-api";
import { newEntryId } from "../features/photo-region/http";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export function Planner() {
  const s = useWorkspace();
  const navigate = useNavigate();
  const [year, setYear] = createSignal(new Date().getFullYear());
  const [history, setHistory] = createSignal(false);
  const [editing, setEditing] = createSignal<Partial<Rotation> | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [productSelection, setProductSelection] = createSignal<{
    rotation: Rotation;
    productId: string;
  } | null>(null);
  const rows = createMemo(
    () =>
      s
        .workspace()
        ?.rotationPlans.filter((p) => p.year === year())
        .sort((a, b) =>
          (a.plannedSowingDate ?? "").localeCompare(b.plannedSowingDate ?? ""),
        ) ?? [],
  );
  let editorFarmId: string | undefined;
  createEffect(
    on(
      () => s.farm()?.id,
      () => {
        setEditing(null);
        setProductSelection(null);
        setError("");
      },
    ),
  );
  const update = (patch: Partial<Rotation>) => {
    const value = { ...editing(), ...patch };
    if (patch.cropId && patch.cropId !== editing()?.cropId) {
      delete value.productId;
      delete value.productName;
    }
    setEditing(value);
  };
  async function save() {
    if (editorFarmId !== s.farm()?.id || s.workspace.loading) {
      setError(
        "Your selected farm changed. Reopen the season for the current farm.",
      );
      return;
    }
    const p = editing();
    if (!p?.cropId || !p.season || !p.plannedSowingDate) {
      setError("Choose a crop, season, and planned sowing date.");
      return;
    }
    if (p.plannedHarvestDate && p.plannedHarvestDate < p.plannedSowingDate) {
      setError("Harvest must come after sowing.");
      return;
    }
    setError("");
    try {
      const cleaned = { ...p };
      if (!cleaned.plannedHarvestDate) delete cleaned.plannedHarvestDate;
      if (!cleaned.productId) {
        delete cleaned.productId;
        delete cleaned.productName;
      }
      const next = {
        ...cleaned,
        id: p.id ?? newEntryId("rotation"),
        year: Number(p.plannedSowingDate.slice(0, 4)),
        cropName: s.cropName(p.cropId),
      } as Rotation;
      await s.saveWorkspace({
        rotationPlans: [
          ...(s.workspace()?.rotationPlans ?? []).filter((r) => r.id !== p.id),
          next,
        ],
      });
      setEditing(null);
      setYear(next.year);
      s.setNotice("Season added to your rotation.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(id: string) {
    if (editorFarmId !== s.farm()?.id || s.workspace.loading) return;
    try {
      await s.saveWorkspace({
        rotationPlans: s.workspace()!.rotationPlans.filter((r) => r.id !== id),
      });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function explore(p: Rotation, selectedProductId?: string) {
    const crop = s.crops()?.find((c) => c.cropId === p.cropId);
    if (!crop?.products[0] || !s.farm() || !p.plannedSowingDate) return;
    selectedProductId ??= p.productId;
    const capturedFarmId = s.farm()!.id;
    if (crop.products.length > 1 && !selectedProductId) {
      setProductSelection({ rotation: p, productId: "" });
      return;
    }
    setBusy(p.id);
    setError("");
    try {
      const plan = await createPlan({
        farmId: s.farm()!.id,
        cropId: p.cropId,
        productId: selectedProductId ?? crop.products[0].productId,
        plantingDate: p.plannedSowingDate,
        ...(s.farm()?.areaHectares ? { areaHa: s.farm()!.areaHectares! } : {}),
        ...(["rainfed", "supplemental", "irrigated"].includes(
          String(s.farm()!.facts.irrigation_category?.value),
        )
          ? {
              irrigationCategory: s.farm()!.facts.irrigation_category!.value as
                "rainfed" | "supplemental" | "irrigated",
            }
          : {}),
      });
      if (s.farm()?.id === capturedFarmId) {
        setProductSelection(null);
        navigate(`/farm/plan/${plan.data.snapshot.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const add = (season = "Kharif") => {
    editorFarmId = s.farm()?.id;
    setEditing({
      season,
      year: year(),
      plannedSowingDate: `${year()}-${season === "Kharif" ? "06-01" : season === "Rabi" ? "11-01" : "03-01"}`,
    });
    setError("");
  };
  return (
    <div class="workspace-page">
      <PageHeading
        eyebrow="THINK IN SEASONS"
        title="A plan for the years ahead."
        description="Connect your crop choices across seasons. Make room to rotate, rest, and adapt."
      >
        <A class="btn secondary" href="/explore">
          <Icon name="compare" size={17} />
          Compare crops
        </A>
        <button class="btn" disabled={!s.farm()} onClick={() => add()}>
          <Icon name="plus" size={17} />
          Add a season
        </button>
      </PageHeading>
      <Show
        when={s.farm()}
        fallback={
          <div class="empty-state">
            <Icon name="map" size={36} />
            <h2>Start with your land.</h2>
            <p>Map a farm first so your rotation has a home.</p>
            <A href="/farm" class="btn">
              Set up your farm
              <Icon name="arrow" size={17} />
            </A>
          </div>
        }
      >
        <div class="planner-context">
          <span class="farm-avatar">
            <Icon name="leaf" />
          </span>
          <div>
            <strong>{s.farm()?.name}</strong>
            <span>
              {s.farm()?.location.districtName} ·{" "}
              {s.farm()?.areaHectares?.toFixed(2) ?? "—"} ha
            </span>
          </div>
          <div class="context-history">
            <Icon name="history" size={17} />
            <Show
              when={s.workspace()?.previousHarvest.status === "known"}
              fallback={
                <span>
                  {s.workspace()?.previousHarvest.status === "none"
                    ? "First season · no harvest history"
                    : "Harvest history not added"}
                </span>
              }
            >
              {(() => {
                const h = s.workspace()?.previousHarvest;
                return h?.status === "known" ? (
                  <span>
                    Last harvest:{" "}
                    <strong>{h.cropName ?? s.cropName(h.cropId)}</strong> ·{" "}
                    {dateLabel(h.harvestDate)}
                  </span>
                ) : null;
              })()}
            </Show>
            <button class="text-button" onClick={() => setHistory(true)}>
              Edit
            </button>
          </div>
        </div>
        <section class="rotation-board">
          <div class="section-heading">
            <div>
              <Icon name="calendar" />
              <h2>Crop rotation</h2>
              <span class="tiny-pill">Your planning choices</span>
            </div>
            <div class="year-switch">
              <button
                aria-label="Previous year"
                onClick={() => setYear(year() - 1)}
              >
                ‹
              </button>
              <strong>{year()}</strong>
              <button
                aria-label="Next year"
                onClick={() => setYear(year() + 1)}
              >
                ›
              </button>
            </div>
          </div>
          <div class="rotation-table">
            <div class="rotation-months">
              <div>SEASON / CROP</div>
              <For each={MONTHS}>{(m) => <span>{m}</span>}</For>
            </div>
            <Show
              when={rows().length}
              fallback={
                <div class="rotation-starter">
                  <div class="starter-art">
                    <Icon name="leaf" size={38} />
                    <span />
                    <span />
                    <span />
                  </div>
                  <h3>Your next chapter is unwritten.</h3>
                  <p>
                    Add a crop for any season in {year()}, then explore how it
                    might grow.
                  </p>
                  <button class="btn" onClick={() => add()}>
                    Plan your first season <Icon name="plus" size={17} />
                  </button>
                </div>
              }
            >
              <For each={rows()}>
                {(p, i) => {
                  const start = () =>
                    p.plannedSowingDate
                      ? Math.max(0, Number(p.plannedSowingDate.slice(5, 7)) - 1)
                      : 0;
                  const end = () =>
                    p.plannedHarvestDate
                      ? Number(p.plannedHarvestDate.slice(0, 4)) > year()
                        ? 12
                        : Number(p.plannedHarvestDate.slice(5, 7))
                      : Math.min(start() + 2, 12);
                  return (
                    <div class="rotation-row">
                      <button
                        class="rotation-crop"
                        onClick={() => {
                          editorFarmId = s.farm()?.id;
                          setEditing(p);
                          setError("");
                        }}
                      >
                        <span class={`crop-dot tone-${i() % 4}`} />
                        <span>
                          <strong>{p.cropName ?? s.cropName(p.cropId)}</strong>
                          <small>{p.season} · Planned</small>
                        </span>
                      </button>
                      <div class="rotation-track">
                        <div class="track-grid">
                          <For each={MONTHS}>{() => <span />}</For>
                        </div>
                        <button
                          class={`rotation-bar tone-${i() % 4}`}
                          style={{
                            left: `${(start() / 12) * 100}%`,
                            width: `${(Math.max(1, end() - start()) / 12) * 100}%`,
                          }}
                          onClick={() => {
                            editorFarmId = s.farm()?.id;
                            setEditing(p);
                            setError("");
                          }}
                        >
                          <Icon name="leaf" size={14} />
                          <span>{p.cropName ?? s.cropName(p.cropId)}</span>
                        </button>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
            <div class="rotation-add">
              <button onClick={() => add()}>
                <Icon name="plus" size={16} /> Add a crop or cover season
              </button>
              <span>
                Bars show saved dates. An open-ended bar means the harvest date
                is unknown.
              </span>
            </div>
          </div>
          <div class="rotation-legend">
            <span>
              <i class="legend-dot green" />
              Planned crop
            </span>
            <span>
              <i class="legend-dot gold" />
              Planned cover / alternate crop
            </span>
            <span>Rotation suitability has not been assessed.</span>
          </div>
        </section>
        <div class="planner-lower">
          <section class="season-list">
            <div class="section-heading">
              <h2>Season plans</h2>
              <span class="subtle-caption">{rows().length} PLANNED</span>
            </div>
            <Show
              when={rows().length}
              fallback={
                <div class="small-empty">
                  <Icon name="calendar" />
                  <p>
                    Each planned season will appear here with a path into its
                    growth timeline.
                  </p>
                </div>
              }
            >
              <For each={rows()}>
                {(p) => (
                  <article class="season-row">
                    <span class="season-row-icon">
                      <Icon name="leaf" size={22} />
                    </span>
                    <div>
                      <h3>{p.cropName ?? s.cropName(p.cropId)}</h3>
                      <p>
                        {p.season}
                        {p.productName ? ` · ${p.productName}` : ""} · Sow{" "}
                        {p.plannedSowingDate
                          ? dateLabel(p.plannedSowingDate)
                          : "date not set"}
                        {p.plannedHarvestDate
                          ? ` → ${dateLabel(p.plannedHarvestDate)}`
                          : ""}
                      </p>
                    </div>
                    <Show
                      when={
                        p.cropId === "ginger" || p.cropId === "synthetic-ginger"
                      }
                      fallback={
                        <div class="season-model-status">
                          <button
                            class="text-link"
                            onClick={() => {
                              editorFarmId = s.farm()?.id;
                              setEditing(p);
                              setError("");
                            }}
                          >
                            Edit season
                            <Icon name="arrow" size={17} />
                          </button>
                          <small>Detailed stage model unavailable</small>
                        </div>
                      }
                    >
                      <button
                        class="text-link"
                        disabled={!!busy()}
                        onClick={() => void explore(p)}
                      >
                        {busy() === p.id
                          ? "Building timeline…"
                          : "View growth model"}
                        <Icon name="arrow" size={17} />
                      </button>
                    </Show>
                  </article>
                )}
              </For>
            </Show>
          </section>
          <aside class="rotation-note">
            <Icon name="leaf" size={28} />
            <p class="eyebrow">LEAVE ROOM FOR THE LAND</p>
            <h3>A rotation is more than a calendar.</h3>
            <p>
              Consider crop family, water access, and the time between harvest
              and sowing. Compare sourced crop requirements before committing.
            </p>
            <A href="/explore" class="text-link">
              Compare your options
              <Icon name="arrow" size={17} />
            </A>
            <div class="note-divider" />
            <strong>Soil conditions</strong>
            <p>
              A crop sequence alone cannot establish soil health. Keep dated
              laboratory measurements with their units, methods and source
              reports.
            </p>
            <A href="/farm/settings" class="text-link">
              Review soil markers
              <Icon name="arrow" size={15} />
            </A>
          </aside>
        </div>
      </Show>
      <Show when={error() && !editing()}>
        <p class="inline-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={productSelection()}>
        {(choice) => (
          <div class="modal-backdrop">
            <section
              class="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="product-title"
            >
              <button
                class="modal-close icon-button"
                aria-label="Close product choice"
                onClick={() => setProductSelection(null)}
              >
                <Icon name="close" />
              </button>
              <p class="eyebrow">ONE CROP, DIFFERENT PATHS</p>
              <h2 id="product-title">Which product are you planning?</h2>
              <p class="muted">
                Harvest timing and source requirements can differ by product.
                Choose how you intend to harvest or sell this crop.
              </p>
              <label>
                Crop product
                <select
                  value={choice().productId}
                  onChange={(e) =>
                    setProductSelection({
                      ...choice(),
                      productId: e.currentTarget.value,
                    })
                  }
                >
                  <option value="">Choose a product</option>
                  <For
                    each={
                      s
                        .crops()
                        ?.find((c) => c.cropId === choice().rotation.cropId)
                        ?.products ?? []
                    }
                  >
                    {(p) => <option value={p.productId}>{p.name}</option>}
                  </For>
                </select>
              </label>
              <button
                class="btn full-width"
                disabled={!choice().productId || !!busy()}
                onClick={() =>
                  void explore(choice().rotation, choice().productId)
                }
              >
                {busy() ? "Building timeline…" : "Explore this product"}
                <Icon name="arrow" size={17} />
              </button>
              <Show when={error()}>
                <p class="inline-error" role="alert">
                  {error()}
                </p>
              </Show>
            </section>
          </div>
        )}
      </Show>
      <Show when={history()}>
        <HistoryDialog onClose={() => setHistory(false)} />
      </Show>
      <Show when={editing()}>
        <div class="modal-backdrop">
          <section
            class="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rotation-title"
          >
            <button
              class="modal-close icon-button"
              onClick={() => setEditing(null)}
              aria-label="Close season editor"
            >
              <Icon name="close" />
            </button>
            <p class="eyebrow">BUILD YOUR ROTATION</p>
            <h2 id="rotation-title">
              {editing()?.id ? "Edit your season" : "What's growing next?"}
            </h2>
            <p class="muted">
              These are your planning dates. Explore the season afterward to see
              sourced stage windows.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                Crop
                <select
                  value={editing()?.cropId ?? ""}
                  onChange={(e) => update({ cropId: e.currentTarget.value })}
                  required
                >
                  <option value="">Select a crop</option>
                  <For each={s.crops() ?? []}>
                    {(c) => <option value={c.cropId}>{c.name}</option>}
                  </For>
                </select>
              </label>
              <Show
                when={
                  s.crops()?.find((c) => c.cropId === editing()?.cropId)
                    ?.products.length
                }
              >
                <label>
                  Product <small>optional for rotation planning</small>
                  <select
                    value={editing()?.productId ?? ""}
                    onChange={(e) => {
                      const product = s
                        .crops()
                        ?.find((c) => c.cropId === editing()?.cropId)
                        ?.products.find(
                          (p) => p.productId === e.currentTarget.value,
                        );
                      update({
                        productId: product?.productId ?? "",
                        productName: product?.name ?? "",
                      });
                    }}
                  >
                    <option value="">Not chosen yet</option>
                    <For
                      each={
                        s.crops()?.find((c) => c.cropId === editing()?.cropId)
                          ?.products ?? []
                      }
                    >
                      {(p) => <option value={p.productId}>{p.name}</option>}
                    </For>
                  </select>
                </label>
              </Show>
              <label>
                Season
                <select
                  value={editing()?.season ?? "Kharif"}
                  onChange={(e) => update({ season: e.currentTarget.value })}
                >
                  <option>Kharif</option>
                  <option>Rabi</option>
                  <option>Zaid</option>
                  <option>Perennial / year-round</option>
                  <option>Cover crop / green manure</option>
                  <option>Other</option>
                </select>
              </label>
              <div class="form-grid">
                <label>
                  Planned sowing
                  <input
                    type="date"
                    value={editing()?.plannedSowingDate ?? today()}
                    onInput={(e) =>
                      update({ plannedSowingDate: e.currentTarget.value })
                    }
                    required
                  />
                </label>
                <label>
                  Planned harvest <small>optional</small>
                  <input
                    type="date"
                    min={editing()?.plannedSowingDate}
                    value={editing()?.plannedHarvestDate ?? ""}
                    onInput={(e) =>
                      update(
                        e.currentTarget.value
                          ? { plannedHarvestDate: e.currentTarget.value }
                          : { plannedHarvestDate: "" },
                      )
                    }
                  />
                </label>
              </div>
              <label>
                Notes <small>optional</small>
                <textarea
                  rows="2"
                  value={editing()?.notes ?? ""}
                  placeholder="Rotation ideas, water needs, or a rest period…"
                  onInput={(e) => update({ notes: e.currentTarget.value })}
                />
              </label>
              <Show when={error()}>
                <p class="inline-error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="modal-actions">
                <Show when={editing()?.id}>
                  <button
                    class="text-button danger"
                    type="button"
                    onClick={() => void remove(editing()!.id!)}
                  >
                    Remove season
                  </button>
                </Show>
                <button class="btn" type="submit" disabled={s.saving()}>
                  {s.saving() ? "Saving…" : "Save season"}
                  <Icon name="check" size={17} />
                </button>
              </div>
            </form>
          </section>
        </div>
      </Show>
    </div>
  );
}
