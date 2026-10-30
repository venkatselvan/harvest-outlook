import { getJson, type FetchLike } from "../../ingest/http";
import { redactSecrets, redactUrl } from "../../ingest/redact";
import { loadProviderConfig, type ProviderConfig } from "../config";

export const DATAGOVIN_PROVIDER = "data.gov.in";

export type MandiUnavailableReason =
  | "api_key_missing"
  | "auth_rejected"
  | "invalid_request"
  | "rate_limited"
  | "network_error"
  | "timeout"
  | "http_error"
  | "invalid_json"
  | "schema_mismatch";

export interface MandiFilters {
  state?: string | undefined;
  district?: string | undefined;
  market?: string | undefined;
  commodity?: string | undefined;
}

export interface MandiRequest {
  resourceId: string;
  filters?: MandiFilters;
  /**
   * Exact-case filter names for resources whose fields are Capitalised (the variety-wise resource uses
   * filters[State], filters[Commodity], filters[Arrival_Date] ...). Merged after `filters`.
   */
  rawFilters?: Record<string, string>;
  /** Page size, 1..1000. */
  limit?: number;
  offset?: number;
  /** Hard cap on records read across pages (also capped by config). */
  maxRecords?: number;
  maxPages?: number;
}

export interface MandiPageInfo {
  page: number;
  count: number;
  total: number | null;
}

export type MandiResult =
  | {
      status: "ok" | "cancelled";
      records: Array<Record<string, unknown>>;
      fields: Array<{ id: string; name?: string; type?: string }>;
      total: number | null;
      pages: number;
      /** True when the hard cap stopped paging before `total` was reached. */
      truncated: boolean;
      fetchedAt: string;
      /** Request URL with the key redacted. */
      requestUrl: string;
      updatedDate: string | null;
    }
  | { status: "unavailable"; reason: MandiUnavailableReason; detail: string };

export interface MandiDeps {
  config?: ProviderConfig | undefined;
  fetchImpl?: FetchLike | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Checked before every page; true stops paging and returns status "cancelled" with what was read. */
  shouldCancel?: (() => boolean | Promise<boolean>) | undefined;
  onPage?: ((info: MandiPageInfo) => void | Promise<void>) | undefined;
}

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildMandiUrl(base: string, apiKey: string, req: MandiRequest, offset: number, limit: number): string {
  const p = new URLSearchParams({ "api-key": apiKey, format: "json", limit: String(limit), offset: String(offset) });
  for (const [k, v] of Object.entries(req.filters ?? {})) if (v) p.set(`filters[${k}]`, v);
  for (const [k, v] of Object.entries(req.rawFilters ?? {})) if (v) p.set(`filters[${k}]`, v);
  return `${base.replace(/\/$/, "")}/resource/${req.resourceId}?${p}`;
}

/**
 * Fetch mandi price records. With no key configured this returns `api_key_missing` and performs NO network
 * request. The key is only placed in the request URL and is redacted from every returned string.
 */
export async function fetchMandiPrices(req: MandiRequest, deps: MandiDeps = {}): Promise<MandiResult> {
  const config = deps.config ?? loadProviderConfig();
  const key = config.DATA_GOV_IN_API_KEY;
  if (!key) return { status: "unavailable", reason: "api_key_missing", detail: "DATA_GOV_IN_API_KEY is not configured; mandi prices are unavailable" };
  if (!RESOURCE_ID.test(req.resourceId)) return { status: "unavailable", reason: "invalid_request", detail: "resourceId must be a UUID" };
  const limit = Math.max(1, Math.min(1000, Math.floor(req.limit ?? 500)));
  const maxRecords = Math.max(1, Math.min(config.DATA_GOV_IN_MAX_RECORDS, Math.floor(req.maxRecords ?? config.DATA_GOV_IN_MAX_RECORDS)));
  const maxPages = Math.max(1, Math.min(config.DATA_GOV_IN_MAX_PAGES, Math.floor(req.maxPages ?? config.DATA_GOV_IN_MAX_PAGES)));
  const now = deps.now ?? (() => new Date());

  const records: Array<Record<string, unknown>> = [];
  let fields: Array<{ id: string; name?: string; type?: string }> = [];
  let total: number | null = null;
  let updatedDate: string | null = null;
  let offset = req.offset ?? 0;
  let pages = 0;
  let cancelled = false;
  let exhausted = false;
  let lastUrl = redactUrl(buildMandiUrl(config.DATA_GOV_IN_BASE_URL, key, req, offset, limit));

  while (pages < maxPages && records.length < maxRecords) {
    if (deps.shouldCancel && (await deps.shouldCancel())) {
      cancelled = true;
      break;
    }
    const pageLimit = Math.min(limit, maxRecords - records.length);
    const url = buildMandiUrl(config.DATA_GOV_IN_BASE_URL, key, req, offset, pageLimit);
    lastUrl = redactUrl(url);
    const res = await getJson(url, { fetchImpl: deps.fetchImpl, timeoutMs: config.PROVIDER_TIMEOUT_MS, retries: config.PROVIDER_MAX_RETRIES, sleep: deps.sleep });
    if (!res.ok) {
      const reason: MandiUnavailableReason =
        res.reason === "http_error" ? (res.status === 401 || res.status === 403 ? "auth_rejected" : res.status === 400 ? "invalid_request" : "http_error") : res.reason;
      // Upstream error bodies are summarised, passed through redaction and never include the request URL.
      const upstream = res.body && typeof res.body === "object" ? (res.body as { error?: unknown; message?: unknown }) : null;
      const note = typeof upstream?.error === "string" ? upstream.error : typeof upstream?.message === "string" ? upstream.message : "";
      return { status: "unavailable", reason, detail: redactSecrets(`${res.message}${note ? `: ${note}` : ""}`, [key]) };
    }
    const body = res.json as Record<string, unknown> | null;
    const page = body && typeof body === "object" ? (body.records as unknown) : undefined;
    if (!Array.isArray(page)) return { status: "unavailable", reason: "schema_mismatch", detail: "response has no records array" };
    pages++;
    const pageRecords = page.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r));
    records.push(...pageRecords);
    const t = body?.total;
    total = typeof t === "number" ? t : typeof t === "string" && /^\d+$/.test(t) ? Number(t) : total;
    if (Array.isArray(body?.field)) fields = body.field as typeof fields;
    else if (Array.isArray(body?.fields)) fields = body.fields as typeof fields;
    if (typeof body?.updated_date === "string") updatedDate = body.updated_date;
    await deps.onPage?.({ page: pages, count: pageRecords.length, total });
    offset += page.length;
    if (page.length === 0 || (total !== null && offset >= total) || page.length < pageLimit) {
      exhausted = true;
      break;
    }
  }
  const truncated = !cancelled && !exhausted;
  return {
    status: cancelled ? "cancelled" : "ok",
    records,
    fields,
    total,
    pages,
    truncated,
    fetchedAt: now().toISOString(),
    requestUrl: lastUrl,
    updatedDate,
  };
}
