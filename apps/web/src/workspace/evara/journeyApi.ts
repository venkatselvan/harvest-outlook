import { CropJourney as cropJourneySchema, type CropJourney, type CropJourneyRequest } from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Crop journey client (docs/research/EVARA_ACTIONS_SPEC.md 3.2): POST /api/v1/farms/:id/crop-journey queues the stage images
 * (or returns today's existing journey), GET /api/v1/farms/:id/crop-journey/:journeyId reports per-stage progress. Responses are
 * validated against the shared contract and checked to belong to the requested farm.
 */
export const JOURNEY_POLL_MS = 3000;
export const JOURNEY_POLL_LIMIT_MS = 4 * 60 * 1000;

export class JourneyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyDataError";
  }
}

const farmPath = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}/crop-journey`;

function parse(farmId: string, data: unknown): CropJourney {
  const parsed = cropJourneySchema.safeParse(data);
  if (!parsed.success) throw new JourneyDataError("The crop journey did not match the expected format.");
  if (parsed.data.farmId !== farmId) throw new JourneyDataError("The crop journey belongs to another farm.");
  return parsed.data;
}

export async function requestCropJourney(farmId: string, body: CropJourneyRequest, fetchImpl?: typeof fetch): Promise<CropJourney> {
  const env = await apiRequest<unknown>(farmPath(farmId), jsonInit("POST", body), fetchImpl);
  return parse(farmId, env.data);
}

export async function loadCropJourney(farmId: string, journeyId: string, fetchImpl?: typeof fetch): Promise<CropJourney> {
  const env = await apiRequest<unknown>(`${farmPath(farmId)}/${encodeURIComponent(journeyId)}`, undefined, fetchImpl);
  return parse(farmId, env.data);
}

export const isTerminal = (journey: Pick<CropJourney, "status">) => !["queued", "running"].includes(journey.status);

export interface JourneyPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch | undefined;
  /** Injected so tests do not wait; the default is a timer. */
  wait?: (ms: number) => Promise<void>;
  /** Checked after every wait and every response: a true stops polling and reports `cancelled`. */
  cancelled?: () => boolean;
  /** Called with every journey read, in order, so ready stages show as they finish. */
  onUpdate?: (journey: CropJourney) => void;
}
export type JourneyOutcome =
  | { status: "done"; journey: CropJourney }
  | { status: "timeout"; journey: CropJourney }
  | { status: "cancelled"; journey: CropJourney };

/**
 * Poll the journey every 3 seconds for up to 4 minutes (as the future look's `pollPrediction`). A transient failure (network,
 * 429, 5xx) skips that round; a 4xx other than 429 ends the poll with the error. Terminal statuses are ready, partial, failed
 * and unavailable.
 */
export async function pollCropJourney(farmId: string, initial: CropJourney, options: JourneyPollOptions = {}): Promise<JourneyOutcome> {
  const interval = options.intervalMs ?? JOURNEY_POLL_MS;
  const attempts = Math.max(1, Math.floor((options.timeoutMs ?? JOURNEY_POLL_LIMIT_MS) / interval));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = initial;
  if (isTerminal(last)) return { status: "done", journey: last };
  for (let i = 0; i < attempts; i++) {
    await wait(interval);
    if (options.cancelled?.()) return { status: "cancelled", journey: last };
    try {
      last = await loadCropJourney(farmId, initial.journeyId, options.fetchImpl);
    } catch (error) {
      const transient = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!transient) throw error;
      continue;
    }
    if (options.cancelled?.()) return { status: "cancelled", journey: last };
    options.onUpdate?.(last);
    if (isTerminal(last)) return { status: "done", journey: last };
  }
  return { status: "timeout", journey: last };
}

/** Indexes of the stages the server illustrates: the first, the last and up to three evenly spaced between (5 at most). Mirrors the server rule so schematics line up before images exist. */
export function illustratedIndexes(total: number, max = 5): Set<number> {
  if (total <= max) return new Set(Array.from({ length: total }, (_, i) => i));
  const picked = new Set<number>([0, total - 1]);
  const between = max - 2;
  for (let k = 1; k <= between; k++) picked.add(Math.round((k * (total - 1)) / (between + 1)));
  return picked;
}

/** Growth progress (0 to 1) of the schematic for stage `index` of `total`. */
export const stageProgress = (index: number, total: number): number => (total <= 1 ? 0.5 : Math.max(0, Math.min(1, index / (total - 1))));

/** Error text for a failed request or poll, for the strip. */
export function journeyErrorText(error: unknown): string {
  if (error instanceof JourneyDataError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 429) return "Too many requests. Wait a minute and try again.";
    if (error.status === 404) return "This crop journey is no longer available. Ask for a new one.";
    if (error.status === 0 || error.code === "network_error") return "Could not reach the server. Check your connection and try again.";
    if (error.status === 400 || error.status === 422) return error.message || "This crop journey cannot be made as asked.";
  }
  return "The crop journey could not be made. Try again in a moment.";
}
