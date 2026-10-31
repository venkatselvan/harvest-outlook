import { setTimeout as sleepTimer } from "node:timers/promises";
import sharp from "sharp";
import {trackMetaInvocation} from '../../services/model-activity';
import { MetaError, type CreateResponseParams, type InputItem, type MetaResponse, type ParsedFunctionCall, type ParsedUsage, type UrlCitation, type WebSearchCall } from "./types";

export const MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUS = (s: number) => s === 429 || (s >= 500 && s <= 599);

export interface MetaClientOptions {
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs?: number;
  /** Capped at 2 regardless of the value passed. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function redactSecrets(text: string, apiKey?: string): string {
  let out = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [redacted]").replace(/authorization["']?\s*[:=]\s*["']?[^"',}\s]+/gi, "authorization: [redacted]");
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join("[redacted]");
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Defensive: unknown/missing usage fields parse to 0 rather than failing the call. */
export function parseUsage(u: unknown): ParsedUsage {
  const o = obj(u);
  const details = obj(o.input_tokens_details ?? o.prompt_tokens_details);
  return {
    inputTokens: num(o.input_tokens ?? o.prompt_tokens),
    outputTokens: num(o.output_tokens ?? o.completion_tokens),
    cachedInputTokens: num(details.cached_tokens ?? o.cached_input_tokens),
    // Verified live 2026-10-30: `output_tokens_details.reasoning_tokens` is included in `output_tokens`.
    reasoningTokens: num(obj(o.output_tokens_details ?? o.completion_tokens_details).reasoning_tokens),
  };
}

export interface ParsedOutput {
  outputText: string | null;
  functionCalls: ParsedFunctionCall[];
  refusal: string | null;
  citations: UrlCitation[];
  webSearchCalls: WebSearchCall[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Documented shape (dev.meta.ai/docs/search-grounding, Responses schemas): action.queries[], action.sources[{url}], results[{url,title}]. */
function parseWebSearchCall(item: Record<string, unknown>): WebSearchCall {
  const action = obj(item.action);
  const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === "string") : str(action.query) ? [action.query as string] : [];
  const sourceUrls = (Array.isArray(action.sources) ? action.sources : []).map((x) => str(obj(x).url)).filter((u): u is string => u !== null);
  const results = (Array.isArray(item.results) ? item.results : []).flatMap((x) => {
    const r = obj(x);
    const url = str(r.url);
    return url ? [{ url, title: str(r.title) }] : [];
  });
  return { id: str(item.id), status: str(item.status), queries, sourceUrls, results };
}

/**
 * Reads `message` (output_text) and `function_call` items; ignores reasoning and unknown item types.
 *
 * Verified live 2026-10-30 (muse-spark-1.3): `output` starts with a `reasoning` item (empty summary), then
 * `message` items whose `content[]` holds `{type: "output_text", text}`. When tools are offered, the model may
 * emit a preamble `message` with `phase: "commentary"` before its `function_call` items; that preamble is not
 * the answer (and would corrupt a JSON payload if concatenated), so commentary text is used only when the
 * response has no other message text and no function calls. Function calls whose item status is
 * `incomplete` (truncated arguments) are dropped. `refusal` content parts are surfaced separately.
 */
export function parseOutputItems(body: Record<string, unknown>): ParsedOutput {
  const texts: string[] = [];
  const commentary: string[] = [];
  const refusals: string[] = [];
  const functionCalls: ParsedFunctionCall[] = [];
  const citations: UrlCitation[] = [];
  const webSearchCalls: WebSearchCall[] = [];
  const output = Array.isArray(body.output) ? body.output : [];
  for (const raw of output) {
    const item = obj(raw);
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const sink = item.phase === "commentary" ? commentary : texts;
      for (const c of content) {
        const part = obj(c);
        if (part.type === "output_text" && typeof part.text === "string") {
          sink.push(part.text);
          for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
            const ann = obj(a);
            const url = str(ann.url);
            if (ann.type === "url_citation" && url) citations.push({ url, title: str(ann.title) });
          }
        } else if (part.type === "refusal" && typeof part.refusal === "string") refusals.push(part.refusal);
      }
    } else if (item.type === "web_search_call") {
      webSearchCalls.push(parseWebSearchCall(item));
    } else if (item.type === "function_call") {
      if (item.status === "incomplete") continue;
      const name = item.name;
      const callId = item.call_id ?? item.id;
      if (typeof name === "string" && typeof callId === "string" && callId.length >= 1 && callId.length <= 64) {
        functionCalls.push({ name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}), callId });
      }
    }
  }
  let outputText: string | null = texts.length > 0 ? texts.join("") : null;
  if (outputText === null && functionCalls.length === 0 && commentary.length > 0) outputText = commentary.join("");
  if (outputText === null && typeof body.output_text === "string") outputText = body.output_text;
  return { outputText, functionCalls, refusal: refusals.length > 0 ? refusals.join(" ").slice(0, 500) : null, citations, webSearchCalls };
}

export class MetaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: MetaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms, signal) => sleepTimer(ms, undefined, signal ? { signal } : {}).then(() => undefined));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.min(MAX_RETRIES, Math.max(0, opts.maxRetries ?? MAX_RETRIES));
  }

  get configured(): boolean {
    return !!this.opts.apiKey;
  }

  /**
   * Builds the request body. `tools` may only hold flat function tools. Built-in web search (search grounding) is
   * added solely from the explicit `webSearch` option, in the documented `{type:"web_search", search_context_size,
   * user_location}` shape; `tool_choice`/`parallel_tool_calls` are sent only with function tools (the documented
   * web-search request carries neither).
   */
  buildBody(p: CreateResponseParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: p.model,
      instructions: p.instructions,
      input: p.input,
      max_output_tokens: p.maxOutputTokens,
    };
    const tools: unknown[] = [];
    if (p.tools && p.tools.length > 0) {
      for (const t of p.tools) {
        if (t.type !== "function") throw new MetaError("bad_request", "Only function tools may be sent in tools (search grounding is enabled only through the explicit webSearch option)");
      }
      tools.push(...p.tools);
      body.tool_choice = "auto"; // the only accepted value; anything else is a 400
      body.parallel_tool_calls = false;
    }
    if (p.webSearch) {
      const loc = p.webSearch.userLocation;
      tools.push({
        type: "web_search",
        ...(p.webSearch.searchContextSize ? { search_context_size: p.webSearch.searchContextSize } : {}),
        ...(loc ? { user_location: { type: "approximate", ...Object.fromEntries(Object.entries(loc).filter(([, v]) => typeof v === "string" && v.length > 0)) } } : {}),
      });
    }
    if (tools.length > 0) body.tools = tools;
    if (p.include && p.include.length > 0) {
      if (p.include.some((i) => i !== "web_search_call.results")) throw new MetaError("bad_request", "Only include web_search_call.results is supported");
      body.include = p.include;
    }
    if (p.textFormat) body.text = { format: { type: "json_schema", name: p.textFormat.name, strict: true, schema: p.textFormat.schema } };
    if (p.previousResponseId) body.previous_response_id = p.previousResponseId;
    if (p.reasoningEffort) body.reasoning = { effort: p.reasoningEffort };
    if (p.store !== undefined) body.store = p.store;
    return body;
  }

  async createResponse(p: CreateResponseParams, signal?: AbortSignal): Promise<MetaResponse> {
    if(!this.opts.apiKey)throw new MetaError('provider_unavailable','MODEL_API_KEY is not configured');
    return trackMetaInvocation(p.model,()=>this.createResponseTransport(p,signal),result=>result.model);
  }

  private async createResponseTransport(p: CreateResponseParams, signal?: AbortSignal): Promise<MetaResponse> {
    const key = this.opts.apiKey;
    if (!key) throw new MetaError("provider_unavailable", "MODEL_API_KEY is not configured");
    const body = JSON.stringify(this.buildBody(p));
    const started = Date.now();
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new MetaError("aborted", "Request cancelled", { retries });
      let res: Response;
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body,
          signal: combined,
        });
      } catch (e) {
        if (signal?.aborted) throw new MetaError("aborted", "Request cancelled", { retries, outcomeUncertain: true });
        const timedOut = timeoutSignal.aborted || (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
        if (attempt < this.maxRetries && !timedOut) {
          retries++;
          await this.backoff(attempt, null, signal);
          continue;
        }
        if (timedOut) throw new MetaError("timeout", `Provider call timed out after ${this.timeoutMs} ms`, { retries, outcomeUncertain: true });
        throw new MetaError("network", `Network error calling provider: ${redactSecrets(String((e as Error).message ?? e).slice(0, 200), key)}`, { retries });
      }
      const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id");
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new MetaError("invalid_response", "Provider returned a non-JSON body", { status: res.status, requestId, retries, outcomeUncertain: true });
        }
        return this.toResponse(json, requestId, Date.now() - started, retries);
      }
      const detail = await this.safeErrorDetail(res, key);
      if (RETRYABLE_STATUS(res.status) && attempt < this.maxRetries) {
        retries++;
        await this.backoff(attempt, res.headers.get("retry-after"), signal);
        continue;
      }
      const kind = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 429 ? "rate_limited" : res.status >= 500 ? "server_error" : "bad_request";
      throw new MetaError(kind, `Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status, requestId, retries });
    }
  }

  /**
   * L5 privacy: delete a stored response (`DELETE /v1/responses/{id}`, verified live 2026-10-30: 200
   * `{object:"response.deleted", deleted:true}`, later GET 404). Never retried, never throws: returns the outcome
   * so the caller can log it. 404 counts as already gone.
   */
  async deleteResponse(id: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number | null; code: string | null }> {
    const key = this.opts.apiKey;
    if (!key) return { ok: false, status: null, code: "provider_unavailable" };
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) return { ok: false, status: null, code: "invalid_id" };
    const timeoutSignal = AbortSignal.timeout(Math.min(this.timeoutMs, 10_000));
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/responses/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${key}` },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { ok: true, status: res.status, code: null };
      return { ok: res.status === 404, status: res.status, code: res.status === 404 ? "already_absent" : `http_${res.status}` };
    } catch (e) {
      return { ok: false, status: null, code: timeoutSignal.aborted ? "timeout" : (e as Error).name === "AbortError" ? "aborted" : "network" };
    }
  }

  private toResponse(json: unknown, requestId: string | null, latencyMs: number, retries: number): MetaResponse {
    const body = obj(json);
    if (Object.keys(body).length === 0) throw new MetaError("invalid_response", "Provider returned an empty or non-object body", { requestId, retries, outcomeUncertain: true });
    const parsed = parseOutputItems(body);
    const incomplete = obj(body.incomplete_details);
    const usage = parseUsage(body.usage);
    const status = typeof body.status === "string" ? body.status : null;
    const incompleteReason = typeof incomplete.reason === "string" ? incomplete.reason : null;
    if (status === "incomplete") {
      // Verified live 2026-10-30: with the server-default reasoning effort ("high") a small max_output_tokens is
      // spent entirely on hidden reasoning and the response ends `incomplete` / `max_output_tokens` with only a
      // reasoning item. Tokens were billed, so the error is marked outcome-uncertain (callers keep the reservation).
      throw new MetaError("incomplete", `Provider response incomplete: ${incompleteReason ?? "unknown reason"} (output tokens ${usage.outputTokens}, reasoning tokens ${usage.reasoningTokens ?? 0})`, { requestId, retries, outcomeUncertain: true, usage, incompleteReason });
    }
    if (status === "failed") {
      const err = obj(body.error);
      const msg = [err.code, err.message].filter((x): x is string => typeof x === "string").join(" / ").slice(0, 200);
      throw new MetaError("server_error", `Provider response failed${msg ? `: ${msg}` : ""}`, { requestId, retries, outcomeUncertain: true, usage });
    }
    return {
      responseId: typeof body.id === "string" ? body.id : null,
      requestId,
      model: typeof body.model === "string" ? body.model : "unknown",
      status,
      outputText: parsed.outputText,
      functionCalls: parsed.functionCalls,
      refusal: parsed.refusal,
      usage,
      latencyMs,
      retries,
      incompleteReason,
      citations: parsed.citations,
      webSearchCalls: parsed.webSearchCalls,
    };
  }

  /** Only the provider's short error code/type/message, redacted and truncated; never headers or the request. */
  private async safeErrorDetail(res: Response, key: string): Promise<string> {
    try {
      const text = await res.text();
      let msg = text;
      try {
        const e = obj(obj(JSON.parse(text)).error);
        msg = [e.code, e.type, e.message].filter((x): x is string => typeof x === "string").join(" / ");
      } catch {
        /* not JSON; use raw text */
      }
      return redactSecrets(msg, key).replace(/\s+/g, " ").slice(0, 200);
    } catch {
      return "";
    }
  }

  private async backoff(attempt: number, retryAfter: string | null, signal?: AbortSignal): Promise<void> {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    const base = Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 5000) : Math.min(250 * 2 ** attempt, 2000) + Math.floor(Math.random() * 100);
    try {
      await this.sleep(base, signal);
    } catch {
      throw new MetaError("aborted", "Request cancelled during backoff", { retries: attempt + 1 });
    }
  }
}

/**
 * Builds a user message carrying a private image as a base64 data URL, downscaled so the longest
 * side is at most `maxSide` (default 1280). EXIF and location metadata are dropped by re-encoding.
 */
export async function imageInputPart(buf: Uint8Array, maxSide = 1280): Promise<{ type: "input_image"; image_url: string }> {
  const out = await sharp(buf).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { type: "input_image", image_url: `data:image/jpeg;base64,${out.toString("base64")}` };
}

export async function imageUserMessage(text: string, buf: Uint8Array, maxSide = 1280): Promise<InputItem> {
  return { role: "user", content: [{ type: "input_text", text }, await imageInputPart(buf, maxSide)] };
}
