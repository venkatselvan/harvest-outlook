import {
  CompleteCareTaskResult,
  FarmAlert as farmAlertSchema,
  TodayView as todayViewSchema,
  type CareTask,
  type FarmAlert,
  type TodayView,
} from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Today view requests. Paths are fixed by docs/research/UI_BRIEF.md section 4. Every response is validated against
 * the shared contract and checked to belong to the requested farm before the view uses it.
 */
const farmPath = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}`;

/** Thrown when the server answers with data that does not match the contract or belongs to another farm. */
export class TodayDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodayDataError";
  }
}

export async function loadToday(farmId: string, fetchImpl?: typeof fetch): Promise<TodayView> {
  const env = await apiRequest<unknown>(`${farmPath(farmId)}/today`, undefined, fetchImpl);
  const parsed = todayViewSchema.safeParse(env.data);
  if (!parsed.success) throw new TodayDataError("The Today view response did not match the expected format.");
  if (parsed.data.farmId !== farmId) throw new TodayDataError("The Today view response belongs to another farm.");
  return parsed.data;
}

/** POST .../alerts/:alertId/dismiss. The route takes no body; dismissing twice is harmless. */
export async function dismissAlert(farmId: string, alertId: string, fetchImpl?: typeof fetch): Promise<FarmAlert> {
  const env = await apiRequest<unknown>(
    `${farmPath(farmId)}/alerts/${encodeURIComponent(alertId)}/dismiss`,
    { method: "POST" },
    fetchImpl,
  );
  const parsed = farmAlertSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.farmId !== farmId || parsed.data.id !== alertId)
    throw new TodayDataError("The dismiss response did not match this alert.");
  return parsed.data;
}

/**
 * The existing idempotent care completion (same path, body and idempotency header the previous Today tab used).
 * Reuse one `clientEntryId` for retries of the same tap so the journal gets one entry.
 */
export async function completeCare(
  farmId: string,
  task: Pick<CareTask, "id" | "cycleId">,
  clientEntryId: string,
  completedOn: string,
  fetchImpl?: typeof fetch,
): Promise<CareCompletion> {
  const env = await apiRequest<unknown>(
    `${farmPath(farmId)}/cycles/${encodeURIComponent(task.cycleId)}/care/${encodeURIComponent(task.id)}/complete`,
    jsonInit("POST", { clientEntryId, completedOn }, { "idempotency-key": clientEntryId }),
    fetchImpl,
  );
  return CompleteCareTaskResult.parse(env.data);
}
export type CareCompletion = ReturnType<typeof CompleteCareTaskResult.parse>;

/**
 * Same-origin URL for an owner-private scene image. Only relative `/api/v1/farms/...` paths are accepted, so a
 * third-party URL in a response can never be loaded; the browser sends the session cookie with same-origin images.
 */
export function sceneImageUrl(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/api/v1/farms/") || path.includes("//") || path.includes("\\")) return null;
  return path;
}

export type TodayErrorKind = "not_available" | "network" | "invalid" | "server";
export interface TodayErrorInfo {
  kind: TodayErrorKind;
  message: string;
}
/** Plain-language error for the Today view. 404 means the endpoint (or this farm's view) is not available yet. */
export function describeTodayError(error: unknown): TodayErrorInfo {
  if (error instanceof TodayDataError)
    return { kind: "invalid", message: "Today's field view could not be read. Your saved records are unchanged." };
  if (error instanceof ApiError) {
    if (error.status === 404)
      return { kind: "not_available", message: "Today's field view is not available on this server yet." };
    if (error.status === 0)
      return { kind: "network", message: "Could not reach the server. Check your connection and try again." };
    if (error.code === "invalid_envelope" || error.code === "invalid_response" || error.code === "empty_response")
      return { kind: "invalid", message: "Today's field view could not be read. Your saved records are unchanged." };
    return { kind: "server", message: error.message || "Today's field view could not load." };
  }
  return { kind: "server", message: "Today's field view could not load." };
}
