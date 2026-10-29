import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Mode } from "@harvest/contracts";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { checkOrigin, privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { ApiError, notFound } from "../services/errors";
import { getFarm } from "../services/farms";
import { compareCrops, type ComparisonInput } from "../catalogue/compare";
import { buildCropDetail, buildCropSummaries, coverageFor, listAreas } from "../catalogue/views";
import { CatalogueNotLoadedError, CatalogueStore, type CatalogueSnapshot } from "../catalogue/snapshot";
import { envelopeSchema } from "./schemas/common";
import { anyData, comparisonBody, cropIdParam, districtsQuery } from "./schemas/crops";

export interface CropRouteDeps {
  config: Config;
  pool: Pool;
  /** Tests may inject a store or a fixed clock. */
  store?: Pick<CatalogueStore, "get">;
  now?: () => Date;
}

/** Registers GET /crops, /crops/:id, /crops/:id/coverage, /districts and POST /crop-comparisons. Public browsing; farm-linked comparison needs a session. */
export async function registerCropRoutes(app: FastifyInstance, deps: CropRouteDeps): Promise<void> {
  const { config, pool } = deps;
  const store = deps.store ?? new CatalogueStore(pool);
  const mode: Mode = config.RUNTIME_MODE;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = async (): Promise<CatalogueSnapshot> => {
    try {
      return await store.get();
    } catch (e) {
      if (e instanceof CatalogueNotLoadedError) throw new ApiError(503, "catalogue_not_loaded", "The crop catalogue has not been loaded into the database (run pnpm db:seed)");
      throw e;
    }
  };

  r.get("/api/v1/crops", { schema: { tags: ["crops"], description: "Catalogue summary with per-crop coverage summary. Coverage is per capability; there is no single quality score.", response: { 200: envelopeSchema(anyData) } } }, async (req) => {
    const snap = await load();
    const crops = buildCropSummaries(snap);
    return envelope(req.id, mode, { crops, counts: { crops: crops.length, qualified: crops.filter((c) => c.qualified).length, products: snap.products.length } });
  });

  r.get("/api/v1/crops/:id", { schema: { tags: ["crops"], params: cropIdParam, description: "Crop profile, regional contexts, rules and evidence excerpts with citations.", response: { 200: envelopeSchema(anyData) } } }, async (req) => {
    const snap = await load();
    const d = buildCropDetail(snap, req.params.id);
    if (!d) throw notFound("Crop");
    return envelope(req.id, mode, d);
  });

  r.get("/api/v1/crops/:id/coverage", { schema: { tags: ["crops"], params: cropIdParam, description: "CoverageRecords for the crop.", response: { 200: envelopeSchema(anyData) } } }, async (req) => {
    const snap = await load();
    const c = coverageFor(snap, req.params.id);
    if (!c) throw notFound("Crop");
    return envelope(req.id, mode, c);
  });

  r.get("/api/v1/districts", { schema: { tags: ["crops"], querystring: districtsQuery, description: "States and agro-regions, or the districts of ?state=IN-KA. District lists exist only for some states.", response: { 200: envelopeSchema(anyData) } } }, async (req) => {
    const snap = await load();
    return envelope(req.id, mode, listAreas(snap, req.query.state));
  });

  r.post(
    "/api/v1/crop-comparisons",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["crops"],
        description:
          "Screens the catalogue against a validated profile and returns per-crop-product outcome, applied rule ids, evidence ids and supported dimensions. Anonymous use is allowed (rate limited). With farmId a guest session and CSRF token are required and the farm must belong to the caller (otherwise 404).",
        body: comparisonBody,
        response: { 200: envelopeSchema(anyData) },
      },
    },
    async (req, reply) => {
      const body = req.body;
      let location = body.location ? { stateId: body.location.stateId as string | null, districtId: body.location.districtId ?? null } : { stateId: null as string | null, districtId: null as string | null };
      let area = body.area;
      const warnings: string[] = [];
      if (body.farmId) {
        await privateRouteGuard(config, pool)(req, reply);
        const farm = await getFarm(pool, requireAuth(req).ownerId, body.farmId);
        if (!farm) throw notFound("Farm");
        if (!body.location) {
          const sc = farm.location.stateCode;
          location = { stateId: sc ? (sc.startsWith("IN-") ? sc : `IN-${sc.toUpperCase()}`) : null, districtId: farm.location.districtId };
          if (!location.stateId) warnings.push("farm_has_no_state: location left unknown");
        }
        if (!area && farm.areaHectares) area = { amount: farm.areaHectares, unit: "ha" };
      } else {
        checkOrigin(req, config);
      }
      const snap = await load();
      if (location.stateId && location.districtId) {
        const districts = snap.areas.filter((a) => a.level === "district" && a.stateId === location.stateId);
        if (districts.length > 0 && !districts.some((d) => d.id === location.districtId)) throw new ApiError(400, "district_state_mismatch", `District ${location.districtId} is not in the ${location.stateId} registry`);
      }
      if (body.cropIds) for (const c of body.cropIds) if (!snap.profiles.some((p) => p.cropId === c)) throw new ApiError(400, "unknown_crop", `Unknown crop id ${c}`);
      const input: ComparisonInput = {
        location, planting: { month: body.planting.month, date: body.planting.date ?? null }, irrigation: body.irrigation, soil: body.soil,
        rainfallSeasonalMm: body.rainfallSeasonalMm, elevationM: body.elevationM, area, budgetInrPerHa: body.budgetInrPerHa,
        excludedCropIds: body.excludedCropIds, assumedPrices: body.assumedPrices, cropIds: body.cropIds, weights: body.preferencePolicy?.weights,
      };
      const out = compareCrops(snap, input, { mode, ...(deps.now ? { now: deps.now() } : {}) });
      if (mode === "synthetic") warnings.push("synthetic_mode: candidate (unreviewed) rules are executed and marked in the result");
      warnings.push("price_access_key_gated: no price reference is available; no price is inferred");
      return envelope(req.id, mode, out, warnings);
    },
  );
}
