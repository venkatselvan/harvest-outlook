import { z } from "zod";

/**
 * Loop ceilings (BUILD_SPEC 9). Read from process-style env so no change to config.ts is required;
 * every value has a conservative default and is logged in the trace of each run.
 */
export interface AgentLimits {
  maxToolRounds: number;
  maxToolCalls: number;
  maxWonderEscalations: number;
  maxRepairAttempts: number;
  wonderEnabled: boolean;
  maxOutputTokens: number;
  interpretationMaxOutputTokens: number;
  /**
   * Sent as `reasoning.effort` on every Spark call. Default "low" when AGENT_REASONING_EFFORT is unset or invalid:
   * verified live 2026-10-30 that muse-spark-1.3 otherwise reasons at "high", and hidden reasoning tokens count
   * against max_output_tokens (a 200-token cap ended `incomplete` with only a reasoning item). At "low" the observed
   * reasoning use was 42-675 tokens per pass (docs/research/META_API_NOTES.md), inside the default caps below.
   * `undefined` is only reachable through an explicit override and means "omit the field" (server default "high").
   */
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "max" | undefined;
  /** Forecast horizon beyond which exact daily rain claims are blocked (days). */
  rainHorizonDays: number;
  turnsPerMinute: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolRounds: 6,
  maxToolCalls: 12,
  maxWonderEscalations: 1,
  maxRepairAttempts: 2,
  wonderEnabled: false,
  maxOutputTokens: 3000,
  interpretationMaxOutputTokens: 1200,
  reasoningEffort: "low",
  rainHorizonDays: 7,
  turnsPerMinute: 20,
};

const posInt = z.coerce.number().int().positive();
const nonNegInt = z.coerce.number().int().nonnegative();

export function loadAgentLimits(env: Record<string, string | undefined> = process.env, over: Partial<AgentLimits> = {}): AgentLimits {
  const pick = <T>(schema: z.ZodType<T>, key: string, def: T): T => {
    const raw = env[key];
    if (raw === undefined || raw === "") return def;
    const r = schema.safeParse(raw);
    return r.success ? r.data : def;
  };
  const effort = env.AGENT_REASONING_EFFORT;
  return {
    maxToolRounds: pick(posInt, "AGENT_MAX_TOOL_ROUNDS", DEFAULT_LIMITS.maxToolRounds),
    maxToolCalls: pick(posInt, "AGENT_MAX_TOOL_CALLS", DEFAULT_LIMITS.maxToolCalls),
    // The contract allows at most one Wonder escalation; a larger configured value is clamped.
    maxWonderEscalations: Math.min(1, pick(nonNegInt, "AGENT_MAX_WONDER_ESCALATIONS", DEFAULT_LIMITS.maxWonderEscalations)),
    maxRepairAttempts: pick(nonNegInt, "AGENT_MAX_REPAIR_ATTEMPTS", DEFAULT_LIMITS.maxRepairAttempts),
    wonderEnabled: env.AGENT_WONDER_ENABLED === "true",
    maxOutputTokens: pick(posInt, "AGENT_MAX_OUTPUT_TOKENS", DEFAULT_LIMITS.maxOutputTokens),
    interpretationMaxOutputTokens: pick(posInt, "AGENT_INTERPRETATION_MAX_OUTPUT_TOKENS", DEFAULT_LIMITS.interpretationMaxOutputTokens),
    reasoningEffort: effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "max" ? effort : DEFAULT_LIMITS.reasoningEffort,
    rainHorizonDays: pick(posInt, "AGENT_RAIN_HORIZON_DAYS", DEFAULT_LIMITS.rainHorizonDays),
    turnsPerMinute: pick(posInt, "ASSISTANT_TURNS_PER_MINUTE", DEFAULT_LIMITS.turnsPerMinute),
    ...over,
  };
}
