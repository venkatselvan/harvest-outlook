import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@harvest/contracts";
import { Decimal } from "@harvest/domain";
import { evaluateGate, type EvidenceFact, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { numberTokens, proseNumbers, wordsToDigits } from "../src/agent/numbers";
import { detectHighRisk, type RiskCode } from "../src/agent/risk";
import { fieldLabel, numberSentence, riskSentence, templateBlock, type TemplateLanguage } from "../src/agent/templates";
import { GINGER_ID } from "./fixtures/meta/helpers";

/** F5: the output gate fails closed in every language and on every model-written text field. */

const OWNER = "o";
const RUN = "r";
const OTHER_CROP = "00000000-0000-4000-8000-0000000000c2";
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  ownerId: OWNER,
  mode: "synthetic",
  agentRunId: RUN,
  asOf: "2026-10-30T06:00:00Z",
  language: "en",
  claimScope: { geographyIds: [], districtIds: ["IN-KA-HAS"], stateIds: ["KA", "IN-KA"], regionIds: [], cropIds: [GINGER_ID] },
  userText: "I have 2 acres in Hassan",
  rainHorizonDays: 7,
  ...over,
});
const tr: StoredToolResult = { id: "t1", ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName: "calculate_scenarios", status: "ok", result: { areaAcre: 2, areaHa: 0.81, rain: 40, netInr: "200000", price: "2050", yieldQ: 25 } };
const wx: StoredToolResult = { ...tr, id: "t2", toolName: "get_weather_forecast", result: { rainMm: 12.4 } };
const ev = (id: string, over: Partial<EvidenceFact> = {}): EvidenceFact => ({ id, mode: "synthetic", validationStatus: "validated", geographyLevel: "district", geographyIds: ["IN-KA-HAS"], cropIds: [GINGER_ID], effectiveAvailableAt: "2026-01-01T00:00:00.000Z", availabilityBasis: "verified_publication", ...over });
const facts = (e: EvidenceFact[] = [], knownCropIds: string[] = [GINGER_ID]): GateFacts => ({ toolResults: new Map([["t1", tr], ["t2", wx]]), evidence: new Map(e.map((x) => [x.id, x])), knownCropIds: new Set(knownCropIds) });
const ref = (id: string, p: string, unit: string, sourceUnit = unit, digits = 0, toolResultId = "t1") => ({ id, toolResultId, jsonPointer: p, presentation: { unit, sourceUnit, rounding: { mode: "decimals", digits }, intervalLabel: "none" } });
const out = (o: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], limitations: [], ...o });
const blk = (text: string, refs: string[] = [], claims: string[] = [], id = "b1") => ({ id, kind: refs.length ? "numeric" : claims.length ? "evidence" : "text", text, numericRefIds: refs, claimIds: claims });
const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);
const one = (text: string, refs: ReturnType<typeof ref>[] = [], lang = "en", c: Partial<GateContext> = {}) =>
  evaluateGate(out({ language: lang, answerBlocks: [blk(text, refs.map((r) => r.id))], numericRefs: refs }), ctx({ language: lang, ...c }), facts());

describe("F5: every reviewer reproduction is now withheld", () => {
  const rain40 = [ref("n1", "/rain", "mm")];
  const acre2 = [ref("n1", "/areaAcre", "acre")];
  const cases: [string, string, ReturnType<typeof ref>[], string, string][] = [
    // [finding, text, refs, language, expected code]
    ["F3 year-range total", "Your 2 acre field may give a total harvest of 2000 kg.", [], "en", "prose_number_without_ref"],
    ["F3 year-range price", "The modal price could be ₹2050 per quintal.", [], "en", "prose_number_without_ref"],
    ["F3 glued currency", "Seed costs Rs500 per bag.", [], "en", "prose_number_without_ref"],
    ["F3 number words", "You may harvest twenty five quintals.", [], "en", "prose_number_without_ref"],
    ["F3 lakh with an acre ref", "Net income is ₹2 lakh.", acre2, "en", "numeric_display_mismatch"],
    ["F3 lakh with an acre ref (number)", "Net income is ₹2 lakh.", acre2, "en", "prose_number_without_ref"],
    ["F3 unit check in Hindi", "क्षेत्रफल 2 है।", acre2, "hi", "unit_missing_in_prose"],
    ["F3 unit check in Tamil", "பரப்பு 2 ஆகும்.", acre2, "ta", "unit_missing_in_prose"],
    ["F2 ta rain next month", "அடுத்த மாதம் 40 மிமீ மழை பெய்யும்.", rain40, "ta", "future_daily_rain_beyond_horizon"],
    ["F2 hi rain next month", "अगले महीने 40 मिमी बारिश होगी।", rain40, "hi", "future_daily_rain_beyond_horizon"],
    ["F4 en rain next month", "Next month it will rain 40 mm.", rain40, "en", "future_daily_rain_beyond_horizon"],
    ["F4 rain in three weeks", "Expect heavy rain of 40 mm in three weeks.", rain40, "en", "future_daily_rain_beyond_horizon"],
    ["F4 double income", "Ginger will double your income this season.", [], "en", "guaranteed_profit"],
    ["F4 hedge via action verb", "Your ginger has soft rot; check the field.", [], "en", "diagnosis_certainty"],
    ["probe 'is caused by'", "The yellowing on your ginger is caused by bacterial wilt.", [], "en", "diagnosis_certainty"],
    ["probe dosage in words", "Spray two millilitres of mancozeb per litre of water.", [], "en", "chemical_dosage"],
    ["F4 spoons via farmer number", "Mix 2 spoons of copper oxychloride in a tank and spray.", [], "en", "chemical_dosage"],
    ["F4 spoons via farmer number (number)", "Mix 2 spoons of copper oxychloride in a tank and spray.", [], "en", "prose_number_without_ref"],
    ["F2 hi dosage ml per litre", "2 मिलीलीटर प्रति लीटर पानी में मिलाकर छिड़काव करें।", [], "hi", "chemical_dosage"],
    ["F2 hi urea kg per acre", "50 किलोग्राम प्रति एकड़ यूरिया डालें।", [], "hi", "chemical_dosage"],
    ["F2 ta dosage", "லிட்டருக்கு 2 மில்லி மருந்து கலந்து தெளிக்கவும்.", [], "ta", "chemical_dosage"],
    ["F2 hi certain diagnosis", "आपकी फसल में निश्चित रूप से ब्लाइट है।", [], "hi", "diagnosis_certainty"],
    ["F2 ta certain diagnosis", "உங்கள் பயிரில் நிச்சயமாக அழுகல் நோய் உள்ளது.", [], "ta", "diagnosis_certainty"],
    ["F2 hi asserted diagnosis", "आपकी अदरक में सड़न रोग है।", [], "hi", "diagnosis_certainty"],
    ["F2 hi profit guarantee", "अदरक से मुनाफा पक्का है।", [], "hi", "guaranteed_profit"],
    ["F2 hi guarantee word", "इस फसल में लाभ की गारंटी है।", [], "hi", "guaranteed_profit"],
    ["F2 ta profit guarantee", "இஞ்சியில் நிச்சய லாபம் கிடைக்கும்.", [], "ta", "guaranteed_profit"],
    ["F4 hi double income", "अदरक से आय दोगुनी होगी।", [], "hi", "guaranteed_profit"],
    ["F4 ta double income", "இஞ்சி உங்கள் வருமானத்தை இரட்டிப்பு ஆக்கும்.", [], "ta", "guaranteed_profit"],
    ["F2 hi unreferenced digit", "बुवाई 15 दिन में करें।", [], "hi", "prose_number_without_ref"],
    ["F2 hi Devanagari digit", "बुवाई १५ दिन में करें।", [], "hi", "prose_number_without_ref"],
    ["F2 ta Tamil digit", "விதைப்பு ௧௫ நாட்களில்.", [], "ta", "prose_number_without_ref"],
    ["F2 hi number word", "पच्चीस क्विंटल उपज संभव है।", [], "hi", "prose_number_without_ref"],
    ["F2 ta number word", "இருபத்தைந்து குவிண்டால் விளைச்சல் கிடைக்கலாம்.", [], "ta", "prose_number_without_ref"],
    ["F2 hi lakh word", "दो लाख रुपये की कमाई संभव है।", [], "hi", "prose_number_without_ref"],
    ["F2 hi lexicon without ref", "बारिश के बाद खेत देखें।", [], "hi", "native_risk_term_unsupported"],
    ["F2 ta lexicon without ref", "நாளை வயலைப் பாருங்கள்.", [], "ta", "native_risk_term_unsupported"],
    ["F2 hi farmer number not exempt", "आपके 2 एकड़ खेत के लिए योजना तैयार है।", [], "hi", "prose_number_without_ref"],
    ["fail closed: unsupported script", "ಶುಂಠಿ ಬೆಳೆ ಚೆನ್ನಾಗಿದೆ.", [], "en", "unsupported_script"],
  ];
  it.each(cases)("%s", (_name, text, refs, lang, code) => {
    const r = one(text, refs, lang, lang === "hi" ? { userText: "मेरे पास 2 एकड़ है" } : {});
    expect(r.status).not.toBe("approved");
    expect(r.approvedBlocks).toEqual([]);
    expect(codes(r)).toContain(code);
  });
});

describe("F5: positive controls pass", () => {
  it.each([
    ["en lakh multiplier with INR ref", "Your 2 acres could earn about ₹2 lakh net.", [ref("n1", "/netInr", "INR")], "en"],
    ["en rupees spelled after a number", "Net income could be 2 lakh rupees.", [ref("n1", "/netInr", "INR")], "en"],
    ["en price per quintal", "The modal price is ₹2,050 per quintal.", [ref("n1", "/price", "INR/quintal")], "en"],
    ["en number words that match a ref", "You may harvest twenty five quintals.", [ref("n1", "/yieldQ", "quintal")], "en"],
    ["en year adjacent to a month (no ref)", "Planting on 15 April 2027 works, or sow in June 2027.", [], "en"],
    ["en conversion ha to acre", "Your field is 0.81 ha.", [ref("n1", "/areaHa", "ha", "ha", 2)], "en"],
    ["en hedged diagnosis", "The spots may be a sign of leaf spot; please ask an officer to check the field.", [], "en"],
    ["en guarantee disclaimer", "No crop can guarantee profit; prices change.", [], "en"],
    ["hi referenced area with conversion", "आपके खेत का क्षेत्रफल 0.81 हेक्टेयर है, यानी लगभग 2 एकड़।", [ref("n1", "/areaHa", "ha", "ha", 2), ref("n2", "/areaHa", "acre", "ha", 0)], "hi"],
    ["hi lakh multiplier with INR ref", "आपका शुद्ध लाभ लगभग ₹2 लाख हो सकता है।", [ref("n1", "/netInr", "INR")], "hi"],
    ["hi rain within a referenced number", "पूर्वानुमान में 12 मिमी बारिश है।", [ref("n1", "/rainMm", "mm", "mm", 0, "t2")], "hi"],
    ["ta referenced acres", "உங்கள் நிலம் 2 ஏக்கர்.", [ref("n1", "/areaAcre", "acre")], "ta"],
    ["ta lakh multiplier with INR ref", "நிகர வருமானம் சுமார் ₹2 லட்சம் ஆகலாம்.", [ref("n1", "/netInr", "INR")], "ta"],
    ["ta price per quintal", "குவிண்டாலுக்கு ₹2050 விலை.", [ref("n1", "/price", "INR/quintal")], "ta"],
  ] as [string, string, ReturnType<typeof ref>[], string][])("%s", (_n, text, refs, lang) => {
    const r = one(text, refs, lang);
    expect(r.issues).toEqual([]);
    expect(r.status).toBe("approved");
  });

  it("normalises numbers across scripts, words and multipliers", () => {
    expect(proseNumbers("twenty five quintals and one hundred and five kg").map(String)).toEqual(["25", "105"]);
    expect(proseNumbers("₹2.5 lakh, ₹1 crore, a lakh rupees, Rs500").map(String)).toEqual(["250000", "10000000", "100000", "500"]);
    expect(proseNumbers("२ लाख, ௨ லட்சம், दो हज़ार").map(String)).toEqual(["200000", "200000", "2000"]);
    expect(proseNumbers("Only one option; one acre").map(String)).toEqual(["1"]);
    expect(proseNumbers("2000 kg on 3 March 2026").map(String)).toEqual(["2000"]);
    expect(wordsToDigits("पानी दो")).toBe("पानी दो"); // "give", not 2
    expect(numberTokens("இருக்கலாம்", { englishDates: false }).tokens).toEqual([]);
  });
});

describe("F1: claim text, limitations and clarifications are gated", () => {
  const E = "11111111-1111-4111-8111-111111111111";
  it("the reviewer's claim probe: unsafe claim, limitation and clarification are removed and recorded", () => {
    const r = evaluateGate(
      out({
        clarifications: [{ id: "q1", question: "Should you spray 3 ml/L chlorpyrifos to guarantee profit?", field: null, options: [] }],
        answerBlocks: [blk("See the cited guidance.", [], ["c1"])],
        claimEvidenceRefs: [{ claimId: "c1", text: "Spray 3 ml per litre of chlorpyrifos; your crop definitely has blight; guaranteed profit of Rs 4 lakh.", evidenceIds: [E] }],
        limitations: ["It will rain 80 mm on 20 December."],
      }),
      ctx(),
      facts([ev(E, { geographyLevel: "state", geographyIds: ["KA"] })]),
    );
    expect(r.status).toBe("correction_requested");
    expect(r.approvedBlocks).toEqual([]);
    expect(r.approvedClaimEvidenceRefs).toEqual([]);
    expect(r.approvedLimitations).toEqual([]);
    expect(r.approvedClarifications).toEqual([]);
    const removed = Object.fromEntries(r.report.removed.map((x) => [x.field, x.codes]));
    expect(removed.claimEvidenceRef).toEqual(expect.arrayContaining(["chemical_dosage", "diagnosis_certainty", "guaranteed_profit", "prose_number_without_ref"]));
    expect(removed.limitation).toEqual(expect.arrayContaining(["future_daily_rain_beyond_horizon", "prose_number_without_ref"]));
    expect(removed.clarification).toEqual(expect.arrayContaining(["clarification_field_unknown", "chemical_dosage"]));
    expect(removed.answerBlock).toContain("claim_not_verified");
  });

  it("a clean claim, limitation and clarification pass; a single bad option is removed alone", () => {
    const r = evaluateGate(
      out({
        clarifications: [{ id: "q1", question: "Is your water from a borewell or a canal?", field: "irrigation", options: ["borewell", "canal", "buy 3 tankers"] }],
        answerBlocks: [blk("Keep the soil evenly moist.", [], ["c1"])],
        claimEvidenceRefs: [{ claimId: "c1", text: "Keep soil evenly moist during rhizome development.", evidenceIds: [E] }],
        limitations: ["Soil test results are not known yet.", "Prices for 2026 are unknown"],
      }),
      ctx(),
      facts([ev(E)]),
    );
    expect(r.approvedBlocks).toHaveLength(1);
    expect(r.approvedClaimEvidenceRefs).toHaveLength(1);
    expect(r.approvedLimitations).toEqual(["Soil test results are not known yet."]);
    expect(r.approvedClarifications).toEqual([{ id: "q1", question: "Is your water from a borewell or a canal?", field: "irrigation", options: ["borewell", "canal"] }]);
    expect(r.report.removed.map((x) => x.field).sort()).toEqual(["clarificationOption", "limitation"]);
    expect(r.status).toBe("partial");
  });

  it("clarifications must name a known profile field", () => {
    const mk = (field: string | null) => evaluateGate(out({ answerBlocks: [blk("Please confirm.")], clarifications: [{ id: "q1", question: "Which water source do you use?", field, options: [] }] }), ctx(), facts());
    expect(mk("irrigation").approvedClarifications).toHaveLength(1);
    expect(mk(null).approvedClarifications).toEqual([]);
    expect(codes(mk("favourite_colour"))).toContain("clarification_field_unknown");
  });

  it("claim numbers must match a numericRef of a block citing the claim", () => {
    const run = (claimText: string) =>
      evaluateGate(
        out({ answerBlocks: [{ id: "b1", kind: "numeric", text: "Your field is 0.81 ha.", numericRefIds: ["n1"], claimIds: ["c1"] }], numericRefs: [ref("n1", "/areaHa", "ha", "ha", 2)], claimEvidenceRefs: [{ claimId: "c1", text: claimText, evidenceIds: [E] }] }),
        ctx(),
        facts([ev(E)]),
      );
    expect(run("Fields of 0.81 ha suit ginger.").status).toBe("approved");
    expect(codes(run("Fields of 3 ha suit ginger."))).toContain("prose_number_without_ref");
  });
});

describe("F5: claim crop scope and granularity", () => {
  const E = "22222222-2222-4222-8222-222222222222";
  const mk = (claim: Record<string, unknown>, c: Partial<GateContext> = {}, e = ev(E), known = [GINGER_ID], text = "Keep the soil evenly moist.") =>
    evaluateGate(out({ answerBlocks: [blk(text, [], ["c1"])], claimEvidenceRefs: [{ claimId: "c1", text: "moist soil", evidenceIds: [E], ...claim }] }), ctx(c), facts([e], known));
  const noPlan = { claimScope: { geographyIds: [], districtIds: ["IN-KA-HAS"], stateIds: ["KA"], regionIds: [], cropIds: [] } };

  it("with a plan crop in scope, evidence must cover it and declared crops must stay inside it", () => {
    expect(mk({}).status).toBe("approved");
    expect(codes(mk({}, {}, ev(E, { cropIds: [OTHER_CROP] })))).toContain("evidence_scope_crop");
    expect(codes(mk({ cropIds: [OTHER_CROP] }))).toContain("claim_crop_outside_scope");
  });

  it("without a plan crop the claim must declare catalogue crops; the crop check is never skipped", () => {
    expect(codes(mk({}, noPlan))).toContain("claim_crop_scope_missing");
    expect(mk({ cropIds: [GINGER_ID] }, noPlan).status).toBe("approved");
    expect(codes(mk({ cropIds: [OTHER_CROP] }, noPlan, ev(E, { cropIds: [OTHER_CROP] }), [GINGER_ID]))).toContain("claim_crop_unknown");
    expect(codes(mk({ cropIds: [GINGER_ID] }, noPlan, ev(E, { cropIds: [OTHER_CROP] })))).toContain("evidence_scope_crop");
  });

  it("granularity defaults to district with a farm; state evidence needs a declared, labelled state claim (en/hi/ta labels)", () => {
    const state = ev(E, { geographyLevel: "state", geographyIds: ["KA"] });
    expect(codes(mk({}, {}, state))).toContain("evidence_scope_granularity");
    expect(codes(mk({ granularity: "state" }, {}, state))).toContain("claim_granularity_unlabelled");
    expect(mk({ granularity: "state" }, {}, state, [GINGER_ID], "At state level, keep the soil evenly moist.").status).toBe("approved");
    expect(mk({ granularity: "state" }, { language: "hi" }, state, [GINGER_ID], "राज्य स्तर पर मिट्टी को नम रखें।").status).toBe("approved");
    expect(mk({ granularity: "state" }, { language: "ta" }, state, [GINGER_ID], "மாநில அளவில் மண்ணை ஈரமாக வைக்கவும்.").status).toBe("approved");
    // district evidence for another district never covers, whatever the declared granularity
    expect(codes(mk({ granularity: "state" }, {}, ev(E, { geographyIds: ["IN-KA-MND"] }), [GINGER_ID], "At state level, keep it moist."))).toContain("evidence_scope_geography");
  });

  it("an invalid declared granularity is a schema error", () => {
    expect(codes(mk({ granularity: "planet" }))).toContain("schema_invalid");
  });

  it("machine-grounded evidence (D28) is accepted and reported for labelling; pending is not", () => {
    const g = mk({}, {}, ev(E, { validationStatus: "grounded" }));
    expect(g.status).toBe("approved");
    expect(g.report.groundedEvidenceIds).toEqual([E]);
    expect(codes(mk({}, {}, ev(E, { validationStatus: "pending" })))).toContain("evidence_not_validated");
  });
});

describe("F2: server-authored templates", () => {
  const langs: TemplateLanguage[] = ["en", "hi", "ta"];
  const risks: RiskCode[] = ["chemical_dosage", "diagnosis_certainty", "guaranteed_profit", "future_daily_rain_beyond_horizon", "yield_from_canopy", "confidence_percentage_unbacked"];

  it("every safety template passes the gate in its own language without references", () => {
    for (const lang of langs)
      for (const code of risks) {
        const r = one(riskSentence(lang, code), [], lang);
        expect(r.issues, `${lang} ${code}`).toEqual([]);
        expect(detectHighRisk(riskSentence(lang, code), { asOf: new Date(), rainHorizonDays: 7, allowConfidencePercent: false })).toEqual([]);
      }
  });

  it("numeric templates are built only from verified refs and pass the gate in en/hi/ta for every templated unit", () => {
    const units: [string, string, number][] = [["ha", "/areaHa", 2], ["acre", "/areaAcre", 0], ["INR", "/netInr", 0], ["INR/quintal", "/price", 0], ["quintal", "/yieldQ", 0], ["mm", "/rain", 0]];
    for (const lang of langs)
      for (const [unit, p, digits] of units) {
        const r0 = ref("n1", p, unit, unit, digits);
        const w = { riskCodes: [], validRefIds: ["n1"], forecastRefIds: unit === "mm" ? ["n1"] : [] };
        const value = (evaluateGate(out({ answerBlocks: [blk("x")], numericRefs: [r0] }), ctx(), facts()).presented!.get("n1"))!;
        const t = templateBlock(lang, blk("bad") as never, w, new Map([["n1", r0 as never]]), () => value)!;
        expect(t.block.numericRefIds).toEqual(["n1"]);
        const g = evaluateGate(out({ language: lang, answerBlocks: [t.block], numericRefs: [r0] }), ctx({ language: lang }), facts());
        expect(g.issues, `${lang} ${unit}: ${t.block.text}`).toEqual([]);
        if (unit === "mm") expect(t.block.text).toMatch(/forecast|पूर्वानुमान|முன்னறிவிப்பு/);
      }
  });

  it("a block with a risk finding gets a safety sentence and never its numbers back", () => {
    const t = templateBlock("hi", blk("2 मिलीलीटर दवा प्रति लीटर") as never, { riskCodes: ["chemical_dosage"], validRefIds: ["n1"], forecastRefIds: [] }, new Map(), () => new Decimal(2))!;
    expect(t.block).toMatchObject({ kind: "warning", numericRefIds: [] });
    expect(t.block.text).not.toMatch(/\d/);
  });

  it("field labels never carry digits", () => {
    expect(fieldLabel("/scenarios/0/netInr")).toBe("net inr");
    expect(fieldLabel("/p50Yield")).toBe("p yield");
    expect(numberSentence("en", "area", new Decimal("0.81"), "ha")).toBe("The number for area is 0.81 ha.");
    expect(numberSentence("en", "rate", new Decimal(50), "kg/ha")).toBeNull();
  });
});
