/** Pure journal model: draft handling, request building, proposal state machine, "Why this changed" summaries. No DOM, no network. */

export const ACTIVITIES = [
  { value: "observation", label: "Field observation" },
  { value: "planting", label: "Planting" },
  { value: "irrigation", label: "Irrigation" },
  { value: "weeding", label: "Weeding" },
  { value: "fertilizer", label: "Fertilizer or compost" },
  { value: "pest_check", label: "Pest or disease check" },
  { value: "harvest", label: "Harvest" },
  { value: "sale", label: "Sale" },
  { value: "expense", label: "Expense only" },
  { value: "other", label: "Other" },
] as const;
export type Activity = (typeof ACTIVITIES)[number]["value"];

export const QUANTITY_UNITS = ["kg", "L", "m3", "mm", "ha", "acre", "days", "g", "t", "quintal"] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];
export const MAX_PHOTOS = 4;

export interface Draft {
  clientEntryId: string;
  farmId: string;
  observedOn: string;
  note: string;
  language: "en" | "ta" | "hi";
  activity: Activity | "";
  quantityValue: string;
  quantityUnit: QuantityUnit;
  expenseInr: string;
  expenseCategory: string;
  /** Farmer-reported sale proceeds in rupees; used only when the activity is "sale". */
  saleInr: string;
  saleNote: string;
  stageId: string;
  mediaIds: string[];
  updatedAt: number;
}

export const todayLocal = (now = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

export function newDraft(farmId: string, clientEntryId: string, today = todayLocal()): Draft {
  return { clientEntryId, farmId, observedOn: today, note: "", language: "en", activity: "observation", quantityValue: "", quantityUnit: "kg", expenseInr: "", expenseCategory: "other", saleInr: "", saleNote: "", stageId: "", mediaIds: [], updatedAt: 0 };
}

const MONEY = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

export type DraftIssue = { field: "observedOn" | "quantity" | "expense" | "sale" | "empty"; message: string };

/** Sale fields apply only to a "sale" entry; for any other activity they are hidden and never sent. */
export const hasSaleFields = (d: Pick<Draft, "activity">): boolean => d.activity === "sale";

export function draftIssues(d: Draft, today = todayLocal()): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.observedOn)) out.push({ field: "observedOn", message: "Choose the date you saw this." });
  else if (d.observedOn > today) out.push({ field: "observedOn", message: "The observation date cannot be in the future." });
  if (d.quantityValue.trim()) {
    const n = Number(d.quantityValue);
    if (!Number.isFinite(n) || n <= 0) out.push({ field: "quantity", message: "Quantity must be a number above zero." });
  }
  if (d.expenseInr.trim() && !MONEY.test(d.expenseInr.trim())) out.push({ field: "expense", message: "Enter the expense in rupees, for example 250 or 250.50." });
  if (hasSaleFields(d) && d.saleInr.trim() && !MONEY.test(d.saleInr.trim())) out.push({ field: "sale", message: "Enter the sale amount in rupees as a number that is not negative, for example 4200 or 4200.50." });
  const hasContent = d.note.trim() || d.mediaIds.length > 0 || d.quantityValue.trim() || d.expenseInr.trim() || (hasSaleFields(d) && d.saleInr.trim()) || d.stageId || (d.activity && d.activity !== "observation");
  if (!hasContent) out.push({ field: "empty", message: "Add a photo, a note, a quantity, an expense or a sale amount." });
  return out;
}

export const canSubmit = (d: Draft, today?: string): boolean => draftIssues(d, today).length === 0;

/** Request body for POST /api/v1/journal. The same clientEntryId is sent on every retry, so a retry cannot duplicate the entry. */
export function draftToBody(d: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { clientEntryId: d.clientEntryId, farmId: d.farmId, observedOn: d.observedOn, language: d.language, mediaIds: d.mediaIds };
  if (d.note.trim()) body.note = d.note.trim();
  if (d.activity) body.activity = d.activity;
  if (d.quantityValue.trim()) body.quantity = { value: Number(d.quantityValue), unit: d.quantityUnit };
  if (d.expenseInr.trim()) body.expense = { amountInr: d.expenseInr.trim(), category: d.expenseCategory.trim() || "other" };
  if (hasSaleFields(d) && d.saleInr.trim() && MONEY.test(d.saleInr.trim())) {
    const note = d.saleNote.trim().slice(0, 120);
    body.sale = { amountInr: d.saleInr.trim(), ...(note ? { note } : {}) };
  }
  if (d.stageId) body.stageId = d.stageId;
  return body;
}

export const idempotencyKeyFor = (d: Pick<Draft, "clientEntryId">): string => `jrnl-${d.clientEntryId}`.slice(0, 128);

// ---------------------------------------------------------------- draft persistence

/** Minimal async key-value store; IndexedDB in the browser, a Map in tests. */
export interface KeyValueStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  constructor(readonly map = new Map<string, unknown>()) {}
  async get(key: string) {
    const v = this.map.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  async set(key: string, value: unknown) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

/** Namespaces every key by owner scope so a draft written for one workspace is unreachable from another. */
export function scopedStore<T extends KeyValueStore>(store: T, scope: () => string): KeyValueStore & { persistent?: boolean | undefined } {
  const k = (key: string) => `s:${scope()}:${key}`;
  return {
    get persistent() {
      return (store as { persistent?: boolean }).persistent;
    },
    get: (key) => store.get(k(key)),
    set: (key, value) => store.set(k(key), value),
    delete: (key) => store.delete(k(key)),
  };
}

const draftKey = (id: string) => `draft:${id}`;
const pointerKey = (farmId: string) => `current:${farmId}`;

export async function saveDraft(store: KeyValueStore, d: Draft, now = Date.now()): Promise<Draft> {
  const saved = { ...d, updatedAt: now };
  await store.set(draftKey(d.clientEntryId), saved);
  await store.set(pointerKey(d.farmId), d.clientEntryId);
  return saved;
}

function isDraft(v: unknown): v is Draft {
  const d = v as Partial<Draft> | null;
  return !!d && typeof d.clientEntryId === "string" && typeof d.farmId === "string" && typeof d.observedOn === "string" && Array.isArray(d.mediaIds) && typeof d.note === "string";
}

/** Drafts saved before the sale fields existed lack them; they read as empty rather than undefined. */
function withDefaults(d: Draft): Draft {
  const x = d as Draft & { saleInr?: unknown; saleNote?: unknown };
  return { ...d, saleInr: typeof x.saleInr === "string" ? x.saleInr : "", saleNote: typeof x.saleNote === "string" ? x.saleNote : "" };
}

/** The farm's unsent draft, or null. A damaged record is ignored rather than crashing the page. */
export async function loadCurrentDraft(store: KeyValueStore, farmId: string): Promise<Draft | null> {
  const id = await store.get(pointerKey(farmId));
  if (typeof id !== "string") return null;
  const d = await store.get(draftKey(id));
  return isDraft(d) && d.farmId === farmId ? withDefaults(d) : null;
}

/** Called only after the server confirmed the save. */
export async function clearDraft(store: KeyValueStore, d: Pick<Draft, "clientEntryId" | "farmId">): Promise<void> {
  await store.delete(draftKey(d.clientEntryId));
  const cur = await store.get(pointerKey(d.farmId));
  if (cur === d.clientEntryId) await store.delete(pointerKey(d.farmId));
}

// ---------------------------------------------------------------- proposal state machine

export type ProposalStatus = "pending" | "reviewing" | "saving" | "confirmed" | "rejected" | "stale" | "error";
export interface ProposalState {
  status: ProposalStatus;
  /** What the in-flight or failed request was trying to do. */
  decision: "accept" | "reject" | null;
  error: string | null;
}
export type ProposalEvent =
  | { type: "accept"; planChanging: boolean }
  | { type: "reject" }
  | { type: "cancel_review" }
  | { type: "confirm_plan_change" }
  | { type: "saved"; decision: "accept" | "reject" }
  | { type: "failed"; code: string; message: string }
  | { type: "retry" };

export const initialProposal: ProposalState = { status: "pending", decision: null, error: null };

/**
 * A proposal never changes anything by itself. A plan-changing accept first shows the diff ("reviewing") and only the
 * explicit confirm sends the request. Non-plan accepts and rejects send at once. Decisions are final once saved.
 */
export function proposalReducer(s: ProposalState, e: ProposalEvent): ProposalState {
  switch (e.type) {
    case "accept":
      if (s.status !== "pending") return s;
      return e.planChanging ? { status: "reviewing", decision: "accept", error: null } : { status: "saving", decision: "accept", error: null };
    case "reject":
      if (s.status !== "pending" && s.status !== "reviewing") return s;
      return { status: "saving", decision: "reject", error: null };
    case "cancel_review":
      return s.status === "reviewing" ? initialProposal : s;
    case "confirm_plan_change":
      return s.status === "reviewing" ? { status: "saving", decision: "accept", error: null } : s;
    case "saved":
      if (s.status !== "saving") return s;
      return { status: e.decision === "accept" ? "confirmed" : "rejected", decision: e.decision, error: null };
    case "failed":
      if (s.status !== "saving") return s;
      return e.code === "version_conflict" ? { status: "stale", decision: s.decision, error: e.message } : { status: "error", decision: s.decision, error: e.message };
    case "retry":
      return s.status === "error" ? initialProposal : s;
  }
}

/** Confirm for a plan-changing proposal is allowed only once a preview was actually computed and shown. */
export function canConfirmPlanChange(preview: unknown | null, previewError: string | null): boolean {
  return preview != null && previewError === null;
}

export const isFinalProposal = (s: ProposalState): boolean => s.status === "confirmed" || s.status === "rejected";

// ---------------------------------------------------------------- "Why this changed"

export interface NamedInputLike {
  key: string;
  value: { value: unknown; validFrom?: string | null };
}
export interface ChangeSummaryLike {
  changes: { type: string; [k: string]: unknown }[];
  oldAssumptions: { confirmedInputs: NamedInputLike[] };
  newAssumptions: { confirmedInputs: NamedInputLike[] };
  changedTaskIds: string[];
  addedTaskIds: string[];
  removedTaskIds: string[];
  economicDelta: {
    priceSource: string;
    scenario: string;
    netCashReturnInrPerHa: { old: string | null; new: string | null; delta: string | null };
    breakEvenPriceInrPerKg: { old: string | null; new: string | null; delta: string | null };
  }[];
}

export interface ChangeLine {
  label: string;
  from: string;
  to: string;
}

const stageName = (names: Record<string, string>, id: unknown) => (typeof id === "string" ? (names[id] ?? id) : "not set");
const CATEGORY_LABEL: Record<string, string> = { rainfed: "Rain only", supplemental: "Rain plus some irrigation", irrigated: "Irrigated" };

/** Old to new for each typed change, read from the engine's own summary. Wording never claims the new value was observed. */
export function changeLines(changes: ChangeSummaryLike["changes"], oldInputs: NamedInputLike[], newInputs: NamedInputLike[], stageNames: Record<string, string> = {}): ChangeLine[] {
  const get = (inputs: NamedInputLike[], key: string, pred?: (i: NamedInputLike) => boolean) => inputs.find((i) => i.key === key && (!pred || pred(i)))?.value.value;
  return changes.flatMap((c): ChangeLine[] => {
    switch (c.type) {
      case "observed_stage": {
        const oldObserved = oldInputs.filter((i) => i.key === "observed_stage").map((i) => stageName(stageNames, i.value.value));
        return [{ label: `Stage on ${String(c.observedOn)} (you confirmed)`, from: oldObserved.length ? oldObserved.join(", ") : "calendar estimate", to: stageName(stageNames, c.stageId) }];
      }
      case "irrigation_category": {
        const f = get(oldInputs, "irrigation_category");
        const t = get(newInputs, "irrigation_category");
        return [{ label: "Water", from: typeof f === "string" ? (CATEGORY_LABEL[f] ?? f) : "not set", to: typeof t === "string" ? (CATEGORY_LABEL[t] ?? t) : "not set" }];
      }
      case "planting_date":
        return [{ label: "Planting date", from: String(get(oldInputs, "planting_date") ?? "not set"), to: String(c.date) }];
      case "area":
        return [{ label: "Area", from: String(get(oldInputs, "area") ?? "not set"), to: `${String(c.amount)} ${String(c.unit)}` }];
      default:
        return [{ label: c.type.replace(/_/g, " "), from: "previous value", to: "new value" }];
    }
  });
}

export const formatInr = (v: string | null): string => (v === null ? "not available" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);

export function economicLines(summary: Pick<ChangeSummaryLike, "economicDelta">): string[] {
  return summary.economicDelta
    .filter((d) => d.netCashReturnInrPerHa.delta !== null)
    .map((d) => `${d.scenario} (${d.priceSource}): net cash return per ha ${formatInr(d.netCashReturnInrPerHa.old)} → ${formatInr(d.netCashReturnInrPerHa.new)} (change ${formatInr(d.netCashReturnInrPerHa.delta)})`);
}

// ---------------------------------------------------------------- season totals (farmer-recorded, never an estimate)

/** The parts of a crop cycle the totals need (the workspace `Cycle` fits this shape). */
export interface SeasonCycle {
  id: string;
  cropId: string;
  cropName?: string;
  sowingDate: string;
  establishmentDate?: string;
  harvestDate?: string;
  stage?: string;
}
/** The parts of a saved journal entry the totals need (the API `JournalEntry` fits this shape). */
export interface SeasonEntry {
  observedOn: string;
  activity: string | null;
  quantity?: { value: number; unit: string } | null;
  expense?: { amountInr: string } | null;
  sale?: { amountInr: string } | null;
  /** The entry's facts (the API `JournalEntry.facts` fit this). Only the farmer's original `cycle_id` fact is read, see `attributeEntries`. */
  facts?: readonly { field: string; kind: string; source: string; value: unknown }[];
}

/**
 * The crop cycle an entry names itself: its original farmer `cycle_id` fact (written by scouting issues, issue events, checks and
 * care completions), when it is a non-empty string and that cycle is in `cycleIds`. Anything else (no fact, an AI-proposed fact,
 * an unknown cycle) is null and the date window decides.
 */
function namedCycle(entry: { facts?: SeasonEntry["facts"] }, cycleIds: ReadonlySet<string>): string | null {
  const f = entry.facts?.find((x) => x.field === "cycle_id" && x.kind === "original" && x.source === "farmer");
  return typeof f?.value === "string" && cycleIds.has(f.value) ? f.value : null;
}

export interface SeasonTotalsRow {
  cycleId: string;
  cropId: string;
  cropName?: string;
  sowingDate: string;
  /** First day counted: the establishment date when there is one, otherwise the sowing date. */
  from: string;
  /** The crop's own last day: the harvest date, or today while the crop is still in the field. */
  to: string;
  /** Last day whose entries are attributed here. Equals `to`, except that a harvested crop also takes later entries (sales usually follow harvest); see POST_HARVEST_WINDOW_DAYS. */
  windowTo: string;
  /** True while the crop has no harvest date (the range runs to today). */
  ongoing: boolean;
  active: boolean;
  entries: number;
  /** Rupees, summed in whole paise from the farmer's own entries. */
  expenseInr: number;
  saleInr: number;
  netInr: number;
  /** Kilograms recorded on harvest entries (kg, quintal and t only); null when there is no convertible harvest quantity. */
  harvestKg: number | null;
  /** Harvest entries whose quantity is in another unit and so is not added to harvestKg. */
  harvestUnitsSkipped: number;
  /** Entries counted here that also fall inside another crop's dates (they go to the crop that started last). */
  overlapping: number;
}

/**
 * How long after a harvest date a crop still takes journal entries (sales, transport, storage costs), capped at the day before
 * the next crop starts. 90 days is an ASSUMPTION chosen so that typical post-harvest sales are not dropped; it is not a sourced
 * figure and not specific to any crop. Entries beyond the window are reported separately as outside every crop's dates.
 */
export const POST_HARVEST_WINDOW_DAYS = 90;

/** ISO date plus n days (n may be negative), in UTC so daylight saving cannot shift the day. */
function addDaysIso(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

interface CycleWindow<C extends SeasonCycle> {
  c: C;
  from: string;
  to: string;
  windowTo: string;
}
/**
 * The dates each crop takes entries from. Still in the field: first day to today. Harvested: first day to the earlier of
 * (day before the next crop starts) and (harvest date + POST_HARVEST_WINDOW_DAYS). "Next crop" is the earliest crop that starts
 * after this harvest date, so an overlapping crop never shortens the window below the harvest date.
 */
function windowsOf<C extends SeasonCycle>(cycles: readonly C[], today: string): CycleWindow<C>[] {
  const day = (d: string) => d.slice(0, 10);
  const starts = cycles.map((c) => day(c.establishmentDate ?? c.sowingDate));
  return cycles.map((c) => {
    const from = day(c.establishmentDate ?? c.sowingDate);
    if (!c.harvestDate) return { c, from, to: today, windowTo: today };
    const to = day(c.harvestDate);
    let windowTo = addDaysIso(to, POST_HARVEST_WINDOW_DAYS);
    const nextStart = starts.filter((st) => st > to).sort()[0];
    if (nextStart !== undefined) {
      const dayBefore = addDaysIso(nextStart, -1);
      if (dayBefore < windowTo) windowTo = dayBefore;
    }
    return { c, from, to, windowTo };
  });
}

const PAISE = /^(\d+)(?:\.(\d{1,2}))?$/;
/** "4200.5" to 420050n. Exact: no floating point. Anything that is not a plain non-negative amount is ignored (null). */
export function toPaise(amount: string | null | undefined): bigint | null {
  const m = typeof amount === "string" ? PAISE.exec(amount.trim()) : null;
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}
const rupees = (paise: bigint): number => Number(paise) / 100;

/** Kilogram multiplier of each unit that converts exactly. Other units are not converted. */
export const KG_PER_UNIT: Readonly<Record<string, bigint>> = { kg: 1n, quintal: 100n, t: 1000n };
/** Quantities are stored with 4 decimals; every exact sum here is a bigint count of 1/QUANTITY_SCALE units. */
export const QUANTITY_SCALE = 10_000;
/** A quantity value as an exact count of 1/QUANTITY_SCALE units; null when it is not a finite number above zero (such a value is never added). */
export function scaledQuantity(value: number): bigint | null {
  return Number.isFinite(value) && value > 0 ? BigInt(Math.round(value * QUANTITY_SCALE)) : null;
}

/** ₹4,200 · −₹1,250.50. Indian digit grouping; paise shown only when there are any. */
export function formatRupees(n: number): string {
  const body = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}₹${body}`;
}
export const formatKg = (kg: number): string => `${kg.toLocaleString("en-IN", { maximumFractionDigits: 4 })} kg`;

/** One crop cycle with the entries attributed to it (see seasonTotals for the rule). */
export interface AttributedCycle<C extends SeasonCycle, E extends { observedOn: string }> {
  c: C;
  from: string;
  to: string;
  windowTo: string;
  active: boolean;
  entries: E[];
  /** Entries counted here that also fall inside another crop's dates. */
  overlapping: number;
}

/**
 * The attribution rule shared by the season totals and the records: cycles sorted (crops still in the field first, then newest
 * sowing first), each with the entries whose observation date lies in its window (see windowsOf), an entry that several windows
 * contain going to the cycle with the latest `from` (ties: the first listed). Entries in no window are dropped. An entry that names
 * an existing cycle in its original farmer `cycle_id` fact goes to that cycle whatever its date and is never counted as overlapping.
 */
export function attributeEntries<C extends SeasonCycle, E extends { observedOn: string; facts?: SeasonEntry["facts"] }>(entries: readonly E[], cycles: readonly C[], today: string): AttributedCycle<C, E>[] {
  const day = (d: string) => d.slice(0, 10);
  const isActive = (c: SeasonCycle) => (c.stage !== undefined ? c.stage !== "harvested" : !c.harvestDate);
  const ordered = [...cycles].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || day(b.sowingDate).localeCompare(day(a.sowingDate)) || a.id.localeCompare(b.id));
  const ranges = windowsOf(ordered, today);
  const out: AttributedCycle<C, E>[] = ranges.map((r) => ({ ...r, active: isActive(r.c), entries: [], overlapping: 0 }));
  const ids = new Set(ordered.map((c) => c.id));
  for (const e of entries) {
    const named = namedCycle(e, ids);
    if (named !== null) {
      // The entry says which crop it belongs to: that wins over the dates, and it is not an overlap guess.
      out[ordered.findIndex((c) => c.id === named)]!.entries.push(e);
      continue;
    }
    const when = day(e.observedOn);
    let home = -1;
    let containing = 0;
    ranges.forEach((r, i) => {
      if (when < r.from || when > r.windowTo) return;
      containing += 1;
      if (home === -1 || r.from > ranges[home]!.from) home = i;
    });
    if (home === -1) continue;
    out[home]!.entries.push(e);
    if (containing > 1) out[home]!.overlapping += 1;
  }
  return out;
}

/**
 * One row per crop cycle: what the farmer wrote down while the crop was in the field and, for a harvested crop, in the
 * window after harvest (see windowsOf), added in code. An entry belongs to the cycle whose window contains its observation date
 * (inclusive), unless its original farmer `cycle_id` fact names an existing cycle, which wins. If several contain it, it goes to the cycle with the latest `from` (ties: the cycle listed first) and is counted in
 * that row's `overlapping`. Sorted: crops still in the field first, then by sowing date, newest first.
 */
export function seasonTotals(entries: readonly SeasonEntry[], cycles: readonly SeasonCycle[], today: string): SeasonTotalsRow[] {
  const day = (d: string) => d.slice(0, 10);
  const ranges = attributeEntries(entries, cycles, today);

  const acc = ranges.map((r) => {
    const a = { entries: r.entries.length, expense: 0n, sale: 0n, harvest: 0n, haveHarvest: false, skipped: 0, overlapping: r.overlapping };
    for (const e of r.entries) {
      a.expense += toPaise(e.expense?.amountInr) ?? 0n;
      a.sale += toPaise(e.sale?.amountInr) ?? 0n;
      if (e.activity === "harvest" && e.quantity) {
        const factor = KG_PER_UNIT[e.quantity.unit];
        if (factor === undefined) a.skipped += 1;
        else {
          const q = scaledQuantity(e.quantity.value);
          if (q !== null) {
            a.harvest += q * factor;
            a.haveHarvest = true;
          }
        }
      }
    }
    return a;
  });

  return ranges.map((r, i) => {
    const a = acc[i]!;
    return {
      cycleId: r.c.id,
      cropId: r.c.cropId,
      ...(r.c.cropName !== undefined ? { cropName: r.c.cropName } : {}),
      sowingDate: day(r.c.sowingDate),
      from: r.from,
      to: r.to,
      windowTo: r.windowTo,
      ongoing: !r.c.harvestDate,
      active: r.active,
      entries: a.entries,
      expenseInr: rupees(a.expense),
      saleInr: rupees(a.sale),
      netInr: rupees(a.sale - a.expense),
      harvestKg: a.haveHarvest ? Number(a.harvest) / QUANTITY_SCALE : null,
      harvestUnitsSkipped: a.skipped,
      overlapping: a.overlapping,
    };
  });
}

/** Entries that carry an expense or sale amount but fall inside no crop's window (for example seed bought before sowing or a sale long after the harvest). They are not in any row. */
export function amountsOutsideCycles(entries: readonly SeasonEntry[], cycles: readonly SeasonCycle[], today: string): number {
  const windows = windowsOf(cycles, today);
  const ids = new Set(cycles.map((c) => c.id));
  return entries.filter((e) => {
    if (namedCycle(e, ids) !== null) return false;
    if (toPaise(e.expense?.amountInr) === null && toPaise(e.sale?.amountInr) === null) return false;
    const when = e.observedOn.slice(0, 10);
    return !windows.some((w) => when >= w.from && when <= w.windowTo);
  }).length;
}
