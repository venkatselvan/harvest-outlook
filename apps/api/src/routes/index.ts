import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import type { StorageAdapter } from "../storage/types";
import { farmRoutes } from "./farms";
import { jobRoutes } from "./jobs";
import { mediaRoutes } from "./media";
import { sessionRoutes } from "./session";

export interface RouteDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
}

/** Each plugin is encapsulated so its auth/CSRF onRequest hook only covers its own routes. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await app.register(sessionRoutes, deps);
  await app.register(farmRoutes, deps);
  await app.register(mediaRoutes, deps);
  await app.register(jobRoutes, deps);
}
