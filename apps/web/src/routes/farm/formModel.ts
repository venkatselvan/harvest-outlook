export const STATES: { code: string; name: string }[] = [
  ["AN", "Andaman and Nicobar Islands"], ["AP", "Andhra Pradesh"], ["AR", "Arunachal Pradesh"], ["AS", "Assam"], ["BR", "Bihar"], ["CH", "Chandigarh"],
  ["CG", "Chhattisgarh"], ["DN", "Dadra and Nagar Haveli and Daman and Diu"], ["DL", "Delhi"], ["GA", "Goa"], ["GJ", "Gujarat"], ["HR", "Haryana"],
  ["HP", "Himachal Pradesh"], ["JK", "Jammu and Kashmir"], ["JH", "Jharkhand"], ["KA", "Karnataka"], ["KL", "Kerala"], ["LA", "Ladakh"], ["LD", "Lakshadweep"],
  ["MP", "Madhya Pradesh"], ["MH", "Maharashtra"], ["MN", "Manipur"], ["ML", "Meghalaya"], ["MZ", "Mizoram"], ["NL", "Nagaland"], ["OD", "Odisha"],
  ["PY", "Puducherry"], ["PB", "Punjab"], ["RJ", "Rajasthan"], ["SK", "Sikkim"], ["TN", "Tamil Nadu"], ["TS", "Telangana"], ["TR", "Tripura"],
  ["UP", "Uttar Pradesh"], ["UK", "Uttarakhand"], ["WB", "West Bengal"],
].map(([code, name]) => ({ code: code!, name: name! }));

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const IRRIGATION_OPTIONS = [
  { value: "rainfed", label: "Rain only" },
  { value: "supplemental", label: "Rain plus some irrigation" },
  { value: "irrigated", label: "Irrigated" },
  { value: "unknown", label: "I don't know" },
] as const;

export const HA_PER_ACRE = 0.40468564224;

export interface FarmFormInput {
  district: string;
  stateCode: string; // "" = not sure
  startMonth: string; // "" = not decided; otherwise "1".."12"
  endMonth: string;
  irrigation: string; // rainfed|supplemental|irrigated|unknown
  areaKnown: boolean;
  area: string;
  areaUnit: "acre" | "ha";
}

export type FarmFormErrors = Partial<Record<"district" | "window" | "irrigation" | "area", string>>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export function validateFarmForm(f: FarmFormInput): FarmFormErrors {
  const e: FarmFormErrors = {};
  if (!f.district.trim()) e.district = "Enter your district name.";
  else if (f.district.trim().length > 120) e.district = "District name is too long (120 characters at most).";
  else if (!slug(f.district)) e.district = "District name needs letters or numbers.";
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
  const district = f.district.trim();
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
      districtId: `typed:${f.stateCode || "xx"}:${slug(district)}`.slice(0, 64),
      districtName: district,
      ...(f.stateCode ? { stateCode: f.stateCode } : {}),
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
