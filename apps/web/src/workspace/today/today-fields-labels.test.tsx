import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { fieldSummariesFixture, todayFieldsFixture } from "./fixtures";
import { conditionAt, stageAt } from "./model";
import { FarmOverview, farmHeroOf, summaryCropNames } from "./TodayView";
import { chipFits, fieldOutlines, NOMINAL_FRAME_PX, sceneFields } from "./TodayHero";
import { TodayEmpty } from "./TodayEmpty";
import { FieldsLegend, FieldsTable } from "../fields/FieldsToday";
import { Route, Router } from "@solidjs/router";

const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const routed = (fn: () => JSX.Element) => html(() => <Router url="/farm"><Route path="/farm" component={fn} /></Router>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (markup: string, needle: RegExp) => (markup.match(needle) ?? []).length;
const noop = () => undefined;

/** Image window of the fixture's wide satellite image: 0.0056 deg across. */
const BBOX: [number, number, number, number] = [76.0977, 12.9978, 76.1033, 13.0032];
const box = (west: number, east: number, south: number, north: number) => ({
  type: "Polygon" as const,
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] as [number, number][][],
});

describe("farm satellite labels: chip or numbered badge", () => {
  it("a field narrower than its chip gets a badge, a wide one gets the full chip (7 px per character + 16 px padding)", () => {
    const label = "Strip 1 · no crop"; // 17 characters: 135 px estimated
    const strip = box(76.1, 76.101, 13.0, 13.001); // 0.001 / 0.0056 = 17.9% of the image
    const wide = box(76.098, 76.1028, 13.0, 13.001); // 85.7%
    const [narrowShape, wideShape] = fieldOutlines(
      [
        { id: "n", name: "Strip 1", boundary: strip, cropId: null },
        { id: "w", name: "Wide", boundary: wide, cropId: null },
      ],
      BBOX,
      { labels: { n: label, w: label } },
    );
    expect(narrowShape!.width).toBeCloseTo(17.86, 1);
    expect(wideShape!.width).toBeCloseTo(85.71, 1);
    expect(chipFits(label, narrowShape!.width)).toBe(false); // 114 px of 135 px
    expect(chipFits(label, wideShape!.width)).toBe(true);
    // Stored order numbers the badges.
    expect([narrowShape!.index, wideShape!.index]).toEqual([1, 2]);
    // The same field passes when the frame is larger: 0.1786 * 800 = 143 px >= 135 px.
    expect(chipFits(label, narrowShape!.width, 800)).toBe(true);
    // A very long label is cut by the CSS 42% max-width, so the rule caps the estimate there rather than demanding the impossible.
    expect(chipFits("x".repeat(200), 45, NOMINAL_FRAME_PX)).toBe(true);
    expect(chipFits("x".repeat(200), 30, NOMINAL_FRAME_PX)).toBe(false);
  });

  function overview(view: ReturnType<typeof todayFieldsFixture>) {
    return routed(() => (
      <FarmOverview
        view={view}
        hero={farmHeroOf(view)}
        mode="satellite"
        onMode={noop}
        date={view.today}
        stage={stageAt(view.timeline, view.today)}
        progress={0.4}
        cropName="Maize"
        condition={conditionAt(view.conditions, view.today)}
        cropNames={summaryCropNames(view.fields ?? [])}
        onSelect={noop}
        empty={<TodayEmpty onPlant={noop} canPlant fieldName="South strip" />}
        side={<div />}
        lists={<div class="today-lists" />}
      />
    ));
  }
  it("in the overview, narrow strips are badges 1 to 3 in stored order and a wide field keeps its chip; crop colours stay on the outlines", () => {
    const view = todayFieldsFixture();
    const narrow = overview(view);
    expect(count(narrow, /data-field-badge=/g)).toBe(3);
    expect(count(narrow, /class="today-sat-field-label"/g)).toBe(0);
    expect([...narrow.matchAll(/data-field-badge="(\d)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    expect(count(narrow, /data-field-outline=/g)).toBe(3);
    // Make the middle strip wide: it keeps a chip, the other two stay badges numbered 1 and 3.
    const mixed = { ...view, fields: view.fields!.map((f) => (f.id === "middle" ? { ...f, boundary: box(76.098, 76.1028, 13.0003, 13.0007) } : f)) };
    const markup = overview(mixed);
    expect(count(markup, /class="today-sat-field-label"/g)).toBe(1);
    expect(text(markup)).toContain("Middle strip · Paddy / rice");
    expect([...markup.matchAll(/data-field-badge="(\d)"/g)].map((m) => m[1])).toEqual(["1", "3"]);
  });
  it("the legend and the Your fields table carry the same number before each field's name", () => {
    const fields = fieldSummariesFixture();
    const legend = html(() => <FieldsLegend fields={fields} />);
    expect([...legend.matchAll(/data-field-number="(\d)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    expect(text(legend)).toContain("1 North strip");
    expect(text(legend)).toContain("2 Middle strip");
    const table = html(() => <FieldsTable fields={fields} onSelect={noop} />);
    expect([...table.matchAll(/data-field-number="(\d)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    expect(text(table)).toContain("3 South strip");
  });
});

describe("scene fields: water belongs to the described field", () => {
  const view = todayFieldsFixture();
  const hero = farmHeroOf(view)!;
  it("sets the condition's water look on the described field only, and only when it has a crop", () => {
    const flooded = sceneFields(hero, "sheet");
    expect(flooded.map((f) => [f.id, f.water])).toEqual([["north", "sheet"], ["middle", undefined], ["south", undefined]]);
    expect(sceneFields(hero, "none").every((f) => f.water === undefined)).toBe(true);
    // The described field has no crop: nothing is flooded.
    const bareSelected = { ...hero, selectedId: "south" };
    expect(sceneFields(bareSelected, "sheet").every((f) => f.water === undefined)).toBe(true);
  });
});
