import { createResource, Show } from "solid-js";
import { A } from "@solidjs/router";
import { useWorkspace, dateLabel } from "./state";
import { loadSoilMarkers } from "./soil";
export function SoilContextSummary(props: { farmId: string }) {
  const s = useWorkspace();
  const key = () => `${s.sessionEpoch()}|${props.farmId}`;
  const [data] = createResource(key, async (target) => {
    const result = await loadSoilMarkers(target.split("|")[1]!);
    return target === key() ? result : undefined;
  });
  const samples = () => (!data.error ? (data()?.samples ?? []) : []);
  const count = () =>
    samples().reduce(
      (sum, sample) =>
        sum +
        sample.markers.filter((m) => m.reviewStatus === "confirmed").length,
      0,
    );
  const date = () =>
    samples()
      .map((sample) => sample.collectionDate ?? sample.reportDate)
      .filter((date): date is string => !!date)
      .sort()
      .at(-1);
  return (
    <section class="card se-panel" aria-labelledby="soil-measurements-h">
      <h2 id="soil-measurements-h">Soil measurements</h2>
      <Show
        when={count()}
        fallback={
          <p>
            {data.loading
              ? "Checking linked soil measurements…"
              : data.error
                ? "Soil measurement status could not be loaded."
                : "No confirmed field soil measurements are linked to this plan’s farm. Soil moisture and soil condition remain unknown."}
          </p>
        }
      >
        <p>
          {count()} confirmed values across {samples().length} separate samples
          {date() ? ` · latest reported sample date ${dateLabel(date()!)}` : ""}
          . Review the report’s methods, dates and units before comparing
          measurements.
        </p>
      </Show>
      <A class="text-link" href={`/farm/settings?farmId=${props.farmId}`}>
        Open soil reports & markers
      </A>
    </section>
  );
}
