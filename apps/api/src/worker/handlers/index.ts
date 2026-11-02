import type { Config } from "../../config";
import { samEnvFromConfig } from "../../config";
import type { Pool } from "../../db/pool";
import type { Budget } from "../../services/budget";
import type { StorageAdapter } from "../../storage/types";
import { samOptionsFromEnv } from "../../vision/sam/options";
import { registerSegmentationHandler } from "../../vision/jobs/segmentation";
import { registerVisualHandlers } from "../../visuals";
import { PlanService, unavailableOutlookSource } from "../../plans";
import { journalTaskCompletionSource, registerJournalHandlers } from "../../journal";
import { PgVisualAssetSource } from "../../visuals";
import { createWeatherSource } from "../../plans/adapters/weather-source";
import type { JobHandler } from "../main";
import { createIngestHandlers } from "./ingest";
import {createSoilHandler} from './soil-reports';
import { createYearPlanHandler } from './year-plan';
import { createMonitorHandler } from './monitoring';
import { createFutureLookHandler } from './future-look';
import { createOutlookNoteHandler, OUTLOOK_NOTE_JOB_TYPE } from './outlook-note';
import { createTodayOverviewHandler, TODAY_OVERVIEW_JOB_TYPE } from './today-overview';
import { createCropFitHandler, CROP_FIT_JOB_TYPE } from './crop-fit';
import { createSoilReviewHandler, SOIL_REVIEW_JOB_TYPE } from './soil-review';
import {withModelActivity} from '../../services/model-activity';

/** Job-type -> handler registry for T05a. Imported by worker/main.ts. */
export const ingestHandlers = createIngestHandlers();

export interface WorkerDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
  budget: Budget;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Registers handlers that need the shared config/pool/storage/budget (everything except the dependency-free
 * ingest handlers). Called once by the worker entry point after configuration is loaded.
 */
export function registerWorkerHandlers(registry: Record<string, JobHandler>, deps: WorkerDeps): void {
  const previous=new Map(Object.entries(registry));
  const { config, pool, storage, budget } = deps;
  registry['soil.extract']=createSoilHandler({config,pool,storage,budget,...(deps.fetchImpl?{fetchImpl:deps.fetchImpl}:{})});
  registry['farm.year-plan'] = createYearPlanHandler({ config, pool, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  registry['farm.monitor'] = createMonitorHandler({ config, pool, budget, fetchImpl: deps.fetchImpl });
  registry['today.future-look'] = createFutureLookHandler({ config, pool, storage, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  // Round 2 (docs/research/ROUND2_SPEC.md): harvest outlook note, crop fit review (soil review is added when its handler lands).
  registry[OUTLOOK_NOTE_JOB_TYPE] = createOutlookNoteHandler({ config, pool, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  // TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 9: the Today overview.
  registry[TODAY_OVERVIEW_JOB_TYPE] = createTodayOverviewHandler({ config, pool, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  registry[CROP_FIT_JOB_TYPE] = createCropFitHandler({ config, pool, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  registry[SOIL_REVIEW_JOB_TYPE] = createSoilReviewHandler({ config, pool, budget, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  // T10: vision.segment. Returns status 'unavailable' without any network call in synthetic/replay mode or without a credential.
  registerSegmentationHandler(registry, { pool, config, storage, budget, options: samOptionsFromEnv(samEnvFromConfig(config)), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  registerVisualHandlers(registry, { pool, config, storage, budget });
  // T13: journal.analysis. The worker needs its own PlanService to validate proposals against the plan.
  const plans = new PlanService({
    pool,
    mode: config.RUNTIME_MODE,
    sources: {
      weather: createWeatherSource({ pool, mode: config.RUNTIME_MODE, climatologyYears: config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: config.WEATHER_CLIMATOLOGY_END_YEAR, autoIngest: false }),
      visuals: new PgVisualAssetSource(pool),
      completions: journalTaskCompletionSource(pool),
      outlook: unavailableOutlookSource("price_access_key_gated"),
    },
  });
  registerJournalHandlers(registry as never, { pool, config, storage, budget, plans, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  for(const[name,handler]of Object.entries(registry)){
    if(previous.get(name)===handler)continue;
    registry[name]=(job,ctx)=>{
      if(!job.owner_id)return handler(job,ctx);
      const payload=job.payload as {sessionId?:unknown}|null;
      const sessionId=name==='farm.monitor'?null:typeof payload?.sessionId==='string'&&/^[0-9a-f-]{36}$/i.test(payload.sessionId)?payload.sessionId:null;
      return withModelActivity({pool,ownerId:job.owner_id,sessionId,mode:config.RUNTIME_MODE,purpose:name},()=>handler(job,ctx));
    };
  }
}
