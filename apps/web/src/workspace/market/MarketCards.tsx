import { For, Show } from "solid-js";
import type { MarketTimeline, MarketTimelinePoint } from "@harvest/contracts";
import { Chip, type ChipTone } from "../ui/Chip";
import { formatDate, priceSummary, safeUrl, weatherSummary, weekSpan } from "./model";

const WEATHER_TONE: Record<string, ChipTone> = { Observed: "observed", Forecast: "forecast", Typical: "typical" };

/**
 * The three cards that follow the slider (ROUND2_SPEC 3.2): Price (value, Observed or Reference chip and its band),
 * Weather (rain, max/min temperature, Observed, Forecast or Typical chip and day coverage) and Events (alerts and price
 * moves valid that week, with source links). Everything shown comes from the selected timeline point.
 */
export function MarketCards(props: { timeline: MarketTimeline; point: MarketTimelinePoint }) {
  const price = () => priceSummary(props.point);
  const weather = () => weatherSummary(props.point);
  const span = () => weekSpan(props.point);
  return (
    <section class="market-cards" aria-label="Selected week" aria-live="polite">
      <article class="market-card" data-card="price">
        <header>
          <h3>Price</h3>
          <Show when={price().chip}>{(chip) => <Chip tone={chip() === "Observed" ? "observed" : "typical"}>{chip()}</Chip>}</Show>
        </header>
        <p class="market-card-value" data-testid="market-price-value">
          <Show when={price().value} fallback={<span class="market-card-none">–</span>}>
            {(v) => (
              <>
                {v()}
                <small>/kg</small>
              </>
            )}
          </Show>
        </p>
        <p class="market-card-sub" data-testid="market-price-band">
          {price().band}
        </p>
        <p class="market-card-basis">
          {span()} · {props.timeline.scope.label}. Wholesale mandi modal price, not a farm-gate price.
          <Show when={price().chip === "Reference"}> Seasonal reference from past years, not a forecast.</Show>
        </p>
        <span class="market-sr">{price().spoken}</span>
      </article>

      <article class={`market-card market-card-weather ${props.point.weather.kind}`} data-card="weather">
        <header>
          <h3>Weather</h3>
          <Show when={weather().chip}>{(chip) => <Chip tone={WEATHER_TONE[chip()] ?? "neutral"}>{chip()}</Chip>}</Show>
        </header>
        <p class="market-card-value" data-testid="market-weather-rain">
          {weather().rain}
        </p>
        <p class="market-card-sub">
          <Show when={weather().temps}>
            {(t) => (
              <span>
                {t()} <span class="market-card-muted">max/min</span>
              </span>
            )}
          </Show>
          <span>{weather().coverage}</span>
        </p>
        <p class="market-card-basis">
          {span()} · field point
          <Show when={props.point.weather.kind === "forecast" && props.timeline.forecastHorizonEnd}>
            {(end) => <>, forecast to {formatDate(end())}</>}
          </Show>
          <Show when={props.point.weather.kind === "typical"}>, typical values describe a normal year, not a forecast</Show>
        </p>
      </article>

      <article class="market-card market-card-events" data-card="events">
        <header>
          <h3>Events</h3>
          <Show when={props.point.events.length}>
            <span class="market-card-count">{props.point.events.length}</span>
          </Show>
        </header>
        <Show when={props.point.events.length} fallback={<p class="market-card-sub">No alerts or price moves this week</p>}>
          <ul class="market-events">
            <For each={props.point.events}>
              {(e) => (
                <li class="market-event" data-event-kind={e.kind}>
                  <div class="market-event-head">
                    <Chip tone={e.severity}>{e.kind === "price_move" ? "Price move" : e.severity === "warning" ? "Warning" : e.severity === "watch" ? "Watch" : "Info"}</Chip>
                    <Show when={e.dismissed}>
                      <Chip tone="neutral">Dismissed</Chip>
                    </Show>
                  </div>
                  <p class="market-event-title">{e.title}</p>
                  <p class="market-event-detail">{e.detail}</p>
                  <Show when={e.source}>
                    {(s) => (
                      <p class="market-event-source">
                        <Show when={safeUrl(s().url)} fallback={<span>Source: {s().name}</span>}>
                          {(url) => (
                            <a href={url()} target="_blank" rel="noopener noreferrer">
                              Source: {s().name} ↗
                            </a>
                          )}
                        </Show>
                        <Show when={s().date}>{(d) => <span class="market-card-muted"> · {formatDate(d())}</span>}</Show>
                      </p>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </article>
    </section>
  );
}
