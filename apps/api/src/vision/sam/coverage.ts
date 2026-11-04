import { parseSamOutput, SamParseError, type RawMask, type SamBox } from "./parser";
import type { SentImagePlan } from "./transform";

/**
 * Image-region coverage from one SAM 3.1 concept response (docs/research/PHOTO_COVERAGE_SPEC.md).
 *
 * Every object in frame 0 is painted onto an occupancy grid the size of the image sent to SAM, so overlapping regions
 * are counted once; the fraction is painted pixels / image pixels. With no mask decoder (DECISIONS.md D44: the live
 * mask payload is an arithmetic-coded envelope the adapter does not decode) each object paints its box, i.e. the
 * fraction is the UNION OF BOXES, which includes the background inside every outline and therefore overstates the
 * share of pixels that belong to the concept. A decoder can be injected (`decodeMask`); a mask is used only when its
 * raster is exactly box-local (H x W = box height x width, as observed live 2026-10-30), otherwise that object falls
 * back to its box and the class is reported as 'box'.
 *
 * Deliberately NOT routed through interpretSamText's quality gate: that gate drops regions under 2 % and over 98 % of
 * the image (suitable for a single outline proposal) and would systematically undercount many small weed patches.
 * Zero objects is a valid measurement of 0.
 */
export interface ClassCoverage {
  /** 0..1 share of the sent image (same aspect as the stored photo); never field area. */
  fraction: number;
  regions: number;
  /** Mean SAM segmentation score of the counted regions; null when none carried a score. */
  confidence: number | null;
  /** 'mask' only when every counted region was painted from a decoded mask. */
  method: "mask" | "box";
  /** Objects not counted, with reasons (dimension mismatch, no box). */
  skipped: string[];
  warnings: string[];
}

export type MaskDecoder = (mask: RawMask) => Uint8Array | null;

/** Upper bound on objects painted from one response (SAM normally returns far fewer). */
export const MAX_COVERAGE_OBJECTS = 256;

function clampBox(b: SamBox, W: number, H: number) {
  const x1 = Math.max(0, Math.min(W - 1, Math.round(Math.min(b.x1, b.x2))));
  const x2 = Math.max(0, Math.min(W - 1, Math.round(Math.max(b.x1, b.x2))));
  const y1 = Math.max(0, Math.min(H - 1, Math.round(Math.min(b.y1, b.y2))));
  const y2 = Math.max(0, Math.min(H - 1, Math.round(Math.max(b.y1, b.y2))));
  return { x1, x2, y1, y2 };
}

export function coverageFromSamText(text: string, plan: Pick<SentImagePlan, "width" | "height">, opts: { decodeMask?: MaskDecoder | undefined } = {}): ClassCoverage {
  const W = plan.width;
  const H = plan.height;
  const grid = new Uint8Array(W * H);
  const parsed = parseSamOutput(text);
  const warnings = [...parsed.warnings];
  const skipped: string[] = [];
  if (parsed.frames.some((f) => f.index !== 0 && f.objects.length)) warnings.push("unexpected_frames_ignored");
  const objects = (parsed.frames.find((f) => f.index === 0)?.objects ?? []).filter((o) => !o.id.startsWith("-"));
  if (objects.length > MAX_COVERAGE_OBJECTS) warnings.push("objects_truncated");
  let regions = 0;
  let allMask = true;
  const scores: number[] = [];
  for (const o of objects.slice(0, MAX_COVERAGE_OBJECTS)) {
    if (!o.box) {
      // Masks are box-local; without the box there is nowhere to place one.
      skipped.push("no_box");
      continue;
    }
    if (o.box.w !== W || o.box.h !== H) {
      // w/h must equal the pixel size sent, or the coordinates cannot be trusted.
      skipped.push("dimension_mismatch");
      continue;
    }
    const b = clampBox(o.box, W, H);
    let painted = false;
    if (opts.decodeMask && o.mask) {
      const bw = b.x2 - b.x1 + 1;
      const bh = b.y2 - b.y1 + 1;
      try {
        const raster = o.mask.x === 0 && o.mask.y === 0 && o.mask.width === bw && o.mask.height === bh ? opts.decodeMask(o.mask) : null;
        if (raster && raster.length === bw * bh) {
          for (let y = 0; y < bh; y++) {
            const row = (b.y1 + y) * W + b.x1;
            for (let x = 0; x < bw; x++) if (raster[y * bw + x]) grid[row + x] = 1;
          }
          painted = true;
        } else warnings.push("mask_not_box_local");
      } catch (e) {
        if (!(e instanceof SamParseError)) throw e;
        warnings.push(`mask_unusable_${e.code}`);
      }
    }
    if (!painted) {
      allMask = false;
      for (let y = b.y1; y <= b.y2; y++) grid.fill(1, y * W + b.x1, y * W + b.x2 + 1);
    }
    regions++;
    const c = o.box.confidence ?? o.mask?.confidence ?? null;
    if (c !== null) scores.push(c);
  }
  let on = 0;
  for (let i = 0; i < grid.length; i++) on += grid[i]!;
  const fraction = Math.round((on / (W * H)) * 1e4) / 1e4;
  const confidence = scores.length ? Math.round((scores.reduce((a, s) => a + s, 0) / scores.length) * 1e4) / 1e4 : null;
  return { fraction, regions, confidence, method: regions > 0 && allMask ? "mask" : "box", skipped, warnings };
}
