import { describe, expect, it } from "vitest";
import {
  blendAlpha,
  drawScene,
  planScene,
  sceneSummary,
  sceneText,
  visibleFrames,
  type SceneKeyframe,
} from "./compositor";
import { computeSceneLayout, polygonToCanvas, type Pt } from "./layout";
import { schematicParams, type Ctx2D } from "./schematic";
import type { StageBlend } from "./blend";

type Op = { op: string; args: unknown[]; alpha: number; clipped: boolean };

/** Recording 2D context double. Tracks the active clip so tests can assert what is drawn inside it. */
class Rec implements Ctx2D {
  ops: Op[] = [];
  globalAlpha = 1;
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  clipPoints: Pt[] | null = null;
  private path: Pt[] = [];
  private stack: (Pt[] | null)[] = [];
  private rec(op: string, ...args: unknown[]) {
    this.ops.push({
      op,
      args,
      alpha: this.globalAlpha,
      clipped: this.clipPoints !== null,
    });
  }
  save() {
    this.stack.push(this.clipPoints);
    this.rec("save");
  }
  restore() {
    this.clipPoints = this.stack.pop() ?? null;
    this.rec("restore");
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x: number, y: number) {
    this.path.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.path.push([x, y]);
  }
  closePath() {}
  clip() {
    this.clipPoints = [...this.path];
    this.rec("clip", [...this.path]);
  }
  fill() {
    this.rec("fill");
  }
  stroke() {
    this.rec("stroke");
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rec("fillRect", x, y, w, h);
  }
  drawImage(
    img: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    this.rec("drawImage", img, x, y, w, h);
  }
  ellipse() {
    this.rec("ellipse");
  }
  clearRect() {
    this.rec("clearRect");
  }
  of(op: string) {
    return this.ops.filter((o) => o.op === op);
  }
}

const POLY: Pt[] = [
  [0.2, 0.3],
  [0.8, 0.3],
  [0.8, 0.9],
  [0.2, 0.9],
];
const imgA = { id: "A" } as unknown as CanvasImageSource;
const imgB = { id: "B" } as unknown as CanvasImageSource;
const base = { id: "base" } as unknown as CanvasImageSource;
const kf = (
  stageId: string,
  over: Partial<SceneKeyframe> = {},
): SceneKeyframe => ({
  stageId,
  url: `/api/v1/visuals/${stageId}/content`,
  state: "ready",
  label: "x",
  ...over,
});
const KFS = [kf("a"), kf("b"), kf("c")];
const IMGS = new Map<string, CanvasImageSource>([
  ["/api/v1/visuals/a/content", imgA],
  ["/api/v1/visuals/b/content", imgB],
]);
const layout = computeSceneLayout({ w: 400, h: 200 }, { w: 100, h: 100 }, 2);
const progress = (
  from: string | null,
  to: string | null,
  t: number,
): StageBlend => ({ fromStageId: from, toStageId: to, t });
const draw = (p: StageBlend, kfs = KFS, reduced = false, imgs = IMGS) => {
  const ctx = new Rec();
  const plan = planScene(p, kfs, imgs, reduced);
  drawScene(ctx, { layout, base, polygon: POLY, plan, stageCount: kfs.length });
  return { ctx, plan };
};

describe("layout and polygon mapping", () => {
  it("letterboxes a square photo in a wide container and applies DPR to the backing store", () => {
    expect(layout).toMatchObject({ canvasW: 800, canvasH: 400, dpr: 2 });
    expect(layout.box).toEqual({ x: 200, y: 0, w: 400, h: 400 });
  });
  it("pillarboxes a portrait photo and maps normalized points through the content box", () => {
    const l = computeSceneLayout({ w: 400, h: 200 }, { w: 100, h: 200 }, 1);
    expect(l.box).toEqual({ x: 150, y: 0, w: 100, h: 200 });
    expect(
      polygonToCanvas(
        [
          [0, 0],
          [1, 1],
          [0.5, 0.5],
        ],
        l.box,
      ),
    ).toEqual([
      [150, 0],
      [250, 200],
      [200, 100],
    ]);
  });
  it("caps DPR, defaults invalid DPR to 1 and survives a zero-size container", () => {
    expect(
      computeSceneLayout({ w: 100, h: 100 }, { w: 10, h: 10 }, 5).dpr,
    ).toBe(3);
    expect(
      computeSceneLayout({ w: 100, h: 100 }, { w: 10, h: 10 }, Number.NaN).dpr,
    ).toBe(1);
    expect(computeSceneLayout({ w: 0, h: 0 }, { w: 10, h: 10 }, 2).box.w).toBe(
      0,
    );
  });
});

describe("drawScene clipping and crossfade", () => {
  it("draws the base photo first, then keyframes only inside a clip equal to the mapped polygon", () => {
    const { ctx } = draw(progress("a", "a", 0));
    const images = ctx.of("drawImage");
    expect(images[0]!.args[0]).toBe(base);
    expect(images[0]!.clipped).toBe(false);
    const clip = ctx.of("clip");
    expect(clip).toHaveLength(1);
    expect(clip[0]!.args[0]).toEqual(polygonToCanvas(POLY, layout.box));
    const frames = images.slice(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args[0]).toBe(imgA);
    expect(frames[0]!.clipped).toBe(true);
    // Nothing is drawn onto the photo outside the region after the clip is released (only the outline stroke).
    const afterRestore = ctx.ops.slice(
      ctx.ops.findIndex((o) => o.op === "restore") + 1,
    );
    expect(
      afterRestore.some((o) => o.op === "drawImage" || o.op === "fillRect"),
    ).toBe(false);
  });

  it("cross-fades A to B by t: A opaque underneath, B at alpha t", () => {
    const { ctx } = draw(progress("a", "b", 0.3));
    const frames = ctx.of("drawImage").slice(1);
    expect(frames.map((f) => [f.args[0], f.alpha])).toEqual([
      [imgA, 1],
      [imgB, 0.3],
    ]);
    expect(frames.every((f) => f.clipped)).toBe(true);
  });

  it("reduced motion switches instantly with no intermediate alpha", () => {
    expect(blendAlpha(0.3, true)).toBe(0);
    expect(blendAlpha(0.5, true)).toBe(1);
    expect(blendAlpha(0.3, false)).toBe(0.3);
    const lo = draw(progress("a", "b", 0.3), KFS, true)
      .ctx.of("drawImage")
      .slice(1);
    expect(lo.map((f) => f.args[0])).toEqual([imgA]);
    const hi = draw(progress("a", "b", 0.7), KFS, true)
      .ctx.of("drawImage")
      .slice(1);
    expect(hi.every((f) => f.alpha === 1)).toBe(true);
    expect(hi.map((f) => f.args[0])).toContain(imgB);
    expect(
      new Set(
        draw(progress("a", "b", 0.4), KFS, true).ctx.ops.map((o) => o.alpha),
      ),
    ).toEqual(new Set([1]));
  });

  it("before the first stage only the base photo (and no clip) is drawn", () => {
    const { ctx } = draw(progress(null, "a", 0));
    expect(ctx.of("clip")).toHaveLength(1);
    const none = draw(progress(null, null, 0)).ctx;
    expect(none.of("clip")).toHaveLength(0);
    expect(none.of("drawImage")).toHaveLength(1);
  });

  it("falls back to the schematic inside the clip for a failed stage, never drawing an image for it", () => {
    const { ctx, plan } = draw(progress("c", "c", 0), [
      kf("a"),
      kf("b"),
      kf("c", { state: "failed", url: null }),
    ]);
    expect(ctx.of("drawImage")).toHaveLength(1); // base only
    expect(ctx.of("fillRect").length).toBeGreaterThan(1);
    expect(ctx.of("ellipse").length).toBeGreaterThanOrEqual(2);
    expect(sceneText(plan, KFS, "live", true).kind).toBe("schematic");
  });

  it("with no keyframes at all the schematic fills the region and the label says schematic", () => {
    const { ctx, plan } = draw(progress("a", "a", 0), [], false, new Map());
    expect(ctx.of("clip")).toHaveLength(1);
    expect(ctx.of("fillRect").some((o) => o.clipped)).toBe(true);
    expect(sceneText(plan, [], "live", true).label).toContain("Schematic");
  });

  it("clears a plain backdrop instead of a photo when no base image exists", () => {
    const ctx = new Rec();
    drawScene(ctx, {
      layout,
      base: null,
      polygon: POLY,
      plan: planScene(progress("a", "a", 0), KFS, IMGS, false),
      stageCount: 3,
    });
    expect(ctx.ops.find((o) => o.op === "drawImage")?.args[0]).toBe(imgA); // the keyframe, still clipped
    expect(ctx.of("drawImage")[0]!.clipped).toBe(true);
  });
});

describe("persistent honesty label", () => {
  const modes = ["live", "replay", "synthetic"] as const;
  it("is never empty and never says observed, in any mode, stage state or motion setting", () => {
    for (const mode of modes)
      for (const reduced of [false, true])
        for (const kfs of [
          [],
          KFS,
          [kf("a", { state: "failed", url: null })],
          [kf("a", { state: "queued", url: null })],
        ])
          for (const p of [
            progress(null, null, 0),
            progress(null, "a", 0),
            progress("a", "b", 0.5),
            progress("a", "a", 0),
          ]) {
            const plan = planScene(p, kfs, IMGS, reduced);
            const t = sceneText(plan, kfs, mode, true);
            expect(t.label.length).toBeGreaterThan(10);
            expect(t.label.toLowerCase()).not.toContain("observed");
            expect(t.label.toLowerCase()).toMatch(
              /illustrative growth|schematic/,
            );
            expect(sceneSummary(t, plan, kfs.length)).toContain(t.label);
          }
  });
  it("uses the illustrative wording only when every visible frame is a generated image", () => {
    const gen = sceneText(
      planScene(progress("a", "b", 0.5), KFS, IMGS, false),
      KFS,
      "live",
      true,
    );
    expect(gen).toMatchObject({
      kind: "illustrative",
      label: "Illustrative growth — generated image, not a prediction",
    });
    const mixed = sceneText(
      planScene(progress("b", "c", 0.5), KFS, IMGS, false),
      KFS,
      "live",
      true,
    ); // c has no preloaded image
    expect(mixed.kind).toBe("schematic");
    expect(
      visibleFrames(planScene(progress("b", "c", 0.5), KFS, IMGS, false)),
    ).toHaveLength(2);
  });
  it("adds the QA, synthetic and no-photo notes", () => {
    const flagged = [
      kf("a", { qaWarning: "Scene changed outside the planting region" }),
      kf("b"),
    ];
    const t = sceneText(
      planScene(progress("a", "a", 0), flagged, IMGS, false),
      flagged,
      "synthetic",
      false,
    );
    expect(t.notes).toEqual(
      expect.arrayContaining([
        "Scene changed outside the planting region",
        expect.stringContaining("Synthetic"),
        expect.stringContaining("No farm photo"),
      ]),
    );
    const clean = sceneText(
      planScene(progress("b", "b", 0), flagged, IMGS, false),
      flagged,
      "live",
      true,
    );
    expect(clean.notes).toEqual([]); // stage b is not flagged
  });
});

describe("schematic scaling", () => {
  it("scales stems and height with stage index only and stays within fixed bounds", () => {
    const first = schematicParams(0, 5);
    const last = schematicParams(4, 5);
    expect(first).toEqual({ stems: 2, heightFraction: 0.25 });
    expect(last.stems).toBe(8);
    expect(last.heightFraction).toBeCloseTo(0.85);
    expect(schematicParams(99, 5)).toEqual(last);
    expect(schematicParams(-3, 5)).toEqual(first);
    expect(schematicParams(0, 1)).toEqual(first);
  });
});
