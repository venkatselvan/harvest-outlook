import { For, Show, createMemo, type JSX } from "solid-js";
import type { EvidenceCitation } from "../comparison/types";
import type { HistoryItem, SeasonState } from "./controller";
import {
  BADGE_TEXT,
  fmtInr,
  fmtNum,
  formatDate,
  formatInstant,
  outlookView,
  taskRows,
  waterRows,
  modeQualifier,
  weatherView,
  type WaterIndex,
} from "./model";
import { capabilitiesState } from "../../lib/capabilities";
import type { TimelineDay } from "../../lib/plan-api";

export function Badge(props: { state: string; children?: JSX.Element }) {
  return (
    <span class="se-badge" data-state={props.state} data-testid={`badge-${props.state}`}>
      {props.children ?? BADGE_TEXT[props.state] ?? props.state}
    </span>
  );
}

/** Runtime mode from GET /capabilities (null until it has loaded or when it failed). */
function runtimeMode() {
  const c = capabilitiesState();
  return c.status === "ready" ? c.envelope.mode : null;
}

function Panel(props: { id: string; title: string; badge?: string; mode?: boolean; children: JSX.Element }) {
  const qualifier = () => (props.mode ? modeQualifier(runtimeMode()) : null);
  return (
    <section class="card se-panel" aria-labelledby={`${props.id}-h`} data-testid={`panel-${props.id}`}>
      <h2 id={`${props.id}-h`}>
        {props.title} <Show when={props.badge}>{(b) => <Badge state={b()} />}</Show>
        <Show when={qualifier()}>{(q) => <span class="se-badge" data-state="mode" data-testid="mode-qualifier">{q()}</span>}</Show>
      </h2>
      {props.children}
    </section>
  );
}

// ------------------------------------------------------------------ stage

export function StagePanel(props: { day: TimelineDay; stageNames: ReadonlyMap<string, string>; basisNote: string | null }) {
  const st = () => props.day.expectedStage;
  return (
    <Panel id="stage" title="Expected stage" badge="inferred">
      <Show when={st()} fallback={<p>No stage is expected on this date (before planting or after the season window).</p>}>
        {(s) => (
          <>
            <p data-testid="stage-name">
              <strong>{props.stageNames.get(s().stageId) ?? s().stageId}</strong>
            </p>
            <p>
              Expected window {formatDate(s().window.start)} to {formatDate(s().window.end)}. Inferred from planting date and sourced duration ranges; confirm with a dated photo.
            </p>
            <Show when={s().possibleStageIds.length > 1}>
              <p class="se-help">Could also be: {s().possibleStageIds.filter((x) => x !== s().stageId).map((x) => props.stageNames.get(x) ?? x).join(", ")} (uncertainty range).</p>
            </Show>
            <Show when={s().basis === "observed_stage_override"}>
              <p class="se-help">Re-anchored on a confirmed observation.</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.basisNote}>{(n) => <p class="se-help">{n()}</p>}</Show>
    </Panel>
  );
}

// ------------------------------------------------------------------ tasks

export function TasksPanel(props: {
  day: TimelineDay;
  tasksById: SeasonState["tasksById"];
  citations: SeasonState["citations"];
  skipped: { templateId: string; reason: string }[];
  canComplete: boolean;
}) {
  const rows = createMemo(() => taskRows(props.day, props.tasksById));
  const cite = (id: string): string => {
    const c = props.citations.byId.get(id);
    return c ? `${c.citation.publisher}, ${c.citation.documentTitle}${c.locator?.page !== undefined ? `, p.${c.locator.page}` : ""}` : id;
  };
  const group = (state: "overdue" | "due" | "done", title: string) => (
    <Show when={rows().filter((r) => r.state === state).length > 0}>
      <h3 class="se-h3">{title}</h3>
      <ul class="se-list" data-testid={`tasks-${state}`}>
        <For each={rows().filter((r) => r.state === state)}>
          {(r) => (
            <li class="se-task">
              <p>
                <strong>{r.description}</strong>
              </p>
              <Show when={r.window}><p class="se-help">Window: {r.window}</p></Show>
              <p class="se-help">Why: {r.reason}.</p>
              <Show when={r.trigger}><p class="se-help">{r.trigger}</p></Show>
              <Show when={r.flag}><p class="se-flag" role="note">{r.flag}</p></Show>
              <Show when={r.evidenceIds.length > 0} fallback={<p class="se-help">No source needed: this is an app action, not an agronomic claim.</p>}>
                <p class="se-help">
                  Source: <For each={r.evidenceIds}>{(id, i) => <span class="se-cite">{i() > 0 ? "; " : ""}{cite(id)}</span>}</For>
                </p>
              </Show>
              <Show when={r.state !== "done"}>
                <button type="button" class="btn secondary" disabled aria-describedby="se-complete-note">Mark done</button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
  return (
    <Panel id="tasks" title="Tasks" badge="derived">
      <Show when={rows().length > 0} fallback={<p data-testid="tasks-none">No tasks fall on this date.</p>}>
        {group("overdue", "Overdue")}
        {group("due", "Due now")}
        {group("done", "Done")}
      </Show>
      <Show when={!props.canComplete}>
        <p id="se-complete-note" class="se-help">Marking tasks done is not available yet. It arrives with the journal; nothing is saved from this screen.</p>
      </Show>
      <Show when={props.skipped.length > 0}>
        <p class="se-help">{props.skipped.length} task(s) are not in this plan: {[...new Set(props.skipped.map((s) => s.reason.replace(/_/g, " ")))].join("; ")}.</p>
      </Show>
    </Panel>
  );
}

// ------------------------------------------------------------------ weather

export function WeatherPanel(props: { day: TimelineDay }) {
  const w = createMemo(() => weatherView(props.day));
  return (
    <Panel mode id="weather" title="Weather and rain" badge={w().badge}>
      <p data-testid="weather-title" data-kind={w().kind}>
        <strong>{w().title}</strong>
      </p>
      <ul class="se-list" data-testid="weather-lines">
        <For each={w().lines}>{(l) => <li>{l}</li>}</For>
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ water

export function WaterPanel(props: { day: TimelineDay; runs: NonNullable<SeasonState["outputs"]["water"]>["byTiming"][keyof NonNullable<SeasonState["outputs"]["water"]>["byTiming"]] | undefined; index: WaterIndex | null; water: SeasonState["outputs"]["water"] | undefined }) {
  const rows = createMemo(() => (props.index ? waterRows(props.runs?.runs, props.index, props.day.calendarDate) : []));
  return (
    <Panel mode id="water" title="Water balance" badge={props.day.water.state === "unavailable" ? "unavailable" : props.day.water.state}>
      <Show
        when={props.day.water.state !== "unavailable"}
        fallback={<p data-testid="water-unavailable">Unavailable — {(props.day.water.missingReason ?? "not computed").replace(/_/g, " ")}.{props.water?.status === "unavailable" ? " Water is not computed for this plan: no sourced crop coefficients exist for this crop and region." : ""}</p>}
      >
        <ul class="se-list">
          <For each={rows()}>
            {(r) => (
              <li>
                <strong>{r.label}</strong> ({r.evidenceState}):{" "}
                {r.day
                  ? `crop water use ${fmtNum(r.day.etcMm)} mm, effective rain ${fmtNum(r.day.effectiveRainMm)} mm (${r.day.rainState}), root-zone depletion ${fmtNum(r.day.depletionEndMm)} mm`
                  : "no value for this day"}
                . {r.stressDays} stress day(s) over the season.
              </li>
            )}
          </For>
        </ul>
        <p class="se-help">A scenario range under stated assumptions, shown in millimetres; it is not a dose. {props.runs?.permittedPrecision === "range_only" ? "Treat it as a range." : ""}</p>
      </Show>
    </Panel>
  );
}

// ------------------------------------------------------------------ outlook, cost, harvest, economics

export function OutlookPanel(props: { day: TimelineDay; outputs: SeasonState["outputs"]; assumedPrice: string | null }) {
  const v = createMemo(() => outlookView(props.day, props.outputs.market_outlook, props.assumedPrice));
  return (
    <Panel mode id="outlook" title="Price outlook" badge={v().badge}>
      <p>
        <strong>{v().title}</strong>
      </p>
      <ul class="se-list" data-testid="outlook-lines">
        <For each={v().lines}>{(l) => <li>{l}</li>}</For>
      </ul>
    </Panel>
  );
}

export function EconomicsPanel(props: { outputs: SeasonState["outputs"]; selectedDate: string }) {
  const h = () => props.outputs.harvest_windows;
  const e = () => props.outputs.economics;
  const current = () => h()?.periods.find((p) => p.period.start <= props.selectedDate && props.selectedDate <= p.period.end) ?? null;
  return (
    <Panel mode id="economics" title="Harvest windows and economics" badge="scenario">
      <Show when={(h()?.periods ?? []).length > 0} fallback={<p>No harvest window is computed.</p>}>
        <ul class="se-list" data-testid="harvest-windows">
          <For each={h()!.periods}>
            {(p) => (
              <li data-current={current()?.periodId === p.periodId}>
                Harvest window {formatDate(p.period.start)} to {formatDate(p.period.end)} <Badge state="derived" />
                <Show when={current()?.periodId === p.periodId}> (selected date is inside)</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={e()} fallback={<p>Economics are not available for this plan.</p>}>
        {(ec) => (
          <>
            <Show when={ec().status === "unavailable" || !ec().priceIndependent}>
              <p data-testid="economics-unavailable">Unavailable — {(ec().missingReason ?? "no sourced cost or yield data for this crop and region").replace(/_/g, " ")}. Costs and yield are not invented.</p>
            </Show>
            <Show when={ec().priceIndependent}>
              {(pi) => (
                <>
                  <h3 class="se-h3">Costs and break-even (per hectare, scenario)</h3>
                  <ul class="se-list" data-testid="economics-scenarios">
                    <For each={pi().scenarios.filter((s) => s.name !== "yield_shortfall_price_rise")}>
                      {(s) => (
                        <li>
                          <strong>{s.name}</strong>: marketable {fmtNum(Number(s.perHa.marketableKgTotal), 0)} kg, cash production cost {fmtInr(s.perHa.cashProductionCostInr)}, break-even price {fmtNum(Number(s.perHa.breakEvenPriceInrPerKg))} Rs/kg
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="se-help">Costs are not time-phased in this plan, so a day-by-day cost curve is not shown. Unpriced: family labour.</p>
                </>
              )}
            </Show>
            <p data-testid="economics-price">
              Price basis: <Badge state={ec().price.state === "unavailable" ? "unavailable" : ec().price.state} /> {ec().price.state === "unavailable" ? "Net proceeds need a price: unavailable until price access or a price you enter." : ""}
            </p>
            <For each={ec().variants}>
              {(v) => (
                <>
                  <h3 class="se-h3">Net cash return per hectare ({v.priceSource === "forecast" ? "forecast price" : "your price"})</h3>
                  <ul class="se-list">
                    <For each={v.result.scenarios.filter((s) => s.name !== "yield_shortfall_price_rise")}>
                      {(s) => <li><strong>{s.name}</strong>: {fmtInr(s.perHa.netCashReturnInr)}</li>}
                    </For>
                  </ul>
                </>
              )}
            </For>
          </>
        )}
      </Show>
    </Panel>
  );
}

// ------------------------------------------------------------------ why this changed + sources

export function WhyPanel(props: { history: SeasonState["history"]; onOpen: () => void; stageNames: ReadonlyMap<string, string> }) {
  const label = (h: HistoryItem, i: number, n: number) => (h.summary ? `Version ${n - i}: ${formatInstant(h.createdAt)}` : `Version ${n - i} (first plan): ${formatInstant(h.createdAt)}`);
  return (
    <section class="card se-panel" aria-labelledby="why-h" data-testid="panel-why">
      <h2 id="why-h">Why this changed</h2>
      <details onToggle={(e) => e.currentTarget.open && props.onOpen()}>
        <summary>Show plan revisions</summary>
        <Show when={props.history.status === "loading"}><p role="status">Loading versions…</p></Show>
        <Show when={props.history.status === "error"}><p role="alert">Could not load the plan history.</p></Show>
        <Show when={props.history.status === "ready"}>
          <Show when={props.history.items.length > 1} fallback={<p data-testid="why-none">This is the first version of the plan. Nothing has changed yet; a change you confirm creates a new version and keeps this one.</p>}>
            <ol class="se-list" data-testid="why-list">
              <For each={props.history.items}>
                {(h, i) => (
                  <li>
                    <strong>{label(h, i(), props.history.items.length)}</strong>
                    <Show when={h.summary}>
                      {(s) => (
                        <ul>
                          <li>Changes: {s().changes.map((c) => c.type.replace(/_/g, " ")).join(", ")}</li>
                          <li>Tasks changed {s().changedTaskIds.length}, added {s().addedTaskIds.length}, removed {s().removedTaskIds.length}</li>
                          <li>Recomputed: {s().recomputedOutputs.join(", ") || "none"}</li>
                          <For each={s().economicDelta.filter((d) => d.scenario === "central" && d.breakEvenPriceInrPerKg?.delta)}>
                            {(d) => <li>Break-even price {d.breakEvenPriceInrPerKg!.old ?? "n/a"} to {d.breakEvenPriceInrPerKg!.new ?? "n/a"} Rs/kg ({d.priceSource})</li>}
                          </For>
                        </ul>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </details>
    </section>
  );
}

export function SourcesPanel(props: { day: TimelineDay; citations: SeasonState["citations"]; onOpen: () => void; assumptions: { id: string; description: string }[] }) {
  const cite = (id: string): EvidenceCitation | undefined => props.citations.byId.get(id);
  return (
    <section class="card se-panel" aria-labelledby="src-h" data-testid="panel-sources">
      <h2 id="src-h">Sources for this date</h2>
      <details onToggle={(e) => e.currentTarget.open && props.onOpen()}>
        <summary>Show {props.day.evidenceRefs.length} source reference(s)</summary>
        <Show when={props.citations.status === "loading"}><p role="status">Loading citations…</p></Show>
        <Show when={props.citations.status === "error"}><p role="alert">Citations could not be loaded; identifiers are shown.</p></Show>
        <ul class="se-list" data-testid="source-list">
          <For each={props.day.evidenceRefs} fallback={<li>No sources are attached to this date.</li>}>
            {(id) => (
              <li>
                <Show when={cite(id)} fallback={<code>{id}</code>}>
                  {(c) => (
                    <>
                      <strong>{c().citation.publisher}</strong>, {c().citation.documentTitle}
                      {c().locator?.page !== undefined ? `, page ${c().locator!.page}` : ""}
                      <Show when={c().excerpt}><blockquote class="se-quote">{c().excerpt}</blockquote></Show>
                      <span class="se-help">Validation: {c().validationStatus}. <Show when={c().citation.sourceUrl}>{(u) => <a href={u()} rel="noreferrer noopener" target="_blank">Source document</a>}</Show></span>
                    </>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.assumptions.length > 0}>
          <h3 class="se-h3">Named assumptions in this plan</h3>
          <ul class="se-list"><For each={props.assumptions}>{(a) => <li><code>{a.id}</code>: {a.description}</li>}</For></ul>
        </Show>
      </details>
    </section>
  );
}

