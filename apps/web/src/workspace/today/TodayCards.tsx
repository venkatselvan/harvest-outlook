import { For, Show, type JSX } from "solid-js";
import type {
  CarbonFootprint,
  EnergyFootprint,
  HarvestEconomics,
  HealthReading,
  NdviSeries,
  PricePoint,
  ResidueIncome,
  TodayView,
  WeatherPoint,
} from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import {
  carbonTermLine,
  co2eParts,
  compactInr,
  compactInrRange,
  costValue,
  energyBasisShort,
  equivalentText,
  formatDay,
  formatCo2e,
  formatGJ,
  formatIndex,
  formatInr,
  formatRain,
  formatTemp,
  formatTonnesRange,
  indexLine,
  inrRangeText,
  lpgEquivalent,
  nextStage,
  orderResidueOptions,
  priceTrend,
  profitValue,
  rangeLabel,
  rankChip,
  residueTitle,
  RESIDUE_ALTERNATIVES,
  revenueValue,
  shortInrRange,
  spokenCo2e,
  spokenIndex,
  spokenInr,
  unavailableReason,
  yieldBasisWords,
  type PriceTrend,
} from "./model";

export type CardKind = "harvest" | "price" | "weather" | "health" | "profit" | "residue" | "energy" | "carbon";

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
/**
 * Deeper weather values (WEATHER_DEPTH_SPEC.md D-W4 and section 7). They are Open-Meteo model estimates for the grid
 * cell around the field, never field readings, and every surface that shows one carries this wording.
 */
export const AGRO_LABEL = "Open-Meteo model estimate for the grid cell, not a field reading";
const AGRO_ATTRIBUTION = "Weather data by Open-Meteo.com";

export interface AgroFact {
  id: "et0" | "humidity" | "gust" | "rain_chance";
  /** Visible short form, for example "humidity 78%". */
  short: string;
  /** Spoken long form for screen readers. */
  spoken: string;
}

/** Which kind of estimate a point is, for hover/aria text: typical days are climatology, never a forecast. */
export function agroKindNote(point: WeatherPoint): string {
  if (point.kind === "typical") return "typical (climatology), not a forecast";
  if (point.kind === "forecast") return `forecast${point.basis.issuedAt ? ` issued ${formatDay(point.basis.issuedAt.slice(0, 10), false)}` : ""}`;
  return "reanalysis of the day";
}

/**
 * Water demand (ET0), mean humidity, gust maximum and rain chance of a weather point. Empty when the point has no `agro`
 * block or is unavailable; a null value is simply left out, never drawn as zero.
 */
export function weatherAgroFacts(point: WeatherPoint | null): AgroFact[] {
  const agro = point && point.kind !== "unavailable" ? point.agro : undefined;
  if (!agro) return [];
  const out: AgroFact[] = [];
  if (agro.et0Mm != null) out.push({ id: "et0", short: `water demand ${agro.et0Mm.toFixed(1)} mm`, spoken: `Water demand (reference evapotranspiration) ${agro.et0Mm.toFixed(1)} millimetres` });
  if (agro.rhMeanPct != null) out.push({ id: "humidity", short: `humidity ${Math.round(agro.rhMeanPct)}%`, spoken: `Average humidity ${Math.round(agro.rhMeanPct)} percent` });
  if (agro.gustMaxKmh != null) out.push({ id: "gust", short: `gusts ${Math.round(agro.gustMaxKmh)} km/h`, spoken: `Strongest gusts ${Math.round(agro.gustMaxKmh)} kilometres per hour` });
  if (agro.rainProbabilityPct != null) out.push({ id: "rain_chance", short: `${Math.round(agro.rainProbabilityPct)}% rain chance`, spoken: `${Math.round(agro.rainProbabilityPct)} percent chance of rain` });
  return out;
}

export function trendText(trend: PriceTrend): string {
  const since = formatDay(trend.since).replace(/^\d+ /, "");
  return trend.direction === "flat"
    ? `Steady since ${since}`
    : `${trend.direction === "up" ? "Up" : "Down"} ${Math.abs(trend.pct)}% since ${since}`;
}

/** Value with a visual short form and a spoken long form, so "₹19.2–23.8" is read as "₹19.2 to ₹23.8 per kg". */
function Value(props: { short: string; spoken: string; unit?: string; econ?: boolean }) {
  return (
    <p class={props.econ ? "today-card-value today-econ-value" : "today-card-value"}>
      <span aria-hidden="true">
        {props.econ ? <span class="today-econ-num">{props.short}</span> : props.short}
        <Show when={props.unit}>
          <small>{props.unit}</small>
        </Show>
      </span>
      <span class="today-sr">{props.spoken}</span>
    </p>
  );
}

/** Short text on screen, long text for a screen reader (the short form is hidden from them). */
function Dual(props: { short: string; spoken: string }) {
  return (
    <>
      <span aria-hidden="true">{props.short}</span>
      <span class="today-sr">{props.spoken}</span>
    </>
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
      <Show when={weatherAgroFacts(point()).length}>
        <ul class="today-agro" data-testid="today-agro" aria-label={`More weather for this day. ${AGRO_LABEL}.`}>
          <For each={weatherAgroFacts(point())}>
            {(fact) => (
              <li class={fact.id === "rain_chance" ? "today-chip agro" : "today-agro-item"} data-agro={fact.id} title={`${fact.spoken}. ${AGRO_LABEL} (${agroKindNote(point()!)}). ${AGRO_ATTRIBUTION}.`}>
                <span aria-hidden="true">{fact.short}</span>
                <span class="today-sr">{`${fact.spoken}. ${AGRO_LABEL}; ${agroKindNote(point()!)}.`}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="today-card-basis">{weatherBasis(point())}</p>
    </Card>
  );
}

/**
 * Moisture index, red-edge greenness and water index of the same image, one per line under the NDVI basis line (name
 * and code on the left, the value on the right). Hidden when the scene carries no index summaries (rows analysed
 * before the indices existed). Screen readers get the spoken form ("minus 0.45"); the visible form uses the true minus.
 */
export function IndexLine(props: { ndvi: NdviSeries | null; healthDate: string }) {
  const reading = () => props.ndvi?.latestUsable ?? null;
  const items = () => indexLine(reading()?.field);
  // The NDVI headline belongs to the health reading's image; name the image when the index scene is a different one.
  const otherImage = () => (reading() && reading()!.date !== props.healthDate ? `Indices from the image of ${formatDay(reading()!.date, false)}` : "");
  return (
    <Show when={items().length}>
      <div class="today-index-line" data-testid="today-index-line">
        <ul>
          <For each={items()}>
            {(item) => (
              <li class="today-index-item" data-index-id={item.id}>
                <span class="today-index-name" aria-hidden="true">
                  {item.label} <span class="today-index-code">({item.code})</span>
                </span>{" "}
                <span class="today-index-num" aria-hidden="true">{formatIndex(item.value)}</span>
                <span class="today-sr">{`${item.label}, ${item.code} ${spokenIndex(item.value)}`}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={otherImage()}>
          <p class="today-index-note">{otherImage()}</p>
        </Show>
      </div>
    </Show>
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
            <IndexLine ndvi={props.ndvi} healthDate={h().date} />
          </>
        )}
      </Show>
    </Card>
  );
}


// ---------------------------------------------------------------- economics and footprint cards (TODAY_ECONOMICS_FOOTPRINT_SPEC section 6)

/** A card whose block has no figure: a dash and the reason sentence (the first limitation, else a plain fallback). */
function NoFigure(props: { spoken: string; reason: string }) {
  return (
    <>
      <Value short="–" spoken={props.spoken} econ />
      <p class="today-card-sub today-econ-reason">{props.reason}</p>
    </>
  );
}

export function ProfitCard(props: { econ: HarvestEconomics; onDetails: (kind: CardKind) => void }) {
  const econ = () => props.econ;
  const value = () => profitValue(econ());
  const revenue = () => revenueValue(econ());
  const cost = () => costValue(econ());
  const per = (scope: "field" | "ha") => (scope === "ha" ? " /ha" : "");
  const spokenPer = (scope: "field" | "ha") => (scope === "ha" ? " per hectare" : " for the field");
  const harvestLine = () => {
    const harvest = econ().harvest;
    if (harvest) return `Harvest around ${rangeLabel(harvest.earliest, harvest.latest)}`;
    return econ().harvestDate ? `Harvest around ${formatDay(econ().harvestDate, false)}` : null;
  };
  const basisLine = () => {
    const yieldRef = econ().basis.find((b) => b.kind === "yield_reference");
    const yieldPart = yieldRef?.label ?? (econ().yieldBasis ? `Based on ${yieldBasisWords[econ().yieldBasis!]}` : null);
    const pricePart = econ().price?.scopeLabel ?? null;
    return [yieldPart, pricePart].filter(Boolean).join(" · ") || "Regional yield, price and cost references";
  };
  return (
    <Card kind="profit" title="Expected profit at harvest" class="today-econ-card" onDetails={props.onDetails}>
      <Show
        when={econ().status !== "unavailable" ? value() : null}
        fallback={<NoFigure spoken="No profit estimate" reason={unavailableReason(econ(), "Profit at harvest cannot be estimated for this crop yet.")} />}
      >
        {(v) => (
          <>
            <Show when={v().kind === "revenue"}>
              <p class="today-card-sub today-econ-kind">Revenue before costs</p>
            </Show>
            <Value
              short={compactInr(v().estimate.central)}
              spoken={`${v().kind === "profit" ? "Expected profit" : "Expected revenue"}${spokenPer(v().scope)}, about ${spokenInr(v().estimate.central)}`}
              unit={per(v().scope)}
              econ
            />
            <p class="today-card-sub today-econ-band" data-testid="today-profit-band">
              <Dual
                short={`likely ${compactInrRange(v().estimate.likely.low, v().estimate.likely.high)}`}
                spoken={`${inrRangeText(v().estimate.likely.low, v().estimate.likely.high)}, likely range`}
              />
            </p>
            <Show when={harvestLine()}>
              <p class="today-card-sub">{harvestLine()}</p>
            </Show>
            <Show
              when={v().kind === "profit" && revenue() && cost() ? { revenue: revenue()!, cost: cost()! } : null}
              fallback={
                <Show when={v().kind === "revenue" || !cost()}>
                  <p class="today-card-sub today-econ-cost">Cost not sourced</p>
                </Show>
              }
            >
              {(pair) => (
                <p class="today-card-sub today-econ-cost">
                  <Dual
                    short={`Revenue ${compactInr(pair().revenue.estimate.central)} · cost ${compactInr(pair().cost.value)}${per(pair().cost.scope)}`}
                    spoken={`Revenue ${spokenInr(pair().revenue.estimate.central)}, cost ${spokenInr(pair().cost.value)}${spokenPer(pair().cost.scope)}`}
                  />
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
      <p class="today-card-basis">{basisLine()}</p>
    </Card>
  );
}

export function ResidueCard(props: { residue: ResidueIncome; onDetails: (kind: CardKind) => void }) {
  const residue = () => props.residue;
  const title = () => residueTitle(residue().residueName);
  const options = () => orderResidueOptions(residue().options);
  const best = () => options()[0] ?? null;
  const income = () => best()?.incomeForField ?? null;
  const quantity = () => {
    const name = residue().residueName ? residue().residueName!.charAt(0).toUpperCase() + residue().residueName!.slice(1) : "Residue";
    const surplus = residue().surplusForFieldKg, all = residue().residueForFieldKg;
    if (surplus && all) return `${name}: about ${formatTonnesRange(surplus)} surplus of ${formatTonnesRange(all)}`;
    if (surplus) return `${name}: about ${formatTonnesRange(surplus)} surplus`;
    return all ? `${name}: about ${formatTonnesRange(all)} in all` : null;
  };
  return (
    <Card kind="residue" title={title()} class="today-residue-card" onDetails={props.onDetails}>
      <Show
        when={residue().status === "available" && best() ? best()! : null}
        fallback={<NoFigure spoken="No residue income estimate" reason={unavailableReason(residue(), "Income from this crop's residue cannot be estimated yet.")} />}
      >
        {(option) => (
          <>
            <Show
              when={income()}
              fallback={
                <>
                  <Value short="–" spoken="No income estimate: no reported price for these uses" econ />
                  <p class="today-card-sub today-residue-noprice">No reported price for these uses yet</p>
                </>
              }
            >
              {(range) => (
                <>
                  <Value
                    short={compactInrRange(range().low, range().high)}
                    spoken={`${inrRangeText(range().low, range().high)} for the field, as ${option().label}`}
                    econ
                  />
                  <p class="today-card-sub today-residue-best">as {option().label}</p>
                </>
              )}
            </Show>
            <Show when={quantity()}>
              <p class="today-card-sub today-residue-quantity">{quantity()}</p>
            </Show>
            <ul class="today-residue-options" aria-label="Ways to use the residue">
              <For each={options()}>
                {(o, i) => (
                  <>
                    <Show when={i() > 0}>
                      <li class="today-residue-or" aria-hidden="true">or</li>
                    </Show>
                    <li class="today-chip today-residue-chip" classList={{ "is-best": i() === 0 }} data-use={o.use}>
                      {o.label}
                    </li>
                  </>
                )}
              </For>
            </ul>
            <p class="today-card-sub today-residue-alt">{RESIDUE_ALTERNATIVES}</p>
          </>
        )}
      </Show>
      <p class="today-card-basis">Residue ratio and prices from published sources</p>
    </Card>
  );
}

export function EnergyCard(props: { energy: EnergyFootprint; residueName: string | null; onDetails: (kind: CardKind) => void }) {
  const energy = () => props.energy;
  // The field figure when the area is known; otherwise the per-hectare figure, marked "/ha" (spec section 6: whichever figure exists).
  const used = () => energy().inputEnergyGJForField ?? energy().inputEnergyGJPerHa;
  const usedPerHaOnly = () => energy().inputEnergyGJForField == null && energy().inputEnergyGJPerHa != null;
  const held = () => energy().residueEnergyGJForField;
  const lpg = () => lpgEquivalent(energy().equivalents);
  const usedItems = () =>
    [...energy().inputBreakdown]
      .sort((a, b) => b.share - a.share)
      .slice(0, 3)
      .map((item) => item.item.toLowerCase());
  const residueWord = () => (props.residueName ? props.residueName.charAt(0).toUpperCase() + props.residueName.slice(1) : "The residue");
  const gj = (r: { low: number; high: number }) => {
    const text = formatGJ(r);
    return { short: text.replace(/ GJ$/, ""), spoken: `${text.replace(/ GJ$/, "").replace("–", " to ")} gigajoules` };
  };
  return (
    <Card kind="energy" title="Energy" class="today-energy-card" onDetails={props.onDetails}>
      <Show
        when={energy().status !== "unavailable" ? (used() ?? held()) : null}
        fallback={<NoFigure spoken="No energy estimate" reason={unavailableReason(energy(), "Energy figures for this crop are not available yet.")} />}
      >
        {(lead) => (
          <>
            <Value short={gj(lead()).short} spoken={`${gj(lead()).spoken}${used() && usedPerHaOnly() ? " per hectare" : ""}${used() ? " used to grow this crop" : " held in the residue"}`} unit={used() && usedPerHaOnly() ? " GJ /ha" : " GJ"} econ />
            <p class="today-card-sub today-energy-used">
              {used()
                ? `used to grow this crop${usedItems().length ? ` (${usedItems().join(", ")})` : ""}`
                : `held in the ${props.residueName ?? "residue"}; the energy used to grow the crop is not sourced`}
            </p>
            <Show when={used() && held()}>
              <p class="today-card-sub today-energy-held">
                <Dual
                  short={`${residueWord()} holds ${formatGJ(held()!)}${lpg() ? ` · about ${equivalentText(lpg()!)}` : ""}`}
                  spoken={`${residueWord()} holds ${gj(held()!).spoken}${lpg() ? `, about ${equivalentText(lpg()!)}` : ""}`}
                />
              </p>
            </Show>
            <Show when={!used() && held() && lpg()}>
              <p class="today-card-sub today-energy-held">about {equivalentText(lpg()!)}</p>
            </Show>
          </>
        )}
      </Show>
      <p class="today-card-basis">{energyBasisShort(energy().inputEnergyBasis, energy().basis)}</p>
    </Card>
  );
}

export function CarbonCard(props: { carbon: CarbonFootprint; onDetails: (kind: CardKind) => void }) {
  const carbon = () => props.carbon;
  // The field total when the area is known; otherwise the per-hectare figure, marked "/ha".
  const total = () => carbon().emissionsForField ?? carbon().emissionsPerHa;
  const perHaOnly = () => carbon().emissionsForField == null;
  const rank = () => (carbon().comparison ? rankChip(carbon().comparison!) : null);
  const lowest = () => carbon().comparison?.lowest ?? null;
  const termLine = () => carbonTermLine(carbon().terms);
  return (
    <Card kind="carbon" title="Carbon" class="today-carbon-card" onDetails={props.onDetails}>
      <Show
        when={carbon().status !== "unavailable" ? total() : null}
        fallback={<NoFigure spoken="No carbon footprint estimate" reason={unavailableReason(carbon(), "A carbon footprint for this crop is not available yet.")} />}
      >
        {(range) => (
          <>
            <Value short={co2eParts(range()).short} spoken={`${spokenCo2e(range())}${perHaOnly() ? " per hectare" : ""} emitted this season`} unit={` ${co2eParts(range()).unit}${perHaOnly() ? " /ha" : ""}`} econ />
            <p class="today-card-sub today-carbon-emitted">emitted this season</p>
            <Show when={termLine()}>
              <p class="today-card-sub today-carbon-largest">{termLine()}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={rank()}>
        {(chip) => (
          <p class="today-card-sub today-carbon-rank">
            <span class="today-chip today-carbon-chip" aria-hidden="true">{chip().text}</span>
            <span class="today-sr">{chip().spoken}</span>
          </p>
        )}
      </Show>
      <Show when={lowest()}>
        {(low) => (
          <p class="today-card-sub today-carbon-lowest">
            <Show
              when={carbon().comparison?.rank !== 1}
              fallback="the lowest here is this crop"
            >
              <Dual
                short={`lowest here: ${low().cropName} ${formatCo2e(low().tCO2eForField)}`}
                spoken={`Lowest here: ${low().cropName}, ${spokenCo2e(low().tCO2eForField)}`}
              />
            </Show>
          </p>
        )}
      </Show>
      <p class="today-card-basis">
        {carbon().seasonDays != null ? `${carbon().seasonDays} day season` : "Season emissions"}
        {carbon().fieldAreaHa != null ? ` on ${carbon().fieldAreaHa!.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ha` : " per hectare reference"}
      </p>
    </Card>
  );
}

export function TodayCards(props: TodayCardsProps) {
  return (
    <section class="today-cards" aria-label="Field summary">
      <Show when={!props.weatherOnly}>
        <HarvestCard view={props.view} onDetails={props.onDetails} />
        <Show when={props.view.harvestEconomics}>{(econ) => <ProfitCard econ={econ()} onDetails={props.onDetails} />}</Show>
        <PriceCard view={props.view} date={props.date} price={props.price} onDetails={props.onDetails} />
      </Show>
      <WeatherCard date={props.date} weather={props.weather} onDetails={props.onDetails} />
      <Show when={!props.weatherOnly || props.view.health}>
        <HealthCard health={props.view.health} ndvi={props.view.ndvi} onDetails={props.onDetails} />
      </Show>
      <Show when={!props.weatherOnly}>
        <Show when={props.view.residueIncome}>{(residue) => <ResidueCard residue={residue()} onDetails={props.onDetails} />}</Show>
        <Show when={props.view.energyFootprint}>
          {(energy) => <EnergyCard energy={energy()} residueName={props.view.residueIncome?.residueName ?? null} onDetails={props.onDetails} />}
        </Show>
        <Show when={props.view.carbonFootprint}>{(carbon) => <CarbonCard carbon={carbon()} onDetails={props.onDetails} />}</Show>
      </Show>
    </section>
  );
}
