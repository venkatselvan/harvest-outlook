import { For, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { BasisRef, PricePoint, TodayView, WeatherPoint } from "@harvest/contracts";
import { Icon } from "../icons";
import { formatDay, formatInr, priceTrend, rangeLabel, words } from "./model";
import { priceGapText, trendText, verdictLabel, weatherBasis, weatherKindLabel, type CardKind } from "./TodayCards";

export type SheetKind = CardKind | "about";

/** Bottom sheet (modal dialog). The shell's modal focus helper traps focus and closes it on Escape. */
export function BottomSheet(props: { title: string; onClose: () => void; children: JSX.Element }) {
  return (
    <Portal>
      <div class="today-sheet-backdrop" onClick={() => props.onClose()} />
      <div class="today-sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="today-sheet-head">
          <h2>{props.title}</h2>
          <button type="button" class="icon-button" aria-label="Close details" onClick={() => props.onClose()}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div class="today-sheet-body">{props.children}</div>
      </div>
    </Portal>
  );
}

function Basis(props: { basis: BasisRef }) {
  return (
    <div class="today-sheet-basis">
      <p>
        <strong>Basis:</strong> {props.basis.label}
        <Show when={props.basis.scope}> · {props.basis.scope}</Show>
      </p>
      <Show when={props.basis.note}>
        <p>{props.basis.note}</p>
      </Show>
      <Show when={props.basis.url}>
        <a href={props.basis.url!} target="_blank" rel="noreferrer noopener">
          Open source <span aria-hidden="true">↗</span>
        </a>
      </Show>
    </div>
  );
}

const stageBasisLabel = { sourced: "sourced stage length", fao_generic: "standard crop coefficient split", estimate: "estimate" } as const;

export interface TodaySheetProps {
  kind: SheetKind;
  view: TodayView;
  date: string;
  price: PricePoint | null;
  weather: WeatherPoint | null;
  onClose: () => void;
}

export function TodaySheet(props: TodaySheetProps) {
  const title = () =>
    ({ harvest: "Days to harvest", price: "Expected price at harvest", weather: `Weather on ${formatDay(props.date)}`, health: "Vegetation health", about: "About this view" })[props.kind];
  return (
    <BottomSheet title={title()} onClose={props.onClose}>
      <Show when={props.kind === "harvest"}>
        <Show when={props.view.timeline} fallback={<p>No stage dates are available for this crop yet.</p>}>
          {(timeline) => (
            <>
              <p>
                Stage dates are calendar estimates from your recorded sowing date. A stage is never marked reached by a
                satellite image.
              </p>
              <ol class="today-sheet-stages">
                <For each={timeline().stages}>
                  {(stage) => (
                    <li>
                      <strong>{stage.name}</strong> · {rangeLabel(stage.from, stage.to)} <small>({stageBasisLabel[stage.basis]})</small>
                    </li>
                  )}
                </For>
                <Show when={timeline().harvest}>
                  <li>
                    <strong>Harvest window</strong> · {rangeLabel(timeline().harvest!.earliest, timeline().harvest!.latest)}
                  </li>
                </Show>
              </ol>
              <Basis basis={timeline().basis} />
            </>
          )}
        </Show>
      </Show>
      <Show when={props.kind === "price"}>
        <Show when={props.view.harvestPrice} fallback={<p>{priceGapText(null)}</p>}>
          {(price) => (
            <>
              <Show when={price().status === "available" && price().range} fallback={<p>{priceGapText(price().reason)}</p>}>
                <p>
                  Harvest weeks: {formatInr(price().range!.low)} to {formatInr(price().range!.high)} per kg
                  <Show when={price().p50 != null}>, middle {formatInr(price().p50!)}</Show>. This is the likely range: the middle
                  half of past years.
                </p>
              </Show>
              <p>{price().scopeLabel}</p>
              <Show when={props.view.outlookNote?.status === "ready" && props.view.outlookNote.text ? props.view.outlookNote : null}>
                {(note) => (
                  <div class="today-sheet-outlook" data-testid="today-sheet-outlook">
                    <p>
                      <strong>{note().origin === "model" ? "Outlook in words (written by Meta from these facts)" : "Outlook in words (written by code)"}</strong>:{" "}
                      {note().text}
                    </p>
                    <ul>
                      <For each={note().facts}>{(fact) => <li>{fact}</li>}</For>
                    </ul>
                  </div>
                )}
              </Show>
              <p>
                Wholesale mandi modal prices in rupees per kg. The range comes from the same weeks in past years; it is a
                seasonal reference, not a forecast and not a farm-gate price.
              </p>
            </>
          )}
        </Show>
        <Show when={props.price}>
          {(point) => (
            <p>
              {formatDay(props.date)}: {point().p50 != null ? formatInr(point().p50!) : "no middle value"}
              <Show when={point().range}> (range {formatInr(point().range!.low)} to {formatInr(point().range!.high)})</Show> ·{" "}
              {point().kind === "observed" ? `recorded week of ${formatDay(point().date, false)}` : "typical for this week"}
            </p>
          )}
        </Show>
        <Show when={priceTrend(props.view.priceTrack, props.view.today)}>
          {(trend) => (
            <p>
              {trendText(trend())}: weekly middle price from {formatDay(trend().since)} to {formatDay(trend().until)}.
            </p>
          )}
        </Show>
      </Show>
      <Show when={props.kind === "weather"}>
        <Show when={props.weather && props.weather.kind !== "unavailable"} fallback={<p>No weather data for this date.</p>}>
          <p>
            {weatherKindLabel[props.weather!.kind]}: high {props.weather!.tMaxC ?? "–"} °C, low {props.weather!.tMinC ?? "–"} °C,{" "}
            {props.weather!.rainMm ?? "–"} mm rain.
          </p>
          <p>{weatherBasis(props.weather)}</p>
        </Show>
        <p>
          Forecasts cover about two weeks. Beyond that the view shows typical weather for the same dates in recent years,
          labelled Typical, never Forecast.
        </p>
      </Show>
      <Show when={props.kind === "health"}>
        <Show when={props.view.health} fallback={<p>No clear satellite reading of this field yet.</p>}>
          {(health) => (
            <>
              <p>
                NDVI {health().ndviMean.toFixed(2)} on {formatDay(health().date)} · {verdictLabel[health().verdict]}
                <Show when={health().typicalRange}>
                  {" "}
                  (typical for this stage {health().typicalRange!.low.toFixed(2)} to {health().typicalRange!.high.toFixed(2)})
                </Show>
              </p>
              <Show when={health().neighbourhoodMean != null}>
                <p>Fields within about 1 km: {health().neighbourhoodMean!.toFixed(2)}</p>
              </Show>
              <p>Clear pixels in the field: {Math.round(health().clearFraction * 100)}%</p>
              <Show when={props.view.ndvi?.smallField}>
                <p>This field covers few satellite pixels; the nearby-fields value is the safer reference.</p>
              </Show>
              <p>
                NDVI measures how green the canopy looks from space. It is a satellite reading, not a field inspection.
              </p>
              <Basis basis={health().basis} />
            </>
          )}
        </Show>
        <Show when={props.view.ndvi?.attribution}>
          <p class="today-sheet-small">{props.view.ndvi!.attribution}</p>
        </Show>
      </Show>
      <Show when={props.kind === "about"}>
        <p>
          Monitoring is {props.view.monitoring.enabled ? "on" : "off"}
          <Show when={props.view.monitoring.lastCheckedAt}>
            {" "}
            · last checked {new Date(props.view.monitoring.lastCheckedAt!).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
          </Show>
        </p>
        <p>The 3D field is a schematic illustration. Plant shapes are not field observations.</p>
        <Show when={props.view.limitations.length}>
          <ul>
            <For each={props.view.limitations}>{(line) => <li>{line}</li>}</For>
          </ul>
        </Show>
        <Show when={props.view.ndvi?.reason}>
          <p>Satellite: {words(props.view.ndvi!.reason!)}</p>
        </Show>
      </Show>
    </BottomSheet>
  );
}
