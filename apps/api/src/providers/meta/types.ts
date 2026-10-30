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

export interface CreateResponseParams {
  model: string;
  instructions: string;
  input: string | InputItem[];
  tools?: FunctionToolDef[];
  textFormat?: { name: string; schema: JsonSchema };
  previousResponseId?: string;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
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
