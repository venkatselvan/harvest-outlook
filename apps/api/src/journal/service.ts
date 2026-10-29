import { addDays } from "@harvest/domain";
import type { Mode } from "@harvest/contracts";
import { withTransaction, type Pool } from "../db/pool";
import { PlanService, regionDate, type ChangeSummary, type PlanView } from "../plans";
import type { PlanChange } from "../plans/types";
import { ApiError, notFound } from "../services/errors";
import { payloadHash } from "../services/hash";
import { enqueue } from "../services/jobs";
import { getMedia } from "../services/media";
import { factToPlanChange, recomputeFor } from "./mapping";
import { changeSummaryOf, dryRunRevision, latestFarmPlan, leafPlanId, stagesOf, type PlanStages } from "./plan-context";
import * as repo from "./repository";
import { JOURNAL_JOB_TYPE, PLAN_FIELDS, type ConfirmBody, type CreateEntryBody, type TaskCompletionBody } from "./types";

export interface JournalServiceOptions {
  pool: Pool;
  /** Server-derived runtime mode (config.RUNTIME_MODE). */
  mode: Mode;
  plans: PlanService;
  clock?: () => Date;
}

const PLAN_FIELD_SET: ReadonlySet<string> = new Set(PLAN_FIELDS);
const validationFailed = (message: string, details?: unknown) => new ApiError(422, "validation_failed", message, details);
const versionConflict = (message: string, details?: unknown) => new ApiError(409, "version_conflict", message, details);

export interface RevisionOut {
  id: string;
  entryId: string;
  fromPlanId: string;
  toPlanId: string;
  factIds: string[];
  changes: PlanChange[];
  changeSummary: ChangeSummary | null;
  createdAt: string;
}

export interface ConfirmResult {
  entry: repo.EntryOut;
  revision: (RevisionOut & { newContentHash: string; snapshot: PlanView["snapshot"] }) | null;
}

export class JournalService {
  readonly pool: Pool;
  readonly mode: Mode;
  readonly plans: PlanService;
  private readonly clock: () => Date;

  constructor(o: JournalServiceOptions) {
    this.pool = o.pool;
    this.mode = o.mode;
    this.plans = o.plans;
    this.clock = o.clock ?? (() => new Date());
  }

  private today(): string {
    return regionDate(this.clock());
  }

  private async ownedFarm(ownerId: string, farmId: string): Promise<void> {
    const r = await this.pool.query("SELECT 1 FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [farmId, ownerId]);
    if (!r.rowCount) throw notFound("Farm");
  }

  private async planStages(ownerId: string, planId: string): Promise<PlanStages & { view: PlanView }> {
    const view = await this.plans.getPlan(ownerId, planId);
    return { ...stagesOf(view), view };
  }

  // ---------------------------------------------------------------- create

  async createEntry(ownerId: string, body: CreateEntryBody): Promise<{ entry: repo.EntryOut; created: boolean }> {
    await this.ownedFarm(ownerId, body.farmId);
    if (body.observedOn > addDays(this.today(), 1)) throw validationFailed("observedOn cannot be in the future");
    const hash = payloadHash({ ...body, version: undefined });

    const existing = await repo.findEntryByClientId(this.pool, ownerId, body.clientEntryId);
    if (existing) return { entry: await this.replay(ownerId, existing, hash, body), created: false };

    let planId: string | null = null;
    if (body.planId) {
      const own = await this.pool.query<{ farm_id: string }>("SELECT farm_id FROM plans WHERE id=$1 AND owner_id=$2", [body.planId, ownerId]);
      if (!own.rows[0] || own.rows[0].farm_id !== body.farmId) throw notFound("Plan");
      planId = body.planId;
    } else {
      planId = await latestFarmPlan(this.pool, ownerId, body.farmId, this.mode);
    }
    for (const id of body.mediaIds) {
      const m = await getMedia(this.pool, ownerId, id);
      if (!m || (m.farmId !== null && m.farmId !== body.farmId)) throw notFound("Media");
    }
    if (new Set(body.mediaIds).size !== body.mediaIds.length) throw validationFailed("mediaIds contains duplicates");
    if (body.stageId) {
      if (!planId) throw validationFailed("a stage can only be selected when the farm has a plan");
      const { stages } = await this.planStages(ownerId, planId);
      if (!stages.some((s) => s.stageId === body.stageId)) throw new ApiError(422, "unknown_stage", `stage '${body.stageId}' is not part of the plan`);
    }

    const now = this.clock();
    const id = await withTransaction(this.pool, async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO journal_entries (owner_id, farm_id, plan_id, client_entry_id, status, entry_date, observed_at, uploaded_at, text_body, language, media_ids,
           activity, quantity, quantity_unit, expense_inr, expense_category, mode, payload_hash, processing_status)
         VALUES ($1,$2,$3,$4,'final',$5,$6,$7,$8,$9,$10::uuid[],$11,$12,$13,$14,$15,$16,$17,'submitted')
         ON CONFLICT (owner_id, client_entry_id) DO NOTHING RETURNING id`,
        [
          ownerId,
          body.farmId,
          planId,
          body.clientEntryId,
          body.observedOn,
          `${body.observedOn}T12:00:00+05:30`,
          body.mediaIds.length ? now.toISOString() : null,
          body.note ?? null,
          body.language ?? null,
          body.mediaIds,
          body.activity ?? null,
          body.quantity?.value ?? null,
          body.quantity?.unit ?? null,
          body.expense?.amountInr ?? null,
          body.expense?.category ?? null,
          this.mode,
          hash,
        ],
      );
      const entryId = ins.rows[0]?.id;
      if (!entryId) return null;
      const farmer = { ownerId, entryId, source: "farmer" as const, evidenceState: "farmer_reported" as const };
      if (body.activity) await repo.insertFact(c, { ...farmer, field: "activity", value: body.activity, unit: null, kind: "original", requiresConfirmation: false });
      if (body.quantity) await repo.insertFact(c, { ...farmer, field: "quantity", value: body.quantity.value, unit: body.quantity.unit, kind: "original", requiresConfirmation: false });
      if (body.expense) await repo.insertFact(c, { ...farmer, field: "expense_inr", value: body.expense.amountInr, unit: "INR", kind: "original", requiresConfirmation: false });
      if (body.stageId) {
        await repo.insertFact(c, { ...farmer, field: "observed_stage", value: body.stageId, unit: null, kind: "original", requiresConfirmation: false });
        // The farmer's selection can change the plan only after an explicit confirmation, like any other plan-changing fact.
        await repo.insertFact(c, { ...farmer, field: "observed_stage", value: body.stageId, unit: null, kind: "proposed", requiresConfirmation: true });
      }
      return entryId;
    });
    if (id === null) {
      const raced = await repo.findEntryByClientId(this.pool, ownerId, body.clientEntryId);
      return { entry: await this.replay(ownerId, raced!, hash, body), created: false };
    }
    return { entry: await this.getEntry(ownerId, id), created: true };
  }

  private async replay(ownerId: string, existing: repo.EntryRow, hash: string, body: CreateEntryBody): Promise<repo.EntryOut> {
    if (existing.payload_hash !== hash) {
      throw versionConflict("this entry id already exists with different content; originals are never overwritten", { currentVersion: existing.version, clientVersion: body.version });
    }
    return this.getEntry(ownerId, existing.id);
  }

  // ---------------------------------------------------------------- read

  async getEntry(ownerId: string, id: string): Promise<repo.EntryOut> {
    const row = await repo.findEntry(this.pool, ownerId, id);
    if (!row) throw notFound("Journal entry");
    const [facts, analyses] = await Promise.all([repo.factsForEntries(this.pool, ownerId, [id]), repo.latestAnalyses(this.pool, ownerId, [id])]);
    return repo.entryOut(row, facts, analyses.get(id), PLAN_FIELD_SET);
  }

  async timeline(ownerId: string, farmId: string) {
    await this.ownedFarm(ownerId, farmId);
    const entries = await repo.listEntries(this.pool, ownerId, farmId);
    const ids = entries.map((e) => e.id);
    const [facts, analyses] = await Promise.all([repo.factsForEntries(this.pool, ownerId, ids), repo.latestAnalyses(this.pool, ownerId, ids)]);
    const completions = await this.pool.query<{ task_id: string; completed_on: string; entry_id: string; plan_id: string }>(
      `SELECT task_id, to_char(completed_on,'YYYY-MM-DD') AS completed_on, entry_id, plan_id FROM journal_task_completions WHERE owner_id=$1 AND farm_id=$2 ORDER BY completed_on DESC, task_id`,
      [ownerId, farmId],
    );
    const revs = await this.pool.query<{ id: string; entry_id: string; from_plan_id: string; to_plan_id: string; fact_ids: string[]; changes: PlanChange[]; change_summary: ChangeSummary | null; created_at: Date }>(
      `SELECT id, entry_id, from_plan_id, to_plan_id, fact_ids, changes, change_summary, created_at FROM journal_revisions WHERE owner_id=$1 AND farm_id=$2 ORDER BY created_at DESC, id`,
      [ownerId, farmId],
    );
    const planId = await latestFarmPlan(this.pool, ownerId, farmId, this.mode);
    let currentPlan: { id: string; contentHash: string; cropId: string; stages: { stageId: string; name: string }[] } | null = null;
    if (planId) {
      const s = await this.planStages(ownerId, planId);
      currentPlan = { id: planId, contentHash: s.contentHash, cropId: s.cropId, stages: s.stages };
    }
    return {
      farmId,
      currentPlan,
      entries: entries.map((e) => repo.entryOut(e, facts, analyses.get(e.id), PLAN_FIELD_SET)),
      completedTasks: completions.rows.map((c) => ({ taskId: c.task_id, completedOn: c.completed_on, entryId: c.entry_id, planId: c.plan_id })),
      revisions: revs.rows.map((r) => ({
        id: r.id,
        entryId: r.entry_id,
        fromPlanId: r.from_plan_id,
        toPlanId: r.to_plan_id,
        factIds: r.fact_ids,
        changes: r.changes,
        changeSummary: r.change_summary,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------- analysis

  /** Queues (or returns) the single live analysis of an entry. Never calls a provider. */
  async requestAnalysis(ownerId: string, entryId: string, sessionId: string | null = null) {
    const entry = await repo.findEntry(this.pool, ownerId, entryId);
    if (!entry) throw notFound("Journal entry");
    if (entry.media_ids.length === 0) throw validationFailed("add a photo before asking for an analysis");
    return withTransaction(this.pool, async (c) => {
      await c.query("SELECT 1 FROM journal_entries WHERE id=$1 FOR UPDATE", [entryId]);
      const live = await c.query<{ id: string; job_id: string | null; status: string; job_state: string | null }>(
        `SELECT a.id, a.job_id, a.status, j.state AS job_state FROM journal_analyses a LEFT JOIN jobs j ON j.id = a.job_id
         WHERE a.entry_id=$1 AND a.status IN ('queued','running','succeeded')`,
        [entryId],
      );
      const cur = live.rows[0];
      if (cur) {
        const dead = (cur.status === "queued" || cur.status === "running") && (cur.job_state === "failed" || cur.job_state === "cancelled");
        if (!dead) return { analysisId: cur.id, jobId: cur.job_id, status: cur.status, deduplicated: true };
        await c.query("UPDATE journal_analyses SET status='failed', error_code='job_failed', updated_at=now() WHERE id=$1", [cur.id]);
      }
      const a = await c.query<{ id: string }>("INSERT INTO journal_analyses (owner_id, entry_id) VALUES ($1,$2) RETURNING id", [ownerId, entryId]);
      const analysisId = a.rows[0]!.id;
      const { job } = await enqueue(c, JOURNAL_JOB_TYPE, { analysisId, entryId, sessionId }, ownerId, `jan:${analysisId}`);
      await c.query("UPDATE journal_analyses SET job_id=$2 WHERE id=$1", [analysisId, job.id]);
      await c.query("UPDATE journal_entries SET processing_status='processing', updated_at=now() WHERE id=$1", [entryId]);
      return { analysisId, jobId: job.id, status: "queued", deduplicated: false };
    });
  }

  // ---------------------------------------------------------------- confirmation and revision

  private async resolvePlan(ownerId: string, entry: repo.EntryRow) {
    if (!entry.plan_id) return null;
    const leaf = await leafPlanId(this.pool, ownerId, entry.plan_id);
    if (!leaf) return null;
    return this.planStages(ownerId, leaf).then((s) => ({ planId: leaf, ...s }));
  }

  private mapFacts(entry: repo.EntryRow, facts: repo.FactRow[], stageIds: ReadonlySet<string> | null) {
    const changes: PlanChange[] = [];
    for (const f of facts) {
      const m = factToPlanChange({ field: f.fact_key, value: f.value }, { observedOn: entry.entry_date, entryId: entry.id, stageIds });
      if (!m.mapped) continue;
      if (!m.ok) throw new ApiError(422, m.code === "unknown_stage" ? "unknown_stage" : "validation_failed", m.message, { factId: f.id, field: f.fact_key });
      changes.push(m.change);
    }
    return changes;
  }

  /** The engine's own preview of the revision that confirming these facts would make. Nothing is saved. */
  async previewRevision(ownerId: string, entryId: string, factIds: string[]) {
    const entry = await repo.findEntry(this.pool, ownerId, entryId);
    if (!entry) throw notFound("Journal entry");
    const facts = await repo.factsByIds(this.pool, ownerId, entryId, factIds);
    if (facts.length !== new Set(factIds).size) throw notFound("Fact");
    if (facts.some((f) => f.kind !== "proposed" || f.status !== "proposed")) throw new ApiError(409, "conflict", "only undecided proposals can be previewed");
    const plan = await this.resolvePlan(ownerId, entry);
    const stageIds = plan ? new Set(plan.stages.map((s) => s.stageId)) : null;
    const changes = this.mapFacts(entry, facts, stageIds);
    if (changes.length === 0) return { planChanging: false as const, changes: [], recompute: [], planContentHash: plan?.contentHash ?? null, preview: null };
    if (!plan) throw validationFailed("this entry has no plan to revise");
    const recompute = [...new Set(changes.flatMap(recomputeFor))];
    const pv = await dryRunRevision(this.plans, this.pool, { ownerId, planId: plan.planId, expectedParentContentHash: plan.contentHash, changes });
    return {
      planChanging: true as const,
      changes,
      recompute,
      planContentHash: plan.contentHash,
      preview: pv.status === "ok" ? { changeSummary: pv.summary, note: "Computed by the plan engine and not saved." } : { changeSummary: null, note: `Preview unavailable: ${pv.reason}` },
    };
  }

  async confirm(ownerId: string, entryId: string, body: ConfirmBody): Promise<ConfirmResult> {
    if (!(await repo.findEntry(this.pool, ownerId, entryId))) throw notFound("Journal entry");
    return withTransaction(this.pool, async (c) => {
      const entry = await repo.findEntry(c, ownerId, entryId, true);
      if (!entry) throw notFound("Journal entry");
      if (entry.version !== body.expectedVersion) throw versionConflict("the entry changed since you loaded it; reload and review again", { currentVersion: entry.version, expectedVersion: body.expectedVersion });
      const ids = [...body.accept, ...body.reject];
      const facts = await repo.factsByIds(c, ownerId, entryId, ids, true);
      if (facts.length !== new Set(ids).size) throw notFound("Fact");
      const undecided = facts.filter((f) => f.kind === "proposed" && f.status === "proposed");
      if (undecided.length !== facts.length) throw new ApiError(409, "conflict", "a fact was already decided");
      const accepted = facts.filter((f) => body.accept.includes(f.id));
      const rejected = facts.filter((f) => body.reject.includes(f.id));

      // Typed plan changes from accepted facts. Routine facts (notes, expenses) never reach this branch.
      const plan = accepted.length ? await this.resolvePlan(ownerId, entry) : null;
      const stageIds = plan ? new Set(plan.stages.map((s) => s.stageId)) : null;
      const planFacts = accepted.filter((f) => PLAN_FIELD_SET.has(f.fact_key));
      const changes = this.mapFacts(entry, planFacts, stageIds);
      let view: PlanView | null = null;
      if (changes.length > 0) {
        if (!plan) throw validationFailed("this entry has no plan to revise");
        if (!body.expectedPlanContentHash) throw validationFailed("expectedPlanContentHash is required when a confirmed fact changes the plan");
        if (body.expectedPlanContentHash !== plan.contentHash) throw versionConflict("the plan changed since you loaded it; review the new version first", { currentContentHash: plan.contentHash });
        // Throws (and rolls this transaction back) if the engine refuses; nothing is confirmed then.
        view = await this.plans.revisePlan({ ownerId, planId: plan.planId, expectedParentContentHash: body.expectedPlanContentHash, changes });
      }

      const now = this.clock();
      for (const f of accepted) {
        await c.query("UPDATE journal_facts SET status='confirmed', confirmed_at=$2 WHERE id=$1", [f.id, now]);
        await repo.insertFact(c, {
          ownerId,
          entryId,
          field: f.fact_key,
          value: f.value as string | number,
          unit: f.unit,
          kind: "confirmed",
          source: f.source,
          evidenceState: "farmer_reported",
          requiresConfirmation: false,
          analysisId: f.analysis_id,
          agentRunId: f.agent_run_id,
          supersedesId: f.id,
          confirmedAt: now,
        });
      }
      for (const f of rejected) await c.query("UPDATE journal_facts SET status='rejected', rejected_at=$2 WHERE id=$1", [f.id, now]);
      await c.query("UPDATE journal_entries SET version = version + 1, updated_at = now() WHERE id=$1", [entryId]);

      let revision: ConfirmResult["revision"] = null;
      if (view && plan) {
        const summary = changeSummaryOf(view);
        const farm = entry.farm_id;
        const ins = await c.query<{ id: string; created_at: Date }>(
          `INSERT INTO journal_revisions (owner_id, farm_id, entry_id, from_plan_id, to_plan_id, fact_ids, changes, change_summary)
           VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::jsonb,$8::jsonb) RETURNING id, created_at`,
          [ownerId, farm, entryId, plan.planId, view.snapshot.id, planFacts.map((f) => f.id), JSON.stringify(changes), JSON.stringify(summary)],
        );
        revision = {
          id: ins.rows[0]!.id,
          entryId,
          fromPlanId: plan.planId,
          toPlanId: view.snapshot.id,
          factIds: planFacts.map((f) => f.id),
          changes,
          changeSummary: summary,
          createdAt: ins.rows[0]!.created_at.toISOString(),
          newContentHash: view.snapshot.contentHash,
          snapshot: view.snapshot,
        };
      }
      const [row, allFacts, analyses] = await Promise.all([repo.findEntry(c, ownerId, entryId), repo.factsForEntries(c, ownerId, [entryId]), repo.latestAnalyses(c, ownerId, [entryId])]);
      return { entry: repo.entryOut(row!, allFacts, analyses.get(entryId), PLAN_FIELD_SET), revision };
    });
  }

  // ---------------------------------------------------------------- task completion

  async completeTask(ownerId: string, entryId: string, body: TaskCompletionBody) {
    const entry = await repo.findEntry(this.pool, ownerId, entryId);
    if (!entry) throw notFound("Journal entry");
    if (!entry.plan_id) throw validationFailed("this entry has no plan, so it has no tasks");
    if (body.completedOn > addDays(this.today(), 1)) throw validationFailed("completedOn cannot be in the future");
    const leaf = await leafPlanId(this.pool, ownerId, entry.plan_id);
    const view = await this.plans.getPlan(ownerId, leaf ?? entry.plan_id);
    const tasks = (view.outputs.find((o) => o.kind === "tasks")?.output as { tasks?: { task: { id: string } }[] } | undefined)?.tasks ?? [];
    if (!tasks.some((t) => t.task.id === body.taskId)) throw validationFailed(`task '${body.taskId}' is not part of the plan`);
    await this.pool.query(
      `INSERT INTO journal_task_completions (owner_id, farm_id, entry_id, plan_id, task_id, completed_on) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id, farm_id, task_id) DO UPDATE SET completed_on = EXCLUDED.completed_on, entry_id = EXCLUDED.entry_id, plan_id = EXCLUDED.plan_id`,
      [ownerId, entry.farm_id, entryId, view.snapshot.id, body.taskId, body.completedOn],
    );
    return { taskId: body.taskId, completedOn: body.completedOn, entryId, planId: view.snapshot.id };
  }
}
