import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope, errorEnvelope } from "../envelope";
import { FixtureProvider } from "../agent/fixture-provider";
import { loadAgentLimits, type AgentLimits } from "../agent/limits";
import { runAgentTurn, type AgentRunResult } from "../agent/loop";
import { selectProvider, type TextModelProvider } from "../agent/provider";
import { implementedBindings } from "../agent/tools/handlers";
import { ToolRegistry, type ToolBindings } from "../agent/tools/registry";
import { recordApprovedText } from "../speech/approved";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { Budget } from "../services/budget";
import { ApiError, notFound } from "../services/errors";
import { getFarm } from "../services/farms";
import { parseIdempotencyKey, runIdempotent } from "../services/idempotency";
import { envelopeSchema, errorEnvelopeSchema } from "./schemas/common";
import { turnBody, turnOut, type TurnOut } from "./schemas/assistant";

export interface AssistantRouteDeps {
  config: Config;
  pool: Pool;
  /** Share the server's Budget instance so limits and the price table are the same everywhere. */
  budget?: Budget;
  /** Test/override hook. Default: synthetic mode -> FixtureProvider; live/replay -> Meta (or provider_unavailable without a key). */
  providerFactory?: (mode: Config["RUNTIME_MODE"]) => TextModelProvider;
  /** Handlers for tools implemented by later tasks (merged over the T09 implementations). */
  toolBindings?: ToolBindings;
  limits?: Partial<AgentLimits>;
  /** Synthetic-mode fixture scenario (server-side only; never a client input). */
  fixtureScenario?: string;
  fetchImpl?: typeof fetch;
}

export function toTurnOut(r: AgentRunResult, approved: { text: string | null; hash: string | null } = { text: null, hash: null }): TurnOut {
  return {
    approvedText: approved.text,
    approvedTextHash: approved.hash,
    status: r.status,
    provenance: r.provenance,
    traceId: r.runId,
    intent: r.intent,
    language: r.language,
    gateStatus: r.gateStatus,
    answerBlocks: r.approved.answerBlocks,
    numericRefs: r.approved.numericRefs,
    claimEvidenceRefs: r.approved.claimEvidenceRefs,
    proposedFacts: r.proposedFacts,
    clarifications: r.clarifications,
    limitations: r.limitations,
    incomplete: r.incomplete ?? null,
    costEstimate: { estimatedUsd: r.cost.estimatedUsd, settledUsd: r.cost.settledUsd, providerCalls: r.cost.providerCalls, billable: r.cost.billable, basis: "estimated_not_billed" },
  };
}

/** Plugin: `app.register(registerAssistantRoutes, deps)`. Owns its own auth/CSRF hook (encapsulated). */
export async function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): Promise<void> {
  const { config, pool } = deps;
  const limits = loadAgentLimits(process.env, deps.limits);
  const budget = deps.budget ?? Budget.fromConfig(pool, config);
  const registry = new ToolRegistry({ ...implementedBindings(), ...deps.toolBindings });
  const scenario = deps.fixtureScenario ?? process.env.AGENT_FIXTURE_SCENARIO ?? "profile_extraction";
  const providerFor = (mode: Config["RUNTIME_MODE"]): TextModelProvider =>
    deps.providerFactory
      ? deps.providerFactory(mode)
      : selectProvider({ mode, apiKey: config.MODEL_API_KEY, baseUrl: config.META_BASE_URL, fixture: () => new FixtureProvider(scenario), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/assistant/turns",
    {
      config: { rateLimit: { max: limits.turnsPerMinute, timeWindow: "1 minute" } },
      schema: {
        tags: ["assistant"],
        description:
          "Runs one assistant turn: interpretation, allowlisted tool calls, strict structured synthesis and the independent output gate. Only gate-approved answer blocks are returned. Mode and owner are server-derived. In synthetic mode answers replay recorded synthetic fixtures (provenance synthetic_fixture); live mode without a Meta key returns 503 provider_unavailable. costEstimate is an estimate, not a billed amount. Supports Idempotency-Key.",
        body: turnBody,
        response: { 200: envelopeSchema(turnOut), 503: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const { ownerId, sessionId } = requireAuth(req);
      const key = parseIdempotencyKey(req.headers["idempotency-key"]);
      const body = req.body;
      const text = (body.text ?? body.confirmedTranscript)!;

      // Ownership of every referenced id is checked before any provider spend; other owners' ids are 404.
      let geographyIds: string[] = [];
      if (body.farmId) {
        const farm = await getFarm(pool, ownerId, body.farmId);
        if (!farm) throw notFound("Farm");
        const d = farm.location.districtId;
        const s = farm.location.stateCode;
        geographyIds = [d, s, s ? `IN-${s}` : null, "IN"].filter((x): x is string => !!x);
      }
      if (body.planId) {
        const p = await pool.query("SELECT 1 FROM plans WHERE id = $1 AND owner_id = $2", [body.planId, ownerId]);
        if (p.rowCount === 0) throw notFound("Plan");
      }

      const ac = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) ac.abort();
      });

      const out = await runIdempotent(pool, { ownerId, key, route: "POST /api/v1/assistant/turns", hashInput: body }, async () => {
        const result = await runAgentTurn(
          { pool, budget, provider: providerFor(config.RUNTIME_MODE), registry, limits, models: { text: config.META_TEXT_MODEL, escalation: config.META_ESCALATION_MODEL }, signal: ac.signal },
          { ownerId, sessionId, mode: config.RUNTIME_MODE, requestId: req.id, language: body.language, text, farmId: body.farmId, planId: body.planId, selectedDate: body.selectedDate, scenarioId: body.scenarioId, geographyIds },
        );
        if (result.status === "provider_unavailable") {
          return { status: 503, body: errorEnvelope(req.id, config.RUNTIME_MODE, { code: "provider_unavailable", message: "The AI provider is not available. Text exploration without AI remains available.", details: { traceId: result.runId } }) };
        }
        if (result.status === "budget_exceeded" && result.approved.answerBlocks.length === 0) throw new ApiError(429, "budget_exceeded", "The spending limit would be exceeded", { traceId: result.runId });
        const approvedText = result.approved.answerBlocks.length > 0 ? result.approved.answerBlocks.map((b) => b.text).join("\n\n") : null;
        const hash = approvedText ? await recordApprovedText(pool, ownerId, approvedText) : null;
        const warnings = result.provenance === "synthetic_fixture" ? ["Synthetic mode: answer replayed from a recorded synthetic fixture."] : [];
        return { status: 200, body: envelope(req.id, config.RUNTIME_MODE, toTurnOut(result, { text: approvedText, hash }), warnings) };
      });
      if (out.replay) reply.header("idempotent-replay", "true");
      return reply.code(out.status as 200).send(out.body as never);
    },
  );
}
