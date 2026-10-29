import { z } from "zod";
import { ToolSchemas, type Mode, type ToolInput, type ToolName, type ToolOutput } from "@harvest/contracts";
import type { Pool } from "../../db/pool";
import { restoreOptionals, toRawJsonSchema, toStrictJsonSchema, type JsonSchema } from "../../providers/meta/strict-schema";
import type { FunctionToolDef } from "../../providers/meta/types";

/**
 * Server-derived execution context. Tool inputs never carry ownerId or mode (the contracts reject
 * them); handlers receive them here and must authorize every owned id they touch.
 */
export interface ToolContext {
  ownerId: string;
  mode: Mode;
  requestId: string;
  pool: Pool;
  agentRunId: string;
  /** Replay cutoff / "now" for availability checks (ISO datetime). */
  asOf: string;
  signal?: AbortSignal | undefined;
}

/**
 * Binding interface for the tools implemented by later tasks (T06b screen_crops/get_market_outlook/
 * calculate_scenarios, T08 plans, T10 observation/segmentation, T11 keyframes, T13 water). A handler
 * returns a value that must satisfy the tool's contract output schema; it is validated again before
 * storage. Throwing, or returning invalid output, yields a stored `error` result the model can see.
 */
export type ToolHandler<N extends ToolName> = (input: ToolInput<N>, ctx: ToolContext) => Promise<ToolOutput<N>>;
export type ToolBindings = { [N in ToolName]?: ToolHandler<N> };

export interface ToolDefinition<N extends ToolName = ToolName> {
  name: N;
  description: string;
  inputSchema: (typeof ToolSchemas)[N]["input"];
  outputSchema: (typeof ToolSchemas)[N]["output"];
  modes: Mode[];
  /** True when the tool reads live/current user or provider data; such tools are excluded in replay. */
  readsCurrentData: boolean;
  /** False for placeholders: not advertised to the model and answer `unavailable/tool_not_bound` if called. */
  bound: boolean;
  handler: ToolHandler<N>;
}

export type ToolOutcome =
  | { status: "ok"; output: unknown }
  | { status: "unavailable"; reason: string }
  | { status: "error"; code: string; message: string };

const ALL: Mode[] = ["live", "replay", "synthetic"];
const NOT_REPLAY: Mode[] = ["live", "synthetic"];

const META: Record<ToolName, { description: string; modes: Mode[]; readsCurrentData: boolean }> = {
  resolve_crop_identity: { description: "Resolve a crop name or alias (any language) to catalogue crop and product candidates. Never forces a match; report ambiguity to the farmer.", modes: ALL, readsCurrentData: false },
  get_farm_context: { description: "Read the requester's own farm profile (district-level location, area, soil, water, budget) with per-fact provenance.", modes: ALL, readsCurrentData: false },
  retrieve_evidence: { description: "Retrieve validated source passages with evidence ids, filtered by crop, region and topic. Cite only ids returned here.", modes: ALL, readsCurrentData: false },
  screen_crops: { description: "Screen crops against a validated farm context: eligibility, unknowns, reasons and coverage.", modes: ALL, readsCurrentData: false },
  get_market_outlook: { description: "Qualified market baseline/forecast artifacts for a product and harvest windows, or an explicit missing state.", modes: ALL, readsCurrentData: false },
  calculate_scenarios: { description: "Compute season economics and sensitivity for a plan or context with typed overrides. All arithmetic is done by code.", modes: ALL, readsCurrentData: false },
  calculate_water_balance: { description: "Compute a water balance scenario from stored weather, soil and stage references.", modes: ALL, readsCurrentData: false },
  interpret_observation: { description: "Propose observations from owned photos with uncertainty; proposals need farmer confirmation.", modes: NOT_REPLAY, readsCurrentData: true },
  propose_plan_revision: { description: "Validate typed plan changes and return a diff; nothing is committed without the farmer's explicit confirmation.", modes: ALL, readsCurrentData: false },
  request_segmentation: { description: "Request a segmentation job for an owned photo (budget gated, manual fallback always available).", modes: NOT_REPLAY, readsCurrentData: true },
  request_visual_keyframes: { description: "Request illustrative growth keyframes for a confirmed plan (deduplicated job).", modes: NOT_REPLAY, readsCurrentData: true },
  get_job_status: { description: "Read the sanitized status of an owned job.", modes: NOT_REPLAY, readsCurrentData: true },
};

export const UNBOUND_REASON = "tool_not_bound";

/**
 * Agent-local output schemas that extend a contract output (not yet promoted into @harvest/contracts).
 * retrieve_evidence passages carry `validationStatus` (validated | grounded), decision D28.
 */
const passage = ToolSchemas.retrieve_evidence.output.shape.passages.element;
export const OUTPUT_OVERRIDES: Partial<Record<ToolName, z.ZodType>> = {
  retrieve_evidence: z.object({ passages: z.array(passage.extend({ validationStatus: z.enum(["validated", "grounded"]) }).strict()) }).strict(),
};

export class ToolRegistry {
  private readonly defs = new Map<ToolName, ToolDefinition>();
  constructor(bindings: ToolBindings) {
    for (const name of Object.keys(ToolSchemas) as ToolName[]) {
      const bound = bindings[name] as ToolHandler<ToolName> | undefined;
      const m = META[name];
      const def: ToolDefinition = {
        name,
        description: m.description,
        inputSchema: ToolSchemas[name].input,
        outputSchema: (OUTPUT_OVERRIDES[name] ?? ToolSchemas[name].output) as (typeof ToolSchemas)[ToolName]["output"],
        modes: m.modes,
        readsCurrentData: m.readsCurrentData,
        bound: bound !== undefined,
        handler: (bound ?? (async () => ({ status: "unavailable", reason: UNBOUND_REASON }))) as ToolHandler<ToolName>,
      };
      this.defs.set(name, def);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name as ToolName);
  }

  all(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  /** The per-mode allowlist. Replay never includes tools that read current data. */
  allowedFor(mode: Mode): ToolDefinition[] {
    return this.all().filter((d) => d.modes.includes(mode) && !(mode === "replay" && d.readsCurrentData));
  }

  isAllowed(name: string, mode: Mode): boolean {
    const d = this.get(name);
    return !!d && this.allowedFor(mode).some((a) => a.name === d.name);
  }

  /** Flat function tools advertised to the model: allowlisted and actually bound. */
  advertisedFor(mode: Mode): FunctionToolDef[] {
    return this.allowedFor(mode)
      .filter((d) => d.bound)
      .map((d) => ({ type: "function", name: d.name, description: d.description, parameters: toStrictJsonSchema(d.inputSchema as z.ZodType), strict: true }));
  }

  /** Parse and validate model-supplied arguments. Strict schemas reject ownerId/mode and any unknown field. */
  parseArguments(name: ToolName, rawArguments: string): { ok: true; input: unknown } | { ok: false; message: string } {
    const def = this.get(name);
    if (!def) return { ok: false, message: "unknown tool" };
    let json: unknown;
    try {
      json = JSON.parse(rawArguments || "{}");
    } catch {
      return { ok: false, message: "arguments are not valid JSON" };
    }
    const restored = restoreOptionals(toRawJsonSchema(def.inputSchema as z.ZodType) as JsonSchema, json);
    const r = (def.inputSchema as z.ZodType).safeParse(restored);
    if (!r.success) return { ok: false, message: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
    return { ok: true, input: r.data };
  }

  /** Runs the handler and validates its output against the contract; never throws. */
  async execute(def: ToolDefinition, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    try {
      const out = await (def.handler as (i: unknown, c: ToolContext) => Promise<unknown>)(input, ctx);
      if (typeof out === "object" && out !== null && (out as { status?: unknown }).status === "unavailable" && typeof (out as { reason?: unknown }).reason === "string") {
        return { status: "unavailable", reason: (out as { reason: string }).reason };
      }
      const parsed = (def.outputSchema as z.ZodType).safeParse(out);
      if (!parsed.success) return { status: "error", code: "invalid_tool_output", message: "Tool output failed contract validation" };
      return { status: "ok", output: parsed.data };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const sc = (e as { statusCode?: unknown }).statusCode;
      const clientError = e instanceof Error && typeof sc === "number" && sc < 500;
      return { status: "error", code: typeof code === "string" && /^[a-z_]{3,40}$/.test(code) ? code : "tool_failed", message: clientError ? (e as Error).message.slice(0, 200) : "Tool execution failed" };
    }
  }
}
