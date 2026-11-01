import { MarketTimeline as marketTimelineSchema, type MarketTimeline } from "@harvest/contracts";
import { apiRequest } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Market timeline request (ROUND2_SPEC 3.1). The response is validated against the shared contract and checked to
 * belong to the requested farm and product before the view uses it.
 */
export class MarketDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataError";
  }
}

export interface MarketTimelineQuery {
  productId: string;
  monthsBack?: number;
  monthsAhead?: number;
}

export function marketTimelinePath(farmId: string, q: MarketTimelineQuery): string {
  const params = new URLSearchParams({ productId: q.productId });
  if (q.monthsBack !== undefined) params.set("monthsBack", String(q.monthsBack));
  if (q.monthsAhead !== undefined) params.set("monthsAhead", String(q.monthsAhead));
  return `/api/v1/farms/${encodeURIComponent(farmId)}/market-timeline?${params.toString()}`;
}

export async function loadMarketTimeline(farmId: string, q: MarketTimelineQuery, fetchImpl?: typeof fetch): Promise<MarketTimeline> {
  const env = await apiRequest<unknown>(marketTimelinePath(farmId, q), undefined, fetchImpl);
  const parsed = marketTimelineSchema.safeParse(env.data);
  if (!parsed.success) throw new MarketDataError("The market timeline response did not match the expected format.");
  if (parsed.data.farmId !== farmId) throw new MarketDataError("The market timeline response belongs to another farm.");
  return parsed.data;
}

/** Plain-language error for the Market view. */
export function describeMarketError(error: unknown): string {
  if (error instanceof MarketDataError) return "The market timeline could not be read. Your saved records are unchanged.";
  if (error instanceof ApiError) {
    if (error.status === 404) return "The market timeline is not available on this server yet.";
    if (error.status === 0) return "Could not reach the server. Check your connection and try again.";
    if (error.status === 429) return "Too many requests just now. Wait a minute and try again.";
    return error.message || "The market timeline could not load.";
  }
  return "The market timeline could not load.";
}
