import { createSignal, createUniqueId, For, Match, onCleanup, onMount, Show, Switch, useContext, type JSX } from "solid-js";
import type { CarbonFootprint, EnergyFootprint, HarvestEconomics, ResidueIncome, SoilReading, SoilReview, TodayView } from "@harvest/contracts";
import { Dynamic } from "solid-js/web";
import { Icon } from "../icons";
import { Chip } from "../ui/Chip";
import { ratingChipTone, ratingLabel, valueText } from "../farm/soilReviewModel";
import { isRatedReading, sharedProvenance, type SoilCardState } from "./todaySoilModel";
import { createSoilCardController, SoilCardContext } from "./TodaySoil";
import { priceGapText, type CardKind } from "./TodayCards";
import {
  co2eParts,
  compactInr,
  compactInrRange,
  energyBasisShort,
  formatCo2e,
  formatDay,
  formatGJ,
  formatInr,
  inrRangeText,
  orderResidueOptions,
  profitValue,
  rankChip,
  residueTitle,
  shortInrRange,
  spokenCo2e,
  spokenInr,
  unavailableReason,
} from "./model";
import { latestQuote } from "./todayMapModel";

/**
 * The layered "Harvest outlook" card under the hero (TODAY_REFINEMENT_SPEC.md 5). It only re-arranges blocks the Today
 * payload already carries: the expected profit and the residue income on top, then three small tiles (harvest-week price,
 * soil, energy and carbon). Every figure keeps a tiny basis mark (Sourced, Modelled or Estimate); the mark is a button whose
 * one-line note (the caveat, the source, the comparison) shows on hover, on keyboard focus and on a tap, and Escape hides
 * it. The full text, sources and limitations stay in the existing details sheets the "Details" buttons open.
 */

export type OutlookBasis = "sourced" | "modelled" | "estimate";
export const OUTLOOK_BASIS_LABEL: Record<OutlookBasis, string> = { sourced: "Sourced", modelled: "Modelled", estimate: "Estimate" };

/**
 * A figure with its basis mark and one-line note. Hover over the figure or the mark, focus the mark, or tap it to show
 * the note; tap again, Escape, or leaving it hides it. The note is the mark's accessible description, so a screen reader
 * hears it with the mark.
 */
export function BasisTip(props: { basis: OutlookBasis; note: string; subject: string; block?: boolean; children: JSX.Element }) {
  const id = `today-tip-${createUniqueId()}`;
  const [pinned, setPinned] = createSignal(false);
  const [hushed, setHushed] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let mark: HTMLButtonElement | undefined;
  onMount(() => {
    // Escape hides a note shown by hover too, not only one the mark holds focus for (WCAG 1.4.13, dismissible).
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(pinned() || hovered() || document.activeElement === mark)) return;
      setPinned(false);
      setHushed(true);
    };
    document.addEventListener("keydown", key);
    onCleanup(() => document.removeEventListener("keydown", key));
  });
  return (
    <Dynamic
      component={props.block ? "div" : "span"}
      class={props.block ? "today-tip is-block" : "today-tip"}
      data-open={pinned() ? "true" : undefined}
      data-hushed={hushed() ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setHushed(false);
      }}
    >
      {props.children}
      <button
        type="button"
        class="today-basis-mark"
        data-basis={props.basis}
        ref={mark}
        aria-describedby={id}
        onClick={() => {
          setHushed(false);
          setPinned(!pinned());
        }}
        onBlur={() => {
          setPinned(false);
          setHushed(false);
        }}
      >
        {OUTLOOK_BASIS_LABEL[props.basis]}
        <span class="today-sr">: {props.subject}</span>
      </button>
      <span class="today-tip-pop" role="tooltip" id={id}>
        {props.note}
      </span>
    </Dynamic>
  );
}

/** "Details →" for a block, named for its sheet. */
function DetailsButton(props: { kind: CardKind; title: string; label?: string; onDetails: (kind: CardKind) => void }) {
  return (
    <button type="button" class="today-outlook-more" onClick={() => props.onDetails(props.kind)} aria-label={`${props.title}: details and sources`}>
      {props.label ?? "Details"} <Icon name="arrow" size={12} />
    </button>
  );
}

/** Short text on screen, a longer form for a screen reader. */
function Dual(props: { short: string; spoken: string }) {
  return (
    <>
      <span aria-hidden="true">{props.short}</span>
      <span class="today-sr">{props.spoken}</span>
    </>
  );
}

// ---------------------------------------------------------------- top band

function ProfitLead(props: { econ: HarvestEconomics; onDetails: (kind: CardKind) => void }) {
  const value = () => (props.econ.status !== "unavailable" ? profitValue(props.econ) : null);
  const per = () => (value()?.scope === "ha" ? " /ha" : "");
  return (
    <article class="today-outlook-lead" data-outlook="profit" aria-labelledby="today-outlook-profit">
      <h3 id="today-outlook-profit">Expected profit at harvest</h3>
      <Show
        when={value()}
        fallback={
          <>
            <p class="today-outlook-figure is-empty">
              <Dual short="–" spoken="No profit estimate" />
            </p>
            <p class="today-outlook-sub">{unavailableReason(props.econ, "Profit at harvest cannot be estimated for this crop yet.")}</p>
          </>
        }
      >
        {(v) => (
          <>
            <p class="today-outlook-figure">
              <BasisTip
                basis="estimate"
                subject={v().kind === "profit" ? "expected profit" : "expected revenue"}
                note={v().kind === "profit" ? "Regional references · not a farm measurement" : "Revenue before costs · regional references, not a farm measurement"}
              >
                <span class="today-outlook-num">
                  <Dual
                    short={`${compactInr(v().estimate.central)}${per()}`}
                    spoken={`${v().kind === "profit" ? "Expected profit" : "Expected revenue"} ${v().scope === "ha" ? "per hectare" : "for the field"}, about ${spokenInr(v().estimate.central)}`}
                  />
                </span>
              </BasisTip>
            </p>
            <p class="today-outlook-sub" data-testid="today-profit-band">
              <Dual
                short={`likely ${compactInrRange(v().estimate.likely.low, v().estimate.likely.high)}${v().kind === "revenue" ? " revenue" : ""}`}
                spoken={`${inrRangeText(v().estimate.likely.low, v().estimate.likely.high)}, likely ${v().kind === "revenue" ? "revenue " : ""}range`}
              />
            </p>
            <Show when={v().kind === "revenue"}>
              <p class="today-outlook-sub">Revenue before costs · cost not sourced; profit unavailable</p>
            </Show>
          </>
        )}
      </Show>
      <DetailsButton kind="profit" title="Expected profit at harvest" onDetails={props.onDetails} />
    </article>
  );
}

function ResidueLead(props: { residue: ResidueIncome; onDetails: (kind: CardKind) => void }) {
  const best = () => (props.residue.status === "available" ? (orderResidueOptions(props.residue.options)[0] ?? null) : null);
  const income = () => best()?.incomeForField ?? null;
  const title = () => residueTitle(props.residue.residueName);
  return (
    <article class="today-outlook-lead" data-outlook="residue" aria-labelledby="today-outlook-residue">
      <h3 id="today-outlook-residue">{title()}</h3>
      <Show
        when={best()}
        fallback={
          <>
            <p class="today-outlook-figure is-empty">
              <Dual short="–" spoken="No residue income estimate" />
            </p>
            <p class="today-outlook-sub">{unavailableReason(props.residue, "Income from this crop's residue cannot be estimated yet.")}</p>
          </>
        }
      >
        {(option) => (
          <>
            <Show when={income()} fallback={<p class="today-outlook-sub">No reported price for these uses yet</p>}>
              {(range) => (
                <p class="today-outlook-figure">
                  <BasisTip basis="estimate" subject="residue income" note="One possible use · extra income before use-specific costs">
                    <span class="today-outlook-num">
                      <Dual short={compactInrRange(range().low, range().high)} spoken={`${inrRangeText(range().low, range().high)} for the field, as ${option().label}`} />
                    </span>
                  </BasisTip>
                </p>
              )}
            </Show>
            <p class="today-outlook-sub">as {option().label.charAt(0).toLowerCase() + option().label.slice(1)}</p>
          </>
        )}
      </Show>
      <DetailsButton kind="residue" title={title()} onDetails={props.onDetails} />
    </article>
  );
}

// ---------------------------------------------------------------- second band

function PriceTile(props: { view: TodayView; onDetails: (kind: CardKind) => void }) {
  const harvest = () => props.view.harvestPrice;
  const range = () => (harvest()?.status === "available" ? (harvest()?.range ?? null) : null);
  const quote = () => latestQuote(props.view.priceTrack, props.view.today);
  return (
    <article class="today-outlook-tile" data-outlook="price" aria-labelledby="today-outlook-price">
      <h3 id="today-outlook-price">Harvest-week price</h3>
      <Show when={range()} fallback={<p class="today-outlook-line">{priceGapText(harvest()?.reason)}</p>}>
        {(r) => (
          <p class="today-outlook-value">
            <BasisTip basis="sourced" subject="harvest-week price" note="Historical mandi range · not a farm-gate forecast">
              <span>
                <Dual short={shortInrRange(r().low, r().high)} spoken={`${formatInr(r().low)} to ${formatInr(r().high)} per kg`} />
                <small aria-hidden="true"> /kg</small>
              </span>
            </BasisTip>
          </p>
        )}
      </Show>
      <p class="today-outlook-line" data-testid="today-price-quote">
        {quote() ? `Latest quote: week of ${formatDay(quote()!.date, false)}` : "No recorded quote yet"}
      </p>
      <DetailsButton kind="price" title="Harvest-week price" onDetails={props.onDetails} />
    </article>
  );
}

/** Soil values for the tile: pH, nitrogen, organic carbon, phosphorus first (as the report names them), then any other rated value; four at most. */
const SOIL_TILE_ORDER = ["ph", "nitrogen_available", "organic_carbon", "phosphorus_available"] as const;
export function soilTileReadings(readings: readonly SoilReading[], max = 4): SoilReading[] {
  const rated = readings.filter(isRatedReading);
  const picked: SoilReading[] = [];
  for (const parameter of SOIL_TILE_ORDER) {
    const hit = rated.find((r) => r.parameter === parameter);
    if (hit) picked.push(hit);
  }
  for (const r of rated) if (!picked.includes(r)) picked.push(r);
  return picked.slice(0, max);
}

/**
 * The soil tile, from the view's shared soil load: up to four confirmed values with their rating chips and "All soil
 * values"; without a report, the upload call to action in one line (also after "Not now" on the old card, so the tile is
 * never an empty box); loading and failure in one line each.
 */
export function SoilTileView(props: { state: SoilCardState; onUpload: () => void; onRecords: () => void; onRetry: () => void }) {
  const review = () => (props.state.kind === "review" ? props.state.review : null);
  const rows = () => (review() ? soilTileReadings(review()!.readings) : []);
  return (
    <article class="today-outlook-tile" data-outlook="soil" aria-labelledby="today-outlook-soil" data-testid="today-soil">
      <h3 id="today-outlook-soil">Soil for this farm</h3>
      <Switch>
        <Match when={props.state.kind === "loading"}>
          <p class="today-outlook-line" aria-live="polite">
            Loading your soil values…
          </p>
        </Match>
        <Match when={props.state.kind === "failed"}>
          <p class="today-outlook-line" role="alert">
            The soil values could not be loaded.{" "}
            <button type="button" class="today-outlook-link" onClick={() => props.onRetry()}>
              Retry
            </button>
          </p>
        </Match>
        <Match when={review()?.status === "no_report"}>
          <button type="button" class="today-outlook-cta" onClick={() => props.onUpload()}>
            Upload a soil report <Icon name="arrow" size={12} />
          </button>
        </Match>
        <Match when={review()}>
          {(r) => <SoilRows review={r()} rows={rows()} />}
        </Match>
      </Switch>
      <Show when={review() && review()!.status !== "no_report"}>
        <button type="button" class="today-outlook-more" onClick={() => props.onRecords()}>
          All soil values <Icon name="arrow" size={12} />
        </button>
      </Show>
    </article>
  );
}

function SoilRows(props: { review: SoilReview; rows: SoilReading[] }) {
  const provenance = () => sharedProvenance(props.rows, props.review);
  return (
    <Show when={props.rows.length} fallback={<p class="today-outlook-line">None of the confirmed values could be rated against a cited band.</p>}>
      <BasisTip block basis="sourced" subject="soil values" note={provenance() ? `From your confirmed soil report · ${provenance()}` : "From your confirmed soil report; dates differ by value, see All soil values"}>
        <ul class="today-outlook-soil" aria-label="Confirmed soil values">
          <For each={props.rows}>
            {(reading) => (
              <li data-parameter={reading.parameter}>
                <span class="today-outlook-soil-label">
                  {reading.label}
                  <Show when={reading.assumption}>
                    <span aria-label="Assumed form">†</span>
                  </Show>
                </span>
                <span class="today-outlook-soil-value">{valueText(reading)}</span>
                <Chip tone={ratingChipTone(reading.rating)}>{ratingLabel(reading.rating)}</Chip>
              </li>
            )}
          </For>
        </ul>
      </BasisTip>
      <Show when={props.rows.some((reading) => !!reading.assumption)}>
        <p class="today-outlook-line">† Assumed form · see All soil values</p>
      </Show>
    </Show>
  );
}

function FootprintTile(props: { energy: EnergyFootprint | null; carbon: CarbonFootprint | null; residueName: string | null; onDetails: (kind: CardKind) => void }) {
  const used = () => (props.energy && props.energy.status !== "unavailable" ? (props.energy.inputEnergyGJForField ?? props.energy.inputEnergyGJPerHa) : null);
  const usedPerHa = () => !!props.energy && props.energy.inputEnergyGJForField == null && props.energy.inputEnergyGJPerHa != null;
  const held = () => (props.energy && props.energy.status !== "unavailable" ? props.energy.residueEnergyGJForField : null);
  const energyLead = () => used() ?? held();
  const total = () => (props.carbon && props.carbon.status !== "unavailable" ? (props.carbon.emissionsForField ?? props.carbon.emissionsPerHa) : null);
  const carbonPerHa = () => !!props.carbon && props.carbon.emissionsForField == null;
  const energyNote = () =>
    props.energy
      ? `${used() ? "Used to grow this crop" : `Held in the ${props.residueName ?? "residue"}`} · ${energyBasisShort(props.energy.inputEnergyBasis, props.energy.basis)}`
      : "";
  const carbonNote = () => {
    const c = props.carbon;
    if (!c) return "";
    const parts = [`Emitted this season${c.seasonDays != null ? ` (${c.seasonDays} days)` : ""}`];
    parts.push(c.fieldAreaHa != null ? `on ${c.fieldAreaHa.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ha` : "per hectare reference");
    if (c.comparison) parts.push(rankChip(c.comparison).text);
    if (c.comparison?.lowest) parts.push(c.comparison.rank === 1 ? "the lowest here is this crop" : `lowest here: ${c.comparison.lowest.cropName} ${formatCo2e(c.comparison.lowest.tCO2eForField)}`);
    return parts.join(" · ");
  };
  return (
    <article class="today-outlook-tile" data-outlook="footprint" aria-labelledby="today-outlook-footprint">
      <h3 id="today-outlook-footprint">Energy and carbon</h3>
      <dl class="today-outlook-pairs">
        <Show when={props.energy}>
          {(energy) => (
            <div>
              <dt>Energy</dt>
              <dd>
                <Show
                  when={energyLead()}
                  fallback={
                    <>
                      <span>Not available</span>
                      <span class="today-sr">{unavailableReason(energy(), "Energy figures for this crop are not available yet.")}</span>
                    </>
                  }
                >
                  {(lead) => (
                    <BasisTip basis="estimate" subject="energy" note={energyNote()}>
                      <span>
                        <Dual
                          short={`${formatGJ(lead())}${used() && usedPerHa() ? " /ha" : ""}`}
                          spoken={`${formatGJ(lead()).replace("–", " to ").replace(" GJ", " gigajoules")}${used() && usedPerHa() ? " per hectare" : ""}${used() ? " used to grow this crop" : " held in the residue"}`}
                        />
                      </span>
                    </BasisTip>
                  )}
                </Show>
              </dd>
            </div>
          )}
        </Show>
        <Show when={props.carbon}>
          {(carbon) => (
            <div>
              <dt>Carbon</dt>
              <dd>
                <Show when={total()} fallback={<span>Not available</span>}>
                  {(range) => (
                    <BasisTip basis="estimate" subject="carbon" note={carbonNote()}>
                      <span>
                        <Dual
                          short={`${co2eParts(range()).short} ${co2eParts(range()).unit}${carbonPerHa() ? " /ha" : ""}`}
                          spoken={`${spokenCo2e(range())}${carbonPerHa() ? " per hectare" : ""} emitted this season`}
                        />
                      </span>
                    </BasisTip>
                  )}
                </Show>
                <Show when={!total()}>
                  <span class="today-sr">{unavailableReason(carbon(), "A carbon footprint for this crop is not available yet.")}</span>
                </Show>
              </dd>
            </div>
          )}
        </Show>
      </dl>
      <div class="today-outlook-actions">
        <Show when={props.energy}>
          <DetailsButton kind="energy" title="Energy" label="Energy details" onDetails={props.onDetails} />
        </Show>
        <Show when={props.carbon}>
          <DetailsButton kind="carbon" title="Carbon" label="Carbon details" onDetails={props.onDetails} />
        </Show>
      </div>
    </article>
  );
}

export interface TodayOutlookProps {
  view: TodayView;
  /** What the card describes ("North strip · Maize"); shown beside the title. */
  subject?: string | null | undefined;
  onDetails: (kind: CardKind) => void;
  onUpload: () => void;
  onRecords: () => void;
}

/**
 * The card. With a crop: the profit and residue band (each block only when the payload carries it), then the price, soil
 * and energy-and-carbon tiles. Without a crop: only the soil tile, titled for the farm, since nothing is growing to price.
 */
export function TodayOutlook(props: TodayOutlookProps) {
  const soil = useContext(SoilCardContext) ?? createSoilCardController(() => props.view.farmId, () => 0);
  const cycle = () => !!props.view.cycle;
  const econ = () => props.view.harvestEconomics ?? null;
  const residue = () => props.view.residueIncome ?? null;
  const footprint = () => !!(props.view.energyFootprint || props.view.carbonFootprint);
  return (
    <section class="today-map-panel today-outlook" classList={{ "is-soil-only": !cycle() }} aria-labelledby="today-outlook-title" data-testid="today-outlook">
      <div class="today-map-panel-head">
        <h2 id="today-outlook-title">{cycle() ? "Harvest outlook" : "Before you plant"}</h2>
        <Show when={props.subject}>
          <span class="today-map-sub">{props.subject}</span>
        </Show>
      </div>
      <Show when={cycle() && (econ() || residue())}>
        <div class="today-outlook-top">
          <Show when={econ()}>{(e) => <ProfitLead econ={e()} onDetails={props.onDetails} />}</Show>
          <Show when={residue()}>{(r) => <ResidueLead residue={r()} onDetails={props.onDetails} />}</Show>
        </div>
      </Show>
      <div class="today-outlook-tiles">
        <Show when={cycle()}>
          <PriceTile view={props.view} onDetails={props.onDetails} />
        </Show>
        <SoilTileView state={soil.state()} onUpload={props.onUpload} onRecords={props.onRecords} onRetry={soil.retry} />
        <Show when={cycle() && footprint()}>
          <FootprintTile
            energy={props.view.energyFootprint ?? null}
            carbon={props.view.carbonFootprint ?? null}
            residueName={props.view.residueIncome?.residueName ?? null}
            onDetails={props.onDetails}
          />
        </Show>
      </div>
    </section>
  );
}
