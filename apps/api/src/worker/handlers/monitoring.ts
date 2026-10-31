import {currentMandiQuotes} from '../../services/market-quotes';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Pool } from '../../db/pool';
import type { Budget } from '../../services/budget';
import { monitoringSnapshot, workspaceMarketProducts, type MonitoringDeps, type MonitoringSnapshot } from '../../services/monitoring';
import { saveMonitorSnapshot } from '../../services/monitor-schedule';
import { getFarm } from '../../services/farms';
import { getWorkspace } from '../../services/workspace';
import { focusedResearch } from '../../services/focused-crops';
import { PgMarketOutlookSource } from '../../plans/adapters/market-outlook';
import { createWeatherSource } from '../../plans/adapters/weather-source';
import { loadProviderConfig } from '../../providers/config';
import {
  addDays, alertReviewSpendTodayUsd, groundedReview, istDate, loadPriceMoves, persistAlerts, reviewCrops, structuredAlerts,
  type GroundedReviewResult, type GroundedTransport,
} from '../../services/today/alerts';
import type { JobHandler } from '../main';

/** Small current-price refresh. Only audited commodity mappings are eligible; no inferred products. */
export async function refreshMarket(deps: MonitoringDeps, ownerId: string, farmId: string, candidateProducts?: string[]): Promise<string | null> {
 const result=await currentMandiQuotes({config:deps.config,pool:deps.pool,fetchImpl:deps.fetchImpl as unknown as typeof fetch},ownerId,farmId,{refresh:true,...(candidateProducts?{productIds:candidateProducts}:{})});
 return result.providerStatus!=='ok'&&result.providerStatus!=='not_checked'?result.providerStatus:result.missingReason;
}

export interface MonitorHandlerDeps {
  config: Config; pool: Pool; budget: Budget; fetchImpl?: typeof fetch | undefined;
  /** Meta transport for the grounded review (tests inject one; production builds a MetaClient). */
  metaTransport?: GroundedTransport | undefined;
}

/** Summary stored in farm_monitors.meta_review; field names stay compatible with the existing Outlook panel. */
function reviewRecord(mode: Config['RUNTIME_MODE'], jobId: string, checkedAt: string, r: Pick<GroundedReviewResult, 'status' | 'reason'> & Partial<GroundedReviewResult>) {
  const kept = r.alerts?.length ?? 0, dropped = r.dropped?.length ?? 0;
  const text = r.status === 'completed' ? `News review kept ${kept} cited alert${kept === 1 ? '' : 's'}${dropped ? ` and dropped ${dropped} that failed the citation gate` : ''}.`
    : r.reason === 'daily_cap_reached' || r.reason === 'budget_exceeded' ? 'News review is paused: the daily monitoring spend cap was reached. Weather and price checks still ran.'
    : `News review did not run (${r.reason ?? r.status}).`;
  const dropReasons: Record<string, number> = {};
  for (const d of r.dropped ?? []) dropReasons[d.reason] = (dropReasons[d.reason] ?? 0) + 1;
  return { mode, kind: 'grounded_alert_review', status: r.status, reason: r.reason, traceId: jobId, checkedAt, answerBlocks: [{ text }], limitations: [] as string[],
    alertsKept: kept, alertsDropped: dropped, dropReasons, searchCalls: r.searchCalls ?? 0, searchQueries: r.searchQueries ?? 0, citations: r.citations ?? 0,
    costEstimateUsd: r.estimateUsd ?? null, costSettledUsd: r.settledUsd ?? null, responseDeleted: r.responseDeleted ?? null, model: r.model ?? null };
}

export function createMonitorHandler(deps: MonitorHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const { farmId } = z.object({ farmId: z.uuid() }).parse(job.payload);
    if (!job.owner_id) return { status: 'unavailable', reason: 'owner_missing' };
    const ownerId = job.owner_id;
    const mode = deps.config.RUNTIME_MODE;
    const monitor = (await deps.pool.query<{ enabled: boolean; meta_enabled: boolean; disabled_by_farmer_at: Date | null }>(
      `SELECT m.enabled,m.meta_enabled,m.disabled_by_farmer_at FROM farm_monitors m JOIN farms f ON f.id=m.farm_id JOIN owners o ON o.id=f.owner_id
       WHERE m.farm_id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL AND o.deleted_at IS NULL`, [farmId, ownerId])).rows[0];
    // A farmer's explicit disable is authoritative even if another path left enabled=true.
    if (!monitor?.enabled || monitor.disabled_by_farmer_at || await ctx.isCancelled()) return { status: 'cancelled', reason: 'monitor_disabled_or_farm_missing' };
    await deps.pool.query('UPDATE farm_monitors SET last_attempt_at=now() WHERE farm_id=$1', [farmId]);
    let snapshot: MonitoringSnapshot, changed: boolean, marketRefreshReason: string | null;
    try {
      let keyConfigured = false;
      try { keyConfigured = !!loadProviderConfig().DATA_GOV_IN_API_KEY; } catch { /* remains missing */ }
      const prices = { source: new PgMarketOutlookSource({ pool: deps.pool, mode, keyConfigured }), keyConfigured };
      const snapshotDeps = { config: deps.config, pool: deps.pool, prices, fetchImpl: deps.fetchImpl };
      marketRefreshReason = await refreshMarket(snapshotDeps, ownerId, farmId);
      await ctx.heartbeat(0.3);
      snapshot = await monitoringSnapshot(snapshotDeps, ownerId, farmId);
      ({ changed } = await saveMonitorSnapshot(deps.pool, ownerId, snapshot));
      await deps.pool.query('UPDATE farm_monitors SET market_refresh_reason=$2 WHERE farm_id=$1', [farmId, marketRefreshReason]);
    } catch (e) {
      // Keep the previous successful snapshot and expose a sanitized error, never provider text/keys.
      await deps.pool.query("UPDATE farm_monitors SET last_error='monitor_refresh_failed' WHERE farm_id=$1", [farmId]);
      throw Object.assign(new Error('monitor_refresh_failed'), { retryable: false, cause: {name:e instanceof Error?e.name:'Error',code:typeof(e as {code?:unknown})?.code==='string'?(e as {code:string}).code:'unclassified',constraint:typeof(e as {constraint?:unknown})?.constraint==='string'?(e as {constraint:string}).constraint:null} });
    }
    await ctx.heartbeat(0.5);
    const farm = await getFarm(deps.pool, ownerId, farmId);
    const workspace = await getWorkspace(deps.pool, ownerId, farmId);
    const today = istDate(snapshot.checkedAt);

    // (a) Code-only alerts from the stored forecast, state mandi series and sourced risk windows.
    const alertSummary = { structured: 0, grounded: 0, notes: [] as string[] };
    try {
      const moves = await loadPriceMoves(deps.pool, { mode, productIds: await workspaceMarketProducts(deps.pool, workspace), stateCode: farm?.location.stateCode ?? null, asOf: snapshot.checkedAt });
      const research = await focusedResearch().catch(() => null);
      const structured = structuredAlerts(snapshot, workspace, moves.moves, snapshot.checkedAt, research);
      const saved = await persistAlerts(deps.pool, ownerId, farmId, mode, structured.alerts);
      alertSummary.structured = saved.inserted + saved.updated;
      alertSummary.notes.push(...moves.notes, ...structured.notes);
    } catch {
      alertSummary.notes.push('structured_alerts_failed');
    }

    // (c) Queue missing archive years for this point through the existing ingest.weather_archive job (live only).
    let climatology = 'not_live';
    if (mode === 'live' && snapshot.weather.point) {
      try {
        const source = createWeatherSource({ pool: deps.pool, mode, autoIngest: true, climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
        const clim = await source.getClimatology({ farmId, districtId: farm?.location.districtId ?? null, stateId: farm?.location.stateCode ?? null, point: snapshot.weather.point }, { start: today, end: addDays(today, 30) });
        climatology = clim ? 'available' : 'unavailable_backfill_requested_when_missing';
      } catch { climatology = 'check_failed'; }
    } else if (mode === 'live') climatology = 'no_point';

    // (b) Grounded news review, at most once per farm per 24 h. A session is not required: this is farm-level
    // automatic monitoring authorised by the user on 2026-11-01 (on by default for every farm, one grounded review
    // per farm per day), so spend is attributed to the farm owner and bounded by the owner-day budget limit and the
    // global MONITOR_META_DAILY_CAP_USD, not to the guest session that happened to create the farm.
    let metaStatus: string;
    let record: ReturnType<typeof reviewRecord> | null = null;
    const cap = deps.config.MONITOR_META_DAILY_CAP_USD;
    if (!monitor.meta_enabled) metaStatus = 'not_enabled';
    else if (mode !== 'live') { metaStatus = 'live_mode_required'; record = reviewRecord(mode, job.id, snapshot.checkedAt, { status: 'skipped', reason: metaStatus }); }
    else if (!deps.config.MODEL_API_KEY && !deps.metaTransport) { metaStatus = 'meta_key_missing'; record = reviewRecord(mode, job.id, snapshot.checkedAt, { status: 'skipped', reason: metaStatus }); }
    else if (!reviewCrops(workspace, today).length) { metaStatus = 'no_tracked_crops'; record = reviewRecord(mode, job.id, snapshot.checkedAt, { status: 'skipped', reason: metaStatus }); }
    else if (await alertReviewSpendTodayUsd(deps.pool) >= cap) { metaStatus = 'daily_cap_reached'; record = reviewRecord(mode, job.id, snapshot.checkedAt, { status: 'skipped', reason: metaStatus }); }
    else {
      // Atomic per-farm claim: overlapping jobs cannot both spend; a crashed attempt is not re-spent within 24 h.
      const claim = (await deps.pool.query(`UPDATE farm_monitors SET last_meta_attempt_at=now() WHERE farm_id=$1 AND enabled AND meta_enabled AND disabled_by_farmer_at IS NULL
        AND (last_meta_attempt_at IS NULL OR last_meta_attempt_at<now()-interval '24 hours') AND (last_meta_at IS NULL OR last_meta_at<now()-interval '24 hours') RETURNING farm_id`, [farmId])).rows[0];
      if (!claim) metaStatus = 'daily_limit';
      else if (await ctx.isCancelled()) metaStatus = 'cancelled';
      else {
        let review: GroundedReviewResult;
        try {
          review = await groundedReview({ pool: deps.pool, config: deps.config, budget: deps.budget, transport: deps.metaTransport, fetchImpl: deps.fetchImpl }, { ownerId, farmId, sessionId: null, snapshot, workspace, asOf: snapshot.checkedAt, jobId: job.id });
        } catch {
          review = { status: 'failed', reason: 'review_error', alerts: [], dropped: [], searchCalls: 0, searchQueries: 0, citations: 0, searchSources: 0, estimateUsd: null, settledUsd: null, responseDeleted: null, model: null, usage: null };
        }
        if (review.alerts.length) { const saved = await persistAlerts(deps.pool, ownerId, farmId, mode, review.alerts); alertSummary.grounded = saved.inserted + saved.updated; }
        metaStatus = review.status === 'completed' ? 'completed' : review.reason ?? review.status;
        record = reviewRecord(mode, job.id, snapshot.checkedAt, review);
        if (review.status === 'completed') await deps.pool.query('UPDATE farm_monitors SET last_meta_at=now() WHERE farm_id=$1', [farmId]);
      }
    }
    if (record) await deps.pool.query('UPDATE farm_monitors SET meta_review=$2::jsonb WHERE farm_id=$1', [farmId, JSON.stringify(record)]);
    return { status: 'checked', farmId, changed, checkedAt: snapshot.checkedAt, marketRefreshReason, metaStatus, alerts: alertSummary, climatology };
  };
}
