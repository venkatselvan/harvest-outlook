import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { ConfigError, loadConfig, sanitizedConfig, type Config } from "./config";
import { databaseStatus, createPool, type Pool } from "./db/pool";
import { envelope, errorEnvelope } from "./envelope";
import { FsStorage } from "./storage/fs";
import type { StorageAdapter } from "./storage/types";
import { Budget } from "./services/budget";
import { ApiError } from "./services/errors";
import { REDACT_PATHS, makeReqSerializer } from "./security/logging";
import { ToolSchemas } from "@harvest/contracts";
import { allBindings } from "./agent/bindings";
import { createWeatherSource } from "./plans/adapters/weather-source";
import { defaultSources, PlanService, type PlanSources } from "./plans";
import { PgMarketOutlookSource, type PriceDeps } from "./plans/adapters/market-outlook";
import { loadProviderConfig } from "./providers/config";
import { PgVisualAssetSource } from "./visuals";
import { JournalService, journalTaskCompletionSource } from "./journal";
import { CatalogueStore } from "./catalogue/snapshot";
import { registerRoutes, type RouteDeps } from "./routes";
import { createSpeechProvider, speechConfigFor } from "./routes/speech";
import { resolveSession } from "./security/session";
import type { FetchLike } from "./ingest/http";
import { envelopeSchema, MODES } from "./routes/schemas/common";

export const LANGUAGES = ["en", "ta", "hi"] as const;

const healthData = z.object({ status: z.enum(["ok", "degraded"]), database: z.boolean() });
const capabilitiesData = z.object({
  mode: z.enum(MODES),
  models: z.object({
    text: z.string(),
    escalation: z.string(),
    image: z.string(),
    segment: z.string(),
    speechToText: z.string().nullable(),
    textToSpeech: z.string().nullable(),
  }),
  providers: z.object({ meta: z.boolean(), elevenlabs: z.boolean() }),
  languages: z.array(z.string()),
  database: z.object({ reachable: z.boolean(), postgis: z.boolean() }),
  limits: z.object({ maxUploadImageBytes: z.number(), maxVoiceSeconds: z.number() }),
  /**
   * Spend summary; null when the budget table is unavailable. Dollar figures are only included when the request
   * carries a valid session cookie (D-T04-1); anonymous callers see `exhausted` only.
   */
  budget: z
    .object({
      exhausted: z.boolean(),
      currency: z.literal("USD").optional(),
      devAllocationUsd: z.number().optional(),
      remainingDevUsd: z.number().optional(),
      demoReserveUsd: z.number().optional(),
    })
    .nullable(),
  speech: z.object({ available: z.boolean(), qualified: z.literal(false) }),
  /** Assistant tools with a bound handler vs. contract-only placeholders (answered `tool_not_bound`). */
  tools: z.object({ bound: z.array(z.string()), unbound: z.array(z.string()) }),
});

export interface ServerDeps {
  storage?: StorageAdapter;
  budget?: Budget;
  /** Override individual plan data sources (tests; INT2 binds outlook/visuals/completions). */
  sources?: Partial<PlanSources>;
  /** Passed to the assistant/speech plugins (tests inject providers; production passes none). */
  assistant?: RouteDeps["assistant"];
  speech?: RouteDeps["speech"];
  /** fetch used by the weather adapter's bounded live ingest (tests). */
  weatherFetch?: FetchLike;
  /** Overrides whether a data.gov.in key is configured (tests). Default: read from the environment; the key itself is never exposed. */
  priceKeyConfigured?: boolean;
  /** Clock for the price reference source and comparison endpoint (tests). */
  priceNow?: () => Date;
}

/** Whether a data.gov.in key is present in the environment. Boolean only; a malformed provider config counts as not configured. */
function dataGovKeyConfigured(): boolean {
  try {
    return !!loadProviderConfig().DATA_GOV_IN_API_KEY;
  } catch {
    return false;
  }
}

export async function buildServer(config: Config, pool: Pool, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const storage = deps.storage ?? new FsStorage(config.STORAGE_FS_ROOT);
  const budget = deps.budget ?? Budget.fromConfig(pool, config);
  const weather = createWeatherSource({
    pool,
    mode: config.RUNTIME_MODE,
    climatologyYears: config.WEATHER_CLIMATOLOGY_YEARS,
    climatologyEndYear: config.WEATHER_CLIMATOLOGY_END_YEAR,
    ...(deps.weatherFetch ? { fetchImpl: deps.weatherFetch } : {}),
  });
  const priceKeyConfigured = deps.priceKeyConfigured ?? dataGovKeyConfigured();
  const outlookSource = deps.sources?.outlook ?? new PgMarketOutlookSource({ pool, mode: config.RUNTIME_MODE, keyConfigured: priceKeyConfigured, ...(deps.priceNow ? { now: deps.priceNow } : {}) });
  const prices: PriceDeps = { source: outlookSource, keyConfigured: priceKeyConfigured, ...(deps.priceNow ? { now: deps.priceNow } : {}) };
  const plans = new PlanService({
    pool,
    mode: config.RUNTIME_MODE,
    sources: {
      ...defaultSources(),
      weather,
      visuals: new PgVisualAssetSource(pool),
      completions: journalTaskCompletionSource(pool),
      outlook: outlookSource,
      ...deps.sources,
    },
  });
  const journal = new JournalService({ pool, mode: config.RUNTIME_MODE, plans });
  const catalogue = new CatalogueStore(pool);
  const toolBindings = allBindings({ pool, plans, budget, segmentModel: config.META_SEGMENT_MODEL, int2: { config, catalogue, prices }, journal });
  const boundTools = Object.keys(toolBindings);
  const toolNames = Object.keys(ToolSchemas);
  const speechConfig = deps.speech?.speech ?? speechConfigFor(config);
  const speechProvider = deps.speech?.provider ?? createSpeechProvider(config, speechConfig);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      serializers: { req: makeReqSerializer(config.SESSION_SECRET) },
    },
    trustProxy: config.TRUST_PROXY,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(h) ? h : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: "Harvest Outlook API", version: "0.1.0" },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: true, max: Number(process.env.RATE_LIMIT_MAX) > 0 ? Number(process.env.RATE_LIMIT_MAX) : 120, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_IMAGE_BYTES, files: 1, fields: 10 } });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-runtime-mode", config.RUNTIME_MODE);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorEnvelope(req.id, config.RUNTIME_MODE, { code: "not_found", message: "Route not found" }));
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof ApiError) {
      if (err.statusCode >= 500) req.log.error({ err: { type: err.name, code: err.code } }, "request failed");
      const message = err.statusCode >= 500 ? "Internal server error" : err.message;
      reply.code(err.statusCode).send(errorEnvelope(req.id, config.RUNTIME_MODE, { code: err.statusCode >= 500 ? "internal_error" : err.code, message, ...(err.details !== undefined ? { details: err.details } : {}) }));
      return;
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: { type: err.name, message: err.message } }, "request failed");
    const isValidation = err.code === "FST_ERR_VALIDATION" || (err as { name?: string }).name === "ResponseValidationError";
    const code = isValidation ? "validation_error" : status === 429 ? "rate_limited" : status >= 500 ? "internal_error" : (err.code ?? "bad_request").toLowerCase();
    // Never leak internal messages for 5xx.
    const message = status >= 500 ? "Internal server error" : err.message;
    reply.code(status).send(errorEnvelope(req.id, config.RUNTIME_MODE, { code, message }));
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/v1/health",
    { schema: { tags: ["system"], response: { 200: envelopeSchema(healthData) } } },
    async (req) => {
      const db = await databaseStatus(pool);
      return envelope(req.id, config.RUNTIME_MODE, { status: db.reachable ? ("ok" as const) : ("degraded" as const), database: db.reachable });
    },
  );

  r.get(
    "/api/v1/capabilities",
    { schema: { tags: ["system"], response: { 200: envelopeSchema(capabilitiesData) } } },
    async (req) => {
      const db = await databaseStatus(pool);
      const summary = db.reachable ? await budget.summary().catch(() => null) : null;
      const session = summary ? await resolveSession(pool, config, req).catch(() => null) : null;
      const budgetSummary = summary ? (session ? summary : { exhausted: summary.exhausted }) : null;
      const warnings: string[] = [];
      if (config.RUNTIME_MODE === "synthetic") warnings.push("Synthetic mode: fixtures, not real data.");
      if (config.RUNTIME_MODE === "live" && !config.MODEL_API_KEY) warnings.push("Live mode without a Meta credential: model features unavailable.");
      return envelope(
        req.id,
        config.RUNTIME_MODE,
        {
          mode: config.RUNTIME_MODE,
          models: {
            text: config.META_TEXT_MODEL,
            escalation: config.META_ESCALATION_MODEL,
            image: config.META_IMAGE_MODEL,
            segment: config.META_SEGMENT_MODEL,
            speechToText: config.ELEVENLABS_STT_MODEL ?? null,
            textToSpeech: config.ELEVENLABS_TTS_MODEL ?? null,
          },
          providers: { meta: !!config.MODEL_API_KEY, elevenlabs: !!config.ELEVENLABS_API_KEY },
          languages: [...LANGUAGES],
          database: db,
          limits: { maxUploadImageBytes: config.MAX_UPLOAD_IMAGE_BYTES, maxVoiceSeconds: config.MAX_VOICE_SECONDS },
          budget: budgetSummary,
          speech: { available: speechProvider.live, qualified: false as const },
          tools: { bound: toolNames.filter((n) => boundTools.includes(n)), unbound: toolNames.filter((n) => !boundTools.includes(n)) },
        },
        warnings,
      );
    },
  );

  await registerRoutes(app, {
    config,
    pool,
    storage,
    budget,
    plans,
    journal,
    catalogue,
    prices,
    toolBindings,
    assistant: deps.assistant,
    speech: { ...deps.speech, speech: speechConfig, provider: speechProvider },
  });
  await budget.init().catch((e) => app.log.warn({ err: { type: (e as Error).name } }, "budget_state not initialised (database unavailable or unmigrated)"));

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}

async function main() {
  await import("./env");
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : "Failed to load configuration");
    process.exit(1);
  }
  const pool = createPool(config.DATABASE_URL);
  const app = await buildServer(config, pool);
  app.log.info({ config: sanitizedConfig(config) }, "configuration loaded");
  const stop = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await app.listen({ port: config.PORT, host: config.HOST });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
