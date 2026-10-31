import { ApiError } from "../lib/api";
import {
  FarmSoilMarkers as farmSoilMarkersSchema,
  SoilReport as soilReportSchema,
  type FarmSoilMarkers,
  type SoilReport,
  type SoilMarkerDraft,
  type SoilParameter,
} from "@harvest/contracts";
import { apiRequest, jsonInit } from "../features/photo-region/http";
export const SOIL_BASELINE: SoilParameter[] = [
  "ph",
  "electrical_conductivity",
  "organic_carbon",
  "nitrogen_available",
  "phosphorus_available",
  "potassium_available",
  "sulphur_available",
  "zinc_available",
  "boron_available",
  "iron_available",
  "manganese_available",
  "copper_available",
];
export const soilLabel = (parameter: string) =>
  (
    ({
      ph: "pH",
      electrical_conductivity: "Electrical conductivity",
      organic_carbon: "Organic carbon",
      nitrogen_available: "Available nitrogen",
      phosphorus_available: "Available phosphorus",
      potassium_available: "Available potassium",
      sulphur_available: "Available sulphur",
      zinc_available: "Available zinc",
      boron_available: "Available boron",
      iron_available: "Available iron",
      manganese_available: "Available manganese",
      copper_available: "Available copper",
      organic_matter: "Organic matter",
      nitrogen_total: "Total nitrogen",
      nitrogen_unspecified: "Nitrogen · form unspecified",
      phosphorus_total: "Total phosphorus",
      potassium_total: "Total potassium",
      nitrate_n: "Nitrate-N",
      ammonium_n: "Ammonium-N",
      cec: "Cation exchange capacity",
      esp: "Exchangeable sodium percentage",
      sar: "Sodium adsorption ratio",
    }) as Record<string, string>
  )[parameter] ?? parameter.replace(/_/g, " ");
export async function loadSoilMarkers(
  farmId: string,
): Promise<FarmSoilMarkers | undefined> {
  const data = (await apiRequest(`/api/v1/farms/${farmId}/soil-markers`)).data;
  const parsed = farmSoilMarkersSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
function reportResponse(data: unknown): SoilReport {
  const parsed = soilReportSchema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      "The soil report service returned an unreadable response. Your original has not been changed.",
    );
  return parsed.data;
}
export async function loadSoilReport(reportId: string): Promise<SoilReport> {
  return reportResponse(
    (await apiRequest(`/api/v1/soil-reports/${reportId}`)).data,
  );
}
export async function uploadSoilReport(
  farmId: string,
  file: File,
  key: string,
): Promise<SoilReport> {
  const body = new FormData();
  body.append("file", file);
  return reportResponse(
    (
      await apiRequest(`/api/v1/farms/${farmId}/soil-reports`, {
        method: "POST",
        headers: { "idempotency-key": key },
        body,
      })
    ).data,
  );
}
export async function loadReferenceReport(
  farmId: string,
  key: string,
): Promise<SoilReport> {
  return reportResponse(
    (
      await apiRequest(
        `/api/v1/farms/${farmId}/soil-reports/sample`,
        jsonInit("POST", {}, { "idempotency-key": key }),
      )
    ).data,
  );
}
/** Parse only the result literally entered in the review form; no unit, analyte or method conversion. */
export function printedResult(
  rawValue: string,
): Pick<SoilMarkerDraft, "rawValue" | "numericValue" | "qualifier" | "range"> {
  const value = rawValue.trim();
  const number = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
  if (/^(?:bdl|below detection(?: limit)?|not detected|nd)$/i.test(value))
    return {
      rawValue,
      numericValue: null,
      qualifier: "below_detection",
      range: null,
    };
  const censored = value.match(new RegExp(`^(<=|>=|<|>|≤|≥)\\s*(${number})$`));
  if (censored)
    return {
      rawValue,
      numericValue: Number(censored[2]),
      qualifier: (
        {
          "<": "less_than",
          ">": "greater_than",
          "<=": "less_or_equal",
          "≤": "less_or_equal",
          ">=": "greater_or_equal",
          "≥": "greater_or_equal",
        } as Record<string, SoilMarkerDraft["qualifier"]>
      )[censored[1]!]!,
      range: null,
    };
  const span = value.match(
    new RegExp(`^(${number})\\s*(?:–|—|to|-)\\s*(${number})$`, "i"),
  );
  if (span && Number(span[1]) <= Number(span[2]))
    return {
      rawValue,
      numericValue: null,
      qualifier: "range",
      range: { low: Number(span[1]), high: Number(span[2]) },
    };
  if (new RegExp(`^${number}$`).test(value) && Number.isFinite(Number(value)))
    return {
      rawValue,
      numericValue: Number(value),
      qualifier: "exact",
      range: null,
    };
  return { rawValue, numericValue: null, qualifier: "text", range: null };
}

export function soilPollDelay(error: unknown): number {
  if (error instanceof ApiError && error.status === 429) {
    const seconds = error.message.match(
      /retry\s*(?:in|after)?\s*(\d+)\s*second/i,
    )?.[1];
    return Math.max(
      2000,
      error.retryAfterMs ?? (seconds ? Number(seconds) * 1000 : 60000),
    );
  }
  return error ? 7000 : 2500;
}
