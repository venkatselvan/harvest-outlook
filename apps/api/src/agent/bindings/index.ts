import type { ToolOutput } from "@harvest/contracts";
import type { Pool } from "../../db/pool";
import { ScenarioSelection, type PlanService, type PlanView } from "../../plans";
import { notFound } from "../../services/errors";
import { payloadHash } from "../../services/hash";
import { enqueue, type JobRecord } from "../../services/jobs";
import { getMedia } from "../../services/media";
import { SEGMENT_JOB_TYPE } from "../../vision/jobs/segmentation";
import { implementedBindings } from "../tools/handlers";
import type { ToolBindings, ToolContext, ToolHandler } from "../tools/registry";
import type { Budget } from "../../services/budget";
import { bindMarketOutlook, bindScreenCrops, bindVisualKeyframes, type Int2Deps } from "./int2";
import { journalToolBindings, type JournalService } from "../../journal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

export interface BindingDeps {
  pool: Pool;
  plans: PlanService;
  budget: Budget;
  segmentModel: string;
  /** INT2: optional so unit tests of the T08/T10 bindings need no catalogue; production passes all of them. */
  int2?: Omit<Int2Deps, "pool" | "budget"> | undefined;
  journal?: JournalService | undefined;
}

/** Owner-scoped plan read. Foreign and missing plans are both 404 (PlanService enforces ownership in SQL). */
async function ownedPlan(deps: BindingDeps, ctx: ToolContext, planId: string): Promise<PlanView> {
  if (!UUID.test(planId)) throw notFound("Plan");
  return deps.plans.getPlan(ctx.ownerId, planId);
}

function selectedTiming(view: PlanView): "early" | "late" {
  const a = (view.snapshot.assumptions as { id: string; value?: { kind?: string; value?: unknown } | null }[]).find((x) => x.id === "selected_scenario");
  if (a?.value?.kind === "category" && typeof a.value.value === "string") {
    const [stageTiming, economicsScenario] = a.value.value.split("/");
    const r = ScenarioSelection.safeParse({ stageTiming, economicsScenario });
    if (r.success) return r.data.stageTiming;
  }
  return "early";
}

/** Pointer-style result ids: `plan-output:<outputId>/<json pointer>`. The ids are stable for a stored (immutable) plan output. */
const pointerId = (outputId: string, pointer: string) => `plan-output:${outputId}${pointer}`;

export function createToolBindings(deps: BindingDeps): ToolBindings {
  const calculateScenarios: ToolHandler<"calculate_scenarios"> = async (input, ctx) => {
    if (input.planId === undefined) return unavailable("context_scenarios_not_supported") as never;
    const view = await ownedPlan(deps, ctx, input.planId);
    // Overrides would need a non-persisted recompute that the engine does not expose; returning the stored
    // scenarios as if they honoured the overrides would let the model report numbers that do not match them.
    if (input.overrides && Object.keys(input.overrides).length > 0) return unavailable("overrides_not_supported") as never;
    const out = view.outputs.find((o) => o.kind === "economics");
    const econ = out?.output as { variants?: { result: ToolOutput<"calculate_scenarios">["result"] }[] } | undefined;
    const variant = econ?.variants?.[0];
    if (!out || !variant) return unavailable("economics_unavailable") as never;
    return { resultId: pointerId(out.id, "/variants/0/result"), result: variant.result };
  };

  const calculateWaterBalance: ToolHandler<"calculate_water_balance"> = async (input, ctx) => {
    const view = await ownedPlan(deps, ctx, input.planId);
    // The stored balance was computed by the engine with its own weather/soil/stage references; the model's refs
    // are not trusted to alter it. A forecast-ignoring variant is not stored, so it is reported unavailable.
    if (input.forecastRainPolicy === "ignore_forecast") return unavailable("forecast_policy_not_supported") as never;
    const out = view.outputs.find((o) => o.kind === "water");
    const water = out?.output as { status?: string; byTiming?: Record<string, ToolOutput<"calculate_water_balance">["result"]> } | undefined;
    const timing = selectedTiming(view);
    const result = water?.status === "computed" ? (water.byTiming?.[timing] ?? Object.values(water.byTiming ?? {})[0]) : undefined;
    if (!out || !result) return unavailable("water_balance_unavailable") as never;
    return { resultId: pointerId(out.id, `/byTiming/${timing in (water?.byTiming ?? {}) ? timing : Object.keys(water!.byTiming!)[0]}`), result };
  };

  const requestSegmentation: ToolHandler<"request_segmentation"> = async (input, ctx) => {
    if (!UUID.test(input.mediaId)) throw notFound("Media");
    const media = await getMedia(deps.pool, ctx.ownerId, input.mediaId);
    if (!media) throw notFound("Media");
    // Budget is reserved by the worker at dispatch; here we only refuse when the global allowance is already spent.
    const summary = await deps.budget.summary().catch(() => null);
    if (summary?.exhausted) return { jobId: null, budgetGate: "denied" as const, manualFallbackAvailable: true as const };
    const payload = { mediaId: media.id, prompt: input.prompt, sessionId: null };
    const base = `vseg:${payloadHash({ owner: ctx.ownerId, sha: media.sha256, prompt: input.prompt, model: deps.segmentModel }).slice(0, 48)}`;
    const reusable = (j: JobRecord) => !(j.state === "failed" || j.state === "cancelled" || (j.state === "succeeded" && (j.result as { status?: string } | null)?.status === "unavailable"));
    let out = await enqueue(deps.pool, SEGMENT_JOB_TYPE, payload, ctx.ownerId, base);
    for (let n = 1; !out.created && !reusable(out.job) && n <= 20; n++) out = await enqueue(deps.pool, SEGMENT_JOB_TYPE, payload, ctx.ownerId, `${base}:r${n}`);
    return { jobId: out.job.id, budgetGate: "checked" as const, manualFallbackAvailable: true as const };
  };

  return {
    calculate_scenarios: calculateScenarios,
    calculate_water_balance: calculateWaterBalance,
    request_segmentation: requestSegmentation,
  };
}

/** Everything the assistant can call today: the T09 tools plus the bindings above. */
export function allBindings(deps: BindingDeps): ToolBindings {
  const extra: ToolBindings = {};
  if (deps.int2) {
    const d = { pool: deps.pool, budget: deps.budget, ...deps.int2 };
    extra.screen_crops = bindScreenCrops(d);
    extra.get_market_outlook = bindMarketOutlook(d);
    extra.request_visual_keyframes = bindVisualKeyframes(d);
  }
  if (deps.journal) Object.assign(extra, journalToolBindings({ pool: deps.pool, service: deps.journal, plans: deps.plans }));
  return { ...implementedBindings(), ...createToolBindings(deps), ...extra };
}

export { implementedBindings };
