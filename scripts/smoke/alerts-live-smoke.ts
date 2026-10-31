/**
 * One live smoke of the grounded farm-alert review (Meta muse-spark-1.3 + web search). Paid: one call capped at three
 * built-in searches (max_tool_calls: 3), expected about $0.03 to $0.05 (run 1, uncapped, made 11 searches and cost
 * about $0.154). Writes alerts-2026-11-01-run2.json; run 1's record stays in alerts-2026-11-01.json. Creates a TEMPORARY guest owner and farm (Hassan, Karnataka) with a maize cycle, runs
 * groundedReview once, persists the gated alerts, records a sanitized summary and deletes the temporary owner/farm.
 * Never reads or modifies existing farms. Run from apps/api so the repo .env loads:
 *   pnpm --filter @harvest/api exec tsx ../../scripts/smoke/alerts-live-smoke.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('../../apps/api/src/env');
const { loadConfig } = await import('../../apps/api/src/config');
const { createPool } = await import('../../apps/api/src/db/pool');
const { Budget } = await import('../../apps/api/src/services/budget');
const { createFarm } = await import('../../apps/api/src/services/farms');
const { groundedReview, persistAlerts, listAlerts, MAX_SEARCH_CALLS } = await import('../../apps/api/src/services/today/alerts');

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../evals/results/live-smoke/alerts-2026-11-01-run2.json');
const config = loadConfig();
const record: Record<string, unknown> = { task: 'stream-b-alerts-live-smoke', run: 2, compareTo: 'evals/results/live-smoke/alerts-2026-11-01.json (run 1: uncapped, 11 searches, 93,581 input tokens, about $0.154, 0 kept, 2 expired)', maxToolCalls: MAX_SEARCH_CALLS, runAt: new Date().toISOString(), runtimeMode: config.RUNTIME_MODE, requestedModel: config.META_TEXT_MODEL, keyConfigured: !!config.MODEL_API_KEY, farm: { kind: 'temporary', district: 'Hassan', state: 'Karnataka', crops: ['maize (growing)'] } };
if (config.RUNTIME_MODE !== 'live' || !config.MODEL_API_KEY) {
  record.status = 'skipped'; record.reason = config.RUNTIME_MODE !== 'live' ? 'live_mode_required' : 'meta_key_missing';
} else {
  const pool = createPool(config.DATABASE_URL);
  let ownerId: string | null = null, farmId: string | null = null;
  try {
    ownerId = (await pool.query<{ id: string }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0]!.id;
    farmId = (await createFarm(pool, ownerId, { name: 'alerts live smoke (temporary)', location: { stateId: 'IN-KA', districtName: 'Hassan', precision: 'district' }, facts: {} } as never)).id;
    // Keep any running worker away from the temporary farm; this script calls the review directly.
    await pool.query("UPDATE farm_monitors SET enabled=false, next_check_at=now()+interval '7 days' WHERE farm_id=$1", [farmId]);
    const workspace = { farmId, version: 0, updatedAt: null, boundary: null, previousHarvest: { status: 'unknown' as const }, cycles: [{ id: 'smoke-maize', cropId: 'maize', sowingDate: '2026-09-15', stage: 'growing' as const }], rotationPlans: [] };
    const asOf = new Date().toISOString();
    const started = Date.now();
    const r = await groundedReview({ pool, config, budget: Budget.fromConfig(pool, config) }, { ownerId, farmId, sessionId: null, workspace, asOf });
    const persisted = r.alerts.length ? await persistAlerts(pool, ownerId, farmId, 'live', r.alerts) : { inserted: 0, updated: 0 };
    const listed = await listAlerts(pool, ownerId, farmId, 'live', asOf);
    const domain = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
    const count = (xs: (string | null)[]) => xs.reduce<Record<string, number>>((m, x) => { const k = x ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    const reservation = (await pool.query<{ state: string; estimated_usd: string; settled_usd: string | null }>("SELECT state, estimated_usd, settled_usd FROM usage_reservations WHERE request_id LIKE $1 ORDER BY created_at DESC LIMIT 1", [`farm_alert_review:${farmId}:%`])).rows[0] ?? null;
    const invocation = (await pool.query<{ status: string; model: string | null; requested_model: string }>("SELECT status, model, requested_model FROM ai_invocations WHERE owner_id=$1 AND purpose='farm_alert_review' ORDER BY started_at DESC LIMIT 1", [ownerId])).rows[0] ?? null;
    Object.assign(record, {
      status: r.status, reason: r.reason, latencyMs: Date.now() - started, receivedModel: r.model, invocation,
      search: { calls: r.searchCalls, queries: r.searchQueries, citations: r.citations, retrievedSources: r.searchSources },
      keptAlerts: r.alerts.map((a) => ({ type: a.type, severity: a.severity, title: a.title, sourceDomain: domain(a.source.url), sourceDate: a.source.date, validFrom: a.validFrom, validTo: a.validTo })),
      adjusted: (r.adjusted ?? []).map((a) => ({ reason: a.reason, type: a.type, sourceDomain: a.sourceDomain })),
      kept: { count: r.alerts.length, types: count(r.alerts.map((a) => a.type)), severities: count(r.alerts.map((a) => a.severity)), sourceDomains: count(r.alerts.map((a) => domain(a.source.url))), sourceDates: r.alerts.map((a) => a.source.date).sort() },
      droppedItems: r.dropped.map((d) => ({ reason: d.reason, type: d.type, sourceDomain: d.sourceDomain })),
      dropped: { count: r.dropped.length, reasons: count(r.dropped.map((d) => d.reason)), types: count(r.dropped.map((d) => d.type)), sourceDomains: count(r.dropped.map((d) => d.sourceDomain)) },
      persisted, listedActive: listed.alerts.length, imdStatus: listed.imdStatus, newsReview: listed.newsReview,
      usage: r.usage, cost: { estimateUsd: r.estimateUsd, settledUsd: r.settledUsd, basis: 'estimated from reported usage and the documented price table, not a provider bill', reservation },
      responseDeleted: r.responseDeleted,
    });
  } catch (e) {
    record.status = 'error'; record.error = { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  } finally {
    const cleanup: Record<string, unknown> = {};
    try {
      if (farmId) cleanup.farmsDeleted = (await pool.query('DELETE FROM farms WHERE id=$1 AND owner_id=$2', [farmId, ownerId])).rowCount;
      if (ownerId) cleanup.ownersDeleted = (await pool.query('DELETE FROM owners WHERE id=$1', [ownerId])).rowCount;
    } catch (e) { cleanup.error = e instanceof Error ? e.message.slice(0, 200) : 'unknown'; }
    record.cleanup = cleanup;
    await pool.end();
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
