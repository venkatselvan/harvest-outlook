/**
 * Test launcher for the photo-region e2e: the real API (buildServer) plus the vision routes and the
 * vision.segment handler, with an in-process job loop. Fable's final wiring makes this unnecessary.
 *
 * Run from the repo root:
 *   DATABASE_URL=postgres://localhost:5432/ho_e2e SESSION_SECRET=<32+ chars> PORT=8791 ALLOWED_ORIGINS=http://localhost:5191 \
 *   STORAGE_FS_ROOT=<dir> pnpm --filter @harvest/api exec tsx ../web/e2e/support/start-api.ts
 * Mode defaults to synthetic (RUNTIME_MODE to override). Never needs a model key.
 */
import { loadConfig } from "../../../api/src/config";
import { createPool } from "../../../api/src/db/pool";
import { migrate } from "../../../api/src/db/migrate";
import { buildServer } from "../../../api/src/server";
import { Budget } from "../../../api/src/services/budget";
import { FsStorage } from "../../../api/src/storage/fs";
import { registerVisionRoutes } from "../../../api/src/routes/vision";
import { registerSegmentationHandler } from "../../../api/src/vision/jobs/segmentation";
import { handlers, pollOnce } from "../../../api/src/worker/main";

const config = loadConfig({ RUNTIME_MODE: "synthetic", LOG_LEVEL: "warn", SESSION_CREATE_PER_HOUR: "1000", ...process.env });
const pool = createPool(config.DATABASE_URL);
await migrate(pool, undefined, () => undefined);
const storage = new FsStorage(config.STORAGE_FS_ROOT);
const budget = Budget.fromConfig(pool, config);
const app = await buildServer(config, pool, { storage, budget });
await app.register(registerVisionRoutes, { config, pool, storage });
registerSegmentationHandler(handlers, { pool, config, storage, budget });
let stop = false;
process.on("SIGTERM", () => (stop = true));
process.on("SIGINT", () => (stop = true));
void (async () => {
  while (!stop) {
    const worked = await pollOnce(pool, "e2e-worker").catch(() => false);
    if (!worked) await new Promise((r) => setTimeout(r, 300));
  }
  await app.close();
  await pool.end();
  process.exit(0);
})();
await app.listen({ port: config.PORT, host: "127.0.0.1" });
console.log(`e2e api listening on ${config.PORT} mode=${config.RUNTIME_MODE}`);
