/** Bounded public-data smoke. Creates and removes its own QA owner/farm; Meta is disabled. */
import '../../apps/api/src/env';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../../apps/api/src/config';
import { createPool } from '../../apps/api/src/db/pool';
import { createFarm } from '../../apps/api/src/services/farms';
import { putWorkspace } from '../../apps/api/src/services/workspace';
import { Budget } from '../../apps/api/src/services/budget';
import { createMonitorHandler } from '../../apps/api/src/worker/handlers/monitoring';
import type { MonitoringSnapshot } from '../../apps/api/src/services/monitoring';

const config = loadConfig();
const database = new URL(config.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname)) throw new Error('smoke_requires_local_database');
if (config.RUNTIME_MODE !== 'live') throw new Error('smoke_requires_live_mode');
const pool = createPool(config.DATABASE_URL);
const runId = randomUUID();
const calls: { provider: string; status: number }[] = [];
const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['api.data.gov.in', 'api.open-meteo.com'].includes(url.hostname)) throw new Error('smoke_unexpected_provider');
  const response = await fetch(input, init);
  // Do not retain request URLs: data.gov.in embeds its API key in query parameters.
  calls.push({ provider: url.hostname, status: response.status });
  return response;
};
let ownerId: string | undefined;
let farmId: string | undefined;
const startedAt = new Date().toISOString();
let report: Record<string, unknown> = { startedAt, mode: config.RUNTIME_MODE, metaEnabled: false };
try {
  ownerId = (await pool.query<{ id: string }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0]!.id;
  const farm = await createFarm(pool, ownerId, { name: `Temporary monitor QA ${runId}`, location: { districtId: 'IN-KA-hassan', stateId: 'IN-KA', precision: 'precise', lat: 13.0033, lon: 76.1004 }, areaHectares: 1 });
  farmId = farm.id;
  await putWorkspace(pool, ownerId, farmId, { expectedVersion: 0, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [{ id: 'qa-ginger-cycle', cropId: 'ginger', sowingDate: '2026-05-01', stage: 'growing' }], rotationPlans: [] });
  // Due far in the future so the independent running worker cannot pick up this direct smoke.
  await pool.query("INSERT INTO farm_monitors(farm_id,enabled,meta_enabled,next_check_at) VALUES($1,true,false,now()+interval '7 days')", [farmId]);
  let metaCalls = 0;
  const handler = createMonitorHandler({ config, pool, budget: Budget.fromConfig(pool, config), fetchImpl, review: async () => { metaCalls++; throw new Error('smoke_meta_must_be_disabled'); } });
  const result = await handler({ id: randomUUID(), owner_id: ownerId, type: 'farm.monitor', attempt: 1, max_attempts: 1, payload: { farmId } }, { pool, heartbeat: async () => {}, isCancelled: async () => false });
  const stored = (await pool.query<{ snapshot: MonitoringSnapshot; last_checked_at: Date; market_refresh_reason: string | null; meta_review: unknown; last_meta_attempt_at: Date | null }>('SELECT snapshot,last_checked_at,market_refresh_reason,meta_review,last_meta_attempt_at FROM farm_monitors WHERE farm_id=$1', [farmId])).rows[0]!;
  if (!stored.snapshot || !stored.last_checked_at || metaCalls !== 0 || stored.meta_review !== null || stored.last_meta_attempt_at !== null) throw new Error('smoke_persistence_or_meta_guard_failed');
  report = { ...report, completedAt: new Date().toISOString(), result, networkCalls: calls, metaCalls,
    persisted: true, snapshotMode: stored.snapshot.mode,
    weather: { status: stored.snapshot.weather.status, reason: stored.snapshot.weather.reason, issuedAt: stored.snapshot.weather.issuedAt, days: stored.snapshot.weather.days.length, coordinateBasis: stored.snapshot.weather.coordinateBasis, attribution: stored.snapshot.weather.attribution },
    market: { status: stored.snapshot.market.status, reason: stored.snapshot.market.reason, refreshReason: stored.market_refresh_reason,
      products: stored.snapshot.market.products.map((p) => ({ productId: p.productId, state: p.reference.state, ...(p.reference.state === 'historical_reference' ? { market: p.reference.marketName, latestDate: p.reference.lastQuote.date, inrPerKg: p.reference.lastQuote.inrPerKg } : { reason: p.reference.missingReason }) })) },
  };
  // Do not publish even the temporary farm UUID in the saved job result.
  if (report.result && typeof report.result === 'object') delete (report.result as Record<string, unknown>).farmId;
} catch {
  report = { ...report, failed: true, reason: 'live_monitor_smoke_failed', networkCalls: calls };
  process.exitCode = 1;
} finally {
  if (farmId && ownerId) await pool.query('DELETE FROM farms WHERE id=$1 AND owner_id=$2', [farmId, ownerId]);
  if (ownerId) await pool.query('DELETE FROM owners WHERE id=$1', [ownerId]);
  const remaining = ownerId ? (await pool.query('SELECT 1 FROM owners WHERE id=$1', [ownerId])).rowCount : 0;
  report.qaRecordsCleaned = remaining === 0;
  report.scope = 'Dedicated temporary QA owner/farm only; public weather cache and market-observation refresh may add real shared source rows; no other farm/session/monitor modified.';
  const out = resolve(import.meta.dirname, '../../evals/results/live-smoke/monitoring-2026-10-30.json');
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}
