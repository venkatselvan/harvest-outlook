import { CommodityBrowser } from "./CommodityCatalogue";
import { CurrentQuote } from "./CurrentQuote";
import { CompareCards } from "./CompareCards";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { PageHeading } from "./FarmPage";
import { Icon } from "./icons";
import { useWorkspace, dateLabel, today } from "./state";
import { compareCrops } from "../lib/catalogue-api";
import type {
  CompareItem,
  ComparisonResult,
  Irrigation,
} from "../features/comparison/types";
import { EvidenceDetails } from "../features/comparison/EvidenceDetails";
import { newEntryId } from "../features/photo-region/http";
import { sourceReason, priceGapTitle } from "./reasons";
import { createPlan } from "../lib/plan-api";
import { loadYearPlan } from "./year/yearPlanApi";
import { preselectProducts } from "./compare-preselect";
import "../features/comparison/comparison.css";
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
const outcomeLabel = (v: string) =>
  (
    ({
      eligible: "Matches sourced rules",
      requires_review: "Needs review",
      unknown: "Evidence incomplete",
      ineligible: "Outside requirements",
      excluded_by_farmer: "Excluded",
    }) as Record<string, string>
  )[v] ?? v;
function dimension(item: CompareItem, key: "waterFit" | "timeToFirstIncome") {
  const d = item.dimensions[key];
  if (d.status !== "known") return "Not enough evidence";
  const v = d.value as {
    minDays?: number;
    maxDays?: number;
    fit?: string;
    waterNeedClass?: string;
  };
  return key === "timeToFirstIncome"
    ? `${v.minDays ?? "—"}–${v.maxDays ?? "—"} days`
    : ((
        {
          matches: "Matches water access",
          partial: "Partial match",
          mismatch: "Water access mismatch",
        } as Record<string, string>
      )[v.fit ?? ""] ??
        v.waterNeedClass ??
        "See source requirements");
}
export function CompareWorkspace(
  props: { focused?: boolean; cropIds?: string[] | undefined } = {},
) {
  const s = useWorkspace();
  const navigate = useNavigate();
  const [date, setDate] = createSignal(today());
  const [comparedDate, setComparedDate] = createSignal("");
  const [result, setResult] = createSignal<ComparisonResult | null>(null);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [planning, setPlanning] = createSignal("");
  const [error, setError] = createSignal("");
  const [details, setDetails] = createSignal<CompareItem | null>(null);
  const [manualProducts, setManualProducts] = createSignal(false);
  const [manualDate, setManualDate] = createSignal(false);
  let runId = 0;
  // Crops to pre-select: the current year plan's proposals, then the saved seasons. Reading the plan never starts a
  // new one, and a failed read just leaves the saved seasons.
  const [yearPlan] = createResource(
    () => {
      const id = s.farm()?.id;
      return id ? `${s.sessionEpoch()}|${id}` : undefined;
    },
    async (key) => {
      const id = key.slice(key.indexOf("|") + 1);
      try {
        return { farmId: id, review: await loadYearPlan(id) };
      } catch {
        return undefined;
      }
    },
  );
  const preferredProducts = () => {
    const plan = yearPlan();
    const w = s.workspace();
    return preselectProducts({
      yearPlan: plan && plan.farmId === s.farm()?.id ? plan.review : undefined,
      savedSeasons: w && w.farmId === s.farm()?.id ? w.rotationPlans : [],
      cropIds: props.focused ? props.cropIds : undefined,
    });
  };
  function persistSelection() {
    const id = s.farm()?.id;
    if (id)
      s.rememberCompareSelection(id, {
        productIds: selected(),
        date: date(),
        manualProducts: manualProducts(),
        manualDate: manualDate(),
      });
  }
  async function compare(plantingDate = date()) {
    const f = s.farm();
    if (!f?.location.stateCode) return;
    const capturedFarmId = f.id;
    const capturedDate = plantingDate;
    const epoch = s.sessionEpoch();
    const mine = ++runId;
    setBusy(true);
    setError("");
    try {
      const state = f.location.stateCode.startsWith("IN-")
        ? f.location.stateCode
        : `IN-${f.location.stateCode}`;
      const r = await compareCrops({
        location: {
          stateId: state,
          ...(f.location.districtId
            ? { districtId: f.location.districtId }
            : {}),
        },
        planting: {
          month: Number(capturedDate.slice(5, 7)),
          date: capturedDate,
        },
        irrigation: (f.facts.irrigation_category?.value ??
          "unknown") as Irrigation,
        ...(f.areaHectares
          ? { area: { amount: f.areaHectares, unit: "ha" as const } }
          : {}),
        excludedCropIds: [],
        assumedPrices: [],
      });
      if (
        s.farm()?.id !== capturedFarmId ||
        epoch !== s.sessionEpoch() ||
        mine !== runId
      )
        return;
      setResult(r.result);
      setComparedDate(capturedDate);
      const available = new Set(
        r.result.items
          .filter(
            (item) => !props.focused || props.cropIds?.includes(item.cropId),
          )
          .map((item) => item.productId),
      );
      const next = manualProducts()
        ? selected().filter((id) => available.has(id))
        : preferredProducts().filter((id) => available.has(id));
      setSelected(next);
      persistSelection();
    } catch (e) {
      if (
        s.farm()?.id === capturedFarmId &&
        epoch === s.sessionEpoch() &&
        mine === runId
      )
        setError((e as Error).message);
    } finally {
      if (mine === runId) setBusy(false);
    }
  }
  createEffect(
    on([() => s.farm()?.id, s.sessionEpoch], ([id]) => {
      runId++;
      setResult(null);
      setDetails(null);
      setBusy(false);
      setError("");
      const saved = id ? s.loadCompareSelection(id) : null;
      setSelected(saved?.productIds ?? []);
      setDate(saved?.date || today());
      setManualProducts(saved?.manualProducts ?? false);
      setManualDate(saved?.manualDate ?? false);
    }),
  );
  createEffect(
    on(
      () => [s.farm()?.id, s.workspace.loading] as const,
      () => {
        if (!s.farm() || s.workspace.loading) return;
        if (!result() || comparedDate() !== date()) void compare(date());
      },
    ),
  );
  createEffect(
    on(
      () =>
        [preferredProducts().join("|"), result()] as const,
      () => {
        if (manualProducts() || !result()) return;
        const available = new Set(
          result()!.items.map((item) => item.productId),
        );
        const next = preferredProducts().filter((id) => available.has(id));
        if (next.join("|") !== selected().join("|")) {
          setSelected(next);
          persistSelection();
        }
      },
    ),
  );
  const currentProduct = (id: string) =>
    s.currentMarket()?.products.find((product) => product.productId === id);
  createEffect(
    on(
      () => [s.farm()?.id, selected().join("|")] as const,
      () => {
        if (s.farm() && selected().length)
          void s.ensureCurrentMarket(selected());
      },
    ),
  );
  const items = () =>
    (result()?.items ?? []).filter(
      (item) => !props.focused || props.cropIds?.includes(item.cropId),
    );
  const choices = createMemo(() =>
    selected().flatMap((id) => {
      const item = items().find((i) => i.productId === id);
      return item ? [item] : [];
    }),
  );
  function toggle(i: CompareItem) {
    setManualProducts(true);
    if (selected().includes(i.productId))
      setSelected(selected().filter((x) => x !== i.productId));
    else if (selected().length < 3) setSelected([...selected(), i.productId]);
    else
      s.setNotice(
        "Compare up to three crop products. Remove one to add another.",
      );
    persistSelection();
  }
  async function choose(i: CompareItem) {
    if (!s.farm()) return;
    if (date() !== comparedDate()) {
      setError(
        "Refresh the comparison for your new sowing date before building a season plan.",
      );
      return;
    }
    const planFarmId = s.farm()!.id;
    setPlanning(i.productId);
    setError("");
    try {
      const p = await createPlan({
        farmId: s.farm()!.id,
        cropId: i.cropId,
        productId: i.productId,
        plantingDate: date(),
        ...(s.farm()?.areaHectares ? { areaHa: s.farm()!.areaHectares! } : {}),
      });
      if (s.farm()?.id === planFarmId)
        navigate(`/farm/plan/${p.data.snapshot.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning("");
    }
  }

  async function addToRotation(item: CompareItem) {
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    if (!farmId || !s.workspace() || s.workspace.loading) return;
    if (date() !== comparedDate()) {
      setError(
        "Refresh the comparison for your new sowing date before saving this choice.",
      );
      return;
    }
    setPlanning(item.productId);
    setError("");
    try {
      await s.saveWorkspace({
        rotationPlans: [
          ...s.workspace()!.rotationPlans,
          {
            id: newEntryId("rotation"),
            year: Number(date().slice(0, 4)),
            season: "Planned season",
            cropId: item.cropId,
            cropName: item.cropName,
            productId: item.productId,
            productName: item.productName,
            plannedSowingDate: date(),
          },
        ],
      });
      if (s.farm()?.id === farmId && s.sessionEpoch() === epoch) {
        s.setNotice(`${item.cropName} added to your rotation.`);
        navigate("/planner");
      }
    } catch (e) {
      if (s.farm()?.id === farmId && s.sessionEpoch() === epoch)
        setError((e as Error).message);
    } finally {
      setPlanning("");
    }
  }
  function reviewRotation() {
    window.dispatchEvent(
      new CustomEvent("ho:ask", {
        detail: {
          text: "Review my previous harvest and saved rotation, and help me compare the crop choices for the next season. Distinguish any sourced rotation evidence from assumptions and gaps.",
        },
      }),
    );
  }
  return (
    <div class="workspace-page">
      <PageHeading
        eyebrow="MAKE AN INFORMED CHOICE"
        title="Different crops. A clearer choice."
        description="Compare sourced requirements for your farm, then explore how each season could unfold."
      >
        <A href="/planner" class="btn secondary">
          Your rotation
          <Icon name="arrow" size={17} />
        </A>
      </PageHeading>
      <Show
        when={s.farm()}
        fallback={
          <div class="empty-state">
            <Icon name="map" size={36} />
            <h2>Your farm comes first.</h2>
            <p>
              Map your land before comparing crops for its location and water
              access.
            </p>
            <A class="btn" href="/farm">
              Set up your farm
              <Icon name="arrow" size={17} />
            </A>
          </div>
        }
      >
        <div class="comparison-history-context">
          <Icon name="history" size={19} />
          <div>
            <strong>
              {(() => {
                const h = s.workspace()?.previousHarvest;
                return h?.status === "known"
                  ? `Previous harvest: ${h.cropName ?? s.cropName(h.cropId)} · ${dateLabel(h.harvestDate)}`
                  : h?.status === "none"
                    ? "Your first season · no previous harvest"
                    : "Previous harvest not recorded";
              })()}
            </strong>
            <p>
              Screening checks your location, sowing date, and water access.
              Harvest history is not scored as rotation suitability.
            </p>
          </div>
          <button class="text-link" onClick={reviewRotation}>
            Review rotation with assistant
            <Icon name="chat" size={15} />
          </button>
        </div>
        <div class="compare-toolbar">
          <div class="compare-farm-context">
            <Icon name="pin" />
            <div>
              <strong>{s.farm()?.name}</strong>
              <span>
                {s.farm()?.location.districtName} ·{" "}
                {String(
                  s.farm()?.facts.irrigation_category?.value ??
                    "Water access unknown",
                )}
              </span>
            </div>
          </div>
          <label>
            Planned sowing
            <input
              type="date"
              value={date()}
              onInput={(e) => {
                setManualDate(true);
                setDate(e.currentTarget.value);
                persistSelection();
              }}
            />
          </label>
          <button
            class="btn"
            onClick={() => void compare()}
            disabled={busy() || s.workspace.loading}
          >
            {busy() ? "Comparing…" : "Refresh comparison"}
            <Icon name="compare" size={17} />
          </button>
        </div>
        <Show when={error()}>
          <p role="alert" class="inline-error">
            {error()}
          </p>
        </Show>
        <Show when={s.currentMarketError() && selected().length}>
          <p class="quote-provider-issue" role="status">
            Mandi quote request: {s.currentMarketError()}
          </p>
          <button
            class="text-button"
            disabled={s.currentMarketBusy()}
            onClick={() =>
              void s.refreshCurrentMarket(selected()).catch(() => {})
            }
          >
            Retry dated quotes
          </button>
        </Show>
        <Show when={result() && date() !== comparedDate()}>
          <div class="stale-comparison" role="status">
            <Icon name="clock" size={17} />
            <span>
              Your sowing date changed. These requirements were checked for{" "}
              {dateLabel(comparedDate())}.
            </span>
            <button
              class="text-button"
              onClick={() => void compare()}
              disabled={busy()}
            >
              Refresh comparison
            </button>
          </div>
        </Show>
        <div class="compare-layout">
          <Show
            when={props.focused}
            fallback={
              <CommodityBrowser
                items={items()}
                selected={selected()}
                onToggle={toggle}
              />
            }
          >
            <section
              class="crop-browser focused-comparison-browser"
              aria-label="Supported crops for comparison"
            >
              <div class="section-heading">
                <h2>Crop choices</h2>
                <span class="count-pill">
                  {new Set(items().map((item) => item.cropId)).size}
                </span>
              </div>
              <p class="section-description">
                Source-based requirements for the focused crop collection.
                Product forms stay separate.
              </p>
              <For each={items()}>
                {(item) => (
                  <button
                    class={`crop-option ${selected().includes(item.productId) ? "selected" : ""}`}
                    onClick={() => toggle(item)}
                  >
                    <span class="crop-mini-icon">
                      <Icon name="leaf" />
                    </span>
                    <span>
                      <strong>{item.cropName}</strong>
                      <small>{item.productName}</small>
                    </span>
                    <span class="crop-checkbox">
                      <Show when={selected().includes(item.productId)}>
                        <Icon name="check" size={14} />
                      </Show>
                    </span>
                  </button>
                )}
              </For>
              <Show when={!items().length}>
                <p class="small-empty">
                  Crop requirements will appear when the farm comparison is
                  ready.
                </p>
              </Show>
              <A href="/catalogue" class="text-link">
                Open reference library <Icon name="arrow" size={14} />
              </A>
            </section>
          </Show>
          <div class="comparison-main">
            <Show when={choices().length}>
              <CompareCards items={choices()} onRemove={toggle} onDetail={setDetails} />
            </Show>
            <section class="comparison-table-card">
              <div class="section-heading">
                <div>
                  <h2>Side by side</h2>
                  <span class="tiny-pill">
                    {choices().length} of 3 selected
                  </span>
                </div>
                <span class="subtle-caption">SOURCED REQUIREMENTS</span>
              </div>
              <Show
                when={choices().length}
                fallback={
                  <div class="small-empty">
                    <Icon name="compare" />
                    <p>
                      {busy()
                        ? "Checking crop requirements for your farm…"
                        : "Choose crops from the catalogue to build your comparison."}
                    </p>
                  </div>
                }
              >
                <Show when={comparedDate()}>
                  <div class="comparison-date-note">
                    <Icon name="calendar" size={15} />
                    <p>
                      Screening uses{" "}
                      <strong>{dateLabel(comparedDate())}</strong> for every
                      crop. Each suggested date is shown separately; check that
                      window to screen a different season.
                    </p>
                  </div>
                </Show>
                <div class="comparison-scroll">
                  <table class="comparison-table">
                    <thead>
                      <tr>
                        <th>FOR YOUR FARM</th>
                        <For each={choices()}>
                          {(i) => (
                            <th>
                              <button
                                class="remove-crop"
                                aria-label={`Remove ${i.cropName} from comparison`}
                                onClick={() => toggle(i)}
                              >
                                ×
                              </button>
                              <span class="comparison-crop-icon">
                                <Icon name="leaf" size={25} />
                              </span>
                              <h3>{i.cropName}</h3>
                              <small>{i.productName}</small>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th>Overall screening</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              <span class={`outcome-tag ${i.outcome}`}>
                                {outcomeLabel(i.outcome)}
                              </span>
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr>
                        <th>Planting window</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              {i.plantingWindow
                                ? `${MONTHS[i.plantingWindow.fromMonth - 1]} – ${MONTHS[i.plantingWindow.toMonth - 1]}`
                                : "No sourced window"}
                              <small>
                                {i.context?.plantingMonthInWindow
                                  ? "Your month is in this window"
                                  : i.plantingWindow
                                    ? "Check your chosen date"
                                    : "For this region"}
                              </small>
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr>
                        <th>Harvest timing</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              {i.dimensions.timeToFirstIncome.status === "known"
                                ? dimension(i, "timeToFirstIncome")
                                : "Not enough evidence"}
                              <small>Reference, not a prediction</small>
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr>
                        <th>Water access</th>
                        <For each={choices()}>
                          {(i) => <td>{dimension(i, "waterFit")}</td>}
                        </For>
                      </tr>
                      <tr>
                        <th>Harvest pattern</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              {i.repeatedPicking === true
                                ? "Repeated picking"
                                : i.repeatedPicking === false
                                  ? "Single harvest"
                                  : "Not established"}
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr>
                        <th>Latest dated mandi quote</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              <Show
                                when={currentProduct(i.productId)}
                                fallback={
                                  <Show
                                    when={
                                      i.priceReference.state ===
                                      "historical_reference"
                                    }
                                    fallback={
                                      <>
                                        <span>
                                          {s.currentMarketBusy()
                                            ? "Checking dated quote…"
                                            : priceGapTitle(
                                                i.priceReference.state ===
                                                  "unavailable"
                                                  ? i.priceReference
                                                      .missingReason
                                                  : undefined,
                                              )}
                                        </span>
                                        <small>
                                          {i.priceReference.state ===
                                          "unavailable"
                                            ? sourceReason(
                                                i.priceReference.missingReason,
                                              )
                                            : ""}
                                        </small>
                                      </>
                                    }
                                  >
                                    {(() => {
                                      const r = i.priceReference;
                                      return r.state ===
                                        "historical_reference" ? (
                                        <>
                                          <strong>
                                            ₹
                                            {Number(
                                              r.lastQuote.inrPerKg,
                                            ).toLocaleString("en-IN", {
                                              maximumFractionDigits: 2,
                                            })}{" "}
                                            / kg
                                          </strong>
                                          <small>
                                            {r.marketName} ·{" "}
                                            {dateLabel(r.lastQuote.date)}
                                          </small>
                                          <small>
                                            Historical quote · not a forecast
                                          </small>
                                        </>
                                      ) : null;
                                    })()}
                                  </Show>
                                }
                              >
                                {(product) => (
                                  <CurrentQuote product={product()} compact />
                                )}
                              </Show>
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr>
                        <th>Evidence coverage</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              {i.evidenceCoverage.evidenceRecords} evidence
                              records
                              <small>
                                {i.evidenceCoverage.validationPending
                                  ? "Validation pending"
                                  : "See sources for applicability"}
                              </small>
                              <button
                                class="text-button"
                                onClick={() => setDetails(i)}
                              >
                                Review sources ↗
                              </button>
                            </td>
                          )}
                        </For>
                      </tr>
                      <tr class="compare-actions-row">
                        <th>Sourced season details</th>
                        <For each={choices()}>
                          {(i) => (
                            <td>
                              <button
                                class="btn compact"
                                disabled={
                                  !!planning() ||
                                  date() !== comparedDate() ||
                                  s.workspace.loading
                                }
                                onClick={() => void addToRotation(i)}
                              >
                                {planning() === i.productId
                                  ? "Saving…"
                                  : "Add to rotation"}
                                <Icon name="plus" size={14} />
                              </button>
                              <Show
                                when={
                                  i.cropId === "ginger" ||
                                  i.cropId === "synthetic-ginger"
                                }
                                fallback={
                                  <small>
                                    Detailed stage model unavailable for this
                                    crop
                                  </small>
                                }
                              >
                                <button
                                  class="text-button detailed-model-button"
                                  disabled={
                                    !!planning() || date() !== comparedDate()
                                  }
                                  onClick={() => void choose(i)}
                                >
                                  Open detailed stage model
                                  <Icon name="arrow" size={13} />
                                </button>
                              </Show>
                            </td>
                          )}
                        </For>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Show>
              <div class="comparison-footnote">
                <Icon name="history" size={16} />
                <span>
                  Unknown evidence is kept visible. Historical market quotes are
                  available in your Outlook.
                </span>
              </div>
            </section>
          </div>
        </div>
      </Show>
      <Show when={details()}>
        {(i) => (
          <div class="modal-backdrop">
            <section
              class="modal-card evidence-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="evidence-title"
            >
              <button
                class="modal-close icon-button"
                aria-label="Close evidence"
                onClick={() => setDetails(null)}
              >
                <Icon name="close" />
              </button>
              <p class="eyebrow">EVIDENCE & OPEN CONDITIONS</p>
              <h2 id="evidence-title">
                {i().cropName} · {i().productName}
              </h2>
              <p class="muted">{outcomeLabel(i().outcome)}</p>
              <For each={i().screening.reasons}>
                {(r) => (
                  <div class="evidence-rule">
                    <strong>{r.effect.replace(/_/g, " ")}</strong>
                    <p>
                      {r.reasonCodes
                        .map((c) => c.replace(/_/g, " "))
                        .join(", ")}
                    </p>
                    <small>
                      {r.reviewStatus} · {r.evidenceIds.length} linked sources
                    </small>
                  </div>
                )}
              </For>
              <Show when={!i().screening.reasons.length}>
                <p>
                  No sourced rule applies to this location and season. This is a
                  gap in the evidence.
                </p>
              </Show>
              <EvidenceDetails item={i()} />
            </section>
          </div>
        )}
      </Show>
    </div>
  );
}
