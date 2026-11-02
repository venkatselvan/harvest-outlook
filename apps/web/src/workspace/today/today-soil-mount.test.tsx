import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { FIXTURE_FARM_ID, todayFieldsFixture } from "./fixtures";
import { conditionAt, priceAt, stageAt, weatherAt } from "./model";
import { FarmOverview, farmHeroOf, summaryCropNames, TodaySide } from "./TodayView";
import { TodayEmpty } from "./TodayEmpty";
import { SoilCardContext, type SoilCardController } from "./TodaySoil";
import type { SoilCardState } from "./todaySoilModel";

/**
 * The node renderer has no DOM and does not run effects, so it cannot show a real remount or a real GET. These tests cover
 * what it can: the card renders once per layout, it reads the view-root controller rather than loading for itself, and the
 * controller is created once above the loading Switch (a source assertion). Not covered: the real unmount/remount and the request
 * count across field switches, which need a DOM; check them in the browser (the Network tab should show one GET /soil-review).
 */
const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const routed = (fn: () => JSX.Element) =>
  html(() => (
    <Router url="/farm">
      <Route path="/farm" component={fn} />
    </Router>
  ));
const count = (markup: string, needle: RegExp) => (markup.match(needle) ?? []).length;
const noop = () => undefined;

const view = todayFieldsFixture();
const today = view.today;
const side = () => (
  <TodaySide view={view} farmId={FIXTURE_FARM_ID} epoch={0} date={today} price={priceAt(view.priceTrack, today)} weather={weatherAt(view.weatherTrack, today)} onDetails={noop} onUpload={noop} onRecords={noop} />
);
const overview = () => (
  <FarmOverview
    view={view}
    hero={farmHeroOf(view)}
    mode="illustration"
    onMode={noop}
    date={today}
    stage={stageAt(view.timeline, today)}
    progress={0.4}
    cropName="Maize"
    condition={conditionAt(view.conditions, today)}
    cropNames={summaryCropNames(view.fields ?? [])}
    onSelect={noop}
    empty={<TodayEmpty onPlant={noop} canPlant fieldName="South strip" />}
    side={side()}
    lists={<div class="today-lists" />}
  />
);

const fake = (state: SoilCardState): SoilCardController => ({ state: () => state, dismissed: () => false, retry: noop, dismiss: noop });

describe("soil card mount", () => {
  it("renders exactly once in the field view and once in the All fields overview", () => {
    expect(count(html(side), /data-testid="today-soil"/g)).toBe(1);
    expect(count(routed(overview), /data-testid="today-soil"/g)).toBe(1);
  });
  it("shows the view-root controller's state in both layouts, whatever the card's own props say", () => {
    const failed = fake({ kind: "failed", reason: "load" });
    for (const markup of [html(() => <SoilCardContext.Provider value={failed}>{side()}</SoilCardContext.Provider>), routed(() => <SoilCardContext.Provider value={failed}>{overview()}</SoilCardContext.Provider>)]) {
      expect(count(markup, /data-testid="today-soil-error"/g)).toBe(1);
      expect(markup).not.toContain('data-testid="today-soil-loading"');
    }
    // Without a provider the card falls back to its own load (standalone use) and starts in the loading state.
    expect(html(side)).toContain('data-testid="today-soil-loading"');
  });
  it("TodayView creates the controller once at its root, outside the loading Switch, and no branch loads the review itself", () => {
    const source = readFileSync(new URL("./TodayView.tsx", import.meta.url), "utf8");
    expect(source.match(/createSoilCardController\(/g)).toHaveLength(1);
    expect(source.indexOf("createSoilCardController(")).toBeLessThan(source.indexOf("<Switch>"));
    expect(source).toContain("<SoilCardContext.Provider");
  });
});
