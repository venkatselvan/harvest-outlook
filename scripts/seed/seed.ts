/** `pnpm db:seed`: load source manifest; in synthetic mode also load synthetic fixtures. */
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";
import { loadProviderConfig } from "../../apps/api/src/providers/config";
import { runSeed } from "../../apps/api/src/ingest/seed";
import { loadCatalogueIntoDb } from "../../apps/api/src/catalogue/load";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = createPool(url);
try {
  const mode = loadProviderConfig().RUNTIME_MODE;
  const r = await runSeed(pool, mode);
  console.log(`db:seed runtime mode: ${r.runtimeMode}`);
  console.log(`source manifest: ${r.manifest.total} records (${r.manifest.inserted} inserted, ${r.manifest.updated} updated)`);
  // Crop catalogue (T06b): public reference data, loaded in every mode, idempotent.
  const cat = await loadCatalogueIntoDb(pool);
  console.log(`catalogue: ${cat.identities} crops (${cat.qualifiedProfiles} qualified), ${cat.products} products, ${cat.evidence} evidence (${cat.evidenceValidated} validated, ${cat.evidenceGrounded} grounded, ${cat.evidencePending} pending), ${cat.rules} rules ${JSON.stringify(cat.rulesByStatus)}, ${cat.stages} stages, ${cat.coverage} coverage rows, ${cat.states} states, ${cat.districts} districts`);
  if (typeof r.fixtures === "string") console.log(`synthetic fixtures: ${r.fixtures}`);
  else {
    console.log(`synthetic market rows: ${r.fixtures.market.inserted} inserted, ${r.fixtures.market.revisions} revisions, ${r.fixtures.market.unchanged} unchanged, ${r.fixtures.market.rejected} rejected (mode=synthetic)`);
    console.log(`synthetic weather: ${r.fixtures.weatherObservations} observations, ${r.fixtures.weatherForecasts} forecast rows (mode=synthetic)`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
