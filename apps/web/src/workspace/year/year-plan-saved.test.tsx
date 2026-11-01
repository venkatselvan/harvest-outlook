import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import type { CropFitCandidate, YearPlanOccupant, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { FarmWorkspace, YearPlanOccupant as OccupantSchema, YearPlanReview as ReviewSchema } from "@harvest/contracts";
import { PLAN_CANDIDATES, fixtureCandidate } from "../farm/cropFitFixtures";
import type { Rotation } from "../state";

// The real picker polls the server; here it only records the props the swap sheet gives it.
const pickerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../farm/CropFitPicker", () => ({
  CropFitPicker: (props: Record<string, unknown>) => {
    pickerProps.push(props);
    return <p class="picker-stub">picker</p>;
  },
}));
// The sheet frame renders in a portal, which server rendering skips; show its parts inline so the sheet body can be read.
vi.mock("../ui/Sheet", () => ({
  Sheet: (props: { title: string; subtitle?: unknown; children?: unknown; footer?: unknown }) => (
    <section data-sheet={props.title}>
      {props.subtitle as never}
      {props.children as never}
      {props.footer as never}
    </section>
  ),
}));
import {
  FIXTURE_FARM_ID,
  FIXTURE_SAVED_SEASON_ID,
  failedSelectionReview,
  fiveOptionReview,
  fourOptionReview,
  freshReview,
  fullYearBestOverall,
  fullYearReview,
  futureReview,
  occupiedReview,
  pendingReview,
  savedSeasonOccupant,
  unavailableReview,
  workspaceWithSavedSeason,
} from "./fixtures";
import { stripPlacement } from "./format";
import {
  SWAP_CONFLICT,
  SWAP_MISSING,
  candidateOccupancy,
  candidatePlannedHarvest,
  modelUnavailable,
  occupantHint,
  occupantName,
  occupantPickChanges,
  occupantPickerCurrent,
  occupantSwapContext,
  planRebuilt,
  replacementRotationPlan,
  seasonLabelForSowing,
  selectionStatus,
  sheetItems,
  swapRefusal,
  swapSavedSeason,
} from "./model";
import { OccupantDetail, OptionSheet } from "./OptionSheet";
import { PlanCalendar, occupantLabel, stripLabel, trackItems } from "./PlanCalendar";
import { ScenarioLine } from "./ScenarioLine";
import { SwapNotice } from "./SwapNotice";
import { SwapPicker } from "./SwapSheet";

/** Text nodes of rendered markup (tags, comments and attributes removed). */
const textNodes = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** All the text of rendered markup as one string (tags and hydration comments removed). */
const plain = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** Server rendering leaves blank class names (`class="yp-strip  is-assumed"`); collapse them so class checks read plainly. */
const tidyClasses = (html: string) => html.replace(/class="([^"]*)"/g, (_m, c: string) => `class="${c.trim().replace(/\s+/g, " ")}"`);

const calendarHtml = (review: YearPlanReview) =>
  tidyClasses(
    renderToString(() => (
      <PlanCalendar
        horizonFrom={review.scenario.horizon.from}
        todayIso="2026-11-01"
        options={review.options}
        appliedOptionIds={[]}
        occupied={review.scenario.occupied ?? []}
        onOpen={() => {}}
      />
    )),
  );

const scenarioHtml = (review: YearPlanReview) =>
  renderToString(() => (
    <ScenarioLine
      text="Oct 2026 to Oct 2027 · Paddy growing until mid-Mar"
      pending={false}
      model={null}
      stale={false}
      selection={selectionStatus(review)}
      refreshing={false}
      onRefresh={() => {}}
    />
  ));

const withSelection = (review: YearPlanReview, selection: YearPlanReview["modelSelection"], extra: Partial<YearPlanReview> = {}): YearPlanReview => ({
  ...review,
  modelSelection: selection,
  ...extra,
});
const candidate = (over: Partial<CropFitCandidate> & Pick<CropFitCandidate, "cropId" | "productId" | "cropName" | "productName">) => fixtureCandidate(over);
const asRotations = (plans: unknown) => plans as Rotation[];

describe("saved-season fixtures keep the contract", () => {
  it("validate against the shared schemas", () => {
    expect(() => OccupantSchema.parse(savedSeasonOccupant)).not.toThrow();
    for (const review of [fullYearReview, failedSelectionReview]) expect(() => ReviewSchema.parse(review)).not.toThrow();
    expect(() => FarmWorkspace.parse(workspaceWithSavedSeason)).not.toThrow();
    expect(workspaceWithSavedSeason.version).toBe(4);
    expect(workspaceWithSavedSeason.rotationPlans.map((r) => r.id)).toEqual([savedSeasonOccupant.id]);
  });
  it("describe the live case: paddy alone in one calculated option, a saved pigeon pea season, Meta not needed", () => {
    expect(fullYearReview.options).toHaveLength(1);
    expect(fullYearReview.options[0]!.slots.map((s) => [s.cropId, s.fixed])).toEqual([["paddy", true]]);
    expect(fullYearReview.options[0]).toMatchObject({ label: "Best overall", origin: "deterministic" });
    expect(fullYearReview.scenario.occupied).toEqual([savedSeasonOccupant]);
    expect(fullYearReview).toMatchObject({ noFreeWindow: true, modelSelection: { outcome: "not_needed", detail: null } });
    expect(failedSelectionReview.options).toHaveLength(3);
  });
});

describe("the badge says how the plans were chosen", () => {
  it("shows 'No space for another crop' and the swap line when saved seasons fill the year, never 'Model unavailable'", () => {
    // The old origin rule would have called this a model failure: every option is calculated.
    expect(modelUnavailable(fullYearReview)).toBe(true);
    expect(selectionStatus(fullYearReview)).toEqual({
      chip: "No space for another crop",
      tone: "neutral",
      line: "Your saved seasons fill the months after the growing crop, so no new crop fits. Swap a saved crop to change the year.",
    });
    const html = scenarioHtml(fullYearReview);
    const nodes = textNodes(html);
    expect(nodes).toContain("No space for another crop");
    expect(nodes).toContain("Your saved seasons fill the months after the growing crop, so no new crop fits. Swap a saved crop to change the year.");
    expect(html).not.toContain("Model unavailable");
  });
  it("keeps 'No space for another crop' and the line for a fresh or later year that saved seasons fill completely: the server's status unavailable, no model selection, no options", () => {
    // This is what the server returns for a field with no growing crop whose saved seasons fill the year.
    const fullyTaken = (kind: "fresh" | "future"): YearPlanReview => ({
      ...fullYearReview,
      status: "unavailable",
      modelSelection: null,
      options: [],
      noFreeWindow: true,
      scenario: { ...fullYearReview.scenario, kind, currentCycleId: null },
    });
    for (const kind of ["fresh", "future"] as const) {
      expect(selectionStatus(fullyTaken(kind))).toEqual({
        chip: "No space for another crop",
        tone: "neutral",
        line: "Your saved seasons fill this year, so no new crop fits. Edit them in Saved seasons below.",
      });
    }
    const html = scenarioHtml(fullyTaken("fresh"));
    expect(textNodes(html)).toEqual(
      expect.arrayContaining(["No space for another crop", "Your saved seasons fill this year, so no new crop fits. Edit them in Saved seasons below."]),
    );
    expect(html).not.toContain("Model unavailable");
    // The flag decides before the outcome: a missing selection (older stored plan) must not hide it either.
    const { modelSelection: _drop, ...older } = fullyTaken("fresh");
    expect(selectionStatus(older)?.chip).toBe("No space for another crop");
    // Without the flag the same empty shape shows nothing, as before.
    expect(selectionStatus({ ...fullyTaken("fresh"), noFreeWindow: false })).toBeNull();
  });
  it("words the line for the growing crop plus saved seasons, and points at swapping only while a plan is drawn", () => {
    expect(selectionStatus(fullYearReview)?.line).toBe(
      "Your saved seasons fill the months after the growing crop, so no new crop fits. Swap a saved crop to change the year.",
    );
    const noPlan = { ...fullYearReview, status: "unavailable" as const, options: [] };
    expect(selectionStatus(noPlan)?.line).toBe(
      "Your saved seasons fill the months after the growing crop, so no new crop fits. Edit them in Saved seasons below.",
    );
  });
});

describe("the no-space line names what actually fills the year", () => {
  const withOccupants = (sources: YearPlanOccupant["source"][], kind: YearPlanReview["scenario"]["kind"] = "occupied", options = fullYearReview.options): YearPlanReview => ({
    ...fullYearReview,
    options,
    scenario: {
      ...fullYearReview.scenario,
      kind,
      occupied: sources.map((source, i) => ({ ...savedSeasonOccupant, id: `o${i}`, source })),
    },
  });
  const line = (review: YearPlanReview) => selectionStatus(review)?.line;

  it("says recorded crops when only recorded crops are present, and never offers a swap", () => {
    expect(line(withOccupants(["recorded_cycle"]))).toBe("Your recorded crops fill the months after the growing crop, so no new crop fits.");
    expect(line(withOccupants(["recorded_cycle", "recorded_cycle"], "fresh", []))).toBe("Your recorded crops fill this year, so no new crop fits.");
    expect(line(withOccupants(["recorded_cycle"], "future", []))).not.toContain("Saved seasons");
    expect(line(withOccupants(["recorded_cycle"]))).not.toContain("Swap a saved crop");
  });
  it("says last year's plan when only the assumed plan is present, with how to change it", () => {
    const expected = "Last year's plan fills this year, so no new crop fits. Save or change that plan to change this.";
    expect(line(withOccupants(["assumed_plan"], "future", []))).toBe(expected);
    expect(line(withOccupants(["assumed_plan"], "occupied"))).toBe(expected);
    expect(line(withOccupants(["assumed_plan"], "future", []))).not.toContain("saved seasons");
  });
  it("keeps the saved-season wording, and its swap sentence, whenever a saved season is among the occupants", () => {
    const mixed = line(withOccupants(["recorded_cycle", "saved_season", "assumed_plan"]));
    expect(mixed).toBe("Your saved seasons fill the months after the growing crop, so no new crop fits. Swap a saved crop to change the year.");
    expect(line(withOccupants(["saved_season", "assumed_plan"], "future", []))).toBe(
      "Your saved seasons fill this year, so no new crop fits. Edit them in Saved seasons below.",
    );
  });
  it("still says something true when nothing is listed (the growing crop alone leaves no window)", () => {
    expect(line(withOccupants([]))).toBe("The growing crop leaves no free months for another crop, so no new crop fits.");
    expect(line(withOccupants([], "fresh", []))).toBe("No free months are left this year, so no new crop fits.");
    const { occupied: _drop, ...scenario } = fullYearReview.scenario;
    expect(selectionStatus({ ...fullYearReview, scenario })?.chip).toBe("No space for another crop");
  });
});

describe("the badge says how the plans were chosen (continued)", () => {
  it("keeps 'Model unavailable, showing calculated plans' for a failed, unconfigured or cancelled model call", () => {
    for (const outcome of ["failed", "not_configured", "cancelled"] as const) {
      const review = withSelection(failedSelectionReview, { outcome, detail: outcome === "failed" ? "provider_timeout" : null });
      expect(selectionStatus(review)).toEqual({ chip: "Model unavailable, showing calculated plans", tone: "watch", line: null });
    }
    expect(textNodes(scenarioHtml(failedSelectionReview))).toContain("Model unavailable, showing calculated plans");
    // Outcome decides, not the option origins: a failed call is reported even when plans carry the model label.
    expect(selectionStatus(withSelection(occupiedReview, { outcome: "failed", detail: "schema_invalid" }))?.chip).toBe(
      "Model unavailable, showing calculated plans",
    );
    // With no plan on screen there are no "calculated plans" to announce.
    expect(selectionStatus(withSelection(failedSelectionReview, { outcome: "failed", detail: null }, { options: [], status: "error" }))).toBeNull();
  });
  it("says AI was not used in a mode that never calls the model", () => {
    const review = withSelection(failedSelectionReview, { outcome: "not_used", detail: null });
    expect(selectionStatus(review)).toEqual({ chip: "Calculated plans · AI not used in this mode", tone: "neutral", line: null });
    expect(textNodes(scenarioHtml(review))).toContain("Calculated plans · AI not used in this mode");
    expect(scenarioHtml(review)).not.toContain("Model unavailable");
  });
  it("says 'Only one plan fits' or 'Only two plans fit' when Meta was not needed, and nothing for three or more", () => {
    const base = withSelection(failedSelectionReview, { outcome: "not_needed", detail: null }, { noFreeWindow: false });
    expect(selectionStatus({ ...base, options: base.options.slice(0, 1) })).toEqual({ chip: "Only one plan fits", tone: "neutral", line: null });
    expect(selectionStatus({ ...base, options: base.options.slice(0, 2) })?.chip).toBe("Only two plans fit");
    expect(selectionStatus(base)).toBeNull();
    // A free-window flag that is absent (older server) is the same as false.
    const { noFreeWindow: _drop, ...without } = base;
    expect(selectionStatus({ ...without, options: without.options.slice(0, 1) })?.chip).toBe("Only one plan fits");
  });
  it("shows nothing when the model chose, or while the plan is still being built", () => {
    expect(selectionStatus(withSelection(failedSelectionReview, { outcome: "model", detail: null }))).toBeNull();
    expect(selectionStatus({ ...fullYearReview, status: "pending" })).toBeNull();
    expect(selectionStatus({ ...fullYearReview, status: "running" })).toBeNull();
    expect(selectionStatus(withSelection(pendingReview, null))).toBeNull();
  });
  it("falls back to the origin-based rule for a plan stored before modelSelection existed", () => {
    expect(unavailableReview.modelSelection).toBeUndefined();
    expect(selectionStatus(unavailableReview)).toEqual({ chip: "Model unavailable, showing calculated plans", tone: "watch", line: null });
    expect(selectionStatus(occupiedReview)).toBeNull();
    expect(selectionStatus(freshReview)).toBeNull();
    expect(selectionStatus(withSelection(unavailableReview, null))?.chip).toBe("Model unavailable, showing calculated plans");
    expect(textNodes(scenarioHtml(unavailableReview))).toContain("Model unavailable, showing calculated plans");
    expect(textNodes(scenarioHtml(occupiedReview)).join(" ")).not.toContain("Model unavailable");
  });
  it("puts the explanation line inside the polite live region with the chip, so it is announced with it", () => {
    const html = scenarioHtml(fullYearReview).replace(/<!--[^>]*-->/g, "").replace(/ data-hk="[^"]*"/g, "");
    const region = html.match(/<div class="yp-scenario-status" role="status" aria-live="polite">(.*)<\/div><\/div>$/s);
    expect(region).not.toBeNull();
    expect(region![1]).toContain("yp-selection-line");
    expect(textNodes(region![1]!)).toEqual(
      expect.arrayContaining(["No space for another crop", "Your saved seasons fill the months after the growing crop, so no new crop fits. Swap a saved crop to change the year."]),
    );
    // Once, and not as a sibling after the live region.
    expect(html.match(/yp-selection-line/g)).toHaveLength(1);
    // A chip without a line (model unavailable) draws no empty paragraph.
    expect(scenarioHtml(failedSelectionReview)).not.toContain("yp-selection-line");
  });
  it("keeps the stale notice and Refresh beside the badge", () => {
    const html = renderToString(() => (
      <ScenarioLine text="x" pending={false} model={null} stale selection={selectionStatus(fullYearReview)} refreshing={false} onRefresh={() => {}} />
    ));
    expect(textNodes(html)).toEqual(expect.arrayContaining(["No space for another crop", "Out of date", "Refresh"]));
  });
});

describe("saved seasons on the calendar", () => {
  const html = calendarHtml(fullYearReview);
  const SAVED_LABEL = "Pigeon pea, saved season, 16 May to 8 Sep. Sow 16 May 2027, harvest by 29 Aug 2027. Open details";

  it("draws the saved season in the option row with the name, 'Saved season · dates' and the accessible name", () => {
    expect(html.match(/class="yp-cal-row"/g)).toHaveLength(1);
    expect(occupantLabel(savedSeasonOccupant)).toBe(SAVED_LABEL);
    const strip = html.match(/<button[^>]*class="yp-strip is-saved"[^>]*>(.*?)<\/button>/);
    expect(strip).not.toBeNull();
    expect(strip![0]).toContain(`aria-label="${SAVED_LABEL}"`);
    expect(textNodes(strip![1]!)).toEqual(["Pigeon pea", "Saved season · 16 May to 8 Sep"]);
    // The pin is decorative: the text and the label carry the meaning.
    expect(strip![0]).toContain("<svg");
    expect(strip![0]).toContain('aria-hidden="true"');
  });
  it("places the strip from sowing to the day the field is free again, inside the 12 columns", () => {
    const place = stripPlacement("2027-05-16", "2027-09-08", "2026-10-31", 12);
    expect(place.visible).toBe(true);
    expect(place.clippedStart || place.clippedEnd).toBe(false);
    expect(html).toContain(`left:${place.left}%;width:${place.width}%`);
  });
  it("clips a season that starts before or ends after the horizon and still names it", () => {
    const early = { ...savedSeasonOccupant, sowing: "2026-08-01", occupancy: { from: "2026-08-01", to: "2026-12-15" } };
    const late = { ...savedSeasonOccupant, id: "late", sowing: "2027-09-01", occupancy: { from: "2027-09-01", to: "2028-01-20" } };
    const out = calendarHtml({ ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: [early, late] } });
    expect(out).toContain('class="yp-strip is-saved is-clipped-start"');
    expect(out).toContain('class="yp-strip is-saved is-clipped-end"');
    // A season wholly outside the horizon has no strip.
    const gone = { ...savedSeasonOccupant, sowing: "2028-02-01", occupancy: { from: "2028-02-01", to: "2028-06-01" } };
    expect(calendarHtml({ ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: [gone] } })).not.toContain('class="yp-strip is-saved');
  });
  it("starts every saved strip's accessible name with the text drawn on it (WCAG 2.5.3)", () => {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const mixed: YearPlanOccupant[] = [
      savedSeasonOccupant,
      { ...savedSeasonOccupant, id: "cycle-1", source: "recorded_cycle", sowing: "2026-12-01", occupancy: { from: "2026-12-01", to: "2027-03-20" }, harvestDate: null, occupancyBasis: "recorded" },
      { ...savedSeasonOccupant, id: "assumed:r", source: "assumed_plan", sowing: "2027-09-20", occupancy: { from: "2027-09-20", to: "2027-10-30" }, harvestDate: null, occupancyBasis: "assumed_duration" },
    ];
    const out = calendarHtml({ ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: mixed } });
    const strips = [...out.matchAll(/<button[^>]*class="yp-strip is-(?:saved|assumed)[^"]*"[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)];
    expect(strips).toHaveLength(3);
    for (const m of strips) {
      const drawn = norm(textNodes(m[2]!).join(" "));
      expect(drawn.length).toBeGreaterThan(0);
      expect(norm(m[1]!.replace(/&#39;/g, "'")).startsWith(drawn)).toBe(true);
    }
  });
  it("words recorded crops and the assumed plan in the label and on the strip, and draws the assumed one lighter", () => {
    const recorded: YearPlanOccupant = { ...savedSeasonOccupant, id: "cycle-1", source: "recorded_cycle", harvestDate: null, occupancyBasis: "recorded" };
    const assumed: YearPlanOccupant = { ...savedSeasonOccupant, id: "assumed:r", source: "assumed_plan", harvestDate: null, occupancyBasis: "assumed_duration" };
    // No harvest date: the only end is where the engine stops the occupancy, which is not a harvest date.
    expect(occupantLabel(recorded)).toBe("Pigeon pea, recorded crop, 16 May to 8 Sep. Sow 16 May 2027, field busy until 8 Sep 2027. Open details");
    expect(occupantLabel(assumed)).toBe(
      "Pigeon pea, assumed plan, 16 May to 8 Sep. Assumed from last year's plan. Sow 16 May 2027, field busy until 8 Sep 2027. Open details",
    );
    // A recorded harvest date keeps "harvest by" and names that date, not the occupancy end.
    expect(occupantLabel({ ...recorded, harvestDate: "2027-08-30" })).toBe(
      "Pigeon pea, recorded crop, 16 May to 8 Sep. Sow 16 May 2027, harvest by 30 Aug 2027. Open details",
    );
    const out = calendarHtml({ ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: [recorded, assumed] } });
    expect(textNodes(out)).toEqual(expect.arrayContaining(["Recorded crop · 16 May to 8 Sep", "Assumed plan · 16 May to 8 Sep"]));
    expect(out).toContain('class="yp-strip is-assumed"');
    expect(out.match(/class="yp-strip is-saved"/g)).toHaveLength(1);
    // Both are buttons: the sheet explains what can be done with them.
    expect(out.match(/<button[^>]*class="yp-strip is-(saved|assumed)/g)).toHaveLength(2);
  });
  it("names an intercrop 'Main + companion · ratio' and leaves a green manure its own name", () => {
    const companion = { systemId: "finger-millet-pigeon-pea-8-1", cropId: "pigeon-pea", cropName: "Pigeon pea", rowRatio: "8:1" };
    const intercrop: YearPlanOccupant = { ...savedSeasonOccupant, cropId: "finger-millet", cropName: "Finger millet", productId: "finger-millet-grain", kind: "intercrop", companion };
    expect(occupantName(intercrop)).toBe("Finger millet + pigeon pea · 8:1");
    expect(occupantLabel(intercrop)).toMatch(/^Finger millet \+ pigeon pea · 8:1, saved season, 16 May to 8 Sep\./);
    expect(occupantName({ ...intercrop, companion: { ...companion, rowRatio: "not stated" } })).toBe("Finger millet + pigeon pea");
    expect(occupantName({ ...savedSeasonOccupant, kind: "green_manure", cropName: "Cowpea (green manure)" })).toBe("Cowpea (green manure)");
  });
  it("lists 'Saved season' in the legend, and 'Assumed' only when an assumed plan is drawn", () => {
    expect(textNodes(html.slice(html.indexOf('class="yp-legend"')))).toEqual(expect.arrayContaining(["Saved season", "Growing now", "Planned crop"]));
    expect(textNodes(html.slice(html.indexOf('class="yp-legend"')))).not.toContain("Assumed");
    const assumed = { ...savedSeasonOccupant, id: "assumed:r", source: "assumed_plan" as const };
    const out = calendarHtml({ ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: [assumed] } });
    expect(textNodes(out.slice(out.indexOf('class="yp-legend"')))).toEqual(expect.arrayContaining(["Saved season", "Assumed"]));
  });
  it("draws the same saved season in every option row", () => {
    const review = { ...fourOptionReview, scenario: { ...fourOptionReview.scenario, occupied: [savedSeasonOccupant] } };
    const out = calendarHtml(review);
    expect(out.match(/class="yp-cal-row"/g)).toHaveLength(4);
    // This horizon (Sep to Sep) ends before the field is free again, so each strip is clipped at the right edge.
    expect(out.match(/class="yp-strip is-saved is-clipped-end"/g)).toHaveLength(4);
  });
  it("puts saved seasons in the Tab order by date: a crop before a saved season sown the same day, a saved season before a gap", () => {
    const option = { slots: fiveOptionReview.options[0]!.slots, gaps: [{ from: "2027-05-16", to: "2027-06-30", days: 45, reason: "x" }] };
    const items = trackItems(option, [savedSeasonOccupant]);
    expect(items.map((i) => (i.kind === "slot" ? i.slot.cropId : i.kind === "occupant" ? "saved" : "gap"))).toEqual(["paddy", "maize", "saved", "gap", "green-gram"]);
    expect(trackItems(fullYearBestOverall, [savedSeasonOccupant]).map((i) => i.kind)).toEqual(["slot", "occupant"]);
    // Without occupants the order is what it was.
    expect(trackItems(fullYearBestOverall).map((i) => i.kind)).toEqual(["slot"]);
    // In the rendered row the saved strip follows the growing crop.
    expect(html.indexOf(stripLabel(fullYearBestOverall.slots[0]!).replace(/'/g, "&#39;"))).toBeLessThan(html.indexOf(SAVED_LABEL));
  });
  it("draws one 'Saved seasons' row, read-only, when no plan is shown but saved seasons take the year", () => {
    const review = { ...fullYearReview, status: "unavailable" as const, options: [] };
    const out = calendarHtml(review);
    expect(out.match(/class="yp-cal-row yp-saved-row"/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Saved seasons"');
    const nodes = textNodes(out);
    expect(nodes).toEqual(expect.arrayContaining(["Saved seasons", "Yours", "Pigeon pea", "Saved season · 16 May to 8 Sep"]));
    // No score ring, no stretched open button, and the strip is an image with a name, not a button.
    expect(out).not.toContain("yp-row-ring");
    expect(out).not.toContain("yp-row-open");
    expect(out).not.toMatch(/<button[^>]*yp-strip/);
    expect(out).toContain('role="img" aria-label="Pigeon pea, saved season, 16 May to 8 Sep. Sow 16 May 2027, harvest by 29 Aug 2027"');
    expect(out).not.toContain("Open details");
  });
  it("draws no saved-seasons row when there are no plans and no saved seasons", () => {
    const out = calendarHtml({ ...fullYearReview, status: "unavailable", options: [], scenario: { ...fullYearReview.scenario, occupied: [] } });
    expect(out).not.toContain("yp-saved-row");
    expect(out).not.toContain('class="yp-strip is-saved');
    // Reviews from before the field existed behave the same.
    const { occupied: _drop, ...scenario } = occupiedReview.scenario;
    expect(calendarHtml({ ...occupiedReview, scenario })).not.toContain('class="yp-strip is-saved');
    expect(calendarHtml(futureReview)).not.toContain('class="yp-strip is-saved');
  });
});

describe("the saved seasons in words beside the calendar", () => {
  it("names one or two saved seasons with their dates, and counts the rest", () => {
    expect(occupantHint([savedSeasonOccupant])).toBe("Saved season: Pigeon pea 16 May to 8 Sep");
    const other = { ...savedSeasonOccupant, id: "o2", cropName: "Sunflower", sowing: "2027-01-10", occupancy: { from: "2027-01-10", to: "2027-04-20" } };
    const third = { ...savedSeasonOccupant, id: "o3", cropName: "Maize", sowing: "2027-10-01", occupancy: { from: "2027-10-01", to: "2028-01-20" } };
    expect(occupantHint([savedSeasonOccupant, other])).toBe("Saved seasons: Sunflower 10 Jan to 20 Apr; Pigeon pea 16 May to 8 Sep");
    expect(occupantHint([third, savedSeasonOccupant, other])).toBe("Saved seasons: Sunflower 10 Jan to 20 Apr; Pigeon pea 16 May to 8 Sep and 1 more");
    expect(occupantHint([])).toBeNull();
    expect(occupantHint(undefined)).toBeNull();
  });
  it("words recorded and assumed seasons for what they are", () => {
    expect(occupantHint([{ ...savedSeasonOccupant, source: "recorded_cycle" }])).toMatch(/^Recorded crop: /);
    expect(occupantHint([{ ...savedSeasonOccupant, source: "assumed_plan" }])).toMatch(/^Assumed plan: /);
    expect(occupantHint([savedSeasonOccupant, { ...savedSeasonOccupant, id: "c", source: "recorded_cycle" }])).toMatch(/^Saved and recorded: /);
  });
  it("never runs past the calendar's 90-character limit", () => {
    const companion = { systemId: "finger-millet-pigeon-pea-8-1", cropId: "pigeon-pea", cropName: "Pigeon pea", rowRatio: "8:1" };
    const long = (id: string, sowing: string) => ({ ...savedSeasonOccupant, id, kind: "intercrop" as const, cropName: "Finger millet", companion, sowing, occupancy: { from: sowing, to: "2027-09-08" } });
    const text = occupantHint([long("a", "2027-01-10"), long("b", "2027-05-16")])!;
    expect(text.length).toBeLessThanOrEqual(90);
    expect(text).toMatch(/and 1 more$/);
    const crowded = occupantHint(Array.from({ length: 5 }, (_, i) => long(`x${i}`, `2027-0${i + 1}-10`)))!;
    expect(crowded.length).toBeLessThanOrEqual(90);
  });
  it("is drawn under every option row, and under the Saved seasons row, as a note kept in view", () => {
    const html = calendarHtml(fullYearReview);
    expect(html.match(/class="yp-row-notes yp-saved-hint"/g)).toHaveLength(1);
    expect(textNodes(html)).toContain("Saved season: Pigeon pea 16 May to 8 Sep");
    const four = calendarHtml({ ...fourOptionReview, scenario: { ...fourOptionReview.scenario, occupied: [savedSeasonOccupant] } });
    expect(four.match(/yp-saved-hint/g)).toHaveLength(4);
    const savedOnly = calendarHtml({ ...fullYearReview, status: "unavailable", options: [] });
    expect(savedOnly.match(/yp-saved-hint/g)).toHaveLength(1);
    // Nothing is drawn when there are no saved seasons, and every sentence on the surface stays short.
    expect(calendarHtml(fourOptionReview)).not.toContain("yp-saved-hint");
    for (const node of textNodes(html)) expect(node.length).toBeLessThanOrEqual(90);
  });
});

describe("the option sheet lists saved seasons among the crops", () => {
  const optionSheet = (occupantId: string | null, review: YearPlanReview = fullYearReview) =>
    renderToString(() => (
      <OptionSheet
        farmId={FIXTURE_FARM_ID}
        review={review}
        option={review.options[0]!}
        slotId={null}
        occupantId={occupantId}
        applied={false}
        editing={false}
        choices={[]}
        rescoreBusy={false}
        rescoreError=""
        trend={() => undefined}
        onSelectSlot={() => {}}
        onSelectOccupant={() => {}}
        onSwapOccupant={() => {}}
        onSwapReset={() => {}}
        swapBusy={false}
        swapError=""
        onEdit={() => {}}
        onCancelEdit={() => {}}
        onRescore={() => {}}
        onUse={() => {}}
        onClose={() => {}}
      />
    ));

  it("merges slots and saved seasons by date, a crop first on a tie", () => {
    const other = { ...savedSeasonOccupant, id: "other", cropId: "sunflower", cropName: "Sunflower", sowing: "2027-01-10", occupancy: { from: "2027-01-10", to: "2027-04-20" } };
    const items = sheetItems(fiveOptionReview.options[0]!, [savedSeasonOccupant, other]);
    expect(items.map((i) => (i.kind === "slot" ? i.slot.cropId : i.occupant.cropId))).toEqual(["paddy", "maize", "sunflower", "pigeon-pea", "green-gram"]);
    expect(sheetItems(fullYearBestOverall, undefined).map((i) => i.kind)).toEqual(["slot"]);
    const tie = { ...savedSeasonOccupant, sowing: fiveOptionReview.options[0]!.slots[1]!.sowing };
    expect(sheetItems(fiveOptionReview.options[0]!, [tie]).map((i) => i.kind).slice(0, 3)).toEqual(["slot", "slot", "occupant"]);
  });
  it("shows a pill for the growing crop and for the saved season, marked 'saved', with the growing crop's panel first", () => {
    const html = optionSheet(null);
    const pills = [...html.matchAll(/<button[^>]*class="yp-slot-tab[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], ...textNodes(m[2]!)]);
    expect(pills).toEqual([
      ["true", "Paddy", "growing now"],
      ["false", "Pigeon pea", "saved"],
    ]);
    expect(html).toContain("Growing now");
    expect(html).not.toContain("Swap crop");
  });
  it("shows the saved season's panel with 'Swap crop' when its pill (or strip) is chosen", () => {
    const html = optionSheet(FIXTURE_SAVED_SEASON_ID);
    const nodes = textNodes(html);
    expect(nodes).toEqual(
      expect.arrayContaining([
        "Saved season",
        "Sow 16 May 2027 · harvest by 29 Aug 2027",
        "This season is saved on your field; the plan keeps it and works around it.",
        "Swap crop",
      ]),
    );
    expect(html).toContain('aria-label="Swap crop, Pigeon pea"');
    // The panel replaces the crop's yield, price and cost rows: a saved season has no estimates here.
    expect(nodes).not.toContain("Price at harvest");
    const pills = [...html.matchAll(/<button[^>]*class="yp-slot-tab[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], textNodes(m[2]!)[0]]);
    expect(pills).toEqual([
      ["false", "Paddy"],
      ["true", "Pigeon pea"],
    ]);
  });
  it("passes the review's stale flag to the saved season's panel", () => {
    const html = optionSheet(FIXTURE_SAVED_SEASON_ID, { ...fullYearReview, stale: true });
    expect(textNodes(html)).toContain("Refresh the plan first");
    expect(html).not.toContain('aria-label="Swap crop, Pigeon pea"');
    expect(textNodes(optionSheet(FIXTURE_SAVED_SEASON_ID))).toContain("Swap crop");
  });
  it("shows no pill row for a plan with one crop and no saved season, as before", () => {
    const html = optionSheet(null, { ...fullYearReview, scenario: { ...fullYearReview.scenario, occupied: [] } });
    expect(html).not.toContain("yp-slot-tabs");
  });
});

describe("the saved season's panel", () => {
  const render = (occupant: YearPlanOccupant, swap = occupant.source === "saved_season") =>
    renderToString(() => <OccupantDetail occupant={occupant} onSwap={swap ? () => {} : undefined} />);

  it("offers Swap crop for a saved season only, and says the plan works around it", () => {
    const html = render(savedSeasonOccupant);
    expect(html).toContain("yp-swap-button");
    expect(textNodes(html)).toEqual(
      expect.arrayContaining([
        "Pigeon pea",
        "Saved season",
        "Sow 16 May 2027 · harvest by 29 Aug 2027",
        "This season is saved on your field; the plan keeps it and works around it.",
      ]),
    );
    expect(plain(html)).toContain("The field counts as busy to 8 Sep 2027 (from your planned dates).");
  });
  it("sends a recorded crop to Farm details and an assumed plan to last year's plan, with no swap", () => {
    const recorded: YearPlanOccupant = { ...savedSeasonOccupant, id: "cycle-1", source: "recorded_cycle", harvestDate: null, occupancyBasis: "recorded" };
    const html = render(recorded);
    expect(html).not.toContain("yp-swap-button");
    const text = textNodes(html).join(" ");
    expect(text).toContain("Recorded crop");
    expect(text).toContain("Change it in Farm details.");
    // No harvest date: the occupancy end includes the buffer, so it is not called a harvest.
    expect(text).toContain("Sow 16 May 2027 · field busy until 8 Sep 2027");
    expect(text).not.toContain("harvest by");
    expect(textNodes(render({ ...recorded, harvestDate: "2027-08-30" })).join(" ")).toContain("Sow 16 May 2027 · harvest by 30 Aug 2027");
    const assumed: YearPlanOccupant = { ...savedSeasonOccupant, id: "assumed:r", source: "assumed_plan", harvestDate: null, occupancyBasis: "assumed_duration" };
    const assumedHtml = render(assumed);
    expect(assumedHtml).not.toContain("yp-swap-button");
    expect(textNodes(assumedHtml).join(" ")).toContain("Assumed from the previous year's plan; save or change that plan to change this.");
    expect(textNodes(assumedHtml)).toContain("Assumed plan");
  });
  it("replaces Swap crop with a disabled 'Refresh the plan first' when the plan is out of date", () => {
    const stale = renderToString(() => <OccupantDetail occupant={savedSeasonOccupant} onSwap={() => {}} stale />);
    const button = stale.match(/<button[^>]*class="yp-swap-button"[^>]*>/);
    expect(button).not.toBeNull();
    expect(button![0]).toContain("disabled");
    // The visible words are the accessible name (WCAG 2.5.3): no leftover "Swap crop" label.
    expect(button![0]).not.toContain("aria-label");
    expect(textNodes(stale)).toContain("Refresh the plan first");
    expect(textNodes(stale)).not.toContain("Swap crop");
    // A current plan still offers the swap, enabled.
    const current = render(savedSeasonOccupant);
    expect(current.match(/<button[^>]*class="yp-swap-button"[^>]*>/)![0]).not.toContain("disabled");
    expect(textNodes(current)).toContain("Swap crop");
    // A recorded crop never offers a swap, stale or not.
    expect(renderToString(() => <OccupantDetail occupant={{ ...savedSeasonOccupant, source: "recorded_cycle" }} stale />)).not.toContain("yp-swap-button");
  });
  it("adds the kind line for an intercrop or a green manure, and the farmer's note", () => {
    const companion = { systemId: "finger-millet-pigeon-pea-8-1", cropId: "pigeon-pea", cropName: "Pigeon pea", rowRatio: "8:1" };
    const intercrop: YearPlanOccupant = { ...savedSeasonOccupant, cropId: "finger-millet", cropName: "Finger millet", productId: "finger-millet-grain", kind: "intercrop", companion, note: "Row spacing 30 cm" };
    const text = textNodes(render(intercrop));
    expect(text).toContain("Finger millet + pigeon pea · 8:1");
    expect(text).toContain("Intercrop · Finger millet + Pigeon pea, rows 8:1");
    expect(text).toContain("Row spacing 30 cm");
    const manure = textNodes(render({ ...savedSeasonOccupant, kind: "green_manure", cropName: "Cowpea (green manure)", productId: null }));
    expect(manure).toContain("Green manure · grown and ploughed in, not harvested or sold");
  });
});

describe("swapping a saved season: picker context", () => {
  const paddy = fullYearBestOverall.slots[0]!;

  it("scores for the saved season's own sowing after the growing crop", () => {
    expect(occupantSwapContext(FIXTURE_SAVED_SEASON_ID, fullYearBestOverall, [savedSeasonOccupant], null)).toEqual({
      sowing: "2027-05-16",
      after: "paddy",
    });
  });
  it("uses the nearest earlier suggested slot, or an earlier saved season, over the growing crop", () => {
    const slots = fiveOptionReview.options[0]!.slots; // paddy 1 Sep, maize 1 Dec, green gram 20 May
    expect(occupantSwapContext(savedSeasonOccupant.id, { slots: slots.slice(0, 2) }, [savedSeasonOccupant], null)?.after).toBe("maize");
    const earlier = { ...savedSeasonOccupant, id: "earlier", cropId: "sunflower", cropName: "Sunflower", sowing: "2027-02-01", occupancy: { from: "2027-02-01", to: "2027-05-10" } };
    expect(occupantSwapContext(savedSeasonOccupant.id, { slots: slots.slice(0, 1) }, [earlier, savedSeasonOccupant], null)?.after).toBe("sunflower");
    // A slot sown after the saved season is not "before" it.
    expect(occupantSwapContext(savedSeasonOccupant.id, { slots: slots.slice(0, 1).concat(slots[2]!) }, [savedSeasonOccupant], null)?.after).toBe("paddy");
    // The saved season being swapped is never its own predecessor.
    expect(occupantSwapContext(earlier.id, fullYearBestOverall, [earlier, savedSeasonOccupant], null)?.after).toBe("paddy");
  });
  it("falls back to the scenario's previous crop when nothing comes before, and to none when that is unknown", () => {
    const first = { ...savedSeasonOccupant, sowing: "2026-10-01" };
    expect(occupantSwapContext(first.id, { slots: [{ ...paddy, sowing: "2026-10-31" }] }, [first], "maize")).toEqual({ sowing: "2026-10-01", after: "maize" });
    expect(occupantSwapContext(first.id, { slots: [{ ...paddy, sowing: "2026-10-31" }] }, [first], null)).toEqual({ sowing: "2026-10-01", after: null });
    expect(occupantSwapContext("missing", fullYearBestOverall, [savedSeasonOccupant], null)).toBeNull();
    expect(occupantSwapContext(savedSeasonOccupant.id, fullYearBestOverall, undefined, null)).toBeNull();
  });
  it("passes the current crop, product and system, and none for a green manure or an unknown product", () => {
    expect(occupantPickerCurrent(savedSeasonOccupant)).toEqual({ cropId: "pigeon-pea", productId: "pigeon-pea-whole", systemId: null });
    const companion = { systemId: "finger-millet-pigeon-pea-8-1", cropId: "pigeon-pea", cropName: "Pigeon pea", rowRatio: "8:1" };
    expect(occupantPickerCurrent({ ...savedSeasonOccupant, cropId: "finger-millet", productId: "finger-millet-grain", kind: "intercrop", companion })).toEqual({
      cropId: "finger-millet",
      productId: "finger-millet-grain",
      systemId: "finger-millet-pigeon-pea-8-1",
    });
    expect(occupantPickerCurrent({ ...savedSeasonOccupant, kind: "green_manure" })).toBeNull();
    expect(occupantPickerCurrent({ ...savedSeasonOccupant, productId: null })).toBeNull();
  });
  it("gives the picker sowing, after and current, and says the saved season is changed and the plan rebuilt by code", () => {
    pickerProps.length = 0;
    const context = occupantSwapContext(FIXTURE_SAVED_SEASON_ID, fullYearBestOverall, [savedSeasonOccupant], null)!;
    const note = "After you pick, the saved season on your field is changed and the year plan is rebuilt by code, not by AI.";
    const html = renderToString(() => (
      <SwapPicker farmId={FIXTURE_FARM_ID} context={context} current={occupantPickerCurrent(savedSeasonOccupant)} note={note} onPick={() => {}} onClose={() => {}} />
    ));
    expect(pickerProps).toHaveLength(1);
    expect(pickerProps[0]).toMatchObject({
      farmId: FIXTURE_FARM_ID,
      sowing: "2027-05-16",
      after: "paddy",
      current: { cropId: "pigeon-pea", productId: "pigeon-pea-whole", systemId: null },
    });
    expect(textNodes(html)).toContain(note);
    expect(textNodes(html).join(" ")).not.toContain("re-scored by code");
    expect(html).not.toContain("disabled");
  });
  it("keeps the old line for a suggested slot, tells the picker it is saving (it keeps Cancel usable) and shows a failure", () => {
    const context = { sowing: "2027-05-16", after: "paddy" };
    pickerProps.length = 0;
    const idle = renderToString(() => <SwapPicker farmId={FIXTURE_FARM_ID} context={context} current={null} onPick={() => {}} onClose={() => {}} />);
    expect(textNodes(idle)).toContain("After you pick, the plan is re-scored by code, not by AI.");
    expect(pickerProps.at(-1)).toMatchObject({ busy: false });
    expect(idle).toContain('aria-busy="false"');
    pickerProps.length = 0;
    const busy = renderToString(() => <SwapPicker farmId={FIXTURE_FARM_ID} context={context} current={null} busy onPick={() => {}} onClose={() => {}} />);
    // No fieldset: a disabled fieldset would also disable the picker's own Cancel button, and its role="presentation" fought aria-busy.
    expect(busy).not.toContain("<fieldset");
    expect(busy).not.toContain('role="presentation"');
    expect(busy).toContain('aria-busy="true"');
    expect(pickerProps.at(-1)).toMatchObject({ busy: true });
    expect(textNodes(busy)).toContain("Saving the swap…");
    const failed = renderToString(() => <SwapPicker farmId={FIXTURE_FARM_ID} context={context} current={null} error={SWAP_CONFLICT} onPick={() => {}} onClose={() => {}} />);
    expect(failed).toContain('role="alert"');
    expect(textNodes(failed)).toContain(SWAP_CONFLICT);
    expect(failed).toContain('aria-busy="false"');
  });
});

describe("swapping a saved season: what is saved", () => {
  const stored = asRotations(workspaceWithSavedSeason.rotationPlans);
  const paddy = fullYearBestOverall.slots[0]!; // growing, field busy 31 Oct 2026 to 25 Mar 2027
  const TODAY = "2026-11-01";
  const CHANGE = { fromCropName: "Pigeon pea", todayIso: TODAY };
  // Sown after the paddy leaves the field and clear of every other season, so the pre-save checks pass.
  const sunflower = candidate({
    cropId: "sunflower",
    productId: "sunflower-seed",
    cropName: "Sunflower",
    productName: "Seed",
    establishmentMethod: "transplanting",
    sowing: "2027-04-01",
    harvest: { earliest: "2027-07-05", latest: "2027-07-25" },
  });
  type Extra = { todayIso?: string; fixedSlot?: Pick<YearPlanSlot, "cropName" | "occupancy"> | null; occupied?: YearPlanOccupant[] };
  const run = (candidateToPick: CropFitCandidate, plans: readonly Rotation[] = stored, save = vi.fn().mockResolvedValue({}), extra: Extra = {}) =>
    swapSavedSeason({
      occupant: savedSeasonOccupant,
      candidate: candidateToPick,
      rotationPlans: plans,
      todayIso: TODAY,
      fixedSlot: paddy,
      occupied: [savedSeasonOccupant],
      save,
      ...extra,
    }).then((result) => ({ result, save }));

  it("replaces crop, product, dates, year and season of the saved season, keeping its id, and saves the whole list once", async () => {
    const { result, save } = await run(sunflower);
    expect(result).toEqual({ kind: "saved", from: "Pigeon pea", to: "Sunflower" });
    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0]![0] as { rotationPlans: Rotation[] };
    expect(patch.rotationPlans).toHaveLength(1);
    expect(patch.rotationPlans[0]).toEqual({
      id: FIXTURE_SAVED_SEASON_ID,
      // The apply-written notes carried the pigeon pea's yield, price and cost; they are replaced.
      notes: "Crop changed from Pigeon pea to Sunflower in the year plan on 1 Nov 2026; the earlier plan's figures no longer apply. Dates are calculated references, not predictions.",
      cropId: "sunflower",
      cropName: "Sunflower",
      productId: "sunflower-seed",
      productName: "Seed",
      establishmentMethod: "transplanting",
      kind: "crop",
      plannedSowingDate: "2027-04-01",
      plannedHarvestDate: "2027-07-25",
      year: 2027,
      season: "Summer",
    });
    // What goes to the server is a valid workspace (year follows the sowing year, harvest after sowing).
    expect(() => FarmWorkspace.parse({ ...workspaceWithSavedSeason, rotationPlans: patch.rotationPlans })).not.toThrow();
    // The stored list is not edited in place.
    expect(stored[0]!.cropId).toBe("pigeon-pea");
    expect(stored[0]!.notes).toMatch(/^Year plan "Best overall"/);
  });
  it("leaves the other saved seasons as they were, in the same order", async () => {
    const other: Rotation = { id: "other", year: 2026, season: "Rabi", cropId: "maize", plannedSowingDate: "2026-12-01" };
    const { save } = await run(sunflower, [other, ...stored, { ...other, id: "third" }]);
    const patch = save.mock.calls[0]![0] as { rotationPlans: Rotation[] };
    expect(patch.rotationPlans.map((r) => r.id)).toEqual(["other", FIXTURE_SAVED_SEASON_ID, "third"]);
    expect(patch.rotationPlans[0]).toEqual(other);
    expect(patch.rotationPlans[2]).toEqual({ ...other, id: "third" });
  });
  it("maps the new sowing month to the season names the server's apply writes and takes the year from the sowing date", () => {
    // Feb to Apr "Summer" (not "Zaid"), May to Aug "Kharif", Sep to Jan "Rabi", as the server's capitalised seasonOfMonth.
    expect(seasonLabelForSowing("2027-02-10")).toBe("Summer");
    expect(seasonLabelForSowing("2027-04-30")).toBe("Summer");
    expect(seasonLabelForSowing("2027-05-16")).toBe("Kharif");
    expect(seasonLabelForSowing("2027-08-31")).toBe("Kharif");
    expect(seasonLabelForSowing("2027-09-01")).toBe("Rabi");
    expect(seasonLabelForSowing("2026-12-20")).toBe("Rabi");
    expect(seasonLabelForSowing("2027-01-15")).toBe("Rabi");
    const next = replacementRotationPlan(
      stored[0]!,
      candidate({ cropId: "chickpea", productId: "chickpea-whole", cropName: "Chickpea", productName: "Whole", sowing: "2026-11-20", harvest: { earliest: "2027-02-20", latest: "2027-03-05" } }),
      CHANGE,
    );
    expect(next).toMatchObject({ year: 2026, season: "Rabi", plannedSowingDate: "2026-11-20", plannedHarvestDate: "2027-03-05" });
  });
  it("removes the old establishment method when the candidate names none, and the companion when the new crop is a sole crop", async () => {
    const intercropStored: Rotation = {
      ...stored[0]!,
      kind: "intercrop",
      establishmentMethod: "transplanting",
      companion: { systemId: "s", cropId: "pigeon-pea", rowRatio: "8:1" },
    };
    const next = replacementRotationPlan(intercropStored, candidate({ cropId: "sorghum", productId: "sorghum-grain", cropName: "Sorghum", productName: "Grain", establishmentMethod: null }), CHANGE);
    expect("establishmentMethod" in next).toBe(false);
    expect("companion" in next).toBe(false);
    expect(next.kind).toBe("crop");
    expect(next.id).toBe(intercropStored.id);
  });
  it("turns an intercrop candidate into an intercrop season with its companion", async () => {
    const intercrop = PLAN_CANDIDATES.find((c) => c.kind === "intercrop" && c.companion)!;
    const { result, save } = await run(intercrop);
    expect(result.kind).toBe("saved");
    const saved = (save.mock.calls[0]![0] as { rotationPlans: Rotation[] }).rotationPlans[0]!;
    expect(saved).toMatchObject({
      kind: "intercrop",
      cropId: intercrop.cropId,
      productId: intercrop.productId,
      companion: {
        systemId: intercrop.companion!.systemId,
        cropId: intercrop.companion!.cropId,
        cropName: intercrop.companion!.cropName,
        productId: intercrop.companion!.productId,
        productName: intercrop.companion!.productName,
        rowRatio: intercrop.companion!.rowRatio,
      },
    });
    expect(() => FarmWorkspace.parse({ ...workspaceWithSavedSeason, rotationPlans: [saved] })).not.toThrow();
  });
  it("only closes when the pick is the crop, product, system and sowing the saved season already has", async () => {
    const same = candidate({ cropId: "pigeon-pea", productId: "pigeon-pea-whole", cropName: "Pigeon pea", productName: "Whole", sowing: "2027-05-16" });
    expect(occupantPickChanges(savedSeasonOccupant, same)).toBe(false);
    const { result, save } = await run(same);
    expect(result).toEqual({ kind: "unchanged" });
    expect(save).not.toHaveBeenCalled();
    // The same crop on another sowing date is a change; so is the same crop as an intercrop.
    expect(occupantPickChanges(savedSeasonOccupant, { ...same, sowing: "2027-06-01" })).toBe(true);
    const asIntercrop = PLAN_CANDIDATES.find((c) => c.kind === "intercrop" && c.companion)!;
    expect(occupantPickChanges({ ...savedSeasonOccupant, cropId: asIntercrop.cropId, productId: asIntercrop.productId, sowing: asIntercrop.sowing }, asIntercrop)).toBe(true);
    // A green manure is never "the same" as a crop.
    expect(occupantPickChanges({ ...savedSeasonOccupant, kind: "green_manure" }, same)).toBe(true);
  });
  it("stops with a reload message, saving nothing, when the saved season is no longer on the field", async () => {
    const { result, save } = await run(sunflower, []);
    expect(result).toEqual({ kind: "missing", message: "This saved season is no longer on the field; reload." });
    expect(SWAP_MISSING).toBe("This saved season is no longer on the field; reload.");
    expect(save).not.toHaveBeenCalled();
    const elsewhere = await run(sunflower, [{ ...stored[0]!, id: "yearplan:other" }]);
    expect(elsewhere.result.kind).toBe("missing");
    expect(elsewhere.save).not.toHaveBeenCalled();
  });
  it("reports a version conflict as 'changed elsewhere' and any other failure with its own message", async () => {
    const conflict = await run(sunflower, stored, vi.fn().mockRejectedValue(Object.assign(new Error("stale"), { status: 409, code: "version_conflict" })));
    expect(conflict.result).toEqual({ kind: "failed", message: "Saved seasons changed elsewhere; reload and try again." });
    const byCode = await run(sunflower, stored, vi.fn().mockRejectedValue({ code: "version_conflict" }));
    expect(byCode.result).toEqual({ kind: "failed", message: SWAP_CONFLICT });
    const other = await run(sunflower, stored, vi.fn().mockRejectedValue(new Error("Please wait for the current save to finish.")));
    expect(other.result).toEqual({ kind: "failed", message: "Please wait for the current save to finish." });
    const bare = await run(sunflower, stored, vi.fn().mockRejectedValue("boom"));
    expect(bare.result).toEqual({ kind: "failed", message: "The saved season could not be changed. Try again." });
  });
});

describe("swapping a saved season: the date the saved season keeps the field until", () => {
  const stored = asRotations(workspaceWithSavedSeason.rotationPlans);
  const CHANGE = { fromCropName: "Pigeon pea", todayIso: "2026-11-01" };
  const intercrop = (companionHarvest: CropFitCandidate["companionHarvest"]) =>
    PLAN_CANDIDATES.filter((c) => c.kind === "intercrop" && c.companion).map((c) => ({
      ...c,
      sowing: "2027-04-01",
      harvest: { earliest: "2027-07-01", latest: "2027-07-20" },
      companionHarvest,
    }))[0]!;

  it("writes the companion's harvest when the companion is harvested after the main crop, because the field stays busy until then", () => {
    const later = intercrop({ earliest: "2027-09-10", latest: "2027-09-30" });
    expect(candidatePlannedHarvest(later)).toBe("2027-09-30");
    const saved = replacementRotationPlan(stored[0]!, later, CHANGE);
    expect(saved.kind).toBe("intercrop");
    expect(saved.plannedHarvestDate).toBe("2027-09-30");
    expect(() => FarmWorkspace.parse({ ...workspaceWithSavedSeason, rotationPlans: [saved] })).not.toThrow();
  });
  it("writes the main crop's harvest when the companion is not harvested later (earlier, the same day, or not given)", () => {
    for (const companionHarvest of [{ earliest: "2027-06-20", latest: "2027-07-10" }, { earliest: "2027-07-01", latest: "2027-07-20" }, null, undefined] as const) {
      const c = intercrop(companionHarvest as CropFitCandidate["companionHarvest"]);
      expect(candidatePlannedHarvest(c)).toBe("2027-07-20");
      expect(replacementRotationPlan(stored[0]!, c, CHANGE).plannedHarvestDate).toBe("2027-07-20");
    }
  });
  it("never lets a sole crop take a companion date, and keeps the main harvest for a plain crop", () => {
    const sole = candidate({ cropId: "sunflower", productId: "sunflower-seed", cropName: "Sunflower", productName: "Seed", sowing: "2027-04-01", harvest: { earliest: "2027-07-05", latest: "2027-07-25" } });
    expect(sole.companionHarvest).toBeNull();
    expect(replacementRotationPlan(stored[0]!, sole, CHANGE).plannedHarvestDate).toBe("2027-07-25");
  });
});

describe("swapping a saved season: the notes", () => {
  const stored = asRotations(workspaceWithSavedSeason.rotationPlans);
  const CHANGE = { fromCropName: "Pigeon pea", todayIso: "2026-11-01" };
  const sunflower = candidate({ cropId: "sunflower", productId: "sunflower-seed", cropName: "Sunflower", productName: "Seed", sowing: "2027-04-01", harvest: { earliest: "2027-07-05", latest: "2027-07-25" } });
  const EXPECTED =
    "Crop changed from Pigeon pea to Sunflower in the year plan on 1 Nov 2026; the earlier plan's figures no longer apply. Dates are calculated references, not predictions.";

  it("replaces notes the year plan's apply wrote, which carry the old crop's yield, price and cost", () => {
    expect(stored[0]!.notes).toContain("Yield 70-110 kg/ha");
    const next = replacementRotationPlan(stored[0]!, sunflower, CHANGE);
    expect(next.notes).toBe(EXPECTED);
    expect(next.notes).not.toContain("kg/ha");
    expect(next.notes).not.toContain("INR");
    // The green-manure variant of the apply notes starts the same way.
    expect(replacementRotationPlan({ ...stored[0]!, notes: 'Year plan "Green manure first" (deterministic) from review x. Green manure: sow 2027-05-16.' }, sunflower, CHANGE).notes).toBe(EXPECTED);
  });
  it("keeps notes the farmer wrote, and leaves a season without notes without notes", () => {
    const written = "Sown after the first good rain; neighbour shares the borewell.";
    expect(replacementRotationPlan({ ...stored[0]!, notes: written }, sunflower, CHANGE).notes).toBe(written);
    // Only the exact apply prefix counts: a farmer's own line that merely mentions the plan stays.
    expect(replacementRotationPlan({ ...stored[0]!, notes: "Year plan idea from the co-op" }, sunflower, CHANGE).notes).toBe("Year plan idea from the co-op");
    const { notes: _drop, ...bare } = stored[0]!;
    expect("notes" in replacementRotationPlan(bare, sunflower, CHANGE)).toBe(false);
  });
  it("saves the replaced notes through swapSavedSeason, and the farmer's notes untouched", async () => {
    const save = vi.fn().mockResolvedValue({});
    const args = { occupant: savedSeasonOccupant, candidate: sunflower, todayIso: "2026-11-01", fixedSlot: null, occupied: [savedSeasonOccupant], save };
    await swapSavedSeason({ ...args, rotationPlans: stored });
    expect((save.mock.calls[0]![0] as { rotationPlans: Rotation[] }).rotationPlans[0]!.notes).toBe(EXPECTED);
    await swapSavedSeason({ ...args, rotationPlans: [{ ...stored[0]!, notes: "Mine" }] });
    expect((save.mock.calls[1]![0] as { rotationPlans: Rotation[] }).rotationPlans[0]!.notes).toBe("Mine");
  });
});

describe("swapping a saved season: checks before saving, the ones the server's apply makes", () => {
  const stored = asRotations(workspaceWithSavedSeason.rotationPlans);
  const paddy = fullYearBestOverall.slots[0]!; // field busy 31 Oct 2026 to 25 Mar 2027
  const TODAY = "2026-11-01";
  const groundnutNeighbour: YearPlanOccupant = {
    ...savedSeasonOccupant,
    id: "yearplan:neighbour",
    cropId: "groundnut",
    cropName: "Groundnut",
    sowing: "2027-08-01",
    occupancy: { from: "2027-08-01", to: "2027-11-30" },
  };
  const pick = (over: Partial<CropFitCandidate> = {}) =>
    candidate({
      cropId: "sunflower",
      productId: "sunflower-seed",
      cropName: "Sunflower",
      productName: "Seed",
      sowing: "2027-04-01",
      harvest: { earliest: "2027-07-05", latest: "2027-07-25" },
      ...over,
    });
  const refusal = (c: CropFitCandidate, occupied: YearPlanOccupant[] = [savedSeasonOccupant], fixedSlot: typeof paddy | null = paddy, todayIso = TODAY) =>
    swapRefusal({ occupant: savedSeasonOccupant, candidate: c, todayIso, fixedSlot, occupied });
  const swap = async (c: CropFitCandidate, occupied: YearPlanOccupant[] = [savedSeasonOccupant]) => {
    const save = vi.fn().mockResolvedValue({});
    const result = await swapSavedSeason({ occupant: savedSeasonOccupant, candidate: c, rotationPlans: stored, todayIso: TODAY, fixedSlot: paddy, occupied, save });
    return { result, save };
  };

  it("passes a crop sown from today, after the growing crop and clear of the other seasons", async () => {
    expect(refusal(pick())).toBeNull();
    const { result, save } = await swap(pick());
    expect(result.kind).toBe("saved");
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("refuses a sowing date that has passed, naming it, and saves nothing", async () => {
    const message = "The sowing date 15 Oct 2026 has passed; pick a crop that can still be sown.";
    expect(refusal(pick({ sowing: "2026-10-15" }))).toBe(message);
    const { result, save } = await swap(pick({ sowing: "2026-10-15" }));
    expect(result).toEqual({ kind: "refused", message });
    expect(save).not.toHaveBeenCalled();
  });
  it("accepts sowing today, and checks the passed date before any overlap", () => {
    // Today is not "passed"; this one is refused for the growing crop, not for its date.
    expect(refusal(pick({ sowing: TODAY }))).toMatch(/would overlap the growing/);
    expect(refusal(pick({ sowing: "2026-10-31" }))).toMatch(/^The sowing date 31 Oct 2026 has passed/);
  });
  it("refuses a crop that overlaps the growing crop, with the date the field is held until", async () => {
    const c = pick({ sowing: "2027-03-01", harvest: { earliest: "2027-06-05", latest: "2027-06-25" } });
    const message = "Sunflower would overlap the growing Paddy, which is expected to hold the field until 25 Mar 2027.";
    expect(refusal(c)).toBe(message);
    const { result, save } = await swap(c);
    expect(result).toEqual({ kind: "refused", message });
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses a crop that overlaps another saved season or recorded crop, naming it and its dates", async () => {
    // Sown 1 Apr, harvest to 25 Jul, field busy to 4 Aug: it runs into the groundnut sown 1 Aug.
    const message = "Sunflower would overlap Groundnut (1 Aug to 30 Nov). Pick a shorter crop or change that season first.";
    expect(refusal(pick(), [savedSeasonOccupant, groundnutNeighbour])).toBe(message);
    const { result, save } = await swap(pick(), [savedSeasonOccupant, groundnutNeighbour]);
    expect(result).toEqual({ kind: "refused", message });
    expect(save).not.toHaveBeenCalled();
    // Any source blocks it: a recorded crop or last year's assumed plan too.
    for (const source of ["recorded_cycle", "assumed_plan"] as const)
      expect(refusal(pick(), [savedSeasonOccupant, { ...groundnutNeighbour, source }])).toBe(message);
    // The first one in date order is named.
    const earlier = { ...groundnutNeighbour, id: "e", cropName: "Mustard", sowing: "2027-07-20", occupancy: { from: "2027-07-20", to: "2027-09-01" } };
    expect(refusal(pick(), [groundnutNeighbour, earlier, savedSeasonOccupant])).toMatch(/^Sunflower would overlap Mustard \(20 Jul to 1 Sep\)\./);
  });
  it("never counts the season being swapped as an obstacle: its own months are being replaced", async () => {
    // Sown 20 May, inside the saved pigeon pea season (16 May to 8 Sep), which is the one being swapped.
    const inside = pick({ sowing: "2027-05-20", harvest: { earliest: "2027-08-01", latest: "2027-08-20" } });
    expect(refusal(inside)).toBeNull();
    expect((await swap(inside)).result.kind).toBe("saved");
  });
  it("uses the engine's half-open rule: a crop may start the day the other is released, and end the day the next begins", () => {
    // Growing paddy releases the field on 25 Mar: sowing that day does not overlap, the day before does.
    expect(refusal(pick({ sowing: "2027-03-25", occupancy: { from: "2027-03-25", to: "2027-08-01" } }), [savedSeasonOccupant, groundnutNeighbour])).toBeNull();
    expect(refusal(pick({ sowing: "2027-03-24", occupancy: { from: "2027-03-24", to: "2027-08-01" } }))).toMatch(/would overlap the growing/);
    // Groundnut begins 1 Aug: occupancy ending 1 Aug is clear, 2 Aug is not.
    expect(refusal(pick({ occupancy: { from: "2027-04-01", to: "2027-08-01" } }), [savedSeasonOccupant, groundnutNeighbour])).toBeNull();
    expect(refusal(pick({ occupancy: { from: "2027-04-01", to: "2027-08-02" } }), [savedSeasonOccupant, groundnutNeighbour])).toMatch(/would overlap Groundnut/);
  });
  it("checks the engine's occupancy, so a companion harvested later (or the land-preparation gap) counts", () => {
    // Main crop harvested 20 Jul (clear of the groundnut sown 1 Aug even with the gap) but its companion on 30 Sep.
    const intercrop = PLAN_CANDIDATES.find((c) => c.kind === "intercrop" && c.companion)!;
    const late = { ...intercrop, sowing: "2027-04-01", harvest: { earliest: "2027-07-01", latest: "2027-07-20" }, companionHarvest: { earliest: "2027-09-10", latest: "2027-09-30" } };
    expect(candidateOccupancy({ ...late, occupancy: { from: "2027-04-01", to: "2027-10-10" } })).toEqual({ from: "2027-04-01", to: "2027-10-10" });
    expect(refusal({ ...late, occupancy: { from: "2027-04-01", to: "2027-10-10" } }, [savedSeasonOccupant, groundnutNeighbour])).toMatch(/would overlap Groundnut/);
    const early = { ...late, companionHarvest: { earliest: "2027-07-01", latest: "2027-07-20" }, occupancy: { from: "2027-04-01", to: "2027-07-30" } };
    expect(refusal(early, [savedSeasonOccupant, groundnutNeighbour])).toBeNull();
  });
  it("falls back to sowing to the planned harvest when the server sends no occupancy", () => {
    const { occupancy: _drop, ...without } = pick({ sowing: "2027-03-01", harvest: { earliest: "2027-06-05", latest: "2027-06-25" } });
    expect(candidateOccupancy(without)).toEqual({ from: "2027-03-01", to: "2027-06-25" });
    expect(refusal(without)).toMatch(/would overlap the growing/);
    const { occupancy: _also, ...clear } = pick();
    expect(refusal(clear)).toBeNull();
    // An intercrop without occupancy falls back to the later companion harvest.
    const { occupancy: _o3, ...lateIntercrop } = {
      ...PLAN_CANDIDATES.find((c) => c.kind === "intercrop" && c.companion)!,
      sowing: "2027-04-01",
      harvest: { earliest: "2027-07-01", latest: "2027-07-20" },
      companionHarvest: { earliest: "2027-09-10", latest: "2027-09-30" },
    };
    expect(candidateOccupancy(lateIntercrop)).toEqual({ from: "2027-04-01", to: "2027-09-30" });
    expect(refusal(lateIntercrop, [savedSeasonOccupant, groundnutNeighbour])).toMatch(/would overlap Groundnut/);
  });
  it("checks only what is there: no growing crop (a fresh field) and no other seasons leave nothing to overlap", () => {
    expect(refusal(pick({ sowing: "2026-11-05", harvest: { earliest: "2027-02-01", latest: "2027-02-20" } }), [savedSeasonOccupant], null)).toBeNull();
    expect(refusal(pick(), [])).toBeNull();
  });
});

describe("after a swap the plan is reported honestly", () => {
  it("counts a ready or partial plan, and the server's own 'no space' answer, as rebuilt, and nothing else", () => {
    expect(planRebuilt({ status: "ready" })).toBe(true);
    expect(planRebuilt({ status: "partial" })).toBe(true);
    // A fully taken fresh or later year: nothing to show, but the plan was rebuilt and says so.
    expect(planRebuilt({ status: "unavailable", noFreeWindow: true })).toBe(true);
    expect(planRebuilt({ status: "unavailable" })).toBe(false);
    expect(planRebuilt({ status: "unavailable", noFreeWindow: false })).toBe(false);
    expect(planRebuilt({ status: "error", noFreeWindow: true })).toBe(false);
    expect(planRebuilt({ status: "pending" })).toBe(false);
    expect(planRebuilt({ status: "running" })).toBe(false);
  });
  const notice = (over: Partial<Parameters<typeof SwapNotice>[0]>) =>
    plain(renderToString(() => <SwapNotice from="Pigeon pea" to="Sunflower" rebuilding={false} rebuilt failed={false} onHide={() => {}} {...over} />));
  it("says 'The plan has been rebuilt.' only for a rebuilt plan", () => {
    expect(notice({})).toBe("Pigeon pea swapped for Sunflower in your saved seasons. The plan has been rebuilt.Hide");
  });
  it("says the plan could not be rebuilt, pointing at the message, when the new review is not a plan", () => {
    const text = notice({ rebuilt: false });
    expect(text).toContain("Pigeon pea swapped for Sunflower in your saved seasons. The plan could not be rebuilt; see the message below.");
    expect(text).not.toContain("has been rebuilt");
  });
  it("says it is rebuilding while the reload runs, even before the plan is known to be a plan", () => {
    const text = notice({ rebuilding: true, rebuilt: false });
    expect(text).toContain("Rebuilding the plan…");
    expect(text).not.toContain("could not be rebuilt");
    expect(text).not.toContain("has been rebuilt");
  });
  it("leaves the outcome to the error line when the reload itself failed", () => {
    const text = notice({ failed: true, rebuilt: false });
    expect(text).toContain("Pigeon pea swapped for Sunflower in your saved seasons.");
    expect(text).not.toContain("rebuilt");
  });
});
