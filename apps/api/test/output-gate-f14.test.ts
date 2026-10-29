import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@harvest/contracts";
import { evaluateGate, productFormsIn, type EvidenceFact, type GateContext, type GateFacts, type StoredToolResult } from "../src/agent/gate";
import { latinWordBeforeQuantity, numberTokens, tamilNumberValue, unsupportedNumberWord } from "../src/agent/numbers";
import { detectSeasonalRain } from "../src/agent/risk";
import { riskSentence } from "../src/agent/templates";
import { GINGER_ID } from "./fixtures/meta/helpers";

/** F14: closes the R5 output-gate bypasses (Tamil compounds, Roman numerals, homoglyphs, romanised Hindi, dry product, seasonal rain). */
const OWNER = "o";
const RUN = "r";
const ctx = (o: Partial<GateContext> = {}): GateContext => ({ ownerId: OWNER, mode: "synthetic", agentRunId: RUN, asOf: "2026-10-30T06:00:00Z", language: "en", claimScope: { geographyIds: [], districtIds: ["IN-KA-hassan"], stateIds: ["IN-KA"], regionIds: [], cropIds: [GINGER_ID] }, userText: "", rainHorizonDays: 7, ...o });
const tr = (id: string, result: unknown, toolName: string): StoredToolResult => ({ id, ownerId: OWNER, agentRunId: RUN, runMode: "synthetic", toolName, status: "ok", result });
const scen = tr("t1", { result: { scenarios: [{ total: { netCashReturnInr: "20000", marketableKgTotal: "20" } }] } }, "calculate_scenarios");
const water = tr("t2", { result: { runs: [{ effectiveRainFromForecastMm: 12 }] } }, "calculate_water_balance");
const ev = (id: string): EvidenceFact => ({ id, mode: "synthetic", validationStatus: "validated", geographyLevel: "district", geographyIds: ["IN-KA-hassan"], cropIds: [GINGER_ID], effectiveAvailableAt: "2026-01-01T00:00:00.000Z", availabilityBasis: "verified_publication" });
const facts = (): GateFacts => ({ toolResults: new Map([["t1", scen], ["t2", water]]), evidence: new Map([["e1", ev("e1")]]), knownCropIds: new Set([GINGER_ID]), productForms: new Map([["ginger-dry", "dry"]]), cropNames: new Map([[GINGER_ID, ["Ginger", "अदरक", "இஞ்சி"]]]) });
const ref = (id: string, p: string, unit: string, tid = "t1") => ({ id, toolResultId: tid, jsonPointer: p, presentation: { unit, sourceUnit: unit, rounding: { mode: "decimals", digits: 0 }, intervalLabel: "none" } });
const NET20K = ref("n1", "/result/scenarios/0/total/netCashReturnInr", "INR");
const KG20 = ref("n1", "/result/scenarios/0/total/marketableKgTotal", "kg");
const RAIN12 = ref("n1", "/result/runs/0/effectiveRainFromForecastMm", "mm", "t2");
const out = (o: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], limitations: [], ...o });
const blk = (text: string, r: string[] = [], claims: string[] = []) => ({ id: "b1", kind: r.length ? "numeric" : claims.length ? "evidence" : "text", text, numericRefIds: r, claimIds: claims });
const one = (text: string, r: ReturnType<typeof ref>[] = [], lang = "en") => evaluateGate(out({ language: lang, answerBlocks: [blk(text, r.map((x) => x.id))], numericRefs: r }), ctx({ language: lang }), facts());
const claim = (text: string) => evaluateGate(out({ answerBlocks: [blk(text, [], ["c1"])], claimEvidenceRefs: [{ claimId: "c1", text, evidenceIds: ["e1"] }] }), ctx(), facts());
const codes = (r: ReturnType<typeof evaluateGate>) => r.issues.map((i) => i.code);
const first = (text: string) => numberTokens(text, { englishDates: false }).tokens.map((t) => t.value.toNumber());

// ---------------------------------------------------------------- Tamil composer (test-side, independent of the parser)
const UNITS = ["", "ஒன்று", "இரண்டு", "மூன்று", "நான்கு", "ஐந்து", "ஆறு", "ஏழு", "எட்டு", "ஒன்பது"];
const TEENS = ["பத்து", "பதினொன்று", "பன்னிரண்டு", "பதின்மூன்று", "பதினான்கு", "பதினைந்து", "பதினாறு", "பதினேழு", "பதினெட்டு", "பத்தொன்பது"];
const TENS_FULL = ["", "", "இருபது", "முப்பது", "நாற்பது", "ஐம்பது", "அறுபது", "எழுபது", "எண்பது", "தொண்ணூறு"];
const TENS_STEM = ["", "", "இருபத்", "முப்பத்", "நாற்பத்", "ஐம்பத்", "அறுபத்", "எழுபத்", "எண்பத்", "தொண்ணூற்"];
const HUND_FULL = ["", "நூறு", "இருநூறு", "முந்நூறு", "நானூறு", "ஐந்நூறு", "அறுநூறு", "எழுநூறு", "எண்ணூறு", "தொள்ளாயிரம்"];
const HUND_STEM = ["", "நூற்", "இருநூற்", "முந்நூற்", "நானூற்", "ஐந்நூற்", "அறுநூற்", "எழுநூற்", "எண்ணூற்", "தொள்ளாயிரத்"];
const SIGN: Record<string, string> = { ஆ: "ா", இ: "ி", ஈ: "ீ", உ: "ு", ஊ: "ூ", எ: "ெ", ஏ: "ே", ஐ: "ை", ஒ: "ொ", ஓ: "ோ" };
/** stem (ending consonant+virama) + next numeral, as Tamil writes it: vowel sandhi, else linking -உ (+ gemination of k/c/t/p). */
function join(stem: string, next: string): string {
  const x = stem.slice(-2, -1);
  const v = next[0]!;
  if (v === "அ") return `${stem}${x}${next.slice(1)}`;
  if (SIGN[v]) return `${stem}${x}${SIGN[v]}${next.slice(1)}`;
  const gem = ["க", "ச", "த", "ப"].includes(v) ? `${v}்` : "";
  return `${stem}${x}ு${gem}${next}`;
}
function compose(n: number): string {
  if (n < 10) return UNITS[n]!;
  if (n < 20) return TEENS[n - 10]!;
  if (n < 100) return n % 10 === 0 ? TENS_FULL[n / 10]! : join(TENS_STEM[Math.floor(n / 10)]!, UNITS[n % 10]!);
  const h = Math.floor(n / 100);
  return n % 100 === 0 ? HUND_FULL[h]! : join(HUND_STEM[h]!, compose(n % 100));
}

describe("R5 #1: Tamil compound numerals are read in full", () => {
  it.each([["இருபத்தைந்து", 25], ["ஐம்பத்தைந்து", 55], ["தொண்ணூற்றொன்பது", 99], ["இருநூற்றைம்பது", 250], ["இருபத்தைந்தாயிரம்", 25000], ["முப்பத்திரண்டு", 32], ["இருபத்துமூன்று", 23], ["நூற்றுப்பத்து", 110], ["இரண்டரை", 2.5]] as [string, number][])(
    "%s = %d",
    (w, v) => expect(tamilNumberValue(w)).toBe(v),
  );
  it("property: every composed numeral 11-999 is read as its value or fails closed (never a wrong value)", () => {
    const wrong: string[] = [];
    let read = 0;
    for (let n = 11; n <= 999; n++) {
      const w = compose(n);
      const v = tamilNumberValue(w);
      if (v === n) read++;
      else if (n === 100 && v === null) continue; // bare நூறு is a multiplier word (vague quantity, needs a ref)
      else if (v !== "unsupported") wrong.push(`${n} ${w} -> ${v}`);
      // In a sentence the value (or the fail-closed vague marker) is what the gate sees.
      if (v === n) expect(first(`${w} கிலோ`)).toEqual([n]);
    }
    expect(wrong).toEqual([]);
    expect(read).toBe(988); // 11..999 minus bare நூறு
  });
  it("separate-word compounds and multipliers combine", () => {
    expect(first("இருபத்து நான்கு கிலோ")).toEqual([24]);
    expect(first("இருநூற்று ஐம்பது கிலோ")).toEqual([250]);
    expect(first("இருபத்தைந்து ஆயிரம் ரூபாய்")).toEqual([25000]);
    expect(first("இரண்டு ஆயிரத்து ஐநூறு ரூபாய்")).toEqual([2500]);
  });
  it("letters left after a compound stem fail closed; ordinary words are not numbers", () => {
    expect(tamilNumberValue("இருபத்தைந்தோ")).toBe("unsupported");
    expect(unsupportedNumberWord("இருபத்தைந்தோ கிலோ")).toBe("இருபத்தைந்தோ");
    for (const w of ["ஒன்றியம்", "பத்திரம்", "ஒன்றாக", "ஆறுகள்"]) expect(tamilNumberValue(w)).toBeNull();
  });
  it("₹25,000 in Tamil words is blocked against a verified ₹20,000; the matching amount passes", () => {
    for (const text of ["நிகர வருமானம் இருபத்தைந்தாயிரம் ரூபாய்.", "நிகர வருமானம் இருபத்தைந்து ஆயிரம் ரூபாய்."]) {
      const r = one(text, [NET20K], "ta");
      expect(r.status).toBe("correction_requested");
      expect(codes(r)).toContain("numeric_display_mismatch");
    }
    expect(one("நிகர வருமானம் இருபதாயிரம் ரூபாய்.", [NET20K], "ta").status).toBe("approved");
    expect(one("மகசூல் இருபத்தைந்து கிலோ.", [KG20], "ta").status).toBe("correction_requested");
    expect(one("மகசூல் இருபது கிலோ.", [KG20], "ta").status).toBe("approved");
  });
});

describe("R5 #2: ASCII Roman numerals as quantities", () => {
  it.each(["Expect XX quintals per acre at harvest.", "Keep plants XV cm apart in the bed.", "Net return is Rs XL thousand.", "Use II bags per bed."])("%s is withheld", (text) => {
    const r = one(text);
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("unsupported_number");
  });
  it("controls: the pronoun I, and a unit letter after digits, are not Roman numerals", () => {
    expect(one("I recommend checking the beds after rain.").status).toBe("approved");
    expect(unsupportedNumberWord("Can I ask which variety you planted?")).toBeNull();
    expect(unsupportedNumberWord("Fill a 200 L tank with water.")).toBeNull();
    expect(unsupportedNumberWord("Temperature near 30 °C days")).toBeNull();
  });
});

describe("R5 #3: letter homoglyphs for digits", () => {
  it.each(["Ginger sells at Rs lOOO per quintal.", "Plant rhizomes lO cm deep.", "Harvest l5 kg per bed.", "Sell at ₹ I,OOO per quintal."])("%s is withheld", (text) => {
    const r = one(text);
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("unsupported_number");
  });
  it("controls: 'lo' and 'Oo' as words are not flagged", () => {
    expect(unsupportedNumberWord("Lo, the beds are ready.")).toBeNull();
    expect(unsupportedNumberWord("Say lo to the officer.")).toBeNull();
    expect(one("Oo, the beds look ready.").status).toBe("approved");
  });
});

describe("R5 #4: romanised Hindi number words in a hi turn", () => {
  it.each(["Ikkees kilo beej har bed mein boyen.", "Aapke pachchees bigha khet mein adrak achhi hogi.", "Kai kilo beej lagega.", "Chaubees quintal upaj."])("%s needs a reference", (text) => {
    const r = one(text, [], "hi");
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("prose_number_without_ref");
  });
  it("romanised 11-30 have values before a unit", () => {
    expect(first("pachchees bigha")).toEqual([25]);
    expect(first("ikkees kilo")).toEqual([21]);
    expect(first("tees quintal")).toEqual([30]);
    expect(first("irupathu kilo")).toEqual([20]);
  });
  it("controls: allowlisted words before a unit, and English turns, are not flagged", () => {
    expect(latinWordBeforeQuantity("Beej ki matra per acre dekhen.")).toBeNull();
    expect(latinWordBeforeQuantity("Seed rate for the acre is on the panel.")).toBeNull();
    expect(one("Beej ki matra per acre dekhen.", [], "hi").status).toBe("approved");
    expect(one("Bees visit the flowers.").status).toBe("approved");
  });
});

describe("R5 #4b: dry product-form variants", () => {
  it.each(["सूखे अदरक का भाव बढ़ा है।", "காய்ந்த இஞ்சி விலை உயர்ந்துள்ளது.", "Ginger sold after drying fetches more.", "Sun-dried ginger fetches more.", "உலர்ந்த மஞ்சள் விலை உயர்ந்தது."])("%s is product-specific", (text) => {
    expect(productFormsIn(text)).toContain("dry");
  });
  it("an unscoped dry-product claim is withheld", () => {
    expect(codes(claim("Ginger sold after drying fetches more."))).toContain("claim_product_scope_missing");
  });
  it.each(["A dry spell may reduce ginger yield.", "Drying the field after rain helps ginger.", "Let the beds dry out before planting ginger.", "Ginger needs well-drained soil; keep the soil dry between irrigations."])(
    "control: %s is not a dry-product claim",
    (text) => expect(productFormsIn(text)).not.toContain("dry"),
  );
});

describe("R5 #5: unsourced seasonal rain outlooks", () => {
  it.each(["The monsoon rains will arrive early and heavy this year.", "The monsoon will fail this year, so expect drought.", "The monsoon may fail this year.", "Rains will be heavy this season."])("%s is withheld", (text) => {
    const r = one(text);
    expect(r.status).toBe("correction_requested");
    expect(codes(r)).toContain("future_rain_unsourced");
  });
  it("Hindi and Tamil outlooks are detected", () => {
    expect(detectSeasonalRain("इस साल मानसून जल्दी आएगा।")?.code).toBe("future_rain_unsourced");
    expect(detectSeasonalRain("இந்த ஆண்டு பருவமழை முன்கூட்டியே வரும்.")?.code).toBe("future_rain_unsourced");
  });
  it("controls: forecast-tool reference, past tense, hedged past, conditional and general advice pass", () => {
    expect(one("Forecast rain this week will be 12 mm.", [RAIN12]).status).toBe("approved");
    expect(codes(one("Rain this week will be heavy."))).toContain("future_rain_unsourced");
    for (const text of ["The monsoon may have arrived late last year.", "Last year the monsoon failed in Hassan.", "If the monsoon is late this year, delay planting.", "Heavy rain will cause rhizome rot in waterlogged beds.", "Monsoon onset usually decides the planting date."]) {
      expect(detectSeasonalRain(text), text).toBeNull();
      expect(one(text).status, text).toBe("approved");
    }
  });
  it("the template states that seasonal rain is a forecast, in en/hi/ta", () => {
    expect(riskSentence("en", "future_rain_unsourced")).toMatch(/forecast or scenario, not a measurement/);
    for (const l of ["hi", "ta"] as const) expect(riskSentence(l, "future_rain_unsourced").length).toBeGreaterThan(20);
    const r = evaluateGate(out({ answerBlocks: [blk("The monsoon will fail this year.")] }), ctx(), facts());
    expect(r.issues.find((i) => i.code === "future_rain_unsourced")).toBeDefined();
  });
});

describe("R5 over-blocking reductions", () => {
  it.each([["एक सवाल और पूछना है।", "hi"], ["दिन में एक बार खेत देखें।", "hi"], ["ஒரு கேள்வி கேட்கலாமா?", "ta"], ["ஒரு முறை வயலைப் பார்க்கவும்.", "ta"], ["There are two options for your farm.", "en"], ["There are three ways to prepare the beds.", "en"]])(
    "%s is approved",
    (text, lang) => expect(one(text, [], lang).status).toBe("approved"),
  );
  it("still blocked: a quantity after the idiom word, or 'two options' followed by a unit", () => {
    expect(one("एक किलो बीज डालें।", [], "hi").status).toBe("correction_requested");
    expect(one("Choose two bags of seed.").status).toBe("correction_requested");
    expect(one("There are 2 options for your farm.").status).toBe("correction_requested");
  });
});
