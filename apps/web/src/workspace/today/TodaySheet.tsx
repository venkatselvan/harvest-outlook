import { For, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { BasisRef, IndexStageReading, NdviReading, PricePoint, TodayView, WeatherPoint } from "@harvest/contracts";
import { Icon } from "../icons";
import {
  curveAgreementWords,
  curveLine,
  curvePhaseText,
  curveShortfall,
  formatDay,
  formatIndex,
  formatInr,
  INDEX_INFO,
  INDEX_ORDER,
  indexCode,
  priceTrend,
  rangeLabel,
  words,
} from "./model";
import { priceGapText, trendText, verdictLabel, weatherBasis, weatherKindLabel, type CardKind } from "./TodayCards";

export type SheetKind = CardKind | "about" | "curve";

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

export function Basis(props: { basis: BasisRef }) {
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

/** All seven indices of one scene: field mean, what it responds to, and the formula that produced it. */
export function IndexTable(props: { reading: NdviReading | null | undefined }) {
  const indices = () => props.reading?.field.indices ?? null;
  return (
    <section class="today-sheet-indices" aria-labelledby="today-index-title" data-testid="today-index-table">
      <h3 id="today-index-title">Other indices from the same image</h3>
      <Show
        when={indices()}
        fallback={<p>The other indices have not been calculated for this image yet.</p>}
      >
        {(summaries) => (
          <>
            <p class="today-sheet-small">
              Field mean over the clear pixels of the image of {formatDay(props.reading!.date)}. Each value is a satellite reading, not a field inspection.
            </p>
            <dl class="today-index-table">
              <For each={INDEX_ORDER}>
                {(id) => (
                  <div class="today-index-row" data-index-id={id}>
                    <dt>
                      {INDEX_INFO[id].label} <span class="today-index-code">({indexCode(id)})</span>
                    </dt>
                    <dd class="today-index-value">{formatIndex(summaries()[id]?.mean)}</dd>
                    <dd class="today-index-meaning">{INDEX_INFO[id].meaning}</dd>
                    <dd class="today-index-formula">Formula: {INDEX_INFO[id].formula}</dd>
                  </div>
                )}
              </For>
            </dl>
            <p>
              B5, B8A and B11 are 20 m bands resampled to the 10 m grid, so these three indices rest on fewer independent pixels.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}

const signed = (value: number) => (value > 0 ? `+${formatIndex(value)}` : formatIndex(value));
const withDate = (value: number | null, date: string | null) =>
  value == null ? "–" : date ? `${formatIndex(value)} on ${formatDay(date)}` : formatIndex(value);
const curveStatusLabel = (reading: IndexStageReading) =>
  reading.status === "available"
    ? "Read from the field's own satellite images"
    : reading.status === "insufficient"
      ? curveShortfall(reading).status
      : "Not available";
const sentenceCase = (value: string) => value.replace(/^\w/, (c) => c.toUpperCase());

/**
 * What the code read from the field's own NDVI curve, side by side with the calendar stage. Evidence only: the fixed
 * line says so, and nothing here moves a stage date.
 */
export function CurveSheetBody(props: { reading: IndexStageReading | null | undefined }) {
  return (
    <Show when={props.reading} fallback={<p>No satellite curve reading is available for this field.</p>}>
      {(reading) => (
        <>
          <p data-testid="today-curve-headline">{curveLine(reading()) ?? "Satellite curve: not available"}</p>
          <dl class="today-curve-facts">
            <div>
              <dt>Status</dt>
              <dd>{curveStatusLabel(reading())}</dd>
            </div>
            <Show when={reading().status === "available"}>
              <div>
                <dt>Phase</dt>
                <dd>{sentenceCase(curvePhaseText(reading()))}</dd>
              </div>
              <div>
                <dt>Green-up</dt>
                <dd>{reading().greenUpDate ? `Seen ${formatDay(reading().greenUpDate)}` : "Not seen in this window"}</dd>
              </div>
              <div>
                <dt>Peak</dt>
                <dd>{withDate(reading().peakValue, reading().peakDate)}</dd>
              </div>
              <div>
                <dt>Lowest</dt>
                <dd>{withDate(reading().troughValue, reading().troughDate)}</dd>
              </div>
              <div>
                <dt>Latest smoothed NDVI</dt>
                <dd>{formatIndex(reading().latestSmoothed)}</dd>
              </div>
              <div>
                <dt>Change over 15 days</dt>
                <dd>{reading().change15d == null ? "–" : signed(reading().change15d!)}</dd>
              </div>
            </Show>
            <div>
              <dt>Readings used</dt>
              <dd>
                {`${reading().readingsUsed} clear ${reading().readingsUsed === 1 ? "image" : "images"}`}
                <Show when={reading().window}>{`, window ${rangeLabel(reading().window!.from, reading().window!.to)}`}</Show>
                <Show when={reading().status === "insufficient"}>{curveShortfall(reading()).needed}</Show>
              </dd>
            </div>
            <Show when={reading().asOf}>
              <div>
                <dt>Latest clear image</dt>
                <dd>{formatDay(reading().asOf)}</dd>
              </div>
            </Show>
            <Show when={reading().calendarStage}>
              {(stage) => (
                <div>
                  <dt>Calendar stage compared</dt>
                  <dd>
                    {stage().name} · {rangeLabel(stage().from, stage().to)}
                  </dd>
                </div>
              )}
            </Show>
            <Show when={curveAgreementWords[reading().agreement]}>
              <div>
                <dt>Against the calendar</dt>
                <dd>{sentenceCase(curveAgreementWords[reading().agreement])}</dd>
              </div>
            </Show>
          </dl>
          <Show when={reading().summary && reading().summary !== curveLine(reading())}>
            <p data-testid="today-curve-summary">{reading().summary}</p>
          </Show>
          <p class="today-curve-evidence">
            Evidence only: the stage dates above are calendar estimates and are not changed by this reading.
          </p>
          <Show when={reading().limitations.length}>
            <ul class="today-curve-limits">
              <For each={reading().limitations}>{(line) => <li>{line}</li>}</For>
            </ul>
          </Show>
          <Basis basis={reading().basis} />
        </>
      )}
    </Show>
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
    ({ harvest: "Days to harvest", price: "Expected price at harvest", weather: `Weather on ${formatDay(props.date)}`, health: "Vegetation health", about: "About this view", curve: "Satellite curve and the calendar" })[props.kind];
  return (
    <BottomSheet title={title()} onClose={props.onClose}>
      <TodaySheetBody kind={props.kind} view={props.view} date={props.date} price={props.price} weather={props.weather} />
    </BottomSheet>
  );
}

/** The content of every sheet kind. Separate from the dialog shell so tests can render it without the portal. */
export function TodaySheetBody(props: Omit<TodaySheetProps, "onClose">) {
  return (
    <>
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
              <IndexTable reading={props.view.ndvi?.latestUsable} />
            </>
          )}
        </Show>
        <Show when={props.view.ndvi?.attribution}>
          <p class="today-sheet-small">{props.view.ndvi!.attribution}</p>
        </Show>
      </Show>
      <Show when={props.kind === "curve"}>
        <CurveSheetBody reading={props.view.indexStage} />
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
    </>
  );
}
