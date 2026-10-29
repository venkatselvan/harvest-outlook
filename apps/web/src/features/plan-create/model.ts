import { isIsoDate, todayInKolkata } from "../season-explorer/model";
import type { CreatePlanInput } from "../../lib/plan-api";

/** First day of the next calendar month (India time): the default planting date offered to the farmer, always editable. */
export function defaultPlantingDate(now: Date): string {
  const [y, m] = todayInKolkata(now).split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

export interface CreatePlanForm {
  plantingDate: string;
  area: string;
  irrigation: "" | "rainfed" | "supplemental" | "irrigated";
  price: string;
}
export type CreatePlanErrors = Partial<Record<"plantingDate" | "area" | "irrigation" | "price", string>>;

export interface FarmKnown {
  hasArea: boolean;
  hasIrrigation: boolean;
}

/** Validates the form. Area and irrigation are required only when the farm does not already hold them. */
export function validateCreate(f: CreatePlanForm, known: FarmKnown): CreatePlanErrors {
  const e: CreatePlanErrors = {};
  if (!isIsoDate(f.plantingDate)) e.plantingDate = "Enter a planting date.";
  const area = f.area.trim();
  if (area === "") {
    if (!known.hasArea) e.area = "Enter the area in hectares.";
  } else {
    const a = Number(area);
    if (!Number.isFinite(a) || a <= 0 || a > 100000) e.area = "Area must be a number above zero (hectares).";
  }
  if (!known.hasIrrigation && f.irrigation === "") e.irrigation = "Choose how the land is watered. Irrigation tasks depend on it.";
  if (f.price.trim() !== "") {
    const p = Number(f.price);
    if (!Number.isFinite(p) || p < 0) e.price = "Price must be zero or more (rupees per kg).";
  }
  return e;
}

export function toCreateInput(farmId: string, cropId: string, productId: string, f: CreatePlanForm): CreatePlanInput {
  const out: CreatePlanInput = { farmId, cropId, productId, plantingDate: f.plantingDate };
  if (f.area.trim() !== "") out.areaHa = Number(f.area);
  if (f.irrigation !== "") out.irrigationCategory = f.irrigation;
  if (f.price.trim() !== "") out.assumedPriceInrPerKg = Number(f.price);
  return out;
}

