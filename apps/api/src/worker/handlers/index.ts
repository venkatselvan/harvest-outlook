import type { Config } from "../../config";
import { samEnvFromConfig } from "../../config";
import type { Pool } from "../../db/pool";
import type { Budget } from "../../services/budget";
import type { StorageAdapter } from "../../storage/types";
import { samOptionsFromEnv } from "../../vision/sam/options";
import { registerSegmentationHandler } from "../../vision/jobs/segmentation";
import type { JobHandler } from "../main";
import { createIngestHandlers } from "./ingest";

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
  const { config, pool, storage, budget } = deps;
  // T10: vision.segment. Returns status 'unavailable' without any network call in synthetic/replay mode or without a credential.
  registerSegmentationHandler(registry, { pool, config, storage, budget, options: samOptionsFromEnv(samEnvFromConfig(config)), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  // INT2: register T11 visual handlers here (e.g. visuals.keyframes) once src/visuals/** exposes registerVisualHandlers.
}
