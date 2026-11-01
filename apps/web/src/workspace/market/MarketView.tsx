import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { MarketTimeline } from "@harvest/contracts";
import { useWorkspace } from "../state";
import { trendProductIds } from "../market-trends";
import { MarketChart } from "./MarketChart";
import { MarketSlider } from "./MarketSlider";
import { MarketCards } from "./MarketCards";
import { SimilarSeasons } from "./SimilarSeasons";
import { describeMarketError, loadMarketTimeline } from "./marketApi";
import { analogueOverlay, hasNoPrices, type ChartOverlay } from "./model";
import "./market.css";

type Entry = { status: "loading" } | { status: "ready"; timeline: MarketTimeline } | { status: "error"; message: string };

export const MARKET_EMPTY_TEXT = "Add a crop to your farm or plan to see its market timeline.";

/** Shown when the farm tracks no product (no crop on record and no current mandi quotes). */
export function MarketEmpty() {
  return (
    <p class="market-empty" data-testid="market-empty">
      {MARKET_EMPTY_TEXT}
    </p>
  );
}

/**
 * One loaded timeline: chart, week slider, the three synchronized cards, years with similar rain and the notes. The
 * selected week (`index`) is controlled by the caller so every part reads the same point.
 */
export function MarketPanel(props: {
  timeline: MarketTimeline;
  index: number;
  onIndex: (index: number) => void;
  shown: ReadonlySet<string>;
  onToggle: (cropYear: string) => void;
}) {
  const last = () => Math.max(0, props.timeline.points.length - 1);
  const index = () => Math.max(0, Math.min(last(), props.index));
  const point = () => props.timeline.points[index()]!;
  const overlays = createMemo<ChartOverlay[]>(() =>
    props.timeline.analogues.years
      .filter((y) => props.shown.has(y.cropYear))
      .map((y) => ({ cropYear: y.cropYear, points: analogueOverlay(props.timeline, y) })),
  );
  return (
    <div class="market-panel" data-product={props.timeline.productId}>
      <Show when={hasNoPrices(props.timeline)}>
        <p class="market-no-price" data-testid="market-no-price">
          No mandi price series is stored for {props.timeline.productName} yet. Weather and events are still shown by week.
        </p>
      </Show>
      <p class="market-scope">
        {props.timeline.productName} · {props.timeline.scope.label}
      </p>
      <MarketChart timeline={props.timeline} index={index()} overlays={overlays()} />
      <MarketSlider points={props.timeline.points} index={index()} todayIndex={props.timeline.todayIndex} onChange={props.onIndex} />
      <Show when={point()}>
        <MarketCards timeline={props.timeline} point={point()} />
      </Show>
      <SimilarSeasons analogues={props.timeline.analogues} shown={props.shown} onToggle={props.onToggle} />
      <details class="market-notes">
        <summary>About these numbers</summary>
        <ul>
          <For each={props.timeline.limitations}>{(text) => <li>{text}</li>}</For>
        </ul>
      </details>
    </div>
  );
}

/**
 * Market tab (ROUND2_SPEC 3.2): product chips over the farm's tracked products (current crop first), then one weekly
 * timeline from 36 months back to 12 months ahead with the chart, slider and cards in sync.
 *
 * Isolation: timelines are cached per farm, product and session epoch; a farm or session change clears them, and a late
 * response for an older request is dropped. The selected week and overlays reset when the product changes.
 */
export default function MarketView(props: { farmId: string }) {
  const s = useWorkspace();
  const currentProduct = createMemo(() => {
    const cycles = (s.workspace()?.cycles ?? []).filter((c) => c.stage !== "harvested");
    const anchor = (c: (typeof cycles)[number]) => c.establishmentDate ?? c.sowingDate;
    return [...cycles].sort((a, b) => anchor(b).localeCompare(anchor(a)))[0]?.productId ?? null;
  });
  const products = createMemo(
    () => {
      const ids = trendProductIds({
        cycles: (s.workspace()?.cycles ?? []).filter((c) => c.stage !== "harvested"),
        savedSeasons: s.workspace()?.rotationPlans ?? [],
        catalogue: s.crops(),
        quotedProductIds: s.currentMarket()?.products.map((p) => p.productId) ?? [],
      });
      const cur = currentProduct();
      return cur && ids.includes(cur) ? [cur, ...ids.filter((id) => id !== cur)] : ids;
    },
    [],
    { equals: (a, b) => a.join("|") === b.join("|") },
  );
  const productName = (id: string) =>
    s
      .crops()
      ?.flatMap((c) => c.products.map((p) => ({ id: p.productId, name: p.name })))
      .find((p) => p.id === id)?.name ?? id.replace(/[_-]+/g, " ");

  const [chosen, setChosen] = createSignal<string | null>(null);
  const selected = () => {
    const list = products();
    const c = chosen();
    return c && list.includes(c) ? c : list[0] ?? null;
  };
  const [entries, setEntries] = createSignal<Record<string, Entry>>({});
  const [pick, setPick] = createSignal<number | null>(null);
  const [shown, setShown] = createSignal<ReadonlySet<string>>(new Set());
  let generation = 0;

  createEffect(
    on([() => props.farmId, s.sessionEpoch], () => {
      generation++;
      setEntries({});
      setChosen(null);
    }),
  );
  createEffect(
    on(selected, () => {
      setPick(null);
      setShown(new Set<string>());
    }),
  );

  const load = (productId: string, force = false) => {
    if (!force && untrack(entries)[productId]) return;
    const gen = generation;
    const farmId = props.farmId;
    setEntries((e) => ({ ...e, [productId]: { status: "loading" } }));
    loadMarketTimeline(farmId, { productId, monthsBack: 36, monthsAhead: 12 })
      .then((timeline) => {
        if (gen === generation && farmId === props.farmId) setEntries((e) => ({ ...e, [productId]: { status: "ready", timeline } }));
      })
      .catch((error) => {
        if (gen === generation && farmId === props.farmId) setEntries((e) => ({ ...e, [productId]: { status: "error", message: describeMarketError(error) } }));
      });
  };
  createEffect(() => {
    const id = selected();
    if (id) load(id);
  });

  const entry = () => {
    const id = selected();
    return id ? entries()[id] : undefined;
  };
  const ready = () => {
    const e = entry();
    return e?.status === "ready" ? e.timeline : null;
  };
  const toggle = (cropYear: string) =>
    setShown((cur) => {
      const next = new Set(cur);
      if (next.has(cropYear)) next.delete(cropYear);
      else next.add(cropYear);
      return next;
    });

  return (
    <section class="market-view" aria-labelledby="market-view-title">
      <header class="market-view-head">
        <h2 id="market-view-title">Market timeline</h2>
        <p>Mandi prices by week, from three years back to a year ahead, with the weather and events of the same week.</p>
      </header>
      <Show when={products().length} fallback={<MarketEmpty />}>
        <div class="market-products" role="group" aria-label="Product">
          <For each={products()}>
            {(id) => (
              <button type="button" class="market-product" aria-pressed={selected() === id} onClick={() => setChosen(id)}>
                {productName(id)}
              </button>
            )}
          </For>
        </div>
        <Switch>
          <Match when={entry()?.status === "loading" || !entry()}>
            <p class="market-status" role="status">
              Loading the market timeline…
            </p>
          </Match>
          <Match when={entry()?.status === "error"}>
            <div class="market-status market-error" role="alert">
              <p>{(entry() as Extract<Entry, { status: "error" }>).message}</p>
              <button type="button" class="text-button" onClick={() => selected() && load(selected()!, true)}>
                Retry
              </button>
            </div>
          </Match>
          <Match when={ready()}>
            {(timeline) => (
              <MarketPanel
                timeline={timeline()}
                index={pick() ?? timeline().todayIndex}
                onIndex={(i) => setPick(i)}
                shown={shown()}
                onToggle={toggle}
              />
            )}
          </Match>
        </Switch>
      </Show>
    </section>
  );
}
