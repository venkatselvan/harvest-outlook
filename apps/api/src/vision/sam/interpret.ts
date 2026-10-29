import { compatibleVariants, type Base85Variant } from "./base85";
import { decodeMask, parseSamOutput, SamParseError, type SamBox, type RawMask } from "./parser";
import { maskToPolygon, type RasterPolygon } from "./raster";
import { qualityGate, polygonAreaFraction, type GateReason } from "./quality";
import { boxToNormalizedPolygon, rasterToNormalized, round6, type SentImagePlan } from "./transform";
import type { SamOptions } from "./options";

export interface Proposal {
  /** 3..64 points, normalized 0..1 in the normalized derivative frame. */
  polygon: [number, number][];
  /** 'mask' = traced from the mask raster; 'box' = rectangle from the box (mask missing or unusable). */
  source: "mask" | "box";
  /** SAM confidence if present. A segmentation score only: not crop identity, not accuracy. */
  segmentationScore: number | null;
  areaFraction: number;
}

/** Minimum overlap between the traced mask's bounding box and the (plain-text) box before a mask is trusted. */
export const MIN_MASK_BOX_IOU = 0.5;

function bboxIou(poly: [number, number][], rasterW: number, rasterH: number, plan: SentImagePlan, b: SamBox): number {
  const xs = poly.map((p) => (p[0] * plan.width) / rasterW);
  const ys = poly.map((p) => (p[1] * plan.height) / rasterH);
  const a = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  const c = { x1: b.x1, y1: b.y1, x2: b.x2 + 1, y2: b.y2 + 1 };
  const iw = Math.min(a.x2, c.x2) - Math.max(a.x1, c.x1);
  const ih = Math.min(a.y2, c.y2) - Math.max(a.y1, c.y1);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (c.x2 - c.x1) * (c.y2 - c.y1) - inter);
}

/** Fraction of adjacent pixel pairs whose values differ: ~0 for a smooth blob, ~0.5 for noise from a wrong alphabet. */
export function edgeDensity(bits: Uint8Array, W: number, H: number): number {
  let d = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = bits[y * W + x];
      if (x + 1 < W) {
        d += v !== bits[y * W + x + 1] ? 1 : 0;
        n++;
      }
      if (y + 1 < H) {
        d += v !== bits[(y + 1) * W + x] ? 1 : 0;
        n++;
      }
    }
  }
  return n ? d / n : 0;
}
export const MAX_EDGE_DENSITY = 0.35;

interface Traced {
  density: number;
  r: ReturnType<typeof decodeMask>;
  poly: RasterPolygon | null;
  variant: Base85Variant;
  iou: number | null;
}

/**
 * The base85 alphabet is unverified. When the configured variant is 'auto' and the payload is valid in several
 * alphabets, a wrong choice decodes to a plausible-looking garbage mask. The box is plain text, so every candidate
 * is traced and the one whose bounding box best matches the box wins; a mask that disagrees with its box is not used.
 */
function traceMask(mask: RawMask, box: SamBox | null, plan: SentImagePlan, options: Pick<SamOptions, "base85Variant" | "base85Fallback" | "bitOrder">, warnings: string[]): Traced {
  const candidates: Base85Variant[] =
    options.base85Variant === "auto"
      ? (() => {
          const c = compatibleVariants(mask.payload);
          return [...c].sort((a, b) => Number(b === options.base85Fallback) - Number(a === options.base85Fallback));
        })()
      : [options.base85Variant];
  if (candidates.length === 0) candidates.push(options.base85Fallback);
  let best: Traced | null = null;
  let lastErr: SamParseError | null = null;
  for (const variant of candidates) {
    try {
      const r = decodeMask(mask, { ...options, base85Variant: variant });
      const poly = maskToPolygon(r.bits, r.width, r.height, 64);
      const iou = poly && box ? bboxIou(poly.polygon, r.width, r.height, plan, box) : null;
      const density = edgeDensity(r.bits, r.width, r.height);
      const ok = (iou === null || iou >= MIN_MASK_BOX_IOU) && density <= MAX_EDGE_DENSITY;
      if (ok && (!best || density < best.density)) best = { r, poly, variant, iou, density };
    } catch (e) {
      if (!(e instanceof SamParseError)) throw e;
      lastErr = e;
    }
  }
  if (!best) throw lastErr ?? new SamParseError("mask_geometry_unsupported", "mask disagrees with its box or is noise (wrong base85 alphabet?)");
  if (!box && candidates.length > 1) warnings.push("base85_variant_unverified");
  if (options.base85Variant === "auto" && candidates.length > 1) warnings.push(`base85_variant_selected_${best.variant}`);
  return best;
}

export interface Interpretation {
  proposals: Proposal[];
  rejected: { reason: GateReason | SamParseError["code"] | "dimension_mismatch" }[];
  warnings: string[];
  objectCount: number;
}

/**
 * Parsed text -> gated, normalized proposals (best first: score desc, then area). Only frame 0 is used because
 * a single image is sent. A mask that cannot be decoded falls back to the object's box when present.
 */
export function interpretSamText(text: string, plan: SentImagePlan, options: Pick<SamOptions, "base85Variant" | "base85Fallback" | "bitOrder">): Interpretation {
  const parsed = parseSamOutput(text);
  const warnings = [...parsed.warnings];
  const rejected: Interpretation["rejected"] = [];
  const proposals: Proposal[] = [];
  const frame0 = parsed.frames.find((f) => f.index === 0);
  if (parsed.frames.some((f) => f.index !== 0 && f.objects.length)) warnings.push("unexpected_frames_ignored");
  const objects = (frame0?.objects ?? []).filter((o) => !o.id.startsWith("-"));
  for (const o of objects.slice(0, 16)) {
    if (o.box && (o.box.w !== plan.width || o.box.h !== plan.height)) {
      // w/h must equal the pixel size we sent; anything else means we cannot trust the coordinates.
      rejected.push({ reason: "dimension_mismatch" });
      continue;
    }
    let done = false;
    if (o.mask) {
      try {
        const { r, poly } = traceMask(o.mask, o.box, plan, options, warnings);
        const g = qualityGate({ polygon: poly?.polygon ?? null, areaFraction: poly ? poly.areaFraction : 0 });
        if (!g.ok) {
          rejected.push({ reason: g.reason });
          done = true;
        } else {
          const norm = round6(rasterToNormalized(poly!.polygon, r, o.mask, plan));
          // Re-check after mapping (degenerate after rounding?).
          if (norm.length < 3 || polygonAreaFraction(norm) < 1e-4) rejected.push({ reason: "degenerate_polygon" });
          else proposals.push({ polygon: norm, source: "mask", segmentationScore: o.mask.confidence ?? o.box?.confidence ?? null, areaFraction: poly!.areaFraction });
          done = true;
        }
      } catch (e) {
        if (!(e instanceof SamParseError)) throw e;
        warnings.push(`mask_unusable_${e.code}`);
        if (!o.box) rejected.push({ reason: e.code });
      }
    }
    if (!done && o.box) {
      const norm = round6(boxToNormalizedPolygon(o.box, plan));
      const frac = polygonAreaFraction(norm);
      const g = qualityGate({ polygon: norm, areaFraction: frac });
      if (!g.ok) rejected.push({ reason: g.reason });
      else proposals.push({ polygon: norm, source: "box", segmentationScore: o.box.confidence, areaFraction: frac });
    }
  }
  proposals.sort((a, b) => (b.segmentationScore ?? -1) - (a.segmentationScore ?? -1) || b.areaFraction - a.areaFraction);
  return { proposals, rejected, warnings, objectCount: objects.length };
}
