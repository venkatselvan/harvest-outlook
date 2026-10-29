import type { StageBlend } from "./blend";
import { QA_FLAG_LABEL, ILLUSTRATIVE_LABEL, NO_PHOTO_NOTE, SCHEMATIC_LABEL, SYNTHETIC_NOTE } from "./labels";
import { polygonToCanvas, type Box, type Pt, type SceneLayout } from "./layout";
import { drawSchematic, schematicParams, type Ctx2D } from "./schematic";

export type KeyframeState = "ready" | "failed" | "schematic" | "queued";

export interface SceneKeyframe {
  stageId: string;
  /** Private content URL of the generated PNG; null when none exists. */
  url: string | null;
  state: KeyframeState;
  label: string;
  /** Set by the server when scene QA found the picture changed outside the planting region. */
  qaWarning?: string | null;
}

export type SceneMode = "live" | "replay" | "synthetic";

/** What to draw for one stage inside the clip. */
export type Frame = { kind: "image"; img: CanvasImageSource; stageId: string } | { kind: "schematic"; index: number; stageId: string };

export interface ScenePlan {
  from: Frame | null;
  to: Frame | null;
  /** Alpha of `to` over `from`, after the reduced-motion rule. */
  alphaTo: number;
}

/** Reduced motion: no cross-fade, an instant switch at the midpoint. Otherwise a linear fade. */
export function blendAlpha(t: number, reducedMotion: boolean): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return reducedMotion ? (c >= 0.5 ? 1 : 0) : c;
}

function frameFor(stageId: string | null, keyframes: readonly SceneKeyframe[], images: ReadonlyMap<string, CanvasImageSource>): Frame | null {
  if (!stageId) return null;
  const index = keyframes.findIndex((k) => k.stageId === stageId);
  const kf = keyframes[index];
  const img = kf && kf.state === "ready" && kf.url ? images.get(kf.url) : undefined;
  if (img) return { kind: "image", img, stageId };
  return { kind: "schematic", index: Math.max(0, index), stageId };
}

export function planScene(progress: StageBlend, keyframes: readonly SceneKeyframe[], images: ReadonlyMap<string, CanvasImageSource>, reducedMotion: boolean): ScenePlan {
  const from = frameFor(progress.fromStageId, keyframes, images);
  const to = frameFor(progress.toStageId, keyframes, images);
  const alphaTo = from && to && from.stageId !== to.stageId ? blendAlpha(progress.t, reducedMotion) : from ? 0 : 1;
  return { from, to, alphaTo };
}

/** Frames actually visible (alpha > 0) for the current plan. */
export function visibleFrames(plan: ScenePlan): Frame[] {
  const out: Frame[] = [];
  if (plan.from && plan.alphaTo < 1) out.push(plan.from);
  if (plan.to && plan.alphaTo > 0) out.push(plan.to);
  if (out.length === 0 && plan.from) out.push(plan.from);
  return out;
}

export interface SceneText {
  /** Always non-empty: the persistent illustration label. */
  label: string;
  kind: "illustrative" | "schematic";
  notes: string[];
}

/**
 * The persistent label text. The label is ALWAYS present: with generated frames it says illustrative; with any
 * schematic frame, or no frames at all, it says schematic. A generated or schematic image is never labelled as observed.
 */
export function sceneText(plan: ScenePlan, keyframes: readonly SceneKeyframe[], mode: SceneMode, hasBase: boolean): SceneText {
  const vis = visibleFrames(plan);
  const allImages = vis.length > 0 && vis.every((f) => f.kind === "image");
  const notes: string[] = [];
  if (mode === "synthetic") notes.push(SYNTHETIC_NOTE);
  if (!hasBase) notes.push(NO_PHOTO_NOTE);
  const shownIds = new Set(vis.map((f) => f.stageId));
  if (allImages && keyframes.some((k) => shownIds.has(k.stageId) && k.qaWarning)) notes.push(QA_FLAG_LABEL);
  return { label: allImages ? ILLUSTRATIVE_LABEL : SCHEMATIC_LABEL, kind: allImages ? "illustrative" : "schematic", notes };
}

export function pathPolygon(ctx: Ctx2D, pts: readonly Pt[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function drawFrame(ctx: Ctx2D, f: Frame, alpha: number, box: Box, polyPx: readonly Pt[], stageCount: number, dpr: number): void {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  if (f.kind === "image") ctx.drawImage(f.img, box.x, box.y, box.w, box.h);
  else drawSchematic(ctx, polyPx, f.index, stageCount, dpr);
  ctx.globalAlpha = 1;
}

export interface DrawInput {
  layout: SceneLayout;
  base: CanvasImageSource | null;
  polygon: readonly Pt[];
  plan: ScenePlan;
  stageCount: number;
}

/**
 * Draws the scene: base photo everywhere, generated/schematic content ONLY inside the confirmed region.
 * Outside the clip the base photo is untouched, whatever the generated image contains.
 */
export function drawScene(ctx: Ctx2D, { layout, base, polygon, plan, stageCount }: DrawInput): void {
  const { box } = layout;
  ctx.clearRect(0, 0, layout.canvasW, layout.canvasH);
  if (box.w <= 0 || box.h <= 0) return;
  if (base) ctx.drawImage(base, box.x, box.y, box.w, box.h);
  else {
    ctx.fillStyle = "#dfe6dc";
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  const polyPx = polygonToCanvas(polygon, box);
  if (polyPx.length < 3 || (!plan.from && !plan.to)) return;
  ctx.save();
  pathPolygon(ctx, polyPx);
  ctx.clip();
  if (plan.from && plan.to && plan.from.stageId !== plan.to.stageId) {
    drawFrame(ctx, plan.from, 1, box, polyPx, stageCount, layout.dpr);
    drawFrame(ctx, plan.to, plan.alphaTo, box, polyPx, stageCount, layout.dpr);
  } else {
    const only = plan.to ?? plan.from!;
    drawFrame(ctx, only, 1, box, polyPx, stageCount, layout.dpr);
  }
  ctx.restore();
  // Thin outline so the farmer sees which area is illustrated. Drawn after restore: outside the clip, on the base photo.
  pathPolygon(ctx, polyPx);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = Math.max(1, layout.dpr);
  ctx.stroke();
}

/** Screen-reader summary; not a substitute for the visible label. */
export function sceneSummary(text: SceneText, plan: ScenePlan, stageCount: number): string {
  const vis = visibleFrames(plan);
  const f = vis[vis.length - 1];
  const what = f ? (f.kind === "schematic" ? `schematic drawing for stage ${f.index + 1} of ${stageCount}` : "generated illustration of the planting region") : "your farm photo";
  return `${text.label}. Showing ${what} inside the outlined planting region.`;
}

export { schematicParams };
