import { z } from "zod";
import { ApiError } from "./errors";

export type PriceEntry =
  | { kind: "audio"; perSecondUsd: number }
  | { kind: "tokens"; inputPerMTokUsd: number; outputPerMTokUsd: number }
  | { kind: "image"; perImageUsd: number }
  /** Built-in web search (search grounding), billed per query on top of the model's tokens. */
  | { kind: "search"; perQueryUsd: number }
  /** Speech is tracked in characters or seconds; no USD price is asserted. */
  | { kind: "speech"; unit: "characters" | "seconds" };

export type PriceTable = Record<string, PriceEntry>;

/** Defaults from docs/API_CAPABILITIES.md; override with PRICE_TABLE_JSON. Not a billing source of truth. */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  "muse-spark-1.3": { kind: "tokens", inputPerMTokUsd: 1.25, outputPerMTokUsd: 4.25 },
  "muse-wonder-1.0": { kind: "tokens", inputPerMTokUsd: 4, outputPerMTokUsd: 20 },
  "muse-image-1.0": { kind: "image", perImageUsd: 0.01 },
  // Meta search grounding: $2.50 per 1,000 search queries plus tokens (dev.meta.ai/docs/pricing-rate-limits, read
  // 2026-10-31). How several queries inside one web_search_call are metered is not stated; callers count per query.
  "meta:web_search": { kind: "search", perQueryUsd: 2.5 / 1000 },
  "sam-3.1": { kind: "image", perImageUsd: 0.0025 },
  // Official Meta Voice Transcribe: $0.18/hour, Standard processing.
  "muse-voice-transcribe-1.0": { kind: "audio", perSecondUsd: 0.18 / 3600 },
};

const nonNeg = z.number().finite().nonnegative();
const entrySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("audio"),perSecondUsd:nonNeg}),
  z.object({ kind: z.literal("tokens"), inputPerMTokUsd: nonNeg, outputPerMTokUsd: nonNeg }),
  z.object({ kind: z.literal("image"), perImageUsd: nonNeg }),
  z.object({ kind: z.literal("search"), perQueryUsd: nonNeg }),
  z.object({ kind: z.literal("speech"), unit: z.enum(["characters", "seconds"]) }),
]);

export function loadPriceTable(overrideJson?: string): PriceTable {
  if (!overrideJson) return { ...DEFAULT_PRICE_TABLE };
  let raw: unknown;
  try {
    raw = JSON.parse(overrideJson);
  } catch {
    throw new Error("PRICE_TABLE_JSON is not valid JSON");
  }
  const parsed = z.record(z.string(), entrySchema).safeParse(raw);
  if (!parsed.success) throw new Error("PRICE_TABLE_JSON does not match the price table schema");
  return { ...DEFAULT_PRICE_TABLE, ...parsed.data };
}

export interface UsageEstimateInput {
  inputTokens?: number;
  /** Use the capped maximum output tokens for a worst-case reservation. */
  outputTokens?: number;
  images?: number;
  /** Web search queries (search grounding). */
  searches?: number;
  characters?: number;
  seconds?: number;
}

export interface CostEstimate {
  /** null when the provider is metered in non-monetary units (speech). */
  usd: number | null;
  units: UsageEstimateInput;
}

/** Whole micro-dollars so that concurrent sums never drift through floating point. */
export const toMicro = (usd: number | string): number => Math.round(Number(usd) * 1_000_000);
export const fromMicro = (m: number): string => (m / 1_000_000).toFixed(6);

/** Round up to a micro-dollar, ignoring binary floating-point noise. */
const ceilMicro = (usd: number): number => Math.ceil(Number((usd * 1_000_000).toFixed(6))) / 1_000_000;

export function estimateCost(table: PriceTable, provider: string, model: string, usage: UsageEstimateInput): CostEstimate {
  const entry = table[model] ?? table[`${provider}:${model}`] ?? table[`${provider}:*`];
  if (!entry) throw new ApiError(500, "unpriced_model", "No price configured for this model; refusing to dispatch");
  for (const v of Object.values(usage)) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new ApiError(500, "invalid_usage_estimate", "Usage estimate must be non-negative");
  }
  switch (entry.kind) {
    case "tokens": {
      const usd = ((usage.inputTokens ?? 0) * entry.inputPerMTokUsd + (usage.outputTokens ?? 0) * entry.outputPerMTokUsd) / 1_000_000;
      return { usd: ceilMicro(usd), units: usage };
    }
    case "image":
      return { usd: ceilMicro((usage.images ?? 1) * entry.perImageUsd), units: usage };
    case "audio":
      return {usd:ceilMicro((usage.seconds??0)*entry.perSecondUsd),units:usage};
    case "search":
      return { usd: ceilMicro((usage.searches ?? 0) * entry.perQueryUsd), units: usage };
    case "speech":
      return { usd: null, units: usage };
  }
}
