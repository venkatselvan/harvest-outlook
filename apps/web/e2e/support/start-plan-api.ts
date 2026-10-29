/**
 * Test launcher for the season e2e (T12): the real API (buildServer) with the catalogue loaded into the database, a
 * SYNTHETIC in-memory weather source (relative to the real clock, so "today" falls inside the season), the T06b crop
 * routes and the T11 visual routes plus handler with an in-process job loop. Fable's final wiring makes the extra
 * registrations unnecessary.
 *
 *   DATABASE_URL=postgres://localhost:5432/harvest_t12_e2e SESSION_SECRET=<32+ chars> PORT=8795 ALLOWED_ORIGINS=http://localhost:5195 \
 *   STORAGE_FS_ROOT=<dir> pnpm --filter @harvest/api exec tsx ../web/e2e/support/start-plan-api.ts
 *
 * Synthetic mode only: nothing here is real weather. Observations exist for the 14 days before today, forecast for 10 days
 * from today (issued at the start of today, India time), seasonal climatology beyond.
 */
import { addDays } from "@harvest/domain";
import type { Mode } from "@harvest/contracts";
import { loadConfig } from "../../../api/src/config";
import { createPool } from "../../../api/src/db/pool";
import { migrate } from "../../../api/src/db/migrate";
import { loadCatalogueIntoDb } from "../../../api/src/catalogue/load";
import { buildServer } from "../../../api/src/server";
import { Budget } from "../../../api/src/services/budget";
import { FsStorage } from "../../../api/src/storage/fs";
import { registerCropRoutes } from "../../../api/src/routes/crops";
import { registerVisualRoutes } from "../../../api/src/routes/visuals";
import { registerVisualHandlers } from "../../../api/src/visuals/job";
import { PgVisualAssetSource } from "../../../api/src/visuals/repository";
import { regionDate } from "../../../api/src/plans/weather";
import type { ClimatologyBundle, DailyWeather, ForecastBundle, WeatherSource } from "../../../api/src/plans/sources";
import { handlers, pollOnce } from "../../../api/src/worker/main";

const config = loadConfig({ RUNTIME_MODE: "synthetic", LOG_LEVEL: "warn", SESSION_CREATE_PER_HOUR: "1000", ...process.env });
if (config.RUNTIME_MODE !== "synthetic") throw new Error("start-plan-api is synthetic-only");
const pool = createPool(config.DATABASE_URL);
await migrate(pool, undefined, () => undefined);
await loadCatalogueIntoDb(pool);

const day = (date: string, source: string, rain: number): DailyWeather => ({ date, rainMm: rain, et0Mm: 4, tMaxC: 29, tMinC: 21, sourceId: source });
const synthWeather: WeatherSource = {
  modes: ["synthetic"] as readonly Mode[],
  async getDailyObservations(_s, range) {
    const today = regionDate(new Date());
    const out: DailyWeather[] = [];
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) if (d < today && d >= addDays(today, -14)) out.push(day(d, "synthetic-obs", 2));
    return out;
  },
  async getForecast(): Promise<ForecastBundle | null> {
    const today = regionDate(new Date());
    return { issuedAt: `${today}T00:00:00+05:30`, sourceId: "synthetic-forecast", days: Array.from({ length: 10 }, (_, i) => day(addDays(today, i), "synthetic-forecast", i === 2 ? 60 : 5)) };
  },
  async getClimatology(_s, range): Promise<ClimatologyBundle | null> {
    const days: DailyWeather[] = [];
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(day(d, "synthetic-climatology", 6));
    return { years: { from: 1991, to: 2020 }, sourceId: "synthetic-climatology", days };
  },
  async dataVersion() {
    return `synthetic-e2e-${regionDate(new Date())}`;
  },
};

const storage = new FsStorage(config.STORAGE_FS_ROOT);
const budget = Budget.fromConfig(pool, config);
const app = await buildServer(config, pool, { storage, budget, sources: { weather: synthWeather, visuals: new PgVisualAssetSource(pool) } });
for (const [name, reg] of [
  ["crops", () => app.register(registerCropRoutes, { config, pool })],
  ["visuals", () => app.register(registerVisualRoutes, { config, pool, storage })],
] as const) {
  try {
    await reg();
  } catch (e) {
    console.log(`${name} routes already registered or failed: ${(e as Error).message}`);
  }
}
registerVisualHandlers(handlers, { pool, config, storage, budget });
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
console.log(`e2e plan api listening on ${config.PORT} mode=${config.RUNTIME_MODE}`);
