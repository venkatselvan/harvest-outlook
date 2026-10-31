import type { JsonSchema } from "./strict-schema";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";

export interface InputTextPart {
  type: "input_text";
  text: string;
}
export interface InputImagePart {
  type: "input_image";
  /** Always a data: URL built from a private media buffer. Never a public URL. */
  image_url: string;
}
export type InputItem =
  | { role: "user" | "assistant"; content: string | (InputTextPart | InputImagePart)[] }
  | { type: "function_call_output"; call_id: string; output: string };

/** Flat Responses function tool (not the nested Chat Completions shape). */
export interface FunctionToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
}

/**
 * Meta built-in web search (search grounding), documented at dev.meta.ai/docs/search-grounding (read 2026-11-01).
 * Sent only through the explicit `webSearch` field, never through `tools`, so no general caller can enable it by
 * passing a tool entry. Billed per search query on top of tokens.
 */
export interface WebSearchToolOptions {
  searchContextSize?: "low" | "medium" | "high";
  /** Coarse locale bias only (country/region/timezone). Never farm coordinates. */
  userLocation?: { country?: string; region?: string; city?: string; timezone?: string };
}

export interface CreateResponseParams {
  model: string;
  instructions: string;
  input: string | InputItem[];
  tools?: FunctionToolDef[];
  webSearch?: WebSearchToolOptions;
  /** Responses `include`; only the documented web-search result expansion is allowed. */
  include?: "web_search_call.results"[];
  textFormat?: { name: string; schema: JsonSchema };
  previousResponseId?: string;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * Sent as `store` when set. Verified live 2026-10-30: `store:false` is accepted but the response cannot then be
   * chained with previous_response_id (HTTP 400), so only single (unchained) calls may use it. Omitted = provider default (true).
   */
  store?: boolean;
}

export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Hidden reasoning tokens; already counted inside outputTokens (do not add twice). */
  reasoningTokens?: number;
}

export interface ParsedFunctionCall {
  name: string;
  /** Raw JSON string exactly as returned; not guaranteed schema-valid. */
  arguments: string;
  callId: string;
}

/** A `url_citation` annotation on an output_text part: the subset of retrieved sources the model cited. */
export interface UrlCitation {
  url: string;
  title: string | null;
}

/** A `web_search_call` output item. `results` is present only with `include: ["web_search_call.results"]`. */
export interface WebSearchCall {
  id: string | null;
  status: string | null;
  queries: string[];
  /** `action.sources[].url`. */
  sourceUrls: string[];
  results: { url: string; title: string | null }[];
}

export interface MetaResponse {
  /** Response id (`resp_...`); usable as previous_response_id. */
  responseId: string | null;
  /** Provider request id from response headers, when present. */
  requestId: string | null;
  model: string;
  status: string | null;
  /** Concatenated output_text of all assistant message items, or null when none. */
  outputText: string | null;
  functionCalls: ParsedFunctionCall[];
  /** Text of any `refusal` content part, or null. */
  refusal: string | null;
  usage: ParsedUsage;
  latencyMs: number;
  retries: number;
  incompleteReason: string | null;
  /** url_citation annotations across all answer message parts (empty when the model cited nothing). */
  citations?: UrlCitation[];
  /** web_search_call items; empty when no search ran (the model decides whether to search). */
  webSearchCalls?: WebSearchCall[];
}

export type MetaErrorKind = "provider_unavailable" | "unauthorized" | "bad_request" | "rate_limited" | "server_error" | "network" | "timeout" | "aborted" | "invalid_response" | "incomplete";

export class MetaError extends Error {
  constructor(
    public readonly kind: MetaErrorKind,
    message: string,
    public readonly info: { status?: number; requestId?: string | null; retries?: number; outcomeUncertain?: boolean; usage?: ParsedUsage; incompleteReason?: string | null } = {},
  ) {
    super(message);
    this.name = "MetaError";
  }
  get status(): number | undefined {
    return this.info.status;
  }
  get requestId(): string | null {
    return this.info.requestId ?? null;
  }
  get retries(): number {
    return this.info.retries ?? 0;
  }
  /** True when the provider may have processed (and billed) the request. */
  get outcomeUncertain(): boolean {
    return this.info.outcomeUncertain ?? false;
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server_error" || this.kind === "network" || this.kind === "timeout";
  }
}
