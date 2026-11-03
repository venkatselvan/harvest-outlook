import {
  IssueCategory as categorySchema,
  IssueSeverity as severitySchema,
  IssueStatus as statusSchema,
  ResponseMethod as methodSchema,
  pointInRing,
  type AddIssueEvent,
  type CompleteCheck,
  type CompleteCheckResult,
  type CreateIssue,
  type FieldCheck,
  type FieldIssue,
  type IssueCategory,
  type IssueEvent,
  type IssueLocation,
  type IssueResponse,
  type IssueSeverity,
  type IssueStatus,
  type PhotoMark,
  type ResponseMethod,
  type TodayView,
  type UpcomingStep,
} from "@harvest/contracts";
import type { KeyValueStore } from "../../features/journal/model";
import { formatDay } from "../today/model";
import { describeScoutingError, KEPT_ON_DEVICE, type ScoutingErrorInfo } from "./scoutingApi";

/**
 * Pure helpers of the field checks and the issue log (docs/research/FIELD_OPERATIONS_SPEC.md 2 to 6, 8.4). The components
 * call these; the tests (node, no DOM) exercise them directly.
 *
 * Wording rules: category, severity and status are what the farmer reported; a response is what the farmer did. Nothing
 * here names a product, a dose, a rate or a timing, and nothing diagnoses. A label wait is the farmer's own reading of a
 * label, turned into a date by the server's arithmetic.
 */

// ---------------------------------------------------------------- labels

export const CATEGORIES = categorySchema.options;
export const SEVERITIES = severitySchema.options;
export const STATUSES = statusSchema.options;
export const METHODS = methodSchema.options;
export const QUANTITY_UNITS = ["kg", "g", "L", "mL", "ha", "acre", "other"] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  pest: "Pest",
  disease: "Disease",
  weed: "Weed",
  water_stress: "Water stress",
  nutrient: "Nutrient",
  weather_damage: "Weather damage",
  animal_damage: "Animal damage",
  other: "Other",
};
/** A short glyph per category for the row badge (decorative; the label is always written next to it). */
export const CATEGORY_MARK: Record<IssueCategory, string> = {
  pest: "P",
  disease: "D",
  weed: "W",
  water_stress: "H₂O",
  nutrient: "N",
  weather_damage: "WX",
  animal_damage: "A",
  other: "?",
};
export const SEVERITY_LABEL: Record<IssueSeverity, string> = { low: "Low", medium: "Medium", high: "High" };
export const STATUS_LABEL: Record<IssueStatus, string> = { open: "Open", treating: "Being treated", resolved: "Resolved", dismissed: "Dismissed" };
export const METHOD_LABEL: Record<ResponseMethod, string> = {
  cultural: "Cultural practice",
  mechanical: "By hand or with a tool",
  biological: "Biological",
  irrigation: "Irrigation",
  nutrition: "Nutrition",
  product_applied: "Applied a product",
  other: "Other",
};
export const EVENT_LABEL: Record<IssueEvent["kind"], string> = {
  reported: "Reported",
  status_changed: "Status changed",
  response_recorded: "What you did",
  recheck_scheduled: "Recheck set",
  note_added: "Note",
};
export const GENERAL_PROMPTS_LABEL = "General prompts (not crop-specific advice)";
export const LABEL_WAIT_HELP = "Only what you read on the label; the app does not check it.";
export const FARMER_REPORTED = "What you reported. The app does not diagnose or confirm an issue.";
export const MAX_PHOTOS = 4;
export const MAX_MARKS = 12;
export const MAX_CHECK_ISSUES = 10;
export const DEFAULT_INTERVAL_DAYS = 7;
export const MIN_INTERVAL_DAYS = 3;
export const MAX_INTERVAL_DAYS = 30;

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (value: string) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const addDaysIso = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** The device's local calendar date (used only when the server's today is not known). */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const day = (date: string | null | undefined) => formatDay(date ?? null);

// ---------------------------------------------------------------- field check steps

export const isFieldCheck = (step: UpcomingStep) => step.kind === "field_check";
export const isRecheck = (step: UpcomingStep) => step.kind === "field_check" && (step.fieldCheck?.kind === "recheck" || !!step.issueId);
/** A field check that is not done yet can be completed (an interval walk or a recheck). */
export const canCompleteCheck = (step: UpcomingStep) => step.kind === "field_check" && !!step.fieldCheck && step.status !== "completed";

/** "Your check interval: every 7 days (your own setting)" for an interval check; null for a recheck. */
export function intervalCaption(check: Pick<FieldCheck, "kind" | "intervalDays">): string | null {
  if (check.kind !== "interval") return null;
  const days = check.intervalDays ?? DEFAULT_INTERVAL_DAYS;
  return `Your check interval: every ${days} day${days === 1 ? "" : "s"} (your own setting)`;
}
/** "2 earlier checks were missed" when the server rolled a long-overdue check forward; null without a count (older servers). */
export function missedText(check: FieldCheck): string | null {
  const n = (check as FieldCheck & { missedCount?: number }).missedCount;
  if (!n || n < 1) return null;
  return n === 1 ? "1 earlier check was missed; this is the latest one." : `${n} earlier checks were missed; this is the latest one.`;
}
export const riskItems = (check: FieldCheck) => check.checklist.filter((item) => item.kind === "risk_window");
export const generalItems = (check: FieldCheck) => check.checklist.filter((item) => item.kind === "general");

// ---------------------------------------------------------------- optimistic completion

export const withId = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
export function withoutId(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

export interface CheckCompletionHooks {
  /** Show the step as done at once. */
  mark: () => void;
  /** Undo `mark` after a failure. */
  unmark: () => void;
  send: (body: CompleteCheck) => Promise<CompleteCheckResult>;
  /** Clears the device draft after the server confirmed the save. */
  clearDraft: () => Promise<void>;
}
export type CheckCompletionOutcome = { ok: true; result: CompleteCheckResult } | { ok: false; error: ScoutingErrorInfo; kept: string | null };
/**
 * The optimistic completion: mark, send, clear the draft on success; on any failure unmark and keep the draft (a network
 * failure says "Kept on this device; try again when online").
 */
export async function runCheckCompletion(body: CompleteCheck, hooks: CheckCompletionHooks): Promise<CheckCompletionOutcome> {
  hooks.mark();
  try {
    const result = await hooks.send(body);
    await hooks.clearDraft().catch(() => undefined);
    return { ok: true, result };
  } catch (error) {
    hooks.unmark();
    const info = describeScoutingError(error);
    return { ok: false, error: info, kept: info.kind === "network" ? KEPT_ON_DEVICE : null };
  }
}

/**
 * The notice after a completed check. When the server says the check was already completed (a replay, or another device got
 * there first) it kept the earlier record, so this submission's note and answers are not claimed as saved.
 */
export function checkCompletionNotice(result: Pick<CompleteCheckResult, "alreadyCompleted"> & { check: Pick<FieldCheck, "completedOn"> }): string {
  if (!result.alreadyCompleted) return "Field check recorded in your field journal.";
  const when = result.check.completedOn ? `on ${formatDay(result.check.completedOn)}` : "earlier";
  return `Already recorded ${when}. The earlier record was kept unchanged.`;
}

// ---------------------------------------------------------------- drafts (spec 8.4)

export type DraftKind = "issue" | "check" | "response";
const draftKey = (kind: DraftKind, id: string) => `scouting:${kind}:${id}`;
const slotKey = (kind: DraftKind, farmId: string, slot: string) => `scouting:${kind}-at:${farmId}:${slot}`;
interface Drafted {
  clientEntryId: string;
  farmId: string;
}
/**
 * Writes the draft under its client entry id and points the farm's slot (a new issue, one check, one issue's response) at
 * it. The store is the owner-scoped journal draft database, so a sign-out or farm deletion purges it with the journal's.
 */
export async function saveScoutingDraft<T extends Drafted>(store: KeyValueStore, kind: DraftKind, slot: string, draft: T, now = Date.now()): Promise<void> {
  await store.set(draftKey(kind, draft.clientEntryId), { ...draft, updatedAt: now });
  await store.set(slotKey(kind, draft.farmId, slot), draft.clientEntryId);
}
/** The slot's unsent draft, or null; a damaged or foreign record is ignored. */
export async function loadScoutingDraft<T extends Drafted>(store: KeyValueStore, kind: DraftKind, farmId: string, slot: string, valid: (value: unknown) => value is T): Promise<T | null> {
  const id = await store.get(slotKey(kind, farmId, slot));
  if (typeof id !== "string") return null;
  const value = await store.get(draftKey(kind, id));
  return valid(value) && value.farmId === farmId && value.clientEntryId === id ? value : null;
}
export async function clearScoutingDraft(store: KeyValueStore, kind: DraftKind, farmId: string, slot: string, clientEntryId: string): Promise<void> {
  await store.delete(draftKey(kind, clientEntryId));
  if ((await store.get(slotKey(kind, farmId, slot))) === clientEntryId) await store.delete(slotKey(kind, farmId, slot));
}

// ---------------------------------------------------------------- check completion draft

export interface CheckDraft {
  clientEntryId: string;
  farmId: string;
  checkId: string;
  completedOn: string;
  result: "" | "nothing_found" | "issues_found";
  note: string;
  issueIds: string[];
  /** Titles of the issues logged from this check, for the form only. */
  issueTitles: Record<string, string>;
}
export const newCheckDraft = (farmId: string, checkId: string, clientEntryId: string, today: string): CheckDraft => ({
  clientEntryId,
  farmId,
  checkId,
  completedOn: today,
  result: "",
  note: "",
  issueIds: [],
  issueTitles: {},
});
export function isCheckDraft(value: unknown): value is CheckDraft {
  const d = value as Partial<CheckDraft> | null;
  return !!d && typeof d.clientEntryId === "string" && typeof d.farmId === "string" && typeof d.checkId === "string" && typeof d.completedOn === "string" && typeof d.note === "string" && Array.isArray(d.issueIds);
}
export function checkProblems(d: CheckDraft, today: string): string[] {
  const out: string[] = [];
  if (!isIsoDate(d.completedOn)) out.push("Enter the date you walked the field.");
  else if (d.completedOn > today) out.push("The date cannot be in the future.");
  if (!d.result) out.push("Choose what you found: nothing, or issues.");
  if (d.result === "nothing_found" && d.issueIds.length) out.push("You logged issues on this walk. Choose Issues found, or remove them from this check.");
  if (d.issueIds.length > MAX_CHECK_ISSUES) out.push(`At most ${MAX_CHECK_ISSUES} issues can be listed on one check.`);
  if (d.note.trim().length > 2000) out.push("The note is longer than 2000 characters.");
  return out;
}
export function checkBody(d: CheckDraft): CompleteCheck {
  const note = d.note.trim();
  return {
    clientEntryId: d.clientEntryId,
    checkId: d.checkId,
    completedOn: d.completedOn,
    result: d.result === "issues_found" ? "issues_found" : "nothing_found",
    ...(note ? { note } : {}),
    issueIds: d.result === "issues_found" ? [...d.issueIds] : [],
  };
}

// ---------------------------------------------------------------- issue draft

export interface IssuePrefill {
  category?: IssueCategory | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  mediaIds?: string[] | undefined;
  /** The accepted AI suggestion this issue comes from (packet O2b). */
  fromFactId?: string | undefined;
  /** The date it was seen (the journal entry's date); ignored when not a real date or later than today. */
  observedOn?: string | undefined;
}
export interface IssueDraft {
  clientEntryId: string;
  farmId: string;
  fieldId: string;
  observedOn: string;
  category: IssueCategory | "";
  severity: IssueSeverity | "";
  title: string;
  detail: string;
  mediaIds: string[];
  photoMarks: PhotoMark[];
  location: IssueLocation | null;
  /** Where the location came from (form only; not sent). */
  locationSource: "device" | "map" | null;
  fromFactId: string | null;
}
export function newIssueDraft(farmId: string, clientEntryId: string, today: string, fieldId: string | null | undefined, prefill?: IssuePrefill): IssueDraft {
  return {
    clientEntryId,
    farmId,
    fieldId: fieldId ?? "",
    observedOn: prefill?.observedOn && isIsoDate(prefill.observedOn) && prefill.observedOn <= today ? prefill.observedOn : today,
    category: prefill?.category ?? "",
    severity: "",
    title: (prefill?.title ?? "").slice(0, 120),
    detail: (prefill?.detail ?? "").slice(0, 2000),
    mediaIds: [...new Set(prefill?.mediaIds ?? [])].slice(0, MAX_PHOTOS),
    photoMarks: [],
    location: null,
    locationSource: null,
    fromFactId: prefill?.fromFactId ?? null,
  };
}
export function isIssueDraft(value: unknown): value is IssueDraft {
  const d = value as Partial<IssueDraft> | null;
  return !!d && typeof d.clientEntryId === "string" && typeof d.farmId === "string" && typeof d.observedOn === "string" && typeof d.title === "string" && typeof d.detail === "string" && Array.isArray(d.mediaIds) && Array.isArray(d.photoMarks);
}
export interface IssueProblem {
  field: "fieldId" | "observedOn" | "category" | "severity" | "title" | "detail" | "photos" | "location";
  message: string;
}
export function issueProblems(d: IssueDraft, ctx: { today: string; hasFields: boolean }): IssueProblem[] {
  const out: IssueProblem[] = [];
  if (ctx.hasFields && !d.fieldId) out.push({ field: "fieldId", message: "Choose the field where you saw it." });
  if (!isIsoDate(d.observedOn)) out.push({ field: "observedOn", message: "Enter the date you saw it." });
  else if (d.observedOn > ctx.today) out.push({ field: "observedOn", message: "The date cannot be in the future." });
  if (!d.category) out.push({ field: "category", message: "Choose what kind of issue it is." });
  if (!d.severity) out.push({ field: "severity", message: "Choose how bad it looks to you." });
  if (!d.title.trim()) out.push({ field: "title", message: "Give the issue a short title." });
  else if (d.title.trim().length > 120) out.push({ field: "title", message: "Keep the title to 120 characters." });
  if (d.detail.trim().length > 2000) out.push({ field: "detail", message: "Keep the description to 2000 characters." });
  if (d.mediaIds.length > MAX_PHOTOS) out.push({ field: "photos", message: `At most ${MAX_PHOTOS} photos.` });
  if (d.photoMarks.length > MAX_MARKS) out.push({ field: "photos", message: `At most ${MAX_MARKS} marks across the photos.` });
  if (d.photoMarks.some((m) => !d.mediaIds.includes(m.mediaId))) out.push({ field: "photos", message: "A mark is on a photo that was removed." });
  return out;
}
export function issueBody(d: IssueDraft): CreateIssue {
  const detail = d.detail.trim();
  return {
    clientEntryId: d.clientEntryId,
    ...(d.fieldId ? { fieldId: d.fieldId } : {}),
    observedOn: d.observedOn,
    category: d.category as IssueCategory,
    severity: d.severity as IssueSeverity,
    title: d.title.trim(),
    ...(detail ? { detail } : {}),
    ...(d.location ? { location: { lat: d.location.lat, lon: d.location.lon } } : {}),
    mediaIds: [...d.mediaIds],
    photoMarks: d.photoMarks
      .filter((m) => d.mediaIds.includes(m.mediaId))
      .map((m) => {
        const label = m.label?.trim().slice(0, 40);
        return label ? { mediaId: m.mediaId, x: m.x, y: m.y, label } : { mediaId: m.mediaId, x: m.x, y: m.y };
      }),
    ...(d.fromFactId ? { fromFactId: d.fromFactId } : {}),
  };
}
/** Removing a photo drops its marks with it. */
export const withoutPhoto = (d: IssueDraft, mediaId: string): Pick<IssueDraft, "mediaIds" | "photoMarks"> => ({
  mediaIds: d.mediaIds.filter((id) => id !== mediaId),
  photoMarks: d.photoMarks.filter((m) => m.mediaId !== mediaId),
});

// ---------------------------------------------------------------- photo marks (normalised 0..1 from the top-left)

const round4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
/**
 * The normalised position of a tap on the displayed photo. The photo is drawn at its own aspect ratio (no crop), so the
 * fraction of the drawn box is the fraction of the normalised derivative. A keyboard activation (no pointer position)
 * marks the centre.
 */
export function markPosition(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, keyboard = false): { x: number; y: number } {
  if (keyboard || rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return { x: round4((clientX - rect.left) / rect.width), y: round4((clientY - rect.top) / rect.height) };
}
/** Adds a mark (at most MAX_MARKS across the issue's photos); unchanged when full. */
export function addMark(marks: readonly PhotoMark[], mediaId: string, x: number, y: number): PhotoMark[] {
  if (marks.length >= MAX_MARKS) return [...marks];
  return [...marks, { mediaId, x: round4(x), y: round4(y) }];
}
export const removeMark = (marks: readonly PhotoMark[], index: number): PhotoMark[] => marks.filter((_, i) => i !== index);
export function labelMark(marks: readonly PhotoMark[], index: number, label: string): PhotoMark[] {
  return marks.map((m, i) => {
    if (i !== index) return m;
    const text = label.slice(0, 40);
    if (text.trim()) return { ...m, label: text };
    const { label: _drop, ...rest } = m;
    return rest;
  });
}
/** The marks on one photo with their index in the issue's list (the number shown on the photo). */
export const marksOn = (marks: readonly PhotoMark[], mediaId: string) =>
  marks.flatMap((m, index) => (m.mediaId === mediaId ? [{ ...m, index, number: index + 1 }] : []));

// ---------------------------------------------------------------- location

export interface Ring {
  coordinates: number[][][];
}
/** Inside every given polygon (the farm and, when chosen, the field). Without any polygon nothing can be checked here. */
export function locationInside(point: IssueLocation, polygons: readonly (Ring | null | undefined)[]): boolean {
  const rings = polygons.filter((p): p is Ring => !!p && (p.coordinates[0]?.length ?? 0) >= 4).map((p) => p.coordinates[0] as [number, number][]);
  return rings.every((ring) => pointInRing([point.lon, point.lat], ring));
}
export const locationText = (point: IssueLocation) => `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
/** Plain message for a GeolocationPositionError code (1 denied, 2 unavailable, 3 timeout). */
export function geolocationMessage(code: number | "unsupported"): string {
  if (code === "unsupported") return "This device cannot share its location. Mark the spot on the map, or leave the location empty.";
  if (code === 1) return "Location permission is off. Mark the spot on the map instead, or leave the location empty.";
  if (code === 3) return "Your location took too long to find. Try again, or mark the spot on the map.";
  return "Your location is not available right now. Mark the spot on the map, or leave the location empty.";
}
export const outsideMessage = (place: string | null) =>
  place ? `That spot is outside ${place}. Mark a spot inside it, or leave the location empty.` : "That spot is outside the farm. Mark a spot inside it, or leave the location empty.";

// ---------------------------------------------------------------- responses (spec 6)

export interface ResponseDraft {
  clientEntryId: string;
  farmId: string;
  issueId: string;
  occurredOn: string;
  method: ResponseMethod | "";
  description: string;
  productName: string;
  quantityValue: string;
  quantityUnit: QuantityUnit | "";
  labelWaitDays: string;
  recheckOn: string;
}
export const newResponseDraft = (farmId: string, issueId: string, clientEntryId: string, today: string): ResponseDraft => ({
  clientEntryId,
  farmId,
  issueId,
  occurredOn: today,
  method: "",
  description: "",
  productName: "",
  quantityValue: "",
  quantityUnit: "",
  labelWaitDays: "",
  recheckOn: addDaysIso(today, 7),
});
export function isResponseDraft(value: unknown): value is ResponseDraft {
  const d = value as Partial<ResponseDraft> | null;
  return !!d && typeof d.clientEntryId === "string" && typeof d.farmId === "string" && typeof d.issueId === "string" && typeof d.description === "string" && typeof d.recheckOn === "string";
}
const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(",", ".")));
export function responseProblems(d: ResponseDraft, ctx: { today: string; observedOn: string }): string[] {
  const out: string[] = [];
  if (!isIsoDate(d.occurredOn)) out.push("Enter the date you did it.");
  else if (d.occurredOn > ctx.today) out.push("The date cannot be in the future.");
  else if (d.occurredOn < ctx.observedOn) out.push(`The date cannot be before the issue was seen (${day(ctx.observedOn)}).`);
  if (!d.method) out.push("Choose how you dealt with it.");
  if (!d.description.trim()) out.push("Say what you did, in your own words.");
  else if (d.description.trim().length > 1000) out.push("Keep the description to 1000 characters.");
  if (d.productName.trim().length > 120) out.push("Keep the product name to 120 characters.");
  const qty = numberOf(d.quantityValue);
  if (qty !== null && (!Number.isFinite(qty) || qty <= 0 || qty > 1e9)) out.push("The quantity must be a number above zero.");
  if (qty !== null && !d.quantityUnit) out.push("Choose the unit of the quantity.");
  const wait = numberOf(d.labelWaitDays);
  if (wait !== null && (!Number.isInteger(wait) || wait < 0 || wait > 365)) out.push("The label wait must be whole days from 0 to 365.");
  if (d.recheckOn && !isIsoDate(d.recheckOn)) out.push("Enter a valid recheck date, or clear it.");
  else if (d.recheckOn && isIsoDate(d.occurredOn) && d.recheckOn < d.occurredOn) out.push("The recheck date cannot be before the date you did it.");
  return out;
}
export function responseEvent(d: ResponseDraft): AddIssueEvent {
  const qty = numberOf(d.quantityValue);
  const wait = numberOf(d.labelWaitDays);
  const product = d.productName.trim();
  const response: IssueResponse = {
    method: d.method as ResponseMethod,
    description: d.description.trim(),
    ...(product ? { productName: product } : {}),
    ...(qty !== null && d.quantityUnit ? { quantity: { value: qty, unit: d.quantityUnit } } : {}),
    ...(wait !== null ? { labelWaitDays: wait } : {}),
    ...(d.recheckOn ? { recheckOn: d.recheckOn } : {}),
  };
  return { clientEntryId: d.clientEntryId, occurredOn: d.occurredOn, kind: "response_recorded", response, mediaIds: [] };
}
export function statusEvent(clientEntryId: string, occurredOn: string, status: IssueStatus, note: string): AddIssueEvent {
  const text = note.trim();
  return { clientEntryId, occurredOn, kind: "status_changed", status, ...(text ? { note: text } : {}), mediaIds: [] };
}
export const noteEvent = (clientEntryId: string, occurredOn: string, note: string): AddIssueEvent => ({ clientEntryId, occurredOn, kind: "note_added", note: note.trim(), mediaIds: [] });
/** Problems of a status change or a note (the API answers 400 for the same status and an empty note). */
export function eventProblems(kind: "status" | "note", ctx: { today: string; observedOn: string; occurredOn: string; status?: IssueStatus | ""; current?: IssueStatus; note: string }): string[] {
  const out: string[] = [];
  if (!isIsoDate(ctx.occurredOn)) out.push("Enter the date.");
  else if (ctx.occurredOn > ctx.today) out.push("The date cannot be in the future.");
  else if (ctx.occurredOn < ctx.observedOn) out.push(`The date cannot be before the issue was seen (${day(ctx.observedOn)}).`);
  if (kind === "status") {
    if (!ctx.status) out.push("Choose the new status.");
    else if (ctx.status === ctx.current) out.push(`The issue is already ${STATUS_LABEL[ctx.status].toLowerCase()}.`);
  } else if (!ctx.note.trim()) out.push("Write the note first.");
  if (ctx.note.trim().length > 2000) out.push("Keep the note to 2000 characters.");
  return out;
}

// ---------------------------------------------------------------- issue sheet lines

export const seenBeforeLines = (issue: Pick<FieldIssue, "seenBefore">) =>
  issue.seenBefore.map((s) => `Seen before: ${day(s.observedOn)}${s.cropName ? ` on ${s.cropName}` : ""}`);
export const earliestHarvestLine = (issue: Pick<FieldIssue, "earliestHarvestOn">) =>
  issue.earliestHarvestOn ? `Earliest harvest after the last application: ${day(issue.earliestHarvestOn)} (from the label you entered)` : null;
/** The response in the farmer's words, one line per part. */
export function responseLines(r: IssueResponse): string[] {
  return [
    `${METHOD_LABEL[r.method]}: ${r.description}`,
    r.productName ? `Product, as you named it: ${r.productName}` : null,
    r.quantity ? `Quantity: ${r.quantity.value} ${r.quantity.unit}` : null,
    r.labelWaitDays !== undefined ? `Label wait: ${r.labelWaitDays} day${r.labelWaitDays === 1 ? "" : "s"} (from the label you entered)` : null,
    r.recheckOn ? `Recheck on ${day(r.recheckOn)}` : null,
  ].filter((x): x is string => !!x);
}
/** Events oldest first (the timeline reads down). */
export const timeline = (issue: Pick<FieldIssue, "events">) =>
  [...issue.events].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.createdAt.localeCompare(b.createdAt));
export function eventLines(event: IssueEvent): string[] {
  const lines: string[] = [];
  if (event.kind === "reported") lines.push("Issue logged.");
  if (event.kind === "status_changed" && event.status) lines.push(`Marked ${STATUS_LABEL[event.status].toLowerCase()}.`);
  if (event.kind === "recheck_scheduled") lines.push("Recheck date set.");
  if (event.response) lines.push(...responseLines(event.response));
  if (event.note) lines.push(event.note);
  if (event.mediaIds.length) lines.push(`${event.mediaIds.length} photo${event.mediaIds.length === 1 ? "" : "s"}`);
  return lines;
}
/** The statuses an issue can move to (never its own). */
export const nextStatuses = (current: IssueStatus) => STATUSES.filter((s) => s !== current);

// ---------------------------------------------------------------- list

export type StatusFilter = IssueStatus | "all";
export const STATUS_FILTERS: readonly StatusFilter[] = ["all", ...STATUSES];
export const filterLabel = (f: StatusFilter) => (f === "all" ? "All" : STATUS_LABEL[f]);
/** Newest observed first, then newest created. */
export const sortIssues = (issues: readonly FieldIssue[]) =>
  [...issues].sort((a, b) => b.observedOn.localeCompare(a.observedOn) || b.createdAt.localeCompare(a.createdAt));
export const filterIssues = (issues: readonly FieldIssue[], filter: StatusFilter) => sortIssues(filter === "all" ? issues : issues.filter((i) => i.status === filter));
export function filterCount(counts: Record<IssueStatus, number>, filter: StatusFilter): number {
  return filter === "all" ? STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0) : (counts[filter] ?? 0);
}
/** Counts by status from a list (used when the list was filtered or extended locally). */
export function countsOf(issues: readonly Pick<FieldIssue, "status">[]): Record<IssueStatus, number> {
  const out: Record<IssueStatus, number> = { open: 0, treating: 0, resolved: 0, dismissed: 0 };
  for (const issue of issues) out[issue.status]++;
  return out;
}
export const placeName = (fieldId: string | null | undefined, names: (id: string) => string | null) => (fieldId ? (names(fieldId) ?? "A field") : "Whole farm");
/** The Today line under the alerts: "2 open issues · Leaf holes" (plus being treated), or null when nothing is open. */
export function issuesLine(block: TodayView["issues"] | undefined): string | null {
  if (!block) return null;
  const parts: string[] = [];
  if (block.open) parts.push(`${block.open} open issue${block.open === 1 ? "" : "s"}`);
  if (block.treating) parts.push(`${block.treating} being treated`);
  if (!parts.length) return null;
  const latest = block.latest[0]?.title;
  return latest ? `${parts.join(" · ")} · ${latest}` : parts.join(" · ");
}

// ---------------------------------------------------------------- deep link (?issue=<id>)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The issue id of a `?issue=` link, or null when absent or not an issue id. */
export function issueFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("issue");
  return raw && UUID.test(raw) ? raw : null;
}
/** The same path and query with `issue` set (or removed with null); other parameters (tab, field) are kept. */
export function withIssueParam(pathname: string, search: string, issueId: string | null): string {
  const params = new URLSearchParams(search);
  if (issueId) params.set("issue", issueId);
  else params.delete("issue");
  const text = params.toString();
  return `${pathname}${text ? `?${text}` : ""}`;
}

// ---------------------------------------------------------------- the farmer's check interval (spec 2, 3)

/** Whole days 3 to 30, or null for a blank entry ("use the farm's interval"); a message for anything else. */
export function parseInterval(text: string): { ok: true; days: number | null } | { ok: false; message: string } {
  const raw = text.trim();
  if (!raw) return { ok: true, days: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_DAYS || n > MAX_INTERVAL_DAYS)
    return { ok: false, message: `Your check interval must be whole days from ${MIN_INTERVAL_DAYS} to ${MAX_INTERVAL_DAYS}.` };
  return { ok: true, days: n };
}
