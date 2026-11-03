import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { CHOOSE_FIELD_TO_ADD, needsFieldForNewSeason, seasonFieldLabel } from "./PlanCalendar";

/**
 * Review fix: under "All fields" on a farm with fields, "add a season" would save a whole-farm season that occupies every
 * field. The add controls are hidden with a line naming the way out, and each listed season names its field.
 */
const ws = vi.hoisted(() => ({ plans: [] as unknown[] }));
vi.mock("../state", () => ({
  today: () => "2026-11-01",
  dateLabel: (d: string) => d,
  useWorkspace: () => ({
    farm: () => ({ id: "11111111-1111-4111-8111-111111111111", name: "Test farm", location: { districtName: "Hassan" }, areaHectares: 1.2, facts: {} }),
    workspace: Object.assign(() => ({ rotationPlans: ws.plans, previousHarvest: { status: "none" } }), { loading: false }),
    crops: () => [],
    cropName: (id: string) => id,
    setNotice: () => undefined,
    saving: () => false,
    saveWorkspace: async () => undefined,
  }),
}));
vi.mock("../FarmPage", () => ({ HistoryDialog: () => null, PageHeading: (p: { title: string; children?: unknown }) => <h1>{p.title}{p.children as never}</h1> }));
const { Planner } = await import("../Planner");
const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "");
const FIELDS = [
  { id: "a", name: "North strip" },
  { id: "b", name: "South strip" },
];
const render = (fieldId: string | null, fields: typeof FIELDS | undefined) =>
  strip(renderToString(() => <Router url="/p"><Route path="/p" component={() => <Planner fieldId={fieldId} fields={fields} />} /></Router>));
const SEASONS = [
  { id: "s1", year: 2027, season: "Kharif", cropId: "maize", cropName: "Maize", plannedSowingDate: "2027-06-01", fieldId: "a" },
  { id: "s2", year: 2027, season: "Rabi", cropId: "onion", cropName: "Onion", plannedSowingDate: "2027-11-01" },
];
const ADD_CONTROLS = ["Add a season", "Plan your first season", "Add a crop or cover season"];

describe("season add control by scope", () => {
  it("is blocked only under All fields on a farm that has fields", () => {
    expect(needsFieldForNewSeason(true, null)).toBe(true);
    expect(needsFieldForNewSeason(true, undefined)).toBe(true);
    expect(needsFieldForNewSeason(true, "a")).toBe(false);
    expect(needsFieldForNewSeason(false, null)).toBe(false);
  });
  it("names each season's field, 'Whole farm' for a legacy one, and nothing in a field's own list or on a farm without fields", () => {
    expect(seasonFieldLabel({ fieldId: "b" }, FIELDS, null)).toBe("South strip");
    expect(seasonFieldLabel({}, FIELDS, null)).toBe("Whole farm");
    expect(seasonFieldLabel({ fieldId: "gone" }, FIELDS, null)).toBe("Unknown field");
    expect(seasonFieldLabel({ fieldId: "b" }, FIELDS, "b")).toBeNull();
    expect(seasonFieldLabel({}, [], null)).toBeNull();
    expect(seasonFieldLabel({}, undefined, null)).toBeNull();
  });
  it("All fields on a farm with fields: no add control anywhere, the choose-a-field line, and a field name on every row", () => {
    ws.plans = SEASONS;
    const html = render(null, FIELDS);
    for (const label of ADD_CONTROLS) expect(html).not.toContain(label);
    expect(html).toContain(CHOOSE_FIELD_TO_ADD);
    expect(html).toContain("Choose a field to add a season");
    expect(html).toContain("· North strip");
    expect(html).toContain("· Whole farm");
  });
  it("All fields with no season yet: the empty state also offers no add control", () => {
    ws.plans = [];
    const html = render(null, FIELDS);
    for (const label of ADD_CONTROLS) expect(html).not.toContain(label);
    expect(html).toContain(CHOOSE_FIELD_TO_ADD);
  });
  it("a selected field and a farm without fields keep the add controls and no choose-a-field line", () => {
    ws.plans = SEASONS;
    for (const html of [render("a", FIELDS), render(null, undefined)]) {
      expect(html).toContain("Add a season");
      expect(html).toContain("Add a crop or cover season");
      expect(html).not.toContain(CHOOSE_FIELD_TO_ADD);
    }
    expect(render("a", FIELDS)).toContain("Whole farm"); // a legacy season seen in a field's list, as before
    expect(render("a", FIELDS)).not.toContain("North strip");
  });
});
