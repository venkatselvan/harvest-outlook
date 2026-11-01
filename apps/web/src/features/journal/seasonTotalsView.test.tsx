import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStringAsync } from "solid-js/web";
import { Suspense } from "solid-js";

/*
 * The Journal tab's "Season totals" section, rendered with the real JournalWorkspace component. Workspace state and the journal
 * API are stubbed with synthetic values; nothing here is a live server response.
 */

const state = vi.hoisted(() => ({
  farm: { id: "farm-1", name: "Test farm" } as { id: string; name: string } | null,
  cycles: [] as Record<string, unknown>[],
  timeline: { farmId: "farm-1", entries: [] as Record<string, unknown>[] },
}));

vi.mock("../../workspace/state", () => ({
  useWorkspace: () => ({
    farm: () => state.farm,
    workspace: Object.assign(() => ({ cycles: state.cycles, version: 1, boundary: null, previousHarvest: { status: "unknown" }, rotationPlans: [] }), { loading: false }),
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

const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ");
// Suspense lets the server render wait for the (stubbed) journal request, as the real page does on the client.
const render = async () => text(await renderToStringAsync(() => <Suspense><JournalWorkspace /></Suspense>));
const cycle = (over: Record<string, unknown> = {}) => ({ id: "c1", cropId: "ginger", cropName: "Ginger", sowingDate: "2026-10-31", stage: "growing", ...over });
const entry = (observedOn: string, over: Record<string, unknown> = {}) => ({ id: observedOn, observedOn, activity: "observation", note: "x", media: [], quantity: null, expense: null, sale: null, provenanceLabel: "Recorded by you", ...over });

beforeEach(() => {
  state.farm = { id: "farm-1", name: "Test farm" };
  state.cycles = [];
  state.timeline = { farmId: "farm-1", entries: [] };
});

describe("Season totals section", () => {
  it("shows nothing when there are no crop records", async () => {
    state.timeline = { farmId: "farm-1", entries: [entry("2026-10-31", { expense: { amountInr: "10", category: "x" } })] };
    expect(await render()).not.toContain("Season totals");
  });

  it("lists spent, sold, net and harvest from the farmer's entries, labelled as farmer recorded and not an estimate", async () => {
    state.cycles = [cycle()];
    state.timeline = {
      farmId: "farm-1",
      entries: [
        entry("2026-10-31", { activity: "planting", expense: { amountInr: "4200", category: "seed" } }),
        entry("2026-11-01", { activity: "harvest", quantity: { value: 3.2, unit: "quintal" } }),
      ],
    };
    const t = await render();
    expect(t).toContain("Season totals");
    expect(t).toContain("Ginger");
    expect(t).toContain("sown 31 Oct 2026 · to today");
    expect(t).toContain("2 entries");
    expect(t).toContain("Spent ₹4,200 · Sold ₹0 · Net −₹4,200");
    expect(t).toContain("Harvest recorded: 320 kg");
    expect(t).toContain("Farmer recorded · not an estimate");
    expect(t).toContain("Totals add your journal expenses and sale amounts from sowing to harvest and up to 90 days after; they are not the plan's profit estimate.");
    expect(t).not.toContain("also fall inside another crop");
  });

  it("says none recorded without a harvest quantity, counts a sale after the harvest date and says how far entries are included", async () => {
    state.cycles = [cycle({ stage: "harvested", sowingDate: "2026-05-01", harvestDate: "2026-08-31" })];
    state.timeline = { farmId: "farm-1", entries: [entry("2026-06-01"), entry("2026-09-20", { activity: "sale", sale: { amountInr: "9000", note: "mandi" } })] };
    const t = await render();
    expect(t).toContain("sown 1 May 2026 · to 31 Aug 2026 · including entries up to 29 Nov 2026");
    expect(t).toContain("2 entries");
    expect(t).toContain("Harvest recorded: none recorded");
    expect(t).toContain("Sold ₹9,000");
    expect(t).not.toContain("fall outside every crop's dates");
  });

  it("does not add the including-entries line when the window is just the harvest date, and keeps the outside-dates note for what is still out", async () => {
    state.cycles = [cycle({ id: "h", stage: "harvested", sowingDate: "2026-05-01", harvestDate: "2026-08-31" }), cycle({ id: "n", cropId: "maize", cropName: "Maize", sowingDate: "2026-09-01" })];
    state.timeline = { farmId: "farm-1", entries: [entry("2026-04-01", { expense: { amountInr: "50", category: "x" } })] };
    const t = await render();
    expect(t).toContain("sown 1 May 2026 · to 31 Aug 2026");
    expect(t).not.toContain("including entries up to");
    expect(t).toContain("1 entry with a money amount falls outside every crop's dates (for example seed bought before sowing or a sale long after the harvest) and is not counted above.");
  });

  it("uses the plural wording when several entries with amounts fall outside every window", async () => {
    state.cycles = [cycle({ sowingDate: "2026-06-01" })];
    state.timeline = { farmId: "farm-1", entries: [entry("2026-05-01", { expense: { amountInr: "50", category: "seed" } }), entry("2026-05-02", { expense: { amountInr: "70", category: "land" } }), entry("2026-06-02")] };
    const t = await render();
    expect(t).toContain("2 entries with money amounts fall outside every crop's dates (for example seed bought before sowing or a sale long after the harvest) and are not counted above.");
    expect(t).toContain("1 entry");
  });

  it("notes entries that fall inside two crops' dates", async () => {
    state.cycles = [cycle({ id: "a", cropId: "maize", cropName: "Maize", sowingDate: "2026-03-01" }), cycle({ id: "b", sowingDate: "2026-06-01" })];
    state.timeline = { farmId: "farm-1", entries: [entry("2026-07-01", { sale: { amountInr: "100" }, activity: "sale" })] };
    const t = await render();
    expect(t).toContain("1 entry also falls inside another crop's dates and is counted here");
    expect(t).toContain("Sold ₹100");
  });

  it("does not show totals from another farm's journal", async () => {
    state.cycles = [cycle()];
    state.timeline = { farmId: "other-farm", entries: [entry("2026-10-31", { expense: { amountInr: "999", category: "x" } })] };
    const other = await render();
    expect(other).toContain("Crop progress");
    expect(other).not.toContain("Season totals");
    expect(other).not.toContain("₹999");

  });
});
