import { MONTHS } from "../profile/model";
import type { CompareItem, Dimension, DimensionKey, EvidenceCitation, Outcome } from "./types";

export const MAX_COMPARE = 3;

const ORDER: Record<Outcome, number> = { eligible: 0, requires_review: 1, unknown: 2, ineligible: 3, excluded_by_farmer: 4 };

export const OUTCOME_LABEL: Record<Outcome, string> = {
  eligible: "Eligible",
  requires_review: "Needs review",
  unknown: "Unknown",
  ineligible: "Not eligible",
  excluded_by_farmer: "You excluded this crop",
};

export const OUTCOME_HELP: Record<Outcome, string> = {
  eligible: "The sourced rules that apply here allow this crop for your inputs.",
  requires_review: "A sourced rule flags a condition that needs a person to check it.",
  unknown: "The evidence cannot say yes or no for your inputs. This is not a finding that the crop cannot grow here.",
  ineligible: "A sourced rule excludes this crop for your inputs.",
  excluded_by_farmer: "You asked not to grow this crop.",
};

export const itemKey = (i: Pick<CompareItem, "cropId" | "productId">): string => `${i.cropId}/${i.productId}`;

/** Eligible, then requires_review, unknown, ineligible, farmer-excluded; the server rank breaks ties. Does not mutate. */
export function sortItems(items: readonly CompareItem[]): CompareItem[] {
  return [...items].sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome] || a.rank - b.rank);
}

/** Toggles a key in the selection. A fourth selection is refused (returns the same array, blocked: true). */
export function toggleSelection(selected: readonly string[], key: string, max = MAX_COMPARE): { selected: string[]; blocked: boolean } {
  if (selected.includes(key)) return { selected: selected.filter((k) => k !== key), blocked: false };
  if (selected.length >= max) return { selected: [...selected], blocked: true };
  return { selected: [...selected, key], blocked: false };
}

export type EvidenceState = "observed" | "derived" | "scenario" | "reference" | "farmer_assumption" | "unavailable";
export const STATE_LABEL: Record<EvidenceState, string> = {
  observed: "Observed",
  derived: "Derived",
  scenario: "Scenario",
  reference: "Source reference",
  farmer_assumption: "Your assumption",
  unavailable: "Unavailable",
};
export const STATE_HELP: Record<EvidenceState, string> = {
  observed: "Direct source measurement.",
  derived: "Reproducible calculation from sourced inputs and your answers.",
  scenario: "Conditional calculation with named assumptions; not a forecast.",
  reference: "Figure published by a source for a region or variety; not measured on your farm.",
  farmer_assumption: "A value you supplied.",
  unavailable: "Evidence cannot support a value.",
};

/** State label for an API dimension. No dimension is "observed": nothing here is a measurement on this farm. */
export function dimensionState(key: DimensionKey, d: Dimension): EvidenceState {
  if (d.status !== "known") return "unavailable";
  if (key === "economics") return "scenario";
  if (key === "timeToFirstIncome") return d.basis === "crop_duration_in_sourced_context" ? "reference" : "derived";
  return "derived";
}

export function humanize(code: string): string {
  const s = code.replace(/[._]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const FIELD_LABEL: Record<string, string> = {
  "irrigation.category": "Water access",
  "soil.drainage": "Soil drainage",
  "soil.texture": "Soil texture",
  "rainfall.seasonalMm": "Seasonal rainfall",
  "elevation.m": "Field elevation",
  "location.districtId": "District",
  "location.stateId": "State",
  assumed_price: "Your assumed price",
  regional_context: "A sourced growing context for your region",
};
export const fieldLabel = (f: string): string => FIELD_LABEL[f] ?? humanize(f);

export function monthRange(from: number, to: number): string {
  const a = MONTHS[from - 1];
  const b = MONTHS[to - 1];
  if (!a || !b) return "Not stated";
  return from === to ? a : `${a} to ${b}`;
}

/** Plain-language price state. The label comes from the API; the gated reason gets the fixed wording. */
export function priceLabel(item: Pick<CompareItem, "priceReference">): string {
  const p = item.priceReference;
  if (p.state === "historical_reference") return p.label;
  return PRICE_MISSING_TEXT[p.missingReason] ?? p.label;
}

/** Honest text per missing-price reason. The gated wording is shown only when no price key is configured. */
export const PRICE_MISSING_TEXT: Record<string, string> = {
  price_access_key_gated: "Unavailable — price access pending",
  price_history_not_ingested: "Price history not ingested yet",
  price_history_insufficient: "Too few recent quotes",
  market_not_in_history: "No quotes for this market",
};

const inr = (v: string) => `INR ${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/kg`;

/** Lines for the price row when a historical reference exists; empty otherwise. Wholesale mandi quotes, not a forecast or a farm-gate price. */
export function priceReferenceLines(item: Pick<CompareItem, "priceReference">): string[] {
  const p = item.priceReference;
  if (p.state !== "historical_reference") return [];
  const q = p.lastQuote;
  const variety = [q.variety, q.grade].filter(Boolean).join(", ");
  const lines = [`Last quote ${inr(q.inrPerKg)} on ${q.date} at ${p.marketName}${variety ? ` (${variety})` : ""}.`];
  if (p.weeklyRange) lines.push(`Range of weekly medians, last 52 weeks (${p.weeklyRange.weeks} weeks): ${inr(p.weeklyRange.lowInrPerKg)} to ${inr(p.weeklyRange.highInrPerKg)}. Not a prediction interval.`);
  if (p.fallbackNote) lines.push(`${p.fallbackNote}.`);
  return lines;
}

export const priceBadgeState = (item: Pick<CompareItem, "priceReference">): "observed" | "unavailable" => (item.priceReference.state === "historical_reference" ? "observed" : "unavailable");

export function yieldBasisLabel(item: Pick<CompareItem, "yieldReference">): string | null {
  const y = item.yieldReference;
  if (!y) return null;
  if (!y.appliesToProduct) return "Regional reference exists for a different product form; not applied here";
  return y.basis === "regional_reference" ? "Regional reference" : humanize(y.basis);
}

export function evidenceIdsOf(item: CompareItem): string[] {
  const ids = new Set<string>([...item.screening.evidenceIds, ...(item.plantingWindow?.evidenceIds ?? []), ...(item.yieldReference?.evidenceIds ?? [])]);
  for (const d of Object.values(item.dimensions)) d.evidenceIds.forEach((e) => ids.add(e));
  return [...ids];
}

/** Links only to https URLs the API marks as openly accessible. Anything else is shown as text. */
export function safeLink(e: Pick<EvidenceCitation, "citation" | "licence">): string | null {
  const u = e.citation.sourceUrl;
  if (!u || e.licence.accessStatus !== "open") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function locatorText(l: EvidenceCitation["locator"]): string {
  if (!l) return "no page or section given";
  const parts = [l.page !== undefined ? `page ${l.page}` : null, l.section ? `section "${l.section}"` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "no page or section given";
}

export function selectionStorageValue(item: CompareItem): string {
  return JSON.stringify({
    cropId: item.cropId, productId: item.productId, cropName: item.cropName, productName: item.productName, outcome: item.outcome,
    evidenceCoverage: item.completeness, mostConsequentialMissingInput: item.mostConsequentialMissingInput, selectedAt: new Date().toISOString(),
    note: "Chosen from Explore; missing assumptions are carried with the selection.",
  });
}
export const SELECTED_CROP_KEY = "ho.selectedCrop";

export function farmHref(item: Pick<CompareItem, "cropId" | "productId">): string {
  return `/farm?cropId=${encodeURIComponent(item.cropId)}&productId=${encodeURIComponent(item.productId)}`;
}
