/**
 * L2: ingest real Karnataka ginger mandi prices from the data.gov.in VARIETY-WISE resource (history back to 2002/2014).
 *
 *   pnpm ingest:ginger-ka [-- --products "Ginger(Green),Ginger(Dry)" --max-pages 60 --start-offset 0 --dry-run]
 *   pnpm ingest:ginger-ka -- --products "Ginger(Green)" --markets "Belur|Belur APMC" --max-pages 10 --label markets
 *
 * T07b extension: --markets adds filters[Market] (exact source name; "|"-separated because names contain commas) and
 * loops products x markets under the same global page cap; --label makes the summary filename unique so a later run
 * never overwrites an earlier run's summary.
 *
 * - Capitalised fields (Arrival_Date, Modal_Price ...) and filters[State]/filters[Commodity] (exact case).
 * - The API cannot filter by date range and its default order is NOT chronological (observed), and
 *   sort[Arrival_Date] sorts the dd/mm/yyyy STRING, so paging is in offset order. Resumable with --start-offset.
 * - Global page/row cap (default 60 pages, 60,000 rows; env DATA_GOV_IN_MAX_PAGES/RECORDS must allow it).
 * - Dedup by (market, product, date, variety, grade) across pages; identical repeats ignored, conflicting repeats
 *   keep the first report and are counted. Stored via the vintage market store with available_at = fetch time
 *   (upper bound): flag availability_basis:conservative_upper_bound; the source publishes no first-seen time.
 * - Unit: field metadata states none; INR/quintal is the Agmarknet convention (flag unit_basis:...), converted
 *   to INR/kg by @harvest/domain with both stored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";
import { storeMarketRows, type MarketStoreCounts } from "../../apps/api/src/ingest/market-store";
import { finishRun, payloadHash, startRun } from "../../apps/api/src/ingest/runs";
import { ensureSource, MANDI_RESOURCES } from "../../apps/api/src/ingest/sources";
import { loadProviderConfig } from "../../apps/api/src/providers/config";
import { fetchMandiPrices } from "../../apps/api/src/providers/datagovin/client";
import { normalizeMandiRecords, type MandiRow } from "../../apps/api/src/providers/datagovin/normalize";

const RESOURCE = "35985678-0d79-46b4-9ed6-6f13308a1d24";
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const products = arg("products", "Ginger(Green),Ginger(Dry)").split(",").map((s) => s.trim()).filter(Boolean);
const state = arg("state", "Karnataka");
const maxPages = Number(arg("max-pages", "60"));
const startOffset = Number(arg("start-offset", "0"));
const dryRun = process.argv.includes("--dry-run");
const markets = arg("markets", "").split("|").map((s) => s.trim()).filter(Boolean);
const label = arg("label", "").replace(/[^a-z0-9-]/gi, "");

const config = loadProviderConfig();
if (!config.DATA_GOV_IN_API_KEY) {
  console.log("DATA_GOV_IN_API_KEY is not set: unavailable (api_key_missing). No request made.");
  process.exit(0);
}
if (config.DATA_GOV_IN_MAX_PAGES < maxPages || config.DATA_GOV_IN_MAX_RECORDS < maxPages * 1000) {
  console.error(`Refusing: set DATA_GOV_IN_MAX_PAGES>=${maxPages} and DATA_GOV_IN_MAX_RECORDS>=${maxPages * 1000} for this run (currently ${config.DATA_GOV_IN_MAX_PAGES}/${config.DATA_GOV_IN_MAX_RECORDS}).`);
  process.exit(2);
}
if (config.RUNTIME_MODE === "replay") {
  console.error("Refusing: ingestion is disabled in replay mode.");
  process.exit(2);
}
if (!process.env.DATABASE_URL && !dryRun) {
  console.error("DATABASE_URL is required (or pass --dry-run).");
  process.exit(2);
}

const pool = dryRun ? null : createPool(process.env.DATABASE_URL!);
const startedAt = new Date();
const hash = payloadHash({ resourceId: RESOURCE, state, products, markets, startOffset, maxPages });
const runId = pool ? await startRun(pool, { jobId: null, jobType: "ingest.market_prices", hash, provider: "data.gov.in", mode: "live" }) : null;
const sourceId = pool
  ? await ensureSource(pool, MANDI_RESOURCES[RESOURCE]!.manifestId, { title: MANDI_RESOURCES[RESOURCE]!.title, publisher: "Open Government Data Platform India", url: `https://api.data.gov.in/resource/${RESOURCE}`, licence: "see manifest" })
  : null;

const seen = new Map<string, string>();
const sig = (r: MandiRow) => [r.priceMin, r.priceModal, r.priceMax].join("|");
const summary: Record<string, unknown> = { resourceId: RESOURCE, state, markets: markets.length ? markets : null, label: label || null, startedAt: startedAt.toISOString(), maxPages, startOffset, dryRun, perProduct: {} as Record<string, unknown> };
let pagesUsed = 0;
let fatal: string | null = null;

const jobs: { commodity: string; market: string | null }[] = products.flatMap((commodity): { commodity: string; market: string | null }[] => (markets.length ? markets.map((market) => ({ commodity, market })) : [{ commodity, market: null }]));
for (const { commodity, market } of jobs) {
  const jobKey = market ? `${commodity} @ ${market}` : commodity;
  const p: Record<string, unknown> = { commodity, market, pages: 0, recordsRead: 0, normalized: 0, rejected: 0, rejectedReasons: {} as Record<string, number>, duplicatesIgnored: 0, conflictsKeptFirst: 0, stored: { inserted: 0, revisions: 0, unchanged: 0, skippedNoProduct: 0, skippedUnmapped: 0 }, total: null, dates: { min: null, max: null }, truncated: false, nextOffset: startOffset };
  (summary.perProduct as Record<string, unknown>)[jobKey] = p;
  let offset = startOffset;
  let minD: string | null = null;
  let maxD: string | null = null;
  while (pagesUsed < maxPages) {
    const res = await fetchMandiPrices({ resourceId: RESOURCE, rawFilters: market ? { State: state, Commodity: commodity, Market: market } : { State: state, Commodity: commodity }, limit: 1000, offset, maxPages: 1, maxRecords: 1000 }, { config });
    if (res.status !== "ok") {
      fatal = `${jobKey} offset ${offset}: ${res.status === "unavailable" ? `${res.reason}: ${res.detail}` : res.status}`;
      break;
    }
    pagesUsed++;
    (p.pages as number)++;
    p.recordsRead = (p.recordsRead as number) + res.records.length;
    p.total = res.total;
    const rep = normalizeMandiRecords(res.records);
    p.rejected = (p.rejected as number) + rep.rejected.length;
    for (const r of rep.rejected) (p.rejectedReasons as Record<string, number>)[r.reason] = ((p.rejectedReasons as Record<string, number>)[r.reason] ?? 0) + 1;
    const fresh: MandiRow[] = [];
    for (const r of rep.rows) {
      const key = [r.marketId, r.productSlug ?? r.commodity, r.observedOn, (r.variety ?? "").toLowerCase(), (r.grade ?? "").toLowerCase()].join("#");
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, sig(r));
        r.flags.push("availability_basis:conservative_upper_bound");
        fresh.push(r);
      } else if (prior === sig(r)) p.duplicatesIgnored = (p.duplicatesIgnored as number) + 1;
      else p.conflictsKeptFirst = (p.conflictsKeptFirst as number) + 1;
      if (!minD || r.observedOn < minD) minD = r.observedOn;
      if (!maxD || r.observedOn > maxD) maxD = r.observedOn;
    }
    p.duplicatesIgnored = (p.duplicatesIgnored as number) + rep.duplicatesIgnored;
    p.conflictsKeptFirst = (p.conflictsKeptFirst as number) + rep.conflictsFlagged;
    p.normalized = (p.normalized as number) + fresh.length;
    if (pool && sourceId) {
      const c: MarketStoreCounts = await storeMarketRows(pool, fresh, { sourceId, mode: "live", availableAt: new Date(res.fetchedAt) });
      const s = p.stored as { inserted: number; revisions: number; unchanged: number; skippedNoProduct: number; skippedUnmapped: number };
      s.inserted += c.inserted; s.revisions += c.revisions; s.unchanged += c.unchanged; s.skippedNoProduct += c.skippedNoProduct; s.skippedUnmapped += c.skippedUnmapped;
    }
    offset += res.records.length;
    p.nextOffset = offset;
    console.log(`${jobKey} page ${pagesUsed}/${maxPages}: offset ${offset}/${res.total ?? "?"}, +${res.records.length} read, ${fresh.length} new identities`);
    if (res.records.length < 1000 || (res.total !== null && offset >= res.total)) break;
  }
  p.dates = { min: minD, max: maxD };
  p.truncated = typeof p.total === "number" && (p.nextOffset as number) < (p.total as number);
  if (fatal) break;
}
summary.pagesUsed = pagesUsed;
summary.rowsFetchedUpperBound = pagesUsed * 1000;
summary.finishedAt = new Date().toISOString();
summary.fatal = fatal;
summary.availabilityBasis = "conservative_upper_bound (available_at = fetch time per page; the source publishes no first-seen time)";
summary.unitBasis = "agmarknet_convention_inr_per_quintal (field metadata states no unit; not confirmed)";
summary.note = "API default order is not chronological, so a capped run is a random subset by date, not an oldest-first or newest-first prefix.";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/raw/datagovin");
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `ingest-ginger-karnataka-${startedAt.toISOString().slice(0, 10)}${label ? `-${label}` : ""}.json`);
writeFileSync(file, JSON.stringify(summary, null, 1) + "\n");
if (pool && runId) {
  await finishRun(pool, runId, fatal ? "failed" : "succeeded", { pagesUsed, perProduct: summary.perProduct }, { startOffset, resourceId: RESOURCE, state, products, markets });
  await pool.end();
}
console.log(JSON.stringify(summary, null, 1));
console.log(`wrote ${file}`);
if (fatal) process.exit(1);
