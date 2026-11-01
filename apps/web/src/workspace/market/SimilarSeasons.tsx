import { For, Show } from "solid-js";
import type { MarketAnalogues } from "@harvest/contracts";
import { formatDate, formatPct, formatRain } from "./model";
import { OVERLAY_DASHES } from "./MarketChart";

export const SIMILAR_SEASONS_NOTE = "Past years whose monsoon rain was closest to this one; how prices moved then, not a forecast.";

/**
 * "Years with similar rain" (ROUND2_SPEC 3.2): each past crop year with its June to September rain, similarity as a
 * short bar, the price change from the current crop's sowing week to its harvest week in that year, and a toggle that
 * draws that year's weekly path on the chart. A selection of history, never a forecast.
 */
export function SimilarSeasons(props: { analogues: MarketAnalogues; shown: ReadonlySet<string>; onToggle: (cropYear: string) => void }) {
  const season = () => props.analogues.thisSeason;
  return (
    <section class="market-similar" aria-labelledby="market-similar-title">
      <h3 id="market-similar-title">Years with similar rain</h3>
      <p class="market-similar-note">{SIMILAR_SEASONS_NOTE}</p>
      <Show when={season()}>
        {(s) => (
          <p class="market-similar-season">
            This season ({s().cropYear}):{" "}
            <Show when={s().rainMm !== null} fallback={<>June to September rain not known yet</>}>
              {formatRain(s().rainMm)} from 1 June to 30 September
              <Show when={(s().typicalRemainderMm ?? 0) > 0 && s().observedThrough}>
                {(_) => <> (observed to {formatDate(s().observedThrough!, false)}, typical after)</>}
              </Show>
            </Show>
          </p>
        )}
      </Show>
      <Show
        when={props.analogues.status === "available" && props.analogues.years.length}
        fallback={<p class="market-similar-empty" data-testid="market-similar-insufficient">{props.analogues.reason ?? "Not enough past years with both rain and prices."}</p>}
      >
        <ul class="market-similar-list">
          <For each={props.analogues.years}>
            {(y, i) => {
              const on = () => props.shown.has(y.cropYear);
              return (
                <li class="market-similar-row" data-crop-year={y.cropYear}>
                  <span class="market-similar-year">{y.cropYear}</span>
                  <span class="market-similar-rain">{formatRain(y.rainMm)}</span>
                  <span class="market-similar-bar" role="img" aria-label={`Similarity ${Math.round(y.similarity * 100)} percent`}>
                    <span style={{ width: `${Math.round(y.similarity * 100)}%` }} />
                  </span>
                  <span class="market-similar-change">
                    {y.harvestChangePct === null ? "–" : `${formatPct(y.harvestChangePct)} sowing to harvest`}
                  </span>
                  <button
                    type="button"
                    class="market-similar-toggle"
                    aria-pressed={on()}
                    disabled={!y.pricePath.length}
                    onClick={() => props.onToggle(y.cropYear)}
                    aria-label={`${on() ? "Hide" : "Show"} the ${y.cropYear} price path on the chart`}
                  >
                    <svg width="22" height="8" aria-hidden="true">
                      <line x1="1" y1="4" x2="21" y2="4" stroke-dasharray={OVERLAY_DASHES[i() % OVERLAY_DASHES.length]} />
                    </svg>
                    {on() ? "Shown" : "Show"}
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}
