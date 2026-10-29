import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseOutputItems, parseUsage } from "../providers/meta/client";
import type { AgentPass, ProviderOutcome, TextModelProvider, TextRequest } from "./provider";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(here, "../../test/fixtures/meta");

const ScenarioFile = z.object({
  synthetic: z.literal(true),
  scenario: z.string().min(1),
  description: z.string(),
  steps: z
    .array(
      z.object({
        /** When present the loop pass must match; catches loop-order drift. */
        pass: z.enum(["interpretation", "tool_round", "synthesis", "repair", "escalation"]).optional(),
        /** A documented Responses API response body (recorded shape, synthetic content). */
        response: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});
export type FixtureScenario = z.infer<typeof ScenarioFile>;

export function loadScenario(name: string, dir = FIXTURE_DIR): FixtureScenario {
  if (!/^[a-z0-9_]{1,60}$/.test(name)) throw new Error("invalid fixture scenario name");
  return ScenarioFile.parse(JSON.parse(readFileSync(resolve(dir, `${name}.json`), "utf8")));
}

/**
 * Replays recorded Responses API bodies in order. Every result is labelled `synthetic_fixture`.
 * `{{toolResultId:N}}` placeholders are replaced with the N-th stored tool result id of the run so
 * numeric references resolve against real stored rows.
 */
export class FixtureProvider implements TextModelProvider {
  readonly kind = "fixture" as const;
  readonly provenance = "synthetic_fixture" as const;
  readonly billable = false;
  private cursor = 0;
  readonly scenario: FixtureScenario;
  readonly seenPasses: AgentPass[] = [];

  constructor(scenario: string | FixtureScenario, dir?: string) {
    this.scenario = typeof scenario === "string" ? loadScenario(scenario, dir) : scenario;
  }

  async call(req: TextRequest): Promise<ProviderOutcome> {
    if (req.signal?.aborted) return fail("aborted", "Request cancelled");
    this.seenPasses.push(req.pass);
    const step = this.scenario.steps[this.cursor++];
    if (!step) return fail("fixture_error", `fixture '${this.scenario.scenario}' exhausted at call ${this.cursor}`);
    if (step.pass && step.pass !== req.pass) return fail("fixture_error", `fixture '${this.scenario.scenario}' step ${this.cursor} expects pass ${step.pass} but loop requested ${req.pass}`);
    const body = fill(step.response, req.toolResultIds ?? []) as Record<string, unknown>;
    const parsed = parseOutputItems(body);
    return {
      ok: true,
      result: {
        provenance: "synthetic_fixture",
        responseId: typeof body.id === "string" ? body.id : null,
        requestId: `fixture-${this.scenario.scenario}-${this.cursor}`,
        model: typeof body.model === "string" ? body.model : req.model,
        outputText: parsed.outputText,
        functionCalls: parsed.functionCalls,
        usage: parseUsage(body.usage),
        latencyMs: 0,
        retries: 0,
      },
    };
  }
}

const fail = (code: "aborted" | "fixture_error", message: string): ProviderOutcome => ({
  ok: false,
  error: { code, message, retryable: false, outcomeUncertain: false, requestId: null, retries: 0 },
});

function fill(v: unknown, ids: string[]): unknown {
  if (typeof v === "string") return v.replace(/\{\{toolResultId:(\d+)\}\}/g, (_m, n: string) => ids[Number(n)] ?? "missing-tool-result");
  if (Array.isArray(v)) return v.map((x) => fill(x, ids));
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]));
  return v;
}
