import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@harvest/contracts";
import { evaluateGate, type EvidenceFact, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { numberTokens, unsupportedNumberWord } from "../src/agent/numbers";
import { detectSeasonalRain } from "../src/agent/risk";
import { riskSentence } from "../src/agent/templates";
import { GINGER_ID } from "./fixtures/meta/helpers";

/** F16: closes the R6 output-gate findings (has/have outlooks, present-perfect weather claims, outlook nouns, homoglyphs). */
const OWNER = "o";
const RUN = "r";
const ctx = (o: Partial<GateContext> = {}): GateContext => ({ ownerId: OWNER, mode: "synthetic", agentRunId: RUN, asOf: "2026-10-30T06:00:00Z", language: "en", claimScope: { geographyIds: [], districtIds: ["IN-KA-hassan"], stateIds: ["IN-KA"], regionIds: [], cropIds: [GINGER_ID] }, userText: "", rainHorizonDays: 7, ...o });
const tr = (id: string, result: unknown, toolName: string): StoredToolResult => ({ id, ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName, status: "ok", result });
const scen = tr("t1", { result: { scenarios: [{ perHa: { marketableKgTotal: "20" }, total: { netCashReturnInr: "20000", marketableKgTotal: "20" } }] } }, "calculate_scenarios");
const water = tr("t2", { result: { runs: [{ effectiveRainFromForecastMm: 12 }] } }, "calculate_water_balance");
const ev = (id: string): EvidenceFact => ({ id, mode: "synthetic", validationStatus: "validated", geographyLevel: "district", geographyIds: ["IN-KA-hassan"], cropIds: [GINGER_ID], effectiveAvailableAt: "2026-01-01T00:00:00.000Z", availabilityBasis: "verified_publication" });
const facts = (): GateFacts => ({ toolResults: new Map([["t1", scen], ["t2", water]]), evidence: new Map([["e1", ev("e1")]]), knownCropIds: new Set([GINGER_ID]), productForms: new Map(), cropNames: new Map([[GINGER_ID, ["Ginger", "अदरक", "இஞ்சி"]]]) });
const ref = (id: string, p: string, unit: string, tid = "t1") => ({ id, toolResultId: tid, jsonPointer: p, presentation: { unit, sourceUnit: unit, rounding: { mode: "decimals", digits: 0 }, intervalLabel: "none" } });
const KGHA20 = ref("n1", "/result/scenarios/0/perHa/marketableKgTotal", "kg/ha");
const RAIN12 = ref("n1", "/result/runs/0/effectiveRainFromForecastMm", "mm", "t2");
const out = (o: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], limitations: [], ...o });
const blk = (text: string, r: string[] = [], claims: string[] = []) => ({ id: "b1", kind: r.length ? "numeric" : claims.length ? "evidence" : "text", text, numericRefIds: r, claimIds: claims });
const one = (text: string, r: ReturnType<typeof ref>[] = [], lang = "en") => evaluateGate(out({ language: lang, answerBlocks: [blk(text, r.map((x) => x.id))], numericRefs: r }), ctx({ language: lang }), facts());
const claim = (text: string) => evaluateGate(out({ answerBlocks: [blk(text, [], ["c1"])], claimEvidenceRefs: [{ claimId: "c1", text, evidenceIds: ["e1"] }] }), ctx(), facts());
const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);

describe("R6 F-1: forecast vocabulary overrides has/have", () => {
  it.each(["The monsoon has been forecast to fail this year.", "We have a weak monsoon coming this year.", "This year's monsoon outlook has a weak signal, so expect less rain."])("%s is withheld", (text) => {
    expect(detectSeasonalRain(text)?.code).toBe("future_rain_unsourced");
    const r = one(text);
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("future_rain_unsourced");
  });
  it.each(["Last year the monsoon arrived late.", "The monsoon has arrived late in past years.", "Last year the monsoon arrived late in Hassan."])("control: %s is approved", (text) => {
    expect(detectSeasonalRain(text)).toBeNull();
    expect(one(text).status).toBe("approved");
  });
});

describe("R6 F-2: present-perfect current-season weather claims need a weather ref or verified claim", () => {
  it("English present perfect with this year is weather_claim_unsourced", () => {
    expect(detectSeasonalRain("The monsoon has arrived early this year.")?.code).toBe("weather_claim_unsourced");
    const r = one("The monsoon has arrived early this year.");
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("weather_claim_unsourced");
  });
  it("Hindi मानसून जल्दी आ गया है requires a reference (weather_claim_unsourced, not a number issue)", () => {
    expect(detectSeasonalRain("मानसून जल्दी आ गया है।")?.code).toBe("weather_claim_unsourced");
    const r = one("मानसून जल्दी आ गया है।", [], "hi");
    expect(codes(r)).toContain("weather_claim_unsourced");
    expect(codes(r)).not.toContain("prose_number_without_ref");
    expect(codes(r)).not.toContain("unsupported_number");
  });
  it("Tamil present perfect is handled the same way", () => {
    expect(detectSeasonalRain("இந்த ஆண்டு பருவமழை முன்கூட்டியே வந்துவிட்டது.")?.code).toBe("weather_claim_unsourced");
  });
  it.each(["The monsoon's arrived early this year.", "Heavy rain has fallen this week.", "Rainfall has been above normal so far."])("%s (contraction or current-period marker) is weather_claim_unsourced", (text) => {
    expect(detectSeasonalRain(text)?.code).toBe("weather_claim_unsourced");
  });
  it("a weather-tool reference or a verified evidence claim lets it through", () => {
    expect(one("The monsoon has arrived early this year, with 12 mm so far.", [RAIN12]).status).toBe("approved");
    expect(claim("The monsoon has arrived early this year.").status).toBe("approved");
  });
  it.each(["The monsoon usually arrives in June.", "Ginger is usually planted before the monsoon.", "The monsoon may have arrived late last year."])("control: %s is approved", (text) => {
    expect(detectSeasonalRain(text)).toBeNull();
    expect(one(text).status).toBe("approved");
  });
  it("the template exists in en/hi/ta and does not itself trip the seasonal detector", () => {
    expect(riskSentence("en", "weather_claim_unsourced")).toBe("Current-season rainfall is shown in the weather panel from dated records; this sentence could not be verified.");
    for (const l of ["en", "hi", "ta"] as const) {
      expect(riskSentence(l, "weather_claim_unsourced").length).toBeGreaterThan(20);
      expect(detectSeasonalRain(riskSentence(l, "weather_claim_unsourced")), l).toBeNull();
    }
  });
});

describe("R6 F-3: outlooks without a rain or monsoon word", () => {
  it.each([
    ["A wet year lies ahead for ginger growers.", "en"],
    ["A drought is ahead this season, so save water.", "en"],
    ["Deficient rainfall is expected this season.", "en"],
    ["Below-normal rainfall lies ahead this year.", "en"],
    ["A dry year lies ahead.", "en"],
    ["इस साल सूखा पड़ेगा।", "hi"],
    ["इस साल अकाल की संभावना है।", "hi"],
    ["இந்த ஆண்டு வறட்சி இருக்கும்.", "ta"],
    ["இந்த ஆண்டு குறைவான மழை இருக்கும்.", "ta"],
  ])("%s is an unsourced outlook", (text) => {
    expect(detectSeasonalRain(text)?.code).toBe("future_rain_unsourced");
  });
  it.each(["Plan ahead for the monsoon by clearing drains.", "Drought-tolerant varieties exist for ginger.", "सूखा अदरक का भाव अच्छा है।", "During a dry spell, water the beds in the evening."])("control: %s is not an outlook", (text) => {
    expect(detectSeasonalRain(text)).toBeNull();
  });
});

describe("R6 F-4: letter homoglyphs, lowercase Roman numerals and short words standing for numbers", () => {
  it.each(["Ginger sells at Rs BOO per quintal.", "Harvest about B kg from the bed.", "Harvest about S kg or G kg.", "Expect xx kg from the plot.", "Use iv kg of compost per bed.", "Ginger sells at Rs S00 per quintal.", "Harvest about Z0 kg from the bed.", "Expect xxv kg from the plot."])("%s is unsupported_number", (text) => {
    expect(unsupportedNumberWord(text)).not.toBeNull();
    expect(codes(one(text))).toContain("unsupported_number");
  });
  it("control: 'a kg of seed per bed' is read by the quantity-word rule (1 kg), not as an unsupported word", () => {
    expect(unsupportedNumberWord("Use a kg of seed per bed.")).toBeNull();
    expect(numberTokens("Use a kg of seed per bed.", { englishDates: false }).tokens.map((t) => t.value.toNumber())).toEqual([1]);
  });
  it.each(["Check the kg figure on the bag.", "Prices are quoted per kg in the market.", "Convert the yield to kg before comparing.", "Bees visit the flowers.", "I think the beds need weeding."])("control: %s is approved", (text) => {
    expect(unsupportedNumberWord(text)).toBeNull();
    expect(one(text).status).toBe("approved");
  });
});

it("control: a Roman-looking unit after digits ('200 L tank') is a unit, not a numeral", () => {
  expect(unsupportedNumberWord("Use a 200 L tank for mixing water.")).toBeNull();
  expect(codes(one("Use a 200 L tank for mixing water."))).not.toContain("unsupported_number");
});

describe("R6 over-blocking: Tamil ஒரு + dative area unit", () => {
  it("ஒரு ஹெக்டேருக்கு இருபது கிலோ மகசூல் with a matching kg/ha ref is approved", () => {
    expect(one("ஒரு ஹெக்டேருக்கு இருபது கிலோ மகசூல் கிடைக்கும்.", [KGHA20], "ta").status).toBe("approved");
  });
  it("ஒரு ஏக்கருக்கு is not counted as the number 1", () => {
    expect(numberTokens("ஒரு ஏக்கருக்கு உரம்", { englishDates: false }).tokens).toHaveLength(0);
    expect(numberTokens("ஒரு கிலோ", { englishDates: false }).tokens.map((t) => t.value.toNumber())).toEqual([1]);
  });
  it("the fail-closed native risk rule is unchanged (documented usefulness cost)", () => {
    expect(codes(one("பாத்திகளில் இலைகளால் மூடாக்கு இடவும்.", [], "ta"))).toContain("native_risk_term_unsupported");
  });
});
