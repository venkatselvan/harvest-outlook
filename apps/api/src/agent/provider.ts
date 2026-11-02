import type { Mode } from "@harvest/contracts";
import { MetaClient, redactSecrets } from "../providers/meta/client";
import { MetaError, type CreateResponseParams, type FunctionToolDef, type InputItem, type ParsedFunctionCall, type ParsedUsage, type ReasoningEffort } from "../providers/meta/types";
import type { JsonSchema } from "../providers/meta/strict-schema";

export type Provenance = "meta_live" | "synthetic_fixture";
export type AgentPass = "interpretation" | "tool_round" | "synthesis" | "repair" | "escalation";

export interface TextRequest {
  pass: AgentPass;
  model: string;
  instructions: string;
  input: string | InputItem[];
  tools?: FunctionToolDef[];
  textFormat?: { name: string; schema: JsonSchema };
  previousResponseId?: string;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort | undefined;
  /** L5: `false` for single, never-chained calls (provider keeps nothing). Omitted = provider default (stored). */
  store?: boolean | undefined;
  /** Tool result ids stored so far in this run, in order; fixtures use them to fill `{{toolResultId:N}}` placeholders. */
  toolResultIds?: string[];
  signal?: AbortSignal | undefined;
}

export interface TextResult {
  provenance: Provenance;
  responseId: string | null;
  requestId: string | null;
  model: string;
  outputText: string | null;
  functionCalls: ParsedFunctionCall[];
  usage: ParsedUsage;
  latencyMs: number;
  retries: number;
}

export type ProviderErrorCode = "provider_unavailable" | "provider_error" | "timeout" | "aborted" | "rate_limited" | "bad_request" | "fixture_error";
export interface ProviderFailure {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  /** Provider may have billed the request (timeout/abort in flight). */
  outcomeUncertain: boolean;
  requestId: string | null;
  retries: number;
  /** 2026-11-02: the provider's incomplete_details.reason when a response ended `incomplete` (e.g. max_output_tokens). */
  incompleteReason?: string | null | undefined;
}
export type ProviderOutcome = { ok: true; result: TextResult } | { ok: false; error: ProviderFailure };

export interface TextModelProvider {
  readonly kind: "meta" | "fixture";
  readonly provenance: Provenance;
  /** Fixture replays are free and skip budget reservation. */
  readonly billable: boolean;
  call(req: TextRequest): Promise<ProviderOutcome>;
  /**
   * L5 privacy: delete a stored provider response after the run. Optional (fixtures and the unavailable provider
   * store nothing). Must never throw.
   */
  deleteResponse?(id: string): Promise<{ ok: boolean; code: string | null }>;
}

export class MetaProvider implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly billable = true;
  constructor(
    private readonly client: MetaClient,
    private readonly apiKey?: string,
  ) {}

  async call(req: TextRequest): Promise<ProviderOutcome> {
    const params: CreateResponseParams = {
      model: req.model,
      instructions: req.instructions,
      input: req.input,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.textFormat ? { textFormat: req.textFormat } : {}),
      ...(req.previousResponseId ? { previousResponseId: req.previousResponseId } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.store !== undefined ? { store: req.store } : {}),
    };
    try {
      const r = await this.client.createResponse(params, req.signal);
      return { ok: true, result: { provenance: "meta_live", responseId: r.responseId, requestId: r.requestId, model: r.model, outputText: r.outputText, functionCalls: r.functionCalls, usage: r.usage, latencyMs: r.latencyMs, retries: r.retries } };
    } catch (e) {
      if (e instanceof MetaError) {
        const code: ProviderErrorCode =
          e.kind === "provider_unavailable" || e.kind === "unauthorized" ? "provider_unavailable" : e.kind === "timeout" ? "timeout" : e.kind === "aborted" ? "aborted" : e.kind === "rate_limited" ? "rate_limited" : e.kind === "bad_request" ? "bad_request" : "provider_error";
        return { ok: false, error: { code, message: redactSecrets(e.message, this.apiKey), retryable: e.retryable, outcomeUncertain: e.outcomeUncertain, requestId: e.requestId, retries: e.retries, incompleteReason: e.info.incompleteReason ?? null } };
      }
      return { ok: false, error: { code: "provider_error", message: redactSecrets(String((e as Error).message ?? e).slice(0, 200), this.apiKey), retryable: false, outcomeUncertain: true, requestId: null, retries: 0 } };
    }
  }

  async deleteResponse(id: string): Promise<{ ok: boolean; code: string | null }> {
    try {
      const r = await this.client.deleteResponse(id);
      return { ok: r.ok, code: r.code };
    } catch {
      return { ok: false, code: "delete_failed" };
    }
  }
}

/** Returned when live/replay mode has no key: no fake answers are ever produced. */
export class UnavailableProvider implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly billable = false;
  constructor(private readonly reason: string) {}
  async call(): Promise<ProviderOutcome> {
    return { ok: false, error: { code: "provider_unavailable", message: this.reason, retryable: false, outcomeUncertain: false, requestId: null, retries: 0 } };
  }
}

export interface ProviderSelection {
  mode: Mode;
  apiKey: string | undefined;
  baseUrl: string;
  fixture: () => TextModelProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Server-derived selection: synthetic mode always replays fixtures; live/replay without a key is unavailable. */
export function selectProvider(s: ProviderSelection): TextModelProvider {
  if (s.mode === "synthetic") return s.fixture();
  if (!s.apiKey) return new UnavailableProvider("Meta model provider is not configured (MODEL_API_KEY missing)");
  const client = new MetaClient({ apiKey: s.apiKey, baseUrl: s.baseUrl, ...(s.fetchImpl ? { fetchImpl: s.fetchImpl } : {}), ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) });
  return new MetaProvider(client, s.apiKey);
}
