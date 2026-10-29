import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@harvest/contracts";
import { canonicalRegionId, knownInHardRule, regionApplies } from "@harvest/domain";
import { clarificationOptionProblem, evaluateGate, type EvidenceFact, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { unitAtPointer } from "../src/agent/tool-units";
import { validateCatalogue } from "../src/catalogue/load";
import { GINGER_ID } from "./fixtures/meta/helpers";

/** F8: closes the R3a gate holes (dosage/diagnosis/rain wording, model-declared units, product scope, clarification options). */
const OWNER = "o";
const RUN = "r";
const ctx = (o: Partial<GateContext> = {}): GateContext => ({ ownerId: OWNER, mode: "synthetic", agentRunId: RUN, asOf: "2026-10-30T06:00:00Z", language: "en", claimScope: { geographyIds: [], districtIds: ["IN-KA-HAS"], stateIds: ["KA", "IN-KA"], regionIds: [], cropIds: [GINGER_ID] }, userText: "I have 2 acres in Hassan", rainHorizonDays: 7, ...o });
const q = (value: number | string, unit: string) => ({ kind: "quantity", value, unit });
const tr = (id: string, result: unknown, toolName = "calculate_scenarios"): StoredToolResult => ({ id, ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName, status: "ok", result });
const legacy = tr("t1", { areaAcre: 2, count: 3, pct: 5, netInr: "200000" });
const rec = tr("t2", { area: q(2, "acre"), rate: q(2, "kg/acre"), rain: q(12, "mm"), count: { kind: "category", value: "3", unit: null } });
const ev = (id: string, o: Partial<EvidenceFact> = {}): EvidenceFact => ({ id, mode: "synthetic", validationStatus: "validated", geographyLevel: "district", geographyIds: ["IN-KA-HAS"], cropIds: [GINGER_ID], effectiveAvailableAt: "2026-01-01T00:00:00.000Z", availabilityBasis: "verified_publication", ...o });
const facts = (e: EvidenceFact[] = []): GateFacts => ({ toolResults: new Map([["t1", legacy], ["t2", rec]]), evidence: new Map(e.map((x) => [x.id, x])), knownCropIds: new Set([GINGER_ID]), productForms: new Map([["ginger-fresh", "fresh"], ["ginger-dry", "dry"]]) });
const ref = (id: string, p: string, unit: string, sourceUnit = unit, tid = "t2") => ({ id, toolResultId: tid, jsonPointer: p, presentation: { unit, sourceUnit, rounding: { mode: "decimals", digits: 0 }, intervalLabel: "none" } });
const out = (o: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], limitations: [], ...o });
const blk = (text: string, refs: string[] = [], claims: string[] = []) => ({ id: "b1", kind: refs.length ? "numeric" : claims.length ? "evidence" : "text", text, numericRefIds: refs, claimIds: claims });
const one = (text: string, refs: ReturnType<typeof ref>[] = [], lang = "en", c: Partial<GateContext> = {}) => evaluateGate(out({ language: lang, answerBlocks: [blk(text, refs.map((r) => r.id))], numericRefs: refs }), ctx({ language: lang, ...c }), facts());
const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);

describe("F8 R3a #1: every previously approved probe string is now withheld", () => {
  const unit = [ref("n1", "/count", "acre", "acre", "t1")];
  const cases: [string, string, ReturnType<typeof ref>[], string][] = [
    ["romanised hi dose (en)", "Do litre per acre spray karo.", [], "en"],
    ["romanised hi dose (hi)", "Do litre per acre spray karo.", [], "hi"],
    ["romanised ta urea (ta)", "Oru kilo urea podunga.", [], "ta"],
    ["romanised ta urea (en)", "Oru kilo urea podunga per acre.", [], "en"],
    ["a kilo of urea", "Apply a kilo of urea per acre.", [], "en"],
    ["half a litre", "Spray half a litre of mancozeb per tank.", [], "en"],
    ["a dozen bags", "Use a dozen bags of urea.", [], "en"],
    ["ta colloquial", "ரெண்டு லிட்டர் போடுங்க.", [], "ta"],
    ["percent ref loss guaranteed", "There is a 5 percent loss guaranteed if you wait.", [ref("n1", "/pct", "percent", "percent", "t1")], "en"],
    ["guaranteed loss words", "Waiting will guarantee a loss of half the crop.", [], "en"],
    ["negation trick 2", "This isn't drought stress, it's bacterial wilt.", [], "en"],
    ["diagnosis without subject", "Bacterial wilt is what is happening here.", [], "en"],
    ["diagnosis you have", "You have rhizome rot in the field.", [], "en"],
    ["rain by date no verb", "Heavy showers on 20 November.", [], "en"],
    ["rain by weekday", "Rain is expected next Friday fortnight.", [], "en"],
    ["unitless field as acre", "Your farm is 3 acres.", unit, "en"],
    ["unitless field as kg", "Harvest 3 kg.", [ref("n1", "/count", "kg", "kg", "t1")], "en"],
    ["template imitation (unitless ref)", "The number for net inr is ₹200000.", [ref("n1", "/netInr", "INR", "INR", "t1")], "en"],
    ["hi sawa", "सवा किलो प्रति एकड़।", [], "hi"],
    ["en a couple of", "Apply a couple of kilos of urea per acre.", [], "en"],
    ["en half", "Apply half a kilo of urea.", [], "en"],
    ["farmer number as dose", "For 2 acres, apply 2 acres of urea.", [], "en"],
  ];
  for (const [name, text, refs, lang] of cases)
    it(name, () => {
      const r = one(text, refs, lang, lang === "en" ? {} : { userText: "" });
      expect(r.approvedBlocks, `${name}: ${codes(r).join(",")}`).toEqual([]);
    });
  it("acceptable: farmer-number template imitation without a dose stays approved", () => {
    expect(one("Please consult a local agricultural officer before applying any chemical. The number for area acre is 2 acres.").status).toBe("approved");
  });
  it("specific codes", () => {
    expect(codes(one("Apply a kilo of urea per acre."))).toContain("chemical_dosage");
    expect(codes(one("Spray mancozeb by the litre."))).toContain("chemical_dosage");
    expect(codes(one("You have rhizome rot in the field."))).toContain("diagnosis_certainty");
    expect(codes(one("Heavy showers on 20 November."))).toContain("future_daily_rain_beyond_horizon");
    expect(codes(one("Showers are likely on 2 November."))).not.toContain("future_daily_rain_beyond_horizon");
    expect(codes(one("Waiting will guarantee a loss."))).toContain("guaranteed_profit");
    expect(codes(one("Spray when convenient.", [], "hi", { userText: "" }))).toContain("native_risk_term_unsupported");
  });
});

describe("F8 R3a #2: units come from the tool output", () => {
  it("derives units from unit-bearing records and the server map; refuses unitless fields", () => {
    expect(unitAtPointer("x", rec.result, "/area/value")).toEqual({ unit: "acre", basis: "unit_record" });
    expect(unitAtPointer("x", { y: { unit: "INR/kg", amount: { low: 1, central: 2, high: 3 } } }, "/y/amount/central")?.unit).toBe("INR/kg");
    expect(unitAtPointer("x", rec.result, "/count/value")).toBeNull();
    expect(unitAtPointer("calculate_scenarios", legacy.result, "/count")).toBeNull();
    expect(unitAtPointer("calculate_scenarios", { result: { scenarios: [{ total: { netCashReturnInr: "5" } }] } }, "/result/scenarios/0/total/netCashReturnInr")?.unit).toBe("INR");
    expect(unitAtPointer("calculate_water_balance", { result: { runs: [{ grossLitresPerHa: 5 }] } }, "/result/runs/0/grossLitresPerHa")).toBeNull();
  });
  it("count displayed as acres is blocked; ValueRecord with unit allowed; sourceUnit mismatch blocked", () => {
    expect(codes(one("Your farm is 3 acres.", [ref("n1", "/count", "acre", "acre", "t1")]))).toContain("numeric_ref_unit_unknown");
    expect(one("Your farm is 2 acres.", [ref("n1", "/area/value", "acre")]).status).toBe("approved");
    expect(one("Your farm is 0.81 ha.", [{ ...ref("n1", "/area/value", "ha", "acre"), presentation: { unit: "ha", sourceUnit: "acre", rounding: { mode: "decimals", digits: 2 }, intervalLabel: "none" } }]).status).toBe("approved");
    expect(codes(one("Your farm is 2 ha.", [ref("n1", "/area/value", "ha", "ha")]))).toContain("numeric_ref_unit_mismatch");
  });
  it("acceptable: a ref-backed, evidence-backed kg/acre rate passes", () => {
    const r = evaluateGate(out({ answerBlocks: [blk("Apply 2 kg per acre of urea at district level.", ["n1"], ["c1"])], numericRefs: [ref("n1", "/rate/value", "kg/acre")], claimEvidenceRefs: [{ claimId: "c1", text: "Urea rate", evidenceIds: ["e1"] }] }), ctx(), facts([ev("e1")]));
    expect(r.status).toBe("approved");
  });
});

describe("F8 R3a #3: product scope", () => {
  const claim = (text: string, extra: Record<string, unknown> = {}, e: EvidenceFact[] = [ev("e1")], c: Partial<GateContext> = {}) =>
    evaluateGate(out({ answerBlocks: [blk(text, [], ["c1"])], claimEvidenceRefs: [{ claimId: "c1", text: "Price evidence", evidenceIds: ["e1"], ...extra }] }), ctx(c), facts(e));
  it("a product-form claim without product scope is blocked", () => expect(codes(claim("Dry ginger prices in Hassan are reported."))).toContain("claim_product_scope_missing"));
  it("dry claim citing fresh-ginger evidence is blocked", () => expect(codes(claim("Dry ginger prices in Hassan are reported.", { productIds: ["ginger-dry"] }, [ev("e1", { productIds: ["ginger-fresh"] })]))).toContain("evidence_scope_product"));
  it("form word must match the declared product", () => expect(codes(claim("Dry ginger prices in Hassan are reported.", { productIds: ["ginger-fresh"] }, [ev("e1", { productIds: ["ginger-fresh"] })]))).toContain("claim_product_form_mismatch"));
  it("crop-level evidence cannot support a product claim", () => expect(codes(claim("Dry ginger prices in Hassan are reported.", { productIds: ["ginger-dry"] }))).toContain("evidence_scope_product"));
  it("matching product evidence passes; plan product is used when undeclared", () => {
    expect(claim("Dry ginger prices in Hassan are reported.", { productIds: ["ginger-dry"] }, [ev("e1", { productIds: ["ginger-dry"] })]).status).toBe("approved");
    expect(claim("Dry ginger prices in Hassan are reported.", {}, [ev("e1", { productIds: ["ginger-dry"] })], { claimScope: { ...ctx().claimScope, productIds: ["ginger-dry"] } }).status).toBe("approved");
    expect(claim("Ginger prices in Hassan are reported.").status).toBe("approved");
  });
});

describe("F8 R3a #5: clarification options", () => {
  const table: [string, string, boolean][] = [
    ["irrigation", "Yes", true], ["irrigation", "borewell", true], ["irrigation", "rain only", true], ["area", "2 acres", true], ["district", "Hassan", true], ["planting_window", "June", true],
    ["irrigation", "Spray mancozeb on the beds", false], ["irrigation", "Yes, apply urea now", false], ["irrigation", "Your crop has wilt", false], ["other", "a very long option text that goes on and on", false], ["soil", "use dawa karo", false],
  ];
  for (const [field, opt, ok] of table) it(`${field}: ${opt}`, () => expect(clarificationOptionProblem(field, opt) === null).toBe(ok));
  it("removes unsafe options and records them", () => {
    const r = evaluateGate(out({ clarifications: [{ id: "c1", field: "irrigation", question: "Do you irrigate?", options: ["Yes", "Spray mancozeb on the beds", "No"] }] }), ctx(), facts());
    expect(r.approvedClarifications[0]!.options).toEqual(["Yes", "No"]);
    expect(r.report.removed).toContainEqual(expect.objectContaining({ field: "clarificationOption", index: 1 }));
  });
});

describe("F8 R3a #9/#10: region ids and known in HARD rules", () => {
  it("canonicalises region ids", () => {
    expect(canonicalRegionId("typed:KA:hassan")).toBe("in-ka-hassan");
    expect(canonicalRegionId("IN-KA-HAS", { regionAliases: { "IN-KA-HAS": "IN-KA-hassan" } })).toBe("in-ka-hassan");
    expect(regionApplies(["IN-KA-hassan"], { districtId: "typed:KA:hassan", stateId: null } as never).truth).toBe("true");
    expect(regionApplies(["IN-KA-hassan"], { districtId: "IN-KA-HAS", stateId: "IN-KA" } as never).truth).toBe("false");
    expect(regionApplies(["IN-KA-hassan"], { districtId: "IN-KA-HAS", stateId: "IN-KA" } as never, { regionAliases: { "IN-KA-HAS": "IN-KA-hassan" } }).truth).toBe("true");
  });
  const rule = (o: Record<string, unknown>) => ({ id: "r1", cropId: "ginger", scope: { regionIds: ["IN-KA-HAS"], seasons: [], irrigation: [] }, when: { field: "soil.ph", op: "known", value: false }, effect: { type: "ineligible", reasonCode: "x" }, exceptions: [], ...o }) as never;
  it("rejects known in a HARD rule and unknown region ids at load (synthetic rule file)", () => {
    expect(knownInHardRule(rule({}))).toEqual(["r1.when"]);
    expect(knownInHardRule(rule({ effect: { type: "caution", reasonCode: "x" } }))).toEqual([]);
    const v = validateCatalogue({ ruleSets: [{ file: "rules/synthetic.rules.json", sourceId: "t", rules: [rule({})], reviewers: {} }], stages: [], coverage: [], areas: [{ id: "IN-KA-hassan" } as never] });
    expect(v.unknownRegionIds).toEqual([{ where: "rules/synthetic.rules.json#r1", id: "IN-KA-HAS" }]);
    expect(v.knownInHardRules).toEqual(["rules/synthetic.rules.json#r1.when"]);
  });
});
