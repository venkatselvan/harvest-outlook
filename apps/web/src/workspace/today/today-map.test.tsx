import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "solid-js/web";
import type { FieldConditionPoint } from "@harvest/contracts";
import { todayFixture, FIXTURE_TODAY } from "./fixtures";
import { sliderModel, stageAt } from "./model";
import { attentionItems, glanceFacts, greennessGauge, headlineEyebrow, headlineSentence, headlineTitle, stageGauge, waterGauge, weekAhead, weekPlan, weekTakeaway } from "./todayMapModel";
import { AttentionPanel, GaugesPanel, GlancePanel, MapCentre, TodayHeadline, TodayMapLayout } from "./TodayMapLayout";

const plain = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const view = todayFixture();
const point = (water: FieldConditionPoint["water"], kind: FieldConditionPoint["kind"] = "observed"): FieldConditionPoint => ({
  date: FIXTURE_TODAY, kind, rain: { mm: 0, class: "none" }, water, heat: { tMaxC: 30, stress: false, thresholdC: null },
  greenness: { ndvi: null, verdict: null, observedOn: null, daysSince: null }, events: [], stage: null,
});

describe("headline sentence rules", () => {
  it("names the farm or the selected field", () => {
    expect(headlineTitle(null)).toBe("Your farm today.");
    expect(headlineTitle("Strip 2")).toBe("Strip 2 today.");
  });
  it("words the attention count", () => {
    expect(headlineSentence(0)).toBe("Nothing needs attention today.");
    expect(headlineSentence(1)).toBe("One thing deserves a closer look.");
    expect(headlineSentence(2)).toBe("Two things deserve a closer look.");
    expect(headlineSentence(10)).toBe("Ten things deserve a closer look.");
    expect(headlineSentence(14)).toBe("14 things deserve a closer look.");
  });
  it("dates the eyebrow in UTC", () => {
    expect(headlineEyebrow("2026-11-04")).toBe("Wednesday · 4 November");
  });
  it("counts open alerts and due steps, an alert and its own suggested step once", () => {
    const { total, items } = attentionItems(view.alerts, view.upcoming, view.today);
    const open = view.upcoming.filter((s) => (s.status === "due" || s.status === "overdue") && !(s.alertId && view.alerts.some((a) => a.id === s.alertId)));
    expect(total).toBe(view.alerts.length + open.length);
    expect(items.length).toBe(Math.min(3, total));
    expect(items[0]!.severity).toBe("warning");
    expect(attentionItems([], [], view.today)).toEqual({ items: [], total: 0 });
    const html = plain(renderToString(() => <TodayHeadline date="2026-11-04" fieldName={null} count={total} />));
    expect(html).toContain("Your farm today.");
    expect(html).toContain(headlineSentence(total));
    expect(renderToString(() => <TodayHeadline date="2026-11-04" fieldName={null} count={total} />)).toMatch(/<h1[^>]*>Your farm today\.<\/h1>/);
  });
  it("shows 'See all in Actions' only when more than three items exist", () => {
    const { items, total } = attentionItems(view.alerts, view.upcoming, view.today);
    const html = renderToString(() => <AttentionPanel items={items} total={total} actionsHref="/farm?tab=actions" />);
    expect(html.includes("See all in Actions")).toBe(total > 3);
    expect(plain(renderToString(() => <AttentionPanel items={[]} total={0} actionsHref="/farm?tab=actions" />))).toContain("Nothing needs attention today.");
  });
});

describe("gauge basis chips", () => {
  it("greenness is observed from the satellite image, or has no reading", () => {
    expect(greennessGauge(view.health)).toMatchObject({ basis: "observed", value: view.health!.ndviMean.toFixed(2), sheet: "health" });
    expect(greennessGauge(null)).toMatchObject({ basis: null, value: "–" });
  });
  it("water is modelled from soil moisture, estimated from rules or practice, and unknown otherwise", () => {
    expect(waterGauge(point({ state: "moist", basis: "model_soil_moisture", soilMoisture0to7: 0.312 }))).toMatchObject({ basis: "modelled", value: "Moist", level: 1, caption: "Model soil moisture 31.2% by volume" });
    expect(waterGauge(point({ state: "ponded", basis: "rain_rule" }))).toMatchObject({ basis: "estimated", level: 2 });
    expect(waterGauge(point({ state: "flooded", basis: "crop_practice" }))).toMatchObject({ basis: "estimated", level: 3 });
    expect(waterGauge(point({ state: "unknown", basis: "none" }))).toMatchObject({ basis: null });
    expect(waterGauge(null)).toMatchObject({ basis: null, value: "–" });
  });
  it("stage progress is a calendar estimate, day N of M", () => {
    const model = sliderModel(view)!;
    const gauge = stageGauge(model, model.todayIndex, stageAt(view.timeline, view.today));
    expect(gauge).toMatchObject({ basis: "estimated", value: `Day ${model.todayIndex} of ${model.total}`, sheet: "harvest" });
    expect(stageGauge(null, 0, { kind: "none" })).toMatchObject({ basis: null });
  });
  it("renders every chip with its label and plain-words basis", () => {
    const gauges = [greennessGauge(view.health), waterGauge(point({ state: "dry", basis: "model_soil_moisture" })), stageGauge(sliderModel(view), 10, stageAt(view.timeline, view.today))];
    const html = renderToString(() => <GaugesPanel gauges={gauges} subject="Maize" dateLabel="Today" onOpen={() => undefined} />);
    expect(html).toMatch(/data-basis="observed"[^>]*>Observed</);
    expect(html).toMatch(/data-basis="modelled"[^>]*>Modelled</);
    expect(html).toMatch(/data-basis="estimated"[^>]*>Estimated</);
    expect(html.match(/<button type="button" class="today-gauge"/g)).toHaveLength(3);
    const none = renderToString(() => <GaugesPanel gauges={[greennessGauge(null)]} subject={null} dateLabel="Today" onOpen={() => undefined} />);
    expect(none).toMatch(/data-basis="none"[^>]*>No reading</);
  });
});

describe("week, glance and this week", () => {
  it("reads five days from the track and takes the weather alert as the takeaway", () => {
    const days = weekAhead(view.weatherTrack, view.today);
    expect(days).toHaveLength(5);
    expect(days[0]!.label).toBe("Today");
    expect(weekAhead([], view.today).every((d) => d.kind === "unavailable" && d.rain === "–")).toBe(true);
    const weather = view.alerts.find((a) => a.type === "weather")!;
    expect(weekTakeaway(view.alerts, view.today)).toContain(weather.title);
    expect(weekTakeaway([], view.today)).toBeNull();
  });
  it("sums cultivated area from fields with a crop and never invents an area", () => {
    const field = (id: string, areaHa: number, crop: boolean) => ({ id, name: id, areaHa, boundary: { type: "Polygon" as const, coordinates: [] }, cycle: crop ? { id, cropId: "maize", cropName: "Maize", companion: null, establishmentDate: "2026-09-01", stage: null, daysToHarvest: null } : null, greenness: null, alertCount: 0 });
    const facts = glanceFacts({ fields: [field("a", 1.5, true), field("b", 2, false)], farmAreaHa: 9, hasCycle: true, model: sliderModel(view) });
    expect(facts.areaHa).toBe(1.5);
    expect(facts.fields).toEqual({ active: 1, total: 2 });
    expect(glanceFacts({ fields: [], farmAreaHa: null, hasCycle: true, model: null })).toEqual({ areaHa: null, fields: null, seasonDay: null });
  });
  it("places open steps on today and the next six days", () => {
    const rows = weekPlan(view.upcoming, view.today);
    expect(rows.every((r) => r.date >= view.today)).toBe(true);
    expect(rows.flatMap((r) => r.steps).every((s) => s.status !== "completed")).toBe(true);
  });
});

describe("at a glance without drawn fields", () => {
  it("shows 0 with the caption 'fields drawn' instead of a wrapping sentence", () => {
    const html = plain(renderToString(() => <GlancePanel facts={{ areaHa: null, fields: null, seasonDay: null }} cropName={null} hasCycle canPlant onPlant={() => {}} />));
    expect(html).toContain("0 fields drawn");
    expect(html).not.toContain("No fields drawn");
  });
});

describe("explore fields link in the at-a-glance header", () => {
  const facts = { areaHa: null, fields: null, seasonDay: null };
  it("links to the fields tab from the tile header, once", () => {
    const html = renderToString(() => <GlancePanel facts={facts} cropName="Ginger" hasCycle canPlant onPlant={() => {}} exploreHref="/farm?tab=modify" />);
    expect(html.match(/<a [^>]*href="\/farm\?tab=modify"/g)).toHaveLength(1);
    expect(plain(html)).toContain("Explore fields");
    expect(html).toContain('data-testid="today-glance-explore"');
  });
  it("shows no link when no destination is given", () => {
    expect(plain(renderToString(() => <GlancePanel facts={facts} cropName={null} hasCycle canPlant onPlant={() => {}} />))).not.toContain("Explore fields");
  });
});

describe("desktop layout has no open centre, pin or zoom buttons", () => {
  const slot = (name: string) => <section data-slot={name} />;
  const layout = () => (
    <TodayMapLayout
      headline={slot("headline")}
      centre={<MapCentre farmName="Kabini farm" exploreHref="/farm?tab=modify" />}
      glance={slot("glance")}
      hero={slot("hero")}
      outlook={slot("outlook")}
      extra={slot("extra")}
      overview={slot("overview")}
      gauges={slot("gauges")}
      attention={slot("attention")}
      week={slot("week")}
      evara={slot("evara")}
    />
  );
  it("renders two columns: main (glance, hero, outlook, extra) then right (attention, Today for you, week, field signals, Evara), without the centre", () => {
    const html = renderToString(layout);
    expect(html).toContain('data-arrangement="wide"');
    expect(html).not.toContain("today-map-centre");
    expect(html).not.toContain("today-map-pin");
    expect(html).not.toContain("today-map-controls");
    expect(html).not.toContain("Zoom in");
    expect(html).not.toContain("today-map-left");
    expect(html).not.toContain("today-more");
    const order = ["headline", "glance", "hero", "outlook", "extra", "attention", "overview", "week", "gauges", "evara"].map((n) => html.indexOf(`data-slot="${n}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const main = html.slice(html.indexOf("today-map-main"), html.indexOf("today-map-right"));
    for (const n of ["glance", "hero", "outlook", "extra"]) expect(main).toContain(`data-slot="${n}"`);
    for (const n of ["attention", "overview", "gauges"]) expect(main).not.toContain(`data-slot="${n}"`);
    const right = html.slice(html.indexOf("today-map-right"));
    for (const n of ["attention", "overview", "week", "gauges", "evara"]) expect(right).toContain(`data-slot="${n}"`);
  });
  it("sets a flexible main column, a 360px right pane, the earlier hero height and stacked field signals in the desktop CSS", () => {
    const css = readFileSync(new URL("./today-layout.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[data-arrangement="wide"\] \{ grid-template-columns: minmax\(0, 1fr\) 360px;/);
    expect(css).not.toMatch(/minmax\(160px, 1fr\)/);
    expect(css).toMatch(/\.today-hero-visual \{ aspect-ratio: 1\.65; min-height: 320px; \}/);
    // Field signals sit in the right pane, one gauge per row: never the earlier three-up row.
    expect(css).not.toMatch(/\.today-gauge-list \{ grid-template-columns: repeat\(3/);
    expect(css).toMatch(/\.today-gauge-list \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).not.toContain(".today-map-controls");
    expect(css).not.toContain(".today-more");
  });
});

describe("map centre (phone band)", () => {
  it("renders no pin, zoom buttons or credit while the map layer is not showing", () => {
    const html = renderToString(() => <MapCentre farmName="Kabini farm" exploreHref="/farm?tab=modify" />);
    expect(html).toContain('data-testid="today-map-centre"');
    expect(html).not.toContain("today-map-pin");
    expect(html).not.toContain("Zoom in");
    expect(html).not.toContain("Imagery");
  });
  it("keeps the imagery credit inside the phone band and the pin and credit clear of each other", () => {
    const css = readFileSync(new URL("./today-layout.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.today-map-credit \{ display: block; position: absolute;/);
    expect(css).toMatch(/height: max\(220px, 38vh\)/);
    expect(css).toMatch(/\[data-arrangement="compact"\]:has\(\.today-map-pin\) \.today-glance-explore \{ display: none; \}/);
  });
  it("the backdrop stays aria-hidden and non-interactive", () => {
    const source = readFileSync(new URL("../WorkspaceBackdrop.tsx", import.meta.url), "utf8");
    expect(source).toContain('class="workspace-backdrop-map" aria-hidden="true"');
    expect(source).toMatch(/dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, keyboard: false/);
    expect(source).toContain("interactive: false");
  });
});
