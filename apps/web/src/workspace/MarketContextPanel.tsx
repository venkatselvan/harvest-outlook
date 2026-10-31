import { For, Show, createResource } from "solid-js";
import { apiRequest } from "../features/photo-region/http";
import { dateLabel } from "./state";
import { Icon } from "./icons";
interface MarketContext {
  status: "available" | "stale" | "unavailable";
  fetchedAt: string | null;
  publishedAt: string | null;
  period: string | null;
  source: { name: string; url: string };
  indices: {
    category: "cereals" | "sugar";
    label: string;
    cropIds: string[];
    points: number;
    unit: "index_2014_2016_100";
    monthOnMonthPct: number | null;
  }[];
  topics: { label: string; cropIds: string[] }[];
  limitations: string[];
}
/** Official global observations are independent of the local mandi quote service. */
export function MarketContextPanel(props: { cropIds: string[] }) {
  const [resource] = createResource(async () => {
    const data = (await apiRequest<MarketContext>("/api/v1/market-context"))
      .data;
    return data &&
      ["available", "stale", "unavailable"].includes(data.status) &&
      data.source?.url &&
      Array.isArray(data.indices)
      ? data
      : undefined;
  });
  const data = () => (!resource.error ? resource() : undefined);
  const ids = () => props.cropIds.map((id) => (id === "rice" ? "paddy" : id));
  const relevant = (cropIds: string[]) =>
    cropIds.some((id) => ids().includes(id));
  const indices = () =>
    data()?.indices.filter((index) => relevant(index.cropIds)) ?? [];
  const topics = () =>
    data()?.topics.filter((topic) => relevant(topic.cropIds)) ?? [];
  return (
    <section class="global-market-context" aria-label="Global market context">
      <div class="command-panel-heading">
        <div>
          <p class="eyebrow">GLOBAL · MONTHLY BULLETIN</p>
          <h2>Wider market context</h2>
        </div>
        <span class="tiny-pill">
          {data()?.status === "stale" ? "Stale source" : "FAO index"}
        </span>
      </div>
      <Show when={resource.loading}>
        <p role="status">Loading the official monthly bulletin…</p>
      </Show>
      <Show
        when={data()?.status !== "unavailable" && data()}
        fallback={
          !resource.loading && (
            <p>
              The official bulletin is unavailable. Local dated market quotes
              remain separate below.
            </p>
          )
        }
      >
        <p class="global-market-date">
          {data()?.period ?? "Period not reported"}
          {data()?.publishedAt
            ? ` · Published ${dateLabel(data()!.publishedAt!)}`
            : ""}
        </p>
        <Show
          when={indices().length}
          fallback={
            <p>
              This bulletin covers global cereals and sugar. It provides no
              crop-specific indicator for your currently recorded or planned
              crops.
            </p>
          }
        >
          <div class="global-market-indices">
            <For each={indices()}>
              {(index) => (
                <article>
                  <span>{index.label}</span>
                  <strong>
                    {index.points.toLocaleString("en-IN", {
                      maximumFractionDigits: 1,
                    })}
                    <small> index points</small>
                  </strong>
                  <p>2014–2016 = 100</p>
                  <Show when={index.monthOnMonthPct !== null}>
                    <p>
                      {index.monthOnMonthPct! > 0 ? "+" : ""}
                      {index.monthOnMonthPct}% from previous month
                    </p>
                  </Show>
                </article>
              )}
            </For>
          </div>
          <Show when={topics().length}>
            <div class="global-market-topics">
              <span>Reported exposure</span>
              <For each={topics()}>
                {(topic) => <span class="tiny-pill">{topic.label}</span>}
              </For>
            </div>
          </Show>
        </Show>
        <p class="global-market-caveat">
          Global export-price context is not an Indian mandi price or a forecast
          of your harvest sale price.
        </p>
        <a
          class="text-link"
          href={data()?.source.url}
          target="_blank"
          rel="noreferrer"
        >
          {data()?.source.name}
          <Icon name="arrow" size={13} />
        </a>
        <Show when={data()?.fetchedAt}>
          <small class="command-issued">
            Retrieved {new Date(data()!.fetchedAt!).toLocaleString("en-IN")}
          </small>
        </Show>
        <details>
          <summary>Coverage & limitations</summary>
          <For each={data()?.limitations ?? []}>{(line) => <p>{line}</p>}</For>
        </details>
      </Show>
    </section>
  );
}
