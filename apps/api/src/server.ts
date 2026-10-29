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
import { REDACT_PATHS, reqSerializer } from "./security/logging";
import { registerRoutes } from "./routes";
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
  /** Sanitised spend summary; null when the budget table is unavailable. */
  budget: z
    .object({
      currency: z.literal("USD"),
      devAllocationUsd: z.number(),
      remainingDevUsd: z.number(),
      demoReserveUsd: z.number(),
      exhausted: z.boolean(),
    })
    .nullable(),
});

export interface ServerDeps {
  storage?: StorageAdapter;
  budget?: Budget;
}

export async function buildServer(config: Config, pool: Pool, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const storage = deps.storage ?? new FsStorage(config.STORAGE_FS_ROOT);
  const budget = deps.budget ?? Budget.fromConfig(pool, config);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      serializers: { req: reqSerializer },
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
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
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
      const budgetSummary = db.reachable ? await budget.summary().catch(() => null) : null;
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
        },
        warnings,
      );
    },
  );

  await registerRoutes(app, { config, pool, storage });
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
