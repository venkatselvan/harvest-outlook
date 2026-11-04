import type { CropFitCandidate, EvaraAction, EvaraCompareColumn, EvaraNode, EvaraOpenTarget, EvaraPromptKey, YearPlanOption, YearPlanReplacement } from "@harvest/contracts";
import type { Dropped } from "./parse";
import {
  actionLabel,
  askLabel,
  chipLabel,
  cut,
  fmtDate,
  fmtDayOfSeason,
  fmtDays,
  fmtInrEstimate,
  fmtMm,
  fmtMonths,
  fmtRange,
  langOf,
  needLabel,
  noteLabel,
  openLabel,
  outcomeLabel,
  plannedLabel,
  rankLabel,
  seasonLabel,
  waterLabel,
  type EvaraLangCode,
} from "./labels";
import { timelineKey, type EvaraCropName, type EvaraOccupant, type EvaraResolveData } from "./types";

/**
 * Node and action builders shared by the resolver (resolve.ts) and the fallback composer (compose.ts). Every string they
 * put in a node is code-written (labels.ts) or a catalogue name, a date or an amount computed by code; text nodes carry
 * gated answer blocks only. Each builder validates the ids it is given against the run's data (EVARA_ACTIONS_SPEC.md 2.5)
 * and returns the drop code of 2.2 when it cannot build.
 */

export type DropCode = Dropped["code"];
export type Built<T> = { ok: true; value: T; notes?: { code: DropCode; detail: string }[] } | { ok: false; code: DropCode; detail: string };
const no = (code: DropCode, detail: string): Built<never> => ({ ok: false, code, detail: detail.slice(0, 200) });
const yes = <T>(value: T, notes?: { code: DropCode; detail: string }[]): Built<T> => (notes && notes.length ? { ok: true, value, notes } : { ok: true, value });

type PlanOptionNode = Extract<EvaraNode, { type: "plan_options" }>["options"][number];
type PlanSlotNode = PlanOptionNode["slots"][number];
type CompareRow = Extract<EvaraNode, { type: "crop_compare" }>["rows"][number];
type Cell = NonNullable<CompareRow["cells"][EvaraCompareColumn]>;

const DASH = "—";
/** Drop detail when a stale year-plan review's options, alternatives or use_plan actions are withheld (review fix E7c-1). */
export const STALE_REVIEW = "stale review";
const lang = (d: EvaraResolveData): EvaraLangCode => langOf(d.language);

// ------------------------------------------------------------------ lookups

export function cropOf(d: EvaraResolveData, id: string): EvaraCropName | null {
  return d.crops[id] ?? d.crops[id.toLowerCase()] ?? null;
}
export function cropName(d: EvaraResolveData, c: EvaraCropName): string {
  const l = lang(d);
  return cut((l === "en" ? c.en : c[l] ?? c.en) || c.slug, 120);
}

/** The crop-fit candidate for a crop on the viewed field: the picked one first, else the best-ranked sole crop, else any. */
export function candidateFor(d: EvaraResolveData, slug: string): CropFitCandidate | null {
  const r = d.cropFit;
  if (!r) return null;
  const pick = r.picks.filter((p) => p.cropId === slug).sort((a, b) => a.rank - b.rank)[0];
  if (pick) {
    const c = r.candidates.find((x) => x.cropId === pick.cropId && x.productId === pick.productId && (pick.systemId ? x.companion?.systemId === pick.systemId : x.kind !== "intercrop"));
    if (c) return c;
  }
  const all = r.candidates.filter((x) => x.cropId === slug).sort((a, b) => Number(a.kind === "intercrop") - Number(b.kind === "intercrop") || a.rank - b.rank);
  return all[0] ?? null;
}

const OUTCOME_ORDER = ["eligible", "requires_review", "unknown", "ineligible"];
export function screeningOutcome(d: EvaraResolveData, slug: string): string | null {
  const rows = d.screening?.results.filter((r) => r.cropId === slug) ?? [];
  if (!rows.length) return null;
  return rows.map((r) => r.outcome).sort((a, b) => OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b))[0]!;
}

/** 2.4: GrowthJourney sowing = the given date, else the crop-fit candidate's sowing, else the current cycle's sowing for its own crop, else today. */
export function journeySowing(d: EvaraResolveData, slug: string, given: string | null): string {
  return given ?? candidateFor(d, slug)?.sowing ?? (d.currentCycle?.cropId === slug ? d.currentCycle.sowingDate : d.today);
}

const isReplaceable = (o: EvaraOccupant) => o.realisation === "planned" || o.realisation === "overdue";

// ------------------------------------------------------------------ prose components

export function buildText(d: EvaraResolveData, blockId: string): Built<EvaraNode> {
  const b = d.blocks.find((x) => x.id === blockId);
  if (!b) return no("unknown-id", `answer block ${blockId} is not an approved block`);
  return yes({ type: "text", blockId: b.id, kind: b.kind, text: b.text });
}

export function buildCallout(d: EvaraResolveData, tone: "warning" | "info" | "good", blockId: string): Built<EvaraNode> {
  const b = d.blocks.find((x) => x.id === blockId);
  if (!b) return no("unknown-id", `answer block ${blockId} is not an approved block`);
  return yes({ type: "callout", tone, text: b.text, blockId: b.id });
}

export function buildChoice(d: EvaraResolveData, blockId: string, actions: EvaraAction[]): Built<EvaraNode> {
  const b = d.blocks.find((x) => x.id === blockId);
  if (!b) return no("unknown-id", `answer block ${blockId} is not an approved block`);
  if (!actions.length) return no("empty-after-resolve", "Choice: no action survived");
  return yes({ type: "choice", prompt: b.text, blockId: b.id, options: actions.slice(0, 6) });
}

export function buildActions(actions: EvaraAction[]): Built<EvaraNode> {
  if (!actions.length) return no("empty-after-resolve", "Actions: no action survived");
  return yes({ type: "actions", items: actions.slice(0, 6) });
}

// ------------------------------------------------------------------ FarmSnapshot

export function buildFarmSnapshot(d: EvaraResolveData): Built<EvaraNode> {
  const b = d.briefing;
  if (!b) return no("empty-after-resolve", "FarmSnapshot: no farm briefing in this run");
  const l = lang(d);
  const c = b.cycle;
  const day = c?.dayOfSeason && c.dayOfSeason.unit === "days" ? fmtDayOfSeason(c.dayOfSeason.value, l) : null;
  const rain = b.weather?.rainNext7Days && b.weather.rainNext7Days.unit === "mm" ? fmtMm(b.weather.rainNext7Days.value, l) : null;
  const next = b.steps.nextAction;
  return yes({
    type: "farm_snapshot",
    fieldName: b.fields?.viewedField ? cut(b.fields.viewedField, 120) : null,
    crop: c ? cut(c.cropName, 120) : null,
    stage: c?.stageToday ? cut(c.stageToday.name, 120) : null,
    dayOfSeason: day ? cut(day, 40) : null,
    rainNext7Days: rain ? cut(rain, 40) : null,
    nextAction: next ? cut(next.title, 160) : null,
    nextActionWindow: next ? cut(fmtRange(next.dueFrom, next.dueTo, l), 60) : null,
    openAlerts: b.alerts.length,
  });
}

// ------------------------------------------------------------------ actions

export function pickCropAction(d: EvaraResolveData, id: string): Built<EvaraAction> {
  const c = cropOf(d, id);
  if (!c) return no("unknown-id", `crop ${id} is not a catalogue crop`);
  const cand = candidateFor(d, c.slug);
  const name = cropName(d, c);
  return yes({ kind: "pick_crop", label: actionLabel("pick_crop", lang(d), { crop: name }), cropId: c.slug, cropName: name, productId: cand?.productId ?? null, sowingDate: cand?.sowing ?? null });
}

export function showJourneyAction(d: EvaraResolveData, id: string): Built<EvaraAction> {
  const c = cropOf(d, id);
  if (!c) return no("unknown-id", `crop ${id} is not a catalogue crop`);
  const name = cropName(d, c);
  return yes({ kind: "show_journey", label: actionLabel("show_journey", lang(d), { crop: name }), cropId: c.slug, cropName: name, sowingDate: candidateFor(d, c.slug)?.sowing ?? null });
}

export function compareAction(d: EvaraResolveData, ids: string[]): Built<EvaraAction> {
  const slugs = [...new Set(ids.map((i) => cropOf(d, i)?.slug).filter((s): s is string => !!s))].slice(0, 4);
  const unknown = ids.filter((i) => !cropOf(d, i));
  if (slugs.length < 2) return no("unknown-id", `Compare needs 2 catalogue crops${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
  return yes({ kind: "compare", label: actionLabel("compare", lang(d)), cropIds: slugs }, unknown.map((u) => ({ code: "unknown-id" as const, detail: `crop ${u} is not a catalogue crop` })));
}

const replacedNames = (rs: YearPlanReplacement[]) => [...new Set(rs.map((r) => r.cropName))].join(", ");

export function usePlanAction(d: EvaraResolveData, source: "plan" | "alternatives", optionId: string): Built<EvaraAction> {
  const yp = d.yearPlan;
  if (!yp || !yp.reviewId) return no("unknown-id", "UsePlan: no stored year plan for this field");
  // Review fix E7c-1: a stale review's options were computed for a field that has changed since; never offer to apply one.
  if (yp.stale) return no("empty-after-resolve", STALE_REVIEW);
  const l = lang(d);
  if (source === "plan") {
    if (!yp.options.some((o) => o.optionId === optionId)) return no("unknown-id", `year-plan option ${optionId} does not exist`);
    return yes({ kind: "use_plan", label: actionLabel("use_plan", l), reviewId: yp.reviewId, optionId, alternative: false, fieldId: d.fieldId });
  }
  const alt = yp.alternatives;
  if (!alt || !alt.options.some((o) => o.optionId === optionId)) return no("unknown-id", `alternative ${optionId} does not exist`);
  if (alt.basis !== "replace_planned") return no("not-replaceable", `alternative ${optionId} is a comparison with sown crops and cannot be applied`);
  return yes({ kind: "use_plan", label: alt.replaces.length ? actionLabel("use_alternative", l, { crops: replacedNames(alt.replaces) }) : actionLabel("use_plan", l), reviewId: yp.reviewId, optionId, alternative: true, fieldId: d.fieldId });
}

export function replaceSeasonAction(d: EvaraResolveData, rotationPlanId: string, cropId: string): Built<EvaraAction> {
  const occ = d.occupants.find((o) => o.rotationPlanId === rotationPlanId);
  if (!occ) return no("unknown-id", `saved season ${rotationPlanId} is not on the viewed field`);
  if (!isReplaceable(occ)) return no("not-replaceable", `saved season ${rotationPlanId} is ${occ.realisation ?? "not dated"}`);
  const c = cropOf(d, cropId);
  if (!c) return no("unknown-id", `crop ${cropId} is not a catalogue crop`);
  const cand = candidateFor(d, c.slug);
  const name = cropName(d, c);
  const takesIt = cand?.replaces?.some((r) => r.rotationPlanId === rotationPlanId) ?? false;
  return yes({
    kind: "replace_season",
    label: actionLabel("replace_season", lang(d), { from: occ.cropName, crop: name }),
    rotationPlanId,
    fromCropName: cut(occ.cropName, 120),
    cropId: c.slug,
    cropName: name,
    productId: cand?.productId ?? null,
    sowingDate: takesIt ? cand!.sowing : occ.plannedSowingDate,
  });
}

/** Furthest a model-chosen @AddSeason sowing may lie ahead of today (review fix E7c-4; orchestrator bound, not agronomy). */
export const ADD_SEASON_MAX_AHEAD_DAYS = 730;
const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthInWindow = (m: number, w: { fromMonth: number; toMonth: number }) => (w.fromMonth <= w.toMonth ? m >= w.fromMonth && m <= w.toMonth : m >= w.fromMonth || m <= w.toMonth);

/**
 * Whether a model-chosen @AddSeason sowing date may stand (review fix E7c-4). Accepted when it equals the crop-fit
 * candidate's sowing for the crop on the viewed field; otherwise only within today..today+730 days AND, when the catalogue
 * compare rows carry a regional planting window for the crop (the farm's state/district context, catalogue/compare.ts), in
 * one of those windows' months. With no window loaded only the 730-day bound applies.
 */
export function addSeasonDateAllowed(d: EvaraResolveData, slug: string, date: string): boolean {
  const cand = candidateFor(d, slug);
  if (cand && cand.sowing === date) return true;
  if (date < d.today || date > addDaysIso(d.today, ADD_SEASON_MAX_AHEAD_DAYS)) return false;
  const row = d.catalogueRows[slug];
  const windows = row ? (row.plantingWindows?.length ? row.plantingWindows : row.plantingWindow ? [row.plantingWindow] : []) : [];
  if (!windows.length) return true;
  const m = Number(date.slice(5, 7));
  return windows.some((w) => monthInWindow(m, w));
}

export function addSeasonAction(d: EvaraResolveData, cropId: string, sowing: string | null): Built<EvaraAction> {
  const c = cropOf(d, cropId);
  if (!c) return no("unknown-id", `crop ${cropId} is not a catalogue crop`);
  const cand = candidateFor(d, c.slug);
  const notes: { code: DropCode; detail: string }[] = [];
  let given = sowing;
  if (given !== null && !addSeasonDateAllowed(d, c.slug, given)) {
    // The argument is ignored; the crop-fit sowing (if any) is used instead.
    notes.push({ code: "type-mismatch", detail: `AddSeason: sowing outside window (${given})` });
    given = null;
  }
  const date = given ?? cand?.sowing ?? null;
  if (!date) return notes.length ? no("type-mismatch", notes[0]!.detail) : no("missing-required", "AddSeason: no sowing date and no crop-fit sowing for this crop");
  if (date < d.today) return no("type-mismatch", "AddSeason: the sowing date is in the past");
  const name = cropName(d, c);
  return yes({ kind: "add_season", label: actionLabel("add_season", lang(d), { crop: name }), cropId: c.slug, cropName: name, productId: cand?.productId ?? null, sowingDate: date }, notes);
}

export function openAction(d: EvaraResolveData, target: EvaraOpenTarget): Built<EvaraAction> {
  return yes({ kind: "open", label: openLabel(target, lang(d)), target });
}

export function askAction(d: EvaraResolveData, promptKey: EvaraPromptKey): Built<EvaraAction> {
  return yes({ kind: "ask", label: askLabel(promptKey, lang(d)), promptKey });
}

// ------------------------------------------------------------------ CropCompare

const COLUMNS: EvaraCompareColumn[] = ["fit", "sowing", "duration", "water", "harvest", "profit", "replaces"];
const cell = (text: string, tone: Cell["tone"] = null, note: string | null = null): Cell => ({ text: cut(text, 80), tone, note: note ? cut(note, 200) : null });
const dash = (note: string | null): Cell => cell(DASH, null, note);
const outcomeTone = (o: string): Cell["tone"] => (o === "eligible" ? "good" : o === "requires_review" ? "watch" : o === "ineligible" ? "short" : "neutral");

export function buildCropCompare(d: EvaraResolveData, ids: string[]): Built<EvaraNode> {
  const l = lang(d);
  const notes: { code: DropCode; detail: string }[] = [];
  const seen = new Set<string>();
  const rows: CompareRow[] = [];
  let anyCandidate = false;
  let anyDash = false;
  for (const id of ids) {
    const c = cropOf(d, id);
    if (!c) {
      notes.push({ code: "unknown-id", detail: `CropCompare: crop ${id} is not a catalogue crop` });
      continue;
    }
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    const cand = candidateFor(d, c.slug);
    const cat = d.catalogueRows[c.slug] ?? null;
    if (cand) anyCandidate = true;
    const cells: Partial<Record<EvaraCompareColumn, Cell>> = {};
    // fit
    if (cand) cells.fit = cell(rankLabel(cand.rank, cand.rankScore ?? cand.score, l), cand.rank <= 3 ? "good" : "neutral", d.cropFit?.replacePass && cand.replaces?.length ? noteLabel("fit_replace", l) : null);
    else {
      const o = screeningOutcome(d, c.slug) ?? cat?.outcome ?? null;
      cells.fit = o ? cell(outcomeLabel(o, l), outcomeTone(o), noteLabel("fit_screening", l)) : dash(noteLabel("not_ranked", l));
    }
    // sowing
    if (cand) cells.sowing = cell(cand.window ? `${fmtDate(cand.sowing, l)} (${seasonLabel(cand.window.season, l)})` : fmtDate(cand.sowing, l));
    else if (cat?.plantingWindow) cells.sowing = cell(`${fmtMonths(cat.plantingWindow.fromMonth, cat.plantingWindow.toMonth, l)}${cat.season ? ` (${seasonLabel(cat.season, l)})` : ""}`);
    else cells.sowing = dash(noteLabel("no_sowing", l));
    // duration
    if (cand) cells.duration = cell(fmtDays(cand.durationDays.low, cand.durationDays.high, l));
    else if (cat?.durationDays) cells.duration = cell(fmtDays(cat.durationDays.min, cat.durationDays.max, l));
    else cells.duration = dash(noteLabel("no_duration", l));
    // water
    if (cand) {
      const k = cand.water.fit >= 0.75 ? "good" : cand.water.fit >= 0.4 ? "partial" : "short";
      cells.water = cell(waterLabel(k, l), k === "good" ? "good" : k === "partial" ? "watch" : "short", l === "en" ? cand.water.verdict : null);
    } else if (cat?.water) cells.water = cell(`${waterLabel(cat.water.fit, l)}${cat.water.needClass ? `, ${needLabel(cat.water.needClass, l)}` : ""}`, cat.water.fit === "matches" ? "good" : cat.water.fit === "partial" ? "watch" : "short");
    else cells.water = dash(noteLabel("no_water", l));
    // harvest
    if (cand) cells.harvest = cell(fmtRange(cand.harvest.earliest, cand.harvest.latest, l));
    else if (cat?.harvest) cells.harvest = cell(fmtRange(cat.harvest.earliest, cat.harvest.latest, l));
    else cells.harvest = dash(noteLabel("no_harvest", l));
    // profit for the field
    const pf = cand?.profitForField ?? null;
    cells.profit = pf ? cell(fmtInrEstimate(pf.central, pf.likely.low, pf.likely.high, l), pf.central < 0 ? "short" : "neutral", noteLabel("profit", l)) : dash(noteLabel("no_profit", l));
    // replaces
    if (cand?.replaces?.length) cells.replaces = cell(cand.replaces.map((r) => plannedLabel(r.cropName, r.plannedSowingDate, l)).join("; "), "watch");
    const actions = [pickCropAction(d, c.slug), showJourneyAction(d, c.slug)].flatMap((a) => (a.ok ? [a.value] : []));
    rows.push({ cropId: c.slug, cropName: cropName(d, c), productName: cand ? cut(cand.productName, 120) : null, cells, actions });
  }
  if (rows.length < 2) return { ok: false, code: "empty-after-resolve", detail: `CropCompare: ${rows.length} of ${ids.length} crops resolved; 2 are needed` };
  const shown = rows.slice(0, 4);
  const columns = COLUMNS.filter((col) => (col === "fit" ? true : col === "replaces" ? shown.some((r) => r.cells.replaces) : shown.some((r) => r.cells[col] && r.cells[col]!.text !== DASH)));
  for (const r of shown) {
    for (const col of COLUMNS) if (!columns.includes(col)) delete r.cells[col];
    if (columns.includes("replaces") && !r.cells.replaces) r.cells.replaces = dash(null);
    if (columns.some((col) => r.cells[col]?.text === DASH && col !== "replaces")) anyDash = true;
  }
  const noteParts = [anyCandidate ? noteLabel(d.cropFit?.replacePass ? "fit_replace" : "fit_review", l) : noteLabel("fit_screening", l), ...(anyDash ? [noteLabel("unknown_cells", l)] : [])];
  return yes({ type: "crop_compare", columns, rows: shown, note: cut(noteParts.join(" "), 300) }, notes);
}

// ------------------------------------------------------------------ PlanOptions

function profitText(o: { central: number; likely: { low: number; high: number } } | null | undefined, l: EvaraLangCode): string | null {
  return o ? cut(fmtInrEstimate(o.central, o.likely.low, o.likely.high, l), 60) : null;
}

function slotOf(s: YearPlanOption["slots"][number], l: EvaraLangCode, replaces: string | null): PlanSlotNode {
  return { cropName: cut(s.cropName, 120), productName: s.productName ? cut(s.productName, 120) : null, kind: cut(s.kind ?? "crop", 20), sowing: s.sowing, harvest: { earliest: s.harvest.earliest, latest: s.harvest.latest }, profitForField: profitText(s.profitForField, l), replaces: replaces ? cut(replaces, 160) : null };
}

const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from <= b.to && b.from <= a.to;

export function buildPlanOptions(d: EvaraResolveData, source: "plan" | "alternatives" | "saved" | null): Built<EvaraNode> {
  const l = lang(d);
  const yp = d.yearPlan;
  // Review fix E7c-1: a stale review (the field changed since it was computed) offers neither its options nor its
  // alternatives, and nothing to apply; only the saved seasons, whose realisation load.ts computes fresh, are shown.
  const stale = !!yp?.stale;
  if (stale && (source === "plan" || source === "alternatives")) return no("empty-after-resolve", STALE_REVIEW);
  const src = stale ? "saved" : (source ?? (yp?.alternatives?.options.length ? "alternatives" : "plan"));
  const staleNote = stale && source === null ? [{ code: "empty-after-resolve" as const, detail: STALE_REVIEW }] : undefined;
  if (src === "plan") {
    if (!yp || !["ready", "partial"].includes(yp.status) || !yp.options.length) return no("empty-after-resolve", "PlanOptions(plan): no stored year-plan options for this field");
    const options: PlanOptionNode[] = yp.options.slice(0, 5).map((o) => ({
      optionId: cut(o.optionId, 120),
      reviewId: yp.reviewId,
      label: cut(o.label, 60),
      chips: [...(o.secondaryLabels ?? []).map((c) => cut(c, 60)), ...(yp.appliedOptionIds.includes(o.optionId) ? [chipLabel("applied", l)] : [])].slice(0, 4),
      slots: o.slots.slice(0, 6).map((s) => slotOf(s, l, null)),
      actions: yp.reviewId ? [{ kind: "use_plan" as const, label: actionLabel("use_plan", l), reviewId: yp.reviewId, optionId: cut(o.optionId, 120), alternative: false, fieldId: d.fieldId }] : [],
    }));
    return yes({ type: "plan_options", source: "plan", basis: null, options, note: noteLabel("plan_review", l) });
  }
  if (src === "alternatives") {
    const alt = yp?.alternatives;
    if (!yp || !alt || !alt.options.length) return no("empty-after-resolve", "PlanOptions(alternatives): the stored year plan has no alternatives");
    const occupied = yp.scenario.occupied ?? [];
    const windowOf = (r: YearPlanReplacement) => occupied.find((o) => o.id === r.rotationPlanId)?.occupancy ?? (r.plannedSowingDate ? { from: r.plannedSowingDate, to: r.plannedSowingDate } : null);
    const options: PlanOptionNode[] = alt.options.slice(0, 5).map((o) => ({
      optionId: cut(o.optionId, 120),
      reviewId: yp.reviewId,
      label: cut(o.label, 60),
      chips: [chipLabel(alt.basis, l), ...(alt.basis === "sown_comparison" ? [chipLabel("comparison_only", l)] : [])],
      slots: o.slots.slice(0, 6).map((s) => {
        if (alt.basis !== "replace_planned" || s.fixed) return slotOf(s, l, null);
        const hit = alt.replaces.filter((r) => {
          const w = windowOf(r);
          return w ? overlaps(s.occupancy, w) : false;
        });
        return slotOf(s, l, hit.length ? hit.map((r) => plannedLabel(r.cropName, r.plannedSowingDate, l)).join("; ") : null);
      }),
      actions:
        alt.basis === "replace_planned" && yp.reviewId
          ? [{ kind: "use_plan" as const, label: alt.replaces.length ? actionLabel("use_alternative", l, { crops: replacedNames(alt.replaces) }) : actionLabel("use_plan", l), reviewId: yp.reviewId, optionId: cut(o.optionId, 120), alternative: true, fieldId: d.fieldId }]
          : [],
    }));
    return yes({ type: "plan_options", source: "alternatives", basis: alt.basis, options, note: noteLabel(alt.basis === "replace_planned" ? "alternatives_replace" : "alternatives_sown", l) });
  }
  // saved seasons with their realisation chips; a planned season offers the crop-fit candidates that would replace it
  const seasons = d.occupants.filter((o) => o.plannedSowingDate).slice(0, 5);
  if (!seasons.length) return no("empty-after-resolve", stale ? STALE_REVIEW : "PlanOptions(saved): no dated saved seasons on this field");
  const cands = d.cropFit ? [...d.cropFit.candidates].sort((a, b) => a.rank - b.rank) : [];
  const options: PlanOptionNode[] = seasons.map((o) => {
    // Review fix E7c-2: the planned harvest, else the year plan's occupancy end; with neither (or one before the sowing) the
    // harvest is unknown (null), never a date made up from the sowing date.
    const end = o.plannedHarvestDate ?? o.occupancyTo ?? null;
    const harvest = end && end >= o.plannedSowingDate! ? { earliest: end, latest: end } : null;
    const takers = isReplaceable(o) ? cands.filter((c) => c.replaces?.some((r) => r.rotationPlanId === o.rotationPlanId)) : [];
    const actions = [...new Map(takers.map((c) => [c.cropId, c])).values()].slice(0, 2).flatMap((c) => {
      const a = replaceSeasonAction(d, o.rotationPlanId, c.cropId);
      return a.ok ? [a.value] : [];
    });
    return {
      optionId: cut(o.rotationPlanId, 120),
      reviewId: null,
      label: cut(`${o.season} ${o.year}`, 60),
      chips: o.realisation ? [chipLabel(o.realisation, l)] : [],
      slots: [{ cropName: cut(o.cropName, 120), productName: o.productName ? cut(o.productName, 120) : null, kind: cut(o.kind, 20), sowing: o.plannedSowingDate!, harvest, profitForField: null, replaces: null }],
      actions,
    };
  });
  return yes({ type: "plan_options", source: "saved", basis: null, options, note: noteLabel("plan_saved", l) }, staleNote);
}

// ------------------------------------------------------------------ GrowthJourney

export function buildGrowthJourney(d: EvaraResolveData, cropId: string, sowing: string | null): Built<EvaraNode> {
  const c = cropOf(d, cropId);
  if (!c) return no("unknown-id", `GrowthJourney: crop ${cropId} is not a catalogue crop`);
  const date = journeySowing(d, c.slug, sowing);
  const tl = d.timelines[timelineKey(c.slug, date)];
  if (!tl || !tl.stages.length) return no("empty-after-resolve", `GrowthJourney: no sourced stages for ${c.slug}`);
  const cand = candidateFor(d, c.slug);
  return yes({
    type: "growth_journey",
    cropId: c.slug,
    cropName: cropName(d, c),
    productId: cand?.productId ?? (d.currentCycle?.cropId === c.slug ? d.currentCycle.productId : null),
    fieldId: d.fieldId,
    sowingDate: date,
    stages: tl.stages.slice(0, 12).map((s) => ({ stageId: cut(s.id, 80), name: cut(s.name, 80), from: s.from, to: s.to, basis: cut(s.basis, 20) })),
    journeyId: null,
    note: noteLabel("journey", lang(d)),
  });
}
