import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import { agentEnvFromConfig } from "../config";
import type { Pool } from "../db/pool";
import { loadAgentLimits } from "../agent/limits";
import type { ToolBindings } from "../agent/tools/registry";
import { PlanService, registerPlanRoutes } from "../plans";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import type { Budget } from "../services/budget";
import { runIdempotent } from "../services/idempotency";
import type { StorageAdapter } from "../storage/types";
import type { JournalService } from "../journal";
import { registerJournalRoutes } from "./journal";
import { registerCropRoutes } from "./crops";
import type { PriceDeps } from "../plans/adapters/market-outlook";
import { registerVisualRoutes } from "./visuals";
import type { CatalogueStore } from "../catalogue/snapshot";
import { farmRoutes } from "./farms";
import { jobRoutes } from "./jobs";
import { mediaRoutes } from "./media";
import { registerAssistantRoutes, type AssistantRouteDeps } from "./assistant";
import { sessionRoutes } from "./session";
import { registerSpeechRoutes, type SpeechRouteDeps } from "./speech";
import { registerVisionRoutes } from "./vision";
import type { FetchLike } from '../ingest/http';
import {commodityCatalogueRoutes} from './commodity-catalogue';
import {soilReportRoutes} from './soil-reports';
import {yearPlanRoutes} from './year-plan';
import {boundaryContextRoutes} from './boundary-context';
import {aiActivityRoutes} from './ai-activity';
import {demoFarmRoutes} from './demo-farm';
import {commandCenterRoutes} from './command-center';
import {registerMarketContextRoutes} from './market-context';
import {todayRoutes, type TodayRouteDeps} from './today';
import {todayNdviRoutes, type TodayNdviDeps} from './today-ndvi';
import {todayAlertRoutes, type TodayAlertRouteDeps} from './today-alerts';
import {todayTimelineRoutes, type TodayTimelineDeps} from './today-timeline';
import {todayFutureRoutes, type TodayFutureDeps} from './today-future';
import {priceSeriesRoutes} from './price-series';
import {marketTimelineRoutes} from './market-timeline';
import {cropFitRoutes} from './crop-fit';
import {soilReviewRoutes} from './soil-review';

export interface RouteDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
  /** The single Budget instance for the whole app (limits and price table are shared). */
  budget: Budget;
  plans: PlanService;
  journal: JournalService;
  catalogue?: Pick<CatalogueStore, "get"> | undefined;
  /** Historical price reference wiring for the comparison endpoint. */
  prices?: PriceDeps | undefined;
  /** Merged over the T09 bindings by the assistant plugin. */
  toolBindings: ToolBindings;
  /** Test/override hooks; production passes none. */
  assistant?: Partial<AssistantRouteDeps> | undefined;
  speech?: Partial<Omit<SpeechRouteDeps, "pool">> | undefined;
  weatherFetch?: FetchLike | undefined;
  /** Test hooks for the Today view plugins (clocks, provider fetch seams, injected timelines); production passes none. Applied after the defaults. */
  today?: {
    view?: Partial<Omit<TodayRouteDeps, "config" | "pool">>;
    ndvi?: Partial<Omit<TodayNdviDeps, "config" | "pool" | "storage">>;
    alerts?: Partial<Omit<TodayAlertRouteDeps, "config" | "pool">>;
    timeline?: Partial<Omit<TodayTimelineDeps, "config" | "pool">>;
    future?: Partial<Omit<TodayFutureDeps, "config" | "pool" | "storage">>;
  } | undefined;
}

/**
 * Each plugin is encapsulated so its auth/CSRF onRequest hook only covers its own routes.
 * Every private plugin installs `privateRouteGuard` (origin -> session -> CSRF) before any handler or body parsing.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, pool } = deps;
  await app.register(sessionRoutes, { config, pool });
  await app.register(farmRoutes, { config, pool, storage: deps.storage, prices: deps.prices, weatherFetch: deps.weatherFetch,yearPlan:{config,pool,budget:deps.budget,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})} });
  await app.register(commodityCatalogueRoutes,{config,pool});
  await registerMarketContextRoutes(app,{config});
  await app.register(commandCenterRoutes,{config,pool});
  await app.register(soilReportRoutes,{config,pool,storage:deps.storage,budget:deps.budget,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})});
  // Stream A: year plan (UI_BRIEF section 4); its job type farm.year-plan is registered in worker/handlers/index.ts.
  await app.register(yearPlanRoutes,{config,pool,budget:deps.budget,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})});
  await app.register(boundaryContextRoutes,{config,pool,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})});
  await app.register(aiActivityRoutes,{config,pool});
  await app.register(demoFarmRoutes,{config,pool});
  await app.register(mediaRoutes, { config, pool, storage: deps.storage });
  await app.register(jobRoutes, { config, pool });
  // Stream B: Today view (UI_BRIEF section 4) and the wholesale price reads. The weather seam only reaches the plugins that call Open-Meteo;
  // the NDVI and future-look plugins talk to Planetary Computer through their own Sentinel2Fetch seam, which tests inject at the plugin.
  await app.register(todayRoutes,{config,pool,...(deps.weatherFetch?{weatherFetch:deps.weatherFetch}:{}),...deps.today?.view});
  await app.register(todayNdviRoutes,{config,pool,storage:deps.storage,...deps.today?.ndvi});
  await app.register(todayAlertRoutes,{config,pool,...deps.today?.alerts});
  await app.register(todayTimelineRoutes,{config,pool,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch}:{}),...deps.today?.timeline});
  await app.register(todayFutureRoutes,{config,pool,storage:deps.storage,...deps.today?.future});
  await app.register(priceSeriesRoutes,{config,pool});
  // Round 2 (docs/research/ROUND2_SPEC.md sections 3 to 5): market timeline, crop fit v2, soil review. Job types farm.crop-fit,
  // farm.soil-review and today.outlook-note are registered in worker/handlers/index.ts.
  await app.register(marketTimelineRoutes,{config,pool,...(deps.weatherFetch?{weatherFetch:deps.weatherFetch}:{})});
  await app.register(cropFitRoutes,{config,pool,budget:deps.budget,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})});
  await app.register(soilReviewRoutes,{config,pool,budget:deps.budget,...(deps.weatherFetch?{fetchImpl:deps.weatherFetch as unknown as typeof fetch}:{})});

  await registerPlanRoutes(app, {
    config,
    service: deps.plans,
    pool,
    resolveOwner: (req) => requireAuth(req).ownerId,
    onRequest: privateRouteGuard(config, pool),
    idempotency: { run: (o, exec) => runIdempotent(pool, o, exec) },
  });

  await app.register(registerAssistantRoutes, {
    config,
    pool,
    budget: deps.budget,
    toolBindings: deps.toolBindings,
    limits: loadAgentLimits(agentEnvFromConfig(config)),
    fixtureScenario: config.AGENT_FIXTURE_SCENARIO,
    ...deps.assistant,
  });
  await app.register(registerVisionRoutes, { config, pool, storage: deps.storage });
  await registerSpeechRoutes(app, { config, pool,budget:deps.budget, ...deps.speech });

  await registerCropRoutes(app, { config, pool, ...(deps.catalogue ? { store: deps.catalogue } : {}), ...(deps.prices ? { prices: deps.prices } : {}) });
  await app.register(registerVisualRoutes, { config, pool, storage: deps.storage });
  await registerJournalRoutes(app, {
    config,
    service: deps.journal,
    resolveOwner: (req) => requireAuth(req).ownerId,
    onRequest: privateRouteGuard(config, pool),
    resolveSession: (req) => requireAuth(req).sessionId,
    idempotency: { run: (o, e) => runIdempotent(pool, o, e) },
  });
}
