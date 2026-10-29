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
  MONEY,
  MULTIPLY_GAIN,
  NATIVE_RISK_LEXICON,
  NEGATION_EN,
  PER,
  RAIN,
  RAIN_FUTURE_VERB,
  UNIT_TERMS,
  YIELD,
  termRe,
  termSource,
} from "./lexicon";
import { DATE_PATTERNS, normaliseForChecks, normalizeDigits, stripDates, tokenize, unitAt, type NumberToken } from "./numbers";

export { normalizeDigits, stripDates };

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
const RAIN_VERB_RE = termRe(RAIN_FUTURE_VERB);
const MM_RE = new RegExp(`\\d\\s?${termSource(UNIT_TERMS.mm!)}`, "iu");

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
  return out;
}

export function detectFutureRain(text: string, asOf: Date, horizonDays: number): RiskHit | null {
  const limit = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) + horizonDays * 86_400_000;
  for (const s of sentences(prep(text))) {
    if (!RAIN_RE.test(s) || !(MM_RE.test(s) || RAIN_VERB_RE.test(s) || /\bheavy\s+rain\s+on\b/iu.test(s))) continue;
    const beyond = extractDates(s, asOf).some((d) => d > limit) || relativeDays(s).some((d) => d > horizonDays);
    if (beyond) return { code: "future_daily_rain_beyond_horizon", message: `exact rain stated beyond the ${horizonDays}-day forecast horizon` };
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
    `\\bit\\s+is\\s+(?:a\\s+|an\\s+)?[a-z ]{0,20}${D}`,
    `\\b(?:caused\\s+by|due\\s+to|because\\s+of|result\\s+of|a\\s+(?:clear\\s+)?(?:sign|symptom|case)\\s+of)\\b[^.\\n]{0,40}${D}`,
  ].join("|"),
  "iu",
);
const HEDGE_RE = termRe(HEDGE);
const CERT_INDIC_RE = termRe({ indic: CERTAINTY.indic ?? [] });
const DISEASE_RE = termRe(DISEASE);
const SUBJECT_INDIC_RE = termRe(DIAGNOSIS_SUBJECT);

export function detectDiagnosisCertainty(text: string): RiskHit | null {
  for (const s of clauses(prep(text))) {
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
const VERB_RE = termRe(DOSAGE_VERBS);
const CHEM_RE = termRe(CHEMICAL_NOUNS);
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
  }
  return out;
}

function indicAreaRate(t: NumberToken): "kg/ha" | "kg/acre" | null {
  const around = `${t.prefix} ${t.suffix}`;
  if (new RegExp(termSource(UNIT_TERMS.ha!), "iu").test(around)) return "kg/ha";
  if (new RegExp(termSource(UNIT_TERMS.acre!), "iu").test(around)) return "kg/acre";
  return null;
}

export function detectDosage(text: string): RiskHit | null {
  return dosageMentions(text).length > 0 ? { code: "chemical_dosage", message: "chemical or input dosage amount stated in prose" } : null;
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
const GAIN_RE = termRe(MULTIPLY_GAIN);
const WILL_RICH_RE = /\bwill\s+(?:make\s+you\s+(?:rich|wealthy)|bring\s+(?:you\s+)?(?:big|huge|high|great)\s+(?:profits?|income|returns?))/iu;
export function detectGuaranteedProfit(text: string): RiskHit | null {
  for (const s of clauses(prep(text))) {
    const money = MONEY_RE.test(s);
    if (isIndic(s)) {
      // Hindi/Tamil: negation is not honoured (fail closed).
      if (money && (GUARANTEE_INDIC_RE.test(s) || GAIN_RE.test(s))) return { code: "guaranteed_profit", message: "guaranteed or multiplied profit/income claim" };
      if (termRe({ indic: GUARANTEE.indic ?? [] }).test(s)) return { code: "guaranteed_profit", message: "guarantee stated" };
      continue;
    }
    if (NEGATION_EN.test(s)) continue;
    if ((GUARANTEE_RE.test(s) && money) || (GAIN_RE.test(s) && money) || WILL_RICH_RE.test(s)) return { code: "guaranteed_profit", message: "guaranteed or multiplied profit/income claim" };
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
  const hits = [detectFutureRain(text, o.asOf, o.rainHorizonDays), detectDiagnosisCertainty(text), detectDosage(text), detectCanopyYield(text), detectGuaranteedProfit(text), o.allowConfidencePercent ? null : detectConfidencePercent(text)];
  return hits.filter((h): h is RiskHit => h !== null);
}

/** Hindi/Tamil high-risk lexicon hits (used by the gate's non-English fail-closed rule). */
export function nativeLexiconHits(text: string): string[] {
  const t = text.normalize("NFC");
  return NATIVE_RISK_LEXICON.filter((l) => termRe(l.list).test(t)).map((l) => l.name);
}
