import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Id, IsoDate } from "@harvest/contracts";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { ApiError } from "../services/errors";
import { harvestPriceOutlook, priceSeries, priceTrend } from "../services/price-series";
import { envelopeSchema } from "./schemas/common";

/**
 * Wholesale mandi price reads for the Year plan and the Today view (services/price-series.ts). Private (guest session
 * required) because they serve the farm workspace; they read no owner data. The runtime mode comes from server config,
 * never from the client. Response schemas are `unknown` until packages/contracts exports PriceSeries,
 * HarvestPriceOutlook and PriceTrend from its index (price-outlook.ts); the API tests parse every payload with them.
 */
export interface PriceSeriesRouteDeps { config: Config; pool: Pool }

const place = z.string().trim().min(1).max(120);
const MAX_SPAN_DAYS = 3660;
const DAY = 86_400_000;

const seriesQuery = z.object({
  productId: Id,
  stateName: place.optional(),
  districtName: place.optional(),
  /** Comma-separated market ids (at most 20). */
  marketIds: z.string().max(2000).optional(),
  from: IsoDate,
  to: IsoDate,
  bucket: z.enum(["week", "month"]).default("month"),
  asOf: IsoDate.optional(),
});
const outlookQuery = z.object({
  productId: Id,
  stateName: place,
  districtName: place.optional(),
  harvestDate: IsoDate,
  asOf: IsoDate.optional(),
  weekWindow: z.coerce.number().int().min(0).max(4).default(2),
  years: z.coerce.number().int().min(2).max(6).default(3),
});
const trendQuery = z.object({
  productId: Id,
  stateName: place,
  districtName: place.optional(),
  months: z.coerce.number().int().min(12).max(60).default(36),
  asOf: IsoDate.optional(),
});

const bad = (message: string) => new ApiError(400, "validation_failed", message);
const today = () => new Date().toISOString().slice(0, 10);

export async function priceSeriesRoutes(app: FastifyInstance, deps: PriceSeriesRouteDeps): Promise<void> {
  const { config, pool } = deps;
  const mode = config.RUNTIME_MODE;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  /** Replay reads need an explicit cutoff; other modes default asOf to today (UTC). */
  const asOfFor = (asOf: string | undefined): string => {
    if (asOf) return asOf;
    if (mode === "replay") throw bad("asOf is required in replay mode");
    return today();
  };
  const limits = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  r.get("/api/v1/price-series", { ...limits, schema: { tags: ["market"], querystring: seriesQuery, response: { 200: envelopeSchema(z.unknown()) } } }, async (req, reply) => {
    requireAuth(req);
    const q = req.query;
    if (q.from > q.to) throw bad("from must not be after to");
    if ((Date.parse(q.to) - Date.parse(q.from)) / DAY > MAX_SPAN_DAYS) throw bad(`the range may span at most ${MAX_SPAN_DAYS} days`);
    const marketIds = (q.marketIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (marketIds.length > 20 || marketIds.some((m) => !Id.safeParse(m).success)) throw bad("marketIds must be at most 20 comma-separated identifiers");
    if (mode === "replay" && !q.asOf) throw bad("asOf is required in replay mode");
    const data = await priceSeries(pool, mode, { productId: q.productId, stateName: q.stateName, districtName: q.districtName, marketIds, from: q.from, to: q.to, bucket: q.bucket, asOf: q.asOf });
    reply.header("cache-control", "private, max-age=300");
    return envelope(req.id, mode, data);
  });

  r.get("/api/v1/price-outlook", { ...limits, schema: { tags: ["market"], querystring: outlookQuery, response: { 200: envelopeSchema(z.unknown()) } } }, async (req, reply) => {
    requireAuth(req);
    const q = req.query;
    const data = await harvestPriceOutlook(pool, mode, { productId: q.productId, stateName: q.stateName, districtName: q.districtName, harvestDate: q.harvestDate, asOf: asOfFor(q.asOf), weekWindow: q.weekWindow, years: q.years });
    reply.header("cache-control", "private, max-age=300");
    return envelope(req.id, mode, data);
  });

  r.get("/api/v1/price-trend", { ...limits, schema: { tags: ["market"], querystring: trendQuery, response: { 200: envelopeSchema(z.unknown()) } } }, async (req, reply) => {
    requireAuth(req);
    const q = req.query;
    const data = await priceTrend(pool, mode, { productId: q.productId, stateName: q.stateName, districtName: q.districtName, months: q.months, asOf: asOfFor(q.asOf) });
    reply.header("cache-control", "private, max-age=300");
    return envelope(req.id, mode, data);
  });
}
