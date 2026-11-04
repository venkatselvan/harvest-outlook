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
import { useWorkspace, today, dateLabel, type Rotation as WorkspaceRotation } from "./state";
import { HistoryDialog, PageHeading } from "./FarmPage";
import { createPlan } from "../lib/plan-api";
import { newEntryId } from "../features/photo-region/http";
import { SeasonPreviewSheet } from "./season/SeasonPreviewSheet";
import {
  addedSeasons,
  defaultYear,
  groupByYear,
  kindLabel,
  seasonTitle,
  yearHints,
} from "./season/seasonPreviewModel";
import { CHOOSE_FIELD_TO_ADD, isWholeFarmSeason, needsFieldForNewSeason, seasonFieldLabel, seasonsForField, seasonWithField } from "./year/PlanCalendar";
import "./season/season-preview.css";
import { recordedForField, cycleInYear, recordedBar, recordedStage } from './season/recordedRotation';
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
/**
 * The workspace state's Rotation predates round 3; the server's RotationPlan also carries `kind` and `companion`
 * (ROUND3_SPEC.md section 9), which pass through the state unchanged, so the Planner reads them with this widened type.
 */
type Rotation = WorkspaceRotation & {
  kind?: "crop" | "green_manure" | "intercrop";
  companion?: { systemId?: string; cropId: string; cropName?: string; productId?: string; productName?: string; rowRatio: string };
};
export function Planner(props: { fieldId?: string | null | undefined; fields?: readonly { id: string; name: string }[] | undefined } = {}) {
  const s = useWorkspace();
  // "All fields" on a farm with fields: listed seasons name their field and nothing can be added (see PlanCalendar).
  const chooseField = () => needsFieldForNewSeason((props.fields?.length ?? 0) > 0, props.fieldId);
  const fieldLabel = (p: Rotation) => seasonFieldLabel(p, props.fields, props.fieldId);
  const navigate = useNavigate();
  // A field's plan lists that field's seasons and legacy whole-farm seasons; "All fields" lists every season.
  const plans = (): Rotation[] => seasonsForField(s.workspace()?.rotationPlans ?? [], props.fieldId);
  const recorded = () => recordedForField(s.workspace()?.cycles ?? [], props.fieldId);
  const current = () => recorded().filter(c => c.stage !== 'harvested');
  // ROUND3_SPEC 2.1: open on the year of the earliest saved season sown on or after today (else this year) until the
  // farmer picks a year; the pick is kept per farm.
  const [picked, setPicked] = createSignal<{
    farmId: string | undefined;
    year: number;
  } | null>(null);
  const year = () => {
    const p = picked();
    return p && p.farmId === s.farm()?.id ? p.year : current().length ? Number(today().slice(0, 4)) : defaultYear(plans(), today());
  };
  const setYear = (y: number) => setPicked({ farmId: s.farm()?.id, year: y });
  const [preview, setPreview] = createSignal<Rotation | null>(null);
  const grouped = createMemo(() => groupByYear(plans()));
  const hints = createMemo(() => yearHints(plans(), year()));
  const title = (p: Rotation) => seasonTitle(p, s.cropName);
  const openEditor = (p: Rotation) => {
    editorFarmId = s.farm()?.id;
    setEditing(p);
    setError("");
  };
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
      plans()
        .filter((p) => p.year === year())
        .sort((a, b) =>
          (a.plannedSowingDate ?? "").localeCompare(b.plannedSowingDate ?? ""),
        ),
  );
  const recordedRows = createMemo(() => recorded().filter(c => cycleInYear(c, year())).sort((a,b) => a.sowingDate.localeCompare(b.sowingDate)));
  // A crop recorded through Plant crop should immediately be visible, even from a future-year plan.
  let knownCycles: {farmId: string | undefined; ids: Set<string>} | undefined;
  createEffect(on(() => [s.farm()?.id, s.workspace()?.cycles] as const, ([farmId, cycles]) => {
    if (!cycles) return;
    if (knownCycles?.farmId === farmId) {
      const added = cycles.find(c => !knownCycles!.ids.has(c.id) && c.stage !== 'harvested');
      if (added) setYear(Number((added.establishmentDate ?? added.sowingDate).slice(0, 4)));
    }
    knownCycles = {farmId, ids: new Set(cycles.map(c => c.id))};
  }));
  let editorFarmId: string | undefined;
  createEffect(
    on(
      () => s.farm()?.id,
      () => {
        setEditing(null);
        setProductSelection(null);
        setPreview(null);
        setError("");
      },
    ),
  );
  // ROUND3_SPEC 2.3: seasons added from elsewhere (a year-plan apply) move the board to the first added season's year
  // and the notice names it. The Planner's own saves set the year themselves.
  let seen: { farmId: string | undefined; ids: Set<string> } | null = null;
  let ownSave: string | null = null;
  createEffect(
    on(
      () => [s.farm()?.id, s.workspace()?.rotationPlans] as const,
      ([farmId, list]) => {
        if (!list) return;
        if (seen && seen.farmId === farmId) {
          const added = addedSeasons(seen.ids, list).filter((p) => p.id !== ownSave);
          const first = added[0];
          if (first) {
            setYear(first.year);
            s.setNotice(
              `${added.length === 1 ? "Saved" : `Saved ${added.length} seasons, first`} ${title(first)}${first.plannedSowingDate ? `, sown ${dateLabel(first.plannedSowingDate)}` : ""}. Showing ${first.year}.`,
            );
          }
        }
        ownSave = null;
        seen = { farmId, ids: new Set(list.map((p) => p.id)) };
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
        ...seasonWithField(cleaned, props.fieldId),
        id: p.id ?? newEntryId("rotation"),
        year: Number(p.plannedSowingDate.slice(0, 4)),
        cropName: s.cropName(p.cropId),
      } as Rotation;
      ownSave = next.id;
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
        <Show
          when={!chooseField()}
          fallback={
            <p class="subtle-caption" data-testid="planner-choose-field">
              {CHOOSE_FIELD_TO_ADD}
            </p>
          }
        >
          <button class="btn" disabled={!s.farm()} onClick={() => add()}>
            <Icon name="plus" size={17} />
            Add a season
          </button>
        </Show>
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
              <span class="tiny-pill">Recorded crops &amp; planned seasons</span>
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
          <Show when={hints().length}>
            <div class="planner-hints">
              <For each={hints()}>
                {(hint) => (
                  <button type="button" onClick={() => setYear(hint.year)}>
                    {hint.later
                      ? `${hint.count} more in ${hint.year} ›`
                      : `‹ ${hint.count} in ${hint.year}`}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="rotation-table">
            <div class="rotation-months">
              <div>SEASON / CROP</div>
              <For each={MONTHS}>{(m) => <span>{m}</span>}</For>
            </div>
            <Show
              when={rows().length || recordedRows().length}
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
                  <Show when={!chooseField()}>
                    <button class="btn" onClick={() => add()}>
                      Plan your first season <Icon name="plus" size={17} />
                    </button>
                  </Show>
                </div>
              }
            >
              <For each={recordedRows()}>{c => <div class="rotation-row recorded-crop" data-testid="rotation-recorded-crop">
                <div class="rotation-crop">
                  <span class="crop-dot tone-1"/>
                  <span><strong>{c.cropName ?? s.cropName(c.cropId)}{c.companion ? ` + ${c.companion.cropName ?? s.cropName(c.companion.cropId)}` : ''}</strong>
                    <small>{recordedStage(c)} · {c.fieldId ? props.fields?.find(f => f.id === c.fieldId)?.name ?? 'Field' : 'Whole farm'}</small>
                    <small>Sown {dateLabel(c.establishmentDate ?? c.sowingDate)}</small>
                  </span>
                </div>
                <div class="rotation-track">
                  <div class="track-grid"><For each={MONTHS}>{() => <span/>}</For></div>
                  <div class="rotation-bar tone-1 recorded-bar" classList={{'open-ended': !c.harvestDate}} style={{left: `${recordedBar(c, year()).left}%`, width: `${recordedBar(c, year()).width}%`}} title={c.harvestDate ? `Harvest: ${dateLabel(c.harvestDate)}` : 'Harvest date not recorded'}>
                    <Icon name="leaf" size={14}/><span>{c.cropName ?? s.cropName(c.cropId)} · {recordedStage(c)}</span>
                  </div>
                </div>
              </div>}</For>
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
                          <strong>{title(p)}</strong>
                          <small>
                            {p.season} · {kindLabel(p)}
                          </small>
                        </span>
                      </button>
                      <div class="rotation-track">
                        <div class="track-grid">
                          <For each={MONTHS}>{() => <span />}</For>
                        </div>
                        <button
                          class={`rotation-bar tone-${p.kind === "green_manure" ? 2 : i() % 4} kind-${p.kind ?? "crop"}`}
                          style={{
                            left: `${(start() / 12) * 100}%`,
                            width: `${(Math.max(1, end() - start()) / 12) * 100}%`,
                          }}
                          aria-label={`Preview season: ${title(p)}`}
                          title="Preview season"
                          disabled={!p.plannedSowingDate}
                          onClick={() => setPreview(p)}
                        >
                          <Icon name="leaf" size={14} />
                          <span>
                            {title(p)}
                            {p.kind === "green_manure" ? " · Green manure" : ""}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
            <div class="rotation-add">
              <Show
                when={!chooseField()}
                fallback={<strong data-testid="planner-choose-field">{CHOOSE_FIELD_TO_ADD}</strong>}
              >
                <button onClick={() => add()}>
                  <Icon name="plus" size={16} /> Add a crop or cover season
                </button>
              </Show>
              <span>
                Bars show saved dates. An open-ended bar means the harvest date
                is unknown.
              </span>
            </div>
          </div>
          <div class="rotation-legend">
            <span><i class="legend-dot"/>Recorded crop</span>
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
              <span class="subtle-caption">{plans().length} PLANNED</span>
            </div>
            <Show
              when={plans().length}
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
              <For each={grouped()}>
                {(group) => (
                  <div class="season-year-group">
                    <h3 class="season-year">{group.year}</h3>
                    <For each={group.plans}>
                      {(p) => (
                        <article class="season-row">
                          <span class="season-row-icon">
                            <Icon name="leaf" size={22} />
                          </span>
                          <div>
                            <h3>{title(p)}</h3>
                            <p>
                              {p.season}
                              {p.kind === "green_manure"
                                ? " · Green manure"
                                : p.kind === "intercrop"
                                  ? " · Intercrop"
                                  : ""}
                              {isWholeFarmSeason(p, props.fieldId) ? " · Whole farm" : ""}
                              {fieldLabel(p) ? ` · ${fieldLabel(p)}` : ""}
                              {p.productName ? ` · ${p.productName}` : ""} · Sow{" "}
                              {p.plannedSowingDate
                                ? dateLabel(p.plannedSowingDate)
                                : "date not set"}
                              {p.plannedHarvestDate
                                ? ` → ${dateLabel(p.plannedHarvestDate)}`
                                : ""}
                            </p>
                          </div>
                          <div class="season-model-status">
                            <div class="season-row-actions">
                              <button
                                class="text-link"
                                disabled={!p.plannedSowingDate}
                                aria-label={`Preview season: ${title(p)}`}
                                onClick={() => setPreview(p)}
                              >
                                Preview
                                <Icon name="arrow" size={17} />
                              </button>
                              <button class="text-link" onClick={() => openEditor(p)}>
                                Edit season
                              </button>
                              <Show
                                when={
                                  p.cropId === "ginger" ||
                                  p.cropId === "synthetic-ginger"
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
                                </button>
                              </Show>
                            </div>
                          </div>
                        </article>
                      )}
                    </For>
                  </div>
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
      <Show when={s.farm() && preview()} keyed>
        {(p) => (
          <SeasonPreviewSheet
            farmId={s.farm()!.id}
            request={{ planId: p.id }}
            fieldId={p.fieldId}
            title={title(p)}
            onClose={() => setPreview(null)}
          />
        )}
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
