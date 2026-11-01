import { For, Show, createMemo } from "solid-js";
import type { MarketTimeline } from "@harvest/contracts";
import { CHART_H, CHART_W, chartGeometry, chartLabel, formatInr, yearTicks, type ChartOverlay } from "./model";

/** Dash patterns for analogue-year overlays, in the order the years are listed. */
export const OVERLAY_DASHES = ["6 4", "2 4", "10 4 2 4", "1 3", "8 3", "4 6"];

/**
 * Weekly price chart (ROUND2_SPEC 3.2): observed weekly median with its min/max shading, the seasonal reference ahead
 * with the likely band and the possible band at lower opacity, a Today marker, the harvest window and analogue-year paths
 * as thin dashed lines. Plain SVG stretched to the width (strokes keep their width); labels are HTML so they never
 * distort. The selected week is marked by a cursor line driven by the slider.
 */
export function MarketChart(props: { timeline: MarketTimeline; index: number; overlays: ChartOverlay[] }) {
  const geo = createMemo(() => chartGeometry(props.timeline, props.overlays));
  const fraction = (x: number) => `${(x / CHART_W) * 100}%`;
  const cursorX = () => geo().x(props.index);
  const cursorY = () => {
    const p = props.timeline.points[props.index]?.price;
    return p && p.kind !== "none" ? geo().y(p.p50) : null;
  };
  const ticks = createMemo(() => yearTicks(props.timeline.points));
  return (
    <figure class="market-chart" data-testid="market-chart">
      <div class="market-chart-frame">
        <div class="market-chart-y" aria-hidden="true">
          <Show when={geo().hasPrice}>
            <span>{formatInr(geo().max)}</span>
            <span>{formatInr(geo().min)}</span>
          </Show>
        </div>
        <div class="market-chart-plot">
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={chartLabel(props.timeline)}>
            <Show when={geo().harvest}>
              {(h) => <rect class="market-harvest" x={h().x} y={0} width={h().width} height={CHART_H} />}
            </Show>
            <path class="market-band-possible" d={geo().possibleBand} />
            <path class="market-band-likely" d={geo().likelyBand} />
            <path class="market-band-observed" d={geo().observedBand} />
            <For each={geo().overlays}>
              {(o, i) => <path class="market-overlay" d={o.path} stroke-dasharray={OVERLAY_DASHES[i() % OVERLAY_DASHES.length]} vector-effect="non-scaling-stroke" data-crop-year={o.cropYear} />}
            </For>
            <path class="market-line-reference" d={geo().referenceLine} vector-effect="non-scaling-stroke" />
            <path class="market-line-observed" d={geo().observedLine} vector-effect="non-scaling-stroke" />
            <For each={geo().observedDots}>{(d) => <rect class="market-dot" x={d.x - 3} y={d.y - 1.5} width={6} height={3} />}</For>
            <line class="market-today" x1={geo().todayX} x2={geo().todayX} y1={0} y2={CHART_H} vector-effect="non-scaling-stroke" />
            <line class="market-cursor" x1={cursorX()} x2={cursorX()} y1={0} y2={CHART_H} vector-effect="non-scaling-stroke" data-index={props.index} />
            <Show when={cursorY() !== null}>
              <line class="market-cursor-mark" x1={cursorX() - 9} x2={cursorX() + 9} y1={cursorY()!} y2={cursorY()!} vector-effect="non-scaling-stroke" />
            </Show>
          </svg>
          <span class="market-today-label" style={{ left: fraction(geo().todayX) }} aria-hidden="true">
            Today
          </span>
          <Show when={!geo().hasPrice}>
            <p class="market-chart-empty">No price series yet</p>
          </Show>
        </div>
      </div>
      <div class="market-chart-x" aria-hidden="true">
        <For each={ticks()}>{(t) => <span style={{ left: `${t.fraction * 100}%` }}>{t.label}</span>}</For>
      </div>
      <figcaption class="market-legend">
        <span class="market-key market-key-observed">Observed weekly median, min to max</span>
        <span class="market-key market-key-reference">Seasonal reference, likely and possible range</span>
        <Show when={props.timeline.harvestWindow}>
          <span class="market-key market-key-harvest">Harvest window</span>
        </Show>
        <For each={props.overlays}>
          {(o) => <span class="market-key market-key-overlay">{o.cropYear} path</span>}
        </For>
      </figcaption>
    </figure>
  );
}
