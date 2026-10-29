import { Decimal } from "@harvest/domain";
import {
  AMBIGUOUS_NUMBER_WORDS,
  CURRENCY_PREFIX,
  CURRENCY_WORD,
  EN_NUMBER_WORDS,
  HI_FRACTION_WORDS,
  HI_MODIFIERS,
  HI_NUMBER_WORDS,
  MULTIPLIERS,
  ROMAN_NUMBER_WORDS,
  TA_COLLOQUIAL_STEMS,
  TA_EXACT_WORDS,
  TA_NUMBER_STEMS,
  UNIT_TERMS,
  termSource,
} from "./lexicon";

/**
 * Number extraction for the output gate. Text is normalised so a quantity cannot dodge the checks by
 * script, spelling or formatting: Indic/full-width digits become ASCII, number words (en/hi/ta small
 * lexicons) become digits, digits glued to letters are separated ("Rs500"), and multipliers (lakh,
 * crore, thousand, हज़ार, லட்சம் ...) are folded into the value. Only date expressions with an English
 * month name (and ISO dates, clock times) are removed, and only when `stripDates` is requested.
 */

/** Maps Indic and full-width digits to ASCII so numbers cannot dodge checks by script. */
export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯０-９]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    const bases = [0xff10, 0x0d66, 0x0ce6, 0x0c66, 0x0be6, 0x0b66, 0x0ae6, 0x0a66, 0x09e6, 0x0966, 0x0660];
    const base = bases.find((b) => cp >= b)!;
    return String(cp - base);
  });
}

export const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
export const DATE_PATTERNS = {
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  dayMonth: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "gi"),
  monthDay: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"),
  monthYear: new RegExp(`\\b${MONTH_RE}\\s*,?\\s+((?:19|20)\\d{2})\\b`, "gi"),
};

/**
 * Removes date expressions so their digits are not treated as quantities. A four-digit year is removed
 * ONLY as part of a date with a month name (or an ISO date); a standalone 2000 is a quantity.
 */
export function stripDates(s: string): string {
  return s
    .replace(DATE_PATTERNS.iso, " ")
    .replace(DATE_PATTERNS.dayMonth, " ")
    .replace(DATE_PATTERNS.monthDay, " ")
    .replace(DATE_PATTERNS.monthYear, " ")
    .replace(/\b\d{1,2}:\d{2}\b(?:\s?(?:am|pm)\b)?/gi, " ");
}

const MULT_RES = MULTIPLIERS.map(([t, v]) => [new RegExp(`^\\s*${termSource(t)}`, "iu"), v] as const);
const ANY_UNIT_RE = new RegExp(`^\\s*(?:${Object.values(UNIT_TERMS).map(termSource).join("|")}|${termSource(CURRENCY_WORD)})`, "iu");
const ANY_MULT_RE = new RegExp(`^\\s*(?:${MULTIPLIERS.map(([t]) => termSource(t)).join("|")})`, "iu");

/** Tamil stems that are also ordinary words or prefixes of ordinary words: whole-word match only. */
const TA_EXACT = new Set(["ஒரு", "ஆறு", "ஏழு", "எட்டு"].map((x) => x.normalize("NFC")));

const own = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function numberWordValue(word: string): { value: number; kind: "unit" | "mult" } | null {
  const w = word.toLowerCase().normalize("NFC");
  if (own(EN_NUMBER_WORDS, w)) return { value: EN_NUMBER_WORDS[w]!, kind: "unit" };
  if (own(HI_NUMBER_WORDS, w)) return { value: HI_NUMBER_WORDS[w]!, kind: "unit" };
  if (own(HI_FRACTION_WORDS, w)) return { value: HI_FRACTION_WORDS[w]!, kind: "unit" };
  if (own(HI_MODIFIERS, w)) return { value: 0, kind: "unit" };
  if (own(TA_EXACT_WORDS, w)) return { value: TA_EXACT_WORDS[w]!, kind: "unit" };
  if (own(ROMAN_NUMBER_WORDS, w)) return { value: ROMAN_NUMBER_WORDS[w]!, kind: "unit" };
  for (const [stem, v] of TA_COLLOQUIAL_STEMS) if (w.startsWith(stem)) return { value: v, kind: "unit" };
  for (const [re, v] of MULT_RES) {
    const m = re.exec(w);
    if (m && m[0].trim().length === w.length) return { value: v, kind: "mult" };
  }
  for (const [stem, v] of TA_NUMBER_STEMS) if (TA_EXACT.has(stem) ? w === stem : w.startsWith(stem)) return { value: v, kind: "unit" };
  for (const [re, v] of MULT_RES) if (re.test(w)) return { value: v, kind: "mult" };
  return null;
}

/** Replaces runs of number words with digits ("twenty five" -> 25, "दो लाख" -> 200000). */
export function wordsToDigits(text: string): string {
  const words = [...text.matchAll(/[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu)];
  const out: string[] = [];
  let cursor = 0;
  let i = 0;
  while (i < words.length) {
    const first = words[i]!;
    const parts = first[0].split("-");
    const firstVal = parts.every((p) => numberWordValue(p) !== null) ? parts.map((p) => numberWordValue(p)!) : null;
    if (!firstVal) {
      i++;
      continue;
    }
    // Extend the run across whitespace, hyphens and "and".
    let j = i;
    let vals = [...firstVal];
    let end = first.index! + first[0].length;
    while (j + 1 < words.length) {
      const next = words[j + 1]!;
      const gap = text.slice(end, next.index);
      if (!/^[\s-]*$/u.test(gap)) break;
      if (next[0].toLowerCase() === "and" && j + 2 < words.length) {
        const after = words[j + 2]!;
        const ap = after[0].split("-").map(numberWordValue);
        if (ap.every((x) => x !== null) && /^[\s-]*$/u.test(text.slice(next.index! + next[0].length, after.index))) {
          vals = [...vals, ...(ap as { value: number; kind: "unit" | "mult" }[])];
          end = after.index! + after[0].length;
          j += 2;
          continue;
        }
        break;
      }
      const np = next[0].split("-").map(numberWordValue);
      if (!np.every((x) => x !== null)) break;
      vals = [...vals, ...(np as { value: number; kind: "unit" | "mult" }[])];
      end = next.index! + next[0].length;
      j++;
    }
    const single = j === i && parts.length === 1;
    // A lone multiplier word ("lakh") is left for the digit pass; ambiguous single words need a unit next.
    // A run containing a romanised Hindi/Tamil word ("do", "oru", "teen") also needs a unit or multiplier next.
    const onlyMult = vals.every((v) => v.kind === "mult");
    const runWords = text.slice(first.index, end).toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}]+/u).filter(Boolean);
    const romanised = runWords.some((w) => own(ROMAN_NUMBER_WORDS, w));
    const ambiguous = (single && AMBIGUOUS_NUMBER_WORDS.has(first[0].toLowerCase().normalize("NFC"))) || romanised;
    const rest = text.slice(end);
    const articled = onlyMult && /(?:^|[^\p{L}\p{M}])(?:a|an)\s+$/iu.test(text.slice(0, first.index));
    if ((onlyMult && !articled) || (ambiguous && !ANY_UNIT_RE.test(rest) && !ANY_MULT_RE.test(rest))) {
      i = j + 1;
      continue;
    }
    // Hindi modifiers: सवा X = X + 0.25, साढ़े X = X + 0.5, पौने X = X - 0.25; alone सवा = 1.25, पौने = 0.75.
    const firstWord = first[0].toLowerCase().normalize("NFC");
    if (own(HI_MODIFIERS, firstWord)) {
      if (vals.length > 1 && vals[1]!.kind === "unit") vals = [{ value: vals[1]!.value + HI_MODIFIERS[firstWord]!, kind: "unit" }, ...vals.slice(2)];
      else if (own(HI_FRACTION_WORDS, firstWord)) vals = [{ value: HI_FRACTION_WORDS[firstWord]!, kind: "unit" }, ...vals.slice(1)];
      else {
        i = j + 1;
        continue;
      }
    }
    let total = 0;
    let current = 0;
    for (const v of vals) {
      if (v.kind === "unit") current += v.value;
      else if (v.value === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * v.value;
        current = 0;
      }
    }
    const value = articled ? vals.reduce((p, v) => p * v.value, 1) : total + current;
    out.push(text.slice(cursor, first.index), ` ${value} `);
    cursor = end;
    i = j + 1;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/**
 * Sentinel value for vague quantities ("a few bags", "several litres"): counted as a number that needs a
 * reference, but it never equals a real stored value.
 */
export const VAGUE_QUANTITY = "0.000000271828";
const EN_QTY_UNIT =
  "(?:kilo(?:gram(?:me)?)?s?|kgs?|lit(?:re|er)s?|ltrs?|millilit(?:re|er)s?|mls?|grams?|quintals?|qtls?|tonnes?|tons?|acres?|hectares?|bags?|packets?|bottles?|sachets?|(?:tea|table)?spoon(?:ful)?s?|caps?|capfuls?|handfuls?|tanks?|tankfuls?|drums?|buckets?|pumps?|kattas?|dozens?|ekad|ekar)\\b";
/**
 * English indefinite and fractional quantities as digits (F8): "a kilo" -> 1 kilo, "half a litre" -> 0.5
 * litre, "a couple of kilos" -> 2 kilos, "a quarter litre" -> 0.25 litre, "a few bags" -> vague. "a/an"
 * used as a rate after a quantity ("₹2050 a quintal", "20 ml a litre") is left alone.
 */
export function englishQuantityPhrases(t: string): string {
  return t
    .replace(/\b(?:a|an)\s+(?:couple|pair)\s+(?:of\s+)?/giu, " 2 ")
    .replace(new RegExp(`\\b(?:(?:a|an)\\s+)?(?:few|several|some|many)\\s+(?:(?:more|of|of\\s+the)\\s+)?(?=${EN_QTY_UNIT})`, "giu"), ` ${VAGUE_QUANTITY} `)
    .replace(/(?<!\b(?:first|second|other|latter|in)\s+)\bhalf[\s-]+(?:(?:a|an)\s+)?/giu, " 0.5 ")
    .replace(/\b(?:(?:a|an|one)\s+)?quarter[\s-]+(?:of\s+)?(?:(?:a|an)\s+)?(?=\S)/giu, (m, off: number, all: string) => (/^(?:a|an|one)\s/i.test(m) || /(?:of|a|an)\s+$/i.test(m) || new RegExp(`^${EN_QTY_UNIT}`, "iu").test(all.slice(off + m.length)) ? " 0.25 " : m))
    .replace(new RegExp(`\\b(?:a|an)\\s+(?=${EN_QTY_UNIT})`, "giu"), (m, off: number, all: string) => (/\d[\d,.]*\s*(?:[\p{L}₹%/.]+\s*){0,2}$/u.test(all.slice(Math.max(0, off - 30), off)) ? m : " 1 "));
}

export interface NumberToken {
  value: Decimal;
  start: number;
  end: number;
  /** Up to 24 characters before the number, cut at the previous number. */
  prefix: string;
  /** Up to 40 characters after the number (and any multiplier), cut at the next number. */
  suffix: string;
  multiplied: boolean;
}

export interface NormalisedText {
  text: string;
  tokens: NumberToken[];
}

/** The normalisation pipeline; `englishDates` strips month-name dates, clock times and list ordinals. */
export function normaliseForChecks(input: string, o: { englishDates: boolean }): string {
  let t = normalizeDigits(input.normalize("NFC"));
  t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ");
  if (o.englishDates) {
    t = stripDates(t);
    t = t.replace(/(^|\n)\s*\d{1,2}[.)]\s/g, "$1 ");
  }
  t = t.replace(/(?<![\p{L}\p{M}])m3(?![\p{L}\p{M}\p{N}])/gu, "m³");
  t = englishQuantityPhrases(t);
  t = wordsToDigits(t);
  // Digits glued to letters ("Rs500", "500kg", "INR2,000") are separated so they are always counted.
  t = t.replace(/([\p{L}\p{M}])(?=\d)/gu, "$1 ").replace(/(\d)(?=[\p{L}\p{M}])/gu, "$1 ");
  return t;
}

export function tokenize(t: string): NumberToken[] {
  const raw: { value: Decimal; start: number; end: number; multiplied: boolean }[] = [];
  for (const m of t.matchAll(/(?<![\p{N}.])-?\d[\d,]*(?:\.\d+)?/gu)) {
    let cleaned = m[0].replace(/,+$/, "").replace(/,/g, "");
    if (cleaned.startsWith("-") && m.index! > 0 && /[\p{N}\p{L}\p{M}]/u.test(t[m.index! - 1]!)) cleaned = cleaned.slice(1);
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) continue;
    let value = new Decimal(cleaned);
    let end = m.index! + m[0].replace(/,+$/, "").length;
    let multiplied = false;
    for (const [re, mult] of MULT_RES) {
      const mm = re.exec(t.slice(end));
      if (mm) {
        value = value.times(mult);
        end += mm[0].length;
        multiplied = true;
        break;
      }
    }
    raw.push({ value, start: m.index!, end, multiplied });
  }
  return raw.map((r, i) => {
    const prevEnd = i > 0 ? raw[i - 1]!.end : 0;
    const nextStart = i + 1 < raw.length ? raw[i + 1]!.start : t.length;
    return { ...r, prefix: t.slice(Math.max(prevEnd, r.start - 24), r.start), suffix: t.slice(r.end, Math.min(nextStart, r.end + 40)) };
  });
}

export function numberTokens(input: string, o: { englishDates: boolean }): NormalisedText {
  const text = normaliseForChecks(input, o);
  return { text, tokens: tokenize(text) };
}

/** Back-compatible helper: all numbers in prose as decimals (English date handling). */
export function proseNumbers(text: string): Decimal[] {
  return numberTokens(text, { englishDates: true }).tokens.map((t) => t.value);
}

// ------------------------------------------------------------------ unit adjacency
const startRe = (src: string) => new RegExp(`^[\\s(:-]*${src}`, "iu");
const endRe = (src: string) => new RegExp(`${src}[\\s.]*$`, "iu");
const UNIT_START: Record<string, RegExp> = Object.fromEntries(Object.entries(UNIT_TERMS).map(([k, v]) => [k, startRe(termSource(v))]));
const CUR_PREFIX_END = endRe(termSource(CURRENCY_PREFIX));
const CUR_WORD_START = startRe(termSource(CURRENCY_WORD));
const within = (key: string) => new RegExp(termSource(UNIT_TERMS[key]!), "iu");

/** Canonical unit stated directly next to the number, or null. Currency counts as "INR". */
export function unitAt(tok: NumberToken): string | null {
  if (CUR_PREFIX_END.test(tok.prefix) || CUR_WORD_START.test(tok.suffix)) return "INR";
  // Longer unit names first so "mm" wins over "m" and "kg" over "g".
  for (const k of ["mm", "ml", "cm", "m3", "kg", "quintal", "acre", "ha", "days", "weeks", "months", "celsius", "percent", "spoon", "L", "g", "t", "m"]) {
    if (UNIT_START[k]!.test(tok.suffix)) return k;
  }
  return null;
}

/** The next word after the number (lower-cased), used as context when no unit is recognised. */
export function contextWord(tok: NumberToken): string | null {
  const m = /^\s*([\p{L}\p{M}]+)/u.exec(tok.suffix);
  return m ? m[1]!.toLowerCase() : null;
}

/** True when the presentation unit of a numeric reference is stated next to the number. */
export function unitAdjacent(tok: NumberToken, unit: string): boolean {
  const around = `${tok.prefix} ${tok.suffix}`;
  switch (unit) {
    case "INR":
      return unitAt(tok) === "INR";
    case "INR/kg":
    case "INR/quintal":
    case "INR/ha":
      return unitAt(tok) === "INR" && within(unit.slice(4)).test(around);
    case "kg/ha":
    case "kg/acre":
      return UNIT_START.kg!.test(tok.suffix) && within(unit.slice(3)).test(around);
    default:
      return UNIT_START[unit] ? UNIT_START[unit]!.test(tok.suffix) && unitAt(tok) === unit : new RegExp(`^\\s*${unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`, "iu").test(tok.suffix);
  }
}
