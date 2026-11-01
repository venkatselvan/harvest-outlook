import { Show } from "solid-js";
import type { NumberEstimate } from "@harvest/contracts";
import { formatAreaHa, formatInrBand, formatInrFull } from "./format";

/** The one-line key to the two bands, shown wherever central, likely and possible values appear. */
export const BAND_EXPLANATION = "Likely = middle half of the simulated outcomes; possible = 10th to 90th percentile";

/** Heading for the field block: "For your 0.16 ha", or "For your field" when the area is not given. */
export const fieldBlockTitle = (areaHa: number | null | undefined) =>
  areaHa != null && areaHa > 0 ? `For your ${formatAreaHa(areaHa)} ha` : "For your field";

/** Plain-language reading of an estimate, used as the accessible name of the block. */
export const estimateSummary = (e: NumberEstimate) =>
  `central ${formatInrFull(e.central)}, likely ${formatInrBand(e.likely)}, possible ${formatInrBand(e.possible)}`;

/**
 * Central value, likely band (p25 to p75) and possible band (p10 to p90) of one profit estimate, in full rupees.
 * One block per scope: per hectare, and for the field when the area is known.
 */
export function EstimateBlock(props: { title: string; estimate: NumberEstimate }) {
  return (
    <div class="yp-band" role="group" aria-label={`${props.title}: ${estimateSummary(props.estimate)}`}>
      <p class="yp-band-title">{props.title}</p>
      <ul class="yp-band-rows">
        <li>
          <span class="yp-band-key">Central</span>
          <strong class="yp-band-val">{formatInrFull(props.estimate.central)}</strong>
        </li>
        <li>
          <span class="yp-band-key">Likely</span>
          <span class="yp-band-val">{formatInrBand(props.estimate.likely)}</span>
        </li>
        <li>
          <span class="yp-band-key">Possible</span>
          <span class="yp-band-val">{formatInrBand(props.estimate.possible)}</span>
        </li>
      </ul>
    </div>
  );
}

/** Per-hectare and field blocks side by side (stacked on phones), followed by the one-line key. */
export function EstimateBlocks(props: {
  perHa: NumberEstimate;
  forField?: NumberEstimate | null | undefined;
  areaHa?: number | null | undefined;
}) {
  return (
    <>
      <div class="yp-bands">
        <EstimateBlock title="Per hectare" estimate={props.perHa} />
        <Show when={props.forField}>{(f) => <EstimateBlock title={fieldBlockTitle(props.areaHa)} estimate={f()} />}</Show>
      </div>
      <span class="yp-basis">{BAND_EXPLANATION}</span>
    </>
  );
}
