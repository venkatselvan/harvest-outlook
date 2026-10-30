import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertDecimal, inr } from "@harvest/domain";

type Dec = ReturnType<typeof inr>;

const here = dirname(fileURLToPath(import.meta.url));

export interface CommodityMapEntry {
  sourceCommodity: string;
  productSlug: string;
  verified: boolean;
  /** The source name does not identify the product (e.g. unqualified "Ginger"); rows carry the unresolved_product flag. */
  unresolved?: boolean;
  note?: string;
}

export function loadCommodityMap(path = resolve(here, "commodity-map.json")): CommodityMapEntry[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as { entries: CommodityMapEntry[] };
  return j.entries;
}

/** Candidate source field names per canonical field (normalised: lower-case, non-alphanumerics -> "_"). */
export const FIELD_CANDIDATES = {
  state: ["state", "state_name"],
  district: ["district", "district_name"],
  market: ["market", "market_name", "mandi"],
  commodity: ["commodity", "commodity_name"],
  commodityCode: ["commodity_code"],
  variety: ["variety"],
  grade: ["grade"],
  arrivalDate: ["arrival_date", "arrivaldate", "price_date", "date", "reported_date"],
  minPrice: ["min_price", "minprice", "min_x0020_price", "minimum_price"],
  maxPrice: ["max_price", "maxprice", "max_x0020_price", "maximum_price"],
  modalPrice: ["modal_price", "modalprice", "modal_x0020_price"],
  arrivals: ["arrivals", "arrival", "arrivals_in_qtl", "arrivals_qtl", "arrival_quantity"],
} as const;
type Canonical = keyof typeof FIELD_CANDIDATES;

export function normKey(k: string): string {
  return k.toLowerCase().replace(/_x0020_/g, "_").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Accepts dd/mm/yyyy (the source format), dd-mm-yyyy and yyyy-mm-dd. Returns ISO date or null. Rejects impossible dates. */
export function parseSourceDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (mt) {
    d = Number(mt[1]); m = Number(mt[2]); y = Number(mt[3]);
  } else if ((mt = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t))) {
    y = Number(mt[1]); m = Number(mt[2]); d = Number(mt[3]);
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseNumber(v: unknown): Dec | null | "invalid" {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || /^(na|n\/a|null|-|--)$/i.test(s)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return "invalid";
  return inr(s);
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export type RejectReason = "missing_identity" | "bad_date" | "no_price" | "non_positive_price" | "invalid_price";

export interface MandiRow {
  marketId: string;
  marketName: string;
  state: string | null;
  district: string | null;
  commodity: string;
  /** Source Commodity_Code as a string when present (variety-wise resource; 103 = Ginger(Green), 27 = Ginger(Dry)). */
  commodityCode: string | null;
  productSlug: string | null;
  mappingVerified: boolean;
  variety: string | null;
  grade: string | null;
  observedOn: string;
  /** Source unit, as stored (price_* columns). */
  sourceUnit: "INR/quintal";
  priceMin: string | null;
  priceModal: string | null;
  priceMax: string | null;
  /** Canonical INR/kg, converted with @harvest/domain. */
  priceMinPerKg: string | null;
  priceModalPerKg: string | null;
  priceMaxPerKg: string | null;
  arrivals: string | null;
  /** Only set when the source field name states the unit; never inferred from magnitude. */
  arrivalsUnit: string | null;
  flags: string[];
  raw: Record<string, unknown>;
}

export interface NormalizeReport {
  rows: MandiRow[];
  rejected: Array<{ reason: RejectReason; index: number }>;
  duplicatesIgnored: number;
  conflictsFlagged: number;
  unmappedFields: string[];
  unmappedCommodities: string[];
}

export interface NormalizeOptions {
  commodityMap?: CommodityMapEntry[];
  /** Set true only after rows have confirmed the unit; until then every row carries a flag. */
  sourceUnitVerified?: boolean;
}

function pick(rec: Map<string, unknown>, c: Canonical): { key: string; value: unknown } | null {
  for (const cand of FIELD_CANDIDATES[c]) if (rec.has(cand)) return { key: cand, value: rec.get(cand) };
  return null;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || /^na$/i.test(s) ? null : s;
};

const perKg = (d: Dec | null): string | null => (d ? convertDecimal(d, "INR/quintal", "INR/kg").toDecimalPlaces(6).toString() : null);

export function normalizeMandiRecords(records: Array<Record<string, unknown>>, opts: NormalizeOptions = {}): NormalizeReport {
  const map = opts.commodityMap ?? loadCommodityMap();
  const bySource = new Map(map.map((e) => [e.sourceCommodity.toLowerCase().replace(/\s+/g, ""), e]));
  const mappedKeys = new Set<string>(Object.values(FIELD_CANDIDATES).flat());
  const report: NormalizeReport = { rows: [], rejected: [], duplicatesIgnored: 0, conflictsFlagged: 0, unmappedFields: [], unmappedCommodities: [] };
  const unmappedFields = new Set<string>();
  const unmappedCommodities = new Set<string>();
  const seen = new Map<string, MandiRow>();

  records.forEach((original, index) => {
    const rec = new Map<string, unknown>(Object.entries(original).map(([k, v]) => [normKey(k), v]));
    for (const k of rec.keys()) if (!mappedKeys.has(k)) unmappedFields.add(k);
    const market = str(pick(rec, "market")?.value);
    const commodity = str(pick(rec, "commodity")?.value);
    const state = str(pick(rec, "state")?.value);
    const district = str(pick(rec, "district")?.value);
    if (!market || !commodity) return void report.rejected.push({ reason: "missing_identity", index });
    const observedOn = parseSourceDate(pick(rec, "arrivalDate")?.value);
    if (!observedOn) return void report.rejected.push({ reason: "bad_date", index });

    const prices = { min: parseNumber(pick(rec, "minPrice")?.value), modal: parseNumber(pick(rec, "modalPrice")?.value), max: parseNumber(pick(rec, "maxPrice")?.value) };
    const vals = Object.values(prices);
    if (vals.includes("invalid")) return void report.rejected.push({ reason: "invalid_price", index });
    const nums = vals.filter((v): v is Dec => typeof v === "object" && v !== null);
    if (nums.length === 0) return void report.rejected.push({ reason: "no_price", index });
    if (nums.some((n) => n.lte(0))) return void report.rejected.push({ reason: "non_positive_price", index });

    const flags: string[] = [];
    // Field metadata states no unit; INR/quintal is the Agmarknet convention, supported by magnitudes but not confirmed.
    if (!opts.sourceUnitVerified) flags.push("source_unit_assumed_inr_per_quintal", "unit_basis:agmarknet_convention_inr_per_quintal");
    const { min, modal, max } = prices as { min: Dec | null; modal: Dec | null; max: Dec | null };
    if ((min && max && min.gt(max)) || (min && modal && min.gt(modal)) || (modal && max && modal.gt(max))) flags.push("price_order_violation");

    const entry = bySource.get(commodity.toLowerCase().replace(/\s+/g, ""));
    if (!entry) {
      unmappedCommodities.add(commodity);
      flags.push("commodity_unmapped");
    } else {
      if (!entry.verified) flags.push("commodity_mapping_unverified");
      if (entry.unresolved) flags.push("unresolved_product");
    }

    const arrivalsPick = pick(rec, "arrivals");
    const arrivalsDec = arrivalsPick ? parseNumber(arrivalsPick.value) : null;
    const arrivalsUnit = arrivalsPick && /qtl|quintal/.test(arrivalsPick.key) ? "quintal" : null;

    const row: MandiRow = {
      marketId: `agmarknet:${slug([state ?? "", district ?? "", market].join("|"))}`,
      marketName: market,
      state,
      district,
      commodity,
      commodityCode: str(pick(rec, "commodityCode")?.value),
      productSlug: entry?.productSlug ?? null,
      mappingVerified: entry?.verified ?? false,
      variety: str(pick(rec, "variety")?.value),
      grade: str(pick(rec, "grade")?.value),
      observedOn,
      sourceUnit: "INR/quintal",
      priceMin: min?.toString() ?? null,
      priceModal: modal?.toString() ?? null,
      priceMax: max?.toString() ?? null,
      priceMinPerKg: perKg(min),
      priceModalPerKg: perKg(modal),
      priceMaxPerKg: perKg(max),
      arrivals: typeof arrivalsDec === "object" && arrivalsDec !== null ? arrivalsDec.toString() : null,
      arrivalsUnit: typeof arrivalsDec === "object" && arrivalsDec !== null ? arrivalsUnit : null,
      flags,
      raw: { ...original },
    };
    // Identity: market + product + observed date + variety + grade (+ source, constant within a batch).
    const key = [row.marketId, slug(commodity), observedOn, slug(row.variety ?? ""), slug(row.grade ?? "")].join("#");
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, row);
      report.rows.push(row);
      return;
    }
    const same = prior.priceMin === row.priceMin && prior.priceModal === row.priceModal && prior.priceMax === row.priceMax && prior.arrivals === row.arrivals;
    if (same) {
      report.duplicatesIgnored++;
      return;
    }
    // Conflicting duplicate: keep the first report, flag it and retain the alternative for review.
    if (!prior.flags.includes("conflicting_duplicate")) {
      prior.flags.push("conflicting_duplicate");
      report.conflictsFlagged++;
    }
    const alts = (prior.raw.__conflictingDuplicates ??= []) as unknown[];
    alts.push(original);
  });

  report.unmappedFields = [...unmappedFields].sort();
  report.unmappedCommodities = [...unmappedCommodities].sort();
  return report;
}
