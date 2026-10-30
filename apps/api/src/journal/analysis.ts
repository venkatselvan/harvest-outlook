import { z } from "zod";
import { agentEnvFromConfig, type Config } from "../config";
import { withTransaction, type Pool } from "../db/pool";
import { AgentTrace } from "../agent/trace";
import { loadAgentLimits } from "../agent/limits";
import { FixtureProvider } from "../agent/fixture-provider";
import { selectProvider, type TextModelProvider, type TextResult } from "../agent/provider";
import { imageInputPart } from "../providers/meta/client";
import { restoreOptionals } from "../providers/meta/strict-schema";
import type { InputItem } from "../providers/meta/types";
import type { PlanService } from "../plans";
import type { Budget } from "../services/budget";
import { ApiError } from "../services/errors";
import { sha256Hex } from "../services/hash";
import { getMedia, readContent } from "../services/media";
import type { StorageAdapter } from "../storage/types";
import { claimDispatch, finishDispatch, unresolvedDispatches } from "../visuals/dispatch";
import { gateInterpretation, type GatedInterpretation } from "./gate";
import { leafPlanId, stagesOf } from "./plan-context";
import { buildUserText, INSTRUCTIONS, PROMPT_HASH, PROMPT_LABEL, rawSchema, strictSchema, type PromptContext } from "./prompt";
import { assessImage, summariseQuality, type ImageQuality } from "./quality";
import * as repo from "./repository";
import { InterpretationOutput, JOURNAL_JOB_TYPE, PROMPT_NAME, PROMPT_VERSION } from "./types";

export const DEFAULT_FIXTURE_SCENARIO = "journal_waterlogging";
const DISPATCH_STAGE = "interpretation";
const MAX_OUTPUT_TOKENS = 1500;
/**
 * Same effort as the assistant loop (AGENT_REASONING_EFFORT, default "low"). Without it the server reasons at
 * "high" and hidden reasoning tokens share MAX_OUTPUT_TOKENS (verified live 2026-10-30; see META_API_NOTES.md),
 * which can end the call `incomplete` with no observation. A 64 px image used ~150 reasoning tokens at "low".
 */
const journalReasoningEffort = (config: Config) => loadAgentLimits(agentEnvFromConfig(config)).reasoningEffort;
/** Conservative per-photo input estimate for the budget reservation (photos are at most 1280 px on the long side). */
const TOKENS_PER_IMAGE_ESTIMATE = 1600;

export interface JournalWorkerDeps {
  pool: Pool;
  config: Config;
  storage: StorageAdapter;
  budget: Budget;
  plans: PlanService;
  /** Tests inject a provider; production selects Meta (live) or the fixture (synthetic) from the server mode. */
  provider?: TextModelProvider;
  /** Synthetic mode only. Defaults to JOURNAL_FIXTURE_SCENARIO or journal_waterlogging. */
  fixtureScenario?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export const payloadSchema = z.object({ analysisId: z.uuid(), entryId: z.uuid(), sessionId: z.uuid().nullable().optional() });

type Handlers = Record<string, (job: { id: string; owner_id: string | null; payload: unknown; attempt?: number; max_attempts?: number }, ctx: { heartbeat: (p?: number) => Promise<void> }) => Promise<unknown>>;

/** Wire in the worker: `registerJournalHandlers(handlers, { pool, config, storage, budget, plans })`. */
export function registerJournalHandlers(registry: Handlers, deps: JournalWorkerDeps): void {
  registry[JOURNAL_JOB_TYPE] = (job, ctx) => runJournalAnalysis(deps, job, ctx);
}

export interface AnalysisJobResult {
  analysisId: string;
  status: "succeeded";
  provenance: "meta_live" | "synthetic_fixture";
  proposalCount: number;
  requestAnotherAngle: boolean;
}

class AnalysisFailure extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: string,
    readonly terminal: "failed" | "unavailable",
    retryable = false,
  ) {
    super(code);
    this.retryable = retryable;
  }
}

function providerFor(deps: JournalWorkerDeps): TextModelProvider {
  if (deps.provider) return deps.provider;
  const scenario = deps.fixtureScenario ?? process.env.JOURNAL_FIXTURE_SCENARIO ?? DEFAULT_FIXTURE_SCENARIO;
  return selectProvider({
    mode: deps.config.RUNTIME_MODE,
    apiKey: deps.config.MODEL_API_KEY,
    baseUrl: deps.config.META_BASE_URL,
    fixture: () => new FixtureProvider(scenario),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

export async function runJournalAnalysis(
  deps: JournalWorkerDeps,
  job: { id: string; owner_id: string | null; payload: unknown; attempt?: number; max_attempts?: number },
  ctx: { heartbeat: (progress?: number) => Promise<void> },
): Promise<AnalysisJobResult> {
  const { pool, config } = deps;
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.owner_id) throw Object.assign(new Error("invalid journal.analysis payload"), { retryable: false });
  const ownerId = job.owner_id;
  const { analysisId, entryId, sessionId } = parsed.data;
  const analysis = await repo.findAnalysis(pool, ownerId, analysisId);
  const entry = await repo.findEntry(pool, ownerId, entryId);
  if (!analysis || !entry || analysis.entry_id !== entryId) throw Object.assign(new Error("analysis or entry not found for owner"), { retryable: false });
  if (analysis.status === "succeeded") {
    return { analysisId, status: "succeeded", provenance: analysis.provenance ?? "synthetic_fixture", proposalCount: 0, requestAnotherAngle: false };
  }
  await pool.query("UPDATE journal_analyses SET status='running', error_code=NULL, updated_at=now() WHERE id=$1", [analysisId]);

  const fail = async (f: AnalysisFailure): Promise<never> => {
    // A retryable failure leaves the analysis queued so the worker's next attempt can run; terminal ones are visible to the farmer.
    const willRetry = f.retryable && (job.attempt ?? 1) < (job.max_attempts ?? 1);
    await pool.query("UPDATE journal_analyses SET status=$2, error_code=$3, updated_at=now() WHERE id=$1", [analysisId, willRetry ? "queued" : f.terminal, f.code]);
    if (!willRetry) await pool.query("UPDATE journal_entries SET processing_status='failed', updated_at=now() WHERE id=$1", [entryId]);
    throw Object.assign(new Error(f.code), { retryable: willRetry, code: f.code });
  };

  try {
    return await analyse();
  } catch (e) {
    if (e instanceof AnalysisFailure) return fail(e);
    await pool.query("UPDATE journal_analyses SET status='failed', error_code='internal_error', updated_at=now() WHERE id=$1", [analysisId]).catch(() => undefined);
    await pool.query("UPDATE journal_entries SET processing_status='failed', updated_at=now() WHERE id=$1", [entryId]).catch(() => undefined);
    throw Object.assign(new Error("journal analysis failed"), { retryable: false });
  }

  async function analyse(): Promise<AnalysisJobResult> {
    // An open or uncertain marker from an earlier attempt means a paid call may have been sent and its result lost
    // (crash, lease expiry). Never dispatch again and never reserve again: hold the old reservation as uncertain, leave
    // the entry as the farmer reported it, and fail without retry.
    const open = await unresolvedDispatches(pool, job.id);
    if (open.length) {
      for (const d of open) {
        if (d.reservation_id) await deps.budget.markUncertain(d.reservation_id).catch(() => undefined);
        await finishDispatch(pool, job.id, d.stage_key, "uncertain");
      }
      throw new AnalysisFailure("provider_outcome_uncertain", "failed", false);
    }
    // Photos: owned originals' normalised derivatives. Quality is computed in code first and attached whatever the model says.
    const photos: { mediaId: string; data: Uint8Array; sha256: string }[] = [];
    for (const id of entry!.media_ids) {
      const m = await getMedia(pool, ownerId, id);
      if (!m) throw new AnalysisFailure("media_not_found", "failed");
      const c = await readContent(pool, deps.storage, ownerId, id, "normalized");
      photos.push({ mediaId: id, data: c.data, sha256: m.sha256 });
    }
    const perImage: ImageQuality[] = [];
    for (const p of photos) perImage.push(await assessImage(p.mediaId, p.data));
    const quality = summariseQuality(perImage);
    await pool.query("UPDATE journal_entries SET image_quality=$2::jsonb WHERE id=$1", [entryId, JSON.stringify(quality)]);
    await pool.query("UPDATE journal_analyses SET quality=$2::jsonb WHERE id=$1", [analysisId, JSON.stringify(quality)]);
    await ctx.heartbeat(0.2);

    if (config.RUNTIME_MODE === "replay") throw new AnalysisFailure("capability_unavailable", "unavailable");
    const provider = providerFor(deps);

    const pc = await promptContext(deps, ownerId, entry!, photos.length);
    const userText = buildUserText(pc);
    const model = config.META_TEXT_MODEL;
    const images = await Promise.all(photos.map((p) => imageInputPart(p.data, 1280)));
    const input: InputItem[] = [{ role: "user", content: [{ type: "input_text", text: userText }, ...images] }];
    const stageIds = pc.stages.length ? new Set(pc.stages.map((s) => s.stageId)) : null;

    const runId = (
      await pool.query<{ id: string }>(
        `INSERT INTO agent_runs (owner_id, session_id, mode, purpose, provider, model, prompt_version, request_id, status, input_hash, provenance)
         VALUES ($1,$2,$3,'journal_observation',$4,$5,$6,$7,'running',$8,$9) RETURNING id`,
        [ownerId, sessionId ?? null, config.RUNTIME_MODE, provider.kind === "fixture" ? "fixture" : "meta", model, PROMPT_LABEL, job.id, sha256Hex(JSON.stringify({ note: entry!.text_body, media: photos.map((p) => p.sha256), observedOn: entry!.entry_date })), provider.provenance],
      )
    ).rows[0]!.id;
    await pool.query("INSERT INTO prompt_versions (name, version, content_sha256) VALUES ($1,$2,$3) ON CONFLICT (name, version) DO NOTHING", [PROMPT_NAME, PROMPT_VERSION, PROMPT_HASH]);
    const trace = new AgentTrace(runId);
    // Redaction keeps notes to 200 characters and never records image bytes; only counts and hashes of photos are traced.
    trace.add("run_started", { provider: provider.provenance, detail: { purpose: "journal_observation", note: entry!.text_body, photoCount: photos.length, photoSha256: photos.map((p) => p.sha256), qualityIssues: quality.issues, hasPlan: pc.stages.length > 0 } });
    const finishRun = async (status: "succeeded" | "failed", extra: { usage?: unknown; estimated?: number; settled?: number; gateStatus?: string | null; error?: string; output?: unknown }) => {
      trace.add("run_finished", { detail: { status, gateStatus: extra.gateStatus ?? null, error: extra.error } });
      await pool
        .query(
          `UPDATE agent_runs SET status=$2, provider_calls=$3, usage=$4::jsonb, estimated_usd=$5, settled_usd=$6, gate_status=$7, trace=$8::jsonb, output=$9::jsonb, error=$10::jsonb, finished_at=now() WHERE id=$1`,
          [runId, status, provider.billable || provider.kind === "fixture" ? 1 : 0, JSON.stringify(extra.usage ?? {}), extra.estimated ?? 0, extra.settled ?? 0, extra.gateStatus ?? null, JSON.stringify(trace.toJSON()), extra.output ? JSON.stringify(extra.output) : null, extra.error ? JSON.stringify({ code: extra.error }) : null],
        )
        .catch(() => undefined);
    };

    // Budget: reserve the worst case before a billable call; fixtures are free.
    let reservationId: string | null = null;
    let estimate = 0;
    if (provider.billable) {
      estimate = deps.budget.estimate("meta", model, { inputTokens: Math.ceil((INSTRUCTIONS.length + userText.length) / 2) + photos.length * TOKENS_PER_IMAGE_ESTIMATE, outputTokens: MAX_OUTPUT_TOKENS }).usd ?? 0;
      try {
        ({ reservationId } = await deps.budget.reserve({ ownerId, sessionId: sessionId ?? null, provider: "meta", model, estimate, jobId: job.id, requestId: job.id }));
        trace.add("budget", { model, detail: { action: "reserved", estimateUsd: estimate } });
      } catch (e) {
        await finishRun("failed", { error: "budget_exceeded" });
        if (e instanceof ApiError && e.code === "budget_exceeded") throw new AnalysisFailure("budget_exceeded", "unavailable");
        throw e;
      }
    }

    // Committed marker BEFORE the paid call (own statement); a lost outcome is then visible to any re-claim of this job.
    if (reservationId && !(await claimDispatch(pool, job.id, DISPATCH_STAGE, reservationId))) {
      await deps.budget.markUncertain(reservationId).catch(() => undefined);
      await finishRun("failed", { error: "provider_outcome_uncertain", estimated: estimate });
      throw new AnalysisFailure("provider_outcome_uncertain", "failed", false);
    }
    const outcome = await provider.call({ pass: "interpretation", model, instructions: INSTRUCTIONS, input, textFormat: { name: "journal_observation", schema: strictSchema() }, maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningEffort: journalReasoningEffort(deps.config), store: false }); // L5: single unchained call, nothing kept by the provider
    await ctx.heartbeat(0.7);
    if (!outcome.ok) {
      const err = outcome.error;
      if (reservationId) {
        if (err.outcomeUncertain) await deps.budget.markUncertain(reservationId).catch(() => undefined);
        else await deps.budget.release(reservationId).catch(() => undefined);
      }
      if (reservationId) await finishDispatch(pool, job.id, DISPATCH_STAGE, err.outcomeUncertain ? "uncertain" : "failed", err.requestId).catch(() => undefined);
      trace.add("provider_error", { provider: provider.provenance, model, detail: { code: err.code, retryable: err.retryable } });
      await finishRun("failed", { error: err.code, estimated: estimate });
      if (err.code === "provider_unavailable") throw new AnalysisFailure("provider_unavailable", "unavailable");
      // Never auto-retry when the provider may already have billed the call.
      throw new AnalysisFailure(err.code, "failed", err.retryable && !err.outcomeUncertain);
    }
    const r: TextResult = outcome.result;
    trace.add("provider_call", { pass: "interpretation", provider: r.provenance, model: r.model, requestId: r.requestId, responseId: r.responseId, usage: r.usage, latencyMs: r.latencyMs, retries: r.retries });
    let settled = 0;
    if (reservationId) {
      const unknownUsage = r.usage.inputTokens === 0 && r.usage.outputTokens === 0;
      settled = unknownUsage ? estimate : (deps.budget.estimate("meta", model, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }).usd ?? 0);
      await deps.budget.settle(reservationId, settled, r.requestId, { images: photos.length, ...r.usage }, "estimated");
      trace.add("budget", { model, detail: { action: "settled", actualUsd: settled, basis: "estimated" } });
      // Only after settlement: if settling fails the marker stays open and a re-claim treats the outcome as uncertain.
      await finishDispatch(pool, job.id, DISPATCH_STAGE, "completed", r.requestId);
    }

    let output: InterpretationOutput;
    try {
      if (!r.outputText) throw new Error("empty");
      output = InterpretationOutput.parse(restoreOptionals(rawSchema(), JSON.parse(r.outputText)));
    } catch {
      await finishRun("failed", { error: "provider_bad_response", usage: r.usage, estimated: estimate, settled });
      throw new AnalysisFailure("provider_bad_response", "failed");
    }

    const gated: GatedInterpretation = gateInterpretation(output, { observedOn: entry!.entry_date, entryId, stageIds, asOf: (deps.clock ?? (() => new Date()))() });
    trace.add("gate", { detail: { facts: gated.facts.length, issues: gated.issues.map((i) => i.code), requestAnotherAngle: gated.requestAnotherAngle } });

    await withTransaction(pool, async (c) => {
      for (const f of gated.facts) {
        await repo.insertFact(c, { ownerId, entryId, field: f.field, value: f.value, unit: f.unit, kind: "proposed", source: "ai", evidenceState: "derived", requiresConfirmation: true, analysisId, agentRunId: runId });
      }
      const result = {
        visibleObservations: gated.visibleObservations,
        competingInterpretations: gated.competingInterpretations,
        missingContext: gated.missingContext,
        imageQualityIssues: [...new Set([...gated.modelQualityIssues, ...quality.issues])],
        requestAnotherAngle: gated.requestAnotherAngle,
        candidatePlanChanges: gated.candidateChanges,
      };
      await c.query(
        `UPDATE journal_analyses SET status='succeeded', error_code=NULL, provenance=$2, model=$3, prompt_version=$4, agent_run_id=$5, result=$6::jsonb,
           ai_narrative=$7, narrative_evidence_state=$8, gate_issues=$9::jsonb, updated_at=now() WHERE id=$1`,
        [analysisId, r.provenance, r.model, PROMPT_LABEL, runId, JSON.stringify(result), gated.narrative, gated.narrative ? "illustrative" : null, JSON.stringify(gated.issues)],
      );
      await c.query("UPDATE journal_entries SET processing_status='ready', version = version + 1, updated_at=now() WHERE id=$1", [entryId]);
    });
    await finishRun("succeeded", { usage: r.usage, estimated: estimate, settled, gateStatus: gated.issues.length ? "filtered" : "clean", output: { proposals: gated.facts.length, requestAnotherAngle: gated.requestAnotherAngle } });
    await ctx.heartbeat(1);
    return { analysisId, status: "succeeded", provenance: r.provenance, proposalCount: gated.facts.length, requestAnotherAngle: gated.requestAnotherAngle };
  }
}

async function promptContext(deps: JournalWorkerDeps, ownerId: string, entry: repo.EntryRow, photoCount: number): Promise<PromptContext> {
  const { pool, plans } = deps;
  let stages: PromptContext["stages"] = [];
  let cropId: string | null = null;
  let expectedStage: PromptContext["expectedStage"] = null;
  if (entry.plan_id) {
    try {
      const leaf = (await leafPlanId(pool, ownerId, entry.plan_id)) ?? entry.plan_id;
      const view = await plans.getPlan(ownerId, leaf);
      const s = stagesOf(view);
      stages = s.stages;
      cropId = s.cropId;
      // Calendar estimate for the observation date from the plan timeline; a missing timeline only removes this hint.
      const tl = await plans.getTimeline(ownerId, leaf, { from: entry.entry_date, to: entry.entry_date }).catch(() => null);
      const es = tl?.days[0]?.expectedStage;
      if (es) expectedStage = { stageId: es.stageId, window: es.window };
    } catch {
      /* no plan context: the model gets no stage ids, and plan-mapped proposals are dropped by the gate */
    }
  }
  const recent = await pool.query<{ d: string; activity: string | null; q: string | null; u: string | null }>(
    `SELECT to_char(entry_date,'YYYY-MM-DD') AS d, activity, quantity::text AS q, quantity_unit AS u FROM journal_entries
     WHERE owner_id=$1 AND farm_id=$2 AND id <> $3 AND entry_date <= $4 ORDER BY entry_date DESC, created_at DESC LIMIT 5`,
    [ownerId, entry.farm_id, entry.id, entry.entry_date],
  );
  const confirmed = await pool.query<{ fact_key: string; value: unknown; unit: string | null }>(
    `SELECT f.fact_key, f.value, f.unit FROM journal_facts f JOIN journal_entries e ON e.id = f.entry_id
     WHERE f.owner_id=$1 AND e.farm_id=$2 AND f.kind='confirmed' ORDER BY f.confirmed_at DESC LIMIT 10`,
    [ownerId, entry.farm_id],
  );
  return {
    observedOn: entry.entry_date,
    cropId,
    stages,
    expectedStage,
    recentActions: recent.rows.map((r) => ({ observedOn: r.d, activity: r.activity, quantity: r.q ? `${Number(r.q)} ${r.u ?? ""}`.trim() : null })),
    confirmedFacts: confirmed.rows.map((f) => ({ field: f.fact_key, value: f.value, unit: f.unit })),
    note: entry.text_body,
    photoCount,
  };
}
