// Loads the crop catalogue into Postgres (idempotent). Usage: DATABASE_URL=... pnpm --filter @harvest/api exec tsx ../../scripts/catalogue/load-db.ts
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";
import { loadCatalogueIntoDb } from "../../apps/api/src/catalogue/load";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = createPool(url);
try {
  console.log(JSON.stringify(await loadCatalogueIntoDb(pool), null, 1));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
