import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { MarketTimeline as marketTimelineSchema } from "@harvest/contracts";
import {
  FIXTURE_FARM_ID,
  FIXTURE_POINTS,
  FIXTURE_TODAY_INDEX,
  marketFixture,
  marketInsufficientFixture,
  marketNoPriceFixture,
} from "./fixtures";
import { MARKET_EMPTY_TEXT, MarketEmpty, MarketPanel } from "./MarketView";
import { SIMILAR_SEASONS_NOTE, SimilarSeasons } from "./SimilarSeasons";
import { MARKET_SLIDER_LABEL } from "./MarketSlider";
import { marketTimelinePath } from "./marketApi";
import {
  analogueOverlay,
  chartGeometry,
  formatInr,
  priceSummary,
  stepForKey,
  weatherSummary,
  weekLabel,
} from "./model";

const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The markup of one card (from its data-card attribute to the end of its article). */
const card = (html: string, kind: string) => {
  const start = html.indexOf(`data-card="${kind}"`);
  return text(html.slice(start, html.indexOf("</article>", start)));
};
const fixture = marketFixture();
const panel = (timeline = fixture, index = timeline.todayIndex, shown: ReadonlySet<string> = new Set()) =>
  renderToString(() => <MarketPanel timeline={timeline} index={index} onIndex={() => undefined} shown={shown} onToggle={() => undefined} />);

describe("Market fixtures", () => {
  it("parse with the MarketTimeline contract and cover the scenario", () => {
    for (const f of [marketFixture(), marketNoPriceFixture(), marketInsufficientFixture()]) expect(marketTimelineSchema.safeParse(f).success).toBe(true);
    expect(fixture.points).toHaveLength(FIXTURE_POINTS);
    expect(fixture.points[FIXTURE_TODAY_INDEX]!.weekStart).toBe("2026-10-26");
    expect(fixture.points[FIXTURE_TODAY_INDEX + 1]!.price.kind).toBe("reference");
    expect(marketFixture("22222222-2222-4222-8222-222222222222").farmId).toBe("22222222-2222-4222-8222-222222222222");
    expect(marketTimelinePath(FIXTURE_FARM_ID, { productId: "maize-grain", monthsBack: 36, monthsAhead: 12 })).toBe(
      `/api/v1/farms/${FIXTURE_FARM_ID}/market-timeline?productId=maize-grain&monthsBack=36&monthsAhead=12`,
    );
  });
});

describe("slider and the three cards stay in sync", () => {
  it("opens at today: slider value, week label, chart cursor and all three cards read the current week", () => {
    const html = panel();
    const today = fixture.points[FIXTURE_TODAY_INDEX]!;
    expect(html).toContain(`aria-valuetext="Week of 26 Oct 2026"`);
    expect(html).toContain(`value="${FIXTURE_TODAY_INDEX}"`);
    expect(html).toContain(`max="${FIXTURE_POINTS - 1}"`);
    expect(html).toContain(`data-index="${FIXTURE_TODAY_INDEX}"`);
    expect(text(html)).toContain(MARKET_SLIDER_LABEL);
    expect(text(html)).not.toContain("Back to today");
    const price = card(html, "price");
    expect(today.price.kind).toBe("observed");
    expect(price).toContain(`${formatInr((today.price as { p50: number }).p50)} /kg`);
    expect(price).toContain("Observed");
    expect(price).toContain("Range");
    expect(card(html, "weather")).toContain("6 mm");
    expect(card(html, "weather")).toContain("Observed");
    expect(card(html, "weather")).toContain("6 of 7 days observed");
    expect(card(html, "events")).toContain("Fall armyworm scouting window");
    expect(card(html, "events")).toContain("Source: Fixture crop guide ↗");
  });

  it("one week later every part moves together: reference price with its band, forecast weather, no events", () => {
    const html = panel(fixture, FIXTURE_TODAY_INDEX + 1);
    const next = fixture.points[FIXTURE_TODAY_INDEX + 1]!;
    expect(html).toContain(`aria-valuetext="Week of 2 Nov 2026"`);
    expect(html).toContain(`data-index="${FIXTURE_TODAY_INDEX + 1}"`);
    expect(text(html)).toContain("Back to today");
    const price = card(html, "price");
    const summary = priceSummary(next);
    expect(price).toContain("Reference");
    expect(price).not.toContain("Observed");
    expect(price).toContain(summary.band);
    expect(price).toContain("not a forecast");
    const weather = card(html, "weather");
    expect(weather).toContain("Forecast");
    expect(weather).toContain("12 mm");
    expect(weather).toContain("forecast to 6 Nov 2026");
    expect(card(html, "events")).toContain("No alerts or price moves this week");
  });

  it("further moves: a price-move week, a dismissed alert week and a typical-weather week", () => {
    const move = panel(fixture, 148);
    expect(move).toContain(`aria-valuetext="Week of 31 Aug 2026"`);
    expect(card(move, "events")).toContain("Price move");
    expect(card(move, "events")).toContain("Mandi price up 25% this week");
    const dismissed = panel(fixture, 135);
    expect(card(dismissed, "events")).toContain("Heavy rain warning");
    expect(card(dismissed, "events")).toContain("Dismissed");
    const later = panel(fixture, FIXTURE_TODAY_INDEX + 10);
    expect(card(later, "weather")).toContain("Typical");
    expect(weatherSummary(fixture.points[FIXTURE_TODAY_INDEX + 10]!).chip).toBe("Typical");
  });
});

describe("keyboard", () => {
  it("arrow keys move exactly one week and clamp at the ends; Page, Home and End jump", () => {
    const last = FIXTURE_POINTS - 1;
    expect(stepForKey("ArrowRight", FIXTURE_TODAY_INDEX, last)).toBe(FIXTURE_TODAY_INDEX + 1);
    expect(stepForKey("ArrowUp", FIXTURE_TODAY_INDEX, last)).toBe(FIXTURE_TODAY_INDEX + 1);
    expect(stepForKey("ArrowLeft", FIXTURE_TODAY_INDEX, last)).toBe(FIXTURE_TODAY_INDEX - 1);
    expect(stepForKey("ArrowDown", FIXTURE_TODAY_INDEX, last)).toBe(FIXTURE_TODAY_INDEX - 1);
    expect(stepForKey("ArrowLeft", 0, last)).toBe(0);
    expect(stepForKey("ArrowRight", last, last)).toBe(last);
    expect(stepForKey("PageUp", 10, last)).toBe(14);
    expect(stepForKey("Home", 10, last)).toBe(0);
    expect(stepForKey("End", 10, last)).toBe(last);
    expect(stepForKey("a", 10, last)).toBeNull();
    // The announced value after one ArrowRight is the next week's label.
    expect(weekLabel(fixture.points[stepForKey("ArrowRight", FIXTURE_TODAY_INDEX, last)!]!)).toBe("Week of 2 Nov 2026");
  });
});

describe("empty and insufficient states", () => {
  it("empty product state: no tracked product, and a product without a price series", () => {
    expect(text(renderToString(() => <MarketEmpty />))).toBe(MARKET_EMPTY_TEXT);
    const none = marketNoPriceFixture();
    const html = panel(none);
    expect(text(html)).toContain("No mandi price series is stored for Sugarcane yet");
    expect(text(html)).toContain("No price series yet");
    expect(card(html, "price")).toContain("–");
    expect(card(html, "price")).toContain("No mandi price series is stored for this product yet");
    expect(card(html, "weather")).toContain("Observed"); // weather still follows the slider
    expect(chartGeometry(none).hasPrice).toBe(false);
  });

  it("insufficient analogues: the reason, the one-line note and no overlay toggles", () => {
    const f = marketInsufficientFixture();
    const html = renderToString(() => <SimilarSeasons analogues={f.analogues} shown={new Set()} onToggle={() => undefined} />);
    expect(text(html)).toContain(SIMILAR_SEASONS_NOTE);
    expect(text(html)).toContain("Fewer than two past crop years have both complete June to September rain at the field and mandi prices (found 1).");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('data-testid="market-similar-insufficient"');
  });

  it("available analogues list year, rain, similarity bar, harvest change and a pressed toggle when shown", () => {
    const html = renderToString(() => <SimilarSeasons analogues={fixture.analogues} shown={new Set(["2025-26"])} onToggle={() => undefined} />);
    const t = text(html);
    expect(t).toContain("This season (2026-27): 1,098 mm from 1 June to 30 September");
    expect(t).toContain("2025-26");
    expect(t).toContain("+8% sowing to harvest");
    expect(html).toContain('aria-label="Similarity 89 percent"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});

describe("chart geometry and overlays", () => {
  it("maps an analogue path onto this crop year by ISO week and draws the bands, harvest window and overlay", () => {
    const year = fixture.analogues.years[0]!;
    const overlay = analogueOverlay(fixture, year);
    // Crop year 2026-27: weeks whose Monday is 1 Jul 2026 to 30 Jun 2027 that the path covers (ISO weeks 28..52, 1..27).
    expect(overlay.length).toBeGreaterThan(40);
    const first = fixture.points[overlay[0]!.index]!;
    expect(first.weekStart >= "2026-07-01").toBe(true);
    expect(overlay[0]!.p50).toBe(year.pricePath.find((p) => p.isoWeek === Number(first.isoWeek.split("-W")[1]))!.p50);
    const geo = chartGeometry(fixture, [{ cropYear: year.cropYear, points: overlay }]);
    expect(geo.observedLine).toMatch(/^M/);
    expect(geo.referenceLine).toMatch(/^M/);
    expect(geo.likelyBand).toContain("Z");
    expect(geo.possibleBand).toContain("Z");
    expect(geo.overlays[0]!.path).toMatch(/^M/);
    expect(geo.harvest).not.toBeNull();
    expect(geo.todayX).toBeCloseTo(geo.x(FIXTURE_TODAY_INDEX), 6);
    const html = panel(fixture, FIXTURE_TODAY_INDEX, new Set([year.cropYear]));
    expect(html).toContain(`data-crop-year="${year.cropYear}"`);
    expect(html).toContain('role="img"');
    expect(html).toContain("Maize grain mandi price by week");
  });
});
