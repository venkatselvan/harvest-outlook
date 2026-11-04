import { CropFitReview, FarmBriefing, Unit, type FarmField, type FarmWorkspace, type TodayView, type ToolOutput } from "@harvest/contracts";
import type { Config } from "../../config";
import type { Pool } from "../../db/pool";
import { listEntries } from "../../journal/repository";
import type { Budget } from "../../services/budget";
import { notFound } from "../../services/errors";
import { getFarm } from "../../services/farms";
import { resolveStateName } from "../../services/price-series";
import { farmSoilMarkers } from "../../services/soil-reports";
import { readSoilReview } from "../../services/soil-review";
import { irrigationCategoryOf } from "../../services/today/footprint";
import { currentCycle, todayView, type TodayViewDeps } from "../../services/today/view";
import { fieldOf, fieldView, getWorkspace } from "../../services/workspace";
import { cropDisplayName } from "../../services/year-plan/data";
import { readYearPlan } from "../../services/year-plan/service";
import { seasonRealisation } from "../../services/year-plan/scenario";
import { defaultFieldId } from "../../services/crop-fit/service";
import { briefingLines, scoutingState } from "../../services/scouting/issues";
import type { ToolContext, ToolHandler } from "../tools/registry";

/**
 * get_farm_briefing (2026-11-02, docs/research/ASSISTANT_FARM_BRIEFING_SPEC.md section 2.1): the selected farm's current
 * state composed by code from read-only services, so Evara can answer "how do I care for my crop" from the same data the
 * Today view shows.
 *
 * Read-only by construction, not by convention: every service receives `readOnlyPool(ctx.pool)`, which refuses any
 * statement that writes (INSERT/UPDATE/DELETE/DDL, SELECT ... FOR UPDATE, nextval) and every `connect()` (transactions,
 * job enqueue), and the Today view gets fetch seams that refuse the network. A part of the Today view that would queue a
 * model job (the outlook note in live mode, the overview) or ingest weather/satellite data therefore fails inside its own
 * guard and is reported as a limitation; nothing is enqueued, no model is called, nothing is written. The outlook sentence
 * is taken only when the Today view returns a ready one (synthetic/replay: the code-written sentence).
 *
 * Every quantity is a unit record {value, unit} or {value: {low, central?, high}, unit} at a pointer listed in
 * UNIT_RECORD_OWNERS.get_farm_briefing (tool-units.ts). No farm name, coordinates, owner or session ids are included;
 * journal text is cut to 120 characters (same rule as services/today/overview.ts).
 */
export interface BriefingDeps {
  config: Config;
  budget: Budget;
  /** Test seams for the Today view (fake providers, stage snapshot). Production passes none. */
  today?: Partial<Pick<TodayViewDeps, "providers" | "snapshot">> | undefined;
  /** Whole-composition bound (default 25 s). */
  timeoutMs?: number | undefined;
}

export const BRIEFING_TIMEOUT_MS = 25_000;
export const BRIEFING_MAX_CHARS = 16_000;
/** fitSize trims to this, leaving a margin under BRIEFING_MAX_CHARS (a real live farm measured 15,912 before the margin). */
export const BRIEFING_TARGET_CHARS = 14_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ read-only guards

const WRITE_SQL = /^\s*(insert|update|delete|merge|create|drop|alter|truncate|grant|revoke|lock|copy|vacuum|refresh|begin|start|commit|rollback|savepoint|set|reset|notify|listen|call|do)\b|\bfor\s+(no\s+key\s+)?(update|share)\b|\bnextval\s*\(|\bpg_advisory|^\s*with\b[\s\S]*\b(insert|update|delete)\b/i;

class ReadOnlyViolation extends Error {
  readonly code = "read_only_briefing";
  constructor() {
    super("The farm briefing is read-only; a write or transaction was refused");
  }
}

/** A pool view that only runs reads. Exported for tests. */
export function readOnlyPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (text: unknown, ...rest: unknown[]) => {
          const sql = typeof text === "string" ? text : typeof text === "object" && text !== null ? (text as { text?: unknown }).text : undefined;
          if (typeof sql !== "string" || WRITE_SQL.test(sql)) return Promise.reject(new ReadOnlyViolation());
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      if (prop === "connect") return () => Promise.reject(new ReadOnlyViolation());
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Fetch seam for the Today view: the briefing never reaches Planetary Computer or Open-Meteo. */
const noNetwork = async (): Promise<never> => {
  throw Object.assign(new Error("network disabled for the farm briefing"), { code: "briefing_no_network" });
};

// ------------------------------------------------------------------ small helpers

type Q = { value: number; unit: Unit };
type R = { value: { low: number; central?: number; high: number }; unit: Unit };
const r2 = (n: number) => Math.round(n * 100) / 100;
/**
 * Review fix 1 (2026-11-02): soil readings and satellite indices keep at least 3 significant figures, so a small reading is
 * never rounded to 0 (zinc 0.004 ppm stays 0.004; NDVI 0.6234 is 0.623). At 1 and above two decimals already give 3
 * significant figures and integers are never cut (potassium 1234 kg/ha stays 1234). Money, mm, days and the rest use r2.
 */
const s3 = (n: number) => (n === 0 || Math.abs(n) >= 1 ? r2(n) : Number(n.toPrecision(3)));
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const num = (v: unknown): number | null => (fin(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const q = (value: unknown, unit: Unit, round: (n: number) => number = r2): Q | null => {
  const n = num(value);
  return n === null ? null : { value: round(n), unit };
};
/** A soil reading or satellite index (3 significant figures, see s3). */
const qs = (value: unknown, unit: Unit): Q | null => q(value, unit, s3);
const rng = (low: unknown, high: unknown, unit: Unit, central?: unknown, round: (n: number) => number = r2): R | null => {
  const lo = num(low);
  const hi = num(high);
  if (lo === null || hi === null) return null;
  const c = central === undefined ? null : num(central);
  return { value: { low: round(Math.min(lo, hi)), ...(c !== null ? { central: round(c) } : {}), high: round(Math.max(lo, hi)) }, unit };
};
const cut = (s: string | null | undefined, n: number): string | null => {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/g;
const DAY_MS = 86_400_000;
const istDate = (iso: string) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const SEVERITY_RANK: Record<string, number> = { warning: 0, watch: 1, info: 2 };
/**
 * Review nit (d): a `grounded_review` alert is a news item Meta classified from a web search, not the application's own rule.
 * The briefing passes `origin` on each alert once the contract's (strict) briefing alert object carries it; until then the
 * origin is shown in the source text ("News review: <source>"), which the prompt rule names. Contract change routed to Fable.
 */
const ALERT_ORIGIN_IN_CONTRACT = "origin" in FarmBriefing.shape.alerts.element.shape;
export const NEWS_SOURCE_PREFIX = "News review: ";

/** Printed soil units mapped to contract units; anything else is passed without a value. */
export function soilUnit(raw: string | null, parameter: string): Unit | null {
  const u = (raw ?? "").toLowerCase().replace(/\s+/g, "").replace(/⁻¹/g, "-1");
  if (parameter === "ph" && (u === "" || u === "-" || u === "ph" || u === "units")) return "pH";
  const map: Record<string, Unit> = { "kg/ha": "kg/ha", "%": "percent", percent: "percent", "ds/m": "dS/m", "dsm-1": "dS/m", ppm: "ppm", "mg/kg": "mg/kg", "t/ha": "kg/ha" };
  if (u === "t/ha") return null; // would need a conversion; not inferred here
  return map[u] ?? null;
}

// ------------------------------------------------------------------ the handler

type Briefing = FarmBriefing;

export function bindFarmBriefing(deps: BriefingDeps): ToolHandler<"get_farm_briefing"> {
  return (input, ctx) => farmBriefing(deps, input.farmId, ctx, input.fieldId);
}

/**
 * The field the briefing describes (FIELDS_MULTICROP_SOIL_SPEC.md 12.5): the named field (404 field_not_found when unknown);
 * without one on a farm with fields, the first field in stored order with a current cycle of its own (`picked`), else none
 * (the whole farm, as the Today view does for a cycle recorded before fields were drawn). A farm without fields: none.
 */
export function briefingField(ws: Pick<FarmWorkspace, "fields" | "cycles">, fieldId: string | undefined): { field: FarmField | null; picked: boolean } {
  if (fieldId !== undefined) return { field: fieldOf(ws, fieldId), picked: false };
  const field = ws.fields.find((f) => currentCycle(ws, f.id)) ?? null;
  return { field, picked: field !== null };
}

export async function farmBriefing(deps: BriefingDeps, farmId: string, ctx: ToolContext, fieldId?: string): Promise<ToolOutput<"get_farm_briefing">> {
  if (!UUID.test(farmId)) throw notFound("Farm");
  const ro = readOnlyPool(ctx.pool);
  const farm = await getFarm(ro, ctx.ownerId, farmId);
  if (!farm) throw notFound("Farm"); // identical for missing and foreign farms
  const config: Config = { ...deps.config, RUNTIME_MODE: ctx.mode };
  const now = () => new Date(ctx.asOf);
  const svc = { pool: ro, config, budget: deps.budget, now };
  // 12.5: the field is resolved once, before the sections, so every section describes the same field.
  const stored = await getWorkspace(ro, ctx.ownerId, farmId);
  const { field, picked } = briefingField(stored, fieldId);
  const fid = field?.id;

  // ---- sections in parallel, each guarded; the whole composition is bounded
  const done = new Map<string, unknown>();
  const failed = new Map<string, string>();
  const section = <T>(name: string, fn: () => Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .then(
      (v) => void done.set(name, v),
      (e: unknown) => void failed.set(name, e instanceof ReadOnlyViolation ? "it would have needed a write" : (e as { code?: unknown })?.code === "not_found" ? "not found" : "it could not be read now"),
    );
  const tasks = [
    // Fields (12.5, 2026-11-03): the Today view, year plan, soil review crop context, saved seasons and crop fit are the
    // field's; soil readings and the journal stay farm-level. A farm without fields (fid undefined) reads exactly as before.
    section("today", async () =>
      todayView(
        { config, pool: ro, now, sentinelFetch: noNetwork as never, weatherFetch: noNetwork as never, providers: { readyFutureLooks: async () => [], ...deps.today?.providers }, ...(deps.today?.snapshot ? { snapshot: deps.today.snapshot } : {}) },
        ctx.ownerId,
        farmId,
        { asOf: ctx.asOf, predictions: "off", ...(fid !== undefined ? { fieldId: fid } : {}) },
      ),
    ),
    section("soilMarkers", () => farmSoilMarkers(svc, ctx.ownerId, farmId)),
    section("soilReview", () => readSoilReview(svc, ctx.ownerId, farmId, fid ?? null)),
    section("yearPlan", () => readYearPlan(svc, ctx.ownerId, farmId, fid !== undefined ? { fieldId: fid } : {})),
    section("workspace", async () => fieldView(stored, fid ?? null)),
    // 2026-11-04: crop fit on a farm with fields always ranks one field (crop-fit defaultFieldId when none is named), so with no
    // field picked here the stored review of that default field is read.
    section("cropFit", () => storedCropFit(ro, ctx.ownerId, farmId, ctx.mode, fid ?? defaultFieldId(stored))),
    section("journal", () => listEntries(ro, ctx.ownerId, farmId, 60)),
    // Field operations (FIELD_OPERATIONS_SPEC.md 5.3): open issues and the next field check per field, plain reads; no model
    // is asked to interpret an issue.
    section("scouting", async () => briefingLines(stored, await scoutingState(ro, ctx.ownerId, farmId, ctx.mode, stored, istDate(ctx.asOf)))),
  ];
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const bounded = new Promise<"timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs ?? BRIEFING_TIMEOUT_MS);
    timer.unref?.();
    if (ctx.signal) {
      onAbort = () => resolve("aborted");
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const ended = await Promise.race([Promise.all(tasks).then(() => "done" as const), bounded]);
  if (timer) clearTimeout(timer);
  if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);

  const limitations: string[] = [];
  const LABEL: Record<string, string> = { today: "The Today view (crop stage, weather, satellite, alerts, steps, prices, expected returns)", soilMarkers: "The soil report readings", soilReview: "The soil ratings", yearPlan: "The year plan", workspace: "The saved seasons and previous harvest", cropFit: "The stored crop-fit review", journal: "The farm journal", scouting: "The field checks and issues" };
  for (const name of Object.keys(LABEL)) {
    if (failed.has(name)) limitations.push(`${LABEL[name]} could not be included: ${failed.get(name)}.`);
    else if (!done.has(name)) limitations.push(`${LABEL[name]} did not finish within ${Math.round((deps.timeoutMs ?? BRIEFING_TIMEOUT_MS) / 1000)} s${ended === "aborted" ? " (the request was cancelled)" : ""} and is not included.`);
  }
  const view = done.get("today") as TodayView | undefined;
  const today = view?.today ?? istDate(ctx.asOf);

  // ---- farm (never the name, coordinates or owner)
  const facts = farm.facts as Record<string, { value?: unknown; basis?: string } | undefined>;
  const known = (k: string) => (facts[k] && facts[k]!.basis !== "unknown" ? facts[k]!.value : undefined);
  const budgetFact = known("budget") as { amountInr?: unknown; per?: unknown } | undefined;
  const labour = known("labour");
  const briefing: Briefing = {
    asOf: new Date(ctx.asOf).toISOString(),
    today,
    farm: {
      districtId: farm.location.districtId,
      districtName: cut(farm.location.districtName, 120),
      stateId: farm.location.stateCode,
      stateName: cut(resolveStateName(farm.location.stateCode), 120),
      area: q(farm.areaHectares, "ha"),
      waterCategory: cut(irrigationCategoryOf(farm.facts as never), 60),
      labour: typeof labour === "string" ? cut(labour, 60) : null,
      budget: budgetFact && (budgetFact.per === "farm" || budgetFact.per === "ha") ? q(budgetFact.amountInr, budgetFact.per === "ha" ? "INR/ha" : "INR") : null,
    },
    cycle: null,
    weather: null,
    satellite: null,
    alerts: [],
    steps: { nextAction: null, upcoming: [] },
    price: null,
    economics: null,
    soil: null,
    plans: null,
    cropFit: null,
    journal: null,
    limitations: [],
  };

  if (view) composeFromToday(briefing, view, today, limitations);
  // Fields (12.5): only on a farm that has them (a farm without fields briefs exactly as before). viewedField names the field
  // described; the limitation says which field and, when the turn named none, that the first field with a crop was chosen.
  const fieldCount = stored.fields.length;
  if (fieldCount > 0) {
    briefing.fields = { count: fieldCount, viewedField: field ? cut(field.name, 80) : null };
    const n = `the farm has ${fieldCount} field${fieldCount > 1 ? "s" : ""}`;
    limitations.push(
      !field
        ? `No field has a current crop cycle, so the figures describe the whole farm; ${n}.`
        : picked
          ? `No field was selected, so this answer is about field ${field.name}, the first field with a current crop; ${n}.`
          : `This answer is about field ${field.name}; ${n}.`,
    );
  }
  // Field operations (5.3): one line per field (the farm without fields) with open issues and the next check, after the field
  // line, in the briefing's own `scouting` list (absent when there is nothing to say).
  const scoutingLines = ((done.get("scouting") as string[] | undefined) ?? []).map((l) => cut(l, 300)!).slice(0, 10);
  if (scoutingLines.length) briefing.scouting = scoutingLines;
  // Review fix 4: when the Today view's outlook note is missing or pending (ensureOutlookNote needs a transaction the read-only
  // pool refuses, or its job is still writing), the latest stored ready note for the same farm, mode and product is read
  // directly with a plain SELECT, so a ready note is never lost to the read-only wrapper.
  if (view && briefing.price && briefing.price.outlook === null && view.cycle?.productId && view.outlookNote?.status !== "unavailable") {
    const stored = await storedOutlookNote(ro, ctx.ownerId, farmId, ctx.mode, view.cycle.productId).catch(() => null);
    if (stored) {
      briefing.price.outlook = cut(stored.text, 300);
      limitations.push(`The harvest outlook sentence is the latest stored one (${istDate(stored.at.toISOString())}); it may predate the latest prices.`);
    }
  }
  composeSoil(briefing, done, limitations);
  composePlans(briefing, done, limitations, today);
  composeCropFit(briefing, done, limitations);
  composeJournal(briefing, done, ctx.mode, view?.cycle ?? null, limitations);

  // Review fix 3: each section is checked against its own contract schema; a section with an out-of-range value is left out
  // with a limitation naming it instead of failing the whole briefing (registry.execute parses the result strictly).
  guardSections(briefing, limitations);

  // Today-view notes after the briefing's own (deduplicated, without the parts the briefing does not use, at most 10).
  // Review fix 4: the guard lines the read-only wrapper itself causes (satellite scene reads refused by the no-network seam,
  // the outlook note's refused transaction) are not data gaps of the farm; they become one plain sentence.
  // The view's own "This farm has N fields; this view describes ..." line is replaced by the briefing's field line above.
  const UNUSED = /Today overview|Stage illustration|harvest outlook sentence is written|monitor|^This farm has \d+ fields?;/i;
  // In the briefing every provider call is refused by the no-network seam, so a provider_unreachable/briefing_no_network code
  // is always the wrapper's, as is the outlook note's internal_error (its transaction refused by the read-only pool).
  const WRAPPER_CAUSED = /^The harvest outlook note could not be read now|scenes could not be read from the provider|^The scene catalogue could not be read now|\((?:provider_unreachable|briefing_no_network|read_only_briefing)\)/i;
  const todayNotes = (view?.limitations ?? []).filter((l) => !UNUSED.test(l));
  if (todayNotes.some((l) => WRAPPER_CAUSED.test(l))) limitations.push("Satellite scenes and the harvest outlook note are not refreshed in the briefing; it shows only what is already stored.");
  limitations.push(...todayNotes.filter((l) => !WRAPPER_CAUSED.test(l)).slice(0, 10).map((l) => cut(l, 200)!));
  briefing.limitations = [...new Set(limitations.map((l) => cut(l.replace(COORD_PAIR, "[coordinates removed]"), 240)!).filter(Boolean))].slice(0, 20);
  return fitSize(briefing);
}

const SECTION_LABEL = {
  cycle: "The crop cycle and stage",
  weather: "The weather",
  satellite: "The satellite reading",
  price: "The price outlook",
  economics: "The expected returns and footprint",
  soil: "The soil readings and ratings",
  plans: "The year plan, saved seasons and previous harvest",
  cropFit: "The crop-fit picks",
  journal: "The farm journal",
} as const;

/**
 * Validates each section against its sub-schema of the contract (FarmBriefing.shape). A nullable section that fails is set to
 * null; a failing alert or step is dropped; a failing farm field is set to null. Each removal adds a limitation naming the part.
 * Exported for tests.
 */
export function guardSections(b: Briefing, lim: string[]): void {
  const shape = FarmBriefing.shape;
  const msg = (label: string) => `${label} could not be included: a stored value did not fit the briefing format.`;
  for (const key of Object.keys(SECTION_LABEL) as (keyof typeof SECTION_LABEL)[]) {
    if (b[key] !== null && !shape[key].safeParse(b[key]).success) {
      (b as Record<string, unknown>)[key] = null;
      lim.push(msg(SECTION_LABEL[key]));
    }
  }
  const farmShape = shape.farm.shape;
  for (const key of Object.keys(farmShape) as (keyof typeof farmShape)[]) {
    if (!farmShape[key].safeParse(b.farm[key]).success) {
      (b.farm as Record<string, unknown>)[key] = null;
      lim.push(msg(`The farm's ${key}`));
    }
  }
  const alertOk = shape.alerts.element;
  const alerts = b.alerts.filter((a) => alertOk.safeParse(a).success);
  if (alerts.length < b.alerts.length) lim.push(msg(`${b.alerts.length - alerts.length} alert(s)`));
  b.alerts = alerts;
  const stepOk = shape.steps.shape.upcoming.element;
  if (b.steps.nextAction && !stepOk.safeParse(b.steps.nextAction).success) {
    b.steps.nextAction = null;
    lim.push(msg("The next action"));
  }
  const upcoming = b.steps.upcoming.filter((x) => stepOk.safeParse(x).success);
  if (upcoming.length < b.steps.upcoming.length) lim.push(msg(`${b.steps.upcoming.length - upcoming.length} upcoming step(s)`));
  b.steps.upcoming = upcoming;
}

/** The latest stored ready harvest-outlook note of the farm for this mode and product (plain SELECT; never ensureOutlookNote). */
async function storedOutlookNote(pool: Pool, ownerId: string, farmId: string, mode: string, productId: string): Promise<{ text: string; at: Date } | null> {
  const row = (
    await pool.query<{ text: string | null; updated_at: Date }>(
      "SELECT text, updated_at FROM farm_outlook_notes WHERE owner_id=$1 AND farm_id=$2 AND mode=$3 AND product_id=$4 AND status='ready' AND text IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
      [ownerId, farmId, mode, productId],
    )
  ).rows[0];
  return row?.text ? { text: row.text, at: row.updated_at } : null;
}

/** Keeps the stored result under BRIEFING_MAX_CHARS: limitations first, then long texts, then list lengths. */
export function fitSize(b: Briefing): Briefing {
  const size = () => JSON.stringify(b).length;
  while (size() > BRIEFING_TARGET_CHARS && b.limitations.length > 6) b.limitations.pop();
  if (size() > BRIEFING_TARGET_CHARS && b.scouting && b.scouting.length > 3) b.scouting.length = 3;
  if (size() > BRIEFING_TARGET_CHARS) {
    b.alerts = b.alerts.map((a) => ({ ...a, detail: cut(a.detail, 140)!, suggestedStep: cut(a.suggestedStep, 120) }));
    b.steps.upcoming = b.steps.upcoming.map((s) => ({ ...s, detail: cut(s.detail, 100) }));
    if (b.soil) b.soil.narrative = null;
  }
  while (size() > BRIEFING_TARGET_CHARS && b.steps.upcoming.length > 4) b.steps.upcoming.pop();
  while (size() > BRIEFING_TARGET_CHARS && b.journal && b.journal.entries.length > 3) b.journal.entries.pop();
  while (size() > BRIEFING_TARGET_CHARS && b.soil && b.soil.facts.length > 3) b.soil.facts.pop();
  while (size() > BRIEFING_MAX_CHARS && b.limitations.length > 1) b.limitations.pop();
  return b;
}

// ------------------------------------------------------------------ sections

/** Exported for tests. */
export function composeFromToday(b: Briefing, v: TodayView, today: string, lim: string[]): void {
  // cycle and stage
  if (v.cycle) {
    const c = v.cycle;
    const anchor = c.establishmentDate ?? c.sowingDate;
    const stages = v.timeline?.stages ?? [];
    const current = [...stages].reverse().find((s) => s.from <= today && today <= s.to) ?? null;
    const next = stages.find((s) => s.from > today) ?? null;
    const harvest = v.timeline?.harvest ?? null;
    b.cycle = {
      cropId: c.cropId,
      cropName: cut(v.product?.cropName ?? c.cropName ?? cropDisplayName(c.cropId), 120)!,
      productId: c.productId ?? null,
      productName: cut(v.product?.productName ?? c.productName ?? null, 120),
      sowingDate: c.sowingDate,
      establishmentDate: c.establishmentDate ?? null,
      establishmentMethod: cut(c.establishmentMethod ?? null, 80),
      workspaceStage: c.stage,
      dayOfSeason: dayDiff(anchor, today) >= 0 ? q(dayDiff(anchor, today), "days") : null,
      stageToday: current ? { id: cut(current.id, 80)!, name: cut(current.name, 80)!, from: current.from, to: current.to, basis: current.basis } : null,
      nextStage: next ? { id: cut(next.id, 80)!, name: cut(next.name, 80)!, from: next.from, to: next.to } : null,
      harvestWindow: harvest ? { earliest: harvest.earliest, latest: harvest.latest } : null,
      daysToHarvest: v.daysToHarvest ? rng(v.daysToHarvest.earliest, v.daysToHarvest.latest, "days") : null,
      timelineBasis: v.timeline ? cut(v.timeline.basis.label, 200) : null,
      satellitePhase: v.indexStage
        ? { status: v.indexStage.status, phase: v.indexStage.phase, asOf: v.indexStage.asOf, agreement: v.indexStage.agreement, summary: cut(v.indexStage.summary, 300) ?? "" }
        : null,
    };
    if (!v.timeline || stages.length === 0) lim.push("No stage timeline exists for the current crop, so the stage of the crop today is not shown.");
  } else lim.push("This farm has no current crop cycle, so there is no crop stage, step list, price or expected return for a growing crop.");

  // weather: observed (last 7 days with data) and forecast (next 7 days), separate so the gate can tell them apart by pointer
  const day = (p: TodayView["weatherTrack"][number]) => ({ date: p.date, rainMm: q(p.rainMm, "mm"), tMinC: q(p.tMinC, "celsius"), tMaxC: q(p.tMaxC, "celsius") });
  const hasData = (p: TodayView["weatherTrack"][number]) => p.rainMm !== null || p.tMinC !== null || p.tMaxC !== null;
  const observedPts = v.weatherTrack.filter((p) => p.kind === "observed" && p.date < today && hasData(p)).slice(-7);
  const forecastPts = v.weatherTrack.filter((p) => p.kind === "forecast" && p.date >= today).slice(0, 7);
  if (observedPts.length || forecastPts.length) {
    const sum = (pts: typeof observedPts) => (pts.some((p) => p.rainMm !== null) ? pts.reduce((n, p) => n + (p.rainMm ?? 0), 0) : null);
    const src = forecastPts[0]?.basis ?? observedPts.at(-1)?.basis ?? null;
    b.weather = {
      source: cut(src?.source ?? null, 120),
      issuedAt: forecastPts[0]?.basis.issuedAt ?? null,
      observed: observedPts.map(day),
      forecast: forecastPts.map(day),
      rainLast7Days: q(sum(observedPts), "mm"),
      rainNext7Days: q(sum(forecastPts), "mm"),
    };
    if (observedPts.some((p) => p.rainMm === null) || forecastPts.some((p) => p.rainMm === null)) lim.push("Some weather days have no rain value; the 7-day rain totals add only the days that have one.");
    if (!forecastPts.length) lim.push("No weather forecast is stored for the coming days.");
  } else lim.push("No observed or forecast weather is stored for this field's location.");

  // satellite
  const latest = v.ndvi?.latestUsable ?? null;
  if (v.health || latest) {
    const usable = (v.ndvi?.readings ?? []).filter((x) => x.usable && x.field.mean !== null);
    // Review nit (b): ndvi and latestDate come from health when it exists, so "previous" is the usable reading before that date.
    const latestDate = v.health?.date ?? latest?.date ?? null;
    const prev = latestDate ? [...usable].reverse().find((x) => x.date < latestDate) ?? null : null;
    const idx = latest?.field.indices ?? null;
    b.satellite = {
      latestDate,
      ndvi: qs(v.health?.ndviMean ?? latest?.field.mean ?? null, "index"),
      neighbourhoodNdvi: qs(v.health?.neighbourhoodMean ?? latest?.neighbourhood?.mean ?? null, "index"),
      typicalRange: v.health?.typicalRange ? rng(v.health.typicalRange.low, v.health.typicalRange.high, "index", undefined, s3) : null,
      verdict: v.health?.verdict ?? null,
      clearShare: q(fin(v.health?.clearFraction) ? v.health!.clearFraction * 100 : latest ? latest.field.clearFraction * 100 : null, "percent"),
      previous: prev && fin(prev.field.mean) ? { date: prev.date, ndvi: qs(prev.field.mean, "index")! } : null,
      indices: idx
        ? (Object.entries(idx) as [string, { mean: number | null } | null][]).flatMap(([k, s]) => (s && fin(s.mean) ? [{ name: k.toUpperCase(), mean: qs(s.mean, "index")! }] : []))
        : [],
      source: "Copernicus Sentinel-2 L2A via Microsoft Planetary Computer (field polygon mean of clear pixels)",
    };
  } else lim.push("No usable satellite reading of the field is stored.");

  // alerts, ranked warning > watch > info
  b.alerts = [...v.alerts]
    .sort((a, z) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[z.severity] ?? 3) || z.validFrom.localeCompare(a.validFrom))
    .slice(0, 5)
    .map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      ...(ALERT_ORIGIN_IN_CONTRACT ? { origin: a.origin } : {}),
      title: cut(a.title, 120)!,
      detail: cut(a.detail, 300)!,
      validFrom: a.validFrom,
      validTo: a.validTo,
      suggestedStep: cut(a.suggestedStep, 300),
      source: cut(!ALERT_ORIGIN_IN_CONTRACT && a.origin === "grounded_review" ? `${NEWS_SOURCE_PREFIX}${a.source.name}` : a.source.name, 200)!,
      sourceDate: a.source.date,
    }));
  if (v.alerts.length > 5) lim.push(`${v.alerts.length - 5} lower-ranked alerts are not included.`);

  // steps
  const step = (s: NonNullable<TodayView["nextAction"]>) => ({ id: cut(s.id, 160)!, kind: s.kind, title: cut(s.title, 160)!, detail: cut(s.detail, 240), dueFrom: s.dueFrom, dueTo: s.dueTo, status: s.status });
  const nextAction = v.nextAction ?? null;
  const upcoming = v.upcoming.filter((s) => s.id !== nextAction?.id);
  b.steps = { nextAction: nextAction ? step(nextAction) : null, upcoming: upcoming.slice(0, 8).map(step) };
  if (upcoming.length > 8) lim.push(`${upcoming.length - 8} later steps are not included.`);

  // price
  if (v.harvestPrice || v.priceTrack.length) {
    const hp = v.harvestPrice;
    const obs = [...v.priceTrack].reverse().find((p) => p.kind === "observed" && p.p50 !== null && p.date <= today) ?? null;
    const harvestDate = v.harvestEconomics?.harvestDate ?? null;
    b.price = {
      status: hp?.status ?? "insufficient",
      scopeLabel: cut(hp?.scopeLabel ?? "Mandi price track", 160)!,
      harvestDate,
      harvestPrice: hp ? q(hp.p50, "INR/kg") : null,
      likelyRange: hp?.range ? rng(hp.range.low, hp.range.high, "INR/kg") : null,
      latestObserved: obs ? { date: obs.date, median: q(obs.p50, "INR/kg")! } : null,
      outlook: v.outlookNote && v.outlookNote.status === "ready" ? cut(v.outlookNote.text, 300) : null,
    };
  } else if (v.cycle) lim.push("No mandi price reference applies to the current crop.");

  // economics and footprint: omit null blocks, keep each block's own limitation text
  const econ: NonNullable<Briefing["economics"]> = {};
  const lims = (l: readonly string[]) => l.slice(0, 3).map((x) => cut(x, 240)!);
  const he = v.harvestEconomics;
  if (he) {
    econ.harvest = {
      status: he.status,
      reason: cut(he.reason, 120),
      yieldForField: he.yieldForFieldKg ? rng(he.yieldForFieldKg.low, he.yieldForFieldKg.high, "kg") : null,
      revenueForField: he.revenueForField ? rng(he.revenueForField.likely.low, he.revenueForField.likely.high, "INR", he.revenueForField.central) : null,
      costPerHa: he.cost ? q(he.cost.a2flPerHa ?? he.cost.c2PerHa ?? he.cost.reportedPerHa, "INR/ha") : null,
      profitForField: he.profitForField ? rng(he.profitForField.likely.low, he.profitForField.likely.high, "INR", he.profitForField.central) : null,
      limitations: lims(he.limitations),
    };
  }
  const ri = v.residueIncome;
  if (ri) {
    econ.residue = {
      status: ri.status,
      reason: cut(ri.reason, 120),
      residueName: cut(ri.residueName, 80),
      surplusForField: ri.surplusForFieldKg ? rng(ri.surplusForFieldKg.low / 1000, ri.surplusForFieldKg.high / 1000, "t") : null,
      options: ri.options.slice(0, 4).map((o) => ({ label: cut(o.label, 80)!, incomeForField: o.incomeForField ? rng(o.incomeForField.low, o.incomeForField.high, "INR") : null })),
      limitations: lims(ri.limitations),
    };
  }
  const ef = v.energyFootprint;
  if (ef) {
    econ.energy = {
      status: ef.status,
      reason: cut(ef.reason, 120),
      inputEnergyForField: ef.inputEnergyGJForField ? rng(ef.inputEnergyGJForField.low, ef.inputEnergyGJForField.high, "GJ") : null,
      residueEnergyForField: ef.residueEnergyGJForField ? rng(ef.residueEnergyGJForField.low, ef.residueEnergyGJForField.high, "GJ") : null,
      limitations: lims(ef.limitations),
    };
  }
  const cf = v.carbonFootprint;
  if (cf) {
    const terms = cf.terms.filter((t) => t.kind === "baseline" && t.tCO2eForField !== null);
    const largest = terms.sort((a, z) => z.tCO2eForField!.high - a.tCO2eForField!.high)[0] ?? null;
    econ.carbon = {
      status: cf.status,
      reason: cut(cf.reason, 120),
      emissionsForField: cf.emissionsForField ? rng(cf.emissionsForField.low, cf.emissionsForField.high, "tCO2e") : null,
      largestTerm: largest ? { label: cut(largest.label, 80)!, amount: rng(largest.tCO2eForField!.low, largest.tCO2eForField!.high, "tCO2e")! } : null,
      limitations: lims(cf.limitations),
    };
  }
  if (Object.keys(econ).length) b.economics = econ;
}

function composeSoil(b: Briefing, done: Map<string, unknown>, lim: string[]): void {
  const markers = done.get("soilMarkers") as { samples: { reportDate: string | null; collectionDate: string | null; depth: { from: number; to: number; unit: string } | null }[] } | undefined;
  const review = done.get("soilReview") as import("@harvest/contracts").SoilReview | undefined;
  if (!markers && !review) return;
  if ((markers?.samples.length ?? 0) === 0 && (!review || review.readings.length === 0)) {
    lim.push("No confirmed soil report exists for this field.");
    return;
  }
  const unmapped: string[] = [];
  const readings = (review?.readings ?? []).slice(0, 16).map((x) => {
    const unit = soilUnit(x.unit, x.parameter);
    if (!unit && x.value !== null) unmapped.push(`${x.label} (${x.unit ?? "no unit"})`);
    return { parameter: cut(x.parameter, 60)!, label: cut(x.label, 120)!, measured: unit ? qs(x.value, unit) : null, rating: x.rating, status: x.status, assumption: cut(x.assumption, 300) };
  });
  if (unmapped.length) lim.push(`Soil readings printed in units the application does not carry are listed with their rating only: ${[...new Set(unmapped)].slice(0, 6).join(", ")}.`);
  if ((review?.readings.length ?? 0) > 16) lim.push(`${review!.readings.length - 16} further soil readings are not included.`);
  const depthUnit = (u: string): Unit | null => (Unit.safeParse(u).success ? (u as Unit) : null);
  const narrative = review?.narrative ? [...review.narrative.lines, ...review.narrative.afterHarvest, ...review.narrative.nextCrop].map((l) => cut(l, 160)!).slice(0, 11) : null;
  b.soil = {
    status: review?.status ?? "unavailable",
    samples: (markers?.samples ?? []).slice(0, 4).map((s) => ({ reportDate: s.reportDate, collectionDate: s.collectionDate, depth: s.depth && depthUnit(s.depth.unit) ? rng(s.depth.from, s.depth.to, depthUnit(s.depth.unit)!) : null })),
    readings,
    facts: (review?.facts ?? []).slice(0, 12).map((f) => cut(f, 200)!),
    narrative,
    narrativeOrigin: review?.narrativeOrigin ?? null,
    ratedFor: { currentCrop: cut(review?.currentCrop?.cropName ?? null, 120), nextCrop: cut(review?.nextCrop?.cropName ?? null, 120) },
  };
  for (const l of review?.limitations ?? []) lim.push(l);
}

function composePlans(b: Briefing, done: Map<string, unknown>, lim: string[], today: string): void {
  const plan = done.get("yearPlan") as import("@harvest/contracts").YearPlanReview | undefined;
  const ws = done.get("workspace") as import("@harvest/contracts").FarmWorkspace | undefined;
  if (!plan && !ws) return;
  const chosenId = plan?.appliedOptionIds?.[0];
  const chosen = plan?.options.find((o) => o.optionId === chosenId) ?? null;
  const opt = chosen ?? plan?.options[0] ?? null;
  const prev = ws?.previousHarvest;
  b.plans = {
    status: plan?.status ?? "unavailable",
    stale: plan?.stale ?? false,
    option: opt
      ? {
          optionId: cut(opt.optionId, 120)!,
          label: cut(opt.label, 60)!,
          chosen: chosen !== null,
          slots: opt.slots.slice(0, 6).map((s) => ({
            cropName: cut(s.cropName, 120)!,
            productName: cut(s.productName, 120)!,
            kind: s.kind ?? "crop",
            fixed: s.fixed,
            sowing: s.sowing,
            harvest: { earliest: s.harvest.earliest, latest: s.harvest.latest },
            yield: s.yieldKgPerHa ? rng(s.yieldKgPerHa.low, s.yieldKgPerHa.high, "kg/ha") : null,
            harvestPrice: s.price && s.price.status === "available" ? q(s.price.p50, "INR/kg") : null,
            cost: s.cost ? q(s.cost.a2flPerHa ?? s.cost.c2PerHa ?? s.cost.reportedPerHa, "INR/ha") : null,
            margin: s.profitPerHa ? rng(s.profitPerHa.low, s.profitPerHa.high, "INR/ha", s.profitEstimate?.central) : null,
          })),
        }
      : null,
    savedSeasons: (ws?.rotationPlans ?? []).slice(0, 6).map((p) => ({
      id: cut(p.id, 120)!,
      year: p.year,
      season: cut(p.season, 80)!,
      cropName: cut(p.cropName ?? cropDisplayName(p.cropId), 120)!,
      productName: cut(p.productName ?? null, 120),
      kind: p.kind ?? "crop",
      plannedSowingDate: p.plannedSowingDate ?? null,
      plannedHarvestDate: p.plannedHarvestDate ?? null,
      // EVARA_ACTIONS_SPEC 1.4: planned / overdue (replaceable) or sown, by the year plan's own rule on this field view.
      ...realisationOf(p, ws?.cycles ?? [], today),
    })),
    previousHarvest: prev ? { status: prev.status, cropName: prev.status === "known" ? cut(prev.cropName ?? cropDisplayName(prev.cropId), 120) : null, harvestDate: prev.status === "known" ? prev.harvestDate : null } : null,
    // EVARA_ACTIONS_SPEC 1.4: the year plan's alternatives (no free window), names and dates only; the growing crop (fixed slot)
    // is left out of each option's slots, so every slot listed is a new season. Null when the field has a free window.
    alternatives: alternativesOf(plan),
  };
  if (b.plans.alternatives) lim.push(b.plans.alternatives.basis === "sown_comparison" ? "The year plan's comparison plans show what could have fitted the field; they cannot be applied." : "The year plan's alternative plans would replace planned seasons that are not sown yet.");
  if (plan && !opt) lim.push("No year plan has been made for this field yet.");
  if (plan?.stale) lim.push("The stored year plan was made before later changes to the farm and may be out of date.");
  if (opt && !chosen) lim.push("No year-plan option has been applied; the first suggested option is shown.");
  if ((ws?.rotationPlans.length ?? 0) > 6) lim.push(`${ws!.rotationPlans.length - 6} further saved seasons are not included.`);
}

type PlanReview = import("@harvest/contracts").YearPlanReview;
/** Briefing view of YearPlanReview.alternatives: basis, summary (300), at most 2 options with at most 6 new-season slots. */
function alternativesOf(plan: PlanReview | undefined): NonNullable<NonNullable<Briefing["plans"]>["alternatives"]> | null {
  const a = plan?.alternatives;
  if (!a) return null;
  return {
    basis: a.basis,
    summary: cut(a.summary, 300)!,
    options: a.options.slice(0, 2).map((o) => ({
      optionId: cut(o.optionId, 120)!,
      label: cut(o.label, 60)!,
      slots: o.slots.filter((s) => !s.fixed).slice(0, 6).map((s) => ({ cropName: cut(s.cropName, 120)!, productName: cut(s.productName, 120)!, kind: s.kind ?? "crop", sowing: s.sowing, harvest: { earliest: s.harvest.earliest, latest: s.harvest.latest } })),
    })),
  };
}
function realisationOf(p: FarmWorkspace["rotationPlans"][number], cycles: FarmWorkspace["cycles"], today: string): { realisation?: string } {
  const r = seasonRealisation(p, cycles, today);
  return r ? { realisation: r } : {};
}

/** The latest ready crop-fit review stored for the farm, or for the field (12.5; read only; never ensureCropFit). */
export async function storedCropFit(pool: Pool, ownerId: string, farmId: string, mode: string, fieldId: string | null = null): Promise<{ review: import("@harvest/contracts").CropFitReview; createdAt: Date } | null> {
  const row = (
    await pool.query<{ result: unknown; created_at: Date }>(
      "SELECT result, created_at FROM crop_fit_reviews WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND archived_at IS NULL AND status='ready' AND result->>'fieldId' IS NOT DISTINCT FROM $4::text ORDER BY created_at DESC LIMIT 1",
      [farmId, ownerId, mode, fieldId],
    )
  ).rows[0];
  if (!row) return null;
  const parsed = CropFitReview.safeParse(row.result);
  return parsed.success ? { review: parsed.data, createdAt: row.created_at } : null;
}

function composeCropFit(b: Briefing, done: Map<string, unknown>, lim: string[]): void {
  if (!done.has("cropFit")) return;
  const stored = done.get("cropFit") as Awaited<ReturnType<typeof storedCropFit>>;
  if (!stored || stored.review.picks.length === 0) {
    lim.push("No crop-fit review is stored for this farm, so no ranked crop picks are included.");
    return;
  }
  const r = stored.review;
  b.cropFit = {
    generatedAt: r.generatedAt,
    picks: r.picks.slice(0, 3).map((p) => {
      const c = r.candidates.find((x) => x.cropId === p.cropId && x.productId === p.productId);
      // EVARA_ACTIONS_SPEC 1.4: the planned, unsown season(s) this pick would replace (replace pass), by crop name.
      const replaces = c?.replaces?.length ? cut(c.replaces.map((r) => r.cropName).join(" and "), 120) : null;
      return { rank: p.rank, cropId: cut(p.cropId, 120)!, cropName: cut(c?.cropName ?? cropDisplayName(p.cropId), 120)!, productName: cut(c?.productName ?? p.productId, 120)!, reason: cut(p.headline, 160) ?? "", replacesCropName: replaces };
    }),
  };
  lim.push("The crop-fit picks are the latest stored review; they may predate later changes to the farm.");
}

function composeJournal(b: Briefing, done: Map<string, unknown>, mode: string, cycle: TodayView["cycle"], lim: string[]): void {
  const rows = done.get("journal") as Awaited<ReturnType<typeof listEntries>> | undefined;
  if (!rows) return;
  const entries = rows.filter((e) => e.mode === mode);
  if (!entries.length) {
    lim.push("The farm journal has no entries.");
    return;
  }
  const qty = (v: string | null, u: string | null) => {
    if (v === null || !u) return null;
    const unit = Unit.safeParse(u);
    return unit.success ? q(v, unit.data) : null;
  };
  const from = cycle ? cycle.establishmentDate ?? cycle.sowingDate : null;
  const inCycle = from ? entries.filter((e) => e.entry_date >= from && (!cycle?.harvestDate || e.entry_date <= cycle.harvestDate)) : [];
  const total = (k: "sale_inr" | "expense_inr") => inCycle.reduce((n, e) => n + (num(e[k]) ?? 0), 0);
  b.journal = {
    entries: entries.slice(0, 8).map((e) => ({
      date: e.entry_date,
      kind: cut(e.activity ?? "note", 40)!,
      text: cut(e.text_body?.replace(COORD_PAIR, "[coordinates removed]") ?? null, 120),
      quantity: qty(e.quantity, e.quantity_unit),
      expense: q(e.expense_inr, "INR"),
      sale: q(e.sale_inr, "INR"),
    })),
    totalsSinceSowing: from ? { from, sales: q(total("sale_inr"), "INR")!, expenses: q(total("expense_inr"), "INR")!, entries: inCycle.length } : null,
  };
  if (entries.length > 8) lim.push(`${entries.length - 8} older journal entries are not included.`);
  if (entries.some((e) => e.quantity !== null && e.quantity_unit && !Unit.safeParse(e.quantity_unit).success)) lim.push("Some journal quantities use units the application does not carry and are left out.");
}
