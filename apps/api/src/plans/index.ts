// T08 plan engine: service layer shared by API routes and future agent tools.
export * from "./types";
export * from "./sources";
export * from "./errors";
export { PlanService, uuidFromSeed, type PlanView, type TimelineView, type ChangeSummary, type PlanServiceOptions } from "./engine";
export { registerPlanRoutes, type PlanRouteDeps } from "./routes";
export type { TimelineDay } from "./timeline";
export { composeWeather, regionDate, type ComposedWeather } from "./weather";
