import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@harvest/contracts";
import { clarificationOptionProblem, cropNameList, evaluateGate, productFormsIn, textScopeProblems, type EvidenceFact, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { compatNormalise, unsupportedNumberChar } from "../src/agent/numbers";
import { isRegistryPlace } from "../src/agent/place-names";
import { unitAtPointer } from "../src/agent/tool-units";
import { GINGER_ID } from "./fixtures/meta/helpers";

/** F13: closes the R4 output-gate bypasses (numeral characters, native number words, text scope, implied doses/diagnoses, options, yields, unit records). */
const OWNER = "o";
const RUN = "r";
const TURMERIC = "00000000-0000-4000-8000-0000000000c2";
const CHILLI = "00000000-0000-4000-8000-0000000000c3";
const PIGEON = "00000000-0000-4000-8000-0000000000c4";
const ctx = (o: Partial<GateContext> = {}): GateContext => ({ ownerId: OWNER, mode: "synthetic", agentRunId: RUN, asOf: "2026-10-30T06:00:00Z", language: "en", claimScope: { geographyIds: [], districtIds: ["IN-KA-hassan"], stateIds: ["IN-KA"], regionIds: [], cropIds: [GINGER_ID] }, userText: "", rainHorizonDays: 7, ...o });
const q = (value: number | string, unit: string) => ({ kind: "quantity", value, unit });
const tr = (id: string, result: unknown, toolName: string): StoredToolResult => ({ id, ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName, status: "ok", result });
// get_market_outlook /references/* is an allowlisted unit-record location.
const refs = tr("t1", { references: [q(2, "acre"), q(200000, "INR"), q(2050, "INR/quintal")] }, "get_market_outlook");
const scen = tr("t2", { result: { scenarios: [{ perHa: { marketableKgTotal: 8000, netCashReturnInr: "250000" }, total: { netCashReturnInr: "200000" } }] }, echo: q(5, "kg"), references: [q(5, "kg")] }, "calculate_scenarios");
const obs = tr("t3", { proposals: [{ field: "area", proposed: q(2, "acre"), uncertainty: { kind: "none", value: null, note: "" }, requiresConfirmation: true }] }, "interpret_observation");
const ev = (id: string, o: Partial<EvidenceFact> = {}): EvidenceFact => ({ id, mode: "synthetic", validationStatus: "validated", geographyLevel: "district", geographyIds: ["IN-KA-hassan"], cropIds: [GINGER_ID], effectiveAvailableAt: "2026-01-01T00:00:00.000Z", availabilityBasis: "verified_publication", ...o });
const cropNames = new Map([[GINGER_ID, ["Ginger"]], [TURMERIC, ["Turmeric"]], [CHILLI, ["Chilli"]], [PIGEON, ["Pigeon pea", "Red gram", "Arhar"]]]);
const facts = (e: EvidenceFact[] = [ev("e1")]): GateFacts => ({ toolResults: new Map([["t1", refs], ["t2", scen], ["t3", obs]]), evidence: new Map(e.map((x) => [x.id, x])), knownCropIds: new Set([GINGER_ID]), productForms: new Map([["ginger-fresh", "fresh"]]), cropNames });
const ref = (id: string, p: string, unit: string, sourceUnit = unit, tid = "t1") => ({ id, toolResultId: tid, jsonPointer: p, presentation: { unit, sourceUnit, rounding: { mode: "decimals", digits: 0 }, intervalLabel: "none" } });
const ACRE = ref("n1", "/references/0/value", "acre");
const INR = ref("n1", "/references/1/value", "INR");
const out = (o: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], limitations: [], ...o });
const blk = (text: string, r: string[] = [], claims: string[] = []) => ({ id: "b1", kind: r.length ? "numeric" : claims.length ? "evidence" : "text", text, numericRefIds: r, claimIds: claims });
const one = (text: string, r: ReturnType<typeof ref>[] = [], lang = "en") => evaluateGate(out({ language: lang, answerBlocks: [blk(text, r.map((x) => x.id))], numericRefs: r }), ctx({ language: lang }), facts());
const claim = (text: string, claimText = text) => evaluateGate(out({ answerBlocks: [blk(text, [], ["c1"])], claimEvidenceRefs: [{ claimId: "c1", text: claimText, evidenceIds: ["e1"] }] }), ctx(), facts());
const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);

describe("R4 #1: non-ASCII numeral characters", () => {
  const chars: [string, string][] = [
    ["full-width", "２"], ["superscript", "²"], ["subscript", "₂"], ["vulgar fraction", "½"], ["mathematical bold", "𝟐"], ["mathematical double-struck", "𝟚"], ["circled", "②"],
    ["parenthesised", "⑵"], ["Thai", "๒"], ["Myanmar", "၂"], ["Tibetan", "༢"], ["Khmer", "២"], ["Tamil ten", "௰"], ["Devanagari", "२"], ["Arabic-Indic", "٢"], ["fraction slash", "1⁄2"],
  ];
  it.each(chars)("%s (%s) in an unreferenced amount is withheld", (_n, c) => {
    for (const text of [`Net return will be ₹${c} lakh per acre.`, `Use ${c} bags per bed.`]) {
      const r = one(text);
      expect(r.status).not.toBe("approved");
      expect(r.approvedBlocks).toEqual([]);
      expect(codes(r).some((x) => ["prose_number_without_ref", "unsupported_number"].includes(x))).toBe(true);
    }
  });
  it("normalisation maps compatibility digits and folds vulgar fractions; unmappable numerals are reported", () => {
    expect(compatNormalise("₹½ lakh")).toMatch(/0\.5/);
    expect(compatNormalise("𝟐𝟎 ① ¹²")).toBe("20 1 12");
    expect(unsupportedNumberChar("๒ lakh")).toBe("๒");
    expect(unsupportedNumberChar("௰")).toBe("௰");
    expect(unsupportedNumberChar("２０ and ४० and 𝟐")).toBeNull();
    expect(codes(one("Net return will be ₹๒ lakh per acre."))).toContain("unsupported_number");
  });
  it("property: every Unicode numeric character (Nd/Nl/No) in an unreferenced amount is withheld", () => {
    const leaks: string[] = [];
    let n = 0;
    for (let cp = 0; cp <= 0x1ffff; cp++) {
      const c = String.fromCodePoint(cp);
      if (!/\p{N}/u.test(c)) continue;
      n++;
      const r = one(`Net return will be ₹${c}${c} per acre.`);
      if (r.status === "approved") leaks.push(`U+${cp.toString(16)}`);
    }
    expect(n).toBeGreaterThan(1000);
    expect(leaks).toEqual([]);
  });
  it("positive control: full-width digits that equal a referenced value pass", () => {
    expect(one("Net cash return could be ₹２０００００ for your farm.", [INR]).status).toBe("approved");
  });
});

describe("R4 #2: Hindi/Tamil number words count by default; traditional units", () => {
  it.each([
    ["दो गज की दूरी पर पौधे लगाएं।", "hi"],
    ["एक सेर खाद हर पौधे में डालें।", "hi"],
    ["हर पौधे को एक सेर पानी दें।", "hi"],
    ["तीन बीघा में अदरक लगाएं।", "hi"],
    ["दो पौधों के बीच जगह रखें।", "hi"],
    ["ஒரு படி உரம் போடுங்க.", "ta"],
    ["இரண்டு அடி இடைவெளி விடுங்கள்.", "ta"],
    ["ரெண்டு மரக்கால் விதை போதும்.", "ta"],
    ["ஒரு செடிக்கு தண்ணீர் விடுங்கள்.", "ta"],
  ])("%s is withheld", (text, lang) => {
    const r = one(text, [], lang);
    expect(r.approvedBlocks).toEqual([]);
    expect(codes(r)).toContain("prose_number_without_ref");
  });
  it.each([
    ["पानी दो।", "hi"],
    ["सब पौधे एक साथ लगाएं।", "hi"],
    ["ஒரு வேளாண் அலுவலரை அணுகவும்.", "ta"],
  ])("documented idiom passes: %s", (text, lang) => {
    expect(one(text, [], lang).status).toBe("approved");
  });
  it("positive controls with references pass", () => {
    expect(one("आपके खेत का क्षेत्रफल 2 एकड़ है।", [ACRE], "hi").status).toBe("approved");
    expect(one("உங்கள் நிலம் 2 ஏக்கர்.", [ACRE], "ta").status).toBe("approved");
    expect(one("आपके खेत का क्षेत्रफल दो एकड़ है।", [ACRE], "hi").status).toBe("approved");
  });
});

describe("R4 #3: product forms and the text scope of evidence-cited claims", () => {
  it.each([
    ["Split pigeon pea (dal) prices in Hassan are high.", ["claim_product_scope_missing", "claim_text_scope_mismatch"]],
    ["Whole grain prices in Hassan are rising.", ["claim_product_scope_missing"]],
    ["Turmeric prices in Hassan rose this season.", ["claim_text_scope_mismatch"]],
    ["Ginger prices in Wayanad rose this season.", ["claim_text_scope_mismatch"]],
    ["Ginger prices in Mandya rose this season.", ["claim_text_scope_mismatch"]],
    ["Ginger prices in Tamil Nadu rose this season.", ["claim_text_scope_mismatch"]],
    ["Evidence for chilli in your district is a machine-grounded excerpt; human review pending.", ["claim_text_scope_mismatch"]],
    ["Red gram did well in Hassan.", ["claim_text_scope_mismatch"]],
  ])("%s is withheld", (text, expected) => {
    const r = claim(text);
    expect(r.approvedBlocks).toEqual([]);
    expect(r.approvedClaimEvidenceRefs).toEqual([]);
    for (const c of expected) expect(codes(r)).toContain(c);
  });
  it("positive controls: own crop, own district, own state, 'your district'", () => {
    for (const t of ["Ginger prices in Hassan rose this season.", "Ginger prices in Karnataka rose this season.", "Evidence for ginger in your district is a machine-grounded excerpt.", "Keep the soil evenly moist during rhizome development; the seed rate matters."]) {
      expect(claim(t).status).toBe("approved");
    }
  });
  it("form words count only as product forms, not agronomy", () => {
    expect(productFormsIn("Split pigeon pea (dal) prices")).toEqual(expect.arrayContaining(["split"]));
    expect(productFormsIn("Groundnut kernels sell well")).toEqual(["kernel"]);
    expect(productFormsIn("groundnut in shell")).toEqual(["pod"]);
    expect(productFormsIn("Onion bulbs are stored dry")).toContain("bulb");
    expect(productFormsIn("Unmilled rice is sold at the mandi")).toContain("paddy");
    expect(productFormsIn("साबुत चना")).toEqual(["whole"]);
    expect(productFormsIn("Check the whole field; use a split application; watch for pod borer and fruit borer; keep the seed rate; rhizome development is slow.")).toEqual([]);
  });
  it("crop names come from the catalogue rows; nested in-scope names are not out of scope", () => {
    expect(cropNameList("pigeon-pea", { en: [{ text: "Pigeon pea", kind: "common" }, { text: "Red gram", kind: "alias" }] })).toEqual(expect.arrayContaining(["pigeon pea", "Pigeon pea", "Red gram"]));
    expect(cropNameList("paddy", { en: [{ text: "Paddy / rice" }] })).toEqual(expect.arrayContaining(["Paddy", "rice"]));
    const names = new Map([["a", ["Pigeon pea"]], ["b", ["pea"]]]);
    expect(textScopeProblems(["Pigeon pea prices"], ["a"], names, { districtIds: [], stateIds: [] })).toEqual([]);
    expect(textScopeProblems(["pea prices"], ["a"], names, { districtIds: [], stateIds: [] })).toEqual(['crop "pea"']);
  });
});

describe("R4 #4: instructions, diagnoses and magnitudes without numbers", () => {
  it.each([
    ["Mix the fungicide stronger this time.", "chemical_dosage"],
    ["Spray the fungicide every few days until it stops.", "chemical_dosage"],
    ["Double the usual dose of copper fungicide.", "chemical_dosage"],
    ["The rot has reached the rhizomes.", "diagnosis_certainty"],
    ["Those yellow leaves show bacterial wilt.", "diagnosis_certainty"],
    ["Rot is spreading through your beds; remove affected clumps.", "diagnosis_certainty"],
    ["You will earn lakhs per acre from ginger.", "prose_number_without_ref"],
    ["Ginger prices will double by harvest.", "guaranteed_profit"],
    ["हज़ारों रुपये की कमाई होगी।", "prose_number_without_ref"],
  ])("%s is withheld", (text, code) => {
    const r = one(text, [], /[ऀ-ॿ]/.test(text) ? "hi" : "en");
    expect(r.approvedBlocks).toEqual([]);
    expect(codes(r)).toContain(code);
  });
  it("a limitation telling the farmer to drench beds with fungicide is removed", () => {
    const r = evaluateGate(out({ limitations: ["Burn the infected plants and drench the beds with the fungicide."] }), ctx(), facts());
    expect(r.approvedLimitations).toEqual([]);
    expect(r.report.removed).toEqual([{ field: "limitation", id: null, index: 0, codes: ["chemical_dosage"] }]);
  });
  it.each([
    "The yellowing may indicate a nutrient deficiency; a local officer can confirm.",
    "Rot may be spreading; please ask an agricultural officer to inspect the beds.",
    "Please consult a local agricultural officer before applying any fungicide.",
    "Prices can rise or fall before harvest.",
    "Ginger is planted before the monsoon.",
  ])("hedged/referral control passes: %s", (text) => {
    expect(one(text).status).toBe("approved");
  });
});

describe("R4 #5: clarification options", () => {
  it.each([
    ["irrigation", "Yes, burn them"],
    ["irrigation", "No, uproot plants"],
    ["irrigation", "Yes, harvest now"],
    ["irrigation", "हाँ जला दो"],
    ["irrigation", "Yes flood daily"],
    ["district", "Uproot all"],
    ["district", "Spray today"],
    ["state", "Burn the field"],
    ["district", "Wayanad"],
  ])("%s option %s is refused", (field, opt) => {
    expect(clarificationOptionProblem(field, opt)).not.toBeNull();
  });
  it.each([
    ["irrigation", "Yes"], ["irrigation", "no."], ["irrigation", "Not sure"], ["irrigation", "हाँ"], ["irrigation", "पता नहीं"], ["irrigation", "இல்லை"], ["irrigation", "drip"],
    ["district", "Hassan"], ["district", "hassan"], ["district", "Dakshina Kannada"], ["state", "Karnataka"], ["state", "कर्नाटक"],
  ])("%s option %s is accepted", (field, opt) => {
    expect(clarificationOptionProblem(field, opt)).toBeNull();
  });
  it("registry lookup is level-specific", () => {
    expect(isRegistryPlace("Karnataka", "district")).toBe(false);
    expect(isRegistryPlace("Hassan", "district")).toBe(true);
  });
});

describe("R4 #6: kg/ha from a mapped yield field is a yield, not a dose", () => {
  const Y = ref("n1", "/result/scenarios/0/perHa/marketableKgTotal", "kg/ha", "kg/ha", "t2");
  it("p2-2 / p2-3 pass", () => {
    expect(one("Marketable yield in this scenario is 8000 kg/ha.", [Y]).status).toBe("approved");
    expect(one("Marketable yield in this scenario is 8000 kg per hectare.", [Y]).status).toBe("approved");
  });
  it("the same ref in an application sentence is still a dose", () => {
    for (const t of ["Apply 8000 kg/ha urea.", "Marketable yield is 8000 kg/ha, so apply fertiliser accordingly."]) expect(codes(one(t, [Y]))).toContain("chemical_dosage");
  });
});

describe("R4 #7: unit records only at allowlisted locations", () => {
  it("a planted {value, unit} record outside the allowlist is refused", () => {
    expect(unitAtPointer("calculate_scenarios", scen.result, "/echo/value")).toBeNull();
    expect(unitAtPointer("calculate_scenarios", scen.result, "/references/0/value")).toBeNull();
    expect(unitAtPointer("interpret_observation", obs.result, "/proposals/0/proposed/value")).toBeNull();
    expect(unitAtPointer("get_market_outlook", refs.result, "/references/0/value")).toEqual({ unit: "acre", basis: "unit_record" });
    expect(unitAtPointer("get_farm_context", { farm: { area: { value: { amount: 0.81, unit: "ha" } } } }, "/farm/area/value/amount")).toEqual({ unit: "ha", basis: "unit_record" });
    expect(codes(one("Harvest 5 kg.", [ref("n1", "/echo/value", "kg", "kg", "t2")]))).toContain("numeric_ref_unit_unknown");
    expect(codes(one("Your farm is 2 acres.", [ref("n1", "/proposals/0/proposed/value", "acre", "acre", "t3")]))).toContain("numeric_ref_unit_unknown");
  });
});
