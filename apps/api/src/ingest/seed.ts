import type { Pool } from "../db/pool";
import { loadSyntheticFixtures, type FixtureCounts } from "./fixtures";
import { loadManifest } from "./manifest";

export interface SeedResult {
  runtimeMode: string;
  manifest: { total: number; inserted: number; updated: number };
  fixtures: FixtureCounts | "skipped (fixtures load only when RUNTIME_MODE=synthetic)";
}

/** Manifests always; synthetic fixtures only in synthetic mode (never live or replay). */
export async function runSeed(pool: Pool, runtimeMode: string): Promise<SeedResult> {
  const manifest = await loadManifest(pool);
  const fixtures = runtimeMode === "synthetic" ? await loadSyntheticFixtures(pool, runtimeMode) : "skipped (fixtures load only when RUNTIME_MODE=synthetic)";
  return { runtimeMode, manifest, fixtures };
}
