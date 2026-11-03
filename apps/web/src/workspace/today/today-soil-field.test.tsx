import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clearSessionState } from "../../lib/session";
import { loadSoilReview, pollSoilReview, refreshSoilReview } from "../farm/soilReviewApi";
import { SOIL_FIXTURE_FARM_ID, errorSoilReview, pendingSoilReview, readyModelReview } from "../farm/soilReviewFixtures";
import { runSoilCard, type SoilCardApi } from "./todaySoilModel";

/**
 * Review fix: the Today soil card asks for the selected field's review (`?fieldId=`), the one the Farm tab shows, so a
 * field needs one Meta narrative job, not two. "All fields" keeps the farm-wide review. The fetch is a stub, not a live server.
 */
const json = (data: unknown) => new Response(JSON.stringify({ requestId: "r1", mode: "live", asOf: "2026-11-03T00:00:00.000Z", warnings: [], data, error: null }), { status: 200, headers: { "content-type": "application/json" } });
function stub(reviews: unknown[]) {
  const calls: { url: string; method: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/soil-review")) return json({ authenticated: true, csrfToken: "tok" });
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return json(reviews.shift() ?? readyModelReview);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const apiOn = (f: typeof fetch): SoilCardApi => ({
  load: (id, o) => loadSoilReview(id, { ...o, fetchImpl: f }),
  refresh: (id, o) => refreshSoilReview(id, { ...o, fetchImpl: f }),
  poll: (id, initial, o) => pollSoilReview(id, initial, { ...o, fetchImpl: f, intervalMs: 1 }),
});
const base = `/api/v1/farms/${SOIL_FIXTURE_FARM_ID}/soil-review`;
const run = (f: typeof fetch, fieldId: string | null | undefined, force = false) => runSoilCard(SOIL_FIXTURE_FARM_ID, apiOn(f), () => {}, new AbortController().signal, force, fieldId);

afterEach(() => clearSessionState());

describe("Today soil card request path", () => {
  it("names the selected field on the first load and on every poll", async () => {
    const { f, calls } = stub([pendingSoilReview, readyModelReview]);
    await run(f, "field 1");
    expect(calls.map((c) => c.url)).toEqual([`${base}?fieldId=field%201`, `${base}?fieldId=field%201`]);
  });
  it("names the field on a forced refresh (POST) and its polls", async () => {
    const { f, calls } = stub([pendingSoilReview, readyModelReview]);
    await run(f, "f2", true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${base}?fieldId=f2`, `GET ${base}?fieldId=f2`]);
  });
  it("keeps the farm-wide review (no fieldId) for All fields, a farm without fields and a missing argument", async () => {
    for (const field of [null, undefined]) {
      const { f, calls } = stub([readyModelReview]);
      await run(f, field);
      expect(calls.map((c) => c.url)).toEqual([base]);
    }
    const { f, calls } = stub([errorSoilReview, readyModelReview]);
    await run(f, null, true);
    expect(calls[0]!.url).toBe(base);
  });
});

describe("Today soil card wiring", () => {
  it("TodayView keys the one controller on the shell's field selection", () => {
    const source = readFileSync(new URL("./TodayView.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/createSoilCardController\(farmId, \(\) => s\.sessionEpoch\(\), undefined, fieldKey\)/);
  });
  it("the controller waits (requests nothing) while the field is undefined and refetches on a field change", () => {
    const source = readFileSync(new URL("./TodaySoil.tsx", import.meta.url), "utf8");
    expect(source).toContain("() => [farmId(), fieldId(), epoch()] as const");
    expect(source).toContain("if (id && field !== undefined) start(id, field, false)");
  });
});
