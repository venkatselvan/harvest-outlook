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
  stageId: string;
  mediaIds: string[];
  updatedAt: number;
}

export const todayLocal = (now = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

export function newDraft(farmId: string, clientEntryId: string, today = todayLocal()): Draft {
  return { clientEntryId, farmId, observedOn: today, note: "", language: "en", activity: "observation", quantityValue: "", quantityUnit: "kg", expenseInr: "", expenseCategory: "other", stageId: "", mediaIds: [], updatedAt: 0 };
}

const MONEY = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

export type DraftIssue = { field: "observedOn" | "quantity" | "expense" | "empty"; message: string };

export function draftIssues(d: Draft, today = todayLocal()): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.observedOn)) out.push({ field: "observedOn", message: "Choose the date you saw this." });
  else if (d.observedOn > today) out.push({ field: "observedOn", message: "The observation date cannot be in the future." });
  if (d.quantityValue.trim()) {
    const n = Number(d.quantityValue);
    if (!Number.isFinite(n) || n <= 0) out.push({ field: "quantity", message: "Quantity must be a number above zero." });
  }
  if (d.expenseInr.trim() && !MONEY.test(d.expenseInr.trim())) out.push({ field: "expense", message: "Enter the expense in rupees, for example 250 or 250.50." });
  const hasContent = d.note.trim() || d.mediaIds.length > 0 || d.quantityValue.trim() || d.expenseInr.trim() || d.stageId || (d.activity && d.activity !== "observation");
  if (!hasContent) out.push({ field: "empty", message: "Add a photo, a note, a quantity or an expense." });
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

/** The farm's unsent draft, or null. A damaged record is ignored rather than crashing the page. */
export async function loadCurrentDraft(store: KeyValueStore, farmId: string): Promise<Draft | null> {
  const id = await store.get(pointerKey(farmId));
  if (typeof id !== "string") return null;
  const d = await store.get(draftKey(id));
  return isDraft(d) && d.farmId === farmId ? d : null;
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
