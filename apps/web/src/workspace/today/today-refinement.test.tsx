import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { todayFixture, FIXTURE_TODAY } from "./fixtures";
import { sliderModel, stageAt } from "./model";
import { actionItems, gaugeLine, greennessGauge, harvestNote, latestQuote, popoverNext, stageGauge } from "./todayMapModel";
import { GaugesPanel } from "./TodayMapLayout";
import { createHeroNotes, HeroNotesButton, HeroNotesPanel } from "./TodayHeroNotes";
import { TodayOutlook } from "./TodayOutlook";
import { SoilCardContext, type SoilCardController } from "./TodaySoil";

const plain = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const view = todayFixture();
const loadingSoil: SoilCardController = { state: () => ({ kind: "loading" }), dismissed: () => false, retry: () => undefined, dismiss: () => undefined };

describe("combined stage gauge", () => {
  it("reads 'Day N of M · stage' with the estimated harvest window as its second line", () => {
    const model = sliderModel(view)!;
    const gauge = stageGauge(model, 4, stageAt(view.timeline, view.today), view.timeline!.harvest);
    expect(gaugeLine(gauge)).toMatch(/^Day 4 of \d+ · /);
    expect(gauge.note).toBe(harvestNote(view.timeline!.harvest));
    expect(gauge.note).toMatch(/^Harvest .+ \(estimated\)$/);
    const html = plain(renderToString(() => <GaugesPanel gauges={[gauge]} subject="Maize" dateLabel="Today" onOpen={() => undefined} />));
    expect(html).toContain(gaugeLine(gauge));
    expect(html).toContain(gauge.note!);
    expect(stageGauge(model, 4, stageAt(view.timeline, view.today)).note).toBeNull();
  });
  it("greenness carries the crop condition headline as its note", () => {
    expect(greennessGauge(view.health, "Within the stage greenness range").note).toBe("Within the stage greenness range");
    expect(greennessGauge(view.health, null, true).basisNote).toContain("small field");
  });
});

describe("About this view popover", () => {
  it("only the button opens it; Escape, a press outside and the close button close it", () => {
    expect(popoverNext(false, "toggle")).toBe(true);
    expect(popoverNext(true, "toggle")).toBe(false);
    for (const event of ["escape", "outside", "close"] as const) {
      expect(popoverNext(true, event)).toBe(false);
      expect(popoverNext(false, event)).toBe(false);
    }
  });
  it("renders a labelled button with aria-expanded and aria-controls, and a hidden panel holding the notes", () => {
    const html = renderToString(() => {
      const notes = createHeroNotes();
      return (
        <>
          <HeroNotesButton notes={notes} />
          <HeroNotesPanel notes={notes} onAbout={() => undefined}>
            <p>Provenance sentence</p>
          </HeroNotesPanel>
        </>
      );
    });
    expect(html).toMatch(/<button[^>]*aria-label="About this view"[^>]*aria-expanded="false"/);
    const controls = html.match(/aria-controls="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`id="${controls}"[^>]*role="group"[^>]*hidden`));
    expect(plain(html)).toContain("Provenance sentence");
    expect(plain(html)).toContain("Monitoring, limitations and sources");
  });
});

describe("harvest outlook card", () => {
  const render = (v = view) =>
    renderToString(() => (
      <SoilCardContext.Provider value={loadingSoil}>
        <TodayOutlook view={v} onDetails={() => undefined} onUpload={() => undefined} onRecords={() => undefined} />
      </SoilCardContext.Provider>
    ));
  it("shows profit and residue on top, then price, soil and energy-and-carbon tiles, each figure with a basis mark", () => {
    const html = render();
    const order = ["profit", "residue", "price", "soil", "footprint"].map((k) => html.indexOf(`data-outlook="${k}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/class="today-basis-mark" data-basis="estimate"/);
    expect(html).toMatch(/class="today-basis-mark" data-basis="sourced"/);
    expect(html).toContain('role="tooltip"');
    expect(plain(html)).toContain("Regional references · not a farm measurement");
    expect(html).toContain('aria-label="Expected profit at harvest: details and sources"');
    expect(plain(html)).not.toContain("More from Today");
  });
  it("without a crop it shows only the soil tile, never an empty box", () => {
    const html = render({ ...view, cycle: null });
    expect(html).toContain('data-outlook="soil"');
    expect(html).not.toContain('data-outlook="profit"');
    expect(plain(html)).toContain("Loading your soil values");
  });
  it("names the latest recorded quote, never a reference point", () => {
    const quote = latestQuote(view.priceTrack, FIXTURE_TODAY);
    expect(quote?.kind).toBe("observed");
    expect(quote!.date <= FIXTURE_TODAY).toBe(true);
  });
});

describe("actions board order", () => {
  it("orders overdue, due, warnings, watch, upcoming, with the next action first in its group", () => {
    const ranks = actionItems(view.alerts, view.upcoming, view.upcoming[0]?.id).map((i) => i.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const step = (id: string, status: "due" | "overdue" | "upcoming") => ({ ...view.upcoming[0]!, id, status });
    const alert = (id: string, severity: "warning" | "watch") => ({ ...view.alerts[0]!, id, severity });
    const items = actionItems([alert("w", "watch"), alert("x", "warning")], [step("u", "upcoming"), step("d", "due"), step("o", "overdue"), step("d2", "due")], "d2");
    expect(items.map((i) => (i.kind === "alert" ? i.alert.id : i.step.id))).toEqual(["o", "d2", "d", "x", "w", "u"]);
  });
});
