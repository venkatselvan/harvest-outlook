import sharp from 'sharp';
import { z } from 'zod';
import type { FieldPhotoCoverage } from '@harvest/contracts';
import type { WorkerDeps } from './index';
import type { JobHandler } from '../main';
import { samEnvFromConfig } from '../../config';
import { ApiError } from '../../services/errors';
import { readContent } from '../../services/media';
import { getFarm } from '../../services/farms';
import { photoCycle } from '../../services/today/field-photos';
import { stageAt, stageTimeline } from '../../services/today/stage-timeline';
import { BASE_LIMITATIONS, COVERAGE_COLS, NO_SUMMARY_INTERRUPTED, phraseLimitation, writeCoverageSummary, type CoverageRow, type SummaryFacts } from '../../services/today/photo-coverage';
import { agronomyCrop, cropDisplayName, IC_PREFIX, poolEntry } from '../../services/year-plan/data';
import { claimDispatch, finishDispatch } from '../../visuals/dispatch';
import { callSam, SamHttpError } from '../../vision/sam/client';
import { coverageFromSamText } from '../../vision/sam/coverage';
import { samOptionsFromEnv } from '../../vision/sam/options';
import { buildPromptText } from '../../vision/sam/prompt';
import { planSentImage } from '../../vision/sam/transform';

const payloadSchema = z.object({coverageId: z.uuid(), farmId: z.uuid(), cycleId: z.string(), sessionId: z.uuid().nullable()});
const SAM_STAGE = 'photo-coverage-sam';
const SUMMARY_STAGE = 'photo-coverage-summary';

/** True when the crop id is in the shipped catalogue (pool or agronomy data); its display name is then trusted over the farmer's. */
function isCatalogueCrop(cropId: string): boolean {
  try { return poolEntry(cropId) !== null || agronomyCrop(cropId) !== null; } catch { return false; }
}
const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * SAM concept phrase for the crop: "<crop name> plants", else "crop plants" (intercrops, unusable names, over 40 chars).
 * F8: the name is the catalogue display name when the crop is catalogued, otherwise the farmer's name reduced to letters,
 * spaces and hyphens; that sanitised `name` (never the raw farmer text) goes into the Muse facts and the UI label.
 */
export function cropConcept(cropId: string, cropName: string | null | undefined): {text: string; name: string | null; fallback: boolean} {
  if (cropId.startsWith(IC_PREFIX)) return {text: 'crop plants', name: null, fallback: true};
  const source = isCatalogueCrop(cropId) ? cropDisplayName(cropId) : (cropName ?? cropDisplayName(cropId));
  const clean = source.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ').replace(/^-+|-+$/g, '').trim();
  const text = `${clean} plants`;
  if (!clean || text.length > 40) return {text: 'crop plants', name: null, fallback: true};
  return {text, name: clean, fallback: false};
}

/**
 * Concept phrases per class, tried in order until one outlines a region (each attempt is one billed SAM image).
 * Measured live 2026-11-04 on one flooded-paddy photo (docs/BUILD_STATUS.md "Photo coverage"): "standing water", "water",
 * "puddle" -> 0 regions; "muddy water" -> 1 region (conf 0.82, 76 % box); "flooded field" -> 1 region (conf 0.57, 81 %).
 * "weeds", "weed", "unwanted plants" -> 0 regions (no weeds visible); "grass" boxed the crop rows (same 11 boxes as the
 * crop phrase), so it is NOT a weed phrase. Weeds therefore have no fallback. The phrases actually sent are recorded on
 * each class (`phrases`) and stated in the limitations and the Muse facts (F6): the "Standing water" label is a display
 * name, it is never itself sent.
 */
export const WATER_PHRASES: readonly string[] = ['muddy water', 'flooded field'];
export const WEED_PHRASES: readonly string[] = ['weeds'];

/** HTTP failure -> stable retry-classified reason (see canRetryPhotoCoverage). */
function samReason(e: SamHttpError): string {
  if (e.outcomeUnknown) return 'provider_outcome_uncertain';
  if (e.status === 401 || e.status === 403) return 'provider_auth';
  if (e.status === 429) return 'provider_rate_limited';
  if (e.status >= 500 || e.status === 0) return 'provider_server';
  return 'provider_bad_request';
}

type Measurement = {method: 'mask' | 'box'; modelId: string; classes: FieldPhotoCoverage['classes']; limitations: string[]};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * today.photo-coverage. Mirrors worker/handlers/field-photo.ts: reserve -> claimDispatch -> call -> settle/markUncertain/
 * release -> finishDispatch, and never re-dispatch a job that already holds a marker. F1: from loading the photo onwards
 * every outcome is written to the row through `close`; a throw after the SAM marker is claimed marks the SAM reservation
 * uncertain, finishes the marker `uncertain` and closes `failed / interrupted_needs_review`. A throw before that point
 * (nothing sent) releases any reservation and closes `failed / worker_interrupted` (retryable). Rows a worker can never
 * close (job cancelled while queued, lease expired at the maximum attempts) are resolved by staleState() on read and
 * request. F2: once the SAM spend is settled the measured classes are persisted before the summary stage, so a later
 * failure, or a rerun that finds the markers, closes `ready` without a summary instead of `failed`.
 */
export function createPhotoCoverageHandler(deps: WorkerDeps): JobHandler {
  return async (job, ctx) => {
    const {pool, storage, config, budget} = deps;
    const payload = payloadSchema.parse(job.payload);
    if (!job.owner_id) throw Object.assign(new Error('Photo coverage requires an owner'), {retryable: false});
    const ownerId = job.owner_id;
    const row = (await pool.query<CoverageRow>(`SELECT ${COVERAGE_COLS} FROM field_photo_coverage WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4`, [payload.coverageId, ownerId, payload.farmId, payload.cycleId])).rows[0];
    if (!row || row.job_id !== job.id || !['queued', 'running'].includes(row.status)) return {status: 'skipped'};
    let usedContext: {capturedOn: string; cropId: string} | null = null;
    const close = async (status: FieldPhotoCoverage['status'], reason: string | null, result?: Measurement & {summaryModelId: string | null; summary: string | null}) => {
      const r = await pool.query(`UPDATE field_photo_coverage SET status=$3, failure_reason=$4, method=$5, model_id=$6, summary_model_id=$7, classes=$8::jsonb, summary=$9, limitations=$10::jsonb,
          captured_on=COALESCE($11::date, captured_on), crop_id=COALESCE($12, crop_id), updated_at=now()
        WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')`,
        [row.id, job.id, status, reason, result?.method ?? null, result?.modelId ?? null, result?.summaryModelId ?? null, JSON.stringify(result?.classes ?? []), result?.summary ?? null,
          JSON.stringify(result?.limitations ?? BASE_LIMITATIONS), usedContext?.capturedOn ?? null, usedContext?.cropId ?? null]);
      return !!r.rowCount;
    };
    /** Reservations of this job that no dispatch marker references were never sent: release them. */
    const releaseUnmarked = async () => {
      const open = await pool.query<{id: string}>(`SELECT r.id FROM usage_reservations r WHERE r.job_id=$1 AND r.state='reserved'
        AND NOT EXISTS (SELECT 1 FROM job_dispatches d WHERE d.job_id=$1 AND d.reservation_id=r.id)`, [job.id]);
      for (const r of open.rows) await budget.release(r.id).catch(() => undefined);
    };
    // Never re-dispatch a job after a provider call may have happened.
    const markers = await pool.query<{stage_key: string; reservation_id: string | null; outcome: string | null}>('SELECT stage_key, reservation_id, outcome FROM job_dispatches WHERE job_id=$1', [job.id]);
    if (markers.rowCount) {
      for (const m of markers.rows) if (m.reservation_id && (!m.outcome || m.outcome === 'uncertain')) await budget.markUncertain(m.reservation_id).catch(() => undefined);
      await releaseUnmarked();
      // F2: the SAM spend was settled and the classes persisted before the summary stage: keep the measurement.
      const sam = markers.rows.find(m => m.stage_key === SAM_STAGE);
      if (sam?.outcome === 'completed' && row.method && Array.isArray(row.classes) && row.classes.length === 3) {
        const limitations = [...(row.limitations ?? BASE_LIMITATIONS).filter(l => l !== NO_SUMMARY_INTERRUPTED), NO_SUMMARY_INTERRUPTED];
        const saved = await close('ready', null, {method: row.method, modelId: row.model_id ?? config.META_SEGMENT_MODEL, classes: row.classes, limitations, summaryModelId: null, summary: null});
        return {status: saved ? 'ready' : 'skipped', summary: 'none', reason: 'summary_interrupted'};
      }
      await close('failed', 'interrupted_needs_review');
      return {status: 'failed'};
    }
    await releaseUnmarked();
    if (config.RUNTIME_MODE !== 'live' || !config.MODEL_API_KEY) { await close('unavailable', 'provider_unavailable'); return {status: 'unavailable'}; }
    if (await ctx.isCancelled?.()) { await close('unavailable', 'cancelled'); return {status: 'unavailable'}; }

    // Photo, crop and the calendar stage on the photo date (the stage is context for the summary only).
    let media: Awaited<ReturnType<typeof readContent>>;
    let concept: ReturnType<typeof cropConcept>;
    let stageName: string | null = null;
    try {
      const cycle = await photoCycle(pool, {ownerId, farmId: row.farm_id, cycleId: row.cycle_id});
      const photo = (await pool.query<{media_id: string; captured_on: string; sha256: string}>(`SELECT f.media_id, f.captured_on::text, m.sha256 FROM field_photos f JOIN media_objects m ON m.id=f.media_id
        WHERE f.id=$1 AND f.owner_id=$2 AND m.deleted_at IS NULL`, [row.photo_id, ownerId])).rows[0];
      if (!photo || photo.sha256 !== row.media_sha256) { await close('unavailable', 'photo_changed'); return {status: 'unavailable'}; }
      // F5: the row records the photo date and crop this run actually used.
      usedContext = {capturedOn: photo.captured_on, cropId: cycle.cropId};
      concept = cropConcept(cycle.cropId, cycle.cropName);
      try {
        const farm = await getFarm(pool, ownerId, row.farm_id);
        if (farm) {
          const timeline = stageTimeline({cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: cycle.establishmentDate ?? cycle.sowingDate, stateId: farm.location.stateCode, districtId: farm.location.districtId});
          stageName = stageAt(timeline, photo.captured_on).stage?.name ?? null;
        }
      } catch { stageName = null; }
      media = await readContent(pool, storage, ownerId, photo.media_id, 'normalized');
    } catch (e) {
      if (!(e instanceof ApiError)) { await close('failed', 'worker_interrupted').catch(() => undefined); return {status: 'failed', reason: 'worker_interrupted', error: errorText(e)}; }
      await close('unavailable', 'photo_unavailable'); return {status: 'unavailable'};
    }
    const model = config.META_SEGMENT_MODEL;
    const concepts = [
      {key: 'crop' as const, label: concept.name ? `${capitalise(concept.name)} plants` : 'Crop plants', phrases: [concept.text]},
      {key: 'weed' as const, label: 'Weed-like plants', phrases: WEED_PHRASES},
      {key: 'water' as const, label: 'Standing water', phrases: WATER_PHRASES},
    ];
    let plan: ReturnType<typeof planSentImage>, imageDataUrl: string, options: ReturnType<typeof samOptionsFromEnv>;
    let reservationId: string | null = null;
    let unit = 0;
    try {
      options = samOptionsFromEnv(samEnvFromConfig(config));
      const meta = await sharp(Buffer.from(media.data)).metadata().catch(() => null);
      if (!meta?.width || !meta.height) { await close('failed', 'photo_undecodable'); return {status: 'failed'}; }
      plan = planSentImage(meta.width, meta.height, options.maxImageSide);
      const jpeg = await sharp(Buffer.from(media.data)).resize({width: plan.width, height: plan.height, fit: 'fill'}).jpeg({quality: 85}).toBuffer();
      imageDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      unit = budget.estimate('meta', model, {images: 1}).usd ?? 0;
      // Reserve for the worst case (every fallback phrase tried); settle for the calls actually sent.
      const maxCalls = concepts.reduce((n, c) => n + c.phrases.length, 0);
      const estimate = budget.estimate('meta', model, {images: maxCalls}).usd ?? 0;
      try { ({reservationId} = await budget.reserve({ownerId, sessionId: payload.sessionId, provider: 'meta', model, estimate, jobId: job.id, requestId: row.id})); }
      catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'budget_exceeded') throw e;
        await close('unavailable', 'budget_exceeded'); return {status: 'unavailable'};
      }
      if (!await claimDispatch(pool, job.id, SAM_STAGE, reservationId)) {
        await budget.markUncertain(reservationId); await close('failed', 'interrupted_needs_review'); return {status: 'failed'};
      }
    } catch (e) {
      // Nothing was sent: a reservation without a call is released (a marker written just before a lost response still
      // blocks any rerun of this job, which then closes it as interrupted).
      if (reservationId) await budget.release(reservationId).catch(() => undefined);
      await close('failed', 'worker_interrupted').catch(() => undefined);
      return {status: 'failed', reason: 'worker_interrupted', error: errorText(e)};
    }
    const samReservation: string = reservationId;

    let samResolved = false;
    let measurement: Measurement | null = null;
    try {
      await pool.query("UPDATE field_photo_coverage SET status='running', updated_at=now() WHERE id=$1 AND job_id=$2", [row.id, job.id]);
      await ctx.heartbeat(0.1);
      // One entry per concept: the response of the first phrase that outlined something, else the last phrase tried (a valid 0).
      const texts: {text: string; phrases: string[]}[] = [];
      let reason: string | null = null, uncertain = false, lastRequestId: string | null = null, calls = 0;
      const usage: unknown[] = [];
      scan: for (const [i, c] of concepts.entries()) {
        const sent: string[] = [];
        for (const [j, phrase] of c.phrases.entries()) {
          if ((i > 0 || j > 0) && await ctx.isCancelled?.()) { reason = 'cancelled'; break scan; }
          try {
            sent.push(phrase);
            const call = await callSam({baseUrl: config.META_BASE_URL, apiKey: config.MODEL_API_KEY, model, text: buildPromptText({kind: 'concept', text: phrase}, plan), imageDataUrl, options, ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {})});
            calls++; lastRequestId = call.providerRequestId ?? lastRequestId; usage.push(call.usage ?? null);
            const found = coverageFromSamText(call.text, plan).regions > 0;
            if (found || j === c.phrases.length - 1) { texts.push({text: call.text, phrases: [...sent]}); break; }
          } catch (e) {
            if (e instanceof SamHttpError) { uncertain = e.outcomeUnknown; reason = samReason(e); }
            else { uncertain = true; reason = 'provider_outcome_uncertain'; }
            break scan;
          }
        }
        await ctx.heartbeat(0.1 + 0.2 * (i + 1));
      }
      // Settle before publishing anything; a crash must never silently forget a potentially billable call.
      if (uncertain) await budget.markUncertain(samReservation);
      else if (calls) await budget.settle(samReservation, unit * calls, lastRequestId, {images: calls, providerUsage: usage}, 'estimated');
      else await budget.release(samReservation);
      await finishDispatch(pool, job.id, SAM_STAGE, uncertain ? 'uncertain' : calls ? 'completed' : 'failed', lastRequestId);
      samResolved = true;
      if (reason || texts.length !== concepts.length) {
        await close(reason === 'cancelled' ? 'unavailable' : 'failed', reason ?? 'provider_incomplete');
        return {status: 'failed', reason};
      }

      const measured = concepts.map((c, i) => ({...coverageFromSamText(texts[i]!.text, plan), key: c.key, label: c.label, phrases: texts[i]!.phrases}));
      const method: 'mask' | 'box' = measured.every(m => m.method === 'mask' || m.regions === 0) && measured.some(m => m.method === 'mask') ? 'mask' : 'box';
      const classes: FieldPhotoCoverage['classes'] = measured.map(m => ({key: m.key, label: m.label, fraction: m.fraction, regions: m.regions, confidence: m.confidence, phrases: m.phrases}));
      const limitations = [...BASE_LIMITATIONS, phraseLimitation(classes)];
      if (concept.fallback) limitations.push('The crop was searched as "crop plants" because the crop name could not be used as a search phrase.');
      if (measured.some(m => m.skipped.length)) limitations.push('Some outlined regions were left out because their coordinates did not match the photo size.');
      measurement = {method, modelId: model, classes, limitations};
      // F2: persist the paid measurement before the summary stage (status stays running until close).
      await pool.query(`UPDATE field_photo_coverage SET method=$3, model_id=$4, classes=$5::jsonb, limitations=$6::jsonb, captured_on=$7::date, crop_id=$8, updated_at=now()
        WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')`, [row.id, job.id, method, model, JSON.stringify(classes), JSON.stringify(limitations), usedContext!.capturedOn, usedContext!.cropId]);

      // Muse Spark: numbers in, words out. A missing summary never hides the measurement.
      let summary: string | null = null, summaryModelId: string | null = null;
      const finalLimitations = [...limitations];
      if (await ctx.isCancelled?.()) finalLimitations.push('No written summary: the request was cancelled.');
      else {
        const facts: SummaryFacts = {cropName: concept.name, stageName, method, classes: measured.map(m => ({key: m.key, label: m.label, fraction: m.fraction, regions: m.regions, phrases: m.phrases}))};
        const s = await writeCoverageSummary({config, budget, ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {})}, {ownerId, sessionId: payload.sessionId, jobId: job.id, requestId: `${row.id}:summary`, facts,
          onDispatch: reservation => claimDispatch(pool, job.id, SUMMARY_STAGE, reservation)});
        if (s.dispatched) await finishDispatch(pool, job.id, SUMMARY_STAGE, s.uncertain ? 'uncertain' : s.model ? 'completed' : 'failed', s.requestId).catch(() => undefined);
        if (s.text) { summary = s.text; summaryModelId = s.model; }
        else finalLimitations.push('No written summary: the AI summary could not be produced or did not pass the safety checks.');
      }
      await ctx.heartbeat(0.95);
      const stillCurrent = (await pool.query('SELECT 1 FROM field_photos WHERE id=$1', [row.photo_id])).rowCount;
      if (!stillCurrent) return {status: 'skipped', reason: 'photo_removed'};
      const saved = await close('ready', null, {...measurement, limitations: finalLimitations, summaryModelId, summary});
      await ctx.heartbeat(1);
      return {status: saved ? 'ready' : 'skipped', method, summary: summary ? 'model' : 'none'};
    } catch (e) {
      if (!samResolved) {
        // A SAM call may have been sent: keep its reservation as uncertain and never re-dispatch this job.
        await budget.markUncertain(samReservation).catch(() => undefined);
        await finishDispatch(pool, job.id, SAM_STAGE, 'uncertain').catch(() => undefined);
        await close('failed', 'interrupted_needs_review').catch(() => undefined);
        return {status: 'failed', reason: 'interrupted_needs_review', error: errorText(e)};
      }
      if (measurement) {
        await close('ready', null, {...measurement, limitations: [...measurement.limitations, NO_SUMMARY_INTERRUPTED], summaryModelId: null, summary: null}).catch(() => undefined);
        return {status: 'ready', summary: 'none', reason: 'summary_interrupted', error: errorText(e)};
      }
      await close('failed', 'interrupted_needs_review').catch(() => undefined);
      return {status: 'failed', reason: 'interrupted_needs_review', error: errorText(e)};
    }
  };
}
