export const STATES: { code: string; name: string }[] = [
  ["AN", "Andaman and Nicobar Islands"], ["AP", "Andhra Pradesh"], ["AR", "Arunachal Pradesh"], ["AS", "Assam"], ["BR", "Bihar"], ["CH", "Chandigarh"],
  ["CG", "Chhattisgarh"], ["DN", "Dadra and Nagar Haveli and Daman and Diu"], ["DL", "Delhi"], ["GA", "Goa"], ["GJ", "Gujarat"], ["HR", "Haryana"],
  ["HP", "Himachal Pradesh"], ["JK", "Jammu and Kashmir"], ["JH", "Jharkhand"], ["KA", "Karnataka"], ["KL", "Kerala"], ["LA", "Ladakh"], ["LD", "Lakshadweep"],
  ["MP", "Madhya Pradesh"], ["MH", "Maharashtra"], ["MN", "Manipur"], ["ML", "Meghalaya"], ["MZ", "Mizoram"], ["NL", "Nagaland"], ["OD", "Odisha"],
  ["PY", "Puducherry"], ["PB", "Punjab"], ["RJ", "Rajasthan"], ["SK", "Sikkim"], ["TN", "Tamil Nadu"], ["TS", "Telangana"], ["TR", "Tripura"],
  ["UP", "Uttar Pradesh"], ["UK", "Uttarakhand"], ["WB", "West Bengal"],
].map(([code, name]) => ({ code: code!, name: name! }));

/** Display name for a stored state id ("IN-KA") or a legacy bare code ("KA"). */
export function stateLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const bare = code.replace(/^IN-/i, "").toUpperCase();
  return STATES.find((s) => s.code === bare)?.name ?? null;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const IRRIGATION_OPTIONS = [
  { value: "rainfed", label: "Rain only" },
  { value: "supplemental", label: "Rain plus some irrigation" },
  { value: "irrigated", label: "Irrigated" },
  { value: "unknown", label: "I don't know" },
] as const;

export const HA_PER_ACRE = 0.40468564224;

export interface FarmFormInput {
  /** Free-text district; used when no registry district is selected (state without a list, "not listed", or no state). */
  district: string;
  /** Registry state id such as "IN-KA"; "" = not sure. */
  stateId: string;
  /** Registry district id picked from the list; "" = none picked. Never typed or derived client-side. */
  districtId: string;
  /** Display name of the picked district (for the farm title only). */
  districtLabel?: string;
  startMonth: string; // "" = not decided; otherwise "1".."12"
  endMonth: string;
  irrigation: string; // rainfed|supplemental|irrigated|unknown
  areaKnown: boolean;
  area: string;
  areaUnit: "acre" | "ha";
}

export type FarmFormErrors = Partial<Record<"district" | "window" | "irrigation" | "area", string>>;

export function validateFarmForm(f: FarmFormInput): FarmFormErrors {
  const e: FarmFormErrors = {};
  if (f.districtId) {
    if (!f.stateId || !f.districtId.startsWith(`${f.stateId}-`)) e.district = "Choose the state again, then pick the district.";
  } else if (!f.district.trim()) e.district = "Enter or choose your district.";
  else if (f.district.trim().length > 120) e.district = "District name is too long (120 characters at most).";
  else if (!/[\p{L}\p{N}]/u.test(f.district)) e.district = "District name needs letters or numbers.";
  if ((f.startMonth === "") !== (f.endMonth === "")) e.window = "Choose both the first and last month, or choose \"Not decided\" for both.";
  if (!["rainfed", "supplemental", "irrigated", "unknown"].includes(f.irrigation)) e.irrigation = "Choose how the land is watered, or \"I don't know\".";
  if (f.areaKnown) {
    const n = Number(f.area);
    if (f.area.trim() === "" || !Number.isFinite(n) || n <= 0) e.area = "Enter the area as a number above 0, or tick \"I don't know the area\".";
    else if (n * (f.areaUnit === "acre" ? HA_PER_ACRE : 1) > 1_000_000) e.area = "That area is too large.";
  }
  return e;
}

/** Builds the POST /farms body. Unknown answers are left out entirely (no fact is better than a made-up one). */
export function buildFarmBody(f: FarmFormInput): Record<string, unknown> {
  const district = (f.districtId ? f.districtLabel?.trim() || "" : f.district.trim()) || "My";
  const facts: Record<string, unknown> = {};
  const reported = { basis: "farmer_reported", confirmed: true, source: "farm form" };
  if (f.startMonth !== "" && f.endMonth !== "") {
    facts.planting_window_start_month = { value: Number(f.startMonth), unit: "month", ...reported };
    facts.planting_window_end_month = { value: Number(f.endMonth), unit: "month", ...reported };
  }
  if (f.irrigation !== "unknown") facts.irrigation_category = { value: f.irrigation, ...reported };
  const body: Record<string, unknown> = {
    name: `${district} farm`.slice(0, 120),
    location: {
      // A picked id comes from the registry list; otherwise only the farmer's text is sent and the server resolves it.
      ...(f.districtId ? { districtId: f.districtId } : { districtName: f.district.trim() }),
      ...(f.stateId ? { stateId: f.stateId } : {}),
      precision: "district",
    },
    facts,
  };
  if (f.areaKnown) {
    const n = Number(f.area);
    const ha = f.areaUnit === "acre" ? n * HA_PER_ACRE : n;
    body.areaHectares = Math.round(ha * 10000) / 10000;
    facts.area_reported = { value: n, unit: f.areaUnit, ...reported };
  }
  return body;
}
