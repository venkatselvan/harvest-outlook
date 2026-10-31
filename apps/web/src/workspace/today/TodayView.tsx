import { For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { useWorkspace, dateLabel } from "../state";
import { FarmMap } from "../FarmMap";
import { FieldGrowthScene } from "../FieldGrowthScene";
import { CurrentQuote } from "../CurrentQuote";
import { Icon } from "../icons";
import { Evara } from "../Evara";
import type { FarmCommandCenter as CommandData } from "@harvest/contracts";
import type { TodayViewProps } from "./types";

// `words` and `SourceLinks` are copies of the shell's helpers (the shell keeps its own for the Soil & crop fit tab).
// They are duplicated, not imported, so this file does not import from FarmCommandCenter.tsx (circular import).
const words = (value: string) =>
  value.replace(/_/g, " ").replace(/^\w/, (s) => s.toUpperCase());

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

export function TodayView(props: TodayViewProps) {
  const s = useWorkspace();
  const navigate = useNavigate();
  // Every prop is a stable accessor or callback owned by the shell, so destructuring keeps the markup below unchanged.
  const {
    data,
    resource,
    workspace,
    cycles,
    active,
    tasks,
    dueCount,
    scene,
    setScene,
    allCare,
    setAllCare,
    careBusy,
    setCycleId,
    complete,
    openPlant,
    showTool,
  } = props;
  // Today-only derivations, moved here from the shell unchanged.
  const crop = () =>
    data()?.focusedCrops.find((crop) => crop.cropId === active()?.cycle.cropId);
  const weather = () => data()?.weather;
  const day = () => weather()?.days[0];
  const markers = () =>
    data()?.soil.markers.samples.flatMap((sample) => sample.markers) ?? [];
  const activeQuote = () =>
    data()?.currentQuotes.products.find(
      (quote) => quote.productId === active()?.cycle.productId,
    );
  const activeFit = () =>
    data()?.soil.fit.find((fit) => fit.cropId === active()?.cycle.cropId);
  const askCare = () =>
    window.dispatchEvent(
      new CustomEvent("ho:ask", {
        detail: {
          text: "Review my current crop, confirmed soil report and upcoming source-based care. Explain what needs attention, and keep forecasts separate from observations.",
        },
      }),
    );

  return (
    <div class="farm-today-grid">
      <section class="command-field-stage" aria-label="Your field">
        <div class="field-stage-toolbar">
          <div
            class="field-view-switch"
            role="group"
            aria-label="Field view"
          >
            <button
              aria-pressed={scene() === "growth"}
              classList={{ active: scene() === "growth" }}
              onClick={() => setScene("growth")}
            >
              <Icon name="leaf" size={15} /> Growth model
            </button>
            <button
              aria-pressed={scene() === "satellite"}
              classList={{ active: scene() === "satellite" }}
              onClick={() => setScene("satellite")}
            >
              <Icon name="map" size={15} /> Satellite
            </button>
          </div>
          <Show when={active()}>
            <span class="stage-crop-label">
              <span class="status-dot" />
              {active()!.cycle.cropName ??
                crop()?.displayName ??
                s.cropName(active()!.cycle.cropId)}
            </span>
          </Show>
        </div>
        <div class="field-stage-canvas">
          <Show
            when={workspace()}
            fallback={
              <div class="command-loading" role="status">
                {s.workspace.loading || resource.loading
                  ? "Loading your saved field boundary…"
                  : "Your field boundary could not load. Retry farm context."}
              </div>
            }
          >
            <Show
              when={scene() === "growth"}
              fallback={
                <FarmMap
                  boundary={workspace()?.boundary ?? null}
                  editing={false}
                  onBoundary={() => {}}
                  farmName={s.farm()?.name ?? "Your farm"}
                  onEdit={() => navigate("/farm/manage")}
                />
              }
            >
              <FieldGrowthScene
                cropId={active()?.cycle.cropId ?? null}
                cropName={
                  crop()?.displayName ?? active()?.cycle.cropName ?? null
                }
                stage={active()?.cycle.stage ?? null}
                boundary={workspace()?.boundary ?? null}
                plantingDate={active()?.cycle.sowingDate ?? null}
                harvestDate={active()?.cycle.harvestDate ?? null}
                onPlant={() => openPlant()}
              />
            </Show>
          </Show>
        </div>
        <div class="field-stage-footer">
          <span>
            <Icon name="target" size={14} />
            {workspace()?.boundary
              ? "Your saved field outline"
              : workspace()
                ? "Boundary not mapped"
                : "Boundary not loaded"}
          </span>
          <A href="/farm/manage">
            Edit boundary <Icon name="arrow" size={13} />
          </A>
        </div>
      </section>
      <aside class="farm-live-inspector">
        <section class="command-panel crop-status-panel">
          <div class="command-panel-heading">
            <h2>Growing now</h2>
            <span class="tiny-pill">Recorded</span>
          </div>
          <Show
            when={active()}
            fallback={
              <div class="command-empty-crop">
                <Icon name="leaf" size={28} />
                <h3>No crop recorded yet</h3>
                <p>
                  Record what you planted and when. Care dates will use that
                  event and available sources.
                </p>
                <button
                  class="text-button"
                  onClick={() => openPlant()}
                  disabled={!data()}
                >
                  Plant your first crop <Icon name="arrow" size={15} />
                </button>
              </div>
            }
          >
            <Show when={cycles().length > 1}>
              <label class="command-sr-label">
                Current crop
                <select
                  aria-label="Current crop"
                  value={active()?.cycle.id}
                  onChange={(e) => setCycleId(e.currentTarget.value)}
                >
                  <For each={cycles()}>
                    {(entry) => (
                      <option value={entry.cycle.id}>
                        {entry.cycle.cropName ??
                          s.cropName(entry.cycle.cropId)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <div class="current-crop-name">
              <span class="crop-status-glyph">
                <Icon name="leaf" size={27} />
              </span>
              <div>
                <h3>
                  {crop()?.displayName ??
                    active()?.cycle.cropName ??
                    "Crop"}
                </h3>
                <p>{words(active()?.cycle.stage ?? "")}</p>
              </div>
            </div>
            <dl class="crop-anchor-list">
              <div>
                <dt>
                  {words(active()?.cycle.establishmentMethod ?? "sowed")}
                </dt>
                <dd>
                  {active()?.cycle.sowingDate
                    ? dateLabel(active()!.cycle.sowingDate)
                    : "Date unknown"}
                </dd>
              </div>
              <div>
                <dt>Care needing attention</dt>
                <dd>
                  {data() ? dueCount() : "—"}{" "}
                  <small>source-scheduled</small>
                </dd>
              </div>
            </dl>
            <Show when={active()?.limitations.length}>
              <details class="command-source-details">
                <summary>Care evidence & gaps</summary>
                <For each={active()?.limitations}>
                  {(line) => <p>{line}</p>}
                </For>
              </details>
            </Show>
          </Show>
        </section>
        <section class="command-panel command-weather">
          <div class="command-panel-heading">
            <h2>Field weather</h2>
            <span class="tiny-pill">
              {weather()?.status === "stale"
                ? "Stale forecast"
                : "Forecast"}
            </span>
          </div>
          <div class="command-weather-reading">
            <Icon
              name={(day()?.rainMm ?? 0) > 1 ? "rain" : "sun"}
              size={34}
            />
            <strong>
              {day()?.tMaxC != null ? `${day()!.tMaxC}°` : "—"}
            </strong>
            <div>
              <span>
                {day()?.date
                  ? dateLabel(day()!.date)
                  : "No forecast available"}
              </span>
              <small>
                {day()?.tMinC != null
                  ? `${day()!.tMinC}° low`
                  : "Temperature unknown"}
              </small>
            </div>
          </div>
          <div class="weather-rain-line">
            <Icon name="rain" size={15} />
            <span>
              {day()?.rainMm != null
                ? `${day()!.rainMm} mm rain forecast`
                : "Rain forecast unavailable"}
            </span>
          </div>
          <A href="/farm?tab=harvest" class="text-link">
            Weather & market detail <Icon name="arrow" size={14} />
          </A>
          <Show when={weather()?.issuedAt}>
            <small class="command-issued">
              Issued{" "}
              {new Date(weather()!.issuedAt!).toLocaleString("en-IN", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              · {weather()?.source}
            </small>
          </Show>
        </section>
        <section class="command-panel command-soil-glance">
          <div class="command-panel-heading">
            <h2>Soil evidence</h2>
            <button
              class="text-button"
              onClick={() => showTool("soil")}
              aria-label="Open soil reports"
            >
              <Icon name="arrow" size={15} />
            </button>
          </div>
          <div class="soil-reading-count">
            <strong>{markers().length || "—"}</strong>
            <span>
              {markers().length
                ? "confirmed lab readings"
                : data()
                  ? "No confirmed field readings"
                  : "Lab readings not loaded"}
            </span>
          </div>
          <p>
            {activeFit()?.summary ??
              "Upload a laboratory report to check compatible measurements against published crop requirements."}
          </p>
          <button
            class="text-button"
            onClick={() => navigate("/farm?tab=soil")}
          >
            Review soil & crop fit <Icon name="arrow" size={14} />
          </button>
        </section>
        <Show when={activeQuote()}>
          {(quote) => (
            <section class="command-panel command-market-glance">
              <div class="command-panel-heading">
                <h2>Latest market quote</h2>
                <span class="tiny-pill">Dated observation</span>
              </div>
              <CurrentQuote
                product={quote()}
                name={crop()?.displayName ?? "Current crop"}
                compact
              />
            </section>
          )}
        </Show>
      </aside>
      <section class="command-care-strip" aria-label="Crop care schedule">
        <div class="care-strip-title">
          <div>
            <span class="eyebrow">FROM YOUR CROP & DATE</span>
            <h2>Next in the field</h2>
          </div>
          <div class="care-strip-actions">
            <Show when={tasks().length > 3}>
              <button
                class="text-button"
                onClick={() => setAllCare(!allCare())}
                aria-expanded={allCare()}
              >
                {allCare()
                  ? "Show next actions"
                  : `All ${tasks().length} care actions`}
              </button>
            </Show>
            <button class="text-button" onClick={askCare}>
              <Evara size={20} /> Ask Evara
            </button>
          </div>
        </div>
        <div class="command-care-cards" classList={{ expanded: allCare() }}>
          <Show
            when={tasks().length}
            fallback={
              <div class="care-empty">
                <Icon name="calendar" size={24} />
                <p>
                  {active()
                    ? "No source-scheduled task is available for this crop and establishment method. Record your own observations in Activity."
                    : "Care appears here after you record a crop and establishment date."}
                </p>
                <A href="/farm?tab=activity" class="text-link">
                  Open activity <Icon name="arrow" size={14} />
                </A>
              </div>
            }
          >
            <For each={allCare() ? tasks() : tasks().slice(0, 3)}>
              {(task) => (
                <article class={`command-care-card ${task.status}`}>
                  <div class="care-task-title">
                    <span class="care-status-dot" />
                    <h3>{task.title}</h3>
                    <small>{words(task.status)}</small>
                  </div>
                  <p>
                    {task.dueFrom === task.dueTo
                      ? dateLabel(task.dueFrom)
                      : `${dateLabel(task.dueFrom)} – ${dateLabel(task.dueTo)}`}
                  </p>
                  <details>
                    <summary>Action & source</summary>
                    <p>{task.action}</p>
                    <For each={task.conditions}>
                      {(condition) => <p>{condition}</p>}
                    </For>
                    <SourceLinks refs={task.sourceRefs} data={data()} />
                  </details>
                  <button
                    class="text-button"
                    disabled={!!careBusy()}
                    onClick={() => void complete(task)}
                  >
                    {careBusy() === task.id ? "Saving…" : "Done today"}
                    <Icon name="check" size={14} />
                  </button>
                </article>
              )}
            </For>
          </Show>
        </div>
        <Show when={active()?.stageGuidance?.length}>
          <details class="stage-guidance-panel">
            <summary>
              Stage-dependent guidance · observation required (
              {active()?.stageGuidance?.length})
            </summary>
            <For each={active()?.stageGuidance}>
              {(guidance) => (
                <article>
                  <h3>{guidance.title}</h3>
                  <p>{guidance.action}</p>
                  <Show
                    when={
                      guidance.applicability &&
                      guidance.applicability !== "matched"
                    }
                  >
                    <p class="source-applicability-note">
                      {guidance.applicability === "outside_source_region"
                        ? "This source covers another region. Confirm local applicability before acting."
                        : "The field location has not been matched to this source region. Confirm local applicability before acting."}
                    </p>
                  </Show>
                  <Show when={guidance.stage}>
                    <span class="tiny-pill">{words(guidance.stage!)}</span>
                  </Show>
                  <For each={guidance.conditions}>
                    {(condition) => <p>{condition}</p>}
                  </For>
                  <SourceLinks refs={guidance.sourceRefs} data={data()} />
                  <p class="muted">
                    No date has been assigned. Check the actual crop stage
                    before acting.
                  </p>
                </article>
              )}
            </For>
          </details>
        </Show>
        <Show when={active()?.referenceGuidance?.length}>
          <details class="stage-guidance-panel">
            <summary>
              Other-region care references (
              {active()?.referenceGuidance?.length})
            </summary>
            <p class="source-applicability-note">
              These references have no scheduled field dates. Confirm local
              applicability with an agronomist before acting.
            </p>
            <For each={active()?.referenceGuidance}>
              {(guidance) => (
                <article>
                  <h3>{guidance.title}</h3>
                  <p>{guidance.action}</p>
                  <p>{guidance.reason}</p>
                  <For each={guidance.conditions}>
                    {(condition) => <p>{condition}</p>}
                  </For>
                  <SourceLinks refs={guidance.sourceRefs} data={data()} />
                </article>
              )}
            </For>
          </details>
        </Show>
      </section>
    </div>
  );
}
