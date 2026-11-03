import { afterEach, describe, expect, it } from "vitest";
import { clearSessionState } from "../../lib/session";
import { isWholeFarmSeason, seasonsForField, seasonWithField } from "../year/PlanCalendar";
import { requestPickerReview } from "./CropFitPicker";
import { FIXTURE_FARM_ID, pendingReview, readyModelReview } from "./cropFitFixtures";

/**
 * FIELDS_MULTICROP_SOIL_SPEC.md 12.6: the crop picker of the swap and suggest sheets ranks for the field the plan is for,
 * so its request carries `fieldId`; without one it is the whole-farm request. The fetch is a stub, not a live server.
 */
const json = (data: unknown) => new Response(JSON.stringify({ requestId: "r1", mode: "live", asOf: "2026-11-03T00:00:00.000Z", warnings: [], data, error: null }), { status: 200, headers: { "content-type": "application/json" } });
function stub(reviews: unknown[]) {
  const calls: { url: string; method: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/crop-fit")) return json({ authenticated: true, csrfToken: "tok" });
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return json(reviews.shift() ?? readyModelReview);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const run = (over: Partial<Parameters<typeof requestPickerReview>[0]>, f: typeof fetch) =>
  requestPickerReview({ farmId: FIXTURE_FARM_ID, fieldId: null, sowing: "2027-05-16", after: "paddy", force: false, signal: new AbortController().signal, onUpdate: () => {}, isCurrent: () => true, fetchImpl: f, intervalMs: 1, ...over }, );

afterEach(() => clearSessionState());

describe("crop picker request", () => {
  it("names the field when one is given, on the first load, every poll and a forced refresh", async () => {
    const { f, calls } = stub([pendingReview, readyModelReview]);
    const seen: string[] = [];
    await run({ fieldId: "field 1", onUpdate: (r) => seen.push(r.status) }, f);
    const base = `/api/v1/farms/${FIXTURE_FARM_ID}/crop-fit?mode=date&sowing=2027-05-16&after=paddy&fieldId=field%201`;
    expect(calls).toEqual([{ url: base, method: "GET" }, { url: base, method: "GET" }]);
    expect(seen).toEqual(["pending", "ready", "ready"]);
    const forced = stub([readyModelReview]);
    await run({ fieldId: "field 1", force: true }, forced.f);
    expect(forced.calls).toEqual([{ url: base, method: "POST" }]);
  });
  it("sends no fieldId for the whole farm (null or omitted)", async () => {
    const { f, calls } = stub([readyModelReview]);
    await run({ fieldId: null }, f);
    expect(calls[0]!.url).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/crop-fit?mode=date&sowing=2027-05-16&after=paddy`);
    expect(calls[0]!.url).not.toContain("fieldId");
  });
});

describe("saved seasons under a field plan", () => {
  const plans = [
    { id: "a", fieldId: "f1" },
    { id: "b", fieldId: "f2" },
    { id: "legacy" },
  ];
  it("lists the field's seasons and legacy whole-farm seasons, not another field's", () => {
    expect(seasonsForField(plans, "f1").map((p) => p.id)).toEqual(["a", "legacy"]);
    expect(seasonsForField(plans, "f2").map((p) => p.id)).toEqual(["b", "legacy"]);
  });
  it("keeps every season in All fields (no field) and does not mutate the input", () => {
    expect(seasonsForField(plans, null).map((p) => p.id)).toEqual(["a", "b", "legacy"]);
    expect(seasonsForField(plans, undefined)).toHaveLength(3);
    expect(plans).toHaveLength(3);
  });
  it("labels only a legacy season in a field view as whole farm", () => {
    expect(isWholeFarmSeason({}, "f1")).toBe(true);
    expect(isWholeFarmSeason({ fieldId: "f1" }, "f1")).toBe(false);
    expect(isWholeFarmSeason({}, null)).toBe(false);
  });
});

describe("season saved from the Planner form", () => {
  const draft: { cropId: string; season: string; plannedSowingDate: string; id?: string; fieldId?: string } = { cropId: "maize", season: "Kharif", plannedSowingDate: "2027-06-10" };
  it("stamps a new season with the field in a field view", () => {
    expect(seasonWithField(draft, "f1")).toEqual({ ...draft, fieldId: "f1" });
  });
  it("adds no field in All fields or on a farm without fields", () => {
    expect(seasonWithField(draft, null)).toEqual(draft);
    expect(seasonWithField(draft, undefined)).not.toHaveProperty("fieldId");
  });
  it("keeps an edited season's own field, and a legacy season stays whole-farm", () => {
    expect(seasonWithField({ ...draft, id: "s1", fieldId: "f2" }, "f1").fieldId).toBe("f2");
    expect(seasonWithField({ ...draft, id: "s1" }, "f1")).not.toHaveProperty("fieldId");
  });
});
