import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { classifyFailure, compareCrops } from "../../lib/catalogue-api";
import { fixtureFlags, hassanFixture } from "./fixtures";
import { MAX_COMPARE, dimensionState, evidenceIdsOf, farmHref, itemKey, priceLabel, safeLink, sortItems, toggleSelection } from "./logic";
import type { CompareItem, EvidenceCitation } from "./types";

const stub = (over: Partial<CompareItem>): CompareItem => ({ ...hassanFixture.items[0]!, ...over });

describe("fixture provenance", () => {
  it("is marked synthetic", () => {
    expect(fixtureFlags).toEqual({ hassan: true, tn: true });
    expect(hassanFixture.mode).toBe("synthetic");
  });
});

describe("sortItems", () => {
  it("orders eligible, requires_review, unknown, ineligible, then farmer-excluded; server rank breaks ties", () => {
    const shuffled = [
      stub({ cropId: "a", productId: "a1", outcome: "excluded_by_farmer", rank: 1 }),
      stub({ cropId: "b", productId: "b1", outcome: "unknown", rank: 2 }),
      stub({ cropId: "c", productId: "c1", outcome: "ineligible", rank: 3 }),
      stub({ cropId: "d", productId: "d1", outcome: "requires_review", rank: 9 }),
      stub({ cropId: "e", productId: "e1", outcome: "eligible", rank: 8 }),
      stub({ cropId: "f", productId: "f1", outcome: "eligible", rank: 4 }),
    ];
    const copy = [...shuffled];
    expect(sortItems(shuffled).map((i) => i.productId)).toEqual(["f1", "e1", "d1", "b1", "c1", "a1"]);
    expect(shuffled).toEqual(copy);
  });
  it("keeps the real fixture grouped by outcome", () => {
    const order = ["eligible", "requires_review", "unknown", "ineligible", "excluded_by_farmer"];
    const idx = sortItems(hassanFixture.items).map((i) => order.indexOf(i.outcome));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(hassanFixture.items.length).toBeGreaterThan(30);
  });
});

describe("toggleSelection", () => {
  it("selects and deselects", () => {
    expect(toggleSelection([], "a").selected).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a").selected).toEqual(["b"]);
  });
  it("refuses a fourth selection without changing the set", () => {
    const three = ["a", "b", "c"];
    const r = toggleSelection(three, "d");
    expect(MAX_COMPARE).toBe(3);
    expect(r).toEqual({ selected: three, blocked: true });
    expect(r.selected).not.toBe(three);
  });
  it("allows deselecting at the limit and then selecting another", () => {
    const r1 = toggleSelection(["a", "b", "c"], "b");
    expect(r1.blocked).toBe(false);
    expect(toggleSelection(r1.selected, "d").selected).toEqual(["a", "c", "d"]);
  });
});

describe("labels", () => {
  it("shows the fixed gated-price wording", () => {
    const g = hassanFixture.items.find((i) => i.cropId === "ginger")!;
    expect(priceLabel(g)).toBe("Unavailable — price access pending");
  });
  it("labels unknown dimensions unavailable and economics as scenario", () => {
    const g = hassanFixture.items.find((i) => i.cropId === "ginger")!;
    expect(dimensionState("waterFit", g.dimensions.waterFit)).toBe("unavailable");
    expect(dimensionState("marketAccess", g.dimensions.marketAccess)).toBe("unavailable");
    expect(dimensionState("harvestWindows", g.dimensions.harvestWindows)).toBe("derived");
    expect(dimensionState("economics", { status: "known", value: {}, basis: "x", missingReason: null, evidenceIds: [] })).toBe("scenario");
  });
  it("collects evidence ids without duplicates", () => {
    const t = hassanFixture.items.find((i) => i.productId === "turmeric-dry")!;
    const ids = evidenceIdsOf(t);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("cat.turmeric.sow");
  });
  it("builds the farm link with encoded ids", () => {
    expect(farmHref({ cropId: "ginger", productId: "ginger-fresh" })).toBe("/farm?cropId=ginger&productId=ginger-fresh");
    expect(itemKey({ cropId: "a", productId: "b" })).toBe("a/b");
  });
});

describe("safeLink", () => {
  const ev = (url: string | null, access = "open"): Pick<EvidenceCitation, "citation" | "licence"> => ({
    citation: { publisher: "p", documentTitle: "d", documentVersion: null, sourceUrl: url },
    licence: { accessStatus: access, redistributable: false },
  });
  it("links only https URLs that are openly accessible", () => {
    expect(safeLink(ev("https://www.indianspices.com/a.pdf"))).toBe("https://www.indianspices.com/a.pdf");
    expect(safeLink(ev("http://example.com/a"))).toBeNull();
    expect(safeLink(ev("javascript:alert(1)"))).toBeNull();
    expect(safeLink(ev("https://example.com/a", "restricted"))).toBeNull();
    expect(safeLink(ev(null))).toBeNull();
    expect(safeLink(ev("not a url"))).toBeNull();
  });
});

const jsonResponse = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("failure states", () => {
  const req = { location: { stateId: "IN-KA" }, planting: { month: 5 }, irrigation: "rainfed" as const, excludedCropIds: [], assumedPrices: [] };
  it("maps a 429 envelope to the rate-limited message", async () => {
    const f: typeof fetch = () => jsonResponse(429, { requestId: "r", mode: "synthetic", asOf: "x", data: null, warnings: [], error: { code: "rate_limited", message: "slow down", retryable: true } });
    const e = await compareCrops(req, f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(classifyFailure(e).kind).toBe("rate_limited");
    expect(classifyFailure(e).message).toMatch(/answers are kept/);
  });
  it("maps a 429 with a non-envelope body to rate-limited too", async () => {
    const f: typeof fetch = () => jsonResponse(429, { statusCode: 429, message: "Rate limit exceeded" });
    expect(classifyFailure(await compareCrops(req, f).catch((x) => x)).kind).toBe("rate_limited");
  });
  it("maps network failure, 503 and 400 distinctly", async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError("fail"));
    expect(classifyFailure(await compareCrops(req, down).catch((x) => x)).kind).toBe("offline");
    const env = (status: number, code: string) => jsonResponse(status, { requestId: "r", mode: "synthetic", asOf: "x", data: null, warnings: [], error: { code, message: "m" } });
    expect(classifyFailure(await compareCrops(req, () => env(503, "catalogue_not_loaded")).catch((x) => x)).kind).toBe("catalogue_unavailable");
    expect(classifyFailure(await compareCrops(req, () => env(400, "bad_request")).catch((x) => x)).kind).toBe("invalid_input");
    expect(classifyFailure(await compareCrops(req, () => env(500, "internal_error")).catch((x) => x)).kind).toBe("server");
  });
  it("posts JSON to the comparison route and returns warnings as objects", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const f: typeof fetch = (url, init) => {
      seen = { url: String(url), ...(init ? { init } : {}) };
      return jsonResponse(200, { requestId: "r", mode: "synthetic", asOf: "x", data: hassanFixture, warnings: [{ code: "w", message: "warn" }], error: null });
    };
    const r = await compareCrops(req, f);
    expect(seen!.url).toBe("/api/v1/crop-comparisons");
    expect(seen!.init?.method).toBe("POST");
    expect(JSON.parse(String(seen!.init?.body))).toEqual(req);
    expect(r.warnings).toEqual([{ code: "w", message: "warn" }]);
    expect(r.mode).toBe("synthetic");
  });
});
