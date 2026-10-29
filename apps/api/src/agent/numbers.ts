import { Decimal } from "@harvest/domain";
import {
  AMBIGUOUS_NUMBER_WORDS,
  CURRENCY_PREFIX,
  CURRENCY_WORD,
  EN_NUMBER_WORDS,
  HI_FRACTION_WORDS,
  HI_MODIFIERS,
  HI_NUMBER_WORDS,
  INDIC_SCRIPT,
  LONE_MAGNITUDE_EXCLUDE,
  MULTIPLIERS,
  NATIVE_NUMBER_IDIOMS,
  ROMAN_NUMBER_WORDS,
  TA_COMBINING,
  TA_EXACT_WORDS,
  TA_FULL,
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

/**
 * F13 (review R4 #1): compatibility normalisation before digit handling. NFKC maps full-width, superscript,
 * subscript, circled and mathematical-alphanumeric digits to ASCII and vulgar fractions to "1⁄2" (U+2044
 * FRACTION SLASH), which is then folded into a decimal ("½" -> 0.5). NFKC is a superset of NFC, so Devanagari
 * and Tamil text is unchanged by it.
 */
export function compatNormalise(s: string): string {
  return normalizeDigits(s.normalize("NFKC")).replace(/(\d+)\s*\u2044\s*(\d+)/gu, (m, a: string, b: string) => (/^0+$/.test(b) ? ` ${a} ${b} ` : ` ${new Decimal(a).div(b).toSignificantDigits(6).toString()} `));
}

/**
 * F13: a numeric character that is still not an ASCII digit after compatibility normalisation (Thai, Myanmar,
 * Tibetan, Tamil ௰/௱/௲, Roman-numeral or other numeric symbols ...). The gate fails closed on these.
 */
export function unsupportedNumberChar(text: string): string | null {
  // Each numeric character must normalise to ASCII digits (a vulgar fraction to a decimal). Characters that NFKC
  // maps to letters or ideographs (Roman numerals Ⅻ -> "XII", ㊁ -> "二") are unsupported, as is anything left over.
  for (const m of text.normalize("NFC").matchAll(/\p{N}/gu)) if (!/^[\s0-9.]+$/u.test(compatNormalise(m[0]))) return m[0];
  const rest = /(?![0-9])\p{N}|\u2044/u.exec(compatNormalise(text));
  return rest ? rest[0] : null;
}

const ROMAN_VALID = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u;
/** A unit, currency word or multiplier right after, or a currency mark right before. */
const quantityAdjacent = (before: string, after: string) => ANY_UNIT_RE.test(after) || ANY_MULT_RE.test(after) || CUR_PREFIX_END.test(before);

/**
 * F14 (review R5 #1-#3): number-like words the gate cannot read, so it fails closed (`unsupported_number`):
 * - a Tamil word that starts like a compound numeral but has letters left that are not a numeral or case ending;
 * - an ASCII Roman numeral (XX, XV, IV ...) used as a quantity: next to a unit, currency or multiplier word
 *   (a Roman-looking unit right after digits, "200 L tank", is a unit, not a numeral);
 * - letter homoglyphs for digits (lOOO, lO, 5OO): a token of l/I/O/o and digits that mixes letters with digits,
 *   or is all l/I/O/o letters of length >= 2, next to a unit, currency or multiplier ("lo" alone is a word).
 * Returns the offending word or null.
 */
export function unsupportedNumberWord(text: string): string | null {
  const t = compatNormalise(text).normalize("NFC");
  for (const m of t.matchAll(/[\p{L}\p{M}]+/gu)) if (tamilNumberValue(m[0]) === "unsupported") return m[0];
  for (const m of t.matchAll(/(?<![\p{L}\p{M}\p{N}_°'’])[IVXLCDM]{1,7}(?![\p{L}\p{M}\p{N}_'’])/gu)) {
    if (!ROMAN_VALID.test(m[0])) continue;
    const before = t.slice(0, m.index);
    if (/\d[\d,.]*\s*$/u.test(before)) continue;
    if (quantityAdjacent(before, t.slice(m.index! + m[0].length))) return m[0];
  }
  // F16 (review R6 F-4): lowercase Roman numerals (xx, iv, xxv) used as a quantity, unless the word is itself a unit.
  for (const m of t.matchAll(/(?<![\p{L}\p{M}\p{N}_°'’])[ivxlcdm]{1,7}(?![\p{L}\p{M}\p{N}_'’])/gu)) {
    if (!ROMAN_VALID.test(m[0].toUpperCase()) || SHORT_WORD_OK.has(m[0]) || ownQuantityWord(t.slice(m.index!), m[0])) continue;
    const before = t.slice(0, m.index);
    if (/\d[\d,.]*\s*$/u.test(before)) continue;
    if (quantityAdjacent(before, t.slice(m.index! + m[0].length))) return m[0];
  }
  // F16: B/S/Z/G join l/I/O/o as letter-for-digit homoglyphs (Rs BOO, S00, Z0).
  for (const m of t.matchAll(/(?<![\p{L}\p{M}\p{N}_])[lIOoBSZG0-9](?:[lIOoBSZG0-9]|[,.](?=[lIOoBSZG0-9]))*(?![\p{L}\p{M}\p{N}_])/gu)) {
    const letters = m[0].replace(/[^lIOoBSZG]/g, "").length;
    const digits = m[0].replace(/[^0-9]/g, "").length;
    if (letters === 0 || (digits === 0 && letters < 2)) continue;
    if (quantityAdjacent(t.slice(0, m.index), t.slice(m.index! + m[0].length))) return m[0];
  }
  // F16 (review R6 F-4): a single capital letter or an all-letter word of at most 3 letters right after a currency mark
  // or right before a mass/volume/area/currency unit stands where a number should be ("Harvest about B kg"). Real unit
  // abbreviations, function words and number words (converted to digits later and checked there) are allowed.
  for (const m of t.matchAll(/(?<![\p{L}\p{M}\p{N}_'’])[A-Za-z]{1,3}(?![\p{L}\p{M}\p{N}_'’])/gu)) {
    const w = m[0];
    const lw = w.toLowerCase();
    if (SHORT_WORD_OK.has(lw) || own(EN_NUMBER_WORDS, lw) || own(ROMAN_NUMBER_WORDS, lw) || ownQuantityWord(t.slice(m.index!), w)) continue;
    const before = t.slice(0, m.index);
    if (/\d[\d,.]*\s*$/u.test(before)) continue; // "200 L tank": a unit after digits
    if (CUR_PREFIX_END.test(before) || SHORT_QTY_UNIT_RE.test(t.slice(m.index! + w.length))) return w;
  }
  return null;
}

/**
 * F16: words allowed right before a unit or right after a currency mark: real unit abbreviations and short function
 * words ("a kg of seed" is read by the quantity-word rule; "the kg figure", "per kg", "in kg"). Reviewed allowlist.
 */
const SHORT_WORD_OK = new Set(["kg", "kgs", "mm", "ha", "cm", "ml", "l", "g", "t", "m", "per", "a", "an", "of", "the", "in", "to", "or", "and", "by", "at", "on", "for", "its", "our", "my", "few", "any", "all", "no", "not", "how", "net", "is", "are", "was", "as", "be", "rs", "inr", "qtl", "har", "ke", "ki", "ka", "se", "me", "pe"]);
/** Units for the short-word rule: mass, volume, area, length and currency (not days/weeks/months/%/°C, which follow ordinary words). */
const SHORT_QTY_UNIT_RE = new RegExp(`^\\s*(?:${Object.entries(UNIT_TERMS).filter(([k]) => !["days", "weeks", "months", "celsius", "percent"].includes(k)).map(([, v]) => termSource(v)).join("|")}|${termSource(CURRENCY_WORD)})`, "iu");
/** The word is itself a unit, currency or multiplier word ("mm", "cc", "Rs"). */
function ownQuantityWord(self: string, word: string): boolean {
  return [ANY_UNIT_RE.exec(self), ANY_MULT_RE.exec(self), CUR_PREFIX_START.exec(self)].some((x) => x !== null && x[0].trim().length >= word.length);
}

/**
 * F14 (review R5 #4): words a hi/ta turn may put before a unit or multiplier without stating a number (articles,
 * prepositions, possessives, Hindi/Tamil postpositions in Latin script). Any OTHER Latin word right before a unit
 * or multiplier is read as an unlisted romanised number word ("ikkees kilo", "pachchees bigha") and needs a
 * reference. The list is a reviewed allowlist, not a number lexicon.
 */
const LATIN_BEFORE_UNIT_OK = new Set([
  "per", "each", "every", "the", "a", "an", "of", "in", "on", "with",
  "and", "or", "to", "for", "from", "by", "at", "your", "my", "our", "their", "this", "that", "these", "those",
  "har", "prati", "ke", "ki", "ka", "se", "mein", "me", "par", "pe", "aapke", "aapki", "aapka", "apne", "apni", "apna",
]);
/** First Latin word that stands where a number should be (before a unit/multiplier) in hi/ta-turn text, or null. */
export function latinWordBeforeQuantity(normText: string): string | null {
  for (const m of normText.matchAll(/(?<![\p{L}\p{M}\p{N}_])[A-Za-z]+(?![\p{L}\p{M}\p{N}_])/gu)) {
    const w = m[0].toLowerCase();
    if (LATIN_BEFORE_UNIT_OK.has(w)) continue;
    const self = normText.slice(m.index!);
    // The word itself is a unit, currency or multiplier word ("kilo per", "rupaye kilo").
    const own = [ANY_UNIT_RE.exec(self), ANY_MULT_RE.exec(self), CUR_PREFIX_START.exec(self)].some((x) => x !== null && x[0].trim().length >= m[0].length);
    if (own) continue;
    const after = normText.slice(m.index! + m[0].length);
    if (!/^\s+\S/u.test(after)) continue;
    if (ANY_UNIT_RE.test(after) || ANY_MULT_RE.test(after)) return m[0];
  }
  return null;
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

// ------------------------------------------------------------------ Tamil compound numerals (F14)
/** Tamil vowel sign -> independent vowel (sandhi: இருபத் + ஐந்து is written இருபத்தைந்து). */
const TA_SIGN: Record<string, string> = { "\u0BBE": "ஆ", "\u0BBF": "இ", "\u0BC0": "ஈ", "\u0BC1": "உ", "\u0BC2": "ஊ", "\u0BC6": "எ", "\u0BC7": "ஏ", "\u0BC8": "ஐ", "\u0BCA": "ஒ", "\u0BCB": "ஓ", "\u0BCC": "ஔ" };
const TA_CONSONANT = /^[\u0B95-\u0BB9]$/u;
/** Case endings accepted after a numeral that is already part of a compound (remainder after the final consonant). */
const TA_CASE_IN_COMPOUND = new Set(["ு", "ி", "ை", "ில்", "ிலும்", "ின்", "ிற்கு", "ால்", "ாக", "ாவது", "ாம்", "ும்", "ுக்கு", "ுக்கும்", "ுடன்", "ோடு"].map((x) => x.normalize("NFC")));
/** Fraction suffixes after a numeral's final consonant: இரண்டரை 2.5, இரண்டேகால் 2.25, இரண்டேமுக்கால் 2.75. */
const TA_FRACTION: [string, number][] = [["ரை", 0.5], ["ேகால்", 0.25], ["ேமுக்கால்", 0.75]];
/** Thousand sandhi heads with an irregular first part (ஓராயிரம் 1000, ஈராயிரம், மூவாயிரம், ஐயாயிரம்). */
const TA_THOUSAND_LEFT: Record<string, number> = { "ஓர": 1, "ஈர": 2, "மூவ": 3, "ஐய": 5 };
const TA_FULL_SORTED = [...TA_FULL].sort((a, b) => b.form.length - a.form.length);
const TA_COMBINING_SORTED = [...TA_COMBINING].sort((a, b) => b.stem.length - a.stem.length);
type TaValue = number | null | "unsupported";

/**
 * The text after a combining stem's virama (it starts with the repeated consonant x). `inCompound` values must
 * stay below `place`. Returns the added value, or "unsupported" when letters remain that are not a numeral or a
 * case ending (fail closed: the reviewer's இருபத்தைந்து must never read as 20).
 */
function taContinuation(r: string, x: string, place: number): TaValue {
  if (!r.startsWith(x)) return "unsupported";
  const r2 = r.slice(x.length);
  if (r2 === "" || TA_CASE_IN_COMPOUND.has(r2)) return 0;
  const readings: string[] = [];
  // Vowel sandhi: இருபத் + இரண்டு -> இருபத்திரண்டு, + ஐந்து -> இருபத்தைந்து.
  if (TA_SIGN[r2[0]!]) readings.push(TA_SIGN[r2[0]!]! + r2.slice(1));
  else if (TA_CONSONANT.test(r2[0]!)) readings.push("அ" + r2); // inherent vowel: நூற் + அறுபது -> நூற்றறுபது
  if (r2.startsWith("ு") || r2.startsWith("ி")) {
    // Linking vowel before a consonant-initial numeral (இருபத்துமூன்று); gemination before a hard consonant: நூற்றுப்பத்து.
    let next = r2.slice(1);
    if (next.length >= 3 && next[1] === "்" && next[0] === next[2]) next = next.slice(2);
    readings.push(next);
  }
  for (const next of readings) {
    const sub = taValue(next, place, true);
    if (typeof sub === "number") return sub;
  }
  return "unsupported";
}

/**
 * Value of one Tamil word as a numeral. null = not a numeral; "unsupported" = it starts like a compound numeral
 * but the rest cannot be read (fail closed). `below` bounds a numeral inside a compound; `strict` (inside a
 * compound) rejects unknown endings instead of ignoring them.
 */
function taValue(w: string, below = Infinity, strict = false): TaValue {
  // Thousand sandhi: இருபத்தைந்தாயிரம் = இருபத்தைந்து x 1000, ஐயாயிரம் = 5000, then an optional combining tail.
  const ti = w.indexOf("ாயிர");
  if (!strict && ti > 0 && !w.startsWith("தொள்ளாயிர")) {
    const leftRaw = w.slice(0, ti);
    const left = TA_THOUSAND_LEFT[leftRaw] ?? taValue(`${leftRaw}ு`, 1000, true);
    if (typeof left !== "number") return left === null ? null : "unsupported";
    const tail = w.slice(ti + 4);
    if (tail === "ம்" || tail === "ம" || tail === "") return left * 1000;
    if (!tail.startsWith("த்")) return "unsupported";
    const add = taContinuation(tail.slice(2), "த", 1000);
    return typeof add === "number" ? left * 1000 + add : "unsupported";
  }
  for (const c of TA_COMBINING_SORTED) {
    if (!w.startsWith(c.stem)) continue;
    if (c.value >= below) return "unsupported";
    const x = c.stem.slice(-2, -1);
    const add = taContinuation(w.slice(c.stem.length), x, c.place);
    // A standalone hundred/thousand word (நூற்று, ஆயிரத்து) is left to the multiplier pass.
    if (add === 0 && !strict && (c.value === 100 || c.value === 1000)) return null;
    return typeof add === "number" ? c.value + add : "unsupported";
  }
  for (const f of TA_FULL_SORTED) {
    const base = f.form.endsWith("ு") ? f.form.slice(0, -1) : f.form;
    if (!w.startsWith(base)) continue;
    if (f.value >= below) continue;
    const r = w.slice(base.length);
    if (w === f.form) return f.value;
    for (const [suffix, add] of TA_FRACTION) if (r === suffix) return f.value + add;
    if (strict) {
      if (TA_CASE_IN_COMPOUND.has(r) || (f.form.endsWith("ு") && r.startsWith("ு") && TA_CASE_IN_COMPOUND.has(r.slice(1)))) return f.value;
      continue;
    }
    if (f.exact || !f.form.endsWith("ு") || !r.startsWith("ு")) continue;
    // A full form followed by a case ending (இருபதுக்கு) keeps its value; a glued lakh/crore scales it.
    if (r.startsWith("ுலட்ச")) return f.value * 100000;
    if (r.startsWith("ுகோடி")) return f.value * 10000000;
    return f.value;
  }
  return strict ? "unsupported" : null;
}

/** F14: Tamil numeral value of a word (exported for tests). */
export function tamilNumberValue(word: string): TaValue {
  const w = word.normalize("NFC");
  return /\p{Script=Tamil}/u.test(w) ? taValue(w) : null;
}

const own = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function numberWordValue(word: string): { value: number; kind: "unit" | "mult"; unsupported?: boolean } | null {
  const w = word.toLowerCase().normalize("NFC");
  if (own(EN_NUMBER_WORDS, w)) return { value: EN_NUMBER_WORDS[w]!, kind: "unit" };
  if (own(HI_NUMBER_WORDS, w)) return { value: HI_NUMBER_WORDS[w]!, kind: "unit" };
  if (own(HI_FRACTION_WORDS, w)) return { value: HI_FRACTION_WORDS[w]!, kind: "unit" };
  if (own(HI_MODIFIERS, w)) return { value: 0, kind: "unit" };
  if (own(TA_EXACT_WORDS, w)) return { value: TA_EXACT_WORDS[w]!, kind: "unit" };
  if (own(ROMAN_NUMBER_WORDS, w)) return { value: ROMAN_NUMBER_WORDS[w]!, kind: "unit" };
  for (const [re, v] of MULT_RES) {
    const m = re.exec(w);
    if (m && m[0].trim().length === w.length) return { value: v, kind: "mult" };
  }
  const ta = tamilNumberValue(w);
  if (ta === "unsupported") return { value: 0, kind: "unit", unsupported: true };
  if (ta !== null) return { value: ta, kind: "unit" };
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
          vals = [...vals, ...(ap as NonNullable<ReturnType<typeof numberWordValue>>[])];
          end = after.index! + after[0].length;
          j += 2;
          continue;
        }
        break;
      }
      const np = next[0].split("-").map(numberWordValue);
      if (!np.every((x) => x !== null)) break;
      vals = [...vals, ...(np as NonNullable<ReturnType<typeof numberWordValue>>[])];
      end = next.index! + next[0].length;
      j++;
    }
    const single = j === i && parts.length === 1;
    // A lone multiplier word ("lakh") is left for the digit pass; ambiguous single words need a unit next.
    // A run containing a romanised Hindi/Tamil word ("do", "oru", "teen") also needs a unit or multiplier next.
    const onlyMult = vals.every((v) => v.kind === "mult");
    const runWords = text.slice(first.index, end).toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}]+/u).filter(Boolean);
    const romanised = runWords.some((w) => own(ROMAN_NUMBER_WORDS, w));
    const firstNorm = first[0].toLowerCase().normalize("NFC");
    // F13: Devanagari/Tamil number words always count, except for the documented idioms (lexicon.ts).
    const indicWord = INDIC_SCRIPT.test(first[0]);
    const rest = text.slice(end);
    const idiom = single && indicWord && NATIVE_NUMBER_IDIOMS.some(([w, r]) => w === firstNorm && new RegExp(r, "u").test(rest));
    const ambiguous = (single && !indicWord && AMBIGUOUS_NUMBER_WORDS.has(firstNorm)) || romanised;
    const articled = onlyMult && /(?:^|[^\p{L}\p{M}])(?:a|an)\s+$/iu.test(text.slice(0, first.index));
    if (onlyMult && !articled) {
      // A multiplier after digits ("2.5 lakh") is folded by the digit pass. F13: a lone magnitude word ("earn
      // lakhs", "हज़ारों", "லட்சங்கள்") is a vague quantity that needs a reference.
      const afterDigits = /\d[\d,.]*\s*$/u.test(text.slice(0, first.index));
      if (!afterDigits && !runWords.every((w) => LONE_MAGNITUDE_EXCLUDE.has(w))) out.push(text.slice(cursor, first.index), ` ${VAGUE_QUANTITY} `), (cursor = end);
      i = j + 1;
      continue;
    }
    // F14: "two options/choices/ways" (English) counts alternatives, not a quantity, unless a unit/currency/multiplier follows.
    const choice = single && !indicWord && (firstNorm === "two" || firstNorm === "three") && /^\s+(?:options?|choices?|ways?)(?![\p{L}\p{M}\p{N}])/u.exec(rest);
    const alternatives = choice ? !ANY_UNIT_RE.test(rest.slice(choice[0].length)) && !ANY_MULT_RE.test(rest.slice(choice[0].length)) : false;
    if (idiom || alternatives || (ambiguous && !ANY_UNIT_RE.test(rest) && !ANY_MULT_RE.test(rest))) {
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
    // F14: a Tamil word that starts like a compound numeral but cannot be read is a number that needs a reference.
    if (vals.some((v) => v.unsupported)) {
      out.push(text.slice(cursor, first.index), ` ${VAGUE_QUANTITY} `);
      cursor = end;
      i = j + 1;
      continue;
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
  let t = compatNormalise(input);
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
const CUR_PREFIX_START = new RegExp(`^${termSource(CURRENCY_PREFIX)}`, "iu");
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
