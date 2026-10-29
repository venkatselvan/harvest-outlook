import type { ComparisonRequest, Irrigation } from "../comparison/types";

/** Farmer profile for crop screening. Strings are what the form holds; toRequest() produces the API body. No coordinates are stored. */

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const IRRIGATION_OPTIONS: { value: Irrigation; label: string }[] = [
  { value: "rainfed", label: "Rain only (rainfed)" },
  { value: "supplemental", label: "Rain plus some irrigation" },
  { value: "irrigated", label: "Irrigated" },
  { value: "unknown", label: "I don't know" },
];
export const IRRIGATION_WHY = "Water access decides which sourced planting window and water condition applies to each crop.";

export const HA_PER_ACRE = 0.40468564224;
export const KG_PER_QUINTAL = 100;
export const MAX_NARRATIVE = 1000;

export type AreaUnit = "acre" | "ha";
export type PriceUnit = "inr_per_kg" | "inr_per_quintal";

export interface ProfileInput {
  stateId: string;
  districtId: string;
  plantingMonth: string; // "" or "1".."12"
  plantingDate: string; // "" or YYYY-MM-DD
  irrigation: "" | Irrigation;
  areaKnown: boolean;
  area: string;
  areaUnit: AreaUnit;
  priceOn: boolean;
  price: string;
  priceUnit: PriceUnit;
  priceProductId: string;
  excludedCropIds: string[];
  narrative: string;
}

export type ProfileField = "state" | "district" | "month" | "date" | "irrigation" | "area" | "price" | "priceProduct" | "narrative";
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export const emptyProfile = (): ProfileInput => ({
  stateId: "", districtId: "", plantingMonth: "", plantingDate: "", irrigation: "",
  areaKnown: false, area: "", areaUnit: "acre", priceOn: false, price: "", priceUnit: "inr_per_kg", priceProductId: "", excludedCropIds: [], narrative: "",
});

const parsePositive = (s: string): number | null => {
  const t = s.trim();
  if (t === "" || !/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const validIsoDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function priceInrPerKg(input: Pick<ProfileInput, "price" | "priceUnit">): number | null {
  const n = parsePositive(input.price);
  if (n === null) return null;
  return input.priceUnit === "inr_per_quintal" ? n / KG_PER_QUINTAL : n;
}

export function validateProfile(p: ProfileInput): ProfileErrors {
  const e: ProfileErrors = {};
  if (!/^IN-[A-Z]{2}$/.test(p.stateId)) e.state = "Choose your state.";
  const m = Number(p.plantingMonth);
  if (p.plantingMonth === "" || !Number.isInteger(m) || m < 1 || m > 12) e.month = "Choose the month you plan to plant (January to December).";
  if (p.plantingDate !== "") {
    if (!validIsoDate(p.plantingDate)) e.date = "Enter a real date, or clear the field.";
    else if (!e.month && Number(p.plantingDate.slice(5, 7)) !== m) e.date = `The exact date must fall in ${MONTHS[m - 1]}.`;
  }
  if (p.irrigation === "") e.irrigation = "Choose how the land is watered, or \"I don't know\".";
  if (p.areaKnown) {
    const n = parsePositive(p.area);
    if (n === null) e.area = "Enter the area as a number above 0, or untick \"I know the area\".";
    else if ((p.areaUnit === "acre" ? n * HA_PER_ACRE : n) > 1_000_000) e.area = "That area is too large; check the unit (acre or hectare).";
  }
  if (p.priceOn) {
    const kg = priceInrPerKg(p);
    if (parsePositive(p.price) === null) e.price = "Enter your assumed price as a number above 0, or untick the price option.";
    else if (kg !== null && kg > 1_000_000) e.price = "That price is too high; check the unit (per kg or per quintal).";
    if (p.priceProductId === "") e.priceProduct = "Choose which crop product this price is for.";
  }
  if (p.narrative.length > MAX_NARRATIVE) e.narrative = `Notes are limited to ${MAX_NARRATIVE} characters.`;
  return e;
}

export const hasErrors = (e: ProfileErrors): boolean => Object.keys(e).length > 0;

const trim2 = (n: number): string => String(Math.round(n * 100) / 100);

/** Display-only conversion shown beside the area field so the unit cannot be misread. The API converts for real. */
export function areaConversionText(p: Pick<ProfileInput, "areaKnown" | "area" | "areaUnit">): string | null {
  if (!p.areaKnown) return null;
  const n = parsePositive(p.area);
  if (n === null) return null;
  return p.areaUnit === "acre" ? `${trim2(n)} acre = ${trim2(n * HA_PER_ACRE)} hectare` : `${trim2(n)} hectare = ${trim2(n / HA_PER_ACRE)} acre`;
}

export function priceConversionText(p: Pick<ProfileInput, "priceOn" | "price" | "priceUnit">): string | null {
  if (!p.priceOn) return null;
  const n = parsePositive(p.price);
  if (n === null) return null;
  return p.priceUnit === "inr_per_quintal" ? `INR ${trim2(n)} per quintal = INR ${trim2(n / KG_PER_QUINTAL)} per kg (1 quintal = 100 kg)` : `INR ${trim2(n)} per kg = INR ${trim2(n * KG_PER_QUINTAL)} per quintal (1 quintal = 100 kg)`;
}

/** Builds the API body. Call only when validateProfile() returned no errors. The narrative is never sent. */
export function toRequest(p: ProfileInput): ComparisonRequest {
  const month = Number(p.plantingMonth);
  const body: ComparisonRequest = {
    location: { stateId: p.stateId, ...(p.districtId ? { districtId: p.districtId } : {}) },
    planting: { month, ...(p.plantingDate ? { date: p.plantingDate } : {}) },
    irrigation: p.irrigation as Irrigation,
    excludedCropIds: [...p.excludedCropIds],
    assumedPrices: [],
  };
  if (p.areaKnown) body.area = { amount: Number(p.area), unit: p.areaUnit };
  if (p.priceOn) {
    const kg = priceInrPerKg(p);
    if (kg !== null && p.priceProductId) body.assumedPrices = [{ productId: p.priceProductId, amountInrPerKg: kg }];
  }
  return body;
}

// ---- persistence (non-sensitive profile only: no coordinates, no narrative)

export const PROFILE_KEY = "ho.exploreProfile.v1";
type Store = Pick<Storage, "getItem" | "setItem">;

export function saveProfile(p: ProfileInput, store: Store | undefined = safeStorage()): void {
  if (!store) return;
  const { narrative: _narrative, ...rest } = p;
  try {
    store.setItem(PROFILE_KEY, JSON.stringify(rest));
  } catch {
    /* storage full or blocked: the form still works */
  }
}

export function loadProfile(store: Store | undefined = safeStorage()): ProfileInput {
  const base = emptyProfile();
  if (!store) return base;
  try {
    const raw = store.getItem(PROFILE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const str = (k: keyof ProfileInput, def: string): string => (typeof o[k] === "string" ? (o[k] as string) : def);
    return {
      ...base,
      stateId: str("stateId", ""), districtId: str("districtId", ""), plantingMonth: str("plantingMonth", ""), plantingDate: str("plantingDate", ""),
      irrigation: (["rainfed", "supplemental", "irrigated", "unknown"].includes(str("irrigation", "")) ? str("irrigation", "") : "") as ProfileInput["irrigation"],
      areaKnown: o.areaKnown === true, area: str("area", ""), areaUnit: o.areaUnit === "ha" ? "ha" : "acre",
      priceOn: o.priceOn === true, price: str("price", ""), priceUnit: o.priceUnit === "inr_per_quintal" ? "inr_per_quintal" : "inr_per_kg", priceProductId: str("priceProductId", ""),
      excludedCropIds: Array.isArray(o.excludedCropIds) ? o.excludedCropIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    };
  } catch {
    return base;
  }
}

function safeStorage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
