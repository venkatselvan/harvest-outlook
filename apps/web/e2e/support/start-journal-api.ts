/**
 * Test launcher for the journal e2e: the real API (buildServer, which already serves sessions, farms, media, jobs and
 * plans) plus the T13 journal routes and the journal.analysis handler, with an in-process job loop. Fable's INT2
 * wiring makes this unnecessary. Synthetic mode only: the "model" is the journal_* fixture; no provider is contacted.
 *
 *   DATABASE_URL=postgres://localhost:5432/harvest_t13_e2e SESSION_SECRET=<32+ chars> PORT=8794 ALLOWED_ORIGINS=http://localhost:5194 \
 *   STORAGE_FS_ROOT=<dir> pnpm --filter @harvest/api exec tsx ../web/e2e/support/start-journal-api.ts
 */
import { loadConfig } from "../../../api/src/config";
import { createPool } from "../../../api/src/db/pool";
import { migrate } from "../../../api/src/db/migrate";
import { buildServer } from "../../../api/src/server";
import { Budget } from "../../../api/src/services/budget";
import { FsStorage } from "../../../api/src/storage/fs";
import { runIdempotent } from "../../../api/src/services/idempotency";
import { privateRouteGuard } from "../../../api/src/security/guards";
import { requireAuth } from "../../../api/src/security/session";
import { createWeatherSource } from "../../../api/src/plans/adapters/weather-source";
import { defaultSources, PlanService } from "../../../api/src/plans";
import { JournalService, journalTaskCompletionSource, registerJournalHandlers, registerJournalRoutes } from "../../../api/src/journal";
import { handlers, pollOnce } from "../../../api/src/worker/main";

const config = loadConfig({ RUNTIME_MODE: "synthetic", LOG_LEVEL: "warn", SESSION_CREATE_PER_HOUR: "1000", ...process.env });
if (config.RUNTIME_MODE !== "synthetic") throw new Error("the journal e2e launcher is synthetic only");
const pool = createPool(config.DATABASE_URL);
await migrate(pool, undefined, () => undefined);
// Catalogue rows the ginger plan needs (idempotent, synthetic test rows).
await pool.query("INSERT INTO crop_identities (slug) SELECT 'ginger' WHERE NOT EXISTS (SELECT 1 FROM crop_identities WHERE slug='ginger')");
await pool.query(
  "INSERT INTO crop_products (crop_id, slug, name) SELECT id, 'ginger-fresh', 'Fresh ginger' FROM crop_identities WHERE slug='ginger' AND NOT EXISTS (SELECT 1 FROM crop_products WHERE slug='ginger-fresh')",
);
const storage = new FsStorage(config.STORAGE_FS_ROOT);
const budget = Budget.fromConfig(pool, config);
const completions = journalTaskCompletionSource(pool);
const app = await buildServer(config, pool, { storage, budget, sources: { completions } });
const weather = createWeatherSource({ pool, mode: config.RUNTIME_MODE, climatologyYears: config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: config.WEATHER_CLIMATOLOGY_END_YEAR });
const plans = new PlanService({ pool, mode: config.RUNTIME_MODE, sources: { ...defaultSources(), weather, completions } });
const service = new JournalService({ pool, mode: config.RUNTIME_MODE, plans });
await registerJournalRoutes(app, {
  config,
  service,
  resolveOwner: (req) => requireAuth(req).ownerId,
  onRequest: privateRouteGuard(config, pool),
  resolveSession: (req) => requireAuth(req).sessionId,
  idempotency: { run: (o, e) => runIdempotent(pool, o, e) },
});
registerJournalHandlers(handlers, { pool, config, storage, budget, plans });
let stop = false;
process.on("SIGTERM", () => (stop = true));
process.on("SIGINT", () => (stop = true));
void (async () => {
  while (!stop) {
    const worked = await pollOnce(pool, "e2e-journal-worker").catch(() => false);
    if (!worked) await new Promise((r) => setTimeout(r, 300));
  }
  await app.close();
  await pool.end();
  process.exit(0);
})();
await app.listen({ port: config.PORT, host: "127.0.0.1" });
console.log(`journal e2e api listening on ${config.PORT} mode=${config.RUNTIME_MODE}`);
