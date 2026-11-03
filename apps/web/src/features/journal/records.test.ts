import { describe, expect, it } from "vitest";
import { cycleRecords, decimalString, fertiliserApplications, formatDecimal, harvestPickings, stockOnHand, waterApplied, type RecordEntry } from "./records";
import { seasonTotals, type SeasonCycle } from "./model";

const e = (observedOn: string, activity: string | null, quantity?: { value: number; unit: string } | null, extra: Partial<RecordEntry> = {}): RecordEntry => ({ observedOn, activity, quantity: quantity ?? null, ...extra });
const cycle = (over: Partial<SeasonCycle> = {}): SeasonCycle => ({ id: "c1", cropId: "ginger", sowingDate: "2026-04-01", stage: "growing", ...over });
const TODAY = "2026-11-01";

describe("harvestPickings", () => {
  it("lists pickings by date with a running total and converts quintal and t exactly", () => {
    const r = harvestPickings([e("2026-10-20", "harvest", { value: 2, unit: "quintal" }), e("2026-10-10", "harvest", { value: 0.1, unit: "kg" }), e("2026-10-15", "harvest", { value: 0.2, unit: "kg" }), e("2026-10-25", "harvest", { value: 1.5, unit: "t" })]);
    expect(r.pickings.map((p) => [p.date, p.kg, p.runningKg])).toEqual([
      ["2026-10-10", 0.1, 0.1],
      ["2026-10-15", 0.2, 0.3], // 0.1 + 0.2 is exactly 0.3 here, not 0.30000000000000004
      ["2026-10-20", 200, 200.3],
      ["2026-10-25", 1500, 1700.3],
    ]);
    expect(r.totalKg).toBe(1700.3);
  });
  it("counts other-unit harvest quantities as skipped and keeps them out of the total", () => {
    const r = harvestPickings([e("2026-10-10", "harvest", { value: 40, unit: "kg" }), e("2026-10-11", "harvest", { value: 3, unit: "L" }), e("2026-10-12", "harvest", { value: 2, unit: "days" })]);
    expect(r.totalKg).toBe(40);
    expect(r.unitsSkipped).toBe(2);
    expect(r.pickings).toHaveLength(1);
  });
  it("has a null total when nothing converts, and ignores non-harvest entries and zero quantities", () => {
    const r = harvestPickings([e("2026-10-10", "sale", { value: 5, unit: "kg" }), e("2026-10-11", "harvest", null), e("2026-10-12", "harvest", { value: 0, unit: "kg" })]);
    expect(r).toEqual({ pickings: [], totalKg: null, unitsSkipped: 0 });
  });
});

describe("stockOnHand", () => {
  it("is hidden when no sale carries a convertible quantity", () => {
    expect(stockOnHand([e("2026-10-20", "sale", null)], 100)).toBeNull();
    expect(stockOnHand([e("2026-10-20", "sale", { value: 2, unit: "bags" })], 100)).toBeNull();
    expect(stockOnHand([], 100)).toBeNull();
  });
  it("is harvested minus sold, exactly, with sales in quintal", () => {
    const s = stockOnHand([e("2026-10-20", "sale", { value: 0.3, unit: "quintal" }), e("2026-10-21", "sale", { value: 5, unit: "kg" })], 100.1)!;
    expect(s.soldKg).toBe(35);
    expect(s.stockKg).toBe(65.1);
    expect(s.salesExceedHarvest).toBe(false);
  });
  it("clamps at zero and flags sales above the recorded harvest, including with no harvest at all", () => {
    const over = stockOnHand([e("2026-10-20", "sale", { value: 120, unit: "kg" })], 100)!;
    expect(over).toMatchObject({ stockKg: 0, soldKg: 120, salesExceedHarvest: true });
    expect(stockOnHand([e("2026-10-20", "sale", { value: 1, unit: "kg" })], null)).toMatchObject({ stockKg: 0, salesExceedHarvest: true });
    expect(stockOnHand([e("2026-10-20", "sale", { value: 100, unit: "kg" })], 100)).toMatchObject({ stockKg: 0, salesExceedHarvest: false });
  });
  it("counts sale quantities in other units next to convertible ones without subtracting them", () => {
    const s = stockOnHand([e("2026-10-20", "sale", { value: 10, unit: "kg" }), e("2026-10-21", "sale", { value: 4, unit: "acre" })], 50)!;
    expect(s).toMatchObject({ soldKg: 10, stockKg: 40, soldUnitsSkipped: 1 });
  });
});

describe("waterApplied", () => {
  it("sums mm as mm and L and m3 as m3, never across families, with exact decimals", () => {
    const w = waterApplied([e("2026-09-01", "irrigation", { value: 12.5, unit: "mm" }), e("2026-09-08", "irrigation", { value: 7.3, unit: "mm" }), e("2026-09-09", "irrigation", { value: 250, unit: "L" }), e("2026-09-10", "irrigation", { value: 0.1, unit: "m3" }), e("2026-09-11", "irrigation", { value: 0.2, unit: "m3" }), e("2026-09-12", "irrigation", { value: 1, unit: "L" })]);
    expect(w.events).toBe(6);
    expect(w.mm).toBe("19.8");
    expect(w.m3).toBe("0.551"); // 0.25 + 0.1 + 0.2 + 0.001
    expect(w.mmAsM3).toBeNull();
    expect(w.areaHa).toBeNull();
  });
  it("shows the mm total as m3 only when an area is supplied (mm x ha x 10)", () => {
    const entries = [e("2026-09-01", "irrigation", { value: 40, unit: "mm" })];
    expect(waterApplied(entries).mmAsM3).toBeNull();
    expect(waterApplied(entries, 0).mmAsM3).toBeNull();
    expect(waterApplied(entries, null).mmAsM3).toBeNull();
    expect(waterApplied(entries, 0.4)).toMatchObject({ mmAsM3: 160, areaHa: 0.4, mm: "40" });
  });
  it("does not convert litres to mm: a litres-only record has no mm and no area conversion", () => {
    const w = waterApplied([e("2026-09-01", "irrigation", { value: 5000, unit: "L" })], 1);
    expect(w).toMatchObject({ mm: null, m3: "5", mmAsM3: null });
  });
  it("counts irrigation without a quantity or in another unit as skipped, and ignores other activities", () => {
    const w = waterApplied([e("2026-09-01", "irrigation", null), e("2026-09-02", "irrigation", { value: 3, unit: "days" }), e("2026-09-03", "weeding", { value: 9, unit: "mm" })]);
    expect(w).toMatchObject({ events: 2, skipped: 2, mm: null, m3: null });
  });
});

describe("fertiliserApplications", () => {
  it("lists fertiliser entries by date with note and quantity in any unit", () => {
    const f = fertiliserApplications([e("2026-08-20", "fertilizer", { value: 50, unit: "g" }, { note: " compost tea ", id: "b" }), e("2026-07-01", "fertilizer", null, { note: null, id: "a" }), e("2026-07-02", "irrigation", { value: 1, unit: "mm" })]);
    expect(f).toEqual([
      { id: "a", date: "2026-07-01", note: null, quantity: null },
      { id: "b", date: "2026-08-20", note: "compost tea", quantity: { value: 50, unit: "g" } },
    ]);
  });
});

describe("decimal helpers", () => {
  it("formats exact decimals without floating point and groups the whole part", () => {
    expect(decimalString(5510000n, 7)).toBe("0.551");
    expect(decimalString(1n, 7)).toBe("0.0000001");
    expect(decimalString(0n, 4)).toBe("0");
    expect(formatDecimal("1234567.25")).toBe("12,34,567.25");
  });
});

describe("cycleRecords attribution", () => {
  const harvested = cycle({ id: "h", stage: "harvested", sowingDate: "2026-01-01", harvestDate: "2026-04-30" });
  const next = cycle({ id: "n", cropId: "maize", sowingDate: "2026-06-01" });
  it("uses exactly the season totals window: post-harvest sales count, entries outside every window do not", () => {
    const entries = [
      e("2025-12-31", "harvest", { value: 99, unit: "kg" }), // before sowing
      e("2026-04-30", "harvest", { value: 100, unit: "kg" }), // harvest day, inclusive
      e("2026-05-15", "sale", { value: 30, unit: "kg" }), // after harvest, before the next crop
      e("2026-06-01", "irrigation", { value: 10, unit: "mm" }), // belongs to the next crop
      e("2026-08-01", "fertilizer", { value: 2, unit: "kg" }, { note: "urea" }),
    ];
    const r = cycleRecords(entries, [harvested, next], TODAY);
    const byId = Object.fromEntries(r.map((x) => [x.cycleId, x]));
    expect(byId.h!.harvest.totalKg).toBe(100);
    expect(byId.h!.stock).toMatchObject({ soldKg: 30, stockKg: 70 });
    expect(byId.h!.water.events).toBe(0);
    expect(byId.n!.water.mm).toBe("10");
    expect(byId.n!.fertiliser).toHaveLength(1);
    expect(byId.n!.harvest.totalKg).toBeNull();
    // the 99 kg before sowing is in nobody's records
    expect(r.flatMap((x) => x.harvest.pickings).map((p) => p.kg)).toEqual([100].sort());
    // and the harvest figure equals the season totals' figure for the same entries
    const totals = Object.fromEntries(seasonTotals(entries, [harvested, next], TODAY).map((t) => [t.cycleId, t.harvestKg]));
    expect(byId.h!.harvest.totalKg).toBe(totals.h);
    expect(byId.n!.harvest.totalKg).toBe(totals.n);
  });
  it("puts an entry that two windows contain in the cycle that started last, like the totals; the order is crops in the field first", () => {
    const a = cycle({ id: "a", cropId: "maize", sowingDate: "2026-03-01" });
    const b = cycle({ id: "b", sowingDate: "2026-06-01" });
    const r = cycleRecords([e("2026-07-01", "harvest", { value: 5, unit: "kg" })], [a, b], TODAY);
    expect(r.map((x) => x.cycleId)).toEqual(["b", "a"]);
    expect(r[0]!.harvest.totalKg).toBe(5);
    expect(r[1]!.harvest.totalKg).toBeNull();
  });
  it("puts an entry with a cycle_id fact in the named cycle, for the totals and the records alike, without an overlap", () => {
    const a = cycle({ id: "a", cropId: "maize", sowingDate: "2026-03-01" });
    const b = cycle({ id: "b", sowingDate: "2026-06-01" });
    const named = e("2026-07-01", "harvest", { value: 5, unit: "kg" }, { facts: [{ field: "cycle_id", kind: "original", source: "farmer", value: "a" }] });
    const unknown = e("2026-07-02", "harvest", { value: 7, unit: "kg" }, { facts: [{ field: "cycle_id", kind: "original", source: "farmer", value: "nope" }] });
    const r = Object.fromEntries(cycleRecords([named, unknown], [a, b], TODAY).map((x) => [x.cycleId, x]));
    expect(r.a!.harvest.totalKg).toBe(5);
    expect(r.b!.harvest.totalKg).toBe(7); // unknown cycle: the date rule (started last)
    const t = Object.fromEntries(seasonTotals([named, unknown], [a, b], TODAY).map((x) => [x.cycleId, x]));
    expect(t.a).toMatchObject({ harvestKg: 5, overlapping: 0 });
    expect(t.b).toMatchObject({ harvestKg: 7, overlapping: 1 });
  });
  it("applies the field area per cycle id only", () => {
    const entries = [e("2026-07-01", "irrigation", { value: 20, unit: "mm" })];
    const a = cycle({ id: "a", sowingDate: "2026-03-01" });
    const r = cycleRecords(entries, [a], TODAY, { areaHaByCycle: { a: 0.5, other: 9 } });
    expect(r[0]!.water.mmAsM3).toBe(100);
    expect(cycleRecords(entries, [a], TODAY, { areaHaByCycle: { other: 9 } })[0]!.water.mmAsM3).toBeNull();
  });
});
