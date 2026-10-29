/**
 * `pnpm test:e2e` launcher: the REAL API (buildServer, every plugin) in synthetic mode plus an in-process job loop using
 * the real worker handler registry. Nothing here is a provider call. Env: DATABASE_URL (default harvest_outlook_dev),
 * SESSION_SECRET (e2e-only default), PORT (default 8791).
 */
import "../../../api/src/env";
import { loadConfig } from "../../../api/src/config";
import { createPool } from "../../../api/src/db/pool";
import { buildServer } from "../../../api/src/server";
import { Budget } from "../../../api/src/services/budget";
import { FsStorage } from "../../../api/src/storage/fs";
import { handlers, pollOnce } from "../../../api/src/worker/main";
import { registerWorkerHandlers } from "../../../api/src/worker/handlers";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/harvest_outlook_dev",
  SESSION_SECRET: "e2e-only-session-secret-not-for-production-0123456789",
  ...process.env,
  RUNTIME_MODE: "synthetic",
  LOG_LEVEL: "warn",
  PORT: process.env.PORT ?? "8791",
  SESSION_CREATE_PER_HOUR: "1000",
});
const pool = createPool(config.DATABASE_URL);
const storage = new FsStorage(config.STORAGE_FS_ROOT);
const budget = Budget.fromConfig(pool, config);
const app = await buildServer(config, pool, { storage, budget });
registerWorkerHandlers(handlers, { config, pool, storage, budget });
let stop = false;
const done = async () => {
  stop = true;
};
process.on("SIGTERM", done);
process.on("SIGINT", done);
void (async () => {
  while (!stop) {
    const worked = await pollOnce(pool, "e2e-real-worker").catch(() => false);
    if (!worked) await new Promise((r) => setTimeout(r, 300));
  }
  await app.close();
  await pool.end();
  process.exit(0);
})();
await app.listen({ port: config.PORT, host: "127.0.0.1" });
