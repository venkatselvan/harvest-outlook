import { setTimeout as sleepTimer } from "node:timers/promises";
import {trackMetaInvocation} from '../services/model-activity';

/**
 * Minimal Muse Image reference-edit client (POST {base}/images/edits). Own fetch wrapper; independent of the
 * text client. Sends only documented fields: no mask, seed, input_fidelity or partial_images (HTTP 400 upstream).
 * The API key is never logged and never appears in error messages.
 *
 * UNVERIFIED against the live service: whether `image_url` accepts a base64 data URL (docs say "public URL or
 * base64 data URL"), the exact usage fields, and how strongly the edit preserves the scene.
 */

export type MuseImageErrorKind = "bad_request" | "auth" | "rate_limited" | "server" | "timeout" | "network" | "bad_response" | "filtered" | "aborted";

export class MuseImageError extends Error {
  constructor(
    public readonly kind: MuseImageErrorKind,
    message: string,
    public readonly opts: { status?: number; outcomeUnknown?: boolean; requestId?: string | null; retries?: number } = {},
  ) {
    super(message);
  }
  /** True when the provider may have processed (and billed) the request but we never saw the result. */
  get outcomeUnknown(): boolean {
    return this.opts.outcomeUnknown === true;
  }
}

export interface MuseImageParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** `data:image/jpeg;base64,...` of the clean, unannotated base image. */
  imageDataUrl: string;
  /** "WxH"; only the aspect ratio is honoured by the provider. */
  size: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface MuseImageResult {
  png: Buffer;
  requestId: string | null;
  retries: number;
  usage: unknown;
}

/** One retry, only for statuses where the provider did not process the request (429/503). */
export const MUSE_IMAGE_MAX_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

export function buildEditBody(p: Pick<MuseImageParams, "model" | "prompt" | "imageDataUrl" | "size">): Record<string, unknown> {
  return {
    model: p.model,
    prompt: p.prompt,
    images: [{ image_url: p.imageDataUrl }],
    n: 1,
    size: p.size,
    response_format: "b64_json",
    output_format: "png",
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  };
}

export async function editImage(p: MuseImageParams): Promise<MuseImageResult> {
  return trackMetaInvocation(p.model,()=>editImageTransport(p));
}
async function editImageTransport(p:MuseImageParams):Promise<MuseImageResult>{
  const fetchImpl = p.fetchImpl ?? fetch;
  const sleep = p.sleep ?? ((ms: number) => sleepTimer(ms).then(() => undefined));
  const url = `${p.baseUrl.replace(/\/+$/, "")}/images/edits`;
  const body = JSON.stringify(buildEditBody(p));
  for (let attempt = 0; ; attempt++) {
    if (p.signal?.aborted) throw new MuseImageError("aborted", "Request cancelled", { retries: attempt });
    const timeout = AbortSignal.timeout(p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = p.signal ? AbortSignal.any([p.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json", accept: "application/json" }, body, signal });
    } catch (e) {
      // The request may have reached the provider: never retry automatically.
      const name = (e as Error).name;
      if (p.signal?.aborted) throw new MuseImageError("aborted", "Request cancelled", { outcomeUnknown: true, retries: attempt });
      throw new MuseImageError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", `image edit request failed (${name})`, { outcomeUnknown: true, retries: attempt });
    }
    const requestId = res.headers.get("x-request-id");
    if (res.status === 429 || res.status === 503) {
      await res.arrayBuffer().catch(() => undefined);
      if (attempt < MUSE_IMAGE_MAX_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new MuseImageError(res.status === 429 ? "rate_limited" : "server", `image edit unavailable (HTTP ${res.status})`, { status: res.status, requestId, retries: attempt });
    }
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => undefined);
      throw new MuseImageError("auth", `image edit rejected credentials (HTTP ${res.status})`, { status: res.status, requestId, retries: attempt });
    }
    if (res.status >= 400 && res.status < 500) {
      await res.arrayBuffer().catch(() => undefined);
      throw new MuseImageError("bad_request", `image edit rejected the request (HTTP ${res.status})`, { status: res.status, requestId, retries: attempt });
    }
    if (res.status >= 500) {
      await res.arrayBuffer().catch(() => undefined);
      throw new MuseImageError("server", `image edit failed (HTTP ${res.status})`, { status: res.status, requestId, retries: attempt });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new MuseImageError("bad_response", "image edit returned an unreadable body", { status: res.status, outcomeUnknown: true, requestId, retries: attempt });
    }
    const o = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    const data = Array.isArray(o.data) ? o.data : [];
    const first = (typeof data[0] === "object" && data[0] !== null ? data[0] : {}) as Record<string, unknown>;
    const b64 = typeof first.b64_json === "string" ? first.b64_json : "";
    const rid = requestId ?? (typeof o.id === "string" ? o.id : typeof o.request_id === "string" ? o.request_id : null);
    if (!b64) throw new MuseImageError("filtered", "image edit returned no image (filtered or empty); not billed", { status: res.status, requestId: rid, retries: attempt });
    const png = Buffer.from(b64, "base64");
    if (png.length === 0) throw new MuseImageError("bad_response", "image edit returned an empty image", { status: res.status, outcomeUnknown: true, requestId: rid, retries: attempt });
    return { png, requestId: rid, retries: attempt, usage: o.usage ?? null };
  }
}
