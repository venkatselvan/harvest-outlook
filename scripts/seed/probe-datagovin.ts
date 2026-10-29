/**
 * First thing to run once a data.gov.in key is configured (DATA_GOV_IN_API_KEY in .env or the environment).
 * Fetches <= 50 ginger rows from the current-daily-price resource and writes a sanitized field/summary report to
 * data/raw/datagovin/probe-<date>.json (gitignored). With no key it makes NO network call.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../apps/api/src/env";
import { fetchMandiPrices } from "../../apps/api/src/providers/datagovin/client";
import { FIELD_CANDIDATES, normKey, normalizeMandiRecords, parseSourceDate, loadCommodityMap } from "../../apps/api/src/providers/datagovin/normalize";
import { loadProviderConfig } from "../../apps/api/src/providers/config";

const RESOURCE = process.env.PROBE_RESOURCE_ID ?? "9ef84268-d588-465a-a308-a864a43d0070";
const config = loadProviderConfig();
const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/raw/datagovin");

if (!config.DATA_GOV_IN_API_KEY) {
  console.log("DATA_GOV_IN_API_KEY is not set: status unavailable (api_key_missing). No request was made.");
  console.log("Register for a free key at https://data.gov.in, set DATA_GOV_IN_API_KEY in .env, then re-run.");
  process.exit(0);
}

const candidates = [...new Set([...loadCommodityMap().map((e) => e.sourceCommodity), "Ginger"])];
const report: Record<string, unknown> = { resourceId: RESOURCE, probedAt: new Date().toISOString(), candidates: {} as Record<string, unknown> };
let usable = 0;
for (const commodity of candidates) {
  const res = await fetchMandiPrices({ resourceId: RESOURCE, filters: { commodity }, limit: 50, maxRecords: 50, maxPages: 1 }, { config });
  if (res.status !== "ok") {
    (report.candidates as Record<string, unknown>)[commodity] = { status: res.status, reason: "reason" in res ? res.reason : undefined, detail: "detail" in res ? res.detail : undefined };
    console.log(`${commodity}: ${res.status} ${"reason" in res ? res.reason : ""}`);
    continue;
  }
  const keys = new Set<string>();
  for (const r of res.records) Object.keys(r).forEach((k) => keys.add(k));
  const dates = res.records.map((r) => {
    const k = Object.keys(r).find((x) => (FIELD_CANDIDATES.arrivalDate as readonly string[]).includes(normKey(x)));
    return k ? parseSourceDate(r[k]) : null;
  }).filter((d): d is string => !!d).sort();
  const norm = normalizeMandiRecords(res.records);
  const unitHints = res.fields.map((f) => `${f.id} ${f.name ?? ""}`).filter((s) => /quintal|qtl|kg|rs\.?|inr/i.test(s));
  const summary = {
    status: "ok",
    rows: res.records.length,
    totalReported: res.total,
    fieldNames: [...keys],
    declaredFields: res.fields,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    unitHints,
    unitGuess: unitHints.some((h) => /quintal|qtl/i.test(h)) ? "INR/quintal (stated in field metadata)" : "undetermined: field metadata does not state a unit",
    distinctMarkets: new Set(res.records.map((r) => String(r.market ?? r.Market ?? ""))).size,
    normalization: { rows: norm.rows.length, rejected: norm.rejected.length, duplicatesIgnored: norm.duplicatesIgnored, conflicts: norm.conflictsFlagged, unmappedFields: norm.unmappedFields },
    sampleRows: res.records.slice(0, 3),
    requestUrl: res.requestUrl,
  };
  (report.candidates as Record<string, unknown>)[commodity] = summary;
  if (res.records.length) usable++;
  console.log(`${commodity}: ${summary.rows} rows (total ${summary.totalReported}); fields: ${[...keys].join(", ")}; dates: ${JSON.stringify(summary.dateRange)}; unit: ${summary.unitGuess}`);
}
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `probe-${date}.json`);
writeFileSync(file, JSON.stringify(report, null, 1) + "\n");
console.log(`wrote ${file}${usable ? "" : " (no candidate returned rows; commodity names remain unverified)"}`);
