/**
 * High-risk assertion detectors for the output gate (BUILD_SPEC 9 step 5). Pure functions over prose.
 * These are deliberately conservative rule checks; they are labelled limited (English plus a few
 * Tamil/Hindi unit and rain words) and are not a semantic verifier.
 */

export type RiskCode =
  | "future_daily_rain_beyond_horizon"
  | "diagnosis_certainty"
  | "chemical_dosage"
  | "yield_from_canopy"
  | "guaranteed_profit"
  | "confidence_percentage_unbacked";

export interface RiskHit {
  code: RiskCode;
  message: string;
}

/** Maps Indic and full-width digits to ASCII so numbers cannot dodge checks by script. */
export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩०-९০-৯௦-௯０-９]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    const base = cp >= 0xff10 ? 0xff10 : cp >= 0x0be6 ? 0x0be6 : cp >= 0x09e6 ? 0x09e6 : cp >= 0x0966 ? 0x0966 : 0x0660;
    return String(cp - base);
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_PATTERNS = {
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  dayMonth: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "gi"),
  monthDay: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"),
};

/** Removes date expressions (and standalone years/times) so their digits are not treated as quantities. */
export function stripDates(s: string): string {
  return s
    .replace(DATE_PATTERNS.iso, " ")
    .replace(DATE_PATTERNS.dayMonth, " ")
    .replace(DATE_PATTERNS.monthDay, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
}

function monthIndex(m: string): number {
  return MONTHS.indexOf(m.slice(0, 3).toLowerCase());
}

const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);

/** All explicit calendar dates in the text, resolved against asOf's year (rolling to next year if already past). */
export function extractDates(text: string, asOf: Date): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(DATE_PATTERNS.iso)) out.push(utc(+m[1]!, +m[2]! - 1, +m[3]!));
  const asOfMs = utc(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const resolve = (mon: string, day: string, year: string | undefined) => {
    const mi = monthIndex(mon);
    if (mi < 0) return;
    let y = year ? +year : asOf.getUTCFullYear();
    let t = utc(y, mi, +day);
    if (!year && t < asOfMs - 30 * 86_400_000) t = utc(++y, mi, +day);
    out.push(t);
  };
  for (const m of text.matchAll(DATE_PATTERNS.dayMonth)) resolve(m[2]!, m[1]!, m[3]);
  for (const m of text.matchAll(DATE_PATTERNS.monthDay)) resolve(m[1]!, m[2]!, m[3]);
  return out;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?।])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
}

const RAIN_WORDS = /\b(rain|rainfall|rains|shower|showers|precipitation|downpour|drizzle)\b|மழை|बारिश|वर्षा/iu;
const RAIN_ASSERTION = /\b(\d+(?:\.\d+)?)\s?(?:mm|millimet(?:re|er)s?)\b|\bwill\s+(?:rain|pour|receive)\b|\bit\s+will\s+rain\b|\bexpect(?:ed)?\s+(?:heavy\s+)?rain\b|\bheavy\s+rain\s+on\b/iu;

function relativeDays(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\b(?:in|after|within|by)\s+(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)\b/giu)) {
    const n = +m[1]!;
    const unit = m[2]!.toLowerCase();
    out.push(unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30);
  }
  if (/\bnext\s+month\b/iu.test(s)) out.push(30);
  return out;
}

export function detectFutureRain(text: string, asOf: Date, horizonDays: number): RiskHit | null {
  const t = normalizeDigits(text);
  const limit = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) + horizonDays * 86_400_000;
  for (const s of sentences(t)) {
    if (!RAIN_WORDS.test(s) || !RAIN_ASSERTION.test(s)) continue;
    const beyond = extractDates(s, asOf).some((d) => d > limit) || relativeDays(s).some((d) => d > horizonDays);
    if (beyond) return { code: "future_daily_rain_beyond_horizon", message: `exact rain stated beyond the ${horizonDays}-day forecast horizon` };
  }
  return null;
}

const HEDGE = /\b(may|might|could|possibly|possible|likely|probably|perhaps|suspect(?:ed)?|appears?|seems?|looks?\s+like|consistent\s+with|can\s+be|check|inspect|consider)\b/iu;
const DISEASE = "(?:disease|infection|infected|blight|wilt|rot|rust|virus|viral|mildew|fung(?:us|al)|bacterial|mite|mites|borer|aphids?|nematodes?|deficiency|toxicity|smut|canker|mosaic)";
const CERTAIN_DIAGNOSIS = new RegExp(`\\b(?:definitely|certainly|surely|undoubtedly|clearly|confirmed|100\\s?%|for\\s+sure)\\b[^.\\n]{0,50}${DISEASE}|${DISEASE}[^.\\n]{0,40}\\b(?:is|are)\\s+(?:definitely|certainly|confirmed|surely)\\b`, "iu");
const ASSERTED_DIAGNOSIS = new RegExp(`\\b(?:your|the|this|these)\\s+(?:crop|plants?|ginger|leaves?|field|rhizomes?|stems?)\\b[^.\\n]{0,30}\\b(?:has|have|is\\s+suffering\\s+from|are\\s+suffering\\s+from|is\\s+infected\\s+with|are\\s+infected\\s+with|is\\s+affected\\s+by|are\\s+affected\\s+by|suffers?\\s+from|is\\s+diagnosed\\s+with)\\b[^.\\n]{0,40}${DISEASE}|\\bthis\\s+is\\s+(?:a\\s+case\\s+of\\s+)?${DISEASE}|\\bit\\s+is\\s+(?:a\\s+|an\\s+)?[a-z ]{0,20}${DISEASE}`, "iu");

export function detectDiagnosisCertainty(text: string): RiskHit | null {
  for (const s of sentences(text)) {
    if (CERTAIN_DIAGNOSIS.test(s)) return { code: "diagnosis_certainty", message: "diagnosis stated with certainty" };
    if (ASSERTED_DIAGNOSIS.test(s) && !HEDGE.test(s)) return { code: "diagnosis_certainty", message: "diagnosis asserted without hedging" };
  }
  return null;
}

const NB = "(?<![\\p{L}\\p{N}])";
const NA = "(?![\\p{L}\\p{N}])";
const MASS_VOL = "(?:ml|mL|cc|g|gm|gms|grams?|kg|l|lit(?:re|er)s?|millilit(?:re|er)s?|मिली|ग्राम|किलो|लीटर|மில்லி|கிராம்|கிலோ|லிட்டர்)";
const PER = "(?:/|per|प्रति|ஒரு)";
const DOSE_PER = new RegExp(`${NB}(\\d+(?:\\.\\d+)?)\\s?${MASS_VOL}\\s?${PER}\\s?(?:\\d+\\s?)?(?:l|lit(?:re|er)s?|acre|ha|hectares?|tank|pump|plant|लीटर|एकड़|हेक्टेयर|लिटर|ஏக்கர்|லிட்டர்)${NA}`, "giu");
const DOSE_VERB = new RegExp(`\\b(?:spray|apply|dose|dosage|mix|dissolve|drench|dilute|add|sprinkle)\\b[^.\\n]{0,60}${NB}(\\d+(?:\\.\\d+)?)\\s?${MASS_VOL}${NA}`, "giu");

/** Dosage-like quantities in prose: values with their unit text, for exception handling by the caller. */
export function dosageMentions(text: string): { value: string; unit: string }[] {
  const t = normalizeDigits(text);
  const out: { value: string; unit: string }[] = [];
  for (const re of [DOSE_PER, DOSE_VERB]) {
    for (const m of t.matchAll(re)) out.push({ value: m[1]!, unit: m[0] });
  }
  return out;
}

export function detectDosage(text: string): RiskHit | null {
  return dosageMentions(text).length > 0 ? { code: "chemical_dosage", message: "chemical or input dosage amount stated in prose" } : null;
}

const CANOPY = /\b(canopy|green\s+cover|ndvi|leaf\s+area|vegetation\s+index|plant\s+density|photo|photograph|picture|image)\b/iu;
const YIELD = /\b(yield|harvest|production|tonnes?|tons?|quintals?|kg\s?\/\s?(?:ha|acre))\b/iu;
export function detectCanopyYield(text: string): RiskHit | null {
  for (const s of sentences(normalizeDigits(text))) {
    if (CANOPY.test(s) && YIELD.test(s) && (/\d/.test(stripDates(s)) || /\byou\s+will\s+(?:get|harvest)\b|\bwill\s+yield\b/iu.test(s))) {
      return { code: "yield_from_canopy", message: "field yield derived from canopy or image" };
    }
  }
  return null;
}

const GUARANTEE = /\b(guarantee[sd]?|assured|risk[\s-]?free|no\s+risk|certain(?:ly)?\s+(?:to\s+)?(?:earn|profit|make)|definitely\s+(?:earn|profit|make)|sure\s+(?:profit|income|returns?)|surely|for\s+sure)\b/iu;
const MONEY = /\b(profit|profits|income|returns?|earn|earnings?|money|revenue|margin)\b/iu;
const NEGATION = /\b(no|not|cannot|can't|cant|never|without|isn't|aren't|don't|doesn't|won't|nor|neither)\b/iu;
export function detectGuaranteedProfit(text: string): RiskHit | null {
  for (const s of sentences(text)) {
    if (GUARANTEE.test(s) && MONEY.test(s) && !NEGATION.test(s)) return { code: "guaranteed_profit", message: "guaranteed profit or income claim" };
  }
  return null;
}

const CONF_WORDS = "(?:confiden\\w*|certain\\w*|sure|accura\\w*|probab\\w*|likel\\w*|chance)";
const CONF_A = new RegExp(`\\b\\d+(?:\\.\\d+)?\\s?(?:%|percent)[^.\\n]{0,30}\\b${CONF_WORDS}\\b`, "iu");
const CONF_B = new RegExp(`\\b${CONF_WORDS}\\b[^.\\n]{0,30}\\b\\d+(?:\\.\\d+)?\\s?(?:%|percent)`, "iu");
export function detectConfidencePercent(text: string): RiskHit | null {
  const t = normalizeDigits(text);
  return CONF_A.test(t) || CONF_B.test(t) ? { code: "confidence_percentage_unbacked", message: "confidence percentage not backed by a labelled evaluation" } : null;
}

export function detectHighRisk(text: string, o: { asOf: Date; rainHorizonDays: number; allowConfidencePercent: boolean }): RiskHit[] {
  const hits = [detectFutureRain(text, o.asOf, o.rainHorizonDays), detectDiagnosisCertainty(text), detectDosage(text), detectCanopyYield(text), detectGuaranteedProfit(text), o.allowConfidencePercent ? null : detectConfidencePercent(text)];
  return hits.filter((h): h is RiskHit => h !== null);
}
