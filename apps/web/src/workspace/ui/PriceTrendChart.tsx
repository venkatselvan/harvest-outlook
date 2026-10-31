import { Show } from "solid-js";
import type { PriceTrend } from "@harvest/contracts";
import { Sparkline } from "./Sparkline";
import "./ui.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10" -> "Oct 2026". */
export const trendMonthLabel = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
/** Per-kg mandi price for display: whole rupees from 100, one decimal below. */
export const rupeesPerKg = (value: number) =>
  `₹${value >= 100 ? Math.round(value).toLocaleString("en-IN") : value.toFixed(1)}`;

/** Where the numbers come from, in words: the scope the server actually used. */
export function trendScopeText(trend: Pick<PriceTrend, "scope">): string {
  const s = trend.scope;
  const markets = `${s.marketCount} market${s.marketCount === 1 ? "" : "s"}`;
  if (s.level === "district" && s.districtName) return `${s.districtName} district mandis, ${markets}`;
  if (s.level === "state" && s.stateName) return `${s.stateName} mandis, ${markets}`;
  if (s.level === "market") return `Selected mandis, ${markets}`;
  return `All-India mandis, ${markets}`;
}

export interface TrendSummary {
  values: (number | null)[];
  first: string | null;
  last: string | null;
  low: number | null;
  high: number | null;
  latest: { month: string; value: number } | null;
  monthsWithData: number;
}

/** Pure summary of a 36-month trend used by the chart label and caption. */
export function summarizeTrend(trend: Pick<PriceTrend, "series">): TrendSummary {
  const values = trend.series.map((p) => (p.p50 != null && Number.isFinite(p.p50) ? p.p50 : null));
  const finite = values.filter((v): v is number => v != null);
  let latestIndex = -1;
  for (let i = values.length - 1; i >= 0; i--)
    if (values[i] != null) {
      latestIndex = i;
      break;
    }
  return {
    values,
    first: trend.series[0]?.month ?? null,
    last: trend.series.at(-1)?.month ?? null,
    low: finite.length ? Math.min(...finite) : null,
    high: finite.length ? Math.max(...finite) : null,
    latest:
      latestIndex >= 0
        ? { month: trend.series[latestIndex]!.month, value: values[latestIndex]! }
        : null,
    monthsWithData: finite.length,
  };
}

/**
 * Monthly mandi price trend (median of market-day modal prices per month), shared by the Year plan detail sheet and
 * the Market tab. Renders "No price series yet" instead of a line whenever the server reports insufficient history.
 * `highlightMonth` (1..12) marks that calendar month in past years, for example the planned harvest month.
 */
export function PriceTrendChart(props: { trend: PriceTrend; productLabel: string; highlightMonth?: number }) {
  const summary = () => summarizeTrend(props.trend);
  const marks = () =>
    props.highlightMonth
      ? props.trend.series.flatMap((p, i) => (Number(p.month.slice(5, 7)) === props.highlightMonth ? [i] : []))
      : [];
  const label = () => {
    const s = summary();
    if (!s.latest || s.low == null || s.high == null) return `${props.productLabel}: no price series yet`;
    return `${props.productLabel} mandi price by month, ${trendMonthLabel(s.first!)} to ${trendMonthLabel(s.last!)}: between ${rupeesPerKg(s.low)} and ${rupeesPerKg(s.high)} per kg, latest ${rupeesPerKg(s.latest.value)} in ${trendMonthLabel(s.latest.month)}.`;
  };
  const yoy = () => {
    const y = props.trend.yoy;
    if (!y) return null;
    const pct = Math.round(y.changePct);
    return pct === 0
      ? "Last 12 months about the same as the year before"
      : `Last 12 months ${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} the year before`;
  };
  return (
    <Show
      when={props.trend.status === "available" && summary().monthsWithData >= 2}
      fallback={<p class="ui-trend-empty">No price series yet</p>}
    >
      <figure class="ui-trend">
        <Sparkline values={summary().values} marks={marks()} label={label()} />
        <figcaption>
          <span class="ui-trend-range">
            {trendMonthLabel(summary().first!)} to {trendMonthLabel(summary().last!)} · low{" "}
            {rupeesPerKg(summary().low!)}, high {rupeesPerKg(summary().high!)}, latest{" "}
            {rupeesPerKg(summary().latest!.value)} per kg
          </span>
          <Show when={yoy()}>{(text) => <span>{text()}</span>}</Show>
          <span class="ui-trend-basis">
            {trendScopeText(props.trend)} · {props.trend.basisLabel}
          </span>
        </figcaption>
      </figure>
    </Show>
  );
}
