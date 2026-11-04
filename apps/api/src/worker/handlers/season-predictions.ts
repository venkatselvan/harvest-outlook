import { z } from 'zod';
import type { WorkerDeps } from './index';
import type { JobHandler } from '../main';
import { seasonEvidence } from '../../services/today/season-predictions';
import { photoToday, requestPhotoPrediction } from '../../services/today/field-photos';
import { requestFutureLook } from '../../services/today/future-look';
import { ApiError } from '../../services/errors';
const payload = z.object({farmId:z.uuid(), cycleId:z.string(), revision:z.string(), sessionId:z.uuid().nullable()});
export function createSeasonPredictionsHandler(deps: WorkerDeps): JobHandler {
  return async (job, ctx) => {
    if (!job.owner_id || deps.config.RUNTIME_MODE !== 'live' || !deps.config.MODEL_API_KEY) return {status:'unavailable'};
    const p = payload.parse(job.payload), scope = {ownerId:job.owner_id, farmId:p.farmId, cycleId:p.cycleId};
    const evidence = await seasonEvidence(deps.pool, scope);
    if (evidence.revision !== p.revision) return {status:'superseded'};
    const horizon = new Date(Date.parse(photoToday()) + 120 * 86400000).toISOString().slice(0,10);
    const results: {date:string; name:string; kind:string; status:string; reason?:string|undefined; id?:string|null}[] = [];
    // Journal observation dates also receive retrospective estimates from prior evidence, clearly distinct from preserved forecasts.
    const targets = [...evidence.milestones, ...evidence.journals.filter(j => !evidence.milestones.some(m => m.date === j.entry_date)).map(j => ({date:j.entry_date,name:'Journal observation',id:j.id}))];
    for (const target of targets) {
      if (await ctx.isCancelled?.()) return {status:'cancelled', results};
      for (const kind of ['photo','satellite'] as const) {
        const photo = evidence.photos.find(photo => photo.captured_on < target.date);
        const sourceDate = kind === 'photo' ? photo?.captured_on : evidence.satellite?.date;
        if (!sourceDate || sourceDate >= target.date || target.date > horizon) {
          results.push({...target,kind,status:'deferred',reason:target.date > horizon ? 'outside_forecast_horizon' : 'no_earlier_source'}); continue;
        }
        try {
          const result = kind === 'photo'
            ? await requestPhotoPrediction({...deps, revision:p.revision, auto:true},scope,photo!.id,target.date,p.sessionId)
            : await requestFutureLook(deps,scope.ownerId,p.farmId,{itemId:evidence.satellite!.item_id,kind:'gap',targetDate:target.date,cycleId:p.cycleId,sessionId:p.sessionId,milestoneRevision:p.revision});
          results.push({date:target.date,name:target.name,kind,status:result.status,id:'id' in result ? result.id : result.assetId,reason:('failureReason' in result ? result.failureReason : result.reason) ?? undefined});
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          results.push({date:target.date,name:target.name,kind,status:'unavailable',reason:e.code});
        }
      }
      await ctx.heartbeat((targets.indexOf(target)+1)/targets.length);
    }
    return {status:'scheduled',revision:p.revision,results};
  };
}
