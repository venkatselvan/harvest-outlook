import { bounds, type Pt } from "./layout";

/**
 * Labelled schematic fallback: ground plus simple stems whose COUNT and HEIGHT scale with the stage index only.
 * It is a drawing aid, not a growth model: no height, leaf count or timing is implied. The matching server
 * constant is apps/api/src/visuals/schematic.ts (stemsForStage); a test pins them together.
 */
export interface SchematicParams {
  stems: number;
  /** Fraction of the region height the tallest stem reaches. */
  heightFraction: number;
}

/** `stageIndex` may be fractional while two schematic stages cross-fade. */
export function schematicParams(stageIndex: number, stageCount: number): SchematicParams {
  const n = Math.max(1, stageCount);
  const i = Math.max(0, Math.min(stageIndex, n - 1));
  const f = n > 1 ? i / (n - 1) : 0;
  return { stems: 2 + Math.round(f * 6), heightFraction: 0.25 + 0.6 * f };
}

/** Minimal 2D context surface the schematic needs; lets tests pass a recording double. */
export interface Ctx2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
}

export function drawSchematic(ctx: Ctx2D, polyPx: readonly Pt[], stageIndex: number, stageCount: number, dpr: number): void {
  const b = bounds(polyPx);
  if (b.w <= 0 || b.h <= 0) return;
  const { stems, heightFraction } = schematicParams(stageIndex, stageCount);
  const groundH = b.h * 0.22;
  ctx.fillStyle = "#cdbf9d";
  ctx.fillRect(b.x, b.y, b.w, b.h); // pale backdrop inside the clip
  ctx.fillStyle = "#8a6a43";
  ctx.fillRect(b.x, b.y + b.h - groundH, b.w, groundH);
  ctx.strokeStyle = "#2f7a46";
  ctx.fillStyle = "#3d9a5a";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, 2 * dpr);
  const maxH = (b.h - groundH) * heightFraction;
  for (let s = 0; s < stems; s++) {
    const x = b.x + ((s + 0.5) / stems) * b.w;
    const base = b.y + b.h - groundH;
    // Fixed, deterministic variation so stems do not look cloned; independent of any biology.
    const h = maxH * (0.7 + 0.3 * (((s * 5) % 7) / 6));
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - h);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x + (s % 2 ? 1 : -1) * 4 * dpr, base - h, 5 * dpr, 2.5 * dpr, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}
