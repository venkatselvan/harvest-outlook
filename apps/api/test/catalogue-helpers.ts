import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Config } from "../src/config";
import type { Pool } from "../src/db/pool";
import { errorEnvelope } from "../src/envelope";
import { ApiError } from "../src/services/errors";
import { sessionRoutes } from "../src/routes/session";
import { farmRoutes } from "../src/routes/farms";
import { registerCropRoutes } from "../src/routes/crops";
import { FsStorage } from "../src/storage/fs";
import { migrate } from "../src/db/migrate";
import { loadCatalogueIntoDb } from "../src/catalogue/load";
import { createPool } from "../src/db/pool";

export const CAT_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_t06b";

/** Minimal app with the shared compilers and error mapping, mounting only session, farm and crop routes (server.ts wiring is Fable's). */
export async function buildCatalogueApp(config: Config, pool: Pool, storageRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send(errorEnvelope(req.id, config.RUNTIME_MODE, { code: err.code, message: err.message }));
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send(errorEnvelope(req.id, config.RUNTIME_MODE, { code: err.code === "FST_ERR_VALIDATION" ? "validation_error" : (err.code ?? "error"), message: err.message }));
  });
  await app.register(sessionRoutes, { config, pool });
  await app.register(farmRoutes, { config, pool, storage: new FsStorage(storageRoot) });
  await app.register(registerCropRoutes, { config, pool });
  await app.ready();
  return app;
}

export async function freshCatalogueDb(): Promise<Pool> {
  const pool = createPool(CAT_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  await loadCatalogueIntoDb(pool);
  return pool;
}
