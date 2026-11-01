import { Show, type JSX } from "solid-js";
import type { HealthReading, NdviSeries, PricePoint, TodayView, WeatherPoint } from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import {
  formatDay,
  formatInr,
  formatRain,
  formatTemp,
  nextStage,
  priceTrend,
  rangeLabel,
  shortInrRange,
  type PriceTrend,
} from "./model";

export type CardKind = "harvest" | "price" | "weather" | "health";

export interface TodayCardsProps {
  view: TodayView;
  /** Slider date. */
  date: string;
  /** Price track point for the slider date (null when the track has none within a week). */
  price: PricePoint | null;
  /** Weather point for the slider date (null when the track has no row for that day). */
  weather: WeatherPoint | null;
  /** Show only the weather and vegetation cards (no current crop). */
  weatherOnly?: boolean;
  onDetails: (kind: CardKind) => void;
}

/** Plain-language reason for a missing price range (price-outlook reason codes, plus the unmapped-product case). */
export function priceGapText(reason: string | null | undefined): string {
  switch (reason) {
    case "price_history_not_ingested":
      return "Price history for this product has not been loaded yet.";
    case "price_history_insufficient":
    case "market_not_in_history":
      return "Not enough past prices to give a range.";
    case "price_residuals_insufficient":
    case "price_interval_crossing":
      return "Past prices vary too much to give a reliable range.";
    default:
      return "This product has no official price series yet.";
  }
}
export const verdictLabel: Record<HealthReading["verdict"], string> = {
  above_typical: "Above typical",
  near_typical: "Near typical",
  below_typical: "Below typical",
  no_reference: "No reference",
};
export const weatherKindLabel: Record<WeatherPoint["kind"], string> = {
  observed: "Observed",
  forecast: "Forecast",
  typical: "Typical",
  unavailable: "Unavailable",
};
/** Basis line for a weather point: forecasts name their issue date, typical days the years they average. */
export function weatherBasis(point: WeatherPoint | null): string {
  if (!point || point.kind === "unavailable") return "No weather data for this date";
  if (point.kind === "forecast")
    return `Forecast${point.basis.issuedAt ? ` issued ${formatDay(point.basis.issuedAt.slice(0, 10), false)}` : ""} · ${point.basis.source}`;
  if (point.kind === "typical") {
    const years = point.basis.years ?? [];
    return years.length
      ? `Typical for this date, ${Math.min(...years)} to ${Math.max(...years)}`
      : `Typical for this date · ${point.basis.source}`;
  }
  return `Recorded · ${point.basis.source}`;
}
export function trendText(trend: PriceTrend): string {
  const since = formatDay(trend.since).replace(/^\d+ /, "");
  return trend.direction === "flat"
    ? `Steady since ${since}`
    : `${trend.direction === "up" ? "Up" : "Down"} ${Math.abs(trend.pct)}% since ${since}`;
}

/** Value with a visual short form and a spoken long form, so "₹19.2–23.8" is read as "₹19.2 to ₹23.8 per kg". */
function Value(props: { short: string; spoken: string; unit?: string }) {
  return (
    <p class="today-card-value">
      <span aria-hidden="true">
        {props.short}
        <Show when={props.unit}>
          <small>{props.unit}</small>
        </Show>
      </span>
      <span class="today-sr">{props.spoken}</span>
    </p>
  );
}

function Card(props: { kind: CardKind; title: string; class?: string; children: JSX.Element; onDetails: (kind: CardKind) => void }) {
  return (
    <article class={`today-card ${props.class ?? ""}`} data-card={props.kind} aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.children}
      <button type="button" class="today-card-more" onClick={() => props.onDetails(props.kind)} aria-label={`${props.title}: details and sources`}>
        Details <Icon name="arrow" size={12} />
      </button>
    </article>
  );
}

function HarvestCard(props: { view: TodayView; onDetails: (kind: CardKind) => void }) {
  const days = () => props.view.daysToHarvest;
  const harvest = () => props.view.timeline?.harvest ?? null;
  const next = () => nextStage(props.view.timeline, props.view.today);
  return (
    <Card kind="harvest" title="Days to harvest" onDetails={props.onDetails}>
      <Show
        when={days()}
        fallback={<Value short="–" spoken="Harvest date not estimated" />}
      >
        {(d) => (
          <Show
            when={d().latest >= 0}
            fallback={<Value short="Due" spoken="Past the expected harvest window" />}
          >
            <Show
              when={d().earliest > 0}
              fallback={<Value short="Now" spoken={`Harvest window open, up to ${d().latest} more days`} />}
            >
              <Value short={d().earliest === d().latest ? `${d().earliest}` : `${d().earliest}–${d().latest}`} spoken={`${d().earliest} to ${d().latest} days`} unit=" days" />
            </Show>
          </Show>
        )}
      </Show>
      <p class="today-card-sub">
        {harvest() ? `Harvest ${rangeLabel(harvest()!.earliest, harvest()!.latest)}` : "Harvest window not estimated"}
      </p>
      <Show when={next()}>
        <p class="today-card-sub">Next: {next()!.name} on {formatDay(next()!.from, false)}</p>
      </Show>
      <p class="today-card-basis">{props.view.timeline?.basis.label ?? "No stage dates for this crop yet"}</p>
    </Card>
  );
}

/**
 * The harvest outlook in words (ROUND2_SPEC 2.2): the sentence when ready, "Writing the outlook…" while the job runs,
 * nothing when unavailable. The AI mark appears only for a model-written (or pending) sentence; the code-written
 * fallback carries no mark.
 */
export function OutlookLine(props: { note: TodayView["outlookNote"] }) {
  const note = () => (props.note && props.note.status !== "unavailable" && (props.note.status === "pending" || props.note.text) ? props.note : null);
  return (
    <Show when={note()}>
      {(n) => (
        <p class={`today-outlook-note ${n().status}`} data-testid="today-outlook-note" aria-live="polite">
          <span>{n().status === "pending" ? "Writing the outlook…" : n().text}</span>
          <Show when={n().status === "pending" || n().origin === "model"}>
            <AiSpark use="harvest_outlook_note" size={14} />
          </Show>
        </p>
      )}
    </Show>
  );
}

function PriceCard(props: { view: TodayView; date: string; price: PricePoint | null; onDetails: (kind: CardKind) => void }) {
  const harvest = () => props.view.harvestPrice;
  const trend = () => priceTrend(props.view.priceTrack, props.view.today);
  const range = () => (harvest()?.status === "available" ? harvest()?.range ?? null : null);
  const atDate = () => {
    const point = props.price;
    if (!point || point.p50 == null) return null;
    if (harvest()?.p50 != null && Math.abs(point.p50 - harvest()!.p50!) < 0.05) return null;
    return point;
  };
  return (
    <Card kind="price" title="Expected price at harvest" onDetails={props.onDetails}>
      <Show
        when={range()}
        fallback={
          <>
            <Value short="No range" spoken="No expected price range" />
            <p class="today-card-sub">{priceGapText(harvest()?.reason)}</p>
          </>
        }
      >
        {(r) => (
          <Value
            short={shortInrRange(r().low, r().high)}
            spoken={`${formatInr(r().low)} to ${formatInr(r().high)} per kg`}
            unit=" /kg"
          />
        )}
      </Show>
      <Show when={range()}>
        <OutlookLine note={props.view.outlookNote ?? null} />
      </Show>
      <Show when={atDate()}>
        {(point) => (
          <p class="today-card-sub" data-testid="today-price-at-date">
            {formatDay(props.date, false)}: {formatInr(point().p50!)}/kg {point().kind === "observed" ? "recorded" : "typical"}
          </p>
        )}
      </Show>
      <Show when={trend()}>
        {(t) => (
          <p class={`today-trend ${t().direction}`}>
            <span aria-hidden="true">{t().direction === "up" ? "↑" : t().direction === "down" ? "↓" : "→"}</span> {trendText(t())}
          </p>
        )}
      </Show>
      <p class="today-card-basis">{harvest()?.scopeLabel ?? "No price series for this product yet"}</p>
    </Card>
  );
}

export function WeatherCard(props: { date: string; weather: WeatherPoint | null; onDetails: (kind: CardKind) => void }) {
  const point = () => props.weather;
  const usable = () => point() && point()!.kind !== "unavailable";
  return (
    <Card
      kind="weather"
      title={`Weather on ${formatDay(props.date, false)}`}
      class={`weather ${point()?.kind ?? "unavailable"}`}
      onDetails={props.onDetails}
    >
      <div class="today-weather-row">
        <Icon name={(point()?.rainMm ?? 0) >= 1 ? "rain" : "sun"} size={26} />
        <Show when={usable()} fallback={<Value short="–" spoken="No weather data" />}>
          <Value
            short={`${formatTemp(point()!.tMaxC)}/${formatTemp(point()!.tMinC)}`}
            spoken={`High ${formatTemp(point()!.tMaxC)}, low ${formatTemp(point()!.tMinC)}`}
          />
        </Show>
      </div>
      <p class="today-card-sub">
        <Show when={usable()} fallback="No reading for this day">
          {formatRain(point()!.rainMm)}
        </Show>
        <span class={`today-chip ${point()?.kind ?? "unavailable"}`}>{weatherKindLabel[point()?.kind ?? "unavailable"]}</span>
      </p>
      <p class="today-card-basis">{weatherBasis(point())}</p>
    </Card>
  );
}

export function HealthCard(props: { health: HealthReading | null; ndvi: NdviSeries | null; onDetails: (kind: CardKind) => void }) {
  return (
    <Card kind="health" title="Vegetation health" onDetails={props.onDetails}>
      <Show
        when={props.health}
        fallback={
          <>
            <Value short="–" spoken="No satellite reading yet" />
            <p class="today-card-sub">No clear satellite reading yet</p>
            <p class="today-card-basis">Sentinel-2 images every few days when cloud allows</p>
          </>
        }
      >
        {(h) => (
          <>
            <div class="today-weather-row">
              <Value short={h().ndviMean.toFixed(2)} spoken={`NDVI ${h().ndviMean.toFixed(2)}`} unit=" NDVI" />
            </div>
            <p class="today-card-sub">
              <span class={`today-chip verdict ${h().verdict}`}>{verdictLabel[h().verdict]}</span>
            </p>
            <Show when={h().typicalRange}>
              <p class="today-card-sub">
                typical {h().typicalRange!.low.toFixed(2)} to {h().typicalRange!.high.toFixed(2)}
              </p>
            </Show>
            <p class="today-card-basis">
              Image of {formatDay(h().date, false)}
              <Show when={h().neighbourhoodMean != null}> · nearby fields {h().neighbourhoodMean!.toFixed(2)}</Show>
              <Show when={props.ndvi?.smallField}> · small field, compare with nearby</Show>
            </p>
          </>
        )}
      </Show>
    </Card>
  );
}

export function TodayCards(props: TodayCardsProps) {
  return (
    <section class="today-cards" aria-label="Field summary">
      <Show when={!props.weatherOnly}>
        <HarvestCard view={props.view} onDetails={props.onDetails} />
        <PriceCard view={props.view} date={props.date} price={props.price} onDetails={props.onDetails} />
      </Show>
      <WeatherCard date={props.date} weather={props.weather} onDetails={props.onDetails} />
      <Show when={!props.weatherOnly || props.view.health}>
        <HealthCard health={props.view.health} ndvi={props.view.ndvi} onDetails={props.onDetails} />
      </Show>
    </section>
  );
}
