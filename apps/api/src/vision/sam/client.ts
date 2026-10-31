import type { SamOptions } from "./options";
import {trackMetaInvocation} from '../../services/model-activity';

/** Provider-call failure. `outcomeUnknown` = the request may have been processed (timeout/connection loss). */
export class SamHttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
  ) {
    super(`SAM request failed: ${code}${status ? ` (HTTP ${status})` : ""}`);
  }
}

export interface SamCallInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Prompt text: a concept noun phrase or token prompt. */
  text: string;
  /** data:image/jpeg;base64,... */
  imageDataUrl: string;
  options: SamOptions;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface SamCallResult {
  text: string;
  providerRequestId: string | null;
  usage: unknown;
}

export function buildRequestBody(i: Pick<SamCallInput, "model" | "text" | "imageDataUrl" | "options">): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: i.model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: i.text },
          { type: "input_image", image_url: i.imageDataUrl },
        ],
      },
    ],
    stream: i.options.stream,
  };
  // Verified live 2026-10-30 (task L4, evals/results/live-smoke/sam-2026-10-30.json): both switches live inside
  // `metadata` as strings. Top-level `include_confidence` is a 400 ("unknown parameter"); the accepted
  // mask_encoding values are 'lossless' | 'one_bit' (`onebit` is a 400). Without mask_encoding the server returns
  // '~' lossless masks (~16 KB of text for two objects vs ~300 chars with one_bit).
  const metadata: Record<string, string> = {};
  if (i.options.maskEncoding) metadata.mask_encoding = i.options.maskEncoding === "onebit" ? "one_bit" : i.options.maskEncoding;
  if (i.options.includeConfidence) metadata.include_confidence = "true";
  if (Object.keys(metadata).length > 0) body.metadata = metadata;
  // Single-shot call: nothing chains from it, so the response is not stored provider-side (store:false verified
  // accepted on sam-3.1 2026-10-30).
  body.store = false;
  return body;
}

const safeCode = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : null);

/** Extracts text from a non-streaming Responses object (response JSON path UNVERIFIED; both common shapes handled). */
export function extractOutputText(json: unknown): string {
  const o = json as { output_text?: unknown; output?: unknown } | null;
  if (o && typeof o.output_text === "string") return o.output_text;
  let text = "";
  if (o && Array.isArray(o.output)) {
    for (const item of o.output as { content?: unknown }[]) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content as { type?: unknown; text?: unknown }[]) {
        if (part && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") text += part.text;
      }
    }
  }
  return text;
}

export async function readSse(body: ReadableStream<Uint8Array>): Promise<{ text: string; id: string | null; usage: unknown; doneText: string | null }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let id: string | null = null;
  let usage: unknown = null;
  let doneText: string | null = null;
  const handle = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let ev: { type?: string; delta?: unknown; text?: unknown; response?: { id?: unknown; usage?: unknown } & Record<string, unknown>; error?: { code?: unknown } };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
    else if (ev.type === "response.output_text.done" && typeof ev.text === "string") doneText = ev.text;
    else if (ev.type === "error" || ev.type === "response.failed") throw new SamHttpError(safeCode(ev.error?.code) ?? "provider_stream_error", 0, false, false);
    if (ev.response) {
      if (typeof ev.response.id === "string") id = ev.response.id;
      if (ev.response.usage) usage = ev.response.usage;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
    }
  }
  if (buf.trim()) handle(buf);
  return { text, id, usage, doneText };
}

/** Minimal fetch wrapper for POST {baseUrl}/responses. Never logs or returns the key or the image. */
export async function callSam(i: SamCallInput): Promise<SamCallResult> {
  return trackMetaInvocation(i.model,()=>callSamTransport(i));
}
async function callSamTransport(i:SamCallInput):Promise<SamCallResult>{
  const f = i.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), i.options.timeoutMs);
  const onAbort = () => ctl.abort();
  i.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await f(`${i.baseUrl.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${i.apiKey}`,
          "content-type": "application/json",
          accept: i.options.stream ? "text/event-stream, application/json" : "application/json",
        },
        body: JSON.stringify(buildRequestBody(i)),
        signal: ctl.signal,
      });
    } catch {
      throw new SamHttpError("provider_unreachable", 0, false, true);
    }
    const headerId = res.headers.get("x-request-id") ?? res.headers.get("request-id");
    if (!res.ok) {
      let code: string | null = null;
      try {
        const j = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
        code = safeCode(j.error?.code) ?? safeCode(j.error?.type);
      } catch {
        /* body is not JSON */
      }
      const retryable = res.status === 429 || res.status >= 500;
      throw new SamHttpError(code ?? `http_${res.status}`, res.status, retryable, false);
    }
    const ctype = res.headers.get("content-type") ?? "";
    try {
      if (i.options.stream && ctype.includes("text/event-stream") && res.body) {
        const s = await readSse(res.body);
        return { text: s.text || s.doneText || "", providerRequestId: headerId ?? s.id, usage: s.usage };
      }
      const json = (await res.json()) as { id?: unknown; usage?: unknown };
      return { text: extractOutputText(json), providerRequestId: headerId ?? (typeof json.id === "string" ? json.id : null), usage: json.usage ?? null };
    } catch (e) {
      if (e instanceof SamHttpError) throw e;
      throw new SamHttpError("provider_response_unreadable", res.status, false, true);
    }
  } finally {
    clearTimeout(timer);
    i.signal?.removeEventListener("abort", onAbort);
  }
}
