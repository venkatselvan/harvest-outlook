import { z } from "zod";
import type { Pool } from "../../db/pool";
import { pgCache } from "../../ingest/cache";
import { IngestError } from "../../ingest/errors";
import type { FetchLike } from "../../ingest/http";
import { storeMarketRows } from "../../ingest/market-store";
import { findReusableRun, finishRun, payloadHash, RUN_FRESHNESS_SECONDS, startRun } from "../../ingest/runs";
import { ensureSource, MANDI_RESOURCES } from "../../ingest/sources";
import { storeArchive, storeForecast } from "../../ingest/weather-store";
import { fetchMandiPrices } from "../../providers/datagovin/client";
import { normalizeMandiRecords } from "../../providers/datagovin/normalize";
import { loadProviderConfig, type ProviderConfig } from "../../providers/config";
import { fetchDailyArchive, fetchForecast, roundCoord, type Unavailable } from "../../providers/openmeteo/client";
import type { JobRow } from "../main";

/** Context supplied by runJob (see worker/main.ts). */
export interface IngestContext {
  heartbeat: (progress?: number) => Promise<void>;
  pool: Pool;
  isCancelled: () => Promise<boolean>;
}
export type IngestHandler = (job: JobRow, ctx: IngestContext) => Promise<unknown>;

export interface IngestDeps {
  config?: ProviderConfig | undefined;
  fetchImpl?: FetchLike | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

export const archivePayload = z.object({ lat, lon, start: isoDate, end: isoDate, farmId: z.string().uuid().optional() }).strict();
export const forecastPayload = z.object({ lat, lon, days: z.number().int().min(1).max(16).default(10) }).strict();
export const marketPayload = z
  .object({
    resourceId: z.string().uuid(),
    commodity: z.string().min(1).max(100),
    state: z.string().min(1).max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();

/**
 * Privacy normalisation of ingest payloads (review finding L4). Weather payloads keep coordinates only at
 * 0.01 degree (~1.1 km; the provider request is rounded the same way in openmeteo/client.ts) and never keep
 * farmId. Enqueuers should call this before enqueue; the handler also rewrites the stored jobs.payload to
 * this form before any provider call, so raw coordinates/farmId do not persist past the first run attempt.
 * Throws IngestError(invalid_payload) for malformed payloads.
 */
export function normalizeIngestPayload(type: string, payload: unknown): Record<string, unknown> {
  if (type === "ingest.weather_archive") {
    const { farmId: _drop, ...p } = parsePayload(archivePayload, payload);
    return { ...p, lat: roundCoord(p.lat), lon: roundCoord(p.lon) };
  }
  if (type === "ingest.weather_forecast") {
    const p = parsePayload(forecastPayload, payload);
    return { ...p, lat: roundCoord(p.lat), lon: roundCoord(p.lon) };
  }
  if (type === "ingest.market_prices") return parsePayload(marketPayload, payload);
  throw new IngestError(`unknown ingest job type ${type}`, false, "invalid_payload");
}

const TRANSIENT = new Set(["network_error", "timeout", "rate_limited", "http_error"]);

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const p = schema.safeParse(payload);
  if (!p.success) throw new IngestError(`invalid payload: ${p.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`, false, "invalid_payload");
  return p.data;
}

function guardMode(config: ProviderConfig): "live" {
  // Replay forbids live provider calls; synthetic runtime may still ingest real public data (stored as mode live).
  if (config.RUNTIME_MODE === "replay") throw new IngestError("ingestion is disabled in replay mode", false, "replay_mode");
  return "live";
}

async function reuse(ctx: IngestContext, type: string, hash: string): Promise<unknown | null> {
  const prior = await findReusableRun(ctx.pool, type, hash, RUN_FRESHNESS_SECONDS[type]!);
  return prior ? { reused: true, ingestRunId: prior.id, counts: prior.counts, detail: prior.detail } : null;
}

async function failUnavailable(ctx: IngestContext, runId: string, u: { reason: string; detail: string }): Promise<never> {
  await finishRun(ctx.pool, runId, "unavailable", {}, { reason: u.reason, detail: u.detail });
  throw new IngestError(`provider unavailable: ${u.reason}: ${u.detail}`, TRANSIENT.has(u.reason), u.reason);
}

export function createIngestHandlers(deps: IngestDeps = {}): Record<string, IngestHandler> {
  const cfg = () => deps.config ?? loadProviderConfig();
  const openMeteoDeps = (ctx: IngestContext, config: ProviderConfig) => ({ config, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, cache: pgCache(ctx.pool) });

  const wrap = async (
    job: JobRow,
    ctx: IngestContext,
    type: string,
    provider: string,
    body: (runId: string, config: ProviderConfig, payload: Record<string, unknown>) => Promise<{ counts: unknown; detail: unknown; status?: "succeeded" | "cancelled" }>,
  ) => {
    const config = cfg();
    const mode = guardMode(config);
    const payload = normalizeIngestPayload(type, job.payload);
    // Scrub the stored payload (raw coordinates, farmId) before any provider call or run record.
    await ctx.pool.query("UPDATE jobs SET payload = $2::jsonb WHERE id = $1 AND payload IS DISTINCT FROM $2::jsonb", [job.id, JSON.stringify(payload)]);
    const hash = payloadHash(payload);
    const reused = await reuse(ctx, type, hash);
    if (reused) return reused;
    const runId = await startRun(ctx.pool, { jobId: job.id, jobType: type, hash, provider, mode });
    try {
      const out = await body(runId, config, payload);
      await finishRun(ctx.pool, runId, out.status ?? "succeeded", out.counts, out.detail);
      return { reused: false, ingestRunId: runId, status: out.status ?? "succeeded", counts: out.counts, detail: out.detail };
    } catch (e) {
      // failUnavailable already closed the run; anything else marks it failed.
      const row = await ctx.pool.query<{ status: string }>("SELECT status FROM ingest_runs WHERE id=$1", [runId]);
      if (row.rows[0]?.status === "running") await finishRun(ctx.pool, runId, "failed", {}, { message: (e as Error).message });
      throw e;
    }
  };

  return {
    "ingest.weather_archive": (job, ctx) =>
      wrap(job, ctx, "ingest.weather_archive", "open-meteo", async (runId, config, payload) => {
        const p = parsePayload(archivePayload, payload);
        await ctx.heartbeat(0.1);
        const res = await fetchDailyArchive({ lat: p.lat, lon: p.lon, start: p.start, end: p.end }, openMeteoDeps(ctx, config));
        if (res.status !== "ok") return failUnavailable(ctx, runId, res as Unavailable);
        await ctx.heartbeat(0.6);
        const counts = await storeArchive(ctx.pool, res.data);
        const first = res.data.rows[0]!;
        // farmId and exact coordinates are deliberately not persisted in shared ingest records.
        return { counts, detail: { units: first.units, measurementKind: first.measurementKind, cached: res.data.cached, stale: res.data.stale, fetchedAt: res.data.fetchedAt, window: { start: p.start, end: p.end } } };
      }),

    "ingest.weather_forecast": (job, ctx) =>
      wrap(job, ctx, "ingest.weather_forecast", "open-meteo", async (runId, config, payload) => {
        const p = parsePayload(forecastPayload, payload);
        await ctx.heartbeat(0.1);
        const res = await fetchForecast({ lat: p.lat, lon: p.lon, days: p.days }, openMeteoDeps(ctx, config));
        if (res.status !== "ok") return failUnavailable(ctx, runId, res as Unavailable);
        await ctx.heartbeat(0.6);
        const counts = await storeForecast(ctx.pool, res.data);
        const first = res.data.rows[0]!;
        return { counts, detail: { units: first.units, horizonDays: first.horizonDays, issueTime: first.issueTime, issueTimeBasis: first.issueTimeBasis, cached: res.data.cached, stale: res.data.stale } };
      }),

    "ingest.market_prices": (job, ctx) =>
      wrap(job, ctx, "ingest.market_prices", "data.gov.in", async (runId, config, payload) => {
        const p = parsePayload(marketPayload, payload);
        const info = MANDI_RESOURCES[p.resourceId];
        const res = await fetchMandiPrices(
          { resourceId: p.resourceId, filters: { commodity: p.commodity, state: p.state } },
          {
            config,
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            sleep: deps.sleep,
            shouldCancel: () => ctx.isCancelled(),
            onPage: (pg) => ctx.heartbeat(pg.total ? Math.min(0.8, (pg.page * 0.8) / Math.max(1, Math.ceil(pg.total / 500))) : 0.4),
          },
        );
        if (res.status === "unavailable") return failUnavailable(ctx, runId, res);
        if (res.status === "cancelled") {
          // Nothing is stored or published from a cancelled run.
          return { status: "cancelled" as const, counts: { recordsRead: res.records.length, stored: 0 }, detail: { pages: res.pages } };
        }
        const report = normalizeMandiRecords(res.records);
        const inWindow = report.rows.filter((r) => (!p.from || r.observedOn >= p.from) && (!p.to || r.observedOn <= p.to));
        const sourceId = await ensureSource(ctx.pool, info?.manifestId ?? `dgi-resource-${p.resourceId}`, {
          title: info?.title ?? `data.gov.in resource ${p.resourceId}`,
          publisher: "Open Government Data Platform India",
          url: `https://api.data.gov.in/resource/${p.resourceId}`,
          licence: "see manifest",
        });
        await ctx.heartbeat(0.9);
        const stored = await storeMarketRows(ctx.pool, inWindow, { sourceId, mode: "live", availableAt: new Date(res.fetchedAt) });
        return {
          counts: {
            recordsRead: res.records.length,
            normalized: report.rows.length,
            outsideWindow: report.rows.length - inWindow.length,
            rejected: report.rejected.length,
            duplicatesIgnored: report.duplicatesIgnored,
            conflictsFlagged: report.conflictsFlagged,
            ...stored,
          },
          detail: { pages: res.pages, total: res.total, truncated: res.truncated, unmappedFields: report.unmappedFields, unmappedCommodities: report.unmappedCommodities, requestUrl: res.requestUrl },
        };
      }),
  };
}
