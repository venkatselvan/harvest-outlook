import { For, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { PriceTrend } from "@harvest/contracts";
import { useWorkspace } from "./state";
import { PriceTrendChart } from "./ui/PriceTrendChart";
import { priceTrend } from "./year/yearPlanApi";
import { trendProductIds, type TrackedSeason } from "./market-trends";

type Entry = { status: "loading" } | { status: "ready"; trend: PriceTrend } | { status: "error" };

/**
 * Price trends at the top of the Market tab: the 36-month mandi trend (shared PriceTrendChart) for each product the
 * farm tracks, for the farm's own state and district. Products without enough history say "No price series yet".
 */
export function MarketTrends(props: { cycles: TrackedSeason[]; savedSeasons: TrackedSeason[] }) {
  const s = useWorkspace();
  const ids = createMemo(
    () =>
      trendProductIds({
        cycles: props.cycles,
        savedSeasons: props.savedSeasons,
        catalogue: s.crops(),
        quotedProductIds: s.currentMarket()?.products.map((p) => p.productId) ?? [],
      }),
    [],
    { equals: (a, b) => a.join("|") === b.join("|") },
  );
  // Keyed by value so a refetch of the farm list (same farm, new object) does not refetch the trends.
  const place = createMemo(() => {
    const f = s.farm();
    return f ? `${f.id}|${f.location.stateCode ?? ""}|${f.location.districtName ?? ""}` : "";
  });
  const [trends, setTrends] = createSignal<Record<string, Entry>>({});
  let generation = 0;
  createEffect(
    on([place, s.sessionEpoch], () => {
      generation++;
      setTrends({});
    }),
  );
  createEffect(() => {
    const farm = s.farm();
    const list = ids();
    if (!farm) return;
    const gen = generation;
    for (const productId of list) {
      if (untrack(trends)[productId]) continue;
      setTrends((t) => ({ ...t, [productId]: { status: "loading" } }));
      priceTrend({
        productId,
        state: farm.location.stateCode,
        district: farm.location.districtName,
        months: 36,
      })
        .then((trend) => {
          if (gen === generation) setTrends((t) => ({ ...t, [productId]: { status: "ready", trend } }));
        })
        .catch(() => {
          if (gen === generation) setTrends((t) => ({ ...t, [productId]: { status: "error" } }));
        });
    }
  });
  const productName = (id: string) =>
    s
      .crops()
      ?.flatMap((c) => c.products.map((p) => ({ id: p.productId, name: `${c.name} · ${p.name}` })))
      .find((p) => p.id === id)?.name ?? id.replace(/[_-]/g, " ");
  return (
    <section class="market-trends" aria-labelledby="market-trends-title">
      <h2 id="market-trends-title">Price trends</h2>
      <p class="market-trends-note">
        Monthly mandi prices for the last 36 months, for your district where there are enough quotes. Past prices, not
        a forecast.
      </p>
      <Show
        when={ids().length}
        fallback={<p class="market-trends-empty">Add a crop to your farm or plan to see its price trend.</p>}
      >
        <div class="market-trends-grid">
          <For each={ids()}>
            {(id) => {
              const entry = () => trends()[id];
              return (
                <article class="command-panel market-trend" aria-label={`${productName(id)} price trend`}>
                  <h3>{productName(id)}</h3>
                  <Show when={entry()?.status === "loading"}>
                    <p class="market-trends-empty" role="status">
                      Loading the price trend…
                    </p>
                  </Show>
                  <Show when={entry()?.status === "error"}>
                    <p class="market-trends-empty">The price trend could not be loaded right now.</p>
                  </Show>
                  <Show when={(entry() as Extract<Entry, { status: "ready" }> | undefined)?.status === "ready"}>
                    <PriceTrendChart
                      trend={(entry() as Extract<Entry, { status: "ready" }>).trend}
                      productLabel={productName(id)}
                    />
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
