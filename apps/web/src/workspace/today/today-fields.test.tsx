import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { TodayView as todaySchema } from "@harvest/contracts";
import {
  FIXTURE_BOUNDARY,
  FIXTURE_FARM_ID,
  FIXTURE_FIELD_BOUNDARIES,
  fieldSummariesFixture,
  todayEmptyFixture,
  todayFieldEmptyFixture,
  todayFieldsFixture,
  todayFixture,
} from "./fixtures";
import { conditionAt, cropColor, CROP_PALETTE, harvestInText, NO_CROP_COLOR, priceAt, stageAt, weatherAt } from "./model";
import { FarmOverview, farmHeroOf, fieldsMode, summaryCropNames, TodayFieldChips, TodaySide } from "./TodayView";
import { fieldOutlines, heroFieldOf, ringCentre, sceneFields, TodayHero } from "./TodayHero";
import { TodayEmpty } from "./TodayEmpty";
import { todayPath } from "./todayApi";
import { chipItemOf, FieldChips, FieldsLegend, FieldsTable, greennessText, summaryCrop } from "../fields/FieldsToday";
import type { FieldBoundary } from "../fieldGeometry";
import { farmHref } from "../farmTabs";

/** SSR markup without hydration keys and comment markers. Node environment: no DOM, so clicks are asserted through pure helpers. */
const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
/** TodayEmpty links to the year plan with the router's <A>, so it renders inside a route. */
const routed = (fn: () => JSX.Element) =>
  html(() => (
    <Router url="/farm">
      <Route path="/farm" component={fn} />
    </Router>
  ));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (markup: string, needle: RegExp) => (markup.match(needle) ?? []).length;
const noop = () => undefined;

const fieldsView = todayFieldsFixture();
const today = fieldsView.today;

function overview(mode: "illustration" | "satellite", view = fieldsView) {
  return routed(() => (
    <FarmOverview
      view={view}
      hero={farmHeroOf(view)}
      mode={mode}
      onMode={noop}
      date={today}
      stage={stageAt(view.timeline, today)}
      progress={0.4}
      cropName="Maize"
      condition={conditionAt(view.conditions, today)}
      cropNames={summaryCropNames(view.fields ?? [])}
      onSelect={noop}
      empty={<TodayEmpty onPlant={noop} canPlant fieldName="South strip" />}
      side={
        <TodaySide
          view={view}
          farmId={view.farmId}
          epoch={0}
          date={today}
          price={priceAt(view.priceTrack, today)}
          weather={weatherAt(view.weatherTrack, today)}
          onDetails={noop}
          onUpload={noop}
          onRecords={noop}
        />
      }
      lists={<div class="today-lists" />}
    />
  ));
}

describe("fields fixtures", () => {
  it("validate against the TodayView contract (overview, field and empty field views)", () => {
    expect(todaySchema.safeParse(fieldsView).success).toBe(true);
    expect(todaySchema.safeParse(todayFieldEmptyFixture()).success).toBe(true);
    expect(fieldsView.fields).toHaveLength(3);
    expect(fieldsView.field?.id).toBe("north");
  });
});

describe("crop colours", () => {
  it("are deterministic per crop id and drawn from the palette; no crop is the bare-soil tone", () => {
    expect(cropColor("maize")).toBe(cropColor("maize"));
    for (const id of ["maize", "paddy", "black_gram", "ginger", "turmeric"]) expect(CROP_PALETTE).toContain(cropColor(id));
    expect(cropColor(null)).toBe(NO_CROP_COLOR);
    expect(cropColor("")).toBe(NO_CROP_COLOR);
  });
  it("harvest-in text covers the window and past dates", () => {
    expect(harvestInText({ earliest: 63, latest: 73 })).toBe("63 to 73 days");
    expect(harvestInText({ earliest: -2, latest: 5 })).toBe("In the harvest window");
    expect(harvestInText({ earliest: -9, latest: -1 })).toBe("Past the expected harvest");
    expect(harvestInText(null)).toBeNull();
  });
});

describe("field chips", () => {
  const items = fieldSummariesFixture().map(chipItemOf);
  it("render All fields then one chip per field (name and crop), the selected chip aria-pressed", () => {
    const markup = html(() => <FieldChips items={items} selected="middle" onSelect={noop} />);
    expect(markup).toContain('data-testid="today-field-chips"');
    expect(count(markup, /data-field-chip=/g)).toBe(4);
    expect(markup).toMatch(/aria-pressed="false" data-field-chip="all"/);
    expect(markup).toMatch(/aria-pressed="true" data-field-chip="middle"/);
    expect(markup).toMatch(/aria-pressed="false" data-field-chip="north"/);
    expect(text(markup)).toContain("All fields North strip Maize Middle strip Paddy / rice + black gram South strip No crop");
    // Every chip is a real button (keyboard reachable).
    expect(count(markup, /<button type="button" class="today-field-chip"/g)).toBe(4);
  });
  it("press All fields when no field is selected", () => {
    const markup = html(() => <FieldChips items={items} selected={null} onSelect={noop} />);
    expect(markup).toMatch(/aria-pressed="true" data-field-chip="all"/);
    expect(count(markup, /aria-pressed="true"/g)).toBe(1);
  });
  it("a farm without fields renders no chips and no overview", () => {
    const view = todayFixture();
    expect(fieldsMode(view.fields ?? [], [], null)).toBe("none");
    expect(fieldsMode([], [], "north")).toBe("none");
    expect(html(() => <TodayFieldChips mode="none" items={[]} selected={null} onSelect={noop} />)).toBe("");
    expect(farmHeroOf(view)).toBeNull();
    expect(farmHeroOf({ ...view, fields: [] })).toBeNull();
    // The same view with fields switches on the chips.
    expect(fieldsMode(fieldsView.fields!, [], null)).toBe("all");
    expect(fieldsMode(fieldsView.fields!, [], "north")).toBe("field");
    expect(fieldsMode([], [{ id: "north", name: "North strip", boundary: FIXTURE_FIELD_BOUNDARIES.north }], "north")).toBe("field");
    expect(html(() => <TodayFieldChips mode="all" items={fieldSummariesFixture().map(chipItemOf)} selected={null} onSelect={noop} />)).toContain("All fields");
  });
});

describe("All fields overview", () => {
  it("draws the farm-mode illustration, the legend and the Your fields table", () => {
    const markup = overview("illustration");
    expect(markup).toContain('data-testid="today-farm-overview"');
    expect(markup).toContain('data-mode="farm"');
    expect(markup).toContain('data-hero-mode="farm"');
    expect(text(markup)).toContain("Your farm · 3 fields");
    expect(text(markup)).toContain("Each field drawn at its own stage today");
    // Legend: one swatch per field, the stored reading for North strip, "No reading yet" for the others (never invented).
    const legend = markup.slice(markup.indexOf('data-testid="today-field-legend"'), markup.indexOf('data-testid="today-fields-table"'));
    expect(count(legend, /data-field-id=/g)).toBe(3);
    expect(text(legend)).toContain("1 North strip Maize NDVI 0.62 on 27 Oct");
    expect(text(legend)).toContain("3 South strip No crop");
    expect(count(legend, /No reading yet/g)).toBe(2);
    // Table: crop, stage, harvest in, greenness with date, alerts.
    const table = text(markup.slice(markup.indexOf('data-testid="today-fields-table"'), markup.indexOf('data-testid="today-first-field"')));
    expect(table).toContain("Your fields");
    expect(table).toContain("North strip");
    expect(table).toContain("Vegetative");
    expect(table).toContain("63 to 73 days");
    expect(table).toContain("0.62 on 27 Oct · Near typical");
    expect(table).toContain("Paddy / rice + black gram");
    expect(table).toContain("Tillering");
    expect(table).toContain("92 to 104 days");
    expect(table).toContain("Not planted");
    expect(count(markup, /data-field-row=/g)).toBe(3);
    expect(count(markup, /<button type="button" class="today-fields-open"/g)).toBe(3);
  });
  it("shows the described field's cards under a heading naming it, with the soil card under Today for you", () => {
    const markup = overview("illustration");
    const first = markup.slice(markup.indexOf('data-testid="today-first-field"'));
    expect(text(first)).toContain("North strip: Maize");
    expect(first).toContain('data-testid="today-overview"');
    expect(first).toContain('data-testid="today-soil"');
    expect(first.indexOf('data-testid="today-overview"')).toBeLessThan(first.indexOf('data-testid="today-soil"'));
    expect(first.indexOf('data-testid="today-soil"')).toBeLessThan(first.indexOf('class="today-cards"'));
  });
  it("satellite: the wide image with one outline per field in its crop colour, the described field thicker, and labels", () => {
    const markup = overview("satellite");
    expect(markup).toContain('data-testid="today-sat-fields"');
    expect(count(markup, /data-field-outline=/g)).toBe(3);
    expect(markup).toMatch(new RegExp(`style="stroke: ?${cropColor("maize")};?"[^>]*class="is-selected\\s*"[^>]*data-field-outline="north"`));
    expect(markup).toMatch(new RegExp(`style="stroke: ?${cropColor("paddy")};?"[^>]*data-field-outline="middle"`));
    expect(markup).toMatch(new RegExp(`style="stroke: ?${cropColor(null)};?"[^>]*data-field-outline="south"`));
    // The fixture strips (18% of the image, about 115 px) are narrower than their chips: numbered badges, no overlapping chips.
    expect(count(markup, /class="today-sat-field-label"/g)).toBe(0);
    expect(count(markup, /data-field-badge=/g)).toBe(3);
    // Overview always shows the wide frame: no 10 m close-up and no Wider view toggle; no single white field outline.
    expect(markup).toContain('data-zoom="wide"');
    expect(markup).not.toContain("Wider view");
    expect(markup).not.toContain('class="today-sat-outline"');
  });
  it("without any crop the planting entry names the field the dialog will choose", () => {
    const view = { ...todayFieldEmptyFixture(), field: null };
    const markup = overview("illustration", view);
    expect(text(markup)).toContain("No crop on any field yet");
    expect(text(markup)).toContain("Plant a crop on South strip");
  });
  it("scene fields carry each field's ring in the farm frame, its crop and its season share", () => {
    const hero = farmHeroOf(fieldsView)!;
    const fields = sceneFields(hero);
    expect(fields.map((f) => [f.id, f.cropId, f.progress, f.companionCropId, f.selected])).toEqual([
      ["north", "maize", 0.4, null, true],
      ["middle", "paddy", 0.25, "black_gram", false],
      ["south", null, 0, null, false],
    ]);
    for (const f of fields) expect(f.ring.length).toBeGreaterThanOrEqual(3);
  });
  it("falls back to the box around the fields when the farm has no outer boundary", () => {
    const hero = farmHeroOf({ ...fieldsView, farmBoundary: null })!;
    expect(hero.boundary.coordinates[0]).toEqual([[76.1, 13.0], [76.101, 13.0], [76.101, 13.001], [76.1, 13.001], [76.1, 13.0]]);
  });
});

describe("field view", () => {
  it("names the field in the hero label and the stage overlay", () => {
    const view = todayFieldsFixture();
    const markup = html(() => (
      <TodayHero
        mode="illustration"
        onMode={noop}
        date={today}
        today={today}
        stage={stageAt(view.timeline, today)}
        progress={0.4}
        cropId="maize"
        cropName="Maize"
        boundary={FIXTURE_FIELD_BOUNDARIES.north as FieldBoundary}
        scenes={view.scenes}
        imageBbox={view.ndvi?.imageBbox ?? null}
        fieldName="North strip"
        otherFields={view.fields!.filter((f) => f.id !== "north").map(heroFieldOf)}
      />
    ));
    expect(markup).toContain('aria-label="Your field North strip"');
    expect(markup).toContain('data-hero-mode="field"');
    expect(text(markup.slice(markup.indexOf('data-testid="today-stage"')))).toContain("North strip Vegetative");
    expect(markup).toContain('data-testid="today-hero-field"');
    expect(markup).not.toContain('data-mode="farm"');
  });
  it("outlines the other fields faintly in the wide satellite view only", () => {
    const view = todayFieldsFixture();
    const others = view.fields!.filter((f) => f.id !== "north").map(heroFieldOf);
    const shapes = fieldOutlines(others, view.ndvi!.imageBbox, { faint: true });
    expect(shapes.map((s) => [s.id, s.faint, s.selected, s.label])).toEqual([
      ["middle", true, false, null],
      ["south", true, false, null],
    ]);
    const centre = ringCentre(FIXTURE_BOUNDARY as FieldBoundary, view.ndvi!.imageBbox)!;
    expect(centre.cx).toBeCloseTo(((76.1005 - 76.0977) / (76.1033 - 76.0977)) * 100, 0);
  });
  it("mounts the soil card under Today for you", () => {
    const view = todayFieldsFixture();
    const markup = html(() => (
      <TodaySide view={view} farmId={FIXTURE_FARM_ID} epoch={0} date={today} price={null} weather={null} onDetails={noop} onUpload={noop} onRecords={noop} />
    ));
    expect(markup).toContain('data-testid="today-soil"');
    expect(text(markup)).toContain("Soil for this farm");
    expect(markup.indexOf('data-testid="today-overview"')).toBeLessThan(markup.indexOf('data-testid="today-soil"'));
  });
  it("the empty state on a field offers Plant a crop on that field; without a field it is unchanged", () => {
    expect(text(routed(() => <TodayEmpty onPlant={noop} canPlant fieldName="South strip" />))).toContain("What's growing on South strip? Record what you planted");
    expect(text(routed(() => <TodayEmpty onPlant={noop} canPlant fieldName="South strip" />))).toContain("Plant a crop on South strip");
    const plain = text(routed(() => <TodayEmpty onPlant={noop} canPlant />));
    expect(plain).toContain("What's growing on this field?");
    expect(plain).not.toContain("Plant a crop on");
  });
  it("loads one field with ?fieldId= and keeps the field on tab links", () => {
    expect(todayPath(FIXTURE_FARM_ID)).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/today`);
    expect(todayPath(FIXTURE_FARM_ID, "north")).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/today?fieldId=north`);
    expect(farmHref("today", undefined, "north")).toBe("/farm?tab=today&field=north");
    expect(farmHref("soil", "records", "north")).toBe("/farm?tab=soil&view=records&field=north");
    expect(farmHref("year")).toBe("/farm?tab=year");
  });
});

describe("summaries", () => {
  it("name the companion and show greenness only from a stored reading", () => {
    const [north, middle, south] = fieldSummariesFixture();
    expect(summaryCrop(middle!)).toBe("Paddy / rice + black gram");
    expect(summaryCrop(south!)).toBe("No crop");
    expect(greennessText(north!)).toBe("0.62 on 27 Oct");
    expect(greennessText(middle!)).toBeNull();
    const legend = text(html(() => <FieldsLegend fields={[middle!]} />));
    expect(legend).toContain("No reading yet");
    expect(legend).not.toMatch(/NDVI \d/);
  });
  it("the table marks the described field", () => {
    const markup = html(() => <FieldsTable fields={fieldSummariesFixture()} selected="middle" onSelect={noop} />);
    expect(markup).toMatch(/data-field-row="middle" class="is-selected"|class="is-selected" data-field-row="middle"/);
  });
  it("a farm view without fields keeps the original fixture unchanged", () => {
    expect(todayFixture().fields).toBeUndefined();
    expect(todayEmptyFixture().field).toBeUndefined();
  });
});
