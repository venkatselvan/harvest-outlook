import { describe, expect, it } from "vitest";
import { compareCrops, type ComparisonInput, type CompareItem } from "../src/catalogue/compare";
import { snapshotFromFiles } from "../src/catalogue/snapshot";

const snap = snapshotFromFiles();
const NOW = new Date("2026-10-30T00:00:00Z");
const base = (o: Partial<ComparisonInput> = {}): ComparisonInput => ({ location: { stateId: "IN-TN", districtId: null }, planting: { month: 6 }, irrigation: "rainfed", excludedCropIds: [], assumedPrices: [], ...o });
const run = (i: ComparisonInput, mode: "live" | "synthetic" = "live") => compareCrops(snap, i, { mode, now: NOW });
const eligible = (i: ComparisonInput) => new Set(run(i).items.filter((x) => x.outcome === "eligible").map((x) => x.cropId));
const item = (items: CompareItem[], id: string) => items.find((x) => x.productId === id)!;

describe("screening is driven by inspectable rules", () => {
  it("changing planting month changes the eligible set and names the rules", () => {
    const june = eligible(base());
    const dec = eligible(base({ planting: { month: 12 } }));
    expect(june).not.toEqual(dec);
    expect(june.has("sorghum")).toBe(true); // TN rainfed sorghum window June-July
    const sorghumDec = item(run(base({ planting: { month: 12 } })).items, "sorghum-grain");
    expect(sorghumDec.outcome).toBe("requires_review");
    expect(sorghumDec.screening.appliedRuleIds).toContain("rule.cat.sorghum.tn.rainfed.planting-outside-window");
    expect(sorghumDec.screening.reasons.every((r) => r.reviewStatus === "approved" && r.evidenceIds.length > 0)).toBe(true);
  });
  it("changing state changes the set; a state with no sourced rule is unknown, not eligible", () => {
    const as = run(base({ location: { stateId: "IN-AS" }, planting: { month: 11 }, irrigation: "irrigated" }));
    expect(item(as.items, "wheat-grain").outcome).toBe("eligible");
    const ka = run(base({ location: { stateId: "IN-KL" }, planting: { month: 11 }, irrigation: "irrigated" }));
    const wheat = item(ka.items, "wheat-grain");
    expect(wheat.outcome).toBe("unknown");
    expect(wheat.screening.noApplicableRule).toBe(true);
  });
  it("changing irrigation changes the outcome (irrigated-only source, rainfed farmer)", () => {
    const irr = item(run(base({ location: { stateId: "IN-AS" }, planting: { month: 11 }, irrigation: "irrigated" })).items, "wheat-grain");
    const rain = item(run(base({ location: { stateId: "IN-AS" }, planting: { month: 11 }, irrigation: "rainfed" }), "synthetic").items, "wheat-grain");
    expect(irr.outcome).toBe("eligible");
    expect(rain.outcome).toBe("requires_review");
    expect(rain.screening.candidateRuleIds).toContain("rule.cat.wheat.as.source-irrigated-only");
    // candidate rules do not run in live mode
    const live = item(run(base({ location: { stateId: "IN-AS" }, planting: { month: 11 }, irrigation: "rainfed" })).items, "wheat-grain");
    expect(live.screening.appliedRuleIds).not.toContain("rule.cat.wheat.as.source-irrigated-only");
  });
  it("a source window is never turned into ineligible", () => {
    for (const m of [1, 4, 7, 10]) for (const irrigation of ["rainfed", "irrigated", "unknown"] as const) {
      const out = run(base({ planting: { month: m }, irrigation }));
      expect(out.items.filter((x) => x.outcome === "ineligible")).toHaveLength(0);
    }
  });
  it("farmer exclusions rank last", () => {
    const out = run(base({ excludedCropIds: ["sorghum"] }));
    expect(item(out.items, "sorghum-grain").outcome).toBe("excluded_by_farmer");
    expect(out.items.at(-1)!.outcome).toBe("excluded_by_farmer");
  });
});

describe("regional exception", () => {
  const ginger = (district: string) => item(run({ location: { stateId: "IN-KA", districtId: district }, planting: { month: 5 }, irrigation: "rainfed", excludedCropIds: [], assumedPrices: [] }).items, "ginger-fresh");
  const rule = (g: CompareItem) => g.screening.reasons.find((r) => r.ruleId === "rule.ginger.ka.rainfed-rainfall-unknown")!;
  it("Hassan gets the caution exception, other Karnataka districts requires_review", () => {
    expect(rule(ginger("IN-KA-hassan")).effect).toBe("caution");
    expect(rule(ginger("IN-KA-hassan")).appliedExceptionId).not.toBeNull();
    expect(rule(ginger("IN-KA-mysuru")).effect).toBe("requires_review");
    expect(rule(ginger("IN-KA-mysuru")).appliedExceptionId).toBeNull();
  });
  it("ginger in Hassan is requires_review with unknown inputs listed, and uses Hassan stage definitions for timing", () => {
    const g = ginger("IN-KA-hassan");
    expect(g.outcome).toBe("requires_review");
    expect(g.screening.verdictBasis).toBe("review_rule"); // F4: soil-drainage-unknown holds, not escalation of soft unknowns
    expect(g.screening.unknownFields).toEqual(expect.arrayContaining(["rainfall.seasonalMm", "elevation.m"]));
    expect(g.dimensions.timeToFirstIncome.value).toMatchObject({ minDays: 210, maxDays: 240 });
    expect(g.dimensions.timeToFirstIncome.basis).toBe("stage_definitions_sum_to_harvest_open");
  });
});

describe("price, products and unknown dimensions", () => {
  it("missing price never excludes and never fabricates a number", () => {
    const out = run(base({ location: { stateId: "IN-AS" }, planting: { month: 6 }, irrigation: "unknown" }));
    for (const x of out.items) {
      expect(x.dimensions.marketAccess).toMatchObject({ status: "unavailable", missingReason: "price_access_key_gated" });
      expect(x.dimensions.economics.status).not.toBe("known");
      expect(x.priceReference.label).toBe("Unavailable — price access pending");
      expect(x.outcome).not.toBe("ineligible");
    }
    const withPrice = run(base({ location: { stateId: "IN-AS" }, planting: { month: 6 }, irrigation: "unknown" })).items.length;
    expect(withPrice).toBe(out.items.length);
  });
  it("an assumed price yields low/central/high gross value = yield x price, with costs unavailable", () => {
    const out = run(base({ location: { stateId: "IN-AS" }, planting: { month: 6 }, irrigation: "unknown", assumedPrices: [{ productId: "paddy-grain", amountInrPerKg: 20, lowInrPerKg: 15, highInrPerKg: 25 }] }));
    const p = item(out.items, "paddy-grain");
    expect(p.dimensions.economics.status).toBe("known");
    const sc = (p.dimensions.economics.value as { scenarios: { name: string; grossHarvestValueInrPerHa: string }[]; netReturn: string }).scenarios;
    // Assam sali yield reference 4500-5500 kg/ha, central 5000
    expect(Number(sc.find((s) => s.name === "low")!.grossHarvestValueInrPerHa)).toBe(4500 * 15);
    expect(Number(sc.find((s) => s.name === "central")!.grossHarvestValueInrPerHa)).toBe(5000 * 20);
    expect(Number(sc.find((s) => s.name === "high")!.grossHarvestValueInrPerHa)).toBe(5500 * 25);
    expect((p.dimensions.economics.value as { netReturn: string }).netReturn).toBe("unavailable_costs_not_sourced");
    expect(p.downside.computable).toBe(true);
    // the price is for paddy-grain only; milled rice has no yield reference or price
    expect(item(out.items, "paddy-milled-rice").dimensions.economics.status).toBe("unknown");
  });
  it("paddy grain vs milled rice and green vs dry chilli stay distinct items", () => {
    const out = run(base());
    for (const id of ["paddy-grain", "paddy-milled-rice", "chilli-green", "chilli-dry"]) expect(item(out.items, id)).toBeTruthy();
    expect(item(out.items, "paddy-grain").productBasis).not.toBe(item(out.items, "paddy-milled-rice").productBasis);
    expect(item(out.items, "chilli-green").productBasis).not.toBe(item(out.items, "chilli-dry").productBasis);
    // a yield stated for one product is not applied to its sibling
    const as = run(base({ location: { stateId: "IN-AS" }, planting: { month: 6 }, assumedPrices: [{ productId: "paddy-milled-rice", amountInrPerKg: 30 }] }));
    const milled = item(as.items, "paddy-milled-rice");
    expect(milled.yieldReference?.appliesToProduct).toBe(false);
    expect(milled.dimensions.economics).toMatchObject({ status: "unknown", missingReason: "yield_basis_differs_from_product_conversion_not_sourced" });
  });
  it("unknown dimensions stay unknown and lower completeness instead of scoring zero", () => {
    const known = item(run(base({ irrigation: "irrigated", planting: { month: 4 } })).items, "sorghum-grain");
    const unk = item(run(base({ irrigation: "unknown", planting: { month: 4 } })).items, "sorghum-grain");
    expect(known.dimensions.waterFit.status).toBe("known");
    expect(unk.dimensions.waterFit).toMatchObject({ status: "unknown", missingReason: "farmer_irrigation_unknown", value: null });
    expect(unk.completeness.known).toBe(known.completeness.known - 1);
    expect(unk.completeness.total).toBe(6);
    expect(unk.dimensions.marketAccess.value).toBeNull();
  });
});

describe("F4 screening semantics: HARD/SOFT aggregation, product and region scope", () => {
  const ka = (district: string | null, o: Partial<ComparisonInput> = {}, mode: "live" | "synthetic" = "live") =>
    run({ location: { stateId: "IN-KA", districtId: district }, planting: { month: 5 }, irrigation: "rainfed", excludedCropIds: [], assumedPrices: [], ...o }, mode);
  const ruleOf = (g: CompareItem, id: string) => g.screening.reasons.find((r) => r.ruleId === id);

  it("Hassan, May, rainfed, nothing else known: requires_review only because the source's drainage-unknown rule holds", () => {
    const g = item(ka("IN-KA-hassan").items, "ginger-fresh");
    expect(g.outcome).toBe("requires_review");
    expect(g.screening.verdictBasis).toBe("review_rule");
    expect(ruleOf(g, "rule.ginger.soil-drainage-unknown")).toMatchObject({ truth: "true", effect: "requires_review" });
    expect(ruleOf(g, "rule.ginger.ka.rainfed-rainfall-unknown")).toMatchObject({ truth: "true", effect: "caution", ruleEffect: "requires_review" });
    const u = g.screening.unresolvedConditions.map((x) => `${x.ruleId}|${x.field}|${x.effectIfTrue}`);
    expect(u).toEqual([
      "rule.ginger.soil-drainage-poor|soil.drainage|requires_review",
      "rule.ginger.soil-drainage-good|soil.drainage|prefer",
      "rule.ginger.soil-texture-listed|soil.texture|prefer",
      "rule.ginger.elevation-above-source-range|elevation.m|requires_review",
      "rule.ginger.rainfed-rainfall-below-requirement|rainfall.seasonalMm|caution",
    ]);
    expect(g.screening.unresolvedConditions.every((x) => x.evidenceIds.length > 0 && x.why)).toBe(true);
    expect(g.screening.confidenceNote).toMatchObject({ resolvedRules: 2, unresolvedRules: 5, unresolvedFields: 4 });
    // the soft unknowns are reported with their declared effect, not as an escalation
    expect(ruleOf(g, "rule.ginger.soil-drainage-good")).toMatchObject({ truth: "unknown", ruleEffect: "prefer" });
  });

  it("Hassan with drainage known good: no ginger rule decides eligibility, so unknown (never eligible), caution and 3 unresolved inputs listed", () => {
    const g = item(ka("IN-KA-hassan", { soil: { drainage: "good" } }).items, "ginger-fresh");
    expect(g.outcome).toBe("unknown");
    expect(g.screening.verdictBasis).toBe("no_applicable_hard_rule");
    expect(ruleOf(g, "rule.ginger.soil-drainage-good")).toMatchObject({ truth: "true", effect: "prefer" });
    expect(ruleOf(g, "rule.ginger.ka.rainfed-rainfall-unknown")).toMatchObject({ effect: "caution", appliedExceptionId: "exc.ginger.hassan-district-normal-rainfall" });
    expect([...new Set(g.screening.unresolvedConditions.map((x) => x.field))]).toEqual(["soil.texture", "elevation.m", "rainfall.seasonalMm"]);
  });

  it("Mysuru with drainage known good: requires_review from the state-wide rainfall-unknown rule (no Hassan exception)", () => {
    const g = item(ka("IN-KA-mysuru", { soil: { drainage: "good" } }).items, "ginger-fresh");
    expect(g.outcome).toBe("requires_review");
    expect(g.screening.verdictBasis).toBe("review_rule");
    expect(ruleOf(g, "rule.ginger.ka.rainfed-rainfall-unknown")).toMatchObject({ truth: "true", effect: "requires_review", appliedExceptionId: null });
  });

  it("poor drainage known -> requires_review (the rule file's effect), not ineligible", () => {
    const g = item(ka("IN-KA-hassan", { soil: { drainage: "poor" } }).items, "ginger-fresh");
    expect(g.outcome).toBe("requires_review");
    expect(ruleOf(g, "rule.ginger.soil-drainage-poor")).toMatchObject({ truth: "true", effect: "requires_review", reasonCodes: ["poor_drainage_soft_rot_risk"] });
  });

  it("ginger-dry receives the same agronomic rules and verdict as ginger-fresh", () => {
    for (const o of [{}, { soil: { drainage: "good" as const } }, { soil: { drainage: "poor" as const } }, { planting: { month: 8 } }]) {
      for (const d of ["IN-KA-hassan", "IN-KA-mysuru", null]) {
        const items = ka(d, o).items;
        const fresh = item(items, "ginger-fresh");
        const dry = item(items, "ginger-dry");
        expect(dry.outcome).toBe(fresh.outcome);
        expect(dry.screening.appliedRuleIds).toEqual(fresh.screening.appliedRuleIds);
        expect(dry.screening.appliedRuleIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("an unknown HARD rule gives requires_review; the known input resolves it", () => {
    const unk = item(run(base({ irrigation: "unknown" })).items, "sorghum-grain");
    expect(unk.outcome).toBe("requires_review");
    expect(unk.screening.verdictBasis).toBe("hard_rule_unresolved");
    expect(unk.screening.unresolvedConditions.some((u) => u.ruleId === "rule.cat.sorghum.tn.rainfed.planting-in-window" && u.field === "irrigation.category" && u.effectIfTrue === "eligible")).toBe(true);
    expect(item(run(base()).items, "sorghum-grain")).toMatchObject({ outcome: "eligible", screening: { verdictBasis: "hard_eligible" } });
  });

  it("no applicable HARD rule -> unknown, not eligible", () => {
    const w = item(run(base({ location: { stateId: "IN-KL" }, planting: { month: 11 }, irrigation: "irrigated" })).items, "wheat-grain");
    expect(w).toMatchObject({ outcome: "unknown", screening: { verdictBasis: "no_applicable_hard_rule", noApplicableRule: true } });
  });

  it("rules scoped to another state never apply with an unknown district", () => {
    const out = run(base({ location: { stateId: "IN-TN", districtId: null } }));
    const applied = out.items.flatMap((i) => i.screening.reasons);
    expect(applied.length).toBeGreaterThan(0);
    for (const r of applied) expect(r.regionIds.some((id) => id === "IN" || id === "IN-TN" || id.startsWith("IN-TN-"))).toBe(true);
    for (const i of out.items) expect(i.screening.unresolvedConditions.filter((u) => u.field.startsWith("location."))).toEqual([]);
  });

  it("a district-scoped rule honours the district (synthetic mode runs the Hassan-only candidate rule)", () => {
    const id = "rule.ginger.hassan.may-premonsoon-planting";
    const has = (d: string | null, stateId = "IN-KA") =>
      item(run({ location: { stateId, districtId: d }, planting: { month: 5 }, irrigation: "rainfed", soil: { drainage: "good" }, excludedCropIds: [], assumedPrices: [] }, "synthetic").items, "ginger-fresh");
    expect(ruleOf(has("IN-KA-hassan"), id)).toMatchObject({ truth: "true", effect: "prefer" });
    expect(ruleOf(has("IN-KA-mysuru"), id)).toBeUndefined();
    expect(ruleOf(has(null, "IN-TN"), id)).toBeUndefined();
    const noDistrict = has(null);
    expect(ruleOf(noDistrict, id)).toMatchObject({ truth: "unknown" });
    expect(noDistrict.screening.unresolvedConditions).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: id, field: "location.districtId", effectIfTrue: "prefer" })]));
  });

  it("keeps the T06b response fields (additive change)", () => {
    const g = item(ka("IN-KA-hassan").items, "ginger-fresh");
    expect(Object.keys(g.screening)).toEqual(expect.arrayContaining(["reasons", "unknownFields", "appliedRuleIds", "evidenceIds", "candidateRuleIds", "noApplicableRule", "verdictBasis", "unresolvedConditions", "confidenceNote"]));
    expect(Object.keys(g.screening.reasons[0]!)).toEqual(expect.arrayContaining(["ruleId", "effect", "truth", "reasonCodes", "appliedExceptionId", "reviewStatus", "reviewer", "regionIds", "evidenceIds", "unknownFields", "ruleEffect"]));
  });
});

describe("price reference (L3)", () => {
  const ginger = (o: Parameters<typeof compareCrops>[2]) => item(compareCrops(snap, base({ location: { stateId: "IN-KA" }, planting: { month: 5 } }), o).items, "ginger-fresh");
  const block = {
    state: "historical_reference", evidenceState: "observed", label: "Mandi reference (wholesale), not a farm-gate price", notForecast: true, marketId: "synth-a", marketName: "Synth A", stateName: "Karnataka",
    lastQuote: { inrPerKg: "120.00", date: "2026-10-29", variety: "Synth Variety", grade: "Local", sourceUnit: "INR/quintal", evidenceState: "observed", evidenceIds: ["doc"] },
    weeklyRange: { lowInrPerKg: "70.00", highInrPerKg: "110.00", label: "Range of weekly medians (last 52 weeks); not a prediction interval", weeks: 7, evidenceState: "derived" }, fallbackNote: null, otherMarkets: 0,
  } as const;
  it("default and config-driven missing reasons come from the caller, never hard-wired", () => {
    expect(ginger({ mode: "live", now: NOW }).priceReference).toMatchObject({ state: "unavailable", missingReason: "price_access_key_gated", text: expect.stringMatching(/Price access pending/) });
    const g = ginger({ mode: "live", now: NOW, priceMissingReason: "price_history_not_ingested" });
    expect(g.priceReference).toMatchObject({ state: "unavailable", missingReason: "price_history_not_ingested", text: "Price history not ingested yet" });
    expect(g.dimensions.marketAccess.missingReason).toBe("price_history_not_ingested");
  });
  it("carries a supplied reference with its labels, and a reference never becomes the farmer's price or an economics figure", () => {
    const g = ginger({ mode: "live", now: NOW, priceReferences: { "ginger-fresh": block as never } });
    expect(g.priceReference).toMatchObject({ state: "historical_reference", notForecast: true, label: "Mandi reference (wholesale), not a farm-gate price" });
    expect(g.dimensions.economics.status).toBe("unknown"); // no assumed price supplied: the mandi quote is not used as one
    expect(JSON.stringify(g.dimensions.economics)).not.toMatch(/120\.00/);
    expect(g.downside.computable).toBe(false);
  });
});
