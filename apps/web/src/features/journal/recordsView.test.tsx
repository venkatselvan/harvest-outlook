import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStringAsync } from "solid-js/web";
import { Suspense } from "solid-js";

/*
 * The Journal tab's "Harvest and inputs" section, rendered with the real JournalWorkspace component (and, for the band, the
 * RecordsSection itself). Workspace state and the journal API are stubbed with synthetic values; nothing here is a live response.
 */

const state = vi.hoisted(() => ({
  farm: { id: "farm-1", name: "Test farm" } as { id: string; name: string } | null,
  cycles: [] as Record<string, unknown>[],
  fields: [] as Record<string, unknown>[],
  timeline: { farmId: "farm-1", entries: [] as Record<string, unknown>[] },
}));

vi.mock("../../workspace/state", () => ({
  useWorkspace: () => ({
    farm: () => state.farm,
    workspace: Object.assign(() => ({ cycles: state.cycles, fields: state.fields, version: 1, boundary: null, previousHarvest: { status: "unknown" }, rotationPlans: [] }), { loading: false }),
    crops: () => [],
    cropName: (id: string) => id.charAt(0).toUpperCase() + id.slice(1),
    sessionEpoch: () => 1,
    refreshWorkspace: async () => undefined,
    setNotice: () => undefined,
  }),
  today: () => "2026-11-01",
  dateLabel: (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
}));
vi.mock("../../workspace/FarmPage", () => ({ PageHeading: (p: { title: string }) => <h1>{p.title}</h1> }));
vi.mock("@solidjs/router", () => ({ A: (p: { href: string; children?: unknown }) => <a href={p.href}>{p.children as never}</a> }));
vi.mock("./api", () => ({
  loadTimeline: async () => state.timeline,
  submitDraft: async () => undefined,
}));

import { JournalWorkspace } from "../../workspace/Journal";
import { RecordsSection } from "./RecordsSection";
import { cycleRecords } from "./records";
import { polygonAreaHa } from "../../workspace/fields/fieldsModel";

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = async () => text(await renderToStringAsync(() => <Suspense><JournalWorkspace /></Suspense>));
const cycle = (over: Record<string, unknown> = {}) => ({ id: "c1", cropId: "ginger", cropName: "Ginger", sowingDate: "2026-04-01", stage: "growing", ...over });
const entry = (observedOn: string, over: Record<string, unknown> = {}) => ({ id: observedOn + String(over.activity), observedOn, activity: "observation", note: "x", media: [], quantity: null, expense: null, sale: null, provenanceLabel: "Recorded by you", ...over });
// A 0.001 degree square near 10 N (about 1.2 ha); the test derives the expected figures from the same area helper the page uses.
const square = { type: "Polygon", coordinates: [[[77, 10], [77.001, 10], [77.001, 10.001], [77, 10.001], [77, 10]]] };

beforeEach(() => {
  state.farm = { id: "farm-1", name: "Test farm" };
  state.cycles = [];
  state.fields = [];
  state.timeline = { farmId: "farm-1", entries: [] };
});

describe("Harvest and inputs section", () => {
  it("shows nothing without crop records", async () => {
    state.timeline = { farmId: "farm-1", entries: [entry("2026-10-31", { activity: "harvest", quantity: { value: 5, unit: "kg" } })] };
    expect(await render()).not.toContain("Harvest and inputs");
  });

  it("does not show another farm's records", async () => {
    state.cycles = [cycle()];
    state.timeline = { farmId: "other-farm", entries: [entry("2026-10-31", { activity: "harvest", quantity: { value: 777, unit: "kg" } })] };
    const t = await render();
    expect(t).not.toContain("Harvest and inputs");
    expect(t).not.toContain("777");
  });

  it("renders one card per cycle with pickings, running total, water, fertiliser and the labels", async () => {
    state.cycles = [cycle()];
    state.timeline = {
      farmId: "farm-1",
      entries: [
        entry("2026-10-20", { activity: "harvest", quantity: { value: 1, unit: "quintal" } }),
        entry("2026-10-27", { activity: "harvest", quantity: { value: 25, unit: "kg" } }),
        entry("2026-10-28", { activity: "sale", quantity: { value: 40, unit: "kg" }, sale: { amountInr: "2000" } }),
        entry("2026-09-01", { activity: "irrigation", quantity: { value: 500, unit: "L" } }),
        entry("2026-08-01", { activity: "fertilizer", note: "farmyard manure", quantity: { value: 20, unit: "kg" } }),
      ],
    };
    const t = await render();
    expect(t).toContain("Harvest and inputs");
    expect(t).toContain("Harvest pickings · 125 kg total");
    expect(t).toContain("1 quintal = 100 kg");
    expect(t).toContain("running total 125 kg");
    expect(t).toContain("Stock on hand · 85 kg");
    expect(t).toContain("Harvested minus sold, from your entries");
    expect(t).toContain("Water applied · 1 irrigation");
    expect(t).toContain("0.5 m³");
    expect(t).toContain("Fertiliser applications · 1");
    expect(t).toContain("farmyard manure");
    expect(t).toContain("20 kg");
    expect(t).toContain("Farmer recorded · not an estimate");
    expect(t).not.toContain("converted with your field area");
    expect(t).not.toContain("Regional band");
  });

  it("hides the stock line when no sale has a quantity", async () => {
    state.cycles = [cycle()];
    state.timeline = {
      farmId: "farm-1",
      entries: [entry("2026-10-20", { activity: "harvest", quantity: { value: 100, unit: "kg" } }), entry("2026-10-28", { activity: "sale", sale: { amountInr: "2000" } })],
    };
    const t = await render();
    expect(t).toContain("Harvest pickings · 100 kg total");
    expect(t).not.toContain("Stock on hand");
    expect(t).not.toContain("Harvested minus sold");
  });

  it("shows zero stock with a note when sales exceed the recorded harvest", async () => {
    state.cycles = [cycle()];
    state.timeline = {
      farmId: "farm-1",
      entries: [entry("2026-10-20", { activity: "harvest", quantity: { value: 10, unit: "kg" } }), entry("2026-10-28", { activity: "sale", quantity: { value: 30, unit: "kg" } })],
    };
    const t = await render();
    expect(t).toContain("Stock on hand · 0 kg");
    expect(t).toContain("Sales exceed recorded harvest");
    expect(t).not.toContain("−");
  });

  it("converts mm to m3 with the field's drawn area only for a cycle on a field, and says so", async () => {
    state.fields = [{ id: "f1", name: "North", boundary: square }];
    state.cycles = [cycle({ id: "onfield", fieldId: "f1" }), cycle({ id: "farmwide", cropId: "maize", cropName: "Maize", sowingDate: "2026-04-02" })];
    state.timeline = { farmId: "farm-1", entries: [entry("2026-09-01", { activity: "irrigation", quantity: { value: 10, unit: "mm" } })] };
    const html = await renderToStringAsync(() => <Suspense><JournalWorkspace /></Suspense>);
    const t = text(html);
    // the entry belongs to the cycle that started last (Maize, farm-wide), which has no field: no conversion
    expect(t).toContain("Depth recorded in mm: 10 mm");
    expect(t).not.toContain("converted with your field area");
    state.cycles = [cycle({ id: "onfield", fieldId: "f1" })];
    const t2 = await render();
    expect(t2).toContain("converted with your field area");
    const ha = polygonAreaHa(square as never);
    const m3 = (Math.round(10 * ha * 10 * 10) / 10).toLocaleString("en-IN", { maximumFractionDigits: 1 });
    expect(t2).toContain(`10 mm over ${ha.toFixed(2)} ha = ${m3} m³ (converted with your field area)`);
  });
});

describe("RecordsSection regional band", () => {
  const records = cycleRecords([entry("2026-10-20", { activity: "harvest", quantity: { value: 100, unit: "kg" } }) as never], [cycle() as never], "2026-11-01");
  const draw = (yieldBands?: Record<string, { low: number; high: number } | null>) =>
    renderToStringAsync(() => <RecordsSection records={records} dateLabel={(d) => d} cropName={(c) => c} {...(yieldBands ? { yieldBands } : {})} />).then(text);

  it("shows the band line only when a band is supplied for that cycle", async () => {
    expect(await draw()).not.toContain("Regional band");
    expect(await draw({ c1: null })).not.toContain("Regional band");
    expect(await draw({ other: { low: 1, high: 2 } })).not.toContain("Regional band");
    expect(await draw({ c1: { low: 800, high: 1500 } })).toContain("Regional band for this field: 800 to 1,500 kg (district statistics, not your field)");
  });
});
