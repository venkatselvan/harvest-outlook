import type { Base85Variant } from "./base85";

/**
 * Adapter flags. Parameter names marked UNVERIFIED are taken from docs/research/META_API_NOTES.md and
 * must be confirmed in a live smoke test; they are flags so a correction needs no code change.
 * Read from process.env by samOptionsFromEnv because config.ts is outside this task's ownership.
 */
export interface SamOptions {
  /** Longest side of the image sent to SAM. */
  maxImageSide: number;
  /** Request `stream: true` and concatenate response.output_text.delta (the docs' stated mode). */
  stream: boolean;
  /** UNVERIFIED placement: sent as top-level `metadata.mask_encoding`. null = do not send. */
  maskEncoding: "onebit" | "lossless" | null;
  /** UNVERIFIED placement: sent as top-level `include_confidence: "true"`. */
  includeConfidence: boolean;
  /** Base85 alphabet; 'auto' chooses by alphabet membership, else base85Fallback. UNVERIFIED variant. */
  base85Variant: Base85Variant | "auto";
  base85Fallback: Base85Variant;
  /** Bit order inside a onebit byte; numpy.packbits default is msb. UNVERIFIED. */
  bitOrder: "msb" | "lsb";
  timeoutMs: number;
}

export const DEFAULT_SAM_OPTIONS: SamOptions = {
  maxImageSide: 1024,
  stream: true,
  maskEncoding: "onebit",
  includeConfidence: true,
  base85Variant: "auto",
  base85Fallback: "rfc1924",
  bitOrder: "msb",
  timeoutMs: 45_000,
};

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : v === "true" || v === "1");

export function samOptionsFromEnv(env: Record<string, string | undefined> = process.env): SamOptions {
  const d = DEFAULT_SAM_OPTIONS;
  const enc = env.SAM_MASK_ENCODING;
  const variant = env.SAM_BASE85_VARIANT;
  return {
    maxImageSide: Math.min(1024, Math.max(128, Number(env.SAM_MAX_IMAGE_SIDE) || d.maxImageSide)),
    stream: bool(env.SAM_STREAM, d.stream),
    maskEncoding: enc === "none" ? null : enc === "lossless" || enc === "onebit" ? enc : d.maskEncoding,
    includeConfidence: bool(env.SAM_INCLUDE_CONFIDENCE, d.includeConfidence),
    base85Variant: variant === "ascii85" || variant === "z85" || variant === "rfc1924" || variant === "auto" ? variant : d.base85Variant,
    base85Fallback: d.base85Fallback,
    bitOrder: env.SAM_BIT_ORDER === "lsb" ? "lsb" : "msb",
    timeoutMs: Number(env.SAM_TIMEOUT_MS) > 0 ? Number(env.SAM_TIMEOUT_MS) : d.timeoutMs,
  };
}

export type SamPrompt =
  | { kind: "concept"; text: string }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "points"; points: { x: number; y: number; positive?: boolean | undefined }[] };
