import { SCHEMA_VERSION, StructuredAssistantOutput, ToolName, type Mode, type ValueRecord } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import type { InputItem, ParsedUsage } from "../providers/meta/types";
import { restoreOptionals, toRawJsonSchema, toStrictJsonSchema, type JsonSchema } from "../providers/meta/strict-schema";
import { Budget } from "../services/budget";
import { ApiError } from "../services/errors";
import { payloadHash, sha256Hex } from "../services/hash";
import { runOutputGate, type GateResult } from "./gate";
import type { AgentLimits } from "./limits";
import { INTERPRETATION_INSTRUCTIONS, PROMPT_HASH, PROMPT_LABEL, PROMPT_NAME, PROMPT_VERSION, SYNTHESIS_INSTRUCTIONS, TOOL_INSTRUCTIONS } from "./prompts";
import type { AgentPass, ProviderFailure, TextModelProvider, TextRequest, TextResult } from "./provider";
import { ProposedProfile } from "./schemas";
import type { ToolContext, ToolRegistry } from "./tools/registry";
import { AgentTrace, redactForTrace } from "./trace";

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
  /** Server-derived from the owned farm: district/state ids. Crop ids are added from resolved crops. */
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
  incomplete?: { reasons: string[] } | undefined;
  gateStatus: GateResult["status"] | null;
  error?: { code: string; message: string } | undefined;
  cost: { estimatedUsd: number; settledUsd: number; providerCalls: number; billable: boolean; cachedInputTokensObserved: number };
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

const outputSchemaStrict = (): JsonSchema =>
  // `toolRequests` items are z.unknown() in the contract; the synthesis pass never requests tools.
  toStrictJsonSchema(StructuredAssistantOutput, { overrideProperties: { toolRequests: { type: "array", items: { type: "string" } } } });
const outputSchemaRaw = (): JsonSchema => toRawJsonSchema(StructuredAssistantOutput);
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
  const run = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (owner_id, session_id, mode, purpose, provider, model, prompt_version, request_id, status, input_hash, provenance, limits)
     VALUES ($1,$2,$3,'assistant_turn',$4,$5,$6,$7,'running',$8,$9,$10::jsonb) RETURNING id`,
    [input.ownerId, input.sessionId, input.mode, provider.kind === "fixture" ? "fixture" : "meta", models.text, PROMPT_LABEL, input.requestId, sha256Hex(input.text), provider.provenance, JSON.stringify(limits)],
  );
  const runId = run.rows[0]!.id;
  await pool.query("INSERT INTO prompt_versions (name, version, content_sha256) VALUES ($1,$2,$3) ON CONFLICT (name, version) DO NOTHING", [PROMPT_NAME, PROMPT_VERSION, PROMPT_HASH]);

  const trace = new AgentTrace(runId);
  trace.add("run_started", { provider: provider.provenance, detail: { mode: input.mode, limits, promptVersion: PROMPT_LABEL, text: input.text, language: input.language, hasFarm: !!input.farmId, hasPlan: !!input.planId } });

  const usage: ParsedUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let estimatedUsd = 0;
  let settledUsd = 0;
  let providerCalls = 0;
  let toolRounds = 0;
  let toolCalls = 0;
  let escalations = 0;
  let repairs = 0;
  let chainTokens = 0;
  const toolResultIds: string[] = [];
  const toolResultViews: string[] = [];
  const discoveredCrops = new Set<string>();
  const unboundUsed = new Set<string>();
  let profile: ProposedProfile | null = null;
  let best: { gate: GateResult; candidate: StructuredAssistantOutput } | null = null;
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
      if (f.code === "aborted") throw new Stop("cancelled", "cancelled", "Request cancelled");
      if (f.code === "provider_unavailable") throw new Stop("provider_unavailable", "provider_unavailable", f.message);
      throw new Stop("failed", f.code, f.message);
    }
    const r = outcome.result;
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
    const rc = { runtimeMode: input.mode, farmId: input.farmId ?? null, planId: input.planId ?? null, selectedDate: input.selectedDate ?? null, scenarioId: input.scenarioId ?? null, today: asOf.slice(0, 10) };
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
      if (name === "resolve_crop_identity" && outcome.status === "ok") {
        for (const cand of (outcome.output as { candidates: { cropId: string }[] }).candidates) discoveredCrops.add(cand.cropId);
      }
      trace.add("tool_call", { pass: "tool_round", detail: { tool: toolName, callId, status: outcome.status, toolResultId: id, durationMs: Date.now() - started, ...(outcome.status !== "ok" ? { outcome } : {}) } });
      let view: string;
      if (outcome.status === "ok") {
        view = JSON.stringify({ toolResultId: id, status: "ok", result: outcome.output });
        if (view.length > MAX_TOOL_VIEW_CHARS) view = JSON.stringify({ toolResultId: id, status: "ok", truncated: true, note: "result too large to display; do not reference values you cannot see", preview: JSON.stringify(outcome.output).slice(0, 4000) });
      } else view = JSON.stringify({ toolResultId: id, ...outcome });
      toolResultViews.push(view);
      return view;
    }

    // ------------------------------------------------------------ synthesis + gate with bounded repair
    const outRaw = outputSchemaRaw();
    const proposedFacts = proposedFactsFromProfile(profile, input.farmId);
    const synthesisMessage = userMsg(
      `Write the final answer now as JSON for the farmer's language (${input.language}). Stored tool result ids available: ${JSON.stringify(toolResultIds)}. Pointers are relative to each tool result's "result" object.` +
        (unboundUsed.size > 0 ? ` Unavailable tools (say so in limitations): ${[...unboundUsed].join(", ")}.` : ""),
    );
    let prevId: string | undefined = lastResponseId;
    let nextInput: InputItem[] = skipTools || !prevId ? [userMsg(contextMessage()), synthesisMessage] : [...pendingOutputs, synthesisMessage];
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
      const parsed = parseStructured(r.outputText, outRaw, { safeParse: (v: unknown) => StructuredAssistantOutput.safeParse({ ...(v as object), toolRequests: [], proposedFacts }) as never });
      let gate: GateResult;
      if (!parsed.ok) {
        gate = { status: "correction_requested", approvedBlocks: [], approvedNumericRefs: [], approvedClaimEvidenceRefs: [], issues: [{ code: "schema_invalid", message: parsed.message, blockIds: [], correctable: true }], incomplete: { reasons: ["schema_invalid"] } };
        correction = `Your previous output was invalid: ${parsed.message}. Return the complete corrected JSON only.`;
      } else {
        const candidate = parsed.value as StructuredAssistantOutput;
        gate = await runOutputGate(pool, candidate, {
          ownerId: input.ownerId,
          mode: input.mode,
          agentRunId: runId,
          asOf,
          language: input.language,
          claimScope: { geographyIds: input.geographyIds ?? [], cropIds: [...discoveredCrops] },
          userText: input.text,
          rainHorizonDays: limits.rainHorizonDays,
        });
        if (gate.parsed && (best === null || gate.approvedBlocks.length >= best.gate.approvedBlocks.length)) best = { gate, candidate: gate.parsed };
        correction = gate.correctionRequest ? `${gate.correctionRequest.instruction} Issues: ${JSON.stringify(gate.correctionRequest.issues)}` : "";
      }
      lastGate = gate;
      trace.add("gate", { pass, detail: { status: gate.status, issues: gate.issues.map((i) => ({ code: i.code, blockIds: i.blockIds })), approvedBlocks: gate.approvedBlocks.length } });
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
      break;
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
  if (final) limitations.push(...final.candidate.limitations);
  const incomplete = status === "approved" ? undefined : (final?.gate.incomplete ?? (stop ? { reasons: [stop.code] } : useGate?.incomplete ?? { reasons: ["no_verified_answer"] }));
  if (incomplete && status !== "approved") limitations.push("Part of the answer was withheld because it could not be verified.");

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
    clarifications: (final?.candidate.clarifications ?? []).slice(0, 1),
    limitations: [...new Set(limitations)],
    incomplete,
    gateStatus: useGate?.status ?? null,
    ...(stop ? { error: { code: stop.code, message: stop.message } } : {}),
    cost: { estimatedUsd: safeNum(estimatedUsd), settledUsd: safeNum(settledUsd), providerCalls, billable: provider.billable, cachedInputTokensObserved: usage.cachedInputTokens },
    usage,
    toolRounds,
    toolCalls,
    trace,
  };
  if (stop?.status === "cancelled") trace.add("cancelled", { detail: { reason: stop.code } });
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
        final ? JSON.stringify({ intent: result.intent, language: result.language, approved: result.approved, limitations: result.limitations, status }) : null,
        stop ? JSON.stringify({ code: stop.code, message: stop.message }) : null,
      ],
    )
    .catch(() => undefined);
  return result;
}
