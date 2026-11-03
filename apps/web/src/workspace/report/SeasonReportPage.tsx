import { For, Show, createMemo, createResource, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import type { ReportEntry, SeasonReport } from "@harvest/contracts";
import { useWorkspace, dateLabel, type Cycle } from "../state";
import { PageHeading } from "../FarmPage";
import { Icon } from "../icons";
import { formatKg, formatRupees, seasonTotals, type SeasonCycle, type SeasonTotalsRow } from "../../features/journal/model";
import { cycleRecords, type CycleRecords } from "../../features/journal/records";
import { RecordsSection } from "../../features/journal/RecordsSection";
import { IssueTrendChart, CATEGORY_LABEL } from "./IssueTrendChart";
import { describeReportError, loadSeasonReport, parseSelector, reportCsvPath, reportHref, type ReportSelector } from "./reportApi";
import "./report.css";

const LABEL = "Farmer recorded · not an estimate";
const ACTIVITY: Record<string, string> = { planting: "Planting", irrigation: "Irrigation", weeding: "Weeding", fertilizer: "Fertiliser", pest_check: "Pest check", harvest: "Harvest", sale: "Sale", expense: "Expense", other: "Other", observation: "Observation" };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const word = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const cropOf = (r: SeasonReport) => r.cycle.cropName ?? word(r.cycle.cropId);

/**
 * The totals and records of a report, from the report's own entries and the SAME functions as the Journal's Season totals
 * and Harvest and inputs (one arithmetic). The cycle is passed alone: the server already attributed the entries to it and cut the
 * period, so `today` is the period end (the server's India date while the crop is in the field).
 */
export function reportTotals(r: SeasonReport): { totals: SeasonTotalsRow; records: CycleRecords } {
  const areaHaByCycle = r.field ? { [r.cycle.id]: r.field.areaHa } : undefined;
  const c = r.cycle;
  const cycle: SeasonCycle = {
    id: c.id, cropId: c.cropId, sowingDate: c.sowingDate, stage: c.stage,
    ...(c.cropName !== undefined ? { cropName: c.cropName } : {}),
    ...(c.establishmentDate !== undefined ? { establishmentDate: c.establishmentDate } : {}),
    ...(c.harvestDate !== undefined ? { harvestDate: c.harvestDate } : {}),
  };
  return {
    totals: seasonTotals(r.entries, [cycle], r.period.to)[0]!,
    records: cycleRecords(r.entries, [cycle], r.period.to, areaHaByCycle ? { areaHaByCycle } : {})[0]!,
  };
}

const Thumbs = (props: { items: { id: string; contentPath: string }[]; date: string }) => (
  <Show when={props.items.length > 0}>
    <ul class="report-thumbs">
      <For each={props.items}>
        {(m) => (
          <li>
            <img src={m.contentPath} alt={`Your photo, ${props.date}`} loading="lazy" width="96" height="96" />
            <span>{props.date}</span>
          </li>
        )}
      </For>
    </ul>
  </Show>
);

function Section(props: { id: string; title: string; note?: string; breakBefore?: boolean; children: JSX.Element }) {
  return (
    <section class="report-section" classList={{ "report-break-before": props.breakBefore }} aria-labelledby={`rep-${props.id}`} data-testid={`report-${props.id}`}>
      <h2 id={`rep-${props.id}`}>{props.title}</h2>
      <Show when={props.note}><p class="report-note">{props.note}</p></Show>
      {props.children}
    </section>
  );
}

/** The report as a document. No router or workspace needed (the page wrapper supplies them), so it renders anywhere. */
export function SeasonReportView(props: { report: SeasonReport; csvHref: string; onPrint?: () => void; fmtDate?: (iso: string) => string }) {
  const r = () => props.report;
  const d = (iso: string) => (props.fmtDate ?? dateLabel)(iso);
  const t = createMemo(() => reportTotals(r()));
  const entryById = createMemo(() => new Map(r().entries.map((e): [string, ReportEntry] => [e.id, e])));
  const cropName = () => cropOf(r());
  return (
    <article class="report-page" data-testid="season-report">
      <header class="report-header">
        <p class="report-kicker">Season report</p>
        <h1>{cropName()}{r().field ? ` on ${r().field!.name}` : ""}</h1>
        <p class="report-meta">
          {r().farm.name}{r().farm.district ? ` · ${r().farm.district}` : ""}{r().farm.state ? `, ${r().farm.state}` : ""}
          {r().field ? ` · field ${r().field!.name}, ${r().field!.areaHa.toFixed(2)} ha (drawn area)` : ""}
        </p>
        <p class="report-meta">
          Counted from {d(r().period.from)} to {d(r().period.to)}
          {r().cycle.harvestDate ? ` (harvested ${d(r().cycle.harvestDate!)})` : " (crop still in the field)"} · generated {d(r().generatedAt.slice(0, 10))}
        </p>
        <p><span class="report-pill">{LABEL}</span></p>
        <div class="report-actions no-print">
          <button type="button" class="btn secondary" onClick={() => (props.onPrint ?? (() => window.print()))()}>
            <Icon name="journal" size={17} />
            Print or save as PDF
          </button>
          <a class="btn secondary" href={props.csvHref} download="" data-testid="report-csv">
            <Icon name="down" size={17} />
            Download CSV
          </a>
        </div>
      </header>

      <Section id="totals" title="Season totals">
        <div class="report-totals" data-testid="report-totals">
          <p>{plural(t().totals.entries, "journal entry", "journal entries")} in these dates</p>
          <p>Spent {formatRupees(t().totals.expenseInr)} · Sold {formatRupees(t().totals.saleInr)} · <span classList={{ "report-negative": t().totals.netInr < 0 }}>Net {formatRupees(t().totals.netInr)}</span></p>
          <p>Harvest recorded: {t().totals.harvestKg === null ? "none recorded" : formatKg(t().totals.harvestKg!)}
            <Show when={t().totals.harvestUnitsSkipped > 0}> <small>({plural(t().totals.harvestUnitsSkipped, "harvest entry", "harvest entries")} in other units not added)</small></Show>
          </p>
          <p class="report-note">{LABEL}. Money is the sum of your journal expense and sale amounts; it is not a profit estimate.</p>
        </div>
      </Section>
      <RecordsSection records={[t().records]} dateLabel={d} cropName={(id) => word(id)} />

      <Section id="entries" title="Journal entries" note={`What you wrote down, oldest first. ${LABEL}.`}>
        <Show when={r().entries.length > 0} fallback={<p class="report-empty">No journal entries fall inside these dates.</p>}>
          <ul class="report-entries">
            <For each={r().entries}>
              {(e) => (
                <li>
                  <strong>{d(e.observedOn)}</strong> · {ACTIVITY[e.activity ?? ""] ?? "Entry"}
                  <Show when={e.quantity}> · {e.quantity!.value} {e.quantity!.unit}</Show>
                  <Show when={e.expense}> · spent ₹{e.expense!.amountInr} ({e.expense!.category})</Show>
                  <Show when={e.sale}> · sold ₹{e.sale!.amountInr}</Show>
                  <Show when={e.note}><span class="report-entry-note">{e.note}</span></Show>
                  <Thumbs items={e.media} date={d(e.observedOn)} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>

      <Section id="issues" title="Issues" breakBefore note="What you saw. Category, severity and status are as you reported them; the app does not diagnose.">
        <Show when={r().issues.length > 0} fallback={<p class="report-empty">No issues were recorded for this crop.</p>}>
          <div class="report-table-wrap">
            <table class="report-table" data-testid="issues-table">
              <thead><tr><th scope="col">Seen</th><th scope="col">Issue</th><th scope="col">Severity</th><th scope="col">Status</th><th scope="col">What happened next</th><th scope="col">Seen before</th></tr></thead>
              <tbody>
                <For each={r().issues}>
                  {(i) => (
                    <tr>
                      <td data-label="Seen">{d(i.observedOn)}</td>
                      <td data-label="Issue">
                        <strong>{i.title}</strong> <span class="report-muted">({CATEGORY_LABEL[i.category]})</span>
                        <Show when={i.detail}><span class="report-entry-note">{i.detail}</span></Show>
                        <Thumbs items={i.mediaIds.map((id) => ({ id, contentPath: `/api/v1/media/${id}/content?variant=normalized` }))} date={d(i.observedOn)} />
                      </td>
                      <td data-label="Severity">{word(i.severity)}</td>
                      <td data-label="Status">{word(i.status)}</td>
                      <td data-label="What happened next">
                        <ul class="report-events">
                          <For each={i.events.filter((e) => e.kind !== "reported")}>
                            {(e) => (
                              <li>
                                {d(e.occurredOn)}: {word(e.kind)}
                                <Show when={e.status}> to {e.status}</Show>
                                <Show when={e.response}>
                                  {" "}({word(e.response!.method)}) {e.response!.description}
                                  <Show when={e.response!.productName}> · product as you named it: {e.response!.productName}</Show>
                                  <Show when={e.response!.labelWaitDays !== undefined}> · label wait {e.response!.labelWaitDays} days (as you entered it)</Show>
                                </Show>
                                <Show when={e.note}> {e.note}</Show>
                              </li>
                            )}
                          </For>
                        </ul>
                        <Show when={i.earliestHarvestOn}><span class="report-note">Earliest harvest from the label you entered: {d(i.earliestHarvestOn!)} (arithmetic; not checked by the app)</span></Show>
                        <Show when={i.recheckOn}><span class="report-note">Recheck set for {d(i.recheckOn!)}</span></Show>
                      </td>
                      <td data-label="Seen before">{i.seenBefore.length ? `${plural(i.seenBefore.length, "earlier issue", "earlier issues")} of this kind, last ${d(i.seenBefore[0]!.observedOn)}` : "None logged"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section id="checks" title="Field checks" breakBefore note="Checks you marked done, at your own check interval.">
        <Show when={r().checks.length > 0} fallback={<p class="report-empty">No field checks were completed for this crop.</p>}>
          <div class="report-table-wrap">
            <table class="report-table" data-testid="checks-table">
              <thead><tr><th scope="col">Done on</th><th scope="col">Check</th><th scope="col">Due window</th><th scope="col">Your note</th></tr></thead>
              <tbody>
                <For each={r().checks}>
                  {(c) => (
                    <tr>
                      <td data-label="Done on">{d(c.completedOn ?? c.dueFrom)}</td>
                      <td data-label="Check">{c.kind === "recheck" ? "Recheck of an issue" : "Field check"}</td>
                      <td data-label="Due window">{c.dueFrom === c.dueTo ? d(c.dueFrom) : `${d(c.dueFrom)} to ${d(c.dueTo)}`}</td>
                      <td data-label="Your note">{(c.journalEntryId && entryById().get(c.journalEntryId)?.note) || "No note"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section id="care" title="Care actions done">
        <Show when={r().careCompletions.length > 0} fallback={<p class="report-empty">No care actions were marked done for this crop.</p>}>
          <ul class="report-entries">
            <For each={r().careCompletions}>{(c) => <li><strong>{d(c.completedOn)}</strong> · {c.title}</li>}</For>
          </ul>
        </Show>
      </Section>

      <Section id="alerts" title="Alerts in these dates" note="Stored alerts with a dated source; dismissed ones are kept.">
        <Show when={r().alerts.length > 0} fallback={<p class="report-empty">No alerts were stored for these dates.</p>}>
          <div class="report-table-wrap">
            <table class="report-table" data-testid="alerts-table">
              <thead><tr><th scope="col">Valid</th><th scope="col">Alert</th><th scope="col">Level</th><th scope="col">Source</th></tr></thead>
              <tbody>
                <For each={r().alerts}>
                  {(a) => (
                    <tr>
                      <td data-label="Valid">{a.validFrom === a.validTo ? d(a.validFrom) : `${d(a.validFrom)} to ${d(a.validTo)}`}</td>
                      <td data-label="Alert"><strong>{a.title}</strong> <Show when={a.dismissedAt}><span class="report-muted">(dismissed)</span></Show><span class="report-entry-note">{a.detail}</span></td>
                      <td data-label="Level">{word(a.severity)}</td>
                      <td data-label="Source"><a href={a.source.url} target="_blank" rel="noopener noreferrer">{a.source.name}</a>, {d(a.source.date)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section id="satellite" title="Satellite readings" note="Stored Sentinel-2 readings for this field. Computed in code; not validated against your field.">
        <Show when={r().ndvi.length > 0} fallback={<p class="report-empty">No stored satellite readings for these dates.</p>}>
          <div class="report-table-wrap">
            <table class="report-table" data-testid="ndvi-table">
              <thead><tr><th scope="col">Date</th><th scope="col">Mean NDVI</th><th scope="col">Clear pixels</th><th scope="col">Used</th></tr></thead>
              <tbody>
                <For each={r().ndvi}>
                  {(n) => (
                    <tr>
                      <td data-label="Date">{d(n.date)}</td>
                      <td data-label="Mean NDVI">{n.meanNdvi === null ? "none" : n.meanNdvi.toFixed(2)}</td>
                      <td data-label="Clear pixels">{n.clearFraction === null ? "none" : `${Math.round(n.clearFraction * 100)}%`}</td>
                      <td data-label="Used">{n.verdict === "usable" ? "Yes" : `No (${word(n.verdict).toLowerCase()})`}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section id="trend" title="Issues by week">
        <IssueTrendChart weeks={r().issueTrend} />
      </Section>

      <Section id="previous" title="Earlier seasons on this field">
        <Show when={r().previousSeasons.length > 0} fallback={<p class="report-empty">No earlier season is recorded for this field.</p>}>
          <div class="report-table-wrap">
            <table class="report-table" data-testid="previous-table">
              <thead><tr><th scope="col">Crop</th><th scope="col">Sown</th><th scope="col">Harvested</th><th scope="col">Issues logged</th><th scope="col">Checks done</th></tr></thead>
              <tbody>
                <For each={r().previousSeasons}>
                  {(p) => (
                    <tr>
                      <td data-label="Crop">{p.cropName}</td>
                      <td data-label="Sown">{d(p.sowingDate)}</td>
                      <td data-label="Harvested">{p.harvestDate ? d(p.harvestDate) : "Not recorded"}</td>
                      <td data-label="Issues logged">{p.issueCount}</td>
                      <td data-label="Checks done">{p.checksCompleted}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section id="limits" title="What this report does not have">
        <ul class="report-limits">
          <For each={r().limitations}>{(l) => <li>{l}</li>}</For>
        </ul>
      </Section>
    </article>
  );
}

/** Route `/farm/report` (`?cycle=<id>` or `?field=<id>`): loads the report for the selected farm and shows it. */
export function SeasonReportPage() {
  const s = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const selector = (): ReportSelector => {
    const q = parseSelector(location.search);
    return { cycleId: q.cycleId, fieldId: q.fieldId };
  };
  const source = () => {
    const farmId = s.farm()?.id;
    const ws = s.workspace();
    if (!farmId || !ws || ws.farmId !== farmId) return undefined;
    const q = selector();
    // A farm with fields needs a crop or a field: show the picker instead of asking the server for an error.
    if (!q.cycleId && !q.fieldId && (ws.fields?.length ?? 0) > 0) return undefined;
    return { farmId, ...q };
  };
  const [report, { refetch }] = createResource(source, (k) => loadSeasonReport(k.farmId, { cycleId: k.cycleId, fieldId: k.fieldId }));
  const cycles = (): Cycle[] => [...(s.workspace()?.cycles ?? [])].sort((a, b) => Number(b.stage !== "harvested") - Number(a.stage !== "harvested") || b.sowingDate.localeCompare(a.sowingDate));
  const fieldName = (id?: string) => s.workspace()?.fields?.find((f) => f.id === id)?.name;
  const label = (c: Cycle) => `${c.cropName ?? s.cropName(c.cropId)}${c.fieldId && fieldName(c.fieldId) ? ` · ${fieldName(c.fieldId)}` : ""} · sown ${dateLabel(c.sowingDate)}${c.stage === "harvested" ? " · harvested" : ""}`;
  const failure = () => (report.error ? describeReportError(report.error) : null);
  const current = () => report.latest;
  return (
    <div class="workspace-page report-route">
      <div class="no-print">
        <PageHeading eyebrow="FARMER RECORDED" title="Season report" description="One crop's entries, issues, checks and alerts in one printable page. Nothing here is an estimate." />
        <Show when={cycles().length > 0}>
          <label class="report-picker">
            <span>Crop</span>
            <select
              aria-label="Choose the crop for the season report"
              value={selector().cycleId ?? current()?.cycle.id ?? ""}
              onChange={(e) => navigate(reportHref({ cycleId: e.currentTarget.value }))}
            >
              <Show when={!(selector().cycleId ?? current())}><option value="">Choose a crop</option></Show>
              <For each={cycles()}>{(c) => <option value={c.id} selected={c.id === (selector().cycleId ?? current()?.cycle.id)}>{label(c)}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
      <Show when={s.farm()} fallback={<p class="report-empty">Set up your farm to see a season report.</p>}>
        <Show when={failure()}>
          {(f) => (
            <div class={f().kind === "choose" ? "report-state" : "alert-card"} role={f().kind === "other" ? "alert" : "status"}>
              {f().message}
              <Show when={f().kind === "other"}><button type="button" class="text-button" onClick={() => void refetch()}>Try again</button></Show>
            </div>
          )}
        </Show>
        <Show when={!source() && !report.error && s.workspace() && cycles().length > 0 && !selector().cycleId && !selector().fieldId}>
          <p class="report-state" data-testid="report-choose">Choose a crop above to see its season report.</p>
        </Show>
        <Show when={report.loading && !report.error}><p class="report-state" role="status">Loading the season report…</p></Show>
        <Show when={!report.error && current() && current()!.farm.id === s.farm()?.id ? current() : undefined}>
          {(rep) => <SeasonReportView report={rep()} csvHref={reportCsvPath(rep().farm.id, selector().cycleId || selector().fieldId ? selector() : { cycleId: rep().cycle.id })} />}
        </Show>
      </Show>
    </div>
  );
}
