/**
 * T07b: DB -> analytics replay export (source_price_row + input_row JSON, gzip) for a registered replay request.
 *
 *   pnpm replay:export [-- --request evals/cases/forecast/ginger-karnataka-2026-10-30/request.json] [--sensitivity <id>]
 *
 * --sensitivity <id> applies a declared request.sensitivityRuns entry (skipExclusionRules) and writes the export and
 * manifest with a "-<id>" suffix. Only declared variants are accepted.
 *
 * Reads the request (markets, aliases, product, training start, availability policy) and writes:
 *   - <request.exportPath>                  rows.json.gz: { caseId, sourcePriceRows[], weatherInputs[] } (not committed)
 *   - <request.exportManifestPath>          counts, exclusions by reason and market, sha256 of the export and inputs
 *   - <dir of manifest>/sample-rows.json    a few rows per market for review
 *
 * Rules (all from holdout-policy.md; nothing here is tuned):
 * - Prices stay in the source unit (INR/quintal, assumed by Agmarknet convention, flagged on every stored row) with
 *   priceUnit stated; the analytics loader converts to INR/kg with Decimal arithmetic (/100). Never inferred here.
 * - marketId = canonical ID from the request's pinned alias table; the source market_id is kept in the manifest.
 * - Vintage 1: availableAt = observedOn + lagDays at 00:00 +05:30 (basis assumed_publication_lag_1d), because the stored
 *   available_at is the 2026-10-30 fetch time. Later vintages: their recorded available_at, revisionOf = prior vintage.
 * - Exclusions in order: validation_status != valid, modal < 300 INR/quintal, modal > 3.5x or < 0.25x the Karnataka
 *   ginger-fresh valid-row monthly median, price order violation, observed before trainingStart. Revisions of an
 *   excluded vintage are excluded too (reason revision_of_excluded_row).
 * - Weather: latest vintage of each Open-Meteo archive day at the Hassan grid cell, variable precipitation_sum (mm),
 *   availableAt = date + 6 days at 00:00 +05:30 (basis assumed_reanalysis_lag_6d).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const requestPath = resolve(ROOT, arg("request", "evals/cases/forecast/ginger-karnataka-2026-10-30/request.json"));
const requestText = readFileSync(requestPath, "utf8");
const req = JSON.parse(requestText) as {
  caseId: string; productId: string; marketIds: string[]; marketAliases: Record<string, string[]>; trainingStart: string;
  exportPath: string; exportManifestPath: string; weatherRegionId: string;
  availabilityPolicy: { prices: { basis: string; lagDays: number }; weather: { basis: string; lagDays: number } };
  sensitivityRuns?: { id: string; skipExclusionRules: string[] }[];
};
const sensitivityId = arg("sensitivity", "");
const sensitivity = sensitivityId ? req.sensitivityRuns?.find((v) => v.id === sensitivityId) : undefined;
if (sensitivityId && !sensitivity) throw new Error(`sensitivity run ${sensitivityId} is not declared in the request`);
const skip = new Set(sensitivity?.skipExclusionRules ?? []);
const suffixed = (p: string) => (sensitivity ? p.replace(/(\.json(\.gz)?)$/, `-${sensitivity.id}$1`) : p);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const STATE = "Karnataka";
const SOURCE_MANIFEST = "MKT02-dgi-mandi-variety";
const WEATHER_LOCATION = arg("weather-location", "open-meteo:12.970,76.091");
const LOW_FLOOR = 300;
const HIGH_X = 3.5;
const LOW_X = 0.25;

/** observedOn + n days at 00:00 Asia/Kolkata, as UTC ISO (i.e. day+n-1 at 18:30Z). */
function localMidnightPlus(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00+05:30`) + days * 86_400_000;
  return new Date(t).toISOString().replace(".000Z", "Z");
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const pool = createPool(process.env.DATABASE_URL);
const aliasToCanon = new Map<string, string>();
for (const [canon, aliases] of Object.entries(req.marketAliases)) for (const a of aliases) aliasToCanon.set(a, canon);

interface PRow { id: string; market_id: string; observed_on: string; price_min: string | null; price_modal: string | null; price_max: string | null; unit: string; available_at: string; vintage_seq: number; revision_of: string | null; validation_status: string; source_id: string; variety: string | null; grade: string | null }
const priceRows = (await pool.query<PRow>(
  `SELECT m.id, m.market_id, to_char(m.observed_on,'YYYY-MM-DD') AS observed_on, m.price_min::text, m.price_modal::text, m.price_max::text, m.unit,
          to_char(m.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS available_at, m.vintage_seq, m.revision_of, m.validation_status, m.source_id, m.variety, m.grade
   FROM market_observations m JOIN crop_products p ON p.id = m.product_id JOIN source_documents s ON s.id = m.source_id
   WHERE m.mode='live' AND NOT m.is_synthetic AND s.manifest_id=$1 AND m.state_name=$2 AND p.slug=$3
   ORDER BY m.market_id, m.observed_on, m.id, m.vintage_seq`, [SOURCE_MANIFEST, STATE, req.productId])).rows;

// Karnataka monthly median of valid vintage-1 modal prices (all markets) for the scaling rule.
const byMonth = new Map<string, number[]>();
for (const r of priceRows) {
  if (r.vintage_seq !== 1 || r.validation_status !== "valid" || r.price_modal === null) continue;
  const v = Number(r.price_modal);
  if (!(v > 0)) continue;
  const k = r.observed_on.slice(0, 7);
  (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(v);
}
const monthMedian = new Map([...byMonth].map(([k, v]) => [k, median(v)]));

const units = new Set<string>();
const excluded = new Map<string, string>(); // row id -> reason
const counts: Record<string, Record<string, number>> = {};
const bump = (market: string, reason: string) => { (counts[market] ??= {})[reason] = ((counts[market] ??= {})[reason] ?? 0) + 1; };
const sourceRows: Record<string, unknown>[] = [];
const perMarket: Record<string, { sourceMarketIds: Record<string, number>; exported: number; first: string | null; last: string | null; revisions: number }> = {};
for (const c of req.marketIds) perMarket[c] = { sourceMarketIds: {}, exported: 0, first: null, last: null, revisions: 0 };
let outOfScope = 0;
for (const r of priceRows) {
  const canon = aliasToCanon.get(r.market_id);
  if (!canon) { outOfScope++; continue; }
  const pm = perMarket[canon]!;
  pm.sourceMarketIds[r.market_id] = (pm.sourceMarketIds[r.market_id] ?? 0) + 1;
  const lo = r.price_min === null ? null : Number(r.price_min);
  const md = r.price_modal === null ? null : Number(r.price_modal);
  const hi = r.price_max === null ? null : Number(r.price_max);
  const mm = monthMedian.get(r.observed_on.slice(0, 7));
  let reason: string | null = null;
  if (r.revision_of && excluded.has(r.revision_of)) reason = "revision_of_excluded_row";
  else if (r.validation_status !== "valid") reason = "validation_status_not_valid";
  else if (md !== null && md < LOW_FLOOR) reason = "modal_below_300_inr_per_quintal";
  else if (!skip.has("scaling_flag_3_5x_or_0_25x_ka_month_median") && md !== null && mm !== undefined && (md > HIGH_X * mm || md < LOW_X * mm)) reason = "scaling_flag_3_5x_or_0_25x_ka_month_median";
  else if ((lo !== null && md !== null && lo > md) || (md !== null && hi !== null && md > hi) || (lo !== null && hi !== null && lo > hi)) reason = "price_order_violation";
  else if (r.observed_on < req.trainingStart) reason = "observed_before_training_start";
  if (reason) { excluded.set(r.id, reason); bump(canon, reason); continue; }
  if (r.unit !== "INR/quintal" && r.unit !== "INR/kg") throw new Error(`unexpected stored unit ${r.unit} on ${r.id}`);
  units.add(r.unit);
  const isRevision = r.vintage_seq > 1;
  sourceRows.push({
    rowId: `mo:${r.id}`, marketId: canon, productId: req.productId, observedOn: r.observed_on,
    minPrice: lo, maxPrice: hi, modalPrice: md, priceUnit: r.unit, arrivals: null, arrivalsUnit: null,
    sourceId: `src:${r.source_id}`,
    availableAt: isRevision ? r.available_at : localMidnightPlus(r.observed_on, req.availabilityPolicy.prices.lagDays),
    availableAtBasis: isRevision ? "recorded" : req.availabilityPolicy.prices.basis,
    revisionOf: r.revision_of ? `mo:${r.revision_of}` : null,
  });
  pm.exported++;
  if (isRevision) pm.revisions++;
  if (!pm.first || r.observed_on < pm.first) pm.first = r.observed_on;
  if (!pm.last || r.observed_on > pm.last) pm.last = r.observed_on;
}

interface WRow { id: string; observed_on: string; precip: string | null; source_id: string; available_at: string; vintage_seq: number }
const wRows = (await pool.query<WRow>(
  `SELECT DISTINCT ON (w.observed_on) w.id, to_char(w.observed_on,'YYYY-MM-DD') AS observed_on, (w.variables->>'precipitation_sum') AS precip, w.source_id,
          to_char(w.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS available_at, w.vintage_seq
   FROM weather_observations w WHERE w.location_key=$1 AND w.mode='live' AND NOT w.is_synthetic
   ORDER BY w.observed_on, w.vintage_seq DESC`, [WEATHER_LOCATION])).rows;
await pool.end();
let weatherNull = 0;
const weatherInputs: Record<string, unknown>[] = [];
for (const w of wRows) {
  if (w.precip === null) { weatherNull++; continue; }
  weatherInputs.push({
    rowId: `wo:${w.id}`, regionId: req.weatherRegionId, periodStart: w.observed_on, periodEnd: w.observed_on,
    variable: "precipitation_sum", value: Number(w.precip), unit: "mm", sourceId: `src:${w.source_id}`,
    availableAt: localMidnightPlus(w.observed_on, req.availabilityPolicy.weather.lagDays), availableAtBasis: req.availabilityPolicy.weather.basis, revisionOf: null,
  });
}

const payload = { caseId: req.caseId, productId: req.productId, sourcePriceRows: sourceRows, weatherInputs };
const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json), { level: 9, mtime: 0 } as never);
const exportFile = resolve(ROOT, suffixed(req.exportPath));
mkdirSync(dirname(exportFile), { recursive: true });
writeFileSync(exportFile, gz);
const excludedTotals: Record<string, number> = {};
for (const m of Object.values(counts)) for (const [k, v] of Object.entries(m)) excludedTotals[k] = (excludedTotals[k] ?? 0) + v;
const manifest = {
  caseId: req.caseId, generatedAt: new Date().toISOString(), requestSha256: sha256(requestText),
  sensitivity: sensitivity ?? null,
  export: { path: suffixed(req.exportPath), bytesGzip: gz.length, bytesJson: Buffer.byteLength(json), sha256Gzip: sha256(gz), sha256Json: sha256(json), committed: false, note: "regenerate with pnpm replay:export; the DB rows are the source" },
  source: { manifestId: SOURCE_MANIFEST, state: STATE, productId: req.productId, storedUnits: [...units], unitBasis: "agmarknet_convention_inr_per_quintal (assumed, not confirmed)" },
  prices: { rowsReadAllKarnataka: priceRows.length, rowsOutsideScoredMarkets: outOfScope, exported: sourceRows.length, excludedByReason: excludedTotals, excludedByMarket: counts, perMarket },
  weather: { locationKey: WEATHER_LOCATION, regionId: req.weatherRegionId, measurementKind: "reanalysis", daysRead: wRows.length, nullPrecipDropped: weatherNull, exported: weatherInputs.length, first: weatherInputs[0]?.periodStart ?? null, last: weatherInputs.at(-1)?.periodStart ?? null },
  availability: req.availabilityPolicy,
  rules: { lowFloorInrPerQuintal: LOW_FLOOR, scalingHighX: HIGH_X, scalingLowX: LOW_X, monthMedianBasis: "Karnataka ginger-fresh valid vintage-1 rows, all markets, same calendar month" },
};
const manifestFile = resolve(ROOT, suffixed(req.exportManifestPath));
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + "\n");
const sample = { note: "Review sample only (first 5 exported rows per market, first 5 weather rows); the full export is regenerated by pnpm replay:export.", sourcePriceRows: req.marketIds.flatMap((m) => sourceRows.filter((r) => r.marketId === m).slice(0, 5)), weatherInputs: weatherInputs.slice(0, 5) };
if (!sensitivity) writeFileSync(resolve(dirname(manifestFile), "sample-rows.json"), JSON.stringify(sample, null, 1) + "\n");
console.log(JSON.stringify({ exported: sourceRows.length, excludedByReason: excludedTotals, weather: weatherInputs.length, bytesGzip: gz.length, perMarket: Object.fromEntries(Object.entries(perMarket).map(([k, v]) => [k, { exported: v.exported, revisions: v.revisions, first: v.first, last: v.last }])) }, null, 1));
