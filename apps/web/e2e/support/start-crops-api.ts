/**
 * Test launcher for the explore e2e: the real API (buildServer) plus the T06b crop routes, which
 * server.ts may not register yet. Fable's final wiring makes this unnecessary.
 *
 *   DATABASE_URL=postgres://localhost:5432/<seeded db> SESSION_SECRET=<32+ chars> PORT=8793 ALLOWED_ORIGINS=http://localhost:5193 \
 *   pnpm --filter @harvest/api exec tsx ../web/e2e/support/start-crops-api.ts
 * Mode defaults to synthetic. The database must be migrated and seeded (pnpm db:seed).
 */
import { loadConfig } from "../../../api/src/config";
import { createPool } from "../../../api/src/db/pool";
import { buildServer } from "../../../api/src/server";
import { registerCropRoutes } from "../../../api/src/routes/crops";

const config = loadConfig({ RUNTIME_MODE: "synthetic", LOG_LEVEL: "warn", SESSION_CREATE_PER_HOUR: "1000", ...process.env });
const pool = createPool(config.DATABASE_URL);
const app = await buildServer(config, pool);
let registered = true;
try {
  await app.register(registerCropRoutes, { config, pool });
} catch (e) {
  registered = false;
  console.log(`crop routes already registered or failed: ${(e as Error).message}`);
}
const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await app.listen({ port: config.PORT, host: "127.0.0.1" });
console.log(`explore e2e api listening on ${config.PORT} mode=${config.RUNTIME_MODE} cropRoutes=${registered}`);
