import { SeasonPreview as seasonPreviewSchema, type SeasonPreview } from "@harvest/contracts";
import { apiRequest } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * GET /api/v1/farms/:id/season-preview (ROUND3_SPEC.md section 7). Synchronous on the server (no job, no model call).
 * The response is validated against the shared contract and checked to belong to the requested farm.
 */
export type SeasonPreviewRequest = (
  | { planId: string }
  | { cropId: string; productId?: string; sowing: string; harvestLatest?: string; establishmentMethod?: string; systemId?: string }
) & {
  /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.3): preview on this field (its cycles, saved seasons and area); omitted = the whole farm. */
  fieldId?: string;
};

/** The request with the field it is for; unchanged without a field. */
export const withPreviewField = (q: SeasonPreviewRequest, fieldId: string | null | undefined): SeasonPreviewRequest =>
  fieldId ? { ...q, fieldId } : q;

export class SeasonPreviewDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonPreviewDataError";
  }
}

export function seasonPreviewPath(farmId: string, q: SeasonPreviewRequest): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === "string" && v) params.set(k, v);
  return `/api/v1/farms/${encodeURIComponent(farmId)}/season-preview?${params.toString()}`;
}

export async function loadSeasonPreview(farmId: string, q: SeasonPreviewRequest, fetchImpl?: typeof fetch): Promise<SeasonPreview> {
  const env = await apiRequest<unknown>(seasonPreviewPath(farmId, q), undefined, fetchImpl);
  const parsed = seasonPreviewSchema.safeParse(env.data);
  if (!parsed.success) throw new SeasonPreviewDataError("The season preview did not match the expected format.");
  if (parsed.data.farmId !== farmId) throw new SeasonPreviewDataError("The season preview belongs to another farm.");
  return parsed.data;
}

export function describeSeasonPreviewError(error: unknown): string {
  if (error instanceof SeasonPreviewDataError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 404) return "This season is no longer saved for this farm.";
    if (error.status === 400) return error.message || "This season cannot be previewed as entered.";
    if (error.status === 429) return "Too many previews in a minute. Wait a moment and try again.";
  }
  return "The season preview could not be loaded. Check your connection and try again.";
}
