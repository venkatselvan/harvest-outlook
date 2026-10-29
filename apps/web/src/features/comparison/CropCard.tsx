import { For, Show } from "solid-js";
import { OutcomeBadge, StateBadge } from "./badges";
import { EvidenceDetails } from "./EvidenceDetails";
import { OUTCOME_HELP, dimensionState, fieldLabel, humanize, monthRange, priceLabel, yieldBasisLabel } from "./logic";
import type { CompareItem, ScenarioRow } from "./types";

type Harvest = { earliest: string; latest: string; plantingDate: string; plantingDateBasis: string; repeatedPicking: boolean | null };
type Time = { minDays: number; maxDays: number | null };
type Water = { fit: string; waterNeedClass?: string; sourceContextIrrigation?: string };
type Econ = { scenarios: ScenarioRow[]; netReturn: string; assumptions: string[]; missingInputs: string[] };

const WATER_TEXT: Record<string, string> = { matches: "matches your water access", partial: "partly matches your water access", mismatch: "does not match your water access" };
const SCENARIO_NAME: Record<string, string> = { low: "Low", central: "Central", high: "High", yield_shortfall_price_rise: "Yield shortfall with price rise" };

function Row(props: { label: string; testid?: string; children: unknown; badge?: unknown }) {
  return (
    <div class="cmp-row" data-testid={props.testid}>
      <dt>{props.label}</dt>
      <dd>
        {props.children as never}
        {props.badge ? <> {props.badge as never}</> : null}
      </dd>
    </div>
  );
}

export interface CropCardProps {
  item: CompareItem;
  assumedPriceUsed?: boolean;
  onChoose?: (item: CompareItem) => void;
  onRemove?: (item: CompareItem) => void;
}

/** One crop-product card per PRD 6.2. Renders API fields only; nothing here computes agronomy or economics. */
export function CropCard(props: CropCardProps) {
  const it = () => props.item;
  const dims = () => it().dimensions;
  const harvest = () => (dims().harvestWindows.status === "known" ? (dims().harvestWindows.value as Harvest) : null);
  const time = () => (dims().timeToFirstIncome.status === "known" ? (dims().timeToFirstIncome.value as Time) : null);
  const water = () => (dims().waterFit.status === "known" ? (dims().waterFit.value as Water) : null);
  const econ = () => (dims().economics.status === "known" ? (dims().economics.value as Econ) : null);
  return (
    <article class="cmp-card" aria-labelledby={`card-${it().productId}`} data-testid="crop-card" data-product={it().productId}>
      <header>
        <h3 id={`card-${it().productId}`}>{it().cropName}: {it().productName}</h3>
        <Show when={it().localNames.length}><p class="cmp-muted">Local names: {it().localNames.join(", ")}</p></Show>
        <p>
          <OutcomeBadge outcome={it().outcome} />
        </p>
        <p class="cmp-muted">{OUTCOME_HELP[it().outcome]}</p>
      </header>
      <dl class="cmp-dl">
        <Row label="Season" badge={<StateBadge state={it().season ? "reference" : "unavailable"} />}>
          {it().season ? humanize(it().season!) : it().referenceContexts.length ? `No sourced season for your region. Sourced elsewhere: ${[...new Set(it().referenceContexts.map((c) => humanize(c.season)))].join(", ")}` : "Not stated"}
        </Row>
        <Row label="Planting window" testid="planting-window" badge={<StateBadge state={it().plantingWindow ? "reference" : "unavailable"} />}>
          {it().plantingWindow ? `${monthRange(it().plantingWindow!.fromMonth, it().plantingWindow!.toMonth)}${it().context && !it().context!.plantingMonthInWindow ? " (your planting month is outside it)" : ""}` : "Not available for your region"}
        </Row>
        <Row label="Harvest window" testid="harvest-window" badge={<StateBadge state={dimensionState("harvestWindows", dims().harvestWindows)} />}>
          <Show when={harvest()} fallback={<>Not available ({humanize(dims().harvestWindows.missingReason ?? "unknown")})</>}>
            {(h) => (
              <>
                Opens {h().earliest}; may continue after {h().latest}.
                {h().repeatedPicking ? " Repeated picking: harvest is spread over several pickings." : h().repeatedPicking === false ? " Single harvest pattern." : " Picking pattern not stated."}
                {h().plantingDateBasis === "first_of_month_assumed" ? ` Assumes planting on ${h().plantingDate} (1st of your month); add an exact date to refine.` : ` Uses your planting date ${h().plantingDate}.`}
              </>
            )}
          </Show>
        </Row>
        <Row label="Time to harvest" badge={<StateBadge state={dimensionState("timeToFirstIncome", dims().timeToFirstIncome)} />}>
          <Show when={time()} fallback={<>Not available ({humanize(dims().timeToFirstIncome.missingReason ?? "unknown")})</>}>
            {(t) => <>{t().minDays} to {t().maxDays ?? "unstated"} days from planting</>}
          </Show>
        </Row>
        <Row label="Water fit" badge={<StateBadge state={dimensionState("waterFit", dims().waterFit)} />}>
          <Show when={water()} fallback={<>Not available ({humanize(dims().waterFit.missingReason ?? "unknown")})</>}>
            {(w) => <>{WATER_TEXT[w().fit] ?? humanize(w().fit)}</>}
          </Show>
        </Row>
        <Row label="Price reference" testid="price-reference" badge={<StateBadge state="unavailable" />}>{priceLabel(it())}</Row>
        <Row label="Yield basis" testid="yield-basis" badge={<StateBadge state={it().yieldReference?.appliesToProduct ? "reference" : "unavailable"} />}>
          <Show when={it().yieldReference} fallback={<>No sourced yield reference for this product and region</>}>
            {(y) => (
              <Show when={y().appliesToProduct} fallback={<>Yield reference exists for {y().productId}, not applied to this product.</>}>
                {y().minKgPerHa} to {y().maxKgPerHa} kg/ha. Basis: {yieldBasisLabel(it())}. {y().label}.
              </Show>
            )}
          </Show>
        </Row>
        <Row label="Cost basis" testid="cost-basis" badge={<StateBadge state="unavailable" />}>{it().costBasis.label}</Row>
        <Show when={econ()}>
          {(e) => (
            <Row label="Gross harvest value per ha" testid="economics" badge={<><StateBadge state="scenario" /> {props.assumedPriceUsed ? <StateBadge state="farmer_assumption" /> : null}</>}>
              <ul class="cmp-list">
                <For each={e().scenarios}>{(s) => <li>{SCENARIO_NAME[s.name] ?? humanize(s.name)}: INR {s.grossHarvestValueInrPerHa} per ha ({s.marketableKgPerHa} kg/ha)</li>}</For>
              </ul>
              <p class="cmp-muted">Net return is not shown: {e().missingInputs.length ? `no sourced ${e().missingInputs.map((m) => humanize(m.replace(/^costs\./, "")).toLowerCase()).join(", ")} cost` : "costs unavailable"}. Scenario values are bounding cases, not forecasts.</p>
              <details class="cmp-details"><summary>Assumptions</summary><ul class="cmp-list"><For each={e().assumptions}>{(a) => <li>{a}</li>}</For></ul></details>
            </Row>
          )}
        </Show>
        <Row label="Main downside" testid="downside" badge={it().downside.computable ? <StateBadge state="scenario" /> : <StateBadge state="unavailable" />}>{it().downside.text || "Not available"}</Row>
        <Row label="Most consequential missing input" testid="missing-input">
          <Show when={it().mostConsequentialMissingInput} fallback={<>None identified</>}>
            {(m) => <><strong>{fieldLabel(m().field)}.</strong> {m().why}</>}
          </Show>
        </Row>
        <Row label="Evidence coverage" testid="coverage">
          {it().completeness.known}/{it().completeness.total} dimensions have a known value. Unknown dimensions are not scored as zero.
        </Row>
      </dl>

      <section aria-label="Fit reasons and open conditions" class="cmp-reasons">
        <h4>Fit reasons, exclusions and open conditions</h4>
        <Show when={it().screening.reasons.length} fallback={<p class="cmp-muted">No sourced rule applied for your location and season. That is a gap in evidence, not a finding that the crop cannot be grown.</p>}>
          <ul class="cmp-list">
            <For each={it().screening.reasons}>
              {(r) => (
                <li>
                  <strong>{r.effect === "eligible" ? "Fits" : r.effect === "ineligible" ? "Excluded" : r.effect === "requires_review" ? "Needs review" : humanize(r.effect)}:</strong> {r.reasonCodes.map(humanize).join(", ") || "no reason code"}
                  {r.reviewStatus !== "approved" ? ` (${r.reviewStatus === "synthetic" ? "synthetic candidate rule, unreviewed" : r.reviewStatus})` : ""}
                  {r.appliedExceptionId ? " (regional exception applied)" : ""}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={it().screening.unknownFields.length}>
          <p>Unresolved: {[...new Set(it().screening.unknownFields)].map(fieldLabel).join(", ")}.</p>
        </Show>
        <Show when={it().screening.candidateRuleIds.length}>
          <p class="cmp-muted">{it().screening.candidateRuleIds.length} rule(s) used here are unreviewed candidates (synthetic mode only).</p>
        </Show>
      </section>

      <EvidenceDetails item={it()} />

      <footer class="cmp-actions">
        <Show when={props.onChoose}>
          <button type="button" class="btn" onClick={() => props.onChoose!(it())}>Choose this crop</button>
        </Show>
        <Show when={props.onRemove}>
          <button type="button" class="btn cmp-secondary" onClick={() => props.onRemove!(it())}>Remove from comparison</button>
        </Show>
      </footer>
    </article>
  );
}
