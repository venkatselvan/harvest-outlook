import { SeasonReport as seasonReportSchema, type SeasonReport } from "@harvest/contracts";
import { apiRequest } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Season report requests (FIELD_OPERATIONS_SPEC.md section 8). The response is validated against the shared contract and must
 * belong to the requested farm before the page uses it.
 */
export interface ReportSelector {
  cycleId?: string | undefined;
  fieldId?: string | undefined;
}

const farmPath = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}`;
/** `?cycleId=..&fieldId=..` (either, both or none). */
export function reportQueryString(q: ReportSelector): string {
  const p = new URLSearchParams();
  if (q.cycleId) p.set("cycleId", q.cycleId);
  if (q.fieldId) p.set("fieldId", q.fieldId);
  const s = p.toString();
  return s ? `?${s}` : "";
}
export const reportPath = (farmId: string, q: ReportSelector) => `${farmPath(farmId)}/season-report${reportQueryString(q)}`;
/** The CSV route with the same query: what the "Download CSV" anchor points at. */
export const reportCsvPath = (farmId: string, q: ReportSelector) => `${farmPath(farmId)}/season-report.csv${reportQueryString(q)}`;

/** The page route for a selector: `/farm/report?cycle=<id>` (a crop) or `?field=<id>` (that field's current crop). */
export function reportHref(q: ReportSelector): string {
  const p = new URLSearchParams();
  if (q.cycleId) p.set("cycle", q.cycleId);
  else if (q.fieldId) p.set("field", q.fieldId);
  const s = p.toString();
  return `/farm/report${s ? `?${s}` : ""}`;
}
/** Reads `?cycle=` and `?field=` from a location search string. */
export function parseSelector(search: string): ReportSelector {
  const p = new URLSearchParams(search);
  const cycleId = p.get("cycle")?.trim();
  const fieldId = p.get("field")?.trim();
  return { ...(cycleId ? { cycleId } : {}), ...(fieldId ? { fieldId } : {}) };
}

export class ReportDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDataError";
  }
}

export async function loadSeasonReport(farmId: string, q: ReportSelector, fetchImpl?: typeof fetch): Promise<SeasonReport> {
  const env = await apiRequest<unknown>(reportPath(farmId, q), undefined, fetchImpl);
  const parsed = seasonReportSchema.safeParse(env.data);
  if (!parsed.success) throw new ReportDataError("The season report response did not match the expected format.");
  if (parsed.data.farm.id !== farmId) throw new ReportDataError("The season report response belongs to another farm.");
  return parsed.data;
}

export type ReportFailure = { kind: "choose" | "missing" | "other"; message: string };
/** What the page says when the report cannot load: ask for a crop (farm with fields), no such crop, or a plain failure. */
export function describeReportError(error: unknown): ReportFailure {
  if (error instanceof ApiError) {
    if (error.code === "field_required") return { kind: "choose", message: "Choose a crop to report on." };
    if (error.code === "cycle_not_found" || error.code === "field_not_found")
      return { kind: "missing", message: "No crop was found for this report. Record a crop first, or choose another one." };
  }
  return { kind: "other", message: error instanceof Error ? error.message : "The season report could not load." };
}
