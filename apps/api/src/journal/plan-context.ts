import type { PoolClient } from "pg";
import type { Pool } from "../db/pool";
import type { ChangeSummary, PlanService, PlanView } from "../plans";
import type { PlanChange } from "../plans/types";

type Db = Pool | PoolClient;

/** The newest plan in the lineage that starts at `planId` (history is linear: one child per parent). */
export async function leafPlanId(db: Db, ownerId: string, planId: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_plan_id FROM plans WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT p.id, p.parent_plan_id FROM plans p JOIN chain c ON p.parent_plan_id = c.id WHERE p.owner_id = $2
     )
     SELECT id FROM chain c WHERE NOT EXISTS (SELECT 1 FROM plans k WHERE k.parent_plan_id = c.id) LIMIT 1`,
    [planId, ownerId],
  );
  return r.rows[0]?.id ?? null;
}

/** The newest plan of a farm in the server mode, or null. */
export async function latestFarmPlan(db: Db, ownerId: string, farmId: string, mode: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `SELECT p.id FROM plans p
     WHERE p.owner_id = $1 AND p.farm_id = $2 AND p.mode = $3
       AND NOT EXISTS (SELECT 1 FROM archived_plans a WHERE a.plan_id = p.id AND a.owner_id = $1)
       AND NOT EXISTS (SELECT 1 FROM plans k WHERE k.parent_plan_id = p.id
         AND NOT EXISTS (SELECT 1 FROM archived_plans a WHERE a.plan_id = k.id AND a.owner_id = $1))
     ORDER BY p.created_at DESC, p.id LIMIT 1`,
    [ownerId, farmId, mode],
  );
  return r.rows[0]?.id ?? null;
}

export interface PlanStages {
  stages: { stageId: string; name: string }[];
  cropId: string;
  contentHash: string;
}

export function stagesOf(view: PlanView): PlanStages {
  const inputs = view.outputs.find((o) => o.kind === "inputs")?.output as { stageDefinitions?: { stageId: string; name: string }[] } | undefined;
  return {
    stages: (inputs?.stageDefinitions ?? []).map((s) => ({ stageId: s.stageId, name: s.name })),
    cropId: view.snapshot.cropId,
    contentHash: view.snapshot.contentHash,
  };
}

export const changeSummaryOf = (view: PlanView): ChangeSummary | null => (view.outputs.find((o) => o.kind === "change_summary")?.output as ChangeSummary | undefined) ?? null;

class DryRunDone extends Error {
  constructor(readonly summary: ChangeSummary | null) {
    super("dry run complete");
  }
}

/**
 * Runs the real T08 revision computation and rolls it back, so the farmer sees the engine's own changed tasks and
 * economic delta before confirming. Nothing is persisted: the engine's transaction is turned into a rollback at COMMIT,
 * after the new plan and its change_summary were written inside it. Relies on PlanService opening its write through
 * `withTransaction(pool)`; if that changes, the preview reports `unavailable` instead of committing (a wrapper that
 * never reaches COMMIT cannot persist).
 */
export async function dryRunRevision(
  plans: PlanService,
  pool: Pool,
  args: { ownerId: string; planId: string; expectedParentContentHash: string; changes: PlanChange[] },
): Promise<{ status: "ok"; summary: ChangeSummary | null; deduplicated: boolean } | { status: "unavailable"; reason: string }> {
  const dryPool = {
    query: (...a: unknown[]) => (pool.query as (...x: unknown[]) => unknown)(...a),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return async (text: unknown, ...rest: unknown[]) => {
              if (typeof text === "string" && text.trim().toUpperCase() === "COMMIT") {
                const r = await target.query<{ output: ChangeSummary }>(
                  `SELECT o.output FROM plans p JOIN plan_outputs o ON o.plan_id = p.id AND o.kind = 'change_summary'
                   WHERE p.parent_plan_id = $1 AND p.owner_id = $2 LIMIT 1`,
                  [args.planId, args.ownerId],
                );
                await target.query("ROLLBACK");
                throw new DryRunDone(r.rows[0]?.output ?? null);
              }
              return (target.query as (...x: unknown[]) => unknown)(text, ...rest);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  } as unknown as Pool;
  const dry = Object.create(plans, { pool: { value: dryPool } }) as PlanService;
  try {
    const view = await dry.revisePlan(args);
    // Identical revision already exists (deduplicated): its stored summary is the preview.
    return { status: "ok", summary: changeSummaryOf(view), deduplicated: true };
  } catch (e) {
    if (e instanceof DryRunDone) return { status: "ok", summary: e.summary, deduplicated: false };
    throw e;
  }
}
