/**
 * Mandi price history ingest: the ginger ingest (ingest-ginger-karnataka.ts) generalised to a manifest of crops,
 * states and a date range, over the data.gov.in VARIETY-WISE daily resource. Rows land in the same table through
 * the same path (normalizeMandiRecords -> storeMarketRows, source MKT02-dgi-mandi-variety, mode live), so existing
 * readers need no change. See docs/research/MANDI_HISTORY_PLAN.md for the design, estimates and operating notes.
 *
 *   pnpm --filter @harvest/api exec tsx ../../scripts/seed/ingest-mandi-history.ts --dry-run
 *   pnpm --filter @harvest/api exec tsx ../../scripts/seed/ingest-mandi-history.ts --products maize-grain \
 *        --states Karnataka --from 2025-03-01 --to 2025-03-31 --progress apps/api/.data/mandi-history/validation.json
 *   ... --dates 2024-06-12,2026-09-16 --no-store      # label census: fetch, report labels, write nothing to the DB
 *
 * Strategy (granularity "state-day"): one request series per (state, calendar day) using filters[State] and
 * filters[Arrival_Date]=dd/mm/yyyy (the resource has no date-range filter; a commodity history scan reads about 20
 * years per commodity). All commodities for the day are paged at pageSize; rows are kept only when the returned
 * Commodity label matches an enabled manifest label (case- and whitespace-insensitive, like the normaliser). Every
 * returned label is counted in a census so renamed or unmapped labels are visible.
 *
 * Resumable: progress is saved after every page to a local JSON (default apps/api/.data/mandi-history/, gitignored).
 * A finished unit is skipped on the next run when it was stored for the same label set. On HTTP 429 the run stops at
 * once WITHOUT retrying, records the Retry-After value and a cooldown time, and exits 75; a later start refuses to
 * send anything until the cooldown has passed. Other transient failures (timeout, network, 5xx) are retried twice.
 *
 * The API key is read from the environment (.env) by the shared provider config, is only ever placed in the request
 * URL by the shared client, and is never printed, stored or logged. Request URLs are not stored.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool } from "../../apps/api/src/db/pool";
import type { FetchLike } from "../../apps/api/src/ingest/http";
import { storeMarketRows, type MarketStoreCounts } from "../../apps/api/src/ingest/market-store";
import { MANDI_RESOURCES } from "../../apps/api/src/ingest/sources";
import { loadProviderConfig, type ProviderConfig } from "../../apps/api/src/providers/config";
import { fetchMandiPrices } from "../../apps/api/src/providers/datagovin/client";
import { loadCommodityMap, normalizeMandiRecords, parseSourceDate, type CommodityMapEntry, type MandiRow } from "../../apps/api/src/providers/datagovin/normalize";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
export const DEFAULT_MANIFEST_PATH = resolve(REPO, "data/manifests/mandi-history-ka-tn-2026-11-01.json");
const PROGRESS_DIR = resolve(REPO, "apps/api/.data/mandi-history");

// ------------------------------------------------------------------------------------------------ manifest

export interface ManifestLabel {
  label: string;
  [evidence: string]: unknown;
}
export interface ManifestProduct {
  cropId: string;
  productId: string;
  enabled: boolean;
  commodities: ManifestLabel[];
  labelHints?: string[];
  note?: string;
}
export interface VolumeSegment {
  from: string;
  to: string;
  rowsPerDay: number;
  storedRowsPerDay?: number;
}
export interface Manifest {
  schemaVersion: number;
  id: string;
  resourceId: string;
  granularity: "state-day";
  states: string[];
  range: { from: string; to: string };
  dateStepDays?: number;
  pageSize?: number;
  pauseMs?: number;
  volumeModel?: { states: Record<string, { segments: VolumeSegment[] }> };
  products: ManifestProduct[];
}

export interface LabelInfo {
  label: string;
  productId: string;
  cropId: string;
  verified: boolean;
}

/** Same normalisation as normalizeMandiRecords uses for commodity-map lookups. */
export const normLabel = (s: string): string => s.toLowerCase().replace(/\s+/g, "");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: unknown): s is string => typeof s === "string" && ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function loadManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export interface ManifestCheck {
  errors: string[];
  warnings: string[];
  /** Enabled labels (normalised key -> info), restricted to `onlyProducts` when given. */
  labels: Map<string, LabelInfo>;
}

/**
 * Every enabled label must resolve to a commodity-map.json entry for the same product slug. An unverified entry is
 * allowed (rows are stored hidden as unverified_mapping, as in the shared store) but is reported as a warning.
 */
export function validateManifest(m: Manifest, map: CommodityMapEntry[], onlyProducts?: Set<string>): ManifestCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const labels = new Map<string, LabelInfo>();
  if (typeof m.id !== "string" || !m.id) errors.push("manifest id is missing");
  if (!MANDI_RESOURCES[m.resourceId]) errors.push(`resourceId ${String(m.resourceId)} is not a known data.gov.in mandi resource (apps/api/src/ingest/sources.ts)`);
  if (m.granularity !== "state-day") errors.push(`granularity must be "state-day", got ${String(m.granularity)}`);
  if (!Array.isArray(m.states) || m.states.length === 0 || m.states.some((s) => typeof s !== "string" || !s.trim())) errors.push("states must be a non-empty list of exact source state names");
  if (!isIsoDate(m.range?.from) || !isIsoDate(m.range?.to)) errors.push("range.from and range.to must be real ISO dates");
  else if (m.range.from > m.range.to) errors.push("range.from is after range.to");
  if (m.dateStepDays !== undefined && !(Number.isInteger(m.dateStepDays) && m.dateStepDays >= 1)) errors.push("dateStepDays must be an integer >= 1");
  if (m.pageSize !== undefined && !(Number.isInteger(m.pageSize) && m.pageSize >= 1 && m.pageSize <= 1000)) errors.push("pageSize must be 1..1000");
  const bySource = new Map(map.map((e) => [normLabel(e.sourceCommodity), e]));
  const seenProducts = new Set<string>();
  for (const p of m.products ?? []) {
    if (seenProducts.has(p.productId)) errors.push(`product ${p.productId} is listed twice`);
    seenProducts.add(p.productId);
    if (!p.enabled || (onlyProducts && !onlyProducts.has(p.productId))) continue;
    if (!p.commodities?.length) errors.push(`enabled product ${p.productId} has no commodity labels`);
    for (const c of p.commodities ?? []) {
      const key = normLabel(c.label);
      const entry = bySource.get(key);
      if (!entry) errors.push(`label "${c.label}" (${p.productId}) has no entry in commodity-map.json`);
      else if (entry.productSlug !== p.productId) errors.push(`label "${c.label}" maps to ${entry.productSlug} in commodity-map.json, not ${p.productId}`);
      else if (entry.unresolved) errors.push(`label "${c.label}" is marked unresolved in commodity-map.json`);
      else if (!entry.verified) warnings.push(`label "${c.label}" (${p.productId}) is unverified in commodity-map.json: rows will be stored hidden as unverified_mapping`);
      if (labels.has(key)) errors.push(`label "${c.label}" appears under both ${labels.get(key)!.productId} and ${p.productId}`);
      labels.set(key, { label: c.label, productId: p.productId, cropId: p.cropId, verified: entry?.verified ?? false });
    }
  }
  if (onlyProducts) for (const id of onlyProducts) if (!seenProducts.has(id)) errors.push(`--products names ${id}, which is not in the manifest`);
  return { errors, warnings, labels };
}

// ------------------------------------------------------------------------------------------------ dates and units

export const toSourceDate = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const dayMs = 86_400_000;
const dayNum = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / dayMs);
const isoOf = (n: number): string => new Date(n * dayMs).toISOString().slice(0, 10);

/** Calendar days from..to inclusive, taking every `step`-th day starting `offset` days after `from`. */
export function enumerateDates(from: string, to: string, step = 1, offset = 0): string[] {
  const out: string[] = [];
  for (let n = dayNum(from) + offset; n <= dayNum(to); n += step) out.push(isoOf(n));
  return out;
}

export interface Unit {
  state: string;
  date: string;
  key: string;
}

export function planUnits(states: string[], dates: string[], order: "newest" | "oldest" = "newest"): Unit[] {
  const ds = order === "newest" ? [...dates].sort().reverse() : [...dates].sort();
  return ds.flatMap((date) => states.map((state) => ({ state, date, key: `${state}|${date}` })));
}

export interface Plan {
  units: number;
  dates: number;
  requestsLowerBound: number;
  requestsExpected: number | null;
  storedRowsExpected: number | null;
  secondsAtPauseLowerBound: number;
}

/** Expected requests = sum over days of ceil(rowsPerDay / pageSize) from the manifest volume model (an estimate). */
export function buildPlan(m: Manifest, states: string[], dates: string[], pageSize: number, pauseMs: number): Plan {
  const units = states.length * dates.length;
  let requests = 0;
  let stored = 0;
  let modelled = true;
  for (const state of states) {
    const segs = m.volumeModel?.states[state]?.segments;
    if (!segs?.length) {
      modelled = false;
      continue;
    }
    for (const d of dates) {
      const seg = segs.find((s) => d >= s.from && d <= s.to);
      if (!seg) {
        modelled = false;
        continue;
      }
      requests += Math.max(1, Math.ceil(seg.rowsPerDay / pageSize));
      stored += seg.storedRowsPerDay ?? 0;
    }
  }
  return { units, dates: dates.length, requestsLowerBound: units, requestsExpected: modelled ? requests : null, storedRowsExpected: modelled ? stored : null, secondsAtPauseLowerBound: units * (pauseMs / 1000) };
}

// ------------------------------------------------------------------------------------------------ progress

export interface StoredCounts {
  inserted: number;
  revisions: number;
  unchanged: number;
  skippedNoProduct: number;
  skippedUnmapped: number;
  storedUnverifiedMapping: number;
}
const emptyStored = (): StoredCounts => ({ inserted: 0, revisions: 0, unchanged: 0, skippedNoProduct: 0, skippedUnmapped: 0, storedUnverifiedMapping: 0 });

export interface UnitProgress {
  status: "partial" | "done";
  nextOffset: number;
  pages: number;
  total: number | null;
  rowsRead: number;
  /** Rows identical to an earlier row of the same unit in this session (page overlap or source duplicates). */
  repeatedRows: number;
  matchedRows: number;
  rejected: number;
  dateMismatch: number;
  stateMismatch: number;
  stored: StoredCounts;
  labelsDigest: string;
  updatedAt: string;
  pagingSuspect?: boolean;
}
export interface CensusEntry {
  rows: number;
  firstDate: string;
  lastDate: string;
  productId: string | null;
}
export interface Progress {
  schemaVersion: 1;
  manifestId: string;
  resourceId: string;
  createdAt: string;
  updatedAt: string;
  cooldown: { until: string; reason: string; retryAfterRaw: string | null } | null;
  requests: number;
  units: Record<string, UnitProgress>;
  /** key: "<state>|<label as returned>" */
  census: Record<string, CensusEntry>;
  byProduct: Record<string, number>;
}

export function loadProgress(path: string, m: Manifest, now: Date, fresh = false): Progress {
  if (!fresh && existsSync(path)) {
    const p = JSON.parse(readFileSync(path, "utf8")) as Progress;
    if (p.manifestId !== m.id || p.resourceId !== m.resourceId) throw new Error(`progress file ${path} belongs to ${p.manifestId}, not ${m.id}; pass another --progress path or --reset-progress`);
    return p;
  }
  const t = now.toISOString();
  return { schemaVersion: 1, manifestId: m.id, resourceId: m.resourceId, createdAt: t, updatedAt: t, cooldown: null, requests: 0, units: {}, census: {}, byProduct: {} };
}

export function saveProgress(path: string, p: Progress, now: Date): void {
  p.updatedAt = now.toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 1) + "\n");
  renameSync(tmp, path);
}

export const labelsDigest = (labels: Map<string, LabelInfo>): string =>
  createHash("sha256").update([...labels.entries()].map(([k, v]) => `${k}=${v.productId}`).sort().join("\n")).digest("hex").slice(0, 16);

// ------------------------------------------------------------------------------------------------ pull loop

export interface PullOptions {
  manifest: Manifest;
  labels: Map<string, LabelInfo>;
  states: string[];
  dates: string[];
  order: "newest" | "oldest";
  pauseMs: number;
  maxRequests: number;
  pageSize: number;
  progressPath: string;
  ignoreCooldown: boolean;
  defaultCooldownSeconds: number;
  /** Retries (after the first attempt) for timeout, network error and 5xx. HTTP 429 is never retried. */
  transientRetries: number;
  resetProgress: boolean;
}
export interface PullDeps {
  config: ProviderConfig;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  commodityMap: CommodityMapEntry[];
  /** Absent in --no-store mode. */
  storeRows?: ((rows: MandiRow[], availableAt: Date) => Promise<MarketStoreCounts>) | undefined;
  log: (line: string) => void;
}
export type PullStatus = "complete" | "paused_max_requests" | "stopped_rate_limited" | "failed";
export interface PullResult {
  status: PullStatus;
  message: string;
  requests: number;
  unitsDone: number;
  unitsSkippedDone: number;
  unitsRemaining: number;
  retryAfterSeconds?: number;
  resumeAfter?: string;
  fatal?: string;
}

/** Seconds from a Retry-After header (delta-seconds or HTTP-date); falls back to `fallback` when absent or invalid. */
export function parseRetryAfter(raw: string | null | undefined, now: Date, fallback: number): number {
  const clamp = (n: number) => Math.min(86_400, Math.max(1, Math.ceil(n)));
  if (!raw) return clamp(fallback);
  const t = raw.trim();
  if (/^\d+$/.test(t)) return clamp(Number(t));
  const when = Date.parse(t);
  return Number.isNaN(when) ? clamp(fallback) : clamp((when - now.getTime()) / 1000);
}

const pickField = (rec: Record<string, unknown>, ...names: string[]): unknown => {
  for (const n of names) if (n in rec) return rec[n];
  return undefined;
};
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const istToday = (now: Date): string => new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export async function runPull(o: PullOptions, d: PullDeps): Promise<PullResult> {
  const progress = loadProgress(o.progressPath, o.manifest, d.now(), o.resetProgress);
  const digest = labelsDigest(o.labels);
  const units = planUnits(o.states, o.dates.filter((x) => x <= istToday(d.now())), o.order);
  const pending = (u: Unit) => progress.units[u.key]?.status !== "done" || progress.units[u.key]?.labelsDigest !== digest;
  const remainingNow = () => units.filter(pending).length;
  const skipped = units.length - remainingNow();

  if (progress.cooldown && !o.ignoreCooldown) {
    const wait = Date.parse(progress.cooldown.until) - d.now().getTime();
    if (wait > 0) {
      const message = `cooling down after HTTP 429 until ${progress.cooldown.until} (${Math.ceil(wait / 1000)} s left); no request sent`;
      return { status: "stopped_rate_limited", message, requests: 0, unitsDone: 0, unitsSkippedDone: skipped, unitsRemaining: remainingNow(), retryAfterSeconds: Math.ceil(wait / 1000), resumeAfter: progress.cooldown.until };
    }
  }
  progress.cooldown = null;

  // Capture the HTTP status and Retry-After of every attempt; the shared client collapses both into a reason code.
  const last: { status: number; retryAfter: string | null; calls: number } = { status: 0, retryAfter: null, calls: 0 };
  const fetchImpl: FetchLike = async (url, init) => {
    last.calls++;
    const res = await d.fetchImpl(url, init);
    last.status = res.status;
    last.retryAfter = res.headers?.get("retry-after") ?? null;
    return res;
  };
  const config: ProviderConfig = { ...d.config, PROVIDER_MAX_RETRIES: 0 };
  let sessionRequests = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  let unitsDone = 0;
  const finish = (status: PullStatus, message: string, extra: Partial<PullResult> = {}): PullResult => {
    progress.requests += sessionRequests;
    saveProgress(o.progressPath, progress, d.now());
    return { status, message, requests: sessionRequests, unitsDone, unitsSkippedDone: skipped, unitsRemaining: remainingNow(), ...extra };
  };

  for (const unit of units) {
    if (!pending(unit)) continue;
    const existing = progress.units[unit.key];
    const resume = existing && existing.status === "partial" && existing.labelsDigest === digest ? existing : null;
    const up: UnitProgress = resume ?? { status: "partial", nextOffset: 0, pages: 0, total: null, rowsRead: 0, repeatedRows: 0, matchedRows: 0, rejected: 0, dateMismatch: 0, stateMismatch: 0, stored: emptyStored(), labelsDigest: digest, updatedAt: d.now().toISOString() };
    progress.units[unit.key] = up;
    const seenRows = new Set<string>();
    const seenIdentity = new Map<string, string>();
    let offset = up.nextOffset;
    let pagesThisSession = 0;

    for (;;) {
      if (sessionRequests >= o.maxRequests) return finish("paused_max_requests", `request cap ${o.maxRequests} reached; progress saved, rerun to resume`);
      const rawFilters = { State: unit.state, Arrival_Date: toSourceDate(unit.date) };
      let res: Awaited<ReturnType<typeof fetchMandiPrices>> | undefined;
      for (let attempt = 0; attempt <= o.transientRetries; attempt++) {
        if (sessionRequests >= o.maxRequests) return finish("paused_max_requests", `request cap ${o.maxRequests} reached; progress saved, rerun to resume`);
        const wait = lastAt + o.pauseMs - d.now().getTime();
        if (wait > 0) await d.sleep(wait);
        lastAt = d.now().getTime();
        sessionRequests++;
        res = await fetchMandiPrices({ resourceId: o.manifest.resourceId, rawFilters, limit: o.pageSize, offset, maxPages: 1, maxRecords: o.pageSize }, { config, fetchImpl, now: d.now, sleep: d.sleep });
        if (res.status !== "unavailable") break;
        if (res.reason === "rate_limited" || last.status === 429) {
          const secs = parseRetryAfter(last.retryAfter, d.now(), o.defaultCooldownSeconds);
          const until = new Date(d.now().getTime() + secs * 1000).toISOString();
          progress.cooldown = { until, reason: "http_429", retryAfterRaw: last.retryAfter };
          return finish("stopped_rate_limited", `HTTP 429 at ${unit.key} offset ${offset}; Retry-After ${last.retryAfter ?? "absent (default applied)"}; resume after ${until}`, { retryAfterSeconds: secs, resumeAfter: until });
        }
        const transient = res.reason === "timeout" || res.reason === "network_error" || res.reason === "invalid_json" || (res.reason === "http_error" && last.status >= 500);
        if (!transient || attempt === o.transientRetries) break;
        await d.sleep(5_000 * (attempt + 1));
      }
      if (!res || res.status !== "ok") {
        const why = res && res.status === "unavailable" ? `${res.reason}: ${res.detail}` : "no result";
        return finish("failed", `${unit.key} offset ${offset}: ${why}`, { fatal: `${unit.key} offset ${offset}: ${why}` });
      }

      const records = res.records;
      pagesThisSession++;
      up.pages++;
      up.rowsRead += records.length;
      up.total = res.total;
      const wantedDate = toSourceDate(unit.date);
      const kept: Array<Record<string, unknown>> = [];
      let dateOk = 0;
      for (const rec of records) {
        const label = text(pickField(rec, "Commodity", "commodity"));
        const state = text(pickField(rec, "State", "state"));
        const rowDate = parseSourceDate(pickField(rec, "Arrival_Date", "arrival_date"));
        const info = o.labels.get(normLabel(label));
        const censusKey = `${unit.state}|${label}`;
        const c = progress.census[censusKey];
        if (c) {
          c.rows++;
          if (rowDate && rowDate < c.firstDate) c.firstDate = rowDate;
          if (rowDate && rowDate > c.lastDate) c.lastDate = rowDate;
        } else progress.census[censusKey] = { rows: 1, firstDate: rowDate ?? unit.date, lastDate: rowDate ?? unit.date, productId: info?.productId ?? null };
        if (rowDate !== unit.date) {
          up.dateMismatch++;
          continue;
        }
        dateOk++;
        if (normLabel(state) !== normLabel(unit.state)) {
          up.stateMismatch++;
          continue;
        }
        const sig = JSON.stringify(rec);
        if (seenRows.has(sig)) up.repeatedRows++;
        else seenRows.add(sig);
        if (info) kept.push(rec);
      }
      // A filter that is silently ignored would return unrelated days: stop instead of storing or paging on.
      if (records.length > 0 && dateOk === 0 && pagesThisSession === 1 && offset === 0) {
        return finish("failed", `${unit.key}: none of ${records.length} rows carried ${wantedDate}; the Arrival_Date filter was not honoured`, { fatal: "date_filter_not_honoured" });
      }

      if (kept.length) {
        const rep = normalizeMandiRecords(kept, { commodityMap: d.commodityMap });
        up.rejected += rep.rejected.length;
        const fresh: MandiRow[] = [];
        for (const r of rep.rows) {
          const key = [r.marketId, r.productSlug ?? r.commodity, r.observedOn, (r.variety ?? "").toLowerCase(), (r.grade ?? "").toLowerCase()].join("#");
          const sig = [r.priceMin, r.priceModal, r.priceMax].join("|");
          const prior = seenIdentity.get(key);
          if (prior === undefined) {
            seenIdentity.set(key, sig);
            r.flags.push("availability_basis:conservative_upper_bound");
            fresh.push(r);
          }
        }
        up.matchedRows += fresh.length;
        for (const r of fresh) if (r.productSlug) progress.byProduct[r.productSlug] = (progress.byProduct[r.productSlug] ?? 0) + 1;
        if (d.storeRows && fresh.length) {
          const c = await d.storeRows(fresh, new Date(res.fetchedAt));
          up.stored.inserted += c.inserted;
          up.stored.revisions += c.revisions;
          up.stored.unchanged += c.unchanged;
          up.stored.skippedNoProduct += c.skippedNoProduct;
          up.stored.skippedUnmapped += c.skippedUnmapped;
          up.stored.storedUnverifiedMapping += c.storedUnverifiedMapping;
        }
      }

      offset += records.length;
      up.nextOffset = offset;
      up.updatedAt = d.now().toISOString();
      const done = records.length === 0 || records.length < o.pageSize || (res.total !== null && offset >= res.total);
      if (done) {
        up.status = "done";
        if (up.pages > 1 && up.repeatedRows > 0.02 * up.rowsRead) up.pagingSuspect = true;
        else delete up.pagingSuspect;
        unitsDone++;
      }
      saveProgress(o.progressPath, progress, d.now());
      d.log(`${unit.key} page ${up.pages}: offset ${offset}/${res.total ?? "?"}, ${kept.length} matched labels${done ? " (unit done)" : ""}`);
      if (done) break;
    }
  }
  return finish("complete", `all ${units.length} units done (${unitsDone} this run, ${skipped} already done)`);
}

// ------------------------------------------------------------------------------------------------ reporting

export interface UnmatchedLabel {
  state: string;
  label: string;
  rows: number;
  firstDate: string;
  lastDate: string;
  hintedProduct: string | null;
}

/** Labels seen in responses that matched no enabled label, with a product hint when the text contains a manifest hint. */
export function unmatchedLabels(p: Progress, m: Manifest, labels: Map<string, LabelInfo>): UnmatchedLabel[] {
  const hints = m.products.filter((x) => x.enabled).flatMap((x) => (x.labelHints ?? []).map((h) => ({ h: h.toLowerCase(), productId: x.productId })));
  const out: UnmatchedLabel[] = [];
  for (const [key, c] of Object.entries(p.census)) {
    const [state, ...rest] = key.split("|");
    const label = rest.join("|");
    if (labels.has(normLabel(label))) continue;
    const hit = hints.find((x) => label.toLowerCase().includes(x.h));
    out.push({ state: state ?? "", label, rows: c.rows, firstDate: c.firstDate, lastDate: c.lastDate, hintedProduct: hit?.productId ?? null });
  }
  return out.sort((a, b) => Number(Boolean(b.hintedProduct)) - Number(Boolean(a.hintedProduct)) || b.rows - a.rows);
}

// ------------------------------------------------------------------------------------------------ cli

export interface CliOptions {
  manifest: string;
  states: string[] | null;
  products: string[] | null;
  from: string | null;
  to: string | null;
  dates: string[] | null;
  dateStep: number | null;
  dateOffset: number;
  order: "newest" | "oldest";
  pauseMs: number | null;
  maxRequests: number;
  pageSize: number | null;
  progress: string | null;
  noStore: boolean;
  dryRun: boolean;
  ignoreCooldown: boolean;
  resetProgress: boolean;
  defaultCooldownSeconds: number;
  help: boolean;
}

const VALUE_FLAGS = new Set(["manifest", "states", "products", "from", "to", "dates", "date-step", "date-offset", "order", "pause-ms", "max-requests", "page-size", "progress", "default-cooldown-s"]);
const BOOL_FLAGS = new Set(["no-store", "dry-run", "ignore-cooldown", "reset-progress", "help"]);

export function parseArgs(argv: string[]): CliOptions {
  const v = new Map<string, string>();
  const b = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) b.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) throw new Error(`--${name} needs a value`);
      v.set(name, val);
    } else throw new Error(`unknown option --${name}`);
  }
  const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : null);
  const int = (name: string, def: number | null): number | null => {
    const s = v.get(name);
    if (s === undefined) return def;
    if (!/^\d+$/.test(s)) throw new Error(`--${name} must be a non-negative integer`);
    return Number(s);
  };
  const order = v.get("order") ?? "newest";
  if (order !== "newest" && order !== "oldest") throw new Error("--order must be newest or oldest");
  const dates = list(v.get("dates"));
  if (dates?.some((x) => !isIsoDate(x))) throw new Error("--dates must be comma-separated real YYYY-MM-DD dates");
  for (const f of ["from", "to"]) if (v.has(f) && !isIsoDate(v.get(f))) throw new Error(`--${f} must be a real YYYY-MM-DD date`);
  const step = int("date-step", null);
  if (step === 0) throw new Error("--date-step must be >= 1");
  return {
    manifest: v.get("manifest") ? resolve(v.get("manifest")!) : DEFAULT_MANIFEST_PATH,
    states: list(v.get("states")),
    products: list(v.get("products")),
    from: v.get("from") ?? null,
    to: v.get("to") ?? null,
    dates,
    dateStep: step,
    dateOffset: int("date-offset", 0) ?? 0,
    order,
    pauseMs: int("pause-ms", null),
    maxRequests: int("max-requests", 500) ?? 500,
    pageSize: int("page-size", null),
    progress: v.get("progress") ? resolve(v.get("progress")!) : null,
    noStore: b.has("no-store"),
    dryRun: b.has("dry-run"),
    ignoreCooldown: b.has("ignore-cooldown"),
    resetProgress: b.has("reset-progress"),
    defaultCooldownSeconds: int("default-cooldown-s", 120) ?? 120,
    help: b.has("help"),
  };
}

const HELP = `ingest-mandi-history.ts --manifest <json> [--states "Karnataka,Tamil Nadu"] [--products slug,slug] [--from ISO --to ISO | --dates ISO,ISO]
  [--date-step N --date-offset K] [--order newest|oldest] [--pause-ms 8000] [--max-requests 500] [--page-size 1000]
  [--progress <path>] [--no-store] [--dry-run] [--ignore-cooldown] [--reset-progress] [--default-cooldown-s 120]
--dry-run makes no network call and no database connection. --no-store fetches and reports labels but writes nothing.`;

const hours = (s: number) => (s >= 7200 ? `${(s / 3600).toFixed(1)} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

export async function main(argv: string[]): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(HELP);
    return 0;
  }
  const manifest = loadManifest(cli.manifest);
  const map = loadCommodityMap();
  const only = cli.products ? new Set(cli.products) : undefined;
  const check = validateManifest(manifest, map, only);
  const states = cli.states ?? manifest.states;
  for (const s of states) if (!manifest.states.includes(s)) check.errors.push(`--states names ${s}, which is not in the manifest`);
  const from = cli.from ?? manifest.range.from;
  const to = cli.to ?? manifest.range.to;
  const step = cli.dateStep ?? manifest.dateStepDays ?? 1;
  const dates = cli.dates ?? enumerateDates(from, to, step, cli.dateOffset);
  const pageSize = cli.pageSize ?? manifest.pageSize ?? 1000;
  const pauseMs = cli.pauseMs ?? manifest.pauseMs ?? 8000;
  if (pageSize < 1 || pageSize > 1000) check.errors.push("--page-size must be 1..1000");
  const progressPath = cli.progress ?? resolve(PROGRESS_DIR, `progress-${manifest.id}${cli.noStore ? "-nostore" : ""}.json`);

  const plan = buildPlan(manifest, states, dates, pageSize, pauseMs);
  const now = new Date();
  const todayIst = istToday(now);
  const futureDates = dates.filter((x) => x > todayIst).length;
  const lines: string[] = [];
  lines.push(`Plan ${manifest.id}${cli.dryRun ? " (dry run: no network, no database)" : ""}`);
  lines.push(`  resource ${manifest.resourceId} (${MANDI_RESOURCES[manifest.resourceId]?.manifestId ?? "unknown"}), granularity ${manifest.granularity}, order ${cli.order}`);
  lines.push(`  states: ${states.join(", ")}`);
  lines.push(`  dates: ${dates.length}${cli.dates ? " (explicit)" : ` (${from}..${to}, every ${step} day(s), offset ${cli.dateOffset})`}${futureDates ? `, ${futureDates} in the future skipped` : ""}`);
  lines.push(`  units (state x day): ${plan.units}; requests >= ${plan.requestsLowerBound}, modelled ~ ${plan.requestsExpected ?? "n/a (no volume model for these states or dates)"}; stored rows modelled ~ ${plan.storedRowsExpected ?? "n/a"}`);
  lines.push(`  pacing: ${pauseMs} ms between requests -> >= ${hours(plan.secondsAtPauseLowerBound)} for the lower bound${plan.requestsExpected ? `, ~ ${hours(plan.requestsExpected * (pauseMs / 1000 + 1.4))} modelled (adds ~1.4 s latency per request, as measured in the 2026-10-30 inventory pull)` : ""}`);
  lines.push(`  request cap this run: ${cli.maxRequests}; page size ${pageSize}; progress file ${progressPath}`);
  lines.push(`  mode: ${cli.dryRun ? "dry run" : cli.noStore ? "fetch only (--no-store)" : "fetch and store (live mode, variety-wise source)"}`);
  const enabled = manifest.products.filter((p) => p.enabled && (!only || only.has(p.productId)));
  lines.push(`  products pulled: ${enabled.length}; labels: ${check.labels.size}`);
  for (const p of enabled) {
    lines.push(`    ${p.productId.padEnd(20)} ${p.commodities.map((c) => `${c.label}${check.labels.get(normLabel(c.label))?.verified ? "" : " [unverified]"}`).join(" | ")}`);
  }
  if (existsSync(progressPath) && !cli.resetProgress) {
    try {
      const p = JSON.parse(readFileSync(progressPath, "utf8")) as Progress;
      const digest = labelsDigest(check.labels);
      const done = planUnits(states, dates).filter((u) => p.units[u.key]?.status === "done" && p.units[u.key]?.labelsDigest === digest).length;
      lines.push(`  progress: ${done} of ${plan.units} units already done for this label set; ${p.requests} request(s) so far${p.cooldown ? `; cooldown until ${p.cooldown.until}` : ""}`);
    } catch {
      lines.push("  progress: file exists but could not be read");
    }
  } else lines.push("  progress: none yet");
  for (const w of check.warnings) lines.push(`  warning: ${w}`);
  for (const e of check.errors) lines.push(`  ERROR: ${e}`);
  console.log(lines.join("\n"));
  if (check.errors.length) return 2;
  if (cli.dryRun) return 0;

  await import("../../apps/api/src/env");
  const config = loadProviderConfig();
  if (!config.DATA_GOV_IN_API_KEY) {
    console.log("DATA_GOV_IN_API_KEY is not set: unavailable (api_key_missing). No request made.");
    return 0;
  }
  if (config.RUNTIME_MODE === "replay") {
    console.error("Refusing: ingestion is disabled in replay mode.");
    return 2;
  }
  if (!cli.noStore && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required (or pass --no-store or --dry-run).");
    return 2;
  }

  let pool: Pool | null = null;
  let sourceId: string | null = null;
  let runId: string | null = null;
  let before: unknown = null;
  const slugs = enabled.map((p) => p.productId);
  const dbStart = new Date();
  const rangeLo = [...dates].sort()[0] ?? from;
  const rangeHi = [...dates].sort().at(-1) ?? to;
  const { createPool } = await import("../../apps/api/src/db/pool");
  const { ensureSource } = await import("../../apps/api/src/ingest/sources");
  const { finishRun, payloadHash, startRun } = await import("../../apps/api/src/ingest/runs");
  const counts = async (): Promise<unknown> =>
    (await pool!.query(
      `SELECT p.slug, m.state_name AS state, m.validation_status AS status, count(*)::int AS rows
         FROM market_observations m JOIN crop_products p ON p.id = m.product_id JOIN source_documents s ON s.id = m.source_id
        WHERE s.manifest_id = $1 AND m.mode = 'live' AND NOT m.is_synthetic AND m.vintage_seq = 1 AND m.observed_on BETWEEN $2::date AND $3::date AND p.slug = ANY($4::text[])
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [MANDI_RESOURCES[manifest.resourceId]!.manifestId, rangeLo, rangeHi, slugs],
    )).rows;
  if (!cli.noStore) {
    pool = createPool(process.env.DATABASE_URL!);
    const have = new Set((await pool.query<{ slug: string }>("SELECT slug FROM crop_products WHERE slug = ANY($1::text[])", [slugs])).rows.map((r) => r.slug));
    const missing = slugs.filter((s) => !have.has(s));
    if (missing.length) console.log(`note: crop_products has no row for ${missing.join(", ")}; those rows are counted as skippedNoProduct and not stored`);
    const src = MANDI_RESOURCES[manifest.resourceId]!;
    sourceId = await ensureSource(pool, src.manifestId, { title: src.title, publisher: "Open Government Data Platform India", url: `https://api.data.gov.in/resource/${manifest.resourceId}`, licence: "see manifest" });
    runId = await startRun(pool, { jobId: null, jobType: "ingest.market_prices", hash: payloadHash({ manifest: manifest.id, states, dates: [dates.length, rangeLo, rangeHi, step], products: slugs.sort(), startedAt: dbStart.toISOString() }), provider: "data.gov.in", mode: "live" });
    before = await counts();
  }

  const log = (s: string) => console.log(s);
  const storeRows = pool && sourceId ? (rows: MandiRow[], availableAt: Date) => storeMarketRows(pool!, rows, { sourceId: sourceId!, mode: "live", availableAt }) : undefined;
  const result = await runPull(
    { manifest, labels: check.labels, states, dates, order: cli.order, pauseMs, maxRequests: cli.maxRequests, pageSize, progressPath, ignoreCooldown: cli.ignoreCooldown, defaultCooldownSeconds: cli.defaultCooldownSeconds, transientRetries: 2, resetProgress: cli.resetProgress },
    { config, fetchImpl: globalThis.fetch as unknown as FetchLike, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(), commodityMap: map, storeRows, log },
  );

  const progress = loadProgress(progressPath, manifest, new Date());
  const after = pool ? await counts() : null;
  const stored = Object.values(progress.units).reduce((a, u) => ({ inserted: a.inserted + u.stored.inserted, revisions: a.revisions + u.stored.revisions, unchanged: a.unchanged + u.stored.unchanged, skippedNoProduct: a.skippedNoProduct + u.stored.skippedNoProduct, skippedUnmapped: a.skippedUnmapped + u.stored.skippedUnmapped, storedUnverifiedMapping: a.storedUnverifiedMapping + u.stored.storedUnverifiedMapping }), emptyStored());
  const unmatched = unmatchedLabels(progress, manifest, check.labels);
  const suspects = Object.entries(progress.units).filter(([, u]) => u.pagingSuspect).map(([k, u]) => `${k} (${u.repeatedRows}/${u.rowsRead} repeated)`);
  const summary = {
    manifestId: manifest.id,
    resourceId: manifest.resourceId,
    startedAt: dbStart.toISOString(),
    finishedAt: new Date().toISOString(),
    result,
    mode: cli.noStore ? "no-store" : "store",
    states,
    dates: { count: dates.length, from: rangeLo, to: rangeHi, step },
    storedTotalsAcrossAllRuns: stored,
    byProductMatchedRowsAcrossAllRuns: progress.byProduct,
    dbRowsBefore: before,
    dbRowsAfter: after,
    pagingSuspectUnits: suspects,
    unmatchedLabelsTop: unmatched.slice(0, 60),
  };
  const outDir = resolve(REPO, "data/raw/datagovin");
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, `ingest-mandi-history-${dbStart.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 1) + "\n");
  if (pool && runId) {
    await finishRun(pool, runId, result.status === "failed" ? "failed" : "succeeded", { status: result.status, requests: result.requests, unitsDone: result.unitsDone, stored }, { manifest: manifest.id, states, from: rangeLo, to: rangeHi, products: slugs });
    await pool.end();
  }
  console.log(`result: ${result.status}: ${result.message}`);
  console.log(`requests this run ${result.requests}; units done this run ${result.unitsDone}, skipped as already done ${result.unitsSkippedDone}, remaining ${result.unitsRemaining}`);
  if (before !== null || after !== null) console.log(`db rows (live, vintage 1, variety-wise source) before: ${JSON.stringify(before)}\n  after: ${JSON.stringify(after)}`);
  console.log(`stored across all runs of this progress file: ${JSON.stringify(stored)}`);
  if (suspects.length) console.log(`paging suspect units (rows repeated across pages): ${suspects.slice(0, 10).join("; ")}${suspects.length > 10 ? " ..." : ""}`);
  if (unmatched.length) {
    console.log(`labels returned but not in the manifest (top ${Math.min(25, unmatched.length)} of ${unmatched.length}; hinted ones first):`);
    for (const u of unmatched.slice(0, 25)) console.log(`  ${u.state} | ${u.label} | ${u.rows} rows ${u.firstDate}..${u.lastDate}${u.hintedProduct ? ` | possible alias for ${u.hintedProduct}` : ""}`);
  }
  console.log(`wrote ${file}`);
  if (result.status === "stopped_rate_limited") return 75;
  return result.status === "failed" ? 1 : 0;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`ingest-mandi-history failed: ${e instanceof Error ? e.message.replace(/api-key=[^&\s]*/gi, "api-key=REDACTED") : "unknown error"}`);
      process.exit(1);
    },
  );
}
