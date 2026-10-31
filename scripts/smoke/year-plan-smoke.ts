/**
 * Live smoke for the year plan (two muse-spark-1.3 selection calls, expected under $0.05 in total).
 * (1) The existing Hassan demo farm (fact demo_prefilled, fresh scenario) through ensureYearPlan + generateYearPlan with
 *     the real provider. Nothing is applied to it; the review row stays as the product cache, its queued job is removed.
 * (2) A temporary Tamil Nadu (Coimbatore) owner and farm with a paddy cycle sown 2026-09-01 (occupied scenario), deleted
 *     afterwards. Records sanitized results only (no key, no owner data beyond ids of the temporary rows).
 * Run: pnpm --filter @harvest/api exec tsx ../../scripts/smoke/year-plan-smoke.ts
 */
import '../../apps/api/src/env';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadConfig} from '../../apps/api/src/config';
import {createPool} from '../../apps/api/src/db/pool';
import {Budget} from '../../apps/api/src/services/budget';
import {createFarm} from '../../apps/api/src/services/farms';
import {putWorkspace} from '../../apps/api/src/services/workspace';
import {buildServer} from '../../apps/api/src/server';
import {ensureYearPlan, generateYearPlan, readYearPlan, type YearPlanDeps} from '../../apps/api/src/services/year-plan/service';

const config = loadConfig();
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(config.DATABASE_URL).hostname)) throw new Error('smoke_requires_local_database');
if (config.RUNTIME_MODE !== 'live') throw new Error('smoke_requires_live_mode');
const key = config.MODEL_API_KEY;
if (!key) { console.log('MODEL_API_KEY not set; skipping year-plan smoke'); process.exit(0); }
const pool = createPool(config.DATABASE_URL);
const OUT = resolve(import.meta.dirname, '../../evals/results/live-smoke/year-plan-2026-11-01.json');
const deps: YearPlanDeps = {pool, config, budget: Budget.fromConfig(pool, config)};

async function runOne(label: string, ownerId: string, sessionId: string, farmId: string) {
  const t0 = Date.now();
  const first = await ensureYearPlan(deps, {ownerId, sessionId}, farmId);
  const gen = await generateYearPlan(deps, first.reviewId!, ownerId);
  const review = await readYearPlan(deps, ownerId, farmId);
  const row = (await pool.query('SELECT input_context, job_id FROM farm_year_plans WHERE id=$1', [first.reviewId])).rows[0];
  if (row?.job_id) await pool.query("DELETE FROM jobs WHERE id=$1 AND state='queued'", [row.job_id]);
  const meta = row?.input_context?.meta ?? null;
  return {
    label, ms: Date.now() - t0, generate: gen, status: review.status, stale: review.stale, summary: review.summary, scenario: review.scenario,
    candidatesConsidered: review.candidatesConsidered, priceKeys: row?.input_context?.inputs?.priceKeys ?? null,
    climatology: row?.input_context?.inputs?.climatologyRainByMonth ? 'available' : 'unavailable', ndviActiveMonths: row?.input_context?.inputs?.neighbourhoodActiveMonths ?? null,
    meta: meta && {failure: meta.failure, dispatched: meta.dispatched, model: meta.model, usage: meta.usage, costUsd: meta.costUsd},
    modelInvocation: review.modelInvocation && {requestedModel: review.modelInvocation.requestedModel, model: review.modelInvocation.model, status: review.modelInvocation.status, responseDeleted: review.modelInvocation.responseDeleted},
    options: review.options.map((o) => ({
      optionId: o.optionId, label: o.label, origin: o.origin, score: o.score, components: o.components, idleMonths: o.idleMonths,
      reasons: o.reasons, totalProfitPerHa: o.totalProfitPerHa, warnings: o.warnings.slice(0, 4),
      slots: o.slots.map((s) => ({crop: s.cropName, product: s.productId, fixed: s.fixed, sowing: s.sowing, harvest: s.harvest, score: s.score, components: s.components, yieldKgPerHa: s.yieldKgPerHa, yieldBasis: s.yieldBasis, price: s.price && {status: s.price.status, range: s.price.range, scope: `${s.price.scope.level}: ${[s.price.scope.districtName, s.price.scope.stateName].filter(Boolean).join(', ')}`, reason: s.price.reason}, profitPerHa: s.profitPerHa, reasonCodes: s.reasonCodes})),
    })),
    limitations: review.limitations,
  };
}

const report: Record<string, unknown> = {kind: 'year_plan_live_smoke', startedAt: new Date().toISOString(), mode: config.RUNTIME_MODE, model: config.META_TEXT_MODEL, note: 'Prices are wholesale mandi references, yields regional statistics; nothing here is a field prediction.'};
let tempOwner: string | undefined, tempFarm: string | undefined;
const app = await buildServer(config, pool);
try {
  const demo = (await pool.query<{id: string; owner_id: string}>("SELECT f.id, f.owner_id FROM farms f JOIN farm_facts ff ON ff.farm_id=f.id AND ff.fact_key='demo_prefilled' AND ff.superseded_by IS NULL LEFT JOIN farm_workspaces w ON w.farm_id=f.id WHERE f.deleted_at IS NULL AND f.district_code='IN-KA-hassan' AND COALESCE(jsonb_array_length(w.state->'cycles'),0)=0 AND COALESCE(jsonb_array_length(w.state->'rotationPlans'),0)=0 ORDER BY f.created_at LIMIT 1")).rows[0];
  if (!demo) throw new Error('no fresh demo farm');
  const demoSession = (await pool.query<{id: string}>('SELECT id FROM sessions WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1', [demo.owner_id])).rows[0];
  if (!demoSession) throw new Error('demo owner has no active session');
  report.hassan = await runOne('Hassan demo farm (fresh)', demo.owner_id, demoSession.id, demo.id);
  const origins = config.ALLOWED_ORIGINS as unknown;
  const origin = Array.isArray(origins) ? String(origins[0]) : String(origins).split(',')[0]!;
  const t = new Date();
  const res = await app.inject({method: 'POST', url: '/api/v1/session', headers: {origin}});
  if (res.statusCode !== 201) throw new Error(`session ${res.statusCode}`);
  const s = (await pool.query<{id: string; owner_id: string}>('SELECT id, owner_id FROM sessions WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 1', [t])).rows[0]!;
  tempOwner = s.owner_id;
  tempFarm = (await createFarm(pool, tempOwner, {name: `Temporary year-plan QA ${randomUUID()}`, location: {stateId: 'IN-TN', districtId: 'IN-TN-coimbatore', precision: 'precise', lat: 11.0168, lon: 76.9558}})).id;
  await putWorkspace(pool, tempOwner, tempFarm, {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [{id: 'smoke-paddy', cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', sowingDate: '2026-09-01', stage: 'growing'}], rotationPlans: []});
  report.coimbatore = await runOne('Temporary Coimbatore farm (occupied, paddy sown 2026-09-01)', tempOwner, s.id, tempFarm);
} catch (e) {
  report.failed = true;
  report.reason = String((e as Error).message).slice(0, 300);
  process.exitCode = 1;
} finally {
  if (tempOwner) await pool.query('DELETE FROM jobs WHERE owner_id=$1', [tempOwner]);
  if (tempFarm && tempOwner) await pool.query('DELETE FROM farms WHERE id=$1 AND owner_id=$2', [tempFarm, tempOwner]);
  if (tempOwner) await pool.query('DELETE FROM owners WHERE id=$1', [tempOwner]);
  const left = tempOwner ? (await pool.query('SELECT 1 FROM owners WHERE id=$1', [tempOwner])).rowCount : 0;
  const costs = [(report.hassan as {meta?: {costUsd?: number}} | undefined)?.meta?.costUsd ?? 0, (report.coimbatore as {meta?: {costUsd?: number}} | undefined)?.meta?.costUsd ?? 0];
  report.totalCostUsdEstimate = Math.round(costs.reduce((x, y) => x + y, 0) * 1e6) / 1e6;
  report.cleanup = {tempOwnerLeft: left, demoFarmApplied: false, kept: 'the Hassan demo review row (product cache); usage ledger rows as the spend record'};
  report.completedAt = new Date().toISOString();
  await mkdir(resolve(OUT, '..'), {recursive: true});
  await writeFile(OUT, `${JSON.stringify(report, null, 2).split(key).join('[redacted]')}\n`);
  const brief = (r: any) => r && {status: r.status, ms: r.ms, meta: r.meta, invocation: r.modelInvocation, priceKeys: r.priceKeys, climatology: r.climatology, options: r.options.map((o: any) => ({label: o.label, origin: o.origin, score: o.score, components: o.components, seq: o.slots.map((x: any) => `${x.crop}${x.fixed ? '(growing)' : ''} ${x.sowing}`).join(' > '), price: o.slots.map((x: any) => x.price?.status === 'available' ? x.price.scope : x.price?.reason ?? 'none').join(' | '), reasons: o.reasons.map((x: any) => x.text)}))};
  console.log(JSON.stringify({failed: report.failed ?? false, reason: report.reason, hassan: brief(report.hassan), coimbatore: brief(report.coimbatore), totalCostUsdEstimate: report.totalCostUsdEstimate, cleanup: report.cleanup}, null, 2));
  await app.close();
  await pool.end();
}
