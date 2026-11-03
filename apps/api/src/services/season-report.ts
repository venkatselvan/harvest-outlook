/**
 * Season report (FIELD_OPERATIONS_SPEC.md section 8.1): one crop cycle's journal entries, completed checks, issues, care
 * completions, stored alerts and stored satellite readings, read-only, plus the CSV rendering of the same data.
 *
 * Nothing here is an estimate or advice: every row is something the farmer recorded or something stored with a dated source.
 * Totals are not computed here; the web adds the entries with the Journal's `seasonTotals` / `cycleRecords` so one arithmetic
 * exists. Documented choices that change results:
 * - Period: from = establishment date (else sowing date); to = today while the crop is in the field, else harvest date + 90
 *   days capped at the day before the next crop on the farm starts. This mirrors the web `windowsOf` (POST_HARVEST_WINDOW_DAYS
 *   is an assumption, not a sourced figure).
 * - Entries: the farm timeline entries whose observation date lies in the period AND whose attributed cycle is this one. An entry
 *   carrying a `cycle_id` fact for a cycle of the farm (field checks, issues, issue events and care completions write one) belongs
 *   to that cycle only; any other entry goes by the web's date rule (an entry that several crops' windows contain goes to the crop
 *   that started last; ties: active crops first, newest sowing first, then id). Plain journal entries carry no field.
 * - Checks / issues: those naming this cycle, plus those with no cycle on the cycle's field (or farm-wide) dated in the period.
 * - Selection: `cycleId`; else `fieldId` -> that field's current cycle (latest unharvested, else the field's latest cycle); else, on
 *   a farm without fields, the farm's current cycle (latest unharvested, else latest). A farm with fields needs one (400
 *   field_required).
 * - Satellite readings: stored Sentinel-2 rows only (no provider call), live mode, matched on the drawn polygon of the field (or
 *   the farm boundary); a 100 m fallback square is not matched.
 * - issueTrend: weeks start on Monday; weeks run without gaps from the first to the last week that has an issue.
 */
import type {FarmAlert, FarmWorkspace, FieldCheck, FieldIssue, IssueCategory, PreviousSeason, ReportAlert, ReportCareCompletion, ReportEntry, ReportNdviReading, IssueTrendWeek, SeasonReport} from '@harvest/contracts';
import {IssueCategory as IssueCategoryEnum, NdviStats} from '@harvest/contracts';
import type {Pool} from '../db/pool';
import * as journalRepo from '../journal/repository';
import {PLAN_FIELDS} from '../journal/types';
import {ApiError, notFound} from './errors';
import {getFarm} from './farms';
import {fieldAreaHa, getWorkspace, requireField} from './workspace';
import {boundaryPolygonHash} from './today/ndvi';
import {addDays, completedCheck, cycleCropName, cycleFieldId} from './scouting/schedule';
import {scoutingRows, toScheduleCompletion, toScheduleIssue, type Mode} from './scouting/repository';
import {latestOpenCycle, toFieldIssue, todayOf, type ScoutingDeps} from './scouting/issues';

type Cycle = FarmWorkspace['cycles'][number];
export const POST_HARVEST_WINDOW_DAYS = 90;
const ENTRY_LIMIT = 5000;
const ALERT_LIMIT = 300;
const NDVI_LIMIT = 120;
const PLAN_FIELD_SET: ReadonlySet<string> = new Set(PLAN_FIELDS);

const startOf = (c: Pick<Cycle, 'establishmentDate' | 'sowingDate'>) => c.establishmentDate ?? c.sowingDate;
const isActive = (c: Pick<Cycle, 'stage'>) => c.stage !== 'harvested';

// ------------------------------------------------------------------ attribution (mirrors apps/web features/journal/model.ts)

export interface Window { cycle: Cycle; from: string; to: string; windowTo: string }
/** The day range each cycle takes entries from (the web's windowsOf over the cycles in the web's sort order). */
export function cycleWindows(cycles: readonly Cycle[], today: string): Window[] {
  const ordered = [...cycles].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.sowingDate.localeCompare(a.sowingDate) || a.id.localeCompare(b.id));
  const starts = ordered.map(startOf);
  return ordered.map((cycle) => {
    const from = startOf(cycle);
    if (!cycle.harvestDate) return {cycle, from, to: today, windowTo: today};
    const to = cycle.harvestDate;
    let windowTo = addDays(to, POST_HARVEST_WINDOW_DAYS);
    const next = starts.filter((s) => s > to).sort()[0];
    if (next !== undefined && addDays(next, -1) < windowTo) windowTo = addDays(next, -1);
    return {cycle, from, to, windowTo};
  });
}
/** The cycle an entry date is attributed to: the containing window with the latest start (ties: first in order). */
export function homeWindow(windows: readonly Window[], date: string): Window | null {
  let home: Window | null = null;
  for (const w of windows) if (date >= w.from && date <= w.windowTo && (home === null || w.from > home.from)) home = w;
  return home;
}

/**
 * The cycle a journal entry belongs to: the cycle named by its `cycle_id` fact when it carries one that exists on the farm (field
 * check, issue and care-completion entries do, even where several crops' windows contain the date), else the date-window rule.
 */
export function entryCycleId(cycles: readonly Pick<Cycle, 'id'>[], windows: readonly Window[], date: string, facts: readonly Pick<journalRepo.FactRow, 'fact_key' | 'value' | 'status'>[]): string | null {
  const named = facts.find((f) => f.fact_key === 'cycle_id' && f.status !== 'rejected' && typeof f.value === 'string' && cycles.some((c) => c.id === f.value));
  return named ? (named.value as string) : homeWindow(windows, date)?.cycle.id ?? null;
}

// ------------------------------------------------------------------ selection

/** 404 cycle_not_found, 400 field_required, 404 field_not_found; see the header for the rule. */
export function chooseCycle(ws: FarmWorkspace, q: {cycleId?: string | undefined; fieldId?: string | undefined}): Cycle {
  const missing = () => new ApiError(404, 'cycle_not_found', 'Crop cycle not found on this farm');
  if (q.cycleId !== undefined) {
    const cycle = ws.cycles.find((c) => c.id === q.cycleId);
    if (!cycle) throw missing();
    if (q.fieldId !== undefined) {
      const field = requireField(ws, q.fieldId);
      if (cycleFieldId(ws, cycle) !== (field?.id ?? null)) throw missing();
    }
    return cycle;
  }
  const field = requireField(ws, q.fieldId);
  const pool = field ? ws.cycles.filter((c) => c.fieldId === field.id) : ws.cycles;
  const pick = latestOpenCycle(pool) ?? [...pool].sort((a, b) => startOf(b).localeCompare(startOf(a)) || a.id.localeCompare(b.id))[0];
  if (!pick) throw missing();
  return pick;
}

// ------------------------------------------------------------------ trend

/** The Monday on or before an ISO date. */
export function mondayOf(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}
const zeroCounts = (): Record<IssueCategory, number> => Object.fromEntries(IssueCategoryEnum.options.map((c) => [c, 0])) as Record<IssueCategory, number>;
/** Weekly (Monday start) issue counts by category, first to last week with an issue, no gaps; empty without issues. */
export function issueTrend(issues: readonly Pick<FieldIssue, 'observedOn' | 'category'>[]): IssueTrendWeek[] {
  if (!issues.length) return [];
  const weeks = new Map<string, Record<IssueCategory, number>>();
  for (const i of issues) {
    const w = mondayOf(i.observedOn);
    const row = weeks.get(w) ?? zeroCounts();
    row[i.category] += 1;
    weeks.set(w, row);
  }
  const keys = [...weeks.keys()].sort();
  const out: IssueTrendWeek[] = [];
  for (let w = keys[0]!; w <= keys[keys.length - 1]!; w = addDays(w, 7)) out.push({weekStart: w, counts: weeks.get(w) ?? zeroCounts()});
  return out;
}

// ------------------------------------------------------------------ stored reads

async function careCompletionsOf(pool: Pool, ownerId: string, farmId: string, mode: Mode, cycleId: string): Promise<ReportCareCompletion[]> {
  const r = await pool.query<{task_id: string; completed_on: string; title: string}>(
    `SELECT action_key AS task_id, to_char(completed_on,'YYYY-MM-DD') AS completed_on,
            COALESCE(source_snapshot->'task'->>'title', CASE WHEN action_key='establishment' THEN 'Crop established' END, action_key) AS title
       FROM farm_cycle_actions WHERE owner_id=$1 AND farm_id=$2 AND mode=$3 AND cycle_id=$4 ORDER BY completed_on, created_at, id`, [ownerId, farmId, mode, cycleId]);
  return r.rows.map((x) => ({taskId: x.task_id, title: x.title.slice(0, 300), completedOn: x.completed_on}));
}

interface AlertDbRow { id: string; farm_id: string; type: FarmAlert['type']; severity: FarmAlert['severity']; origin: FarmAlert['origin']; title: string; detail: string; source: FarmAlert['source']; valid_from: string; valid_to: string; suggested_step: string | null; created_at: Date; field_id: string | null; dismissed_at: Date | null }
/** Alerts whose validity overlaps the period, the field's own plus farm-wide, dismissed ones included. */
async function alertsOf(pool: Pool, ownerId: string, farmId: string, mode: Mode, fieldId: string | null, from: string, to: string): Promise<{alerts: ReportAlert[]; capped: boolean}> {
  const r = await pool.query<AlertDbRow>(
    `SELECT a.id, a.farm_id, a.type, a.severity, a.origin, a.title, a.detail, a.source, to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to,
            a.suggested_step, a.created_at, a.field_id, a.dismissed_at
       FROM farm_alerts a JOIN farms f ON f.id=a.farm_id AND f.owner_id=a.owner_id
      WHERE a.farm_id=$1 AND a.owner_id=$2 AND a.mode=$3 AND f.deleted_at IS NULL AND a.valid_from <= $5::date AND a.valid_to >= $4::date
        AND (a.field_id IS NULL OR a.field_id = $6::text)
      ORDER BY a.valid_from, a.created_at, a.id LIMIT $7`, [farmId, ownerId, mode, from, to, fieldId, ALERT_LIMIT + 1]);
  const rows = r.rows.slice(0, ALERT_LIMIT);
  return {
    capped: r.rows.length > ALERT_LIMIT,
    alerts: rows.map((a) => ({
      id: a.id, farmId: a.farm_id, type: a.type, severity: a.severity, origin: a.origin, title: a.title, detail: a.detail, source: {name: a.source.name, url: a.source.url, date: a.source.date},
      validFrom: a.valid_from, validTo: a.valid_to, suggestedStep: a.suggested_step, createdAt: a.created_at.toISOString(), ...(a.field_id ? {fieldId: a.field_id} : {}), scope: a.field_id ? 'field' as const : 'farm' as const,
      dismissedAt: a.dismissed_at?.toISOString() ?? null,
    })),
  };
}

/** Stored satellite readings for a polygon hash inside the period (no provider call). */
async function ndviOf(pool: Pool, ownerId: string, farmId: string, polygonHash: string, from: string, to: string): Promise<ReportNdviReading[]> {
  const r = await pool.query<{acquired_at: Date; field_stats: unknown}>(
    `SELECT acquired_at, field_stats FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND acquired_at >= $4::date AND acquired_at < ($5::date + 1) ORDER BY acquired_at LIMIT $6`,
    [ownerId, farmId, polygonHash, from, to, NDVI_LIMIT]);
  const out: ReportNdviReading[] = [];
  for (const row of r.rows) {
    const stats = NdviStats.safeParse(row.field_stats);
    if (!stats.success) continue;
    out.push({date: row.acquired_at.toISOString().slice(0, 10), meanNdvi: stats.data.mean, clearFraction: stats.data.clearFraction, verdict: stats.data.usable ? 'usable' : stats.data.rejection ?? 'not_usable'});
  }
  return out;
}

const toReportEntry = (row: journalRepo.EntryRow, facts: journalRepo.FactRow[]): ReportEntry => {
  const e = journalRepo.entryOut(row, facts, undefined, PLAN_FIELD_SET);
  return {
    id: e.id, observedOn: e.observedOn, activity: e.activity, note: e.note, quantity: e.quantity, expense: e.expense, sale: e.sale,
    media: e.media, provenanceLabel: e.provenanceLabel,
    facts: e.facts.map((f) => ({id: f.id, field: f.field, kind: f.kind, source: f.source, status: f.status, value: f.value, unit: f.unit, evidenceState: f.evidenceState})),
  };
};

// ------------------------------------------------------------------ the report

export async function buildSeasonReport(deps: ScoutingDeps, ownerId: string, farmId: string, q: {cycleId?: string | undefined; fieldId?: string | undefined}): Promise<SeasonReport> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const ws = await getWorkspace(deps.pool, ownerId, farmId);
  const mode = deps.config.RUNTIME_MODE;
  const today = todayOf(deps);
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();

  const cycle = chooseCycle(ws, q);
  const fieldId = cycleFieldId(ws, cycle);
  const field = fieldId === null ? null : ws.fields.find((f) => f.id === fieldId) ?? null;
  const windows = cycleWindows(ws.cycles, today);
  const mine = windows.find((w) => w.cycle.id === cycle.id)!;
  const period = {from: mine.from, to: mine.windowTo};
  const inPeriod = (d: string) => d >= period.from && d <= period.to;

  // Journal entries attributed to this cycle (oldest first).
  const rowsAll = await journalRepo.listEntries(deps.pool, ownerId, farmId, ENTRY_LIMIT);
  const inWindow = rowsAll.filter((e) => inPeriod(e.entry_date));
  const allFacts = await journalRepo.factsForEntries(deps.pool, ownerId, inWindow.map((e) => e.id));
  const rowsIn = inWindow.filter((e) => entryCycleId(ws.cycles, windows, e.entry_date, allFacts.filter((f) => f.entry_id === e.id)) === cycle.id).reverse();
  const facts = allFacts.filter((f) => rowsIn.some((e) => e.id === f.entry_id));
  const entries = rowsIn.map((e) => toReportEntry(e, facts.filter((f) => f.entry_id === e.id)));

  // Issues and completed checks.
  const rows = await scoutingRows(deps.pool, ownerId, farmId, mode);
  const sameField = (id: string | null) => id === fieldId;
  const issueRows = rows.issues.filter((i) => i.cycle_id === cycle.id || (i.cycle_id === null && sameField(i.field_id) && inPeriod(i.observed_on)));
  const issues = issueRows.map((i) => toFieldIssue(i, rows.events, rows.issues, ws)).sort((a, b) => a.observedOn.localeCompare(b.observedOn) || a.createdAt.localeCompare(b.createdAt));
  const input = {workspace: ws, issues: rows.issues.map((i) => toScheduleIssue(i, ws)), alerts: rows.alerts};
  const checks: FieldCheck[] = rows.completions
    .filter((c) => (c.cycle_id === cycle.id || (c.cycle_id === null && sameField(c.field_id))) && inPeriod(c.completed_on))
    .map((c) => completedCheck(input, toScheduleCompletion(c)))
    .sort((a, b) => (a.completedOn ?? '').localeCompare(b.completedOn ?? '') || a.id.localeCompare(b.id));

  const careCompletions = await careCompletionsOf(deps.pool, ownerId, farmId, mode, cycle.id);
  const alertRead = await alertsOf(deps.pool, ownerId, farmId, mode, fieldId, period.from, period.to);

  let ndvi: ReportNdviReading[] = [];
  let ndviNote: string | null = null;
  const boundary = field?.boundary ?? ws.boundary;
  const hash = boundary ? boundaryPolygonHash(boundary) : null;
  if (mode !== 'live') ndviNote = 'Satellite readings are stored only in live mode, so none are listed here.';
  else if (!hash) ndviNote = 'No field boundary is drawn, so no stored satellite readings can be matched to this field.';
  else ndvi = await ndviOf(deps.pool, ownerId, farmId, hash, period.from, period.to);

  // Earlier cycles on the same field.
  const previousSeasons: PreviousSeason[] = ws.cycles
    .filter((c) => c.id !== cycle.id && cycleFieldId(ws, c) === fieldId && startOf(c) < startOf(cycle))
    .sort((a, b) => startOf(b).localeCompare(startOf(a)) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((c) => ({
      cycleId: c.id, cropName: cycleCropName(c), sowingDate: c.sowingDate, harvestDate: c.harvestDate ?? null,
      issueCount: rows.issues.filter((i) => i.cycle_id === c.id).length, checksCompleted: rows.completions.filter((x) => x.cycle_id === c.id).length,
    }));

  const limitations = [
    'Everything here is what you recorded or what was stored with a dated source; none of it is an estimate or advice.',
    'Journal entries are attributed to this crop by the crop a field check, issue or care action names, and otherwise by date (the same rule as the Season totals); plain entries are not tied to a field.',
    `The period ends ${cycle.harvestDate ? `${POST_HARVEST_WINDOW_DAYS} days after harvest (or before the next crop starts)` : 'today'}; ${POST_HARVEST_WINDOW_DAYS} days is an assumption so that sales after harvest are not dropped.`,
  ];
  if (!entries.length) limitations.push('No journal entries fall inside this period.');
  if (rowsAll.length >= ENTRY_LIMIT) limitations.push(`Only the newest ${ENTRY_LIMIT} journal entries of the farm were read; older ones are missing.`);
  if (!issues.length) limitations.push('No issues were recorded for this crop.');
  if (!checks.length) limitations.push('No field checks were completed for this crop.');
  if (!careCompletions.length) limitations.push('No care actions were marked done for this crop.');
  if (!alertRead.alerts.length) limitations.push('No alerts were stored for this period.');
  if (alertRead.capped) limitations.push(`Only the first ${ALERT_LIMIT} alerts of the period are listed.`);
  if (ndviNote) limitations.push(ndviNote);
  else if (!ndvi.length) limitations.push('No stored satellite readings for this field fall inside the period.');

  return {
    farm: {id: farm.id, name: farm.name, district: farm.location.districtName, state: farm.location.stateCode, areaHa: farm.areaHectares},
    field: field ? {id: field.id, name: field.name, areaHa: fieldAreaHa(ws, field.id)} : null,
    cycle, period, entries, checks, issues, careCompletions, alerts: alertRead.alerts, ndvi, issueTrend: issueTrend(issues), previousSeasons, generatedAt, limitations,
  };
}

// ------------------------------------------------------------------ CSV

export const CSV_HEADER = ['date', 'kind', 'field', 'title', 'detail', 'category', 'severity', 'status', 'quantity', 'unit', 'amount_inr', 'source'] as const;
export const CSV_DETAIL_MAX = 500;
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: newlines flattened, the optional length cap applied, a leading = + - @ (or tab / CR) defused with a quote, then the length cap (the quote counts), always quoted. */
export function csvCell(value: string | number | null | undefined, maxLength?: number): string {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.replace(/\r\n|\r|\n/g, ' ').trim();
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (maxLength !== undefined && s.length > maxLength) s = `${s.slice(0, maxLength - 1).trimEnd()}…`;
  return `"${s.replace(/"/g, '""')}"`;
}

type Row = {date: string; kind: 'journal' | 'check' | 'issue' | 'issue_event' | 'care' | 'alert'; field?: string; title: string; detail?: string; category?: string; severity?: string; status?: string; quantity?: number | string; unit?: string; amount?: string; source: string};
const KIND_ORDER: Record<Row['kind'], number> = {journal: 0, care: 1, check: 2, issue: 3, issue_event: 4, alert: 5};

/** Rows of the report, one per dated record, oldest first (ties: kind order, then title). */
export function reportRows(report: SeasonReport): Row[] {
  const fieldName = report.field?.name;
  const rows: Row[] = [];
  for (const e of report.entries) {
    const base = {date: e.observedOn, kind: 'journal' as const, title: e.activity ?? 'note', detail: e.note ?? '', source: 'farmer'};
    const qty = e.quantity ? {quantity: e.quantity.value, unit: e.quantity.unit} : {};
    if (e.sale) rows.push({...base, ...qty, category: 'sale', amount: e.sale.amountInr, ...(e.sale.note ? {detail: [e.note, e.sale.note].filter(Boolean).join(' / ')} : {})});
    if (e.expense) rows.push({...base, ...(e.sale ? {} : qty), category: `expense: ${e.expense.category}`, amount: e.expense.amountInr});
    if (!e.sale && !e.expense) rows.push({...base, ...qty});
  }
  for (const c of report.checks) {
    rows.push({date: c.completedOn ?? c.dueFrom, kind: 'check', ...(fieldName ? {field: fieldName} : {}), title: c.kind === 'recheck' ? 'Recheck completed' : 'Field check completed', detail: `Due ${c.dueFrom} to ${c.dueTo}`, status: 'completed', source: 'farmer'});
  }
  for (const i of report.issues) {
    rows.push({date: i.observedOn, kind: 'issue', ...(fieldName ? {field: fieldName} : {}), title: i.title, detail: i.detail ?? '', category: i.category, severity: i.severity, status: i.status, source: 'farmer'});
    for (const ev of i.events) {
      if (ev.kind === 'reported') continue;
      const r = ev.response;
      rows.push({
        date: ev.occurredOn, kind: 'issue_event', ...(fieldName ? {field: fieldName} : {}),
        title: `${i.title}: ${ev.kind.replace(/_/g, ' ')}${r ? ` (${r.method.replace(/_/g, ' ')})` : ''}`,
        detail: [r?.description, r?.productName ? `product as typed: ${r.productName}` : '', r?.labelWaitDays !== undefined ? `label wait ${r.labelWaitDays} days (farmer-entered)` : '', ev.note ?? ''].filter(Boolean).join('; '),
        category: i.category, ...(ev.status ? {status: ev.status} : {}), ...(r?.quantity ? {quantity: r.quantity.value, unit: r.quantity.unit} : {}), source: 'farmer',
      });
    }
  }
  for (const c of report.careCompletions) rows.push({date: c.completedOn, kind: 'care', ...(fieldName ? {field: fieldName} : {}), title: c.title, status: 'completed', source: 'farmer'});
  for (const a of report.alerts) {
    rows.push({date: a.validFrom, kind: 'alert', ...(a.fieldId ? {field: report.field?.id === a.fieldId ? report.field.name : a.fieldId} : {}), title: a.title, detail: a.detail, category: a.type, severity: a.severity, status: a.dismissedAt ? 'dismissed' : 'active', source: `${a.source.name} (${a.source.url}, ${a.source.date})`});
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'crop';

/** The CSV text (RFC 4180 line endings, header row, every data cell quoted) and its download file name. */
export function seasonReportCsv(report: SeasonReport): {filename: string; body: string} {
  const lines = [CSV_HEADER.join(',')];
  for (const r of reportRows(report)) {
    lines.push([
      csvCell(r.date), csvCell(r.kind), csvCell(r.field), csvCell(r.title), csvCell(r.detail, CSV_DETAIL_MAX), csvCell(r.category), csvCell(r.severity), csvCell(r.status),
      csvCell(r.quantity), csvCell(r.unit), csvCell(r.amount), csvCell(r.source),
    ].join(','));
  }
  return {filename: `season-${slug(cycleCropName(report.cycle))}-${report.cycle.sowingDate}.csv`, body: `${lines.join('\r\n')}\r\n`};
}
