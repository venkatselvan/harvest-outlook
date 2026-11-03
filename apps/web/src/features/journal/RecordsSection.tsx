import { For, Show } from "solid-js";
import { formatKg } from "./model";
import { formatDecimal, type CycleRecords } from "./records";
import "./records.css";

/** The regional yield range for a cycle's field (the Today view's `economics.yieldForFieldKg`); district statistics, not the farmer's field. */
export interface YieldBand {
  low: number;
  high: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const qty = (q: { value: number; unit: string }) => `${q.value.toLocaleString("en-IN", { maximumFractionDigits: 4 })} ${q.unit}`;
const bandText = (b: YieldBand) => {
  const n = (v: number) => Math.round(v).toLocaleString("en-IN");
  return b.low === b.high ? `${n(b.low)} kg` : `${n(b.low)} to ${n(b.high)} kg`;
};

/**
 * "Harvest and inputs": per crop cycle, the harvest pickings with a running total, stock on hand, water applied and fertiliser
 * applications, all summed in code from the farmer's own journal entries (see records.ts). `dateLabel` and `cropName` are passed
 * in so this stays free of workspace state. `yieldBands` is keyed by cycle id and is optional: the line appears only for a
 * cycle that has a band.
 */
export function RecordsSection(props: {
  records: readonly CycleRecords[];
  dateLabel: (isoDate: string) => string;
  cropName: (cropId: string) => string;
  yieldBands?: Readonly<Record<string, YieldBand | null | undefined>>;
}) {
  return (
    <section class="records-section" aria-labelledby="records-title">
      <div class="records-heading">
        <h2 id="records-title">Harvest and inputs</h2>
      </div>
      <div class="records-grid">
        <For each={props.records}>
          {(r) => {
            const name = () => r.cropName ?? props.cropName(r.cropId);
            const band = () => props.yieldBands?.[r.cycleId] ?? null;
            const hasAny = () => r.harvest.pickings.length > 0 || r.harvest.unitsSkipped > 0 || r.water.events > 0 || r.fertiliser.length > 0;
            return (
              <article class="records-card" data-testid="records-card" aria-label={`Harvest and inputs for ${name()}`}>
                <h3>{name()}</h3>
                <Show when={!hasAny()}>
                  <p class="records-empty">No harvest, water or fertiliser entries in this crop's dates yet.</p>
                </Show>

                <Show when={r.harvest.pickings.length > 0 || r.harvest.unitsSkipped > 0}>
                  <section class="records-block" aria-labelledby={`rec-h-${r.cycleId}`}>
                    <h4 id={`rec-h-${r.cycleId}`}>
                      Harvest pickings
                      <Show when={r.harvest.totalKg !== null}>
                        <span class="records-total"> · {formatKg(r.harvest.totalKg!)} total</span>
                      </Show>
                    </h4>
                    <Show when={r.harvest.pickings.length > 0}>
                      <ul class="records-list" data-testid="records-pickings">
                        <For each={r.harvest.pickings}>
                          {(p) => (
                            <li>
                              <span class="records-date">{props.dateLabel(p.date)}</span>
                              <span>
                                {qty(p.quantity)}
                                {p.quantity.unit !== "kg" ? ` = ${formatKg(p.kg)}` : ""}
                              </span>
                              <span class="records-running">running total {formatKg(p.runningKg)}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={r.harvest.unitsSkipped > 0}>
                      <p class="records-note">{plural(r.harvest.unitsSkipped, "harvest entry", "harvest entries")} in other units not added.</p>
                    </Show>
                    <Show when={band()}>
                      {(b) => <p class="records-band">Regional band for this field: {bandText(b())} (district statistics, not your field)</p>}
                    </Show>
                  </section>
                </Show>

                <Show when={r.stock}>
                  {(s) => (
                    <section class="records-block" aria-labelledby={`rec-s-${r.cycleId}`}>
                      <h4 id={`rec-s-${r.cycleId}`}>
                        Stock on hand<span class="records-total"> · {formatKg(s().stockKg)}</span>
                      </h4>
                      <p class="records-note">Harvested minus sold, from your entries. Sold: {formatKg(s().soldKg)}.</p>
                      <Show when={s().salesExceedHarvest}>
                        <p class="records-note records-warn" role="note">Sales exceed recorded harvest, so stock shows zero. Check your harvest entries.</p>
                      </Show>
                      <Show when={s().soldUnitsSkipped > 0}>
                        <p class="records-note">{plural(s().soldUnitsSkipped, "sale entry", "sale entries")} with a quantity in another unit not subtracted.</p>
                      </Show>
                    </section>
                  )}
                </Show>

                <Show when={r.water.events > 0}>
                  <section class="records-block" aria-labelledby={`rec-w-${r.cycleId}`}>
                    <h4 id={`rec-w-${r.cycleId}`}>
                      Water applied<span class="records-total"> · {plural(r.water.events, "irrigation", "irrigations")}</span>
                    </h4>
                    <ul class="records-list records-list-plain" data-testid="records-water">
                      <Show when={r.water.mm !== null}>
                        <li>Depth recorded in mm: {formatDecimal(r.water.mm!)} mm</li>
                      </Show>
                      <Show when={r.water.m3 !== null}>
                        <li>Volume recorded in litres or m³: {formatDecimal(r.water.m3!)} m³ (litres divided by 1,000)</li>
                      </Show>
                      <Show when={r.water.mmAsM3 !== null}>
                        <li>
                          {formatDecimal(r.water.mm!)} mm over {r.water.areaHa!.toFixed(2)} ha = {r.water.mmAsM3!.toLocaleString("en-IN", { maximumFractionDigits: 1 })} m³ (converted with your field area)
                        </li>
                      </Show>
                    </ul>
                    <Show when={r.water.mm !== null && r.water.m3 !== null}>
                      <p class="records-note">mm and m³ are kept apart; they are not added.</p>
                    </Show>
                    <Show when={r.water.skipped > 0}>
                      <p class="records-note">{plural(r.water.skipped, "irrigation entry", "irrigation entries")} with no quantity, or a quantity in another unit, not added.</p>
                    </Show>
                  </section>
                </Show>

                <Show when={r.fertiliser.length > 0}>
                  <section class="records-block" aria-labelledby={`rec-f-${r.cycleId}`}>
                    <h4 id={`rec-f-${r.cycleId}`}>
                      Fertiliser applications<span class="records-total"> · {r.fertiliser.length}</span>
                    </h4>
                    <ul class="records-list" data-testid="records-fertiliser">
                      <For each={r.fertiliser}>
                        {(f) => (
                          <li>
                            <span class="records-date">{props.dateLabel(f.date)}</span>
                            <span class="records-text">{f.note ?? "No note"}</span>
                            <span class="records-running">{f.quantity ? qty(f.quantity) : "no quantity"}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>

                <p class="records-label">Farmer recorded · not an estimate</p>
              </article>
            );
          }}
        </For>
      </div>
    </section>
  );
}
