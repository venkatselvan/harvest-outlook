import { For, Show } from "solid-js";
import { IssueCategory, type IssueTrendWeek } from "@harvest/contracts";

/**
 * Weekly issue counts by category as stacked bars, drawn as inline SVG from the data (no chart library), with the same numbers
 * as a table under "As a table" (FIELD_OPERATIONS_SPEC.md 8.3). Counts are what the farmer logged, not a forecast.
 */
export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  pest: "Pest", disease: "Disease", weed: "Weed", water_stress: "Water stress", nutrient: "Nutrient", weather_damage: "Weather damage", animal_damage: "Animal damage", other: "Other",
};
/** Fixed colours (readable on the light and the dark surface); the legend and the table carry the meaning, not colour alone. */
export const CATEGORY_COLOR: Record<IssueCategory, string> = {
  pest: "#c2410c", disease: "#7e22ce", weed: "#4d7c0f", water_stress: "#0369a1", nutrient: "#a16207", weather_damage: "#475569", animal_damage: "#be185d", other: "#6b7280",
};
const CATEGORIES = IssueCategory.options;

export interface TrendBar {
  weekStart: string;
  x: number;
  width: number;
  total: number;
  segments: { category: IssueCategory; count: number; y: number; height: number }[];
}
export interface TrendLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotBottom: number;
  max: number;
  ticks: { value: number; y: number }[];
  bars: TrendBar[];
  /** Index of the weeks that get an x label (every nth so labels never overlap). */
  labelEvery: number;
}

/** Pure geometry for the chart: integer y ticks, one stacked bar per week (categories in a fixed order, zero counts omitted). */
export function trendLayout(weeks: readonly IssueTrendWeek[]): TrendLayout {
  const plotLeft = 30, plotTop = 10, plotBottom = 150, height = 175;
  const slot = 26;
  const width = Math.max(260, plotLeft + weeks.length * slot + 6);
  const totals = weeks.map((w) => CATEGORIES.reduce((n, c) => n + w.counts[c], 0));
  const max = Math.max(1, ...totals);
  const step = Math.max(1, Math.ceil(max / 4));
  const top = Math.ceil(max / step) * step;
  const scale = (plotBottom - plotTop) / top;
  const ticks: TrendLayout["ticks"] = [];
  for (let v = 0; v <= top; v += step) ticks.push({ value: v, y: plotBottom - v * scale });
  const bars = weeks.map((w, i): TrendBar => {
    let y = plotBottom;
    const segments: TrendBar["segments"] = [];
    for (const category of CATEGORIES) {
      const count = w.counts[category];
      if (!count) continue;
      const h = count * scale;
      y -= h;
      segments.push({ category, count, y, height: h });
    }
    return { weekStart: w.weekStart, x: plotLeft + i * slot + 4, width: slot - 8, total: totals[i]!, segments };
  });
  return { width, height, plotLeft, plotTop, plotBottom, max: top, ticks, bars, labelEvery: weeks.length > 12 ? Math.ceil(weeks.length / 8) : 1 };
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function IssueTrendChart(props: { weeks: readonly IssueTrendWeek[] }) {
  const layout = () => trendLayout(props.weeks);
  const used = () => CATEGORIES.filter((c) => props.weeks.some((w) => w.counts[c] > 0));
  const total = () => props.weeks.reduce((n, w) => n + CATEGORIES.reduce((m, c) => m + w.counts[c], 0), 0);
  return (
    <Show when={props.weeks.length > 0} fallback={<p class="report-empty" data-testid="trend-empty">No issues were recorded, so there is nothing to chart.</p>}>
      <figure class="report-chart" data-testid="issue-trend">
        <svg
          viewBox={`0 0 ${layout().width} ${layout().height}`}
          role="img"
          aria-label={`Issues logged per week, ${props.weeks.length} ${props.weeks.length === 1 ? "week" : "weeks"}, ${total()} in total. The same numbers are in the table below.`}
          class="report-chart-svg"
          style={{ "min-width": `${Math.min(layout().width, 360)}px` }}
        >
          <For each={layout().ticks}>
            {(t) => (
              <g>
                <line x1={layout().plotLeft} x2={layout().width} y1={t.y} y2={t.y} class="report-chart-grid" />
                <text x={layout().plotLeft - 5} y={t.y + 4} text-anchor="end" class="report-chart-text">{t.value}</text>
              </g>
            )}
          </For>
          <For each={layout().bars}>
            {(bar, i) => (
              <g data-week={bar.weekStart}>
                <For each={bar.segments}>
                  {(s) => (
                    <rect x={bar.x} y={s.y} width={bar.width} height={s.height} fill={CATEGORY_COLOR[s.category]} class="report-chart-bar">
                      <title>{`${CATEGORY_LABEL[s.category]}: ${s.count} (week of ${shortDate(bar.weekStart)})`}</title>
                    </rect>
                  )}
                </For>
                <Show when={i() % layout().labelEvery === 0}>
                  <text x={bar.x + bar.width / 2} y={layout().plotBottom + 14} text-anchor="middle" class="report-chart-text">{shortDate(bar.weekStart)}</text>
                </Show>
              </g>
            )}
          </For>
        </svg>
        <ul class="report-legend" aria-label="Legend">
          <For each={used()}>
            {(c) => (
              <li>
                <span class="report-swatch" style={{ background: CATEGORY_COLOR[c] }} aria-hidden="true" />
                {CATEGORY_LABEL[c]}
              </li>
            )}
          </For>
        </ul>
        <figcaption class="report-note">Weeks start on Monday. Counts are issues you logged by the day you saw them.</figcaption>
        <details class="report-chart-table">
          <summary>As a table</summary>
          <div class="report-table-wrap">
            <table class="report-table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <For each={used()}>{(c) => <th scope="col">{CATEGORY_LABEL[c]}</th>}</For>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                <For each={props.weeks}>
                  {(w) => (
                    <tr>
                      <th scope="row" data-label="Week of">{shortDate(w.weekStart)}</th>
                      <For each={used()}>{(c) => <td data-label={CATEGORY_LABEL[c]}>{w.counts[c]}</td>}</For>
                      <td data-label="Total">{CATEGORIES.reduce((n, c) => n + w.counts[c], 0)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </details>
      </figure>
    </Show>
  );
}
