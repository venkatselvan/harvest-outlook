import type { ToolInput, ToolOutput, ValueRecord } from "@harvest/contracts";
import { IrrigationCategory, IsoDate } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import type { PlanService } from "../plans";
import { PlanChange } from "../plans/types";
import type { ToolBindings, ToolHandler } from "../agent/tools/registry";
import { notFound } from "../services/errors";
import { getMedia } from "../services/media";
import { recomputeFor, type RecomputeKind } from "./mapping";
import { leafPlanId, stagesOf } from "./plan-context";
import * as repo from "./repository";
import { PROMPT_LABEL } from "./prompt";
import type { JournalService } from "./service";

export interface JournalBindingDeps {
  pool: Pool;
  service: JournalService;
  plans: PlanService;
}

type Out<N extends "interpret_observation" | "propose_plan_revision"> = ToolOutput<N>;

const farmScope = (farmId: string) => ({ level: "farm" as const, ids: [farmId] });

function proposalValue(farmId: string, value: unknown, unit: string | null): ValueRecord {
  const common = {
    schemaVersion: "1.0" as const,
    // A model proposal is derived from the photo and note; it is not an observation and not yet farmer-reported.
    evidenceState: "derived" as const,
    scope: farmScope(farmId),
    validFrom: null,
    validTo: null,
    issuedAt: null,
    evidenceIds: [],
    assumptionIds: [],
    methodVersion: PROMPT_LABEL,
    validationStatus: "pending" as const,
    missingReason: null,
  };
  const UNITS = ["ha", "acre", "kg", "quintal", "t", "mm", "L", "m3", "days", "g", "m", "cm", "percent"];
  if (typeof value === "number" && unit && UNITS.includes(unit)) return { ...common, kind: "quantity", value, unit } as ValueRecord;
  return { ...common, kind: "category", value: String(value), unit: null } as ValueRecord;
}

/**
 * `interpret_observation`: reads the stored analysis of the farmer's saved observation or queues one. It never runs the
 * vision call inside the assistant loop; while the job runs the tool abstains with the job id so the model can use get_job_status.
 */
export function bindInterpretObservation(deps: JournalBindingDeps): ToolHandler<"interpret_observation"> {
  return async (input: ToolInput<"interpret_observation">, ctx): Promise<Out<"interpret_observation">> => {
    const farm = await deps.pool.query("SELECT 1 FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [input.farmId, ctx.ownerId]);
    if (!farm.rowCount) throw notFound("Farm");
    for (const id of input.mediaIds) if (!(await getMedia(deps.pool, ctx.ownerId, id))) throw notFound("Media");
    const found = await deps.pool.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE owner_id=$1 AND farm_id=$2 AND media_ids @> $3::uuid[] ORDER BY created_at DESC LIMIT 1`,
      [ctx.ownerId, input.farmId, input.mediaIds],
    );
    const entryId = found.rows[0]?.id;
    const abstain = (reason: string): Out<"interpret_observation"> => ({ proposals: [], abstained: true, abstainReason: reason });
    if (!entryId) return abstain("no_saved_observation: the farmer has not saved these photos in the Journal yet");
    const entry = await deps.service.getEntry(ctx.ownerId, entryId);
    const a = entry.analysis;
    if (a?.status === "succeeded") {
      const proposals = entry.facts
        .filter((f) => f.kind === "proposed" && f.source === "ai" && f.analysisId === a.id)
        .map((f) => ({
          field: f.field,
          proposed: proposalValue(input.farmId, f.value, f.unit),
          uncertainty: { kind: "model_self_report" as const, value: null, note: "Meta gives no calibrated confidence. This is an unevaluated AI proposal that needs the farmer's confirmation." },
          requiresConfirmation: true as const,
        }));
      return { proposals, abstained: a.requestAnotherAngle, abstainReason: a.requestAnotherAngle ? "another_angle_needed: the photo was not clear enough to propose anything" : null };
    }
    if (a?.status === "queued" || a?.status === "running") return abstain(`analysis_in_progress: job ${a.jobId}`);
    const q = await deps.service.requestAnalysis(ctx.ownerId, entryId);
    return abstain(`analysis_queued: job ${q.jobId}`);
  };
}

const KEYS = ["planting_date", "irrigation_category", "observed_stage", "area"] as const;

/**
 * `propose_plan_revision`: validates typed changes against the plan and reports what they would recompute. It never
 * commits: only the farmer's confirmation through the journal route can create a revision.
 */
export function bindProposePlanRevision(deps: JournalBindingDeps): ToolHandler<"propose_plan_revision"> {
  return async (input: ToolInput<"propose_plan_revision">, ctx): Promise<Out<"propose_plan_revision">> => {
    const leaf = (await leafPlanId(deps.pool, ctx.ownerId, input.planId).catch(() => null)) ?? null;
    if (!leaf) throw notFound("Plan");
    const view = await deps.plans.getPlan(ctx.ownerId, leaf);
    const { stages } = stagesOf(view);
    const stageIds = new Set(stages.map((s) => s.stageId));
    const errors: string[] = [];
    if (leaf !== input.planId) errors.push("plan_not_latest: a newer plan version exists; propose against the latest version");
    if (view.snapshot.contentHash !== input.expectedContentHash) errors.push("plan_hash_mismatch: the plan changed since the hash was read");
    const diff: Out<"propose_plan_revision">["diff"] = [];
    const typed: PlanChange[] = [];
    const current = new Map((view.snapshot.confirmedInputs as { key: string; value: ValueRecord }[]).map((i) => [i.key, i.value]));
    for (const ch of input.changes) {
      const to = ch.to;
      const val = to.value;
      let typedChange: PlanChange | null = null;
      if (!(KEYS as readonly string[]).includes(ch.key)) {
        errors.push(`unsupported_key:${ch.key}`);
        continue;
      }
      if (ch.key === "planting_date") {
        const d = IsoDate.safeParse(val);
        if (d.success) typedChange = { type: "planting_date", date: d.data };
      } else if (ch.key === "irrigation_category") {
        const c = IrrigationCategory.safeParse(val);
        if (c.success) typedChange = { type: "irrigation_category", category: c.data };
      } else if (ch.key === "observed_stage") {
        if (typeof val === "string" && stageIds.has(val) && to.validFrom) typedChange = { type: "observed_stage", stageId: val, observedOn: to.validFrom, journalEntryId: null, basis: "farmer_reported" };
        else errors.push("observed_stage needs a stage id of this plan and validFrom set to the observation date");
      } else if (ch.key === "area") {
        if (typeof val === "number" && (to.unit === "ha" || to.unit === "acre") && val > 0) typedChange = { type: "area", amount: val, unit: to.unit };
      }
      const checked = typedChange ? PlanChange.safeParse(typedChange) : null;
      if (!checked?.success) {
        if (!errors.some((e) => e.startsWith(ch.key) || e.startsWith("observed_stage"))) errors.push(`invalid_value:${ch.key}`);
        continue;
      }
      typed.push(checked.data);
      diff.push({ key: ch.key, from: current.get(ch.key) ?? null, to });
    }
    const recompute: RecomputeKind[] = [...new Set(typed.flatMap(recomputeFor))];
    return { diff, recomputeRequired: recompute, requiresUserConfirmation: true as const, validationErrors: errors };
  };
}

export function journalToolBindings(deps: JournalBindingDeps): ToolBindings {
  return { interpret_observation: bindInterpretObservation(deps), propose_plan_revision: bindProposePlanRevision(deps) };
}
