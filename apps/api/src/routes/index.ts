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
import { registerVisualRoutes } from "./visuals";
import type { CatalogueStore } from "../catalogue/snapshot";
import { farmRoutes } from "./farms";
import { jobRoutes } from "./jobs";
import { mediaRoutes } from "./media";
import { registerAssistantRoutes, type AssistantRouteDeps } from "./assistant";
import { sessionRoutes } from "./session";
import { registerSpeechRoutes, type SpeechRouteDeps } from "./speech";
import { registerVisionRoutes } from "./vision";

export interface RouteDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
  /** The single Budget instance for the whole app (limits and price table are shared). */
  budget: Budget;
  plans: PlanService;
  journal: JournalService;
  catalogue?: Pick<CatalogueStore, "get"> | undefined;
  /** Merged over the T09 bindings by the assistant plugin. */
  toolBindings: ToolBindings;
  /** Test/override hooks; production passes none. */
  assistant?: Partial<AssistantRouteDeps> | undefined;
  speech?: Partial<Omit<SpeechRouteDeps, "pool">> | undefined;
}

/**
 * Each plugin is encapsulated so its auth/CSRF onRequest hook only covers its own routes.
 * Every private plugin installs `privateRouteGuard` (origin -> session -> CSRF) before any handler or body parsing.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, pool } = deps;
  await app.register(sessionRoutes, { config, pool });
  await app.register(farmRoutes, { config, pool, storage: deps.storage });
  await app.register(mediaRoutes, { config, pool, storage: deps.storage });
  await app.register(jobRoutes, { config, pool });

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
  await registerSpeechRoutes(app, { config, pool, ...deps.speech });

  await registerCropRoutes(app, { config, pool, ...(deps.catalogue ? { store: deps.catalogue } : {}) });
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
