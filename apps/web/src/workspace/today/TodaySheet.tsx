import { For, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type {
  BasisRef,
  CarbonFootprint,
  CarbonTerm,
  EnergyFootprint,
  HarvestEconomics,
  IndexStageReading,
  NdviReading,
  NumberEstimate,
  NumberRange,
  PricePoint,
  ResidueIncome,
  TodayView,
  WeatherPoint,
} from "@harvest/contracts";
import { Icon } from "../icons";
import {
  carbonTermNote,
  co2eParts,
  costValue,
  curveAgreementWords,
  curveLine,
  curvePhaseText,
  curveShortfall,
  equivalentAmount,
  formatCo2e,
  formatDay,
  formatGJ,
  formatIndex,
  formatInr,
  formatTonnesRange,
  INDEX_INFO,
  INDEX_ORDER,
  indexCode,
  inrRangeText,
  orderResidueOptions,
  priceTrend,
  rangeLabel,
  rangeText,
  rankChip,
  residueTitle,
  RESIDUE_SHEET_ALTERNATIVES,
  spokenInr,
  unavailableReason,
  words,
  yieldBasisWords,
} from "./model";
import { agroKindNote, AGRO_LABEL, priceGapText, trendText, weatherAgroFacts, weatherBasis, weatherKindLabel, healthHeadline, type CardKind } from "./TodayCards";

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


// ---------------------------------------------------------------- economics and footprint sheets (TODAY_ECONOMICS_FOOTPRINT_SPEC section 6)

type Row = readonly [label: string, value: string | null | undefined];
/** Label and value pairs. Rows without a value are left out, never shown as zero. */
function Facts(props: { rows: readonly Row[]; testid?: string }) {
  const rows = () => props.rows.filter((row): row is readonly [string, string] => !!row[1]);
  return (
    <dl class="today-econ-facts" data-testid={props.testid}>
      <For each={rows()}>
        {([label, value]) => (
          <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}
function BasisList(props: { basis: readonly BasisRef[] }) {
  return (
    <Show when={props.basis.length}>
      <div class="today-econ-basis" data-testid="today-econ-basis">
        <For each={props.basis}>{(basis) => <Basis basis={basis} />}</For>
      </div>
    </Show>
  );
}
function LimitList(props: { limitations: readonly string[] }) {
  return (
    <Show when={props.limitations.length}>
      <section class="today-econ-limits" data-testid="today-econ-limits">
        <h3>What this does not tell you</h3>
        <ul class="today-curve-limits">
          <For each={props.limitations}>{(line) => <li>{line}</li>}</For>
        </ul>
      </section>
    </Show>
  );
}
const inrBand = (low: number, high: number) => inrRangeText(low, high);
/** "central ₹x, likely ₹a to ₹b, possible ₹c to ₹d" for a simulated estimate, in full rupees. */
const estimateText = (e: NumberEstimate, suffix = "") =>
  `${spokenInr(e.central)}${suffix} (likely ${inrBand(e.likely.low, e.likely.high)}; possible ${inrBand(e.possible.low, e.possible.high)})`;
const kgText = (range: NumberRange) => `${rangeText(range, 0)} kg`;
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function ProfitSheetBody(props: { econ: HarvestEconomics | null | undefined }) {
  return (
    <Show when={props.econ} fallback={<p>No profit estimate was returned for this field.</p>}>
      {(econ) => {
        const cost = () => econ().cost;
        return (
          <>
            <Show
              when={econ().status !== "unavailable"}
              fallback={<p data-testid="today-econ-reason">{unavailableReason(econ(), "Profit at harvest cannot be estimated for this crop yet.")}</p>}
            >
              <p>
                <Show when={econ().harvestDate} fallback="Profit at the harvest date">
                  Profit at harvest around {formatDay(econ().harvestDate)}
                </Show>
                : yield times price, less the cost of growing, for the whole field and for one hectare.
                <Show when={econ().status === "partial"}> Part of the inputs is missing, so this is an incomplete estimate.</Show>
              </p>
              <Facts
                testid="today-profit-facts"
                rows={[
                  ["Harvest window", econ().harvest ? rangeLabel(econ().harvest!.earliest, econ().harvest!.latest) : null],
                  ["Field area", econ().fieldAreaHa != null ? `${econ().fieldAreaHa!.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ha` : "not known, so figures are per hectare"],
                  [
                    "Yield per hectare",
                    econ().yieldKgPerHa ? `${kgText(econ().yieldKgPerHa!)}/ha${econ().yieldBasis ? ` (${yieldBasisWords[econ().yieldBasis!]})` : ""}` : null,
                  ],
                  ["Yield for the field", econ().yieldForFieldKg ? `${kgText(econ().yieldForFieldKg!)} (${formatTonnesRange(econ().yieldForFieldKg!)})` : null],
                  ["Kept after post-harvest loss", econ().keepFraction < 1 ? percent(econ().keepFraction) : "No post-harvest loss share is sourced for this crop"],
                  [
                    "Price at harvest",
                    econ().price?.likely
                      ? `${formatInr(econ().price!.likely!.low)} to ${formatInr(econ().price!.likely!.high)} per kg${econ().price!.p50 != null ? `, middle ${formatInr(econ().price!.p50!)}` : ""}`
                      : null,
                  ],
                  ["Price source", econ().price?.scopeLabel],
                  ["Cost per hectare (A2+FL)", cost()?.a2flPerHa != null ? `${formatInr(cost()!.a2flPerHa!)}` : null],
                  ["Cost per hectare (C2)", cost()?.c2PerHa != null ? `${formatInr(cost()!.c2PerHa!)}` : null],
                  ["Cost source", cost() && (cost()!.authority || cost()!.year || cost()!.region) ? [cost()!.authority?.toUpperCase(), cost()!.region, cost()!.year].filter(Boolean).join(" · ") : null],
                  ["Cost used", costValue(econ()) ? `${costValue(econ())!.label}, ${formatInr(costValue(econ())!.value)}${costValue(econ())!.scope === "ha" ? " per hectare" : " for the field"}` : "not sourced"],
                  ["Revenue per hectare", econ().revenuePerHa ? estimateText(econ().revenuePerHa!) : null],
                  ["Revenue for the field", econ().revenueForField ? estimateText(econ().revenueForField!) : null],
                  ["Profit per hectare", econ().profitPerHa ? estimateText(econ().profitPerHa!) : "not computed"],
                  ["Profit for the field", econ().profitForField ? estimateText(econ().profitForField!) : econ().fieldAreaHa == null ? "needs the field area" : "not computed"],
                ]}
              />
              <p class="today-sheet-small">
                Likely is the middle half of simulated outcomes; possible is the 10th to 90th percentile. Prices are past
                harvest-week mandi prices, so this is an estimate from regional references, not a forecast and not a
                promised sale.
              </p>
            </Show>
            <BasisList basis={econ().basis} />
            <LimitList limitations={econ().limitations} />
          </>
        );
      }}
    </Show>
  );
}

export function ResidueSheetBody(props: { residue: ResidueIncome | null | undefined }) {
  return (
    <Show when={props.residue} fallback={<p>No residue income estimate was returned for this field.</p>}>
      {(residue) => {
        const options = () => orderResidueOptions(residue().options);
        return (
          <>
            <Show
              when={residue().status === "available"}
              fallback={<p data-testid="today-econ-reason">{unavailableReason(residue(), "Income from this crop's residue cannot be estimated yet.")}</p>}
            >
              <Facts
                testid="today-residue-facts"
                rows={[
                  ["Residue", residue().residueName],
                  [
                    "Residue per kg of product",
                    residue().residueToProductRatio ? `${rangeText(residue().residueToProductRatio!, 2, true)} kg dry residue (published ratio)` : null,
                  ],
                  ["Residue from the field", residue().residueForFieldKg ? `${formatTonnesRange(residue().residueForFieldKg!)} dry` : null],
                  [
                    "Share that is surplus",
                    residue().surplusFraction
                      ? `${rangeText({ low: residue().surplusFraction!.low * 100, high: residue().surplusFraction!.high * 100 }, 0)}% after on-farm uses`
                      : "Not published: the whole residue is shown",
                  ],
                  ["Surplus from the field", residue().surplusForFieldKg ? `${formatTonnesRange(residue().surplusForFieldKg!)} dry` : null],
                ]}
              />
              <p class="today-residue-alternatives" data-testid="today-residue-alternatives">
                <strong>{RESIDUE_SHEET_ALTERNATIVES}</strong>
              </p>
              <ol class="today-residue-list" data-testid="today-residue-options">
                <For each={options()}>
                  {(option) => (
                    <li class="today-residue-option" data-use={option.use}>
                      <h3>{option.label}</h3>
                      <Facts
                        rows={[
                          ["Could take", formatTonnesRange(option.quantityKg)],
                          [
                            "Reported price",
                            option.priceInrPerTonne
                              ? `${inrRangeText(option.priceInrPerTonne.low, option.priceInrPerTonne.high)} per tonne${option.priceBasis ? `, ${option.priceBasis}` : ""}`
                              : "no price sourced",
                          ],
                          [
                            "Income for the field",
                            option.incomeForField ? inrRangeText(option.incomeForField.low, option.incomeForField.high) : "not estimated without a price",
                          ],
                        ]}
                      />
                      <Show when={option.note}>
                        <p class="today-sheet-small">{option.note}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <BasisList basis={residue().basis} />
            <LimitList limitations={residue().limitations} />
          </>
        );
      }}
    </Show>
  );
}

export function EnergySheetBody(props: { energy: EnergyFootprint | null | undefined }) {
  return (
    <Show when={props.energy} fallback={<p>No energy estimate was returned for this field.</p>}>
      {(energy) => (
        <>
          <Show
            when={energy().status !== "unavailable"}
            fallback={<p data-testid="today-econ-reason">{unavailableReason(energy(), "Energy figures for this crop are not available yet.")}</p>}
          >
            <Facts
              testid="today-energy-facts"
              rows={[
                ["Energy used to grow the crop, per hectare", energy().inputEnergyGJPerHa ? formatGJ(energy().inputEnergyGJPerHa!) : null],
                ["Energy used to grow the crop, for the field", energy().inputEnergyGJForField ? formatGJ(energy().inputEnergyGJForField!) : null],
                ["Where that figure comes from", energy().inputEnergyBasis],
                [
                  "Calorific value of the dry residue",
                  energy().calorificValueMJPerKg ? `${rangeText(energy().calorificValueMJPerKg!, 1)} MJ per kg` : null,
                ],
                ["Energy held in the surplus residue", energy().residueEnergyGJForField ? formatGJ(energy().residueEnergyGJForField!) : null],
              ]}
            />
            <Show when={energy().inputBreakdown.length}>
              <section>
                <h3>Where the energy to grow the crop goes</h3>
                <ul class="today-energy-breakdown" data-testid="today-energy-breakdown">
                  <For each={[...energy().inputBreakdown].sort((a, b) => b.share - a.share)}>
                    {(item) => (
                      <li>
                        {item.item}: {percent(item.share)}
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <Show when={energy().equivalents.length}>
              <section>
                <h3>The residue energy in other terms</h3>
                <ul class="today-energy-equivalents" data-testid="today-energy-equivalents">
                  <For each={energy().equivalents}>
                    {(eq) => (
                      <li>
                        {eq.label}: about {equivalentAmount(eq)}
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <p class="today-sheet-small">
              The two figures answer different questions: what it takes to grow the crop, and what the surplus residue
              holds. They are not netted against each other and say nothing about whether the crop is worth growing.
            </p>
          </Show>
          <BasisList basis={energy().basis} />
          <LimitList limitations={energy().limitations} />
        </>
      )}
    </Show>
  );
}

/**
 * A term's figure. A term that carries a note (see `carbonTermNote`) gets the "kept out of the air" suffix only when the note
 * is that one; the informational residue-carbon note is printed once, as its own row, not after every figure.
 */
const termFigure = (range: NumberRange, term: CarbonTerm) => {
  const note = carbonTermNote(term);
  return note && note.startsWith("carbon kept out") ? `${formatCo2e(range)} (${note})` : formatCo2e(range);
};

/** A term's field figure, or the plain statement that only the per-hectare figure exists (the field area is not known). */
const termField = (term: CarbonTerm) => (term.tCO2eForField ? termFigure(term.tCO2eForField, term) : "per hectare only (field area not known)");
/** The extra row for the informational residue-carbon term. */
const termNoteRows = (term: CarbonTerm): [string, string][] => (term.source === "residue_carbon" ? [["What this figure is", carbonTermNote(term)!]] : []);

export function CarbonSheetBody(props: { carbon: CarbonFootprint | null | undefined }) {
  return (
    <Show when={props.carbon} fallback={<p>No carbon footprint estimate was returned for this field.</p>}>
      {(carbon) => {
        const baseline = () => carbon().terms.filter((term) => term.kind === "baseline");
        const scenarioTerms = () => carbon().terms.filter((term) => term.kind === "scenario");
        return (
          <>
            <Show
              when={carbon().status !== "unavailable"}
              fallback={<p data-testid="today-econ-reason">{unavailableReason(carbon(), "A carbon footprint for this crop is not available yet.")}</p>}
            >
              <Show when={carbon().summary}>
                <p data-testid="today-carbon-summary">{carbon().summary}</p>
              </Show>
              <Facts
                testid="today-carbon-facts"
                rows={[
                  ["Emitted this season, for the field", carbon().emissionsForField ? formatCo2e(carbon().emissionsForField!) : null],
                  ["Emitted this season, per hectare", carbon().emissionsPerHa ? formatCo2e(carbon().emissionsPerHa!) : null],
                  ["Field area", carbon().fieldAreaHa != null ? `${carbon().fieldAreaHa!.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ha` : null],
                  ["Season length used", carbon().seasonDays != null ? `${carbon().seasonDays} days` : null],
                  ["Rank among crops here", carbon().comparison ? `${rankChip(carbon().comparison!).text} (1 is the lowest emissions per hectare)` : null],
                  [
                    "Lowest here",
                    carbon().comparison?.lowest ? `${carbon().comparison!.lowest!.cropName}, ${formatCo2e(carbon().comparison!.lowest!.tCO2eForField)}` : null,
                  ],
                  [
                    "Highest here",
                    carbon().comparison?.highest ? `${carbon().comparison!.highest!.cropName}, ${formatCo2e(carbon().comparison!.highest!.tCO2eForField)}` : null,
                  ],
                ]}
              />
              <Show when={baseline().length}>
                <section>
                  <h3>What the emissions are made of</h3>
                  <ul class="today-carbon-terms" data-testid="today-carbon-terms">
                    <For each={baseline()}>
                      {(term) => (
                        <li class="today-carbon-term" data-source={term.source}>
                          <h4>{term.label}</h4>
                          <Facts
                            rows={[
                              ["For the field", termField(term)],
                              ["Per hectare", termFigure(term.tCO2ePerHa, term)],
                              ...termNoteRows(term),
                              ["How it is worked out", term.method],
                            ]}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
              <Show when={carbon().residueScenarios.length}>
                <section>
                  <h3>What happens to the residue</h3>
                  <p class="today-sheet-small">
                    These are alternatives for the same residue, not added together. Each total is the emissions above
                    plus that choice.
                  </p>
                  <ul class="today-carbon-scenarios" data-testid="today-carbon-scenarios">
                    <For each={carbon().residueScenarios}>
                      {(scenario) => (
                        <li class="today-carbon-scenario" data-scenario={scenario.id}>
                          <h4>{scenario.label}</h4>
                          <Facts rows={[["Net for the field", formatCo2e(scenario.netForField)]]} />
                          <p class="today-sheet-small">{scenario.note}</p>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={scenarioTerms().length}>
                    <ul class="today-carbon-terms" data-testid="today-carbon-scenario-terms">
                      <For each={scenarioTerms()}>
                        {(term) => (
                          <li class="today-carbon-term" data-source={term.source}>
                            <h4>{term.label}</h4>
                            <Facts rows={[["For the field", termField(term)], ["Per hectare", termFigure(term.tCO2ePerHa, term)], ...termNoteRows(term), ["How it is worked out", term.method]]} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>
              </Show>
              <Show when={carbon().gwp}>
                {(gwp) => (
                  <p class="today-sheet-small" data-testid="today-carbon-gwp">
                    Global warming potentials (100-year): methane {gwp().ch4}, nitrous oxide {gwp().n2o}. {gwp().basis}
                  </p>
                )}
              </Show>
            </Show>
            <BasisList basis={carbon().basis} />
            <LimitList limitations={carbon().limitations} />
          </>
        );
      }}
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

/** Dialog title of a sheet kind: the card's own title, so the sheet and the card it opened from agree. */
export function sheetTitle(kind: SheetKind, view: Pick<TodayView, "residueIncome">, date: string): string {
  return {
      harvest: "Harvest window",
      price: "Harvest-week price",
      weather: `Weather on ${formatDay(date)}`,
      health: "Crop condition",
      profit: "Expected profit at harvest",
      residue: residueTitle(view.residueIncome?.residueName),
      energy: "Energy",
      carbon: "Carbon",
      about: "About this view",
      curve: "Satellite curve and the calendar",
    }[kind];
}

export function TodaySheet(props: TodaySheetProps) {
  const title = () => sheetTitle(props.kind, props.view, props.date);
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
          <Show when={weatherAgroFacts(props.weather).length}>
            <p data-testid="today-agro-detail">
              {weatherAgroFacts(props.weather)
                .map((fact) => fact.spoken)
                .join("; ")}
              . {AGRO_LABEL} ({agroKindNote(props.weather!)}). Weather data by Open-Meteo.com.
            </p>
          </Show>
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
                NDVI {health().ndviMean.toFixed(2)} on {formatDay(health().date)} · {healthHeadline(health())}
                <Show when={health().typicalRange}>
                  {" "}
                  (typical for this stage {health().typicalRange!.low.toFixed(2)} to {health().typicalRange!.high.toFixed(2)})
                </Show>
              </p>
              <Show when={health().neighbourhoodMean != null}>
                <p>Surrounding land within about 1 km: {health().neighbourhoodMean!.toFixed(2)}</p>
              </Show>
              <p>Clear pixels in the field: {Math.round(health().clearFraction * 100)}%</p>
              <Show when={props.view.ndvi?.smallField}>
                <p>This field covers few satellite pixels; the surrounding-land value is a reference; it may include other vegetation.</p>
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
      <Show when={props.kind === "profit"}>
        <ProfitSheetBody econ={props.view.harvestEconomics} />
      </Show>
      <Show when={props.kind === "residue"}>
        <ResidueSheetBody residue={props.view.residueIncome} />
      </Show>
      <Show when={props.kind === "energy"}>
        <EnergySheetBody energy={props.view.energyFootprint} />
      </Show>
      <Show when={props.kind === "carbon"}>
        <CarbonSheetBody carbon={props.view.carbonFootprint} />
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
