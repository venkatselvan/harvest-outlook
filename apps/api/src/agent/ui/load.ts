import { type FarmBriefing, type FarmWorkspace, type Mode, type ToolOutput, type YearPlanReview } from "@harvest/contracts";
import type { Config } from "../../config";
import type { Pool } from "../../db/pool";
import { compareCrops, type ComparisonInput } from "../../catalogue/compare";
import { CatalogueStore } from "../../catalogue/snapshot";
import type { Budget } from "../../services/budget";
import { getFarm } from "../../services/farms";
import { stageTimeline } from "../../services/today/stage-timeline";
import { fieldView, getWorkspace } from "../../services/workspace";
import { cropDisplayName } from "../../services/year-plan/data";
import { seasonRealisation } from "../../services/year-plan/scenario";
import { readYearPlan } from "../../services/year-plan/service";
import { briefingField, readOnlyPool, storedCropFit } from "../bindings/briefing";
import { aliasesFromNames } from "../tools/handlers";
import { candidateFor, cropOf, journeySowing } from "./build";
import { CROP_INTENTS, fallbackCompareCrops, fallbackJourneyCrop } from "./compose";
import { parseEvaraLang, type Expr, type Statement } from "./parse";
import { timelineKey, type EvaraAnswerBlock, type EvaraCatalogueRow, type EvaraCropName, type EvaraOccupant, type EvaraResolveData, type EvaraTimeline } from "./types";

/**
 * Builds EvaraResolveData for one turn (docs/EVARA_LANG.md "Data"). Read-only by construction: every query goes through
 * `readOnlyPool` (agent/bindings/briefing.ts), nothing is enqueued, no model is called and no network is reached. Each
 * source is guarded: a failing source is reported and becomes absent data, never a failed turn. The whole load is bounded
 * (default 5 s) and stops early on the turn's abort signal; what finished is used.
 *
 * Sources: this run's tool results (in memory: get_farm_briefing, screen_crops, resolve_crop_identity); the catalogue
 * crop names (crop_identities); the workspace (the viewed field as the briefing picks it, its saved seasons and cycles);
 * the stored crop-fit review of the viewed field (storedCropFit from agent/bindings/briefing.ts); the stored year-plan review of the viewed field (readYearPlan, only when a plan component can appear); the
 * catalogue compare service for the crops a CropCompare can show; the stage calendar for the journeys a GrowthJourney can
 * show (stageTimeline, the timeline the season preview uses).
 */

export interface EvaraLoadContext {
  ownerId: string;
  mode: Mode;
  farmId: string | null;
  fieldId?: string | undefined;
  asOf: string;
  language: string;
  intent: string | null;
  blocks: EvaraAnswerBlock[];
  hasClarification: boolean;
  /** The model's program (parsed here only to know which crops and journeys to prepare). */
  program: string | null;
  /** Ok tool outputs of this run, in call order. */
  toolOutputs: { name: string; output: unknown }[];
  /** The server config (year-plan reads); without it the year plan is not read. */
  config?: Config | undefined;
  budget?: Budget | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** In-memory data only (cancelled or provider-unavailable turns). */
  skipDb?: boolean | undefined;
  /** Called once per source with its outcome (for the trace). */
  report?: ((source: string, status: "ok" | "failed" | "skipped" | "timeout") => void) | undefined;
}

export const EVARA_LOAD_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMPARE_CROPS = 12;
const MAX_JOURNEYS = 6;
const istDate = (iso: string) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(0, 10);

const stores = new WeakMap<Pool, CatalogueStore>();
function catalogueStore(pool: Pool): CatalogueStore {
  let s = stores.get(pool);
  if (!s) {
    s = new CatalogueStore(readOnlyPool(pool));
    stores.set(pool, s);
  }
  return s;
}

const lastOutput = <T>(outs: EvaraLoadContext["toolOutputs"], name: string): T | null => {
  for (let i = outs.length - 1; i >= 0; i--) if (outs[i]!.name === name) return outs[i]!.output as T;
  return null;
};

/** Literal crop ids and journey arguments the program names (through one level of refs), so only those are prepared. */
function programNeeds(program: string | null): { compareIds: string[]; addSeasonIds: string[]; journeys: { cropId: string; sowing: string | null }[]; components: Set<string> } {
  const { statements } = parseEvaraLang(program);
  const table = new Map<string, Statement>();
  for (const s of statements) table.set(s.name, s);
  const deref = (e: Expr | undefined): Expr | undefined => (e && e.k === "ref" ? table.get(e.name)?.expr : e);
  const strings = (e: Expr | undefined): string[] => {
    const x = deref(e);
    if (!x) return [];
    if (x.k === "str") return [x.v];
    if (x.k === "list") return x.items.flatMap((i) => strings(i));
    return [];
  };
  const compareIds: string[] = [];
  const addSeasonIds: string[] = [];
  const journeys: { cropId: string; sowing: string | null }[] = [];
  const components = new Set<string>();
  const visit = (e: Expr) => {
    if (e.k === "call" || e.k === "action") {
      components.add(e.k === "action" ? `@${e.name}` : e.name);
      if (e.k === "call" && e.name === "CropCompare") compareIds.push(...strings(e.args[0]));
      if (e.k === "action" && e.name === "AddSeason") addSeasonIds.push(...strings(e.args[0]).slice(0, 1));
      if (e.k === "call" && e.name === "GrowthJourney") {
        const crop = strings(e.args[0])[0];
        const d = deref(e.args[1]);
        if (crop) journeys.push({ cropId: crop, sowing: d && d.k === "str" ? d.v : null });
      }
      e.args.forEach(visit);
    } else if (e.k === "list") e.items.forEach(visit);
  };
  statements.forEach((s) => visit(s.expr));
  return { compareIds, addSeasonIds, journeys, components };
}

function cropsFromNames(rows: { id: string; slug: string; names: unknown }[]): Record<string, EvaraCropName> {
  const out: Record<string, EvaraCropName> = {};
  for (const r of rows) {
    const aliases = aliasesFromNames(r.names, r.slug);
    const first = (lang: string) => aliases.find((a) => a.language === lang || a.language.startsWith(`${lang}-`))?.text;
    const entry: EvaraCropName = { slug: r.slug, en: first("en") ?? cropDisplayName(r.slug), hi: first("hi"), ta: first("ta") };
    out[r.slug] = entry;
    out[r.id] = entry;
  }
  return out;
}

/** Comparison input from the farm facts, as screen_crops builds it (agent/bindings/int2.ts). */
function comparisonInput(farm: NonNullable<Awaited<ReturnType<typeof getFarm>>>, asOf: string, cropIds: string[]): ComparisonInput {
  const facts = farm.facts as Record<string, { value?: unknown } | undefined>;
  const sc = farm.location.stateCode;
  const win = facts.planting_window?.value as { start?: string } | undefined;
  const month = win?.start && /^\d{4}-\d{2}/.test(win.start) ? Number(win.start.slice(5, 7)) : new Date(asOf).getUTCMonth() + 1;
  const irr = facts.irrigation?.value;
  const drain = facts.soil_drainage?.value;
  const excluded = facts.excluded_crop_ids?.value;
  return {
    location: { stateId: sc ? (sc.startsWith("IN-") ? sc : `IN-${sc.toUpperCase()}`) : null, districtId: farm.location.districtId },
    planting: { month, date: null },
    irrigation: irr === "rainfed" || irr === "supplemental" || irr === "irrigated" ? irr : "unknown",
    soil: drain === "poor" || drain === "moderate" || drain === "good" ? { drainage: drain } : undefined,
    area: farm.areaHectares ? { amount: farm.areaHectares, unit: "ha" } : null,
    excludedCropIds: Array.isArray(excluded) ? (excluded as string[]) : [],
    cropIds,
  };
}

/**
 * Saved seasons of a field view with their realisation (EVARA_ACTIONS_SPEC.md 1.1), computed fresh from the workspace with the
 * year plan's own rule (services/year-plan/scenario.ts seasonRealisation: same crop, same field or farm-wide, sowing within
 * 45 days of the planned date; planned when the date is today or later, else overdue). Review fix E7c-1: a stored review's
 * realisation is never used, not even as a tie-break: a stale review could call a sown season "planned" and the resolver
 * would then accept @ReplaceSeason on it. The stored review contributes only the occupancy end, and only when its interval
 * starts on the season's current planned sowing date (a moved season's old interval is not its window).
 */
export function evaraOccupants(view: Pick<FarmWorkspace, "rotationPlans" | "cycles">, yearPlan: YearPlanReview | null, today: string): EvaraOccupant[] {
  const occupied = yearPlan?.scenario.occupied ?? [];
  return view.rotationPlans.map((p) => {
    const occ = occupied.find((o) => o.id === p.id);
    const sameDates = !!occ && !!p.plannedSowingDate && occ.sowing === p.plannedSowingDate;
    return {
      rotationPlanId: p.id,
      cropId: p.cropId,
      cropName: p.cropName ?? occ?.cropName ?? cropDisplayName(p.cropId),
      productId: p.productId ?? null,
      productName: p.productName ?? null,
      season: p.season,
      year: p.year,
      kind: p.kind ?? "crop",
      plannedSowingDate: p.plannedSowingDate ?? null,
      plannedHarvestDate: p.plannedHarvestDate ?? null,
      realisation: seasonRealisation(p, view.cycles, today),
      occupancyTo: sameDates ? occ!.occupancy.to : null,
    };
  });
}

export async function loadEvaraData(pool: Pool, ctx: EvaraLoadContext): Promise<EvaraResolveData> {
  const report = ctx.report ?? (() => undefined);
  const today = istDate(ctx.asOf);
  const briefing = lastOutput<FarmBriefing>(ctx.toolOutputs, "get_farm_briefing");
  const screening = lastOutput<ToolOutput<"screen_crops">>(ctx.toolOutputs, "screen_crops");
  const resolvedCropIds = ctx.toolOutputs
    .filter((o) => o.name === "resolve_crop_identity")
    .flatMap((o) => ((o.output as ToolOutput<"resolve_crop_identity">).candidates ?? []).map((c) => c.cropId));

  const data: EvaraResolveData = {
    language: ctx.language,
    today,
    intent: ctx.intent,
    blocks: ctx.blocks,
    hasClarification: ctx.hasClarification,
    briefing,
    screening,
    resolvedCropIds: [...new Set(resolvedCropIds)],
    cropFit: null,
    yearPlan: null,
    fieldId: null,
    occupants: [],
    currentCycle: briefing?.cycle ? { cropId: briefing.cycle.cropId, productId: briefing.cycle.productId, sowingDate: briefing.cycle.sowingDate } : null,
    crops: {},
    catalogueRows: {},
    timelines: {},
  };
  // Crop ids the run's own data already names are catalogue ids; they count even if the names query fails.
  const seedCrop = (slug: string, name?: string | null) => {
    if (slug && !data.crops[slug]) data.crops[slug] = { slug, en: name || cropDisplayName(slug) };
  };
  if (briefing?.cycle) seedCrop(briefing.cycle.cropId, briefing.cycle.cropName);
  for (const p of briefing?.cropFit?.picks ?? []) seedCrop(p.cropId, p.cropName);
  for (const r of screening?.results ?? []) seedCrop(r.cropId);

  if (ctx.skipDb || ctx.signal?.aborted) {
    report("database", "skipped");
    return data;
  }

  const ro = readOnlyPool(pool);
  const farmId = ctx.farmId && UUID.test(ctx.farmId) ? ctx.farmId : null;
  const needs = programNeeds(ctx.program);
  const intent = ctx.intent ?? "";
  const wantPlan = intent === "plan_question" || needs.components.has("PlanOptions") || needs.components.has("@UsePlan");
  const wantCompare = CROP_INTENTS.has(intent) || needs.components.has("CropCompare");
  // Review fix E7c-4: an @AddSeason date is checked against the crop's regional planting window, so its crops get compare rows too.
  const wantCatalogue = wantCompare || needs.addSeasonIds.length > 0;
  const wantJourney = intent === "growth_journey" || needs.components.has("GrowthJourney");

  let stored: FarmWorkspace | null = null;
  let farm: Awaited<ReturnType<typeof getFarm>> | null = null;
  let timedOut = false;
  const guard = async <T>(source: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const v = await fn();
      if (!timedOut) report(source, "ok");
      return v;
    } catch {
      if (!timedOut) report(source, "failed");
      return null;
    }
  };

  const work = (async () => {
    // ---- phase 1: names, workspace (viewed field), farm
    const [names, ws, f] = await Promise.all([
      guard("catalogue_names", async () => (await ro.query<{ id: string; slug: string; names: unknown }>("SELECT id::text AS id, slug, names FROM crop_identities ORDER BY slug")).rows),
      farmId ? guard("workspace", () => getWorkspace(ro, ctx.ownerId, farmId)) : Promise.resolve(null),
      farmId && (wantCatalogue || wantJourney) ? guard("farm", () => getFarm(ro, ctx.ownerId, farmId)) : Promise.resolve(null),
    ]);
    if (names) data.crops = { ...data.crops, ...cropsFromNames(names) };
    stored = ws;
    farm = f;
    let fid: string | null = null;
    if (ws) {
      try {
        fid = briefingField(ws, ctx.fieldId).field?.id ?? null;
      } catch {
        fid = null;
      }
    }
    data.fieldId = fid;

    // ---- phase 2: stored crop fit and year plan of the viewed field
    if (farmId) {
      const [fit, plan] = await Promise.all([
        guard("crop_fit", async () => {
          return (await storedCropFit(ro, ctx.ownerId, farmId, ctx.mode, fid))?.review ?? null;
        }),
        wantPlan && ctx.config && ctx.budget
          ? guard("year_plan", () => readYearPlan({ pool: ro, config: { ...ctx.config!, RUNTIME_MODE: ctx.mode }, budget: ctx.budget!, now: () => new Date(ctx.asOf) }, ctx.ownerId, farmId, fid ? { fieldId: fid } : {}))
          : Promise.resolve((report("year_plan", "skipped"), null) as YearPlanReview | null),
      ]);
      data.cropFit = fit;
      data.yearPlan = plan;
      for (const c of fit?.candidates ?? []) seedCrop(c.cropId, c.cropName);
    }

    // ---- phase 3 (code, no I/O except the cached catalogue snapshot): compare rows and stage timelines
    if (wantCatalogue) {
      const slugs = [...new Set([...needs.compareIds, ...needs.addSeasonIds, ...(wantCompare ? fallbackCompareCrops(data) : [])].map((id) => cropOf(data, id)?.slug).filter((s): s is string => !!s))].slice(0, MAX_COMPARE_CROPS);
      const f2 = farm as Awaited<ReturnType<typeof getFarm>> | null;
      if (slugs.length && f2) {
        await guard("catalogue_compare", async () => {
          const snap = await catalogueStore(pool).get();
          const out = compareCrops(snap, comparisonInput(f2, ctx.asOf, slugs), { mode: ctx.mode, now: new Date(ctx.asOf) });
          for (const it of out.items) {
            const known = data.catalogueRows[it.cropId];
            if (known) {
              // items are ranked; the first product of a crop is its best. Later products only add their planting window.
              if (it.plantingWindow && !known.plantingWindows!.some((w) => w.fromMonth === it.plantingWindow!.fromMonth && w.toMonth === it.plantingWindow!.toMonth))
                known.plantingWindows!.push({ fromMonth: it.plantingWindow.fromMonth, toMonth: it.plantingWindow.toMonth });
              continue;
            }
            const t = it.dimensions.timeToFirstIncome;
            const h = it.dimensions.harvestWindows;
            const w = it.dimensions.waterFit;
            const row: EvaraCatalogueRow = {
              cropId: it.cropId,
              cropName: it.cropName,
              outcome: it.outcome,
              season: it.season,
              plantingWindow: it.plantingWindow ? { fromMonth: it.plantingWindow.fromMonth, toMonth: it.plantingWindow.toMonth } : null,
              plantingWindows: it.plantingWindow ? [{ fromMonth: it.plantingWindow.fromMonth, toMonth: it.plantingWindow.toMonth }] : [],
              durationDays: t.status === "known" ? { min: (t.value as { minDays: number }).minDays, max: (t.value as { maxDays: number | null }).maxDays ?? null } : null,
              water: w.status === "known" ? { fit: (w.value as { fit: "matches" | "partial" | "mismatch" }).fit, needClass: (w.value as { waterNeedClass?: string }).waterNeedClass ?? null } : null,
              harvest: h.status === "known" ? { earliest: (h.value as { earliest: string }).earliest, latest: (h.value as { latest: string }).latest } : null,
            };
            data.catalogueRows[it.cropId] = row;
          }
        });
      } else report("catalogue_compare", "skipped");
    }
    if (wantJourney) {
      const asked = [...needs.journeys];
      const fb = fallbackJourneyCrop(data);
      if (fb) asked.push({ cropId: fb, sowing: null });
      const f2 = farm as Awaited<ReturnType<typeof getFarm>> | null;
      const stateId = f2?.location.stateCode ?? null;
      const districtId = f2?.location.districtId ?? null;
      for (const j of asked.slice(0, MAX_JOURNEYS)) {
        const c = cropOf(data, j.cropId);
        if (!c || (j.sowing !== null && !/^\d{4}-\d{2}-\d{2}$/.test(j.sowing))) continue;
        const sowing = journeySowing(data, c.slug, j.sowing);
        const key = timelineKey(c.slug, sowing);
        if (data.timelines[key]) continue;
        const cand = candidateFor(data, c.slug);
        try {
          const tl = stageTimeline({
            cropId: c.slug,
            productId: cand?.productId ?? (data.currentCycle?.cropId === c.slug ? data.currentCycle.productId : null),
            establishmentMethod: cand?.establishmentMethod ?? null,
            anchorDate: sowing,
            stateId,
            districtId,
          });
          const t: EvaraTimeline = { stages: tl.stages.map((s) => ({ id: s.id, name: s.name, from: s.from, to: s.to, basis: s.basis })), harvest: tl.harvest };
          data.timelines[key] = t;
        } catch {
          report("stage_timeline", "failed");
        }
      }
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const bounded = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ctx.timeoutMs ?? EVARA_LOAD_TIMEOUT_MS);
    timer.unref?.();
    if (ctx.signal) {
      onAbort = () => resolve("timeout");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const ended = await Promise.race([work.then(() => "done" as const, () => "done" as const), bounded]);
  if (timer) clearTimeout(timer);
  if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
  if (ended === "timeout") {
    timedOut = true;
    report("load", "timeout");
  }

  // Saved seasons of the viewed field with their realisation, computed fresh (evaraOccupants).
  const ws = stored as FarmWorkspace | null;
  if (ws) {
    try {
      const view = fieldView(ws, data.fieldId);
      data.occupants = evaraOccupants(view, data.yearPlan, today);
      if (!data.currentCycle) {
        const growing = view.cycles.filter((c) => c.stage !== "harvested").sort((a, b) => b.sowingDate.localeCompare(a.sowingDate))[0];
        if (growing) data.currentCycle = { cropId: growing.cropId, productId: growing.productId ?? null, sowingDate: growing.sowingDate };
      }
    } catch {
      report("occupants", "failed");
    }
  }
  return data;
}
