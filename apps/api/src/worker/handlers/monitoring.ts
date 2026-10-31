import {currentMandiQuotes} from '../../services/market-quotes';
import { z } from 'zod';
import type { Config } from '../../config';
import { agentEnvFromConfig } from '../../config';
import type { Pool } from '../../db/pool';
import type { Budget } from '../../services/budget';
import { monitoringSnapshot, workspaceMarketProducts, type MonitoringDeps } from '../../services/monitoring';
import { monitorFingerprint, saveMonitorSnapshot } from '../../services/monitor-schedule';
import { getFarm } from '../../services/farms';
import { getWorkspace } from '../../services/workspace';
import { PgMarketOutlookSource, stateNameFor } from '../../plans/adapters/market-outlook';
import { loadProviderConfig } from '../../providers/config';
import { fetchMandiPrices } from '../../providers/datagovin/client';
import { loadCommodityMap, normalizeMandiRecords } from '../../providers/datagovin/normalize';
import { ensureSource, MANDI_RESOURCES } from '../../ingest/sources';
import { storeMarketRows } from '../../ingest/market-store';
import { runAgentTurn } from '../../agent/loop';
import { loadAgentLimits } from '../../agent/limits';
import { selectProvider } from '../../agent/provider';
import { implementedBindings } from '../../agent/tools/handlers';
import { ToolRegistry } from '../../agent/tools/registry';
import type { JobHandler } from '../main';

/** Small current-price refresh. Only audited commodity mappings are eligible; no inferred products. */
export async function refreshMarket(deps: MonitoringDeps, ownerId: string, farmId: string, candidateProducts?: string[]): Promise<string | null> {
 const result=await currentMandiQuotes({config:deps.config,pool:deps.pool,fetchImpl:deps.fetchImpl as unknown as typeof fetch},ownerId,farmId,{refresh:true,...(candidateProducts?{productIds:candidateProducts}:{})});
 return result.providerStatus!=='ok'&&result.providerStatus!=='not_checked'?result.providerStatus:result.missingReason;
}

export function createMonitorHandler(deps: { config: Config; pool: Pool; budget: Budget; fetchImpl?: typeof fetch | undefined; review?: typeof runAgentTurn }): JobHandler {
  return async (job, ctx) => {
    const { farmId } = z.object({ farmId: z.uuid() }).parse(job.payload);
    if (!job.owner_id) return { status: 'unavailable', reason: 'owner_missing' };
    const ownerId = job.owner_id;
    const monitor = (await deps.pool.query<{ enabled: boolean; meta_enabled: boolean; session_id: string | null; last_meta_at: Date | null; last_meta_attempt_at: Date | null; reviewed_fingerprint: string | null }>(
      `SELECT m.enabled,m.meta_enabled,m.session_id,m.last_meta_at,m.last_meta_attempt_at,m.reviewed_fingerprint FROM farm_monitors m JOIN farms f ON f.id=m.farm_id JOIN owners o ON o.id=f.owner_id
       WHERE m.farm_id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL AND o.deleted_at IS NULL`, [farmId, ownerId])).rows[0];
    if (!monitor?.enabled || await ctx.isCancelled()) return { status: 'cancelled', reason: 'monitor_disabled_or_farm_missing' };
    await deps.pool.query('UPDATE farm_monitors SET last_attempt_at=now() WHERE farm_id=$1', [farmId]);
    try {
      let keyConfigured = false;
      try { keyConfigured = !!loadProviderConfig().DATA_GOV_IN_API_KEY; } catch { /* remains missing */ }
      const prices = { source: new PgMarketOutlookSource({ pool: deps.pool, mode: deps.config.RUNTIME_MODE, keyConfigured }), keyConfigured };
      const snapshotDeps = { config: deps.config, pool: deps.pool, prices, fetchImpl: deps.fetchImpl };
      const marketRefreshReason = await refreshMarket(snapshotDeps, ownerId, farmId);
      await ctx.heartbeat(0.3);
      const snapshot = await monitoringSnapshot(snapshotDeps, ownerId, farmId);
      const { changed } = await saveMonitorSnapshot(deps.pool, ownerId, snapshot);
      await deps.pool.query('UPDATE farm_monitors SET market_refresh_reason=$2 WHERE farm_id=$1', [farmId, marketRefreshReason]);
      let metaStatus = 'not_requested';
      const fingerprint = monitorFingerprint(snapshot);
      const needsReview = fingerprint !== monitor.reviewed_fingerprint;
      const recentlyReviewed = monitor.last_meta_attempt_at && Date.now() - monitor.last_meta_attempt_at.getTime() < 24 * 3600_000;
      if (monitor.meta_enabled && needsReview && !recentlyReviewed && deps.config.RUNTIME_MODE === 'live') {
        // Re-check opt-in/session just before provider spend. An expired guest session cannot incur new spend.
        const claim = (await deps.pool.query<{ session_id: string }>(`UPDATE farm_monitors m SET last_meta_attempt_at=now() FROM sessions s
          WHERE m.session_id=s.id AND m.farm_id=$1 AND m.enabled AND m.meta_enabled AND s.owner_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND (m.last_meta_attempt_at IS NULL OR m.last_meta_attempt_at<now()-interval '24 hours') RETURNING m.session_id`, [farmId, ownerId])).rows[0];
        if (claim && !await ctx.isCancelled()) {
          const bindings = implementedBindings();
          const registry = new ToolRegistry({ get_farm_context: bindings.get_farm_context!, retrieve_evidence: bindings.retrieve_evidence!, resolve_crop_identity: bindings.resolve_crop_identity! });
          const result = await (deps.review ?? runAgentTurn)({ pool: deps.pool, budget: deps.budget,
            provider: selectProvider({ mode: 'live', apiKey: deps.config.MODEL_API_KEY, baseUrl: deps.config.META_BASE_URL, fixture: () => { throw new Error('monitor_fixtures_disabled'); }, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }),
            registry, limits: loadAgentLimits(agentEnvFromConfig(deps.config), { maxToolRounds: 2, maxToolCalls: 4, maxWonderEscalations: 0, wonderEnabled: false, maxRepairAttempts: 1 }),
            models: { text: deps.config.META_TEXT_MODEL, escalation: deps.config.META_ESCALATION_MODEL }, signal: AbortSignal.timeout(90_000),
          }, { ownerId, sessionId: claim.session_id, mode: 'live', requestId: job.id, language: 'en', farmId,
            text: 'Perform the scheduled farm monitoring review. Call get_farm_context to read farmer-reported crop history and server-recorded monitoring references. Assess the latest dated conditions that merit farmer attention; do not claim to have compared previous conditions. Weather is a gridded forecast, mandi values are dated wholesale observations. Keep stale/missing states explicit. Cite all quantities through numericRefs to the tool result and retrieve evidence before agronomic claims. Do not infer crop disease, fertilizer dose, validated rotation suitability or farm yield. Do not change plans. Explain briefly if no actionable advice can be verified.',
          });
          metaStatus = result.status;
          await deps.pool.query('UPDATE farm_monitors SET last_meta_at=now(),meta_review=$2::jsonb,reviewed_fingerprint=$3 WHERE farm_id=$1', [farmId, JSON.stringify({ mode: deps.config.RUNTIME_MODE, status: result.status, traceId: result.runId, answerBlocks: result.approved.answerBlocks, limitations: result.limitations, checkedAt: snapshot.checkedAt }), fingerprint]);
        } else metaStatus = 'session_expired_or_monitor_disabled';
      } else if (monitor.meta_enabled) metaStatus = recentlyReviewed ? 'daily_limit' : !needsReview ? 'unchanged' : 'live_mode_required';
      return { status: 'checked', farmId, changed, checkedAt: snapshot.checkedAt, marketRefreshReason, metaStatus };
    } catch (e) {
      // Keep the previous successful snapshot and expose a sanitized error, never provider text/keys.
      await deps.pool.query("UPDATE farm_monitors SET last_error='monitor_refresh_failed' WHERE farm_id=$1", [farmId]);
      throw Object.assign(new Error('monitor_refresh_failed'), { retryable: false, cause: {name:e instanceof Error?e.name:'Error',code:typeof(e as {code?:unknown})?.code==='string'?(e as {code:string}).code:'unclassified',constraint:typeof(e as {constraint?:unknown})?.constraint==='string'?(e as {constraint:string}).constraint:null} });
    }
  };
}
