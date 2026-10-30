import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/ingest/http";
import { redactSecrets, redactUrl } from "../src/ingest/redact";
import { loadProviderConfig } from "../src/providers/config";
import { buildMandiUrl, fetchMandiPrices } from "../src/providers/datagovin/client";
import { normalizeMandiRecords, parseSourceDate, type CommodityMapEntry } from "../src/providers/datagovin/normalize";

const RES = "9ef84268-d588-465a-a308-a864a43d0070";
const KEY = "sekret-key-0123456789";
const keyed = loadProviderConfig({ DATA_GOV_IN_API_KEY: KEY, PROVIDER_MAX_RETRIES: "0" });
const noSleep = async () => undefined;
const page = (records: unknown[], total: number): Awaited<ReturnType<FetchLike>> => ({ ok: true, status: 200, text: async () => JSON.stringify({ total, count: records.length, records }), headers: new Headers() });
const rec = (i: number) => ({ state: "Karnataka", district: "Hassan", market: "Hassan", commodity: "Ginger(Green)", variety: "Other", grade: "FAQ", arrival_date: "15/10/2026", min_price: "6000", max_price: "7000", modal_price: String(6500 + i) });

describe("data.gov.in adapter", () => {
  it("with no key: unavailable api_key_missing and ZERO network calls", async () => {
    const f = vi.fn();
    const r = await fetchMandiPrices({ resourceId: RES, filters: { commodity: "Ginger(Green)" } }, { config: loadProviderConfig({}), fetchImpl: f as unknown as FetchLike });
    expect(r).toMatchObject({ status: "unavailable", reason: "api_key_missing" });
    expect(f).not.toHaveBeenCalled();
  });

  it("builds the documented URL (api-key, format, limit, offset, filters[field])", () => {
    const u = new URL(buildMandiUrl("https://api.data.gov.in", KEY, { resourceId: RES, filters: { commodity: "Ginger(Green)", state: "Karnataka" } }, 500, 250));
    expect(u.pathname).toBe(`/resource/${RES}`);
    expect(u.searchParams.get("api-key")).toBe(KEY);
    expect([u.searchParams.get("format"), u.searchParams.get("limit"), u.searchParams.get("offset")]).toEqual(["json", "250", "500"]);
    expect(u.searchParams.get("filters[commodity]")).toBe("Ginger(Green)");
    expect(u.searchParams.get("filters[state]")).toBe("Karnataka");
  });

  it("redacts api-key from URLs and from error text; the key never appears in results", async () => {
    expect(redactUrl(`https://api.data.gov.in/resource/${RES}?api-key=${KEY}&format=json`)).not.toContain(KEY);
    expect(redactUrl(`https://x/?a=1&api-key=${KEY}`)).toContain("api-key=REDACTED");
    expect(redactSecrets(`boom ${KEY} boom`, [KEY])).not.toContain(KEY);
    const leaky: FetchLike = async (u) => {
      throw new Error(`connect failed for ${u}`);
    };
    const r = await fetchMandiPrices({ resourceId: RES }, { config: keyed, fetchImpl: leaky, sleep: noSleep });
    expect(r.status).toBe("unavailable");
    expect(JSON.stringify(r)).not.toContain(KEY);
    const okFetch: FetchLike = async () => page([rec(1)], 1);
    const good = await fetchMandiPrices({ resourceId: RES }, { config: keyed, fetchImpl: okFetch });
    expect(JSON.stringify(good)).not.toContain(KEY);
    expect(good.status === "ok" && good.requestUrl).toContain("api-key=REDACTED");
  });

  it("maps auth/validation failures to typed reasons", async () => {
    const mk = (code: number): FetchLike => async () => ({ ok: false, status: code, text: async () => JSON.stringify({ error: "Authorization field missing" }), headers: new Headers() });
    expect(await fetchMandiPrices({ resourceId: RES }, { config: keyed, fetchImpl: mk(403) })).toMatchObject({ reason: "auth_rejected" });
    expect(await fetchMandiPrices({ resourceId: RES }, { config: keyed, fetchImpl: mk(400) })).toMatchObject({ reason: "invalid_request" });
    expect(await fetchMandiPrices({ resourceId: "not-a-uuid" }, { config: keyed, fetchImpl: mk(200) })).toMatchObject({ reason: "invalid_request" });
  });

  it("paginates with limit clamped to 1000 and stops at the hard cap, reporting truncation", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => {
      urls.push(u);
      const p = new URL(u).searchParams;
      const off = Number(p.get("offset"));
      const lim = Number(p.get("limit"));
      return page(Array.from({ length: lim }, (_, i) => rec(off + i)), 5000);
    };
    const r = await fetchMandiPrices({ resourceId: RES, limit: 99999, maxRecords: 1500 }, { config: keyed, fetchImpl: f });
    expect(r.status === "ok" && r.records.length).toBe(1500);
    expect(urls.map((u) => new URL(u).searchParams.get("limit"))).toEqual(["1000", "500"]);
    expect(r.status === "ok" && r.truncated).toBe(true);
  });

  it("stops at the last short page without truncation", async () => {
    const f: FetchLike = async (u) => (new URL(u).searchParams.get("offset") === "0" ? page([rec(1), rec(2), rec(3)], 3) : page([], 3));
    const r = await fetchMandiPrices({ resourceId: RES, limit: 100 }, { config: keyed, fetchImpl: f });
    expect(r).toMatchObject({ status: "ok", pages: 1, truncated: false });
  });

  it("honours cancellation between pages and returns only what was read", async () => {
    let calls = 0;
    const f: FetchLike = async (u) => {
      calls++;
      const off = Number(new URL(u).searchParams.get("offset"));
      return page(Array.from({ length: 10 }, (_, i) => rec(off + i)), 1000);
    };
    let cancelNow = false;
    const r = await fetchMandiPrices({ resourceId: RES, limit: 10 }, { config: keyed, fetchImpl: f, shouldCancel: () => cancelNow, onPage: () => void (cancelNow = true) });
    expect(r).toMatchObject({ status: "cancelled", pages: 1 });
    expect(calls).toBe(1);
  });
});

describe("mandi normalisation", () => {
  const map: CommodityMapEntry[] = [{ sourceCommodity: "Ginger(Green)", productSlug: "ginger-fresh", verified: false }];

  it("converts INR/quintal to INR/kg exactly with both stored", () => {
    const r = normalizeMandiRecords([{ ...rec(0), min_price: "6000", modal_price: "6525", max_price: "7000" }], { commodityMap: map });
    const row = r.rows[0]!;
    expect([row.priceMin, row.priceModal, row.priceMax, row.sourceUnit]).toEqual(["6000", "6525", "7000", "INR/quintal"]);
    expect([row.priceMinPerKg, row.priceModalPerKg, row.priceMaxPerKg]).toEqual(["60", "65.25", "70"]);
    expect(row.flags).toContain("source_unit_assumed_inr_per_quintal");
    expect(row.flags).toContain("commodity_mapping_unverified");
    expect(row.observedOn).toBe("2026-10-15");
  });

  it("parses dd/mm/yyyy and rejects impossible dates", () => {
    expect(parseSourceDate("05/11/2026")).toBe("2026-11-05"); // day first, not month first
    expect(parseSourceDate("2026-11-05")).toBe("2026-11-05");
    expect(parseSourceDate("31/02/2026")).toBeNull();
    expect(parseSourceDate("13/13/2026")).toBeNull();
    expect(parseSourceDate("garbage")).toBeNull();
    const r = normalizeMandiRecords([{ ...rec(0), arrival_date: "31/02/2026" }], { commodityMap: map });
    expect(r.rejected).toEqual([{ reason: "bad_date", index: 0 }]);
  });

  it("ignores exact duplicates and flags conflicting duplicates without losing the alternative", () => {
    const a = rec(0);
    const input = [a, { ...a }, { ...a, modal_price: "9999" }];
    const r = normalizeMandiRecords(input, { commodityMap: map });
    expect(r.rows).toHaveLength(1);
    expect(r.duplicatesIgnored).toBe(1);
    expect(r.conflictsFlagged).toBe(1);
    expect(r.rows[0]!.flags).toContain("conflicting_duplicate");
    expect((r.rows[0]!.raw.__conflictingDuplicates as unknown[]).length).toBe(1);
    expect(input[0]).not.toHaveProperty("__conflictingDuplicates"); // input not mutated
  });

  it("distinct varieties on the same day are not duplicates", () => {
    const r = normalizeMandiRecords([rec(0), { ...rec(0), variety: "Dry" }], { commodityMap: map });
    expect(r.rows).toHaveLength(2);
    expect(r.conflictsFlagged).toBe(0);
  });

  it("rejects non-positive/missing prices, keeps order violations flagged, reports unmapped fields and commodities", () => {
    const r = normalizeMandiRecords(
      [
        { ...rec(0), modal_price: "0" },
        { ...rec(1), min_price: "NA", modal_price: "NA", max_price: "NA" },
        { ...rec(2), min_price: "8000", max_price: "7000", modal_price: "7500", Extra_Field: "x" },
        { ...rec(3), commodity: "Turmeric", market: "Other" },
      ],
      { commodityMap: map },
    );
    expect(r.rejected.map((x) => x.reason)).toEqual(["non_positive_price", "no_price"]);
    expect(r.rows[0]!.flags).toContain("price_order_violation");
    expect(r.unmappedFields).toContain("extra_field");
    expect(r.unmappedCommodities).toEqual(["Turmeric"]);
    expect(r.rows[1]!.productSlug).toBeNull();
  });

  it("accepts documented alternate field spellings (Min_x0020_Price) and never infers arrival units", () => {
    const r = normalizeMandiRecords([{ State: "Karnataka", District: "Hassan", Market: "Hassan", Commodity: "Ginger(Green)", Arrival_Date: "15/10/2026", Min_x0020_Price: "100", Max_x0020_Price: "200", Modal_x0020_Price: "150", Arrivals: "12" }], { commodityMap: map });
    expect(r.rows[0]).toMatchObject({ priceModal: "150", arrivals: "12", arrivalsUnit: null });
    const q = normalizeMandiRecords([{ ...rec(0), arrivals_in_qtl: "12" }], { commodityMap: map });
    expect(q.rows[0]!.arrivalsUnit).toBe("quintal");
  });
});

describe("variety-wise resource (capitalised fields, Commodity_Code)", () => {
  const VARIETY = "35985678-0d79-46b4-9ed6-6f13308a1d24";
  const cap = (over: Record<string, unknown> = {}) => ({
    Arrival_Date: "07/01/2014", Commodity: "Ginger(Green)", Commodity_Code: "103", District: "Bangalore", Grade: "FAQ", Market: "Bangalore",
    Max_Price: "6600", Min_Price: "4100", Modal_Price: "5200", State: "Karnataka", Variety: "Green Ginger", ...over,
  });

  it("builds exact-case filters[State]/filters[Commodity] via rawFilters", () => {
    const u = new URL(buildMandiUrl("https://api.data.gov.in", KEY, { resourceId: VARIETY, rawFilters: { State: "Karnataka", Commodity: "Ginger(Green)", Arrival_Date: "07/01/2014" } }, 0, 1000));
    expect(u.searchParams.get("filters[State]")).toBe("Karnataka");
    expect(u.searchParams.get("filters[Commodity]")).toBe("Ginger(Green)");
    expect(u.searchParams.get("filters[Arrival_Date]")).toBe("07/01/2014");
    expect(u.searchParams.has("filters[state]")).toBe(false);
  });

  it("normalises Capitalised fields, numeric or string commodity code, with the verified shipped map", () => {
    const r = normalizeMandiRecords([cap(), cap({ Commodity_Code: 103, Grade: "Medium", Modal_Price: 5300 })]);
    expect(r.rows).toHaveLength(2);
    const row = r.rows[0]!;
    expect([row.marketName, row.district, row.state, row.observedOn, row.productSlug, row.mappingVerified, row.commodityCode]).toEqual(["Bangalore", "Bangalore", "Karnataka", "2014-01-07", "ginger-fresh", true, "103"]);
    expect([row.priceMin, row.priceModal, row.priceMax, row.priceModalPerKg]).toEqual(["4100", "5200", "6600", "52"]);
    expect(row.flags).not.toContain("commodity_mapping_unverified");
    expect(row.flags).toContain("unit_basis:agmarknet_convention_inr_per_quintal");
    expect(r.rows[1]!.commodityCode).toBe("103");
    expect(r.unmappedFields).toEqual([]); // Commodity_Code is a known field, not "unmapped"
  });

  it("maps Ginger(Dry) verified to ginger-dry but unqualified Ginger stays unresolved and unverified", () => {
    const r = normalizeMandiRecords([cap({ Commodity: "Ginger(Dry)", Commodity_Code: "27" }), cap({ Commodity: "Ginger", Commodity_Code: undefined })]);
    expect(r.rows[0]).toMatchObject({ productSlug: "ginger-dry", mappingVerified: true });
    const g = r.rows[1]!;
    expect(g.mappingVerified).toBe(false);
    expect(g.flags).toEqual(expect.arrayContaining(["commodity_mapping_unverified", "unresolved_product"]));
    expect(r.rows[0]!.flags).not.toContain("unresolved_product");
  });

  it("dedupes capitalised rows by market+product+date+variety+grade", () => {
    const r = normalizeMandiRecords([cap(), cap(), cap({ Grade: "Medium" })]);
    expect(r.rows).toHaveLength(2);
    expect(r.duplicatesIgnored).toBe(1);
  });
});

describe("canonicalMarketKey (source renames from Nov 2025)", () => {
  it("joins legacy and renamed market names but keeps different markets apart", async () => {
    const { canonicalMarketKey: k } = await import("../src/providers/datagovin/market-alias");
    expect(k("Hassan APMC")).toBe(k("Hassan"));
    expect(k("Binny Mill (FF&V) Bengaluru APMC")).toBe(k("Binny Mill (F&V), Bangalore"));
    expect(k("Bengaluru APMC")).toBe(k("Bangalore"));
    expect(k("Mysuru APMC")).not.toBe(k("Mysore (Bandipalya)")); // different market labels: not merged by guess
    expect(k("Belur APMC")).not.toBe(k("Hassan"));
  });
});
