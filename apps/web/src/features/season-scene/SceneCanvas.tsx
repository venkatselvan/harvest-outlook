import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { StageBlend } from "./blend";
import { drawScene, planScene, sceneSummary, sceneText, type SceneKeyframe, type SceneMode } from "./compositor";
import { loadImage } from "./images";
import { computeSceneLayout, type Pt } from "./layout";
import type { Ctx2D } from "./schematic";
import "./season-scene.css";

export interface SceneCanvasProps {
  /** Private URL of the normalized farm photo the region was drawn on; null shows a plain backdrop. */
  baseImageUrl: string | null;
  /** Confirmed planting region, normalized 0..1 in the base photo. */
  polygon: Pt[];
  /** One entry per plan stage in plan order (ready, failed, schematic or queued). */
  keyframes: SceneKeyframe[];
  stageProgress: StageBlend;
  /** Defaults to the OS prefers-reduced-motion setting. */
  reducedMotion?: boolean;
  mode: SceneMode;
}

const prefersReduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Canvas 2D compositor. Draws the farm photo, then clips generated keyframes (or the labelled schematic) to the
 * confirmed region and cross-fades by `stageProgress.t`. Assets are preloaded `Image` objects; changing the slider
 * only redraws and never touches the network. The illustration label is a DOM element, not canvas pixels.
 */
export function SceneCanvas(props: SceneCanvasProps) {
  let wrap!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [dpr, setDpr] = createSignal(typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const [base, setBase] = createSignal<HTMLImageElement | null>(null);
  const [images, setImages] = createSignal<ReadonlyMap<string, CanvasImageSource>>(new Map());
  const [motion, setMotion] = createSignal(prefersReduced());

  const reduced = () => props.reducedMotion ?? motion();
  const imageSize = () => {
    const b = base();
    return b ? { w: b.naturalWidth, h: b.naturalHeight } : { w: 4, h: 3 };
  };
  const layout = createMemo(() => computeSceneLayout(size(), imageSize(), dpr()));
  const plan = createMemo(() => planScene(props.stageProgress, props.keyframes, images(), reduced()));
  const text = createMemo(() => sceneText(plan(), props.keyframes, props.mode, base() !== null));

  onMount(() => {
    const measure = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const onMq = () => setMotion(!!mq?.matches);
    mq?.addEventListener("change", onMq);
    // DPR changes when the window moves between screens or the page is zoomed.
    const onResize = () => setDpr(devicePixelRatio || 1);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      ro.disconnect();
      mq?.removeEventListener("change", onMq);
      window.removeEventListener("resize", onResize);
    });
  });

  // Preload the base photo only when its URL changes.
  createEffect(() => {
    const url = props.baseImageUrl;
    const ac = new AbortController();
    onCleanup(() => ac.abort());
    if (!url) return setBase(null);
    void loadImage(url, ac.signal).then((img) => !ac.signal.aborted && setBase(img));
  });

  // Preload keyframes only when the set of ready URLs changes (never on slider movement).
  const readyUrls = createMemo(() => props.keyframes.filter((k) => k.state === "ready" && k.url).map((k) => k.url as string).sort().join("\n"));
  createEffect(() => {
    const urls = readyUrls() ? readyUrls().split("\n") : [];
    const ac = new AbortController();
    onCleanup(() => ac.abort());
    void Promise.all(urls.map(async (u) => [u, await loadImage(u, ac.signal)] as const)).then((pairs) => {
      if (ac.signal.aborted) return;
      setImages(new Map(pairs.filter((p): p is readonly [string, HTMLImageElement] => p[1] !== null)));
    });
  });

  let raf = 0;
  createEffect(() => {
    const l = layout();
    const p = plan();
    const b = base();
    const poly = props.polygon;
    const count = props.keyframes.length;
    if (!canvas) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (canvas.width !== l.canvasW) canvas.width = l.canvasW;
      if (canvas.height !== l.canvasH) canvas.height = l.canvasH;
      const ctx = canvas.getContext("2d");
      if (ctx) drawScene(ctx as unknown as Ctx2D, { layout: l, base: b, polygon: poly, plan: p, stageCount: count });
    });
  });
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <figure class="season-scene" data-kind={text().kind}>
      <div class="season-scene__stage" ref={wrap} style={{ "aspect-ratio": `${imageSize().w} / ${imageSize().h}` }}>
        <canvas ref={canvas} class="season-scene__canvas" role="img" aria-label={sceneSummary(text(), plan(), props.keyframes.length)} style={{ width: "100%", height: "100%" }} />
      </div>
      <figcaption class="season-scene__caption">
        <p class="season-scene__label" role="note" data-testid="scene-label">
          {text().label}
        </p>
        <For each={text().notes}>{(n) => <p class="season-scene__note">{n}</p>}</For>
        <Show when={props.keyframes.some((k) => k.state === "failed")}>
          <p class="season-scene__note">A stage illustration could not be generated; a schematic is shown for it. Your plan is unaffected.</p>
        </Show>
      </figcaption>
    </figure>
  );
}
