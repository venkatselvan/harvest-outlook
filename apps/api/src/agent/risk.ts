/**
 * High-risk assertion detectors for the output gate (BUILD_SPEC 9 step 5). Pure functions over prose.
 * These are conservative rule checks over small English/Hindi/Tamil lexicons (agent/lexicon.ts); they
 * are not a semantic verifier. Text is normalised first (digits, number words, multipliers), so
 * "two millilitres" or "४० मिमी" are checked like "2 ml" or "40 mm".
 */
import {
  CANOPY,
  CERTAINTY,
  CHEMICAL_NOUNS,
  CONFIDENCE,
  DENOMINATOR,
  DIAGNOSIS_SUBJECT,
  DISEASE,
  DOSAGE_VERBS,
  DOSE_UNITS,
  GUARANTEE,
  HEDGE,
  INDIC_RATE_MARK,
  INDIC_SCRIPT,
  LATIN_RISK_LEXICON,
  LOSS,
  MONEY,
  MULTIPLY_GAIN,
  NATIVE_RISK_LEXICON,
  NEGATION_EN,
  PER,
  RAIN,
  SEASONAL_RAIN,
  ROMAN_CHEMICAL_NOUNS,
  ROMAN_DOSAGE_VERBS,
  UNIT_TERMS,
  YIELD,
  termRe,
  termSource,
} from "./lexicon";
import { DATE_PATTERNS, normaliseForChecks, normalizeDigits, stripDates, tokenize, unitAt, type NumberToken } from "./numbers";

export { normalizeDigits, stripDates };

export type RiskCode =
  | "future_daily_rain_beyond_horizon"
  | "future_rain_unsourced"
  | "diagnosis_certainty"
  | "chemical_dosage"
  | "yield_from_canopy"
  | "guaranteed_profit"
  | "confidence_percentage_unbacked";

export interface RiskHit {
  code: RiskCode;
  message: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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
  for (const m of text.matchAll(DATE_PATTERNS.monthYear)) resolve(m[1]!, "1", m[2]);
  return out;
}

/** Sentences; clauses additionally split on ";" and ":" so a hedge in one clause cannot cover another. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?।॥])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
}
function clauses(text: string): string[] {
  return sentences(text).flatMap((s) => s.split(/[;:]/u)).map((s) => s.trim()).filter(Boolean);
}

const isIndic = (s: string) => INDIC_SCRIPT.test(s);
/** Text prepared for detection: NFC, ASCII digits and number words as digits. Dates are kept. */
const prep = (text: string) => normaliseForChecks(text, { englishDates: false });

// ------------------------------------------------------------------ future rain
const RAIN_RE = termRe(RAIN);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function relativeDays(s: string): number[] {
  const out: number[] = [];
  const scale = (u: string) => (/^(day|दिन|நா)/iu.test(u) ? 1 : /^(week|हफ|सप्ताह|வார)/iu.test(u) ? 7 : 30);
  for (const m of s.matchAll(/(?:in|after|within|by|over)\s+(?:the\s+)?(?:next\s+)?(\d+(?:\.\d+)?)\s*(days?|weeks?|months?)/giu)) out.push(+m[1]! * scale(m[2]!));
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(days?|weeks?|months?)\s+(?:from\s+now|later|ahead|time)/giu)) out.push(+m[1]! * scale(m[2]!));
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(दिन|हफ्ते|हफ़्ते|हफ्तों|सप्ताह|महीने|महीनों|माह|நாட்கள|நாள|நாட்|வார|மாத)/gu)) out.push(+m[1]! * scale(m[2]!));
  if (/\bnext\s+month\b|अगले\s*(?:महीने|माह)|अगला\s*(?:महीना|माह)|அடுத்த\s*மாத|வரும்\s*மாத/iu.test(s)) out.push(30);
  if (/\bnext\s+(?:week|fortnight)\b|अगले\s*(?:हफ्ते|हफ़्ते|सप्ताह)|अगला\s*(?:हफ्ता|सप्ताह)|அடுத்த\s*வார|வரும்\s*வார/iu.test(s)) out.push(14);
  if (/\btomorrow\b|(?<![\p{L}\p{M}])कल(?![\p{L}\p{M}])|நாளை/iu.test(s)) out.push(1);
  if (/day\s+after\s+tomorrow|परसों|நாளை\s*மறுநாள்/iu.test(s)) out.push(2);
  // F8: "fortnight", "next Friday" (conservatively the later reading: 8-14 days), "this weekend" is near.
  if (/\bfortnight\b|पखवाड़|இரண்டு\s*வார/iu.test(s)) out.push(14);
  if (/\b(?:later\s+this|end\s+of\s+(?:the|this))\s+month\b|\bmonth[\s-]end\b|\bnext\s+season\b/iu.test(s)) out.push(30);
  return out;
}

/** Days from asOf to a named weekday ("on Friday" = next occurrence; "next Friday" = the one after). */
function weekdayDays(s: string, asOf: Date): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\b(next|this|coming|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/giu)) {
    const target = WEEKDAYS.indexOf(m[2]!.toLowerCase());
    let d = (target - asOf.getUTCDay() + 7) % 7 || 7;
    if (m[1] && m[1].toLowerCase() === "next") d += 7;
    out.push(d);
  }
  return out;
}

/** dd/mm and dd-mm dates (Indian order), resolved like month-name dates. */
function numericDates(s: string, asOf: Date): number[] {
  const out: number[] = [];
  const asOfMs = utc(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  for (const m of s.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?![\d/.-])/gu)) {
    const day = +m[1]!;
    const mon = +m[2]! - 1;
    if (day < 1 || day > 31 || mon < 0 || mon > 11) continue;
    let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : asOf.getUTCFullYear();
    let t = utc(y, mon, day);
    if (!m[3] && t < asOfMs - 30 * 86_400_000) t = utc(++y, mon, day);
    out.push(t);
  }
  return out;
}

export function detectFutureRain(text: string, asOf: Date, horizonDays: number): RiskHit | null {
  const limit = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) + horizonDays * 86_400_000;
  for (const s of sentences(prep(text))) {
    // F8: any weather noun with a date beyond the horizon, whatever the verb (or none) and with or without mm.
    if (!RAIN_RE.test(s)) continue;
    const beyond =
      extractDates(s, asOf).some((d) => d > limit) ||
      numericDates(s, asOf).some((d) => d > limit) ||
      relativeDays(s).some((d) => d > horizonDays) ||
      weekdayDays(s, asOf).some((d) => d > horizonDays);
    if (beyond) return { code: "future_daily_rain_beyond_horizon", message: `exact rain stated beyond the ${horizonDays}-day forecast horizon` };
  }
  return null;
}

// ------------------------------------------------------------------ seasonal rain outlook (F14)
const SR = Object.fromEntries(Object.entries(SEASONAL_RAIN).map(([k, v]) => [k, termRe(v)])) as Record<keyof typeof SEASONAL_RAIN, RegExp>;
const MONSOON_QUALIFIED = new RegExp(`${termSource(SEASONAL_RAIN.monsoonQualifier)}[^.!?।\\n]{0,40}${termSource(SEASONAL_RAIN.monsoon)}|${termSource(SEASONAL_RAIN.monsoon)}[^.!?।\\n]{0,40}${termSource(SEASONAL_RAIN.monsoonQualifier)}`, "iu");
const CONDITIONAL_BEFORE = new RegExp(`${termSource(SEASONAL_RAIN.conditionalBefore)}\\s+(?:[^\\s]+\\s+){0,3}$`, "iu");
/** Tamil conditional verb after the rain word ("பருவமழை தாமதமானால்", "மழை பெய்தால்"). */
const TA_CONDITIONAL_AFTER = /^[\p{L}\p{M}]*(?:\s+[\p{L}\p{M}]+){0,3}?\s+[\p{L}\p{M}]*(?:ால்|என்றால்)(?![\p{L}\p{M}])/u;

/**
 * F14 (review R5 #5): an unsourced seasonal rain outlook ("The monsoon will fail this year"). Per sentence: a
 * rain/monsoon word, not inside a conditional, with a modal-future occurrence verb, or with a seasonal marker (this
 * year, next season, arrive, fail; early/late only next to a monsoon word) and no past-tense or general-statement
 * marker. The gate lets it through only with a forecast-tool reference or a verified evidence claim.
 */
export function detectSeasonalRain(text: string): RiskHit | null {
  for (const s of sentences(text.normalize("NFC"))) {
    const rain = RAIN_RE.exec(s);
    if (!rain) continue;
    if (CONDITIONAL_BEFORE.test(s.slice(0, rain.index)) || TA_CONDITIONAL_AFTER.test(s.slice(rain.index + rain[0].length))) continue;
    const modal = SR.modalFuture.test(s);
    const seasonal = SR.seasonal.test(s) || MONSOON_QUALIFIED.test(s);
    if (modal || (seasonal && !SR.past.test(s) && !SR.general.test(s))) {
      return { code: "future_rain_unsourced", message: "a seasonal or future rain statement without a forecast reference or verified evidence" };
    }
  }
  return null;
}

// ------------------------------------------------------------------ diagnosis certainty
const D = termSource(DISEASE);
const CERT_SRC = termSource({ en: CERTAINTY.en ?? [] });
const CERTAIN_DIAGNOSIS_EN = new RegExp(`(?:${CERT_SRC}|100\\s?%)[^.\\n]{0,50}${D}|${D}[^.\\n]{0,40}\\b(?:is|are)\\s+(?:definitely|certainly|confirmed|surely)\\b`, "iu");
const ASSERTED_DIAGNOSIS_EN = new RegExp(
  [
    `\\b(?:your|the|this|these|my)\\s+(?:crop|plants?|ginger|leaves?|field|rhizomes?|stems?|roots?|yellowing|spots?|damage|symptoms?)\\b[^.\\n]{0,30}\\b(?:has|have|is\\s+suffering\\s+from|are\\s+suffering\\s+from|is\\s+infected\\s+with|are\\s+infected\\s+with|is\\s+affected\\s+by|are\\s+affected\\s+by|suffers?\\s+from|is\\s+diagnosed\\s+with|got|caught)\\b[^.\\n]{0,40}${D}`,
    `\\bthis\\s+is\\s+(?:a\\s+case\\s+of\\s+|an?\\s+)?${D}`,
    `\\b(?:it|this|that)(?:\\s+is|'s|’s|s)\\s+(?:a\\s+|an\\s+)?[a-z ]{0,20}${D}`,
    // F8: disease as complement or subject: "you have X", "X is what is happening", "the problem is X",
    // "there is X in your field", a clause that only asserts "X in the field".
    `\\byou(?:'ve|’ve|\\s+have|\\s+have\\s+got|\\s+got|\\s+are\\s+(?:dealing|facing|seeing)\\s+(?:with\\s+)?)\\b[^.\\n]{0,40}${D}`,
    `${D}[^.\\n]{0,10}\\s+(?:is|are)\\s+(?:what|exactly\\s+what|the\\s+(?:cause|problem|issue|reason|culprit|diagnosis))\\b`,
    `\\bthe\\s+(?:problem|issue|cause|culprit|diagnosis|reason)\\s+(?:here\\s+)?(?:is|are)\\s+[^.\\n]{0,25}${D}`,
    `\\bthere\\s+(?:is|are)\\s+[^.\\n]{0,25}${D}[^.\\n]{0,10}\\b(?:in|on|affecting)\\s+(?:the|your)\\s+(?:field|crop|plants?|farm|beds?|rhizomes?)`,
    `^\\s*[\\p{L} ]{0,25}${D}\\s+(?:in|on)\\s+(?:the|your)\\s+(?:field|crop|plants?|farm|beds?)\\s*[.!]?\\s*$`,
    `\\b(?:caused\\s+by|due\\s+to|because\\s+of|result\\s+of|a\\s+(?:clear\\s+)?(?:sign|symptom|case)\\s+of)\\b[^.\\n]{0,40}${D}`,
    // F13 (review R4 #4): implied diagnosis. A disease noun as the subject of a progressive/perfect verb ("the rot
    // has reached the rhizomes", "rot is spreading"), or an observation that shows/indicates/means a disease.
    `${D}[^.\\n]{0,25}?\\b(?:has|have|had)\\s+(?:already\\s+)?(?:reached|spread|affected|infected|attacked|damaged|destroyed|killed|entered|taken\\s+hold|set\\s+in|started|begun|appeared)\\b`,
    `${D}[^.\\n]{0,25}?\\b(?:is|are|was|were)\\s+(?:now\\s+|already\\s+)?(?:spreading|attacking|affecting|infecting|damaging|destroying|killing|entering|moving|reaching|present|active|visible|developing|setting\\s+in)\\b`,
    `${D}\\s+(?:spreads?|attacks?|affects?|infects?|kills?)\\s+(?:the|your|this|these|its)\\b`,
    `\\b(?:shows?|showing|indicates?|indicating|means|meaning|confirms?|proves?|signals?|reveals?|points\\s+to)\\s+(?:that\\s+)?(?:(?:the|a|an|your|this|some)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?${D}`,
  ].join("|"),
  "iu",
);
const HEDGE_RE = termRe(HEDGE);
const CERT_INDIC_RE = termRe({ indic: CERTAINTY.indic ?? [] });
const DISEASE_RE = termRe(DISEASE);
const SUBJECT_INDIC_RE = termRe(DIAGNOSIS_SUBJECT);

export function detectDiagnosisCertainty(text: string): RiskHit | null {
  // A hedge must sit in the same comma-separated clause as the assertion ("This may not be X, it's Y").
  for (const s of clauses(prep(text)).flatMap((c) => c.split(/,/u)).map((c) => c.trim()).filter(Boolean)) {
    if (CERTAIN_DIAGNOSIS_EN.test(s)) return { code: "diagnosis_certainty", message: "diagnosis stated with certainty" };
    if (ASSERTED_DIAGNOSIS_EN.test(s) && !HEDGE_RE.test(s)) return { code: "diagnosis_certainty", message: "diagnosis asserted without hedging" };
    if (isIndic(s) && DISEASE_RE.test(s)) {
      // Hindi/Tamil: negation is not honoured (fail closed); a certainty word with a disease is certain.
      if (CERT_INDIC_RE.test(s)) return { code: "diagnosis_certainty", message: "diagnosis stated with certainty" };
      if (SUBJECT_INDIC_RE.test(s) && !HEDGE_RE.test(s)) return { code: "diagnosis_certainty", message: "diagnosis asserted without hedging" };
    }
  }
  return null;
}

// ------------------------------------------------------------------ dosage
const VERB_RE = new RegExp(`${termSource(DOSAGE_VERBS)}|${termSource(ROMAN_DOSAGE_VERBS)}`, "iu");
const CHEM_RE = new RegExp(`${termSource(CHEMICAL_NOUNS)}|${termSource(ROMAN_CHEMICAL_NOUNS)}`, "iu");
/**
 * F8: dose-unit and container words WITHOUT a number ("spray the litre", "a bag of urea" before
 * normalisation). Single-letter unit symbols (l, g, t) are excluded here: they collide with ordinary text.
 */
const DOSE_WORD_RE = new RegExp(
  termSource({
    en: ["kilos?", "kilograms?", "kgs?", "lit(?:re|er)s?", "ltrs?", "leeta?rs?", "millilit(?:re|er)s?", "ml", "grams?", "gms?", "quintals?", "qtls?", "tonnes?",
      ...((UNIT_TERMS.spoon!.en ?? []) as string[])],
    indic: [...(UNIT_TERMS.L!.indic ?? []), ...(UNIT_TERMS.ml!.indic ?? []), ...(UNIT_TERMS.kg!.indic ?? []), ...(UNIT_TERMS.g!.indic ?? []), ...(UNIT_TERMS.quintal!.indic ?? []), ...(UNIT_TERMS.spoon!.indic ?? [])],
  }),
  "giu",
);
const DENOM_BEFORE_RE = /(?:\bper|\/|\beach|\bevery|प्रति|हर|ஒவ்வொரு)\s*$/iu;
const DENOM_AFTER_RE = new RegExp(`^\\s*(?:of\\s+[\\p{L}\\p{M} ]{0,30}?\\s*)?${termSource(PER)}\\s*(?:\\d+\\s*)?${termSource(DENOMINATOR)}`, "iu");
const INDIC_RATE_RE = termRe(INDIC_RATE_MARK);
const MASS_PER_AREA_RE = new RegExp(`^\\s*${termSource(UNIT_TERMS.kg!)}\\s*${termSource(PER)}?\\s*(${termSource(UNIT_TERMS.ha!)}|${termSource(UNIT_TERMS.acre!)})`, "iu");
const DOSE_UNIT_SET = new Set<string>(DOSE_UNITS);

export interface DosageMention {
  value: string;
  /** Canonical unit of the quantity (ml, L, g, kg, spoon, quintal, t). */
  unit: string;
  /** "kg/ha" or "kg/acre" when stated as a mass-per-area rate; otherwise null. */
  rate: "kg/ha" | "kg/acre" | null;
}

/** Dosage-like quantities in prose: a mass/volume quantity in a clause with a rate, a dosing verb or a chemical. */
export function dosageMentions(text: string): DosageMention[] {
  const out: DosageMention[] = [];
  for (const s of sentences(prep(text))) {
    const toks = tokenize(s);
    const verb = VERB_RE.test(s);
    const chem = CHEM_RE.test(s);
    const indicRate = isIndic(s) && INDIC_RATE_RE.test(s);
    const before = out.length;
    for (const t of toks) {
      const u = unitAt(t);
      if (!u || !DOSE_UNIT_SET.has(u)) continue;
      const suffixAfterUnit = t.suffix.replace(new RegExp(`^[\\s(:-]*${termSource(UNIT_TERMS[u]!)}`, "iu"), "");
      const perRate = DENOM_AFTER_RE.test(suffixAfterUnit);
      if (!(perRate || verb || chem || indicRate)) continue;
      const area = MASS_PER_AREA_RE.exec(t.suffix);
      const rate = u === "kg" && area ? (new RegExp(termSource(UNIT_TERMS.ha!), "iu").test(area[1]!) ? "kg/ha" : "kg/acre") : u === "kg" && isIndic(s) ? indicAreaRate(t) : null;
      out.push({ value: t.value.toString(), unit: u, rate });
    }
    // F8: a dose without a number: a dose-unit/container word together with a chemical noun or an
    // application verb in one clause. A unit used only as a price/rate denominator ("₹40 per kg") counts
    // only when a chemical is named.
    if (out.length === before) {
      for (const c of s.split(/[;:,]/u)) {
        const cv = VERB_RE.test(c);
        const cc = CHEM_RE.test(c);
        if (!cv && !cc) continue;
        const words = [...c.matchAll(DOSE_WORD_RE)];
        const nonDenom = words.some((m) => !DENOM_BEFORE_RE.test(c.slice(0, m.index)));
        if (words.length > 0 && (cc || nonDenom)) {
          out.push({ value: "", unit: "unquantified", rate: null });
          break;
        }
      }
    }
  }
  return out;
}

function indicAreaRate(t: NumberToken): "kg/ha" | "kg/acre" | null {
  const around = `${t.prefix} ${t.suffix}`;
  if (new RegExp(termSource(UNIT_TERMS.ha!), "iu").test(around)) return "kg/ha";
  if (new RegExp(termSource(UNIT_TERMS.acre!), "iu").test(around)) return "kg/acre";
  return null;
}

/** True when a (normalised) sentence applies an input: an application verb together with a chemical/input noun. */
export function isApplicationContext(sentence: string): boolean {
  return VERB_RE.test(sentence) && CHEM_RE.test(sentence);
}

/** True when the text contains any application verb or chemical/input noun (en/hi/ta/romanised). */
export function hasApplicationWords(text: string): boolean {
  const t = prep(text);
  return VERB_RE.test(t) || CHEM_RE.test(t);
}

/**
 * F13 (review R4 #4): an input instruction without a number is still a dose instruction. A clause with an
 * application verb and a chemical/input noun, or a chemical noun with a strength/frequency modifier ("double
 * the dose", "mix it stronger"), is chemical_dosage unless the clause is a referral to an officer/label.
 */
const DOSE_MODIFIER_RE = termRe({
  en: ["doses?", "dosages?", "strength", "stronger", "weaker", "concentrat\\w*", "double[ds]?", "triple[ds]?", "twice", "half[\\s-]strength", "more\\s+often", "less\\s+often", "every\\s+(?:few|couple\\s+of|other)\\s+days", "until\\s+it\\s+stops", "heavier", "lighter"],
  indic: ["दोगुना", "दुगना", "दुगुना", "ज़्यादा", "ज्यादा", "कम मात्रा", "मात्रा", "இரட்டிப்பு", "அதிகமாக", "அளவு"],
});
const REFERRAL_RE = termRe({
  en: ["consult(?:ing)?", "ask(?:ing)?", "check\\s+with", "advice", "advise[sd]?", "officers?", "extension", "kvk", "krishi\\s+vigyan", "label", "expert", "agronomist"],
  indic: ["सलाह", "अधिकारी", "विशेषज्ञ", "அலுவலர", "அணுக", "நிபுணர", "ஆலோசனை"],
});
export function detectInputInstruction(text: string): RiskHit | null {
  for (const c of clauses(prep(text))) {
    if (!CHEM_RE.test(c) || REFERRAL_RE.test(c)) continue;
    if (VERB_RE.test(c) || DOSE_MODIFIER_RE.test(c)) return { code: "chemical_dosage", message: "chemical or input application instruction stated in prose" };
  }
  return null;
}

export function detectDosage(text: string): RiskHit | null {
  return dosageMentions(text).length > 0 ? { code: "chemical_dosage", message: "chemical or input dosage amount stated in prose" } : detectInputInstruction(text);
}

// ------------------------------------------------------------------ yield from canopy / photo
const CANOPY_RE = termRe(CANOPY);
const YIELD_RE = new RegExp(`${termSource(YIELD)}|kg\\s?/\\s?(?:ha|acre)`, "iu");
export function detectCanopyYield(text: string): RiskHit | null {
  for (const s of sentences(prep(text))) {
    if (CANOPY_RE.test(s) && YIELD_RE.test(s) && (/\d/.test(stripDates(s)) || /\byou\s+will\s+(?:get|harvest)\b|\bwill\s+yield\b/iu.test(s))) {
      return { code: "yield_from_canopy", message: "field yield derived from canopy or image" };
    }
  }
  return null;
}

// ------------------------------------------------------------------ guaranteed profit
const GUARANTEE_RE = new RegExp(`${termSource(GUARANTEE)}|${termSource({ en: ["certain(?:ly)?\\s+(?:to\\s+)?(?:earn|profit|make)", "definitely\\s+(?:earn|profit|make)", "surely", "for\\s+sure"] })}`, "iu");
const GUARANTEE_INDIC_RE = termRe({ indic: [...(GUARANTEE.indic ?? []), ...(CERTAINTY.indic ?? [])] });
const MONEY_RE = termRe(MONEY);
const LOSS_RE = termRe(LOSS);
const GAIN_RE = termRe(MULTIPLY_GAIN);
const WILL_RICH_RE = /\bwill\s+(?:make\s+you\s+(?:rich|wealthy)|bring\s+(?:you\s+)?(?:big|huge|high|great)\s+(?:profits?|income|returns?))/iu;
export function detectGuaranteedProfit(text: string): RiskHit | null {
  for (const s of clauses(prep(text))) {
    const money = MONEY_RE.test(s);
    if (isIndic(s)) {
      // Hindi/Tamil: negation is not honoured (fail closed).
      if ((money || LOSS_RE.test(s)) && (GUARANTEE_INDIC_RE.test(s) || GAIN_RE.test(s))) return { code: "guaranteed_profit", message: "guaranteed or multiplied profit/income claim" };
      if (termRe({ indic: GUARANTEE.indic ?? [] }).test(s)) return { code: "guaranteed_profit", message: "guarantee stated" };
      continue;
    }
    if (NEGATION_EN.test(s)) continue;
    if ((GUARANTEE_RE.test(s) && money) || (GAIN_RE.test(s) && money) || WILL_RICH_RE.test(s)) return { code: "guaranteed_profit", message: "guaranteed or multiplied profit/income claim" };
    // F8: a guaranteed loss/failure is also a guaranteed outcome.
    if (GUARANTEE_RE.test(s) && LOSS_RE.test(s)) return { code: "guaranteed_profit", message: "guaranteed loss or outcome claim" };
  }
  return null;
}

// ------------------------------------------------------------------ confidence percentage
const CONF = termSource(CONFIDENCE);
const PCT = `\\d+(?:\\.\\d+)?\\s?${termSource(UNIT_TERMS.percent!)}`;
const CONF_A = new RegExp(`${PCT}[^.\\n।]{0,30}${CONF}`, "iu");
const CONF_B = new RegExp(`${CONF}[^.\\n।]{0,30}${PCT}`, "iu");
export function detectConfidencePercent(text: string): RiskHit | null {
  const t = prep(text);
  return CONF_A.test(t) || CONF_B.test(t) ? { code: "confidence_percentage_unbacked", message: "confidence percentage not backed by a labelled evaluation" } : null;
}

export function detectHighRisk(text: string, o: { asOf: Date; rainHorizonDays: number; allowConfidencePercent: boolean }): RiskHit[] {
  const hits = [detectFutureRain(text, o.asOf, o.rainHorizonDays), detectSeasonalRain(text), detectDiagnosisCertainty(text), detectDosage(text), detectCanopyYield(text), detectGuaranteedProfit(text), o.allowConfidencePercent ? null : detectConfidencePercent(text)];
  return hits.filter((h): h is RiskHit => h !== null);
}

/** Hindi/Tamil high-risk lexicon hits (used by the gate's non-English fail-closed rule). */
export function nativeLexiconHits(text: string, o: { latin?: boolean } = {}): string[] {
  const t = text.normalize("NFC");
  const hits = NATIVE_RISK_LEXICON.filter((l) => termRe(l.list).test(t)).map((l) => l.name);
  if (o.latin && /\p{Script=Latin}/u.test(t)) hits.push(...LATIN_RISK_LEXICON.filter((l) => termRe(l.list).test(t)).map((l) => `latin_${l.name}`));
  return hits;
}
