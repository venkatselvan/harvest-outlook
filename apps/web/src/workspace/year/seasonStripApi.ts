import { StageTimeline } from "@harvest/contracts";
import { apiRequest } from "../../features/photo-region/http";

/**
 * GET /api/v1/farms/:id/stage-timeline?cycleId=: the calendar stage timeline of one cycle, built by code from the crop's
 * sourced stage durations (no provider call). The season strip reads the stage names from it. Any failure (route missing,
 * network, a payload that does not match the contract, a timeline for another farm or crop) returns null: the strip then
 * labels the growing crop from the plan's own harvest window and says nothing it cannot back.
 */
export async function loadStageTimeline(
  farmId: string,
  cycleId: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<StageTimeline | null> {
  try {
    const path = `/api/v1/farms/${encodeURIComponent(farmId)}/stage-timeline?cycleId=${encodeURIComponent(cycleId)}`;
    const env = await apiRequest<unknown>(path, signal ? { signal } : undefined, fetchImpl);
    const data = env.data as { farmId?: unknown; cycleId?: unknown; timeline?: unknown } | null;
    if (!data || data.farmId !== farmId || data.cycleId !== cycleId) return null;
    const parsed = StageTimeline.nullable().safeParse(data.timeline);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
