import { z } from "zod";
import { SCHEMA_VERSION, StructuredAssistantOutput, ToolName, type Mode, type ValueRecord } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import type { InputItem, ParsedUsage } from "../providers/meta/types";
import { restoreOptionals, toRawJsonSchema, toStrictJsonSchema, type JsonSchema } from "../providers/meta/strict-schema";
import { Budget } from "../services/budget";
import { ApiError } from "../services/errors";
import { payloadHash, sha256Hex } from "../services/hash";
import { getFarm } from "../services/farms";
import { runOutputGate, type GateContext, type GateResult } from "./gate";
import type { AgentLimits } from "./limits";
import { INTERPRETATION_INSTRUCTIONS, PROMPT_HASH, PROMPT_LABEL, PROMPT_NAME, PROMPT_VERSION, SYNTHESIS_INSTRUCTIONS, TOOL_INSTRUCTIONS } from "./prompts";
import type { AgentPass, ProviderFailure, TextModelProvider, TextRequest, TextResult } from "./provider";
import { AgentClaimEvidenceRef, ProposedProfile, attachClaimExtras, splitClaimExtras } from "./schemas";
import { TEMPLATE_LIMITATION, WITHHELD_LIMITATION, templateBlock, templateLanguage } from "./templates";
import type { ToolContext, ToolRegistry } from "./tools/registry";
import { AgentTrace, redactForTrace } from "./trace";
import { resolveTurnProduct, type ProductResolution } from "./product-resolution";
import { COMPACT_VIEWS } from "./tool-views";

export interface AgentTurnInput {
  ownerId: string;
  sessionId: string | null;
  mode: Mode;
  requestId: string;
  language: string;
  /** The farmer's message, or the farmer-confirmed transcript. */
  text: string;
  farmId?: string | undefined;
  planId?: string | undefined;
  selectedDate?: string | undefined;
  scenarioId?: string | undefined;
  /** Server-derived. Defaults to now; replay callers pass the cutoff. */
  asOf?: string | undefined;
  /**
   * Server-derived location of the owned farm (the route passes what it already loaded). When absent
   * and farmId is set, the loop loads the owned farm itself.
   */
  farmGeography?: { districtId: string | null; stateCode: string | null; regionIds?: string[] } | undefined;
  /** Legacy flat geography list (district/state ids); classified by id pattern in the gate. */
  geographyIds?: string[] | undefined;
}

export interface AgentDeps {
  pool: Pool;
  budget: Budget;
  provider: TextModelProvider;
  registry: ToolRegistry;
  limits: AgentLimits;
  models: { text: string; escalation: string };
  signal?: AbortSignal | undefined;
}

export type AgentStatus = "approved" | "partial" | "incomplete" | "provider_unavailable" | "budget_exceeded" | "cancelled" | "failed";

export interface AgentRunResult {
  runId: string;
  status: AgentStatus;
  provenance: TextModelProvider["provenance"];
  intent: string | null;
  language: string;
  approved: { answerBlocks: StructuredAssistantOutput["answerBlocks"]; numericRefs: StructuredAssistantOutput["numericRefs"]; claimEvidenceRefs: StructuredAssistantOutput["claimEvidenceRefs"] };
  proposedFacts: StructuredAssistantOutput["proposedFacts"];
  clarifications: StructuredAssistantOutput["clarifications"];
  limitations: string[];
  /** F13: server-authored withheld/templated notices in the turn language, appended to the spoken text. */
  spokenNotices: string[];
  incomplete?: { reasons: string[] } | undefined;
  gateStatus: GateResult["status"] | null;
  /** What the gate removed (claims, limitations, clarifications, blocks) and which blocks were templated. */
  gateReport: GateResult["report"] | null;
  error?: { code: string; message: string } | undefined;
  cost: { estimatedUsd: number; settledUsd: number; providerCalls: number; billable: boolean; cachedInputTokensObserved: number };
  /** L5 privacy: provider-stored responses of this run deleted after the run (best effort). */
  providerCleanup?: { attempted: number; deleted: number; failedCodes: string[] } | undefined;
  /** L5: tools the server called itself (for example screen_crops for a crop-choice question the model left unscreened). */
  serverInitiatedTools?: string[] | undefined;
  usage: ParsedUsage;
  toolRounds: number;
  toolCalls: number;
  trace: AgentTrace;
}

class Stop extends Error {
  constructor(
    public readonly status: AgentStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OUTPUT_FORMAT_NAME = "assistant_output";
const MAX_TOOL_VIEW_CHARS = 60_000;
const RESPONSE_CLEANUP_TIMEOUT_MS = 8_000;

const claimRefsArray = z.array(AgentClaimEvidenceRef);
const outputSchemaStrict = (): JsonSchema =>
  // `toolRequests` items are z.unknown() in the contract; the synthesis pass never requests tools.
  // claimEvidenceRefs carries the agent-local cropIds/granularity extension (stripped by the gate).
  toStrictJsonSchema(StructuredAssistantOutput, { overrideProperties: { toolRequests: { type: "array", items: { type: "string" } }, claimEvidenceRefs: toStrictJsonSchema(claimRefsArray) } });
const outputSchemaRaw = (): JsonSchema => {
  const raw = toRawJsonSchema(StructuredAssistantOutput);
  (raw.properties as Record<string, JsonSchema>).claimEvidenceRefs = toRawJsonSchema(claimRefsArray);
  return raw;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileSchemaStrict = (): JsonSchema => toStrictJsonSchema(ProposedProfile);

const userMsg = (text: string): InputItem => ({ role: "user", content: text });

const safeNum = (n: number) => Math.round(n * 1e6) / 1e6;

export function proposedFactsFromProfile(p: ProposedProfile | null, farmId: string | undefined): StructuredAssistantOutput["proposedFacts"] {
  if (!p) return [];
  const scope = { level: "farm" as const, ids: [farmId ?? "unsaved_profile"] };
  return p.facts.map((f) => {
    const common = { schemaVersion: SCHEMA_VERSION, evidenceState: "farmer_reported" as const, scope, validFrom: null, validTo: null, issuedAt: null, evidenceIds: [], assumptionIds: [], methodVersion: "meta_interpretation_v1", validationStatus: "pending" as const, missingReason: null };
    const value: ValueRecord = f.number !== null && f.unit !== null ? { ...common, kind: "quantity", value: f.number, unit: f.unit } : { ...common, kind: "text", value: f.text, unit: null };
    // Farmer facts are proposals only: the model can never mark them confirmed.
    return { field: f.field, value, sourceSpan: f.sourceSpan, requiresConfirmation: true as const };
  });
}

const estimateTokens = (...parts: unknown[]): number => Math.ceil(parts.reduce<number>((n, p) => n + (typeof p === "string" ? p.length : JSON.stringify(p ?? "").length), 0) / 2);

export async function runAgentTurn(deps: AgentDeps, input: AgentTurnInput): Promise<AgentRunResult> {
  const { pool, budget, provider, registry, limits, models } = deps;
  const asOf = input.asOf ?? new Date().toISOString();
  const farmUuid = input.farmId && UUID_RE.test(input.farmId) ? input.farmId : null;
  // farm_id is set only for a farm the owner actually holds, so farm deletion removes the run.
  const run = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (owner_id, session_id, mode, purpose, provider, model, prompt_version, request_id, status, input_hash, provenance, limits, farm_id)
     VALUES ($1,$2,$3,'assistant_turn',$4,$5,$6,$7,'running',$8,$9,$10::jsonb,(SELECT f.id FROM farms f WHERE f.id = $11::uuid AND f.owner_id = $1)) RETURNING id`,
    [input.ownerId, input.sessionId, input.mode, provider.kind === "fixture" ? "fixture" : "meta", models.text, PROMPT_LABEL, input.requestId, sha256Hex(input.text), provider.provenance, JSON.stringify(limits), farmUuid],
  );
  const runId = run.rows[0]!.id;
  await pool.query("INSERT INTO prompt_versions (name, version, content_sha256) VALUES ($1,$2,$3) ON CONFLICT (name, version) DO NOTHING", [PROMPT_NAME, PROMPT_VERSION, PROMPT_HASH]);

  const trace = new AgentTrace(runId);
  // The farmer's message is never stored in the trace: only its length and hash.
  trace.add("run_started", { provider: provider.provenance, detail: { mode: input.mode, limits, promptVersion: PROMPT_LABEL, textLength: input.text.length, textSha256: sha256Hex(input.text), language: input.language, hasFarm: !!input.farmId, hasPlan: !!input.planId } });

  // Server-derived claim scope: the plan's crop and the owned farm's district/state.
  const planCropIds: string[] = [];
  // F8: the plan's product (catalogue slug) scopes product-form claims ("dry ginger price ...").
  const planProductIds: string[] = [];
  if (input.planId && UUID_RE.test(input.planId)) {
    const pr = await pool.query<{ crop_id: string; product_ref: string | null }>("SELECT crop_id, product_ref FROM plans WHERE id = $1 AND owner_id = $2", [input.planId, input.ownerId]);
    for (const row of pr.rows) {
      planCropIds.push(row.crop_id);
      if (row.product_ref) planProductIds.push(row.product_ref);
    }
  }
  // L5: plan product slugs mapped to catalogue product ids (what resolve_crop_identity returns).
  const planProductUuids: string[] = planProductIds.length > 0 ? (await pool.query<{ id: string }>("SELECT id::text AS id FROM crop_products WHERE slug = ANY($1::text[]) OR id::text = ANY($1::text[])", [planProductIds])).rows.map((r) => r.id) : [];
  let farmGeo = input.farmGeography;
  if (!farmGeo && farmUuid) {
    const farm = await getFarm(pool, input.ownerId, farmUuid).catch(() => null);
    if (farm) farmGeo = { districtId: farm.location.districtId, stateCode: farm.location.stateCode };
  }
  const claimScope: GateContext["claimScope"] = {
    geographyIds: input.geographyIds ?? [],
    districtIds: farmGeo?.districtId ? [farmGeo.districtId] : [],
    stateIds: farmGeo?.stateCode ? [farmGeo.stateCode, `IN-${farmGeo.stateCode}`] : [],
    regionIds: farmGeo?.regionIds ?? [],
    cropIds: planCropIds,
    productIds: planProductIds,
  };
  const gateCtx = (): GateContext => ({ ownerId: input.ownerId, mode: input.mode, agentRunId: runId, asOf, language: input.language, claimScope, userText: input.text, rainHorizonDays: limits.rainHorizonDays });

  const usage: ParsedUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let estimatedUsd = 0;
  let settledUsd = 0;
  let providerCalls = 0;
  let toolRounds = 0;
  let toolCalls = 0;
  let escalations = 0;
  let repairs = 0;
  let chainRecoveries = 0;
  let chainTokens = 0;
  const toolResultIds: string[] = [];
  const responseIds: string[] = [];
  /** Tools that returned an ok result in this run. */
  const calledTools = new Set<string>();
  const serverInitiated: string[] = [];
  const productResolutions = new Map<string, ProductResolution>();
  const toolResultViews: string[] = [];
  const unboundUsed = new Set<string>();
  let profile: ProposedProfile | null = null;
  let best: { gate: GateResult; candidate: StructuredAssistantOutput } | null = null;
  let repairsExhausted = false;
  let templateUsed = false;
  let lastGate: GateResult | null = null;
  let stop: Stop | null = null;

  const ctxBase = { ownerId: input.ownerId, mode: input.mode, requestId: input.requestId, pool, agentRunId: runId, asOf, signal: deps.signal } satisfies ToolContext;

  /** One provider call with budget reserve/settle/release/markUncertain, trace and cancellation. */
  async function call(pass: AgentPass, req: Omit<TextRequest, "pass" | "toolResultIds" | "signal">, opts: { chained: boolean } = { chained: false }): Promise<TextResult> {
    if (deps.signal?.aborted) throw new Stop("cancelled", "cancelled", "Request cancelled");
    let reservationId: string | null = null;
    let estimate = 0;
    if (provider.billable) {
      estimate = budget.estimate("meta", req.model, { inputTokens: estimateTokens(req.instructions, req.input, req.tools, req.textFormat) + (opts.chained ? chainTokens : 0), outputTokens: req.maxOutputTokens }).usd ?? 0;
      try {
        const r = await budget.reserve({ ownerId: input.ownerId, sessionId: input.sessionId, provider: "meta", model: req.model, estimate, requestId: input.requestId });
        reservationId = r.reservationId;
        estimatedUsd += estimate;
        trace.add("budget", { pass, model: req.model, detail: { action: "reserved", estimateUsd: estimate } });
      } catch (e) {
        if (e instanceof ApiError && e.code === "budget_exceeded") {
          trace.add("budget", { pass, detail: { action: "denied", limit: (e.details as { limit?: string } | undefined)?.limit } });
          throw new Stop("budget_exceeded", "budget_exceeded", e.message);
        }
        throw e;
      }
    }
    providerCalls++;
    let outcome: Awaited<ReturnType<TextModelProvider["call"]>>;
    try {
      outcome = await provider.call({ ...req, pass, toolResultIds, signal: deps.signal });
    } catch (e) {
      // A provider implementation must not throw; if it does the outcome is unknown, so the reservation is kept.
      outcome = { ok: false, error: { code: "provider_error", message: `provider threw ${e instanceof Error ? e.name : "an error"}`, retryable: false, outcomeUncertain: true, requestId: null, retries: 0 } };
    }
    if (!outcome.ok) {
      const f: ProviderFailure = outcome.error;
      if (reservationId) {
        try {
          if (f.outcomeUncertain) await budget.markUncertain(reservationId);
          else await budget.release(reservationId);
          trace.add("budget", { pass, detail: { action: f.outcomeUncertain ? "uncertain" : "released" } });
        } catch (e) {
          trace.add("budget", { pass, detail: { action: "reservation_update_failed", error: (e as Error).name } });
        }
      }
      trace.add("provider_error", { pass, model: req.model, requestId: f.requestId, retries: f.retries, detail: { code: f.code, message: f.message } });
      // L5: observed live once (2026-10-30): a chained call failed with HTTP 400 "referenced response not found or
      // expired" 3 s after the referenced response was created (not deleted by us). Recover once per run by
      // re-sending the same pass unchained, with the request context and every stored tool result as text.
      if (f.code === "bad_request" && req.previousResponseId && /referenced response not found/i.test(f.message) && chainRecoveries < 1) {
        chainRecoveries++;
        const kept = (Array.isArray(req.input) ? req.input : [userMsg(req.input)]).filter((i) => (i as { type?: string }).type !== "function_call_output");
        const recovered: InputItem[] = [userMsg(`${contextMessage()}\n<stored_tool_results>${toolResultViews.join("\n")}</stored_tool_results>`), ...kept];
        trace.add("chain_recovery", { pass, detail: { reason: "previous_response_not_found", resentToolResults: toolResultViews.length } });
        const { previousResponseId: _drop, ...rest } = req;
        return call(pass, { ...rest, input: recovered }, { chained: false });
      }
      if (f.code === "aborted") throw new Stop("cancelled", "cancelled", "Request cancelled");
      if (f.code === "provider_unavailable") throw new Stop("provider_unavailable", "provider_unavailable", f.message);
      throw new Stop("failed", f.code, f.message);
    }
    const r = outcome.result;
    if (r.responseId && !responseIds.includes(r.responseId)) responseIds.push(r.responseId);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.cachedInputTokens += r.usage.cachedInputTokens;
    if (opts.chained || pass === "tool_round") chainTokens += r.usage.inputTokens + r.usage.outputTokens;
    if (reservationId) {
      const unknownUsage = r.usage.inputTokens === 0 && r.usage.outputTokens === 0;
      // Cached input is priced at the full input rate: the price table has no cached tier, so this over-estimates.
      const actual = unknownUsage ? estimate : (budget.estimate("meta", req.model, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }).usd ?? 0);
      try {
        await budget.settle(reservationId, actual, r.requestId, { ...r.usage, requests: 1, model: r.model, usageReported: !unknownUsage });
        settledUsd += actual;
        trace.add("budget", { pass, requestId: r.requestId, detail: { action: "settled", actualUsd: actual, estimateUsd: estimate, basis: "estimated" } });
      } catch (e) {
        trace.add("budget", { pass, detail: { action: "settle_failed", error: (e as Error).name } });
      }
    }
    trace.add("provider_call", { pass, provider: r.provenance, model: r.model, requestId: r.requestId, responseId: r.responseId, usage: r.usage, latencyMs: r.latencyMs, retries: r.retries, detail: { functionCalls: r.functionCalls.map((c) => c.name), outputChars: r.outputText?.length ?? 0 } });
    return r;
  }

  const contextMessage = (): string => {
    const rc = {
      runtimeMode: input.mode, farmId: input.farmId ?? null, planId: input.planId ?? null, selectedDate: input.selectedDate ?? null, scenarioId: input.scenarioId ?? null, today: asOf.slice(0, 10),
      ...(productResolutions.size > 0 ? { productResolution: [...productResolutions.values()] } : {}),
    };
    return `<farmer_input language="${input.language}">\n${input.text}\n</farmer_input>\n<request_context>${JSON.stringify(rc)}</request_context>` + (profile ? `\n<interpretation>${JSON.stringify(profile)}</interpretation>` : "");
  };

  /** Parse a structured-output text with the strict-mode null restoration; returns the validated value or an error summary. */
  const parseStructured = <T>(text: string | null, raw: JsonSchema, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): { ok: true; value: T; json: unknown } | { ok: false; message: string } => {
    if (text === null || text.trim() === "") return { ok: false, message: "the response contained no JSON text" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, message: "the response was not valid JSON" };
    }
    const restored = restoreOptionals(raw, json);
    const r = schema.safeParse(restored);
    if (!r.success) return { ok: false, message: r.error.issues.slice(0, 6).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 600) };
    return { ok: true, value: r.data, json: restored };
  };

  const repairBudgetLeft = () => repairs < limits.maxRepairAttempts;
  const canEscalate = () => limits.wonderEnabled && escalations < limits.maxWonderEscalations;

  try {
    // ------------------------------------------------------------ interpretation pass
    let interpResponseId: string | null = null;
    {
      let attemptInput: string | InputItem[] = [userMsg(contextMessage())];
      let prev: string | undefined;
      for (;;) {
        const isRepair = prev !== undefined;
        const r = await call(isRepair ? "repair" : "interpretation", {
          model: models.text,
          instructions: INTERPRETATION_INSTRUCTIONS,
          input: attemptInput,
          textFormat: { name: "proposed_profile", schema: profileSchemaStrict() },
          ...(prev ? { previousResponseId: prev } : {}),
          maxOutputTokens: limits.interpretationMaxOutputTokens,
          reasoningEffort: limits.reasoningEffort,
        }, { chained: isRepair });
        const parsed = parseStructured(r.outputText, toRawJsonSchema(ProposedProfile), ProposedProfile);
        if (parsed.ok) {
          profile = parsed.value;
          interpResponseId = r.responseId;
          break;
        }
        if (!repairBudgetLeft() || !r.responseId) throw new Stop("failed", "interpretation_invalid", "The interpretation output was not valid after repair attempts");
        repairs++;
        trace.add("gate", { pass: "interpretation", detail: { stage: "schema", ok: false, repairAttempt: repairs, message: parsed.message } });
        prev = r.responseId;
        attemptInput = [userMsg(`Your previous output was invalid: ${parsed.message}. Return the complete corrected JSON only.`)];
      }
    }
    void interpResponseId;

    // ------------------------------------------------------------ tool phase
    let lastResponseId: string | undefined;
    let pendingOutputs: InputItem[] = [];
    const advertised = registry.advertisedFor(input.mode);
    const skipTools = profile!.intent === "clarification_needed" || profile!.intent === "out_of_scope" || advertised.length === 0;
    if (!skipTools) {
      let toolInput: InputItem[] = [userMsg(contextMessage())];
      let prev: string | undefined;
      for (let round = 1; ; round++) {
        const r = await call("tool_round", {
          model: models.text,
          instructions: TOOL_INSTRUCTIONS,
          input: toolInput,
          tools: advertised,
          ...(prev ? { previousResponseId: prev } : {}),
          maxOutputTokens: limits.maxOutputTokens,
          reasoningEffort: limits.reasoningEffort,
        }, { chained: prev !== undefined });
        pendingOutputs = []; // the previous round's outputs were delivered by this call
        if (r.functionCalls.length === 0) {
          if (r.responseId) lastResponseId = r.responseId;
          break;
        }
        if (!r.responseId) throw new Stop("failed", "missing_response_id", "Provider response had no id; cannot continue the tool round");
        if (round > limits.maxToolRounds) {
          trace.add("ceiling_refused", { pass: "tool_round", detail: { ceiling: "tool_rounds", limit: limits.maxToolRounds, refusedCalls: r.functionCalls.map((c) => c.name) } });
          pendingOutputs = r.functionCalls.map((c) => ({ type: "function_call_output" as const, call_id: c.callId, output: JSON.stringify({ status: "error", code: "ceiling_exceeded", message: "tool round ceiling reached; no further tools will be executed" }) }));
          lastResponseId = r.responseId;
          break;
        }
        toolRounds++;
        const outputs: InputItem[] = [];
        let hitCallCeiling = false;
        for (const c of r.functionCalls) {
          if (deps.signal?.aborted) throw new Stop("cancelled", "cancelled", "Request cancelled");
          if (toolCalls >= limits.maxToolCalls) {
            hitCallCeiling = true;
            trace.add("ceiling_refused", { pass: "tool_round", detail: { ceiling: "tool_calls", limit: limits.maxToolCalls, refusedCall: c.name } });
            outputs.push({ type: "function_call_output", call_id: c.callId, output: JSON.stringify({ status: "error", code: "ceiling_exceeded", message: "tool call ceiling reached" }) });
            continue;
          }
          toolCalls++;
          const view = await executeCall(c.name, c.arguments, c.callId);
          outputs.push({ type: "function_call_output", call_id: c.callId, output: view });
        }
        prev = r.responseId;
        toolInput = outputs;
        lastResponseId = r.responseId;
        pendingOutputs = outputs;
        if (hitCallCeiling) break;
      }
    }

    /** Executes one tool call; stores the result and returns the model-visible JSON string. */
    async function executeCall(rawName: string, rawArgs: string, callId: string): Promise<string> {
      const started = Date.now();
      const nameParsed = ToolName.safeParse(rawName);
      let outcome: { status: "ok"; output: unknown } | { status: "unavailable"; reason: string } | { status: "error"; code: string; message: string };
      let argsForAudit: unknown = null;
      const name = nameParsed.success ? nameParsed.data : null;
      if (!name) outcome = { status: "error", code: "unknown_tool", message: "That tool does not exist" };
      else if (!registry.isAllowed(name, input.mode)) outcome = { status: "error", code: "tool_not_allowed", message: `${name} is not available in ${input.mode} mode` };
      else {
        const def = registry.get(name)!;
        const parsed = registry.parseArguments(name, rawArgs);
        if (!parsed.ok) outcome = { status: "error", code: "invalid_arguments", message: parsed.message.slice(0, 400) };
        else {
          argsForAudit = parsed.input;
          outcome = await registry.execute(def, parsed.input, ctxBase);
          if (outcome.status === "unavailable") unboundUsed.add(name);
        }
      }
      if (name && outcome.status === "ok") calledTools.add(name);
      const toolName = (name ?? `invalid:${rawName.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`);
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO tool_results (owner_id, agent_run_id, tool_name, args_hash, result, error, duration_ms, status, call_id, redacted_args, ordinal)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
        [
          input.ownerId,
          runId,
          toolName,
          payloadHash(argsForAudit ?? rawArgs),
          outcome.status === "ok" ? JSON.stringify(outcome.output) : null,
          outcome.status === "ok" ? null : JSON.stringify(outcome),
          Date.now() - started,
          outcome.status,
          callId,
          JSON.stringify(redactForTrace(argsForAudit)),
          toolResultIds.length,
        ],
      );
      const id = ins.rows[0]!.id;
      toolResultIds.push(id);
      trace.add("tool_call", { pass: "tool_round", detail: { tool: toolName, callId, status: outcome.status, toolResultId: id, durationMs: Date.now() - started, ...(outcome.status !== "ok" ? { outcome } : {}) } });
      let view: string;
      if (outcome.status === "ok") {
        const pr = name === "resolve_crop_identity" ? productResolutionFor(outcome.output) : null;
        view = JSON.stringify({ toolResultId: id, status: "ok", result: outcome.output, ...(pr ? { serverProductResolution: pr } : {}) });
        const compact = name ? COMPACT_VIEWS[name] : undefined;
        if (view.length > MAX_TOOL_VIEW_CHARS && compact) view = JSON.stringify({ toolResultId: id, status: "ok", result: compact(outcome.output), ...(pr ? { serverProductResolution: pr } : {}) });
        if (view.length > MAX_TOOL_VIEW_CHARS) view = JSON.stringify({ toolResultId: id, status: "ok", truncated: true, note: "result too large to display; do not reference values you cannot see", preview: JSON.stringify(outcome.output).slice(0, 4000) });
      } else view = JSON.stringify({ toolResultId: id, ...outcome });
      toolResultViews.push(view);
      return view;
    }

    /**
     * L5 product rule: a single-crop identity result without a product gets the server's product choice
     * (plan -> explicit fresh/dry mention -> single product -> crop level). Attached outside "result", so
     * JSON pointers into the stored tool result are unaffected.
     */
    function productResolutionFor(output: unknown): ProductResolution | null {
      const cands = (output as { candidates?: { cropId: string; productId: string | null; products: { productId: string; productBasis: string }[] }[] }).candidates ?? [];
      const crops = new Set(cands.map((c) => c.cropId));
      if (crops.size !== 1 || cands.some((c) => c.productId !== null)) return null;
      const c = cands[0]!;
      const pr = resolveTurnProduct(c.cropId, c.products, { planProductIds: planProductUuids, userText: input.text, intent: profile?.intent ?? null });
      productResolutions.set(c.cropId, pr);
      trace.add("product_resolution", { pass: "tool_round", detail: pr });
      return pr;
    }

    // ------------------------------------------------------------ L5 server-initiated screening
    // A crop-choice question must be answered from screen_crops. If the model ended its tool rounds without
    // calling it, the server calls it once with the owned farm as context and hands the result to synthesis.
    let serverToolMessage: InputItem | null = null;
    const SCREEN_INTENTS = new Set(["compare_crops", "explore_crops"]);
    if (!skipTools && profile && SCREEN_INTENTS.has(profile.intent) && !calledTools.has("screen_crops") && farmUuid && advertised.some((t) => t.name === "screen_crops") && toolCalls < limits.maxToolCalls) {
      if (deps.signal?.aborted) throw new Stop("cancelled", "cancelled", "Request cancelled");
      toolCalls++;
      const callId = `server_screen_crops_${toolResultIds.length + 1}`;
      const view = await executeCall("screen_crops", JSON.stringify({ contextId: farmUuid }), callId);
      serverInitiated.push("screen_crops");
      trace.add("server_initiated_tool", { pass: "tool_round", detail: { tool: "screen_crops", reason: "crop_choice_intent_without_screening", intent: profile.intent, callId, toolResultId: toolResultIds[toolResultIds.length - 1] } });
      serverToolMessage = userMsg(`<server_initiated_tool_result tool="screen_crops" reason="crop choice question; screening is required">\n${view}\n</server_initiated_tool_result>`);
    }

    // ------------------------------------------------------------ synthesis + gate with bounded repair
    const outRaw = outputSchemaRaw();
    const proposedFacts = proposedFactsFromProfile(profile, input.farmId);
    const synthesisMessage = userMsg(
      `Write the final answer now as JSON for the farmer's language (${input.language}). Stored tool result ids available: ${JSON.stringify(toolResultIds)}. Pointers are relative to each tool result's "result" object.` +
        (unboundUsed.size > 0 ? ` Unavailable tools (say so in limitations): ${[...unboundUsed].join(", ")}.` : ""),
    );
    let prevId: string | undefined = lastResponseId;
    const serverMsgs = serverToolMessage ? [serverToolMessage] : [];
    let nextInput: InputItem[] = skipTools || !prevId ? [userMsg(contextMessage()), ...serverMsgs, synthesisMessage] : [...pendingOutputs, ...serverMsgs, synthesisMessage];
    let pass: AgentPass = "synthesis";
    let model = profile!.needsEscalation && canEscalate() ? models.escalation : models.text;
    if (model === models.escalation) {
      escalations++;
      trace.add("escalation", { model, detail: { reason: "needs_escalation" } });
    }
    for (;;) {
      const r = await call(pass, {
        model,
        instructions: SYNTHESIS_INSTRUCTIONS,
        input: nextInput,
        textFormat: { name: OUTPUT_FORMAT_NAME, schema: outputSchemaStrict() },
        ...(prevId ? { previousResponseId: prevId } : {}),
        maxOutputTokens: limits.maxOutputTokens,
        reasoningEffort: limits.reasoningEffort,
      }, { chained: prevId !== undefined });
      let correction: string;
      // Validate the contract shape with the agent-local claim fields split off, but gate the full candidate.
      const parsed = parseStructured(r.outputText, outRaw, {
        safeParse: (v: unknown) => {
          const full = { ...(v as object), toolRequests: [], proposedFacts };
          const split = splitClaimExtras(full);
          if (!split.ok) return { success: false, error: { issues: [{ path: ["claimEvidenceRefs"], message: split.message }] } } as never;
          const c = StructuredAssistantOutput.safeParse(split.stripped);
          return (c.success ? { success: true, data: full } : c) as never;
        },
      });
      let gate: GateResult;
      if (!parsed.ok) {
        gate = { status: "correction_requested", approvedBlocks: [], approvedNumericRefs: [], approvedClaimEvidenceRefs: [], approvedLimitations: [], approvedClarifications: [], report: { removed: [], groundedEvidenceIds: [], templated: [] }, withheld: [], issues: [{ code: "schema_invalid", message: parsed.message, blockIds: [], correctable: true }], incomplete: { reasons: ["schema_invalid"] } };
        correction = `Your previous output was invalid: ${parsed.message}. Return the complete corrected JSON only.`;
      } else {
        gate = await runOutputGate(pool, parsed.value, gateCtx());
        if (gate.parsed && (best === null || gate.approvedBlocks.length >= best.gate.approvedBlocks.length)) best = { gate, candidate: gate.parsed };
        correction = gate.correctionRequest ? `${gate.correctionRequest.instruction} Issues: ${JSON.stringify(gate.correctionRequest.issues)}` : "";
      }
      lastGate = gate;
      trace.add("gate", { pass, detail: { status: gate.status, issues: gate.issues.map((i) => ({ code: i.code, blockIds: i.blockIds })), approvedBlocks: gate.approvedBlocks.length, removed: gate.report.removed } });
      if (gate.status === "approved" || gate.status === "unverified") break;
      // Needs repair (partial or nothing approved).
      if (repairBudgetLeft() && r.responseId) {
        repairs++;
        prevId = r.responseId;
        nextInput = [userMsg(correction)];
        pass = "repair";
        continue;
      }
      const schemaFailure = gate.issues.some((i) => i.code === "schema_invalid");
      if (schemaFailure && canEscalate()) {
        escalations++;
        model = models.escalation;
        trace.add("escalation", { model, detail: { reason: "repeated_schema_failure" } });
        prevId = undefined;
        nextInput = [userMsg(`${contextMessage()}\n<stored_tool_results>${toolResultViews.join("\n")}</stored_tool_results>`), synthesisMessage, userMsg(correction)];
        pass = "escalation";
        continue;
      }
      repairsExhausted = true;
      break;
    }

    // ------------------------------------------------------------ server templates after repair exhaustion
    // Withheld critical statements are replaced by server-authored template sentences built only from
    // verified numericRefs (or a fixed safety sentence), and the result is gated again.
    if (repairsExhausted && best && best.gate.status !== "approved" && best.gate.withheld.length > 0 && best.gate.parsed) {
      const g = best.gate;
      const lang = templateLanguage(input.language);
      const refs = new Map(g.parsed!.numericRefs.map((r) => [r.id, r]));
      const withheldById = new Map(g.withheld.map((w) => [w.blockId, w]));
      const templated: GateResult["report"]["templated"] = [];
      const blocks = g.parsed!.answerBlocks.flatMap((b) => {
        const w = withheldById.get(b.id);
        if (!w) return g.approvedBlocks.some((a) => a.id === b.id) ? [b] : [];
        const t = templateBlock(lang, b, w, refs, (id) => g.presented?.get(id) ?? null);
        if (!t) return [];
        templated.push({ blockId: b.id, template: t.template, numericRefIds: t.block.numericRefIds });
        return [t.block];
      });
      if (templated.length > 0) {
        const rebuilt = attachClaimExtras({ ...g.parsed!, answerBlocks: blocks, limitations: g.approvedLimitations, clarifications: g.approvedClarifications }, g.claimExtras ?? new Map());
        const regate = await runOutputGate(pool, rebuilt, gateCtx());
        const kept = templated.filter((t) => regate.approvedBlocks.some((b) => b.id === t.blockId));
        trace.add("gate", { pass: "template", detail: { status: regate.status, templated: templated.map((t) => ({ blockId: t.blockId, template: t.template })), approvedBlocks: regate.approvedBlocks.length, issues: regate.issues.map((i) => ({ code: i.code, blockIds: i.blockIds })) } });
        if (kept.length > 0 && regate.approvedBlocks.length > 0) {
          const removed = [...g.report.removed, ...regate.report.removed];
          best = {
            candidate: best.candidate,
            gate: {
              ...regate,
              // Templated output is never "approved": the original text was withheld.
              status: "partial",
              report: { removed, groundedEvidenceIds: regate.report.groundedEvidenceIds, templated: kept },
              incomplete: { reasons: [...new Set([...(g.incomplete?.reasons ?? []), "template_substituted"])] },
            },
          };
          templateUsed = true;
        }
      }
    }
  } catch (e) {
    if (e instanceof Stop) stop = e;
    else {
      stop = new Stop("failed", "internal_error", "The assistant run failed unexpectedly");
      trace.add("provider_error", { detail: { code: "internal_error", error: e instanceof Error ? e.name : "unknown" } });
    }
  }

  // ---------------------------------------------------------------- result assembly
  const useGate = best?.gate ?? lastGate;
  const final = best && best.gate.status !== "unverified" ? best : null;
  let status: AgentStatus;
  if (stop) status = stop.status;
  else if (final && final.gate.status === "approved") status = "approved";
  else if (final && final.gate.approvedBlocks.length > 0) status = "partial";
  else status = "incomplete";
  // A hard stop after a partially approved answer still returns what was approved, labelled partial.
  if (stop && final && final.gate.approvedBlocks.length > 0 && (stop.status === "budget_exceeded" || stop.status === "failed")) status = "partial";

  const limitations: string[] = [];
  if (provider.provenance === "synthetic_fixture") limitations.push("Synthetic fixture response: not produced by a live model and not based on real data.");
  for (const t of unboundUsed) limitations.push(`The ${t} capability is not available yet, so no result from it is included.`);
  if (final) limitations.push(...final.gate.approvedLimitations);
  // F13 (review R4 #8): server-authored notices about withheld/templated content, in the turn language; the
  // route appends them to the spoken (approved) text so audio never omits them.
  const spokenNotices: string[] = [];
  if (templateUsed) spokenNotices.push(TEMPLATE_LIMITATION[templateLanguage(input.language)]);
  if (templateUsed) limitations.push(TEMPLATE_LIMITATION[templateLanguage(input.language)]);
  if (final && final.gate.report.groundedEvidenceIds.length > 0) limitations.push("Some cited evidence is a machine-grounded excerpt; human review of its meaning and scope is pending.");
  const incomplete = status === "approved" ? undefined : (final?.gate.incomplete ?? (stop ? { reasons: [stop.code] } : useGate?.incomplete ?? { reasons: ["no_verified_answer"] }));
  if (incomplete && status !== "approved") {
    limitations.push(WITHHELD_LIMITATION.en);
    spokenNotices.push(WITHHELD_LIMITATION[templateLanguage(input.language)]);
  }

  // Only one clarification is asked per turn; the trimmed ones are recorded as removed (F8).
  const approvedClarifications = final?.gate.approvedClarifications ?? [];
  const baseReport = final?.gate.report ?? useGate?.report ?? null;
  const gateReport: GateResult["report"] | null =
    baseReport && approvedClarifications.length > 1
      ? {
          ...baseReport,
          removed: [
            ...baseReport.removed,
            ...approvedClarifications.slice(1).map((q) => ({ field: "clarification" as const, id: q.id, index: (final?.gate.parsed?.clarifications ?? []).findIndex((x) => x.id === q.id), codes: ["clarification_limit"] })),
          ],
        }
      : baseReport;
  const result: AgentRunResult = {
    runId,
    status,
    provenance: provider.provenance,
    intent: final ? final.candidate.intent : (profile?.intent ?? null),
    language: final ? final.candidate.language : input.language,
    approved: final
      ? { answerBlocks: final.gate.approvedBlocks, numericRefs: final.gate.approvedNumericRefs, claimEvidenceRefs: final.gate.approvedClaimEvidenceRefs }
      : { answerBlocks: [], numericRefs: [], claimEvidenceRefs: [] },
    proposedFacts: proposedFactsFromProfile(profile, input.farmId),
    clarifications: approvedClarifications.slice(0, 1),
    limitations: [...new Set(limitations)],
    spokenNotices: [...new Set(spokenNotices)],
    incomplete,
    gateStatus: useGate?.status ?? null,
    gateReport,
    ...(stop ? { error: { code: stop.code, message: stop.message } } : {}),
    cost: { estimatedUsd: safeNum(estimatedUsd), settledUsd: safeNum(settledUsd), providerCalls, billable: provider.billable, cachedInputTokensObserved: usage.cachedInputTokens },
    usage,
    toolRounds,
    toolCalls,
    trace,
  };
  if (stop?.status === "cancelled") trace.add("cancelled", { detail: { reason: stop.code } });
  // L5 privacy: delete every provider-stored response of this run (success or failure). Best effort and bounded:
  // a failure is logged, never changes the answer, and is never retried.
  if (responseIds.length > 0 && provider.deleteResponse) {
    const del = provider.deleteResponse.bind(provider);
    const settled = await Promise.race([
      Promise.allSettled(responseIds.map((id) => del(id))),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RESPONSE_CLEANUP_TIMEOUT_MS).unref?.()),
    ]);
    const failedCodes: string[] = [];
    let deleted = 0;
    if (settled === null) failedCodes.push("cleanup_timeout");
    else for (const s of settled) {
      if (s.status === "fulfilled" && s.value.ok) deleted++;
      else failedCodes.push(s.status === "fulfilled" ? (s.value.code ?? "delete_failed") : "delete_threw");
    }
    result.providerCleanup = { attempted: responseIds.length, deleted, failedCodes };
    trace.add("response_cleanup", { detail: result.providerCleanup });
  }
  if (serverInitiated.length > 0) result.serverInitiatedTools = [...serverInitiated];
  trace.add("run_finished", { detail: { status, gateStatus: result.gateStatus, providerCalls, toolRounds, toolCalls, repairs, escalations } });

  const dbStatus = status === "approved" || status === "partial" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
  await pool
    .query(
      `UPDATE agent_runs SET status=$2, rounds=$3, tool_calls=$4, provider_calls=$5, gate_status=$6, usage=$7::jsonb, estimated_usd=$8, settled_usd=$9,
              trace=$10::jsonb, output=$11::jsonb, error=$12::jsonb, finished_at=now() WHERE id=$1`,
      [
        runId,
        dbStatus,
        toolRounds,
        toolCalls,
        providerCalls,
        result.gateStatus,
        JSON.stringify(usage),
        safeNum(estimatedUsd),
        safeNum(settledUsd),
        JSON.stringify(trace.toJSON()),
        final ? JSON.stringify({ intent: result.intent, language: result.language, approved: result.approved, limitations: result.limitations, status, gateReport: result.gateReport }) : null,
        stop ? JSON.stringify({ code: stop.code, message: stop.message }) : null,
      ],
    )
    .catch(() => undefined);
  return result;
}
