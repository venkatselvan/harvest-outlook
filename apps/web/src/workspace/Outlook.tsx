import { CurrentQuote } from "./CurrentQuote";
import { For, Show, createSignal, createEffect, on } from "solid-js";
import { A } from "@solidjs/router";
import { PageHeading } from "./FarmPage";
import { useWorkspace, dateLabel } from "./state";
import { Icon } from "./icons";
import { sourceReason } from "./reasons";
import { apiRequest, jsonInit } from "../features/photo-region/http";
type Schedule = {
  enabled: boolean;
  metaEnabled: boolean;
  intervalHours: number;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastMetaAt: string | null;
  changes: { at: string; kind: string; message: string }[];
  lastError?: string | null;
  marketRefreshReason?: string | null;
  lastAttemptAt?: string | null;
  metaReview: null | {
    status: string;
    traceId: string;
    answerBlocks: { text: string }[];
    limitations: string[];
  };
};
export function Outlook() {
  const s = useWorkspace();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [refresh, setRefresh] = createSignal(false);
  const schedule = () =>
    (s.monitor() as ReturnType<typeof s.monitor> & { schedule?: Schedule })
      ?.schedule;
  const weather = () => s.monitor()?.weather;
  const days = () => weather()?.days.slice(0, 7) ?? [];
  const current = () => days()[0];
  const knownRain = () => days().filter((d) => d.rainMm !== null);
  const rain = () =>
    knownRain().length ? knownRain().reduce((n, d) => n + d.rainMm!, 0) : null;
  const currentQuotes = s.currentMarket;
  const productName = (id: string) =>
    s
      .crops()
      ?.flatMap((c) =>
        c.products.map((p) => ({
          id: p.productId,
          name: `${c.name} · ${p.name}`,
        })),
      )
      .find((p) => p.id === id)?.name ?? id.replace(/[_-]/g, " ");
  createEffect(
    on(
      () =>
        [
          s.farm()?.id,
          s.workspace.loading,
          s.workspace()?.version,
        ] as const,
      () => {
        if (s.farm() && !s.workspace.loading) void s.ensureCurrentMarket();
      },
    ),
  );
  const allProducts = () => s.monitor()?.market.products ?? [];
  const products = () =>
    allProducts().filter((p) => p.reference.state === "historical_reference");
  const missingProducts = () =>
    allProducts().filter((p) => p.reference.state === "unavailable");
  async function saveSchedule(patch: Partial<Schedule>) {
    const target = s.farm()?.id;
    const snapshot = s.monitor();
    if (
      !target ||
      s.monitor.loading ||
      !snapshot ||
      (snapshot as typeof snapshot & { farmId: string }).farmId !== target
    )
      return;
    const epoch = s.sessionEpoch();
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        `/api/v1/farms/${target}/monitoring`,
        jsonInit("PUT", {
          enabled: schedule()?.enabled ?? false,
          intervalHours: schedule()?.intervalHours ?? 24,
          metaEnabled: schedule()?.metaEnabled ?? false,
          ...patch,
        }),
      );
      if (s.farm()?.id === target && epoch === s.sessionEpoch())
        await s.refreshMonitor();
    } catch (e) {
      if (s.farm()?.id === target && epoch === s.sessionEpoch())
        setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshNow() {
    setRefresh(true);
    const target = s.farm()?.id;
    const epoch = s.sessionEpoch();
    setError("");
    try {
      await Promise.all([s.refreshMonitor(), s.refreshCurrentMarket()]);
    } catch (e) {
      if (target === s.farm()?.id && epoch === s.sessionEpoch())
        setError((e as Error).message);
    } finally {
      setRefresh(false);
    }
  }
  function askReview() {
    window.dispatchEvent(
      new CustomEvent("ho:ask", {
        detail: {
          text: "Review the current weather, rainfall and stored mandi prices for my farm. Explain any meaningful changes, data age, and what I should pay attention to before my next season.",
        },
      }),
    );
  }
  const dayLabel = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short" });
  return (
    <div class="workspace-page">
      <PageHeading
        eyebrow="KEEP AN EYE ON WHAT MATTERS"
        title="The outlook, closer to home."
        description="Weather for your farm's location. Mandi references with their dates. Evidence you can keep in perspective."
      >
        <button
          class="btn secondary"
          disabled={refresh() || !s.farm()}
          onClick={() => void refreshNow()}
        >
          <Icon name="history" size={17} />
          {refresh() ? "Refreshing…" : "Refresh outlook"}
        </button>
        <button class="btn" disabled={!s.farm()} onClick={askReview}>
          <Icon name="chat" size={17} />
          Ask for a review
        </button>
      </PageHeading>
      <Show
        when={s.farm()}
        fallback={
          <div class="empty-state">
            <Icon name="sun" size={36} />
            <h2>A local outlook starts with your farm.</h2>
            <p>Map your land so weather has a meaningful location.</p>
            <A class="btn" href="/farm">
              Set up your farm
            </A>
          </div>
        }
      >
        <Show when={s.monitor.error}>
          <div class="alert-card" role="alert">
            The outlook couldn't load. {(s.monitor.error as Error).message}
            <button class="text-button" onClick={() => void refreshNow()}>
              Try again
            </button>
          </div>
        </Show>
        <div class="outlook-top">
          <section class="weather-card">
            <div class="section-heading">
              <div>
                <Icon name="sun" />
                <h2>Weather & rainfall</h2>
                <span
                  class={`tiny-pill ${weather()?.status === "fresh" ? "completed" : ""}`}
                >
                  {weather()?.status ?? "Loading"}
                </span>
              </div>
              <span class="subtle-caption">
                {s.farm()?.location.districtName}
              </span>
            </div>
            <Show
              when={days().length}
              fallback={
                <div class="weather-unavailable">
                  <Icon name="rain" size={40} />
                  <h3>
                    {s.monitor.loading
                      ? "Checking the local forecast…"
                      : "Weather is unavailable"}
                  </h3>
                  <p>
                    {s.monitor.loading
                      ? "Loading the forecast for this farm’s saved location."
                      : sourceReason(weather()?.reason) ||
                        (s.workspace()?.farmId === s.farm()?.id &&
                        s.workspace()?.boundary
                          ? "A forecast is not available for this saved field location. Try refreshing the outlook."
                          : "Map the farm boundary to request a local forecast.")}
                  </p>
                  <Show
                    when={
                      !s.monitor.loading &&
                      !s.workspace.loading &&
                      s.workspace()?.farmId === s.farm()?.id &&
                      !s.workspace()?.boundary
                    }
                  >
                    <A class="text-link" href="/farm/manage">
                      Go to your map
                      <Icon name="arrow" size={16} />
                    </A>
                  </Show>
                </div>
              }
            >
              <div class="weather-current">
                <div class="weather-temperature">
                  <Icon
                    name={(current()?.rainMm ?? 0) > 1 ? "rain" : "sun"}
                    size={52}
                  />
                  <div>
                    <strong>
                      {current()?.tMaxC ?? "—"}
                      <small>°C</small>
                    </strong>
                    <span>High · Low {current()?.tMinC ?? "—"}°</span>
                  </div>
                </div>
                <div class="weather-rain-total">
                  <span>Next 7 days · rainfall</span>
                  <strong>
                    {rain()?.toFixed(1) ?? "—"}
                    <small> mm</small>
                  </strong>
                  <span>{knownRain().length} days with available data</span>
                </div>
              </div>
              <div class="weather-week">
                <For each={days()}>
                  {(d) => (
                    <div>
                      <span>{dayLabel(d.date)}</span>
                      <Icon
                        name={(d.rainMm ?? 0) > 1 ? "rain" : "sun"}
                        size={24}
                      />
                      <strong>
                        {d.tMaxC ?? "—"}° <small>{d.tMinC ?? "—"}°</small>
                      </strong>
                      <div class="rain-bar">
                        <i
                          style={{
                            height: `${Math.max(3, Math.min(100, ((d.rainMm ?? 0) / Math.max(...days().map((x) => x.rainMm ?? 0), 10)) * 100))}%`,
                          }}
                        />
                      </div>
                      <span class="rain-mm">{d.rainMm ?? "—"} mm</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="weather-attribution">
                <span>{weather()?.attribution}</span>
                <span>
                  Issued{" "}
                  {weather()?.issuedAt
                    ? new Date(weather()!.issuedAt!).toLocaleString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "not available"}
                </span>
              </div>
            </Show>
            <p class="weather-note">
              Modelled local forecast, not a field sensor. Rainfall at your
              exact plot may differ.
            </p>
          </section>
          <aside class="monitor-card">
            <span class="round-feature">
              <Icon name="target" size={26} />
            </span>
            <p class="eyebrow">STAY IN THE LOOP</p>
            <h2>A watchful eye on your farm.</h2>
            <p>
              Keep checking weather and stored market references in the
              background.
            </p>
            <div class="monitor-toggle">
              <div>
                <strong>Automatic monitoring</strong>
                <small>
                  {schedule()?.enabled
                    ? "Worker checks are enabled"
                    : "Currently off"}
                </small>
              </div>
              <button
                role="switch"
                aria-checked={schedule()?.enabled ?? false}
                aria-label="Enable automatic farm monitoring"
                class={`switch ${schedule()?.enabled ? "on" : ""}`}
                disabled={busy() || s.monitor.loading}
                onClick={() =>
                  void saveSchedule({ enabled: !schedule()?.enabled })
                }
              >
                <span />
              </button>
            </div>
            <Show when={schedule()?.enabled}>
              <label class="monitor-interval">
                Check every
                <select
                  value={schedule()?.intervalHours ?? 24}
                  disabled={busy() || s.monitor.loading}
                  onChange={(e) =>
                    void saveSchedule({
                      intervalHours: Number(e.currentTarget.value),
                    })
                  }
                >
                  <option value="6">6 hours</option>
                  <option value="12">12 hours</option>
                  <option value="24">24 hours</option>
                  <option value="72">3 days</option>
                  <option value="168">7 days</option>
                </select>
              </label>
              <label class="monitor-ai">
                <input
                  type="checkbox"
                  checked={schedule()?.metaEnabled ?? false}
                  disabled={busy() || s.monitor.loading}
                  onChange={(e) =>
                    void saveSchedule({ metaEnabled: e.currentTarget.checked })
                  }
                />
                <span>
                  <strong>Include Meta review</strong>
                  <small>
                    Review on meaningful change, at most daily. Uses the
                    configured AI budget.
                  </small>
                </span>
              </label>
              <p class="monitor-next">
                Next check{" "}
                {schedule()?.nextCheckAt
                  ? new Date(schedule()!.nextCheckAt!).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : "being scheduled"}
              </p>
            </Show>
            <Show when={error()}>
              <p class="inline-error" role="alert">
                {error()}
              </p>
            </Show>
            <Show when={schedule()?.lastCheckedAt}>
              <p class="monitor-last-check">
                Last checked{" "}
                {new Date(schedule()!.lastCheckedAt!).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </Show>
            <Show when={schedule()?.lastError}>
              <p class="inline-error" role="status">
                Last check issue: {schedule()?.lastError}
              </p>
            </Show>
            <Show when={sourceReason(schedule()?.marketRefreshReason)}>
              <p class="monitor-status-reason">
                {sourceReason(schedule()?.marketRefreshReason)}
              </p>
            </Show>
            <Show when={schedule()?.changes.length}>
              <details class="monitor-changes">
                <summary>Recent changes ({schedule()?.changes.length})</summary>
                <For each={schedule()?.changes.slice(0, 4)}>
                  {(c) => <p>{c.message}</p>}
                </For>
              </details>
            </Show>
            <div class="monitor-note">
              <Icon name="clock" size={16} />
              <span>
                Background checks run while the API worker is running.
              </span>
            </div>
          </aside>
        </div>
        <section
          class="market-section current-market-section"
          aria-label="Latest dated mandi quotes"
        >
          <div class="section-heading">
            <div>
              <Icon name="trend" />
              <h2>Latest dated mandi quotes</h2>
              <span class="tiny-pill">
                {s.currentMarketBusy()
                  ? "Checking provider"
                  : currentQuotes()?.status === "available"
                    ? "Quotes returned"
                    : currentQuotes()?.status === "partial"
                      ? "Partial coverage"
                      : "Source coverage"}
              </span>
            </div>
            <button
              class="text-button"
              disabled={s.currentMarketBusy()}
              onClick={() => void s.refreshCurrentMarket().catch(() => {})}
            >
              {s.currentMarketBusy() ? "Checking…" : "Refresh dated quotes"}
              <Icon name="history" size={14} />
            </button>
          </div>
          <p class="section-description">
            Published wholesale market observations with their actual date and
            location. A latest quote is separate from the trading history needed
            for historical ranges.
          </p>
          <Show
            when={
              currentQuotes()?.selectionBasis === "recommendation_watchlist"
            }
          >
            <p class="market-watchlist-note">
              Watching Evara’s recommended crop options for this farm. These
              crops have not been recorded as planted.
            </p>
          </Show>
          <Show when={s.currentMarketError()}>
            <p class="inline-error" role="status">
              {s.currentMarketError()}
            </p>
          </Show>
          <Show
            when={currentQuotes()?.products.length}
            fallback={
              <div class="market-empty">
                <div>
                  <h3>
                    {s.currentMarketBusy()
                      ? "Checking AGMARKNET for your crop choices…"
                      : "No quote products returned yet"}
                  </h3>
                  <p>
                    {sourceReason(currentQuotes()?.missingReason) ||
                      "Evara's sourced crop recommendations or your saved crop choices provide the watchlist for this check."}
                  </p>
                </div>
              </div>
            }
          >
            <div class="market-grid">
              <For each={currentQuotes()?.products ?? []}>
                {(product) => (
                  <CurrentQuote
                    product={product}
                    name={productName(product.productId)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={currentQuotes()}>
            <details class="market-source-details">
              <summary>
                Provider status, source coverage and limitations
              </summary>
              <p>
                Provider: {sourceReason(currentQuotes()?.providerStatus)} ·
                checked{" "}
                {new Date(currentQuotes()!.checkedAt).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
              <For each={currentQuotes()?.limitations ?? []}>
                {(line) => <p>{line}</p>}
              </For>
            </details>
          </Show>
        </section>
        <section class="market-section">
          <div class="section-heading">
            <div>
              <Icon name="trend" />
              <h2>Historical price context</h2>
              <span class="tiny-pill">Trading history</span>
            </div>
            <span class="subtle-caption">
              {products().length} PRODUCTS WITH STORED DATA
            </span>
          </div>
          <p class="section-description">
            Stored market observations, shown with the market and quote date.
            These are not live bids or a price forecast.
          </p>
          <Show
            when={products().length}
            fallback={
              <div class="market-empty">
                <span class="round-feature">
                  <Icon name="trend" size={26} />
                </span>
                <div>
                  <h3>Historical summaries are not available yet.</h3>
                  <p>
                    {sourceReason(s.monitor()?.market.reason) ||
                      "Price coverage depends on the crop, region, and available source observations."}
                  </p>
                </div>
                <A href="/explore" class="text-link">
                  Compare crop requirements
                  <Icon name="arrow" size={16} />
                </A>
              </div>
            }
          >
            <div class="market-grid">
              <For each={products()}>
                {(p) => (
                  <Show when={p.reference.state === "historical_reference"}>
                    {(() => {
                      const r = p.reference;
                      if (r.state !== "historical_reference") return null;
                      return (
                        <article class="price-card">
                          <div class="price-card-heading">
                            <span class="crop-mini-icon">
                              <Icon name="leaf" />
                            </span>
                            <div>
                              <h3>
                                {s
                                  .crops()
                                  ?.flatMap((c) =>
                                    c.products.map((product) => ({
                                      id: product.productId,
                                      name: `${c.name} · ${product.name}`,
                                    })),
                                  )
                                  .find((x) => x.id === p.productId)?.name ??
                                  p.productId.replace(/_/g, " ")}
                              </h3>
                              <span>{r.marketName}</span>
                            </div>
                          </div>
                          <div class="price-main">
                            <strong>
                              ₹
                              {Number(r.lastQuote.inrPerKg).toLocaleString(
                                "en-IN",
                                { maximumFractionDigits: 2 },
                              )}
                              <small> / kg</small>
                            </strong>
                            <span class="tiny-pill">Stored quote</span>
                          </div>
                          <div class="price-date">
                            <Icon name="calendar" size={15} />
                            <span>Quoted {dateLabel(r.lastQuote.date)}</span>
                          </div>
                          <Show when={r.weeklyRange}>
                            <div class="weekly-range">
                              <span>{r.weeklyRange!.label}</span>
                              <strong>
                                ₹{Number(r.weeklyRange!.lowInrPerKg).toFixed(1)}{" "}
                                – ₹
                                {Number(r.weeklyRange!.highInrPerKg).toFixed(1)}{" "}
                                / kg
                              </strong>
                            </div>
                          </Show>
                          <Show when={r.fallbackNote}>
                            <p class="price-fallback">{r.fallbackNote}</p>
                          </Show>
                          <span class="source-footnote">
                            {r.lastQuote.variety ?? "Variety not specified"} ·{" "}
                            {r.otherMarkets} other markets
                          </span>
                        </article>
                      );
                    })()}
                  </Show>
                )}
              </For>
            </div>
          </Show>
          <Show when={missingProducts().length}>
            <details class="market-missing">
              <summary>
                Historical context missing for {missingProducts().length}{" "}
                products
              </summary>
              <For each={missingProducts()}>
                {(p) => (
                  <p>
                    <strong>{p.productId.replace(/_/g, " ")}</strong> —{" "}
                    {p.reference.state === "unavailable"
                      ? sourceReason(p.reference.missingReason)
                      : ""}
                  </p>
                )}
              </For>
            </details>
          </Show>
        </section>
        <Show when={schedule()?.metaReview}>
          <section class="monitor-review">
            <div class="section-heading">
              <div>
                <Icon name="chat" />
                <h2>Latest monitoring review</h2>
                <span class="tiny-pill">{schedule()?.metaReview?.status}</span>
              </div>
              <span class="subtle-caption">
                {schedule()?.lastMetaAt
                  ? new Date(schedule()!.lastMetaAt!).toLocaleString("en-IN")
                  : ""}
              </span>
            </div>
            <For each={schedule()?.metaReview?.answerBlocks ?? []}>
              {(b) => <p>{b.text}</p>}
            </For>
            <Show when={schedule()?.metaReview?.limitations.length}>
              <details>
                <summary>Review limitations</summary>
                <For each={schedule()?.metaReview?.limitations}>
                  {(l) => <p>{l}</p>}
                </For>
              </details>
            </Show>
          </section>
        </Show>
      </Show>
    </div>
  );
}
