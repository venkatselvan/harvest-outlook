import type { StructuredAssistantOutput, Unit } from "@harvest/contracts";
import type { Decimal } from "@harvest/domain";
import type { RiskCode } from "./risk";

/**
 * SERVER-AUTHORED template sentences (BUILD_SPEC 5.3: "retry or use a template for critical statements
 * when agreement fails"). After the repair budget is exhausted, a withheld answer block is replaced by
 * one of these sentences in the turn language (en/hi/ta). They are written by the application, not
 * by a model; the only variable content is a value/unit taken from a numericRef whose stored value,
 * conversion and rounding the gate verified, and a field label derived from that reference's JSON
 * pointer. Templated output is passed through the gate again before it is returned. Wording was written
 * for this build and has not been reviewed by native-speaker agronomists.
 */

export type TemplateLanguage = "en" | "hi" | "ta";
export const templateLanguage = (lang: string): TemplateLanguage => (/^hi(-|$)/i.test(lang) ? "hi" : /^ta(-|$)/i.test(lang) ? "ta" : "en");

const RISK_TEMPLATES: Record<RiskCode, Record<TemplateLanguage, string>> = {
  chemical_dosage: {
    en: "Please consult a local agricultural officer before applying any chemical.",
    hi: "खेत में कुछ भी डालने से पहले कृपया स्थानीय कृषि अधिकारी से सलाह लें।",
    ta: "வயலில் எதையும் இடுவதற்கு முன் உள்ளூர் வேளாண் அலுவலரை அணுகவும்.",
  },
  diagnosis_certainty: {
    en: "The cause cannot be identified with certainty from here; please ask a local agricultural officer to inspect the crop.",
    hi: "इसका कारण यहाँ से पहचाना नहीं जा सकता; कृपया स्थानीय कृषि अधिकारी से फसल की जाँच करवाएँ।",
    ta: "இதன் காரணத்தை இங்கிருந்து கண்டறிய முடியாது; உள்ளூர் வேளாண் அலுவலரிடம் பயிரைக் காட்டவும்.",
  },
  guaranteed_profit: {
    en: "Income from any crop is uncertain; prices and yields change.",
    hi: "किसी भी फसल की आय पहले से तय नहीं होती; दाम और उपज बदलते रहते हैं।",
    ta: "எந்தப் பயிரின் வருமானமும் முன்கூட்டியே தெரியாது; விலையும் விளைச்சலும் மாறும்.",
  },
  future_daily_rain_beyond_horizon: {
    en: "Exact rain beyond the forecast range is not known; this is a forecast, not a measurement.",
    hi: "पूर्वानुमान सीमा से आगे की सटीक जानकारी उपलब्ध नहीं है; यह पूर्वानुमान है, माप नहीं।",
    ta: "முன்னறிவிப்பு எல்லைக்கு அப்பால் துல்லியமான தகவல் இல்லை; இது முன்னறிவிப்பு, அளவீடு அல்ல.",
  },
  yield_from_canopy: {
    en: "Field yield cannot be estimated from a photo.",
    hi: "फोटो से खेत की उपज का अनुमान नहीं लगाया जा सकता।",
    ta: "புகைப்படத்திலிருந்து வயலின் விளைச்சலை மதிப்பிட முடியாது.",
  },
  confidence_percentage_unbacked: {
    en: "No tested confidence figure is available for this answer.",
    hi: "इस उत्तर के लिए कोई परखा हुआ भरोसे का आँकड़ा उपलब्ध नहीं है।",
    ta: "இந்தப் பதிலுக்குச் சோதிக்கப்பட்ட நம்பகத்தன்மை அளவு இல்லை.",
  },
};

const FORECAST_NOTE: Record<TemplateLanguage, string> = {
  en: "This is a forecast, not a measurement.",
  hi: "यह पूर्वानुमान है, माप नहीं।",
  ta: "இது முன்னறிவிப்பு, அளவீடு அல்ல.",
};

/** Value with unit, worded so the gate's unit-adjacency check recognises it. Rate units are never templated. */
const UNIT_WORDING: Partial<Record<Unit, Record<TemplateLanguage, (v: string) => string>>> = {
  ha: { en: (v) => `${v} ha`, hi: (v) => `${v} हेक्टेयर`, ta: (v) => `${v} ஹெக்டேர்` },
  acre: { en: (v) => `${v} acres`, hi: (v) => `${v} एकड़`, ta: (v) => `${v} ஏக்கர்` },
  kg: { en: (v) => `${v} kg`, hi: (v) => `${v} किलोग्राम`, ta: (v) => `${v} கிலோ` },
  quintal: { en: (v) => `${v} quintals`, hi: (v) => `${v} क्विंटल`, ta: (v) => `${v} குவிண்டால்` },
  t: { en: (v) => `${v} tonnes`, hi: (v) => `${v} टन`, ta: (v) => `${v} டன்` },
  INR: { en: (v) => `₹${v}`, hi: (v) => `₹${v}`, ta: (v) => `₹${v}` },
  "INR/kg": { en: (v) => `₹${v} per kg`, hi: (v) => `₹${v} प्रति किलोग्राम`, ta: (v) => `கிலோவுக்கு ₹${v}` },
  "INR/quintal": { en: (v) => `₹${v} per quintal`, hi: (v) => `₹${v} प्रति क्विंटल`, ta: (v) => `குவிண்டாலுக்கு ₹${v}` },
  "INR/ha": { en: (v) => `₹${v} per ha`, hi: (v) => `₹${v} प्रति हेक्टेयर`, ta: (v) => `ஹெக்டேருக்கு ₹${v}` },
  mm: { en: (v) => `${v} mm`, hi: (v) => `${v} मिमी`, ta: (v) => `${v} மிமீ` },
  L: { en: (v) => `${v} litres`, hi: (v) => `${v} लीटर`, ta: (v) => `${v} லிட்டர்` },
  m3: { en: (v) => `${v} m³`, hi: (v) => `${v} घन मीटर`, ta: (v) => `${v} கன மீட்டர்` },
  days: { en: (v) => `${v} days`, hi: (v) => `${v} दिन`, ta: (v) => `${v} நாட்கள்` },
  celsius: { en: (v) => `${v} °C`, hi: (v) => `${v} डिग्री सेल्सियस`, ta: (v) => `${v} டிகிரி செல்சியஸ்` },
  percent: { en: (v) => `${v} percent`, hi: (v) => `${v} प्रतिशत`, ta: (v) => `${v} சதவீதம்` },
  m: { en: (v) => `${v} metres`, hi: (v) => `${v} मीटर`, ta: (v) => `${v} மீட்டர்` },
  cm: { en: (v) => `${v} cm`, hi: (v) => `${v} सेमी`, ta: (v) => `${v} செ.மீ` },
  g: { en: (v) => `${v} g`, hi: (v) => `${v} ग्राम`, ta: (v) => `${v} கிராம்` },
  months: { en: (v) => `${v} months`, hi: (v) => `${v} महीने`, ta: (v) => `${v} மாதங்கள்` },
};

/** "/scenarios/0/netInr" -> "net inr". Digits are dropped so the label never carries a number. */
export function fieldLabel(jsonPointer: string): string {
  // ".../value", ".../amount/central" (unit-bearing records, F8) are labelled by the record's field name.
  const seg = jsonPointer.split("/").filter((s) => s !== "" && !/^\d+$/.test(s) && !/^(value|amount|low|central|high)$/.test(s)).pop() ?? "value";
  const words = seg.replace(/~1/g, " ").replace(/~0/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").replace(/\d+/g, " ").replace(/[^\p{L}\p{M} ]/gu, " ").trim().toLowerCase().replace(/\s+/g, " ");
  return words || "value";
}

export function numberSentence(lang: TemplateLanguage, label: string, value: Decimal, unit: Unit): string | null {
  const w = UNIT_WORDING[unit]?.[lang];
  if (!w) return null;
  const v = w(value.toString());
  return lang === "hi" ? `${label} के लिए संख्या ${v} है।` : lang === "ta" ? `${label} க்கான எண் ${v}.` : `The number for ${label} is ${v}.`;
}

export function riskSentence(lang: TemplateLanguage, code: RiskCode): string {
  return RISK_TEMPLATES[code][lang];
}

type Block = StructuredAssistantOutput["answerBlocks"][number];
type Ref = StructuredAssistantOutput["numericRefs"][number];

/**
 * Template blocks for one withheld block. Risk findings win: the block becomes a safety sentence with
 * no numbers (a dosage block never gets its numbers back). Otherwise each verified numericRef becomes
 * one "The number for <field> is <value> <unit>" sentence. Returns null when nothing can be templated.
 */
export function templateBlock(
  lang: TemplateLanguage,
  original: Block,
  w: { riskCodes: RiskCode[]; validRefIds: string[]; forecastRefIds: string[] },
  refs: Map<string, Ref>,
  presented: (refId: string) => Decimal | null,
): { block: Block; template: string } | null {
  if (w.riskCodes.length > 0) {
    const codes = [...new Set(w.riskCodes)];
    return { block: { id: original.id, kind: "warning", text: codes.map((c) => riskSentence(lang, c)).join(" "), numericRefIds: [], claimIds: [] }, template: codes.join("+") };
  }
  const sentences: string[] = [];
  const used: string[] = [];
  for (const id of w.validRefIds) {
    const ref = refs.get(id);
    const value = presented(id);
    if (!ref || value === null) continue;
    const s = numberSentence(lang, fieldLabel(ref.jsonPointer), value, ref.presentation.unit);
    if (!s) continue;
    sentences.push(s);
    used.push(id);
  }
  if (sentences.length === 0) return null;
  if (w.forecastRefIds.some((id) => used.includes(id))) sentences.push(FORECAST_NOTE[lang]);
  return { block: { id: original.id, kind: "numeric", text: sentences.join(" "), numericRefIds: used, claimIds: [] }, template: "numeric" };
}

export const TEMPLATE_LIMITATION: Record<TemplateLanguage, string> = {
  en: "Some statements were replaced with standard wording written by the application because the generated text could not be verified.",
  hi: "कुछ कथनों को एप्लिकेशन द्वारा लिखे गए मानक शब्दों से बदला गया है क्योंकि उत्पन्न पाठ की पुष्टि नहीं हो सकी।",
  ta: "உருவாக்கப்பட்ட உரையைச் சரிபார்க்க முடியாததால் சில வாக்கியங்கள் பயன்பாட்டின் நிலையான சொற்களால் மாற்றப்பட்டன.",
};
