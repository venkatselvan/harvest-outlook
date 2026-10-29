/**
 * Server-owned word lists for the output gate (English, Hindi, Tamil). These are deliberately small,
 * conservative lexicons for rule checks, not a language model: every list has gaps and spelling
 * variants that are not covered. The gate therefore fails closed for Hindi and Tamil text (see
 * gate.ts): numbers and lexicon hits there need a matching reference or the text is withheld.
 *
 * Matching conventions (all text is NFC-normalised first):
 * - English fragments are regex sources matched as whole words (letters, combining marks and digits
 *   are word characters, so `\b` ASCII semantics never apply to Indic text).
 * - Hindi/Tamil terms are literal strings matched at the START of a word only (suffixes such as Tamil
 *   case endings may follow). A term ending in "$" must match the whole word.
 */

export const WORD_L = "(?<![\\p{L}\\p{M}\\p{N}_])";
export const WORD_R = "(?![\\p{L}\\p{M}\\p{N}_])";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface TermList {
  /** English regex fragments, matched as whole words. */
  en?: string[];
  /** Hindi/Tamil literal terms (start-of-word match; trailing "$" = whole word). */
  indic?: string[];
  /** Raw regex fragments with no boundary handling (symbols such as ₹ or %). */
  raw?: string[];
}

/** Regex source for a term list (a non-capturing alternation). */
export function termSource(t: TermList): string {
  const parts: string[] = [];
  for (const r of t.raw ?? []) parts.push(`(?:${r})`);
  for (const e of t.en ?? []) parts.push(`${WORD_L}(?:${e})${WORD_R}`);
  const indic = [...(t.indic ?? [])].map((x) => x.normalize("NFC")).sort((a, b) => b.length - a.length);
  for (const term of indic) parts.push(term.endsWith("$") ? `${WORD_L}${esc(term.slice(0, -1))}${WORD_R}` : `${WORD_L}${esc(term)}`);
  return parts.length ? `(?:${parts.join("|")})` : "(?!)";
}

export const termRe = (t: TermList, flags = "iu") => new RegExp(termSource(t), flags);
export const merge = (...lists: TermList[]): TermList => ({ en: lists.flatMap((l) => l.en ?? []), indic: lists.flatMap((l) => l.indic ?? []), raw: lists.flatMap((l) => l.raw ?? []) });

// ------------------------------------------------------------------ units
/** Canonical unit keys: the contract Unit values plus dosage-only measures (ml, spoon...). */
export const UNIT_TERMS: Record<string, TermList> = {
  mm: { en: ["mm", "millimet(?:re|er)s?"], indic: ["मिमी", "मि.मी.", "मिलीमीटर", "मिलिमीटर", "மிமீ", "மி.மீ", "மில்லிமீட்டர்", "மில்லி மீட்டர்"] },
  ml: { en: ["ml", "mls", "millilit(?:re|er)s?", "cc"], indic: ["मिलीलीटर", "मिलिलीटर", "मिली$", "मि.ली.", "மில்லிலிட்டர்", "மில்லி லிட்டர்", "மில்லி", "மி.லி"] },
  L: { en: ["l", "ltrs?", "lit(?:re|er)s?", "leeta?rs?"], indic: ["लीटर", "लिटर", "லிட்டர", "லிட்டர்"] },
  g: { en: ["g", "gms?", "grams?", "grammes?"], indic: ["ग्राम", "கிராம்"] },
  kg: { en: ["kg", "kgs", "kilos?", "kilograms?", "kilogrammes?", "killa"], indic: ["किलोग्राम", "किलो", "कि.ग्रा.", "கிலோகிராம்", "கிலோ"] },
  quintal: { en: ["quintals?", "qtls?"], indic: ["क्विंटल", "कुंटल", "குவிண்டால", "குவின்டால"] },
  t: { en: ["t", "tonnes?", "tons?", "mt"], indic: ["टन$", "டன்"] },
  acre: { en: ["acres?", "ac", "ekad", "ekar", "ekkar", "eker"], indic: ["एकड़", "एकड", "ஏக்கர"] },
  ha: { en: ["ha", "hectares?", "hectors?"], indic: ["हेक्टेयर", "हेक्टेअर", "ஹெக்டேர", "ஹெக்டர"] },
  days: { en: ["days?"], indic: ["दिन", "நாட்கள", "நாள", "நாட்"] },
  weeks: { en: ["weeks?"], indic: ["हफ्ते", "हफ़्ते", "हफ्तों", "सप्ताह", "வாரம்", "வாரங்கள", "வார"] },
  months: { en: ["months?"], indic: ["महीने", "महीना", "महीनों", "माह", "மாதம்", "மாதங்கள", "மாத"] },
  celsius: { raw: ["°\\s?c"], en: ["celsius", "degrees?"], indic: ["डिग्री", "டிகிரி"] },
  percent: { raw: ["%"], en: ["percent", "per\\s?cent"], indic: ["प्रतिशत", "फीसदी", "சதவீத", "சதவிகித"] },
  m: { en: ["m", "met(?:re|er)s?"], indic: ["मीटर", "மீட்டர"] },
  cm: { en: ["cm", "centimet(?:re|er)s?"], indic: ["सेमी", "से.मी.", "सेंटीमीटर", "செமீ", "செ.மீ", "சென்டிமீட்டர"] },
  m3: { raw: ["m³"], en: ["m3", "cubic\\s+met(?:re|er)s?"], indic: ["घन मीटर", "கன மீட்டர"] },
  spoon: {
    en: ["spoons?", "spoonfuls?", "teaspoons?", "tablespoons?", "tsp", "tbsp", "caps?", "capfuls?", "packets?", "sachets?", "bottles?", "bags?", "drops?", "handfuls?",
      // Containers that measure an input amount (F8): "two tanks", "a pump of" ...; romanised Hindi/Tamil too.
      "tanks?", "tankfuls?", "pumps?", "drums?", "buckets?", "knapsacks?", "sprayers?", "kattas?", "bori", "boriyan", "chammach", "tanki", "mootai", "moottai"],
    indic: ["चम्मच", "ढक्कन", "पैकेट", "बोरी", "बोरे", "बूंद", "बूँद", "मुट्ठी", "टंकी", "पंप", "कट्टा", "कट्टे", "ஸ்பூன்", "கரண்டி", "மூடி", "பாக்கெட்", "மூட்டை", "சொட்டு", "கைப்பிடி", "டேங்க", "தொட்டி"],
  },
};

/** Currency marks and words (INR). Prefix forms are checked before a number, word forms after it. */
export const CURRENCY_PREFIX: TermList = { raw: ["₹"], en: ["rs\\.?", "inr"], indic: ["रु.", "रू.", "रु$", "ரூ."] };
export const CURRENCY_WORD: TermList = { en: ["rupees?", "rupaye", "rs\\.?", "inr"], indic: ["रुपये", "रुपए", "रुपया", "रुपयों", "ரூபாய்", "ரூபாய"] };

/** Units that make a dosage quantity (mass or volume of an input). */
export const DOSE_UNITS = ["ml", "L", "g", "kg", "spoon", "quintal", "t"] as const;

/** Rate denominators (per litre / acre / tank ...). */
export const DENOMINATOR: TermList = {
  en: ["lit(?:re|er)s?", "l", "acres?", "ha", "hectares?", "tanks?", "pumps?", "plants?", "bighas?", "sprayers?", "knapsacks?", "drums?", "buckets?", "beds?", "pits?"],
  indic: ["लीटर", "लिटर", "एकड़", "हेक्टेयर", "टंकी", "पंप", "पौध", "बीघा", "லிட்டர", "ஏக்கர", "ஹெக்டேர", "டேங்க", "தொட்டி", "செடி"],
};
export const PER: TermList = { raw: ["/"], en: ["per", "each", "every", "a", "an"], indic: ["प्रति", "हर$", "ஒவ்வொரு", "ஒரு$"] };
/** Hindi/Tamil rate markers anywhere in a sentence (Tamil marks "per X" with the dative -க்கு). */
export const INDIC_RATE_MARK: TermList = { raw: ["க்கு"], indic: ["प्रति", "हर$", "ஒவ்வொரு", "ஒரு$"] };

// ------------------------------------------------------------------ numbers
export const EN_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const HI_LIST = [
  "एक", "दो", "तीन", "चार", "पांच|पाँच", "छह|छः|छे", "सात", "आठ", "नौ", "दस",
  "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह|पन्द्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस", "बीस",
  "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस", "तीस",
  "इकतीस|इकत्तीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस", "चालीस",
  "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस|चौवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास", "पचास",
  "इक्यावन", "बावन", "तिरेपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ", "साठ",
  "इकसठ", "बासठ", "तिरसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर", "सत्तर",
  "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उन्यासी|उनासी", "अस्सी",
  "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अट्ठासी", "नवासी", "नब्बे",
  "इक्यानवे", "बानवे", "तिरानवे", "चौरानवे", "पचानवे", "छियानवे", "सत्तानवे", "अट्ठानवे", "निन्यानवे",
];
export const HI_NUMBER_WORDS: Record<string, number> = Object.fromEntries(HI_LIST.flatMap((w, i) => w.split("|").map((v) => [v.normalize("NFC"), i + 1])));

/** Tamil numerals as word stems (matched at the start of a word because of agglutination). */
export const TA_NUMBER_STEMS: [string, number][] = [
  ["பதினொன்", 11], ["பன்னிரண்", 12], ["பதின்மூன்", 13], ["பதினான்", 14], ["பதினைந்", 15], ["பதினாறு", 16], ["பதினேழு", 17], ["பதினெட்டு", 18], ["பத்தொன்பது", 19],
  ["இருபத்", 20], ["இருபது", 20], ["முப்பத்", 30], ["முப்பது", 30], ["நாற்பத்", 40], ["நாற்பது", 40], ["ஐம்பத்", 50], ["ஐம்பது", 50],
  ["அறுபத்", 60], ["அறுபது", 60], ["எழுபத்", 70], ["எழுபது", 70], ["எண்பத்", 80], ["எண்பது", 80], ["தொண்ணூற்", 90], ["தொண்ணூறு", 90],
  ["இருநூ", 200], ["முந்நூ", 300], ["நானூ", 400], ["ஐந்நூ", 500], ["அறுநூ", 600], ["எழுநூ", 700], ["எண்ணூ", 800], ["தொள்ளாயிர", 900],
  ["ஒன்று", 1], ["இரண்டு", 2], ["மூன்று", 3], ["நான்கு", 4], ["நாலு", 4], ["ஐந்து", 5], ["அஞ்சு", 5], ["ஆறு", 6], ["ஏழு", 7], ["எட்டு", 8], ["ஒன்பது", 9], ["பத்து", 10],
  ["ஒரு", 1],
].map(([s, v]) => [(s as string).normalize("NFC"), v as number] as [string, number]).sort((a, b) => b[0].length - a[0].length);

/**
 * Fractional and colloquial Hindi/Tamil number words (F8). Values are the conventional ones (सवा = 1.25,
 * ढाई = 2.5, அரை = 0.5 ...). Hindi prefix modifiers (सवा/साढ़े/पौने + number) are applied in numbers.ts.
 */
export const HI_FRACTION_WORDS: Record<string, number> = Object.fromEntries(
  ([["सवा", 1.25], ["आधा", 0.5], ["आधी", 0.5], ["आधे", 0.5], ["ढाई", 2.5], ["अढ़ाई", 2.5], ["डेढ़", 1.5], ["डेढ", 1.5], ["पौना", 0.75], ["पौने", 0.75]] as const).map(([w, v]) => [w.normalize("NFC"), v]),
);
/** Hindi modifiers: सवा X = X + 0.25, साढ़े X = X + 0.5, पौने X = X - 0.25 (when another number follows). */
export const HI_MODIFIERS: Record<string, number> = Object.fromEntries(([["सवा", 0.25], ["साढ़े", 0.5], ["साढे", 0.5], ["पौने", -0.25]] as const).map(([w, v]) => [w.normalize("NFC"), v]));
/** Tamil colloquial/fractional words matched as whole words only (அரை, கால் are also ordinary words). */
export const TA_EXACT_WORDS: Record<string, number> = Object.fromEntries(
  ([["அரை", 0.5], ["கால்", 0.25], ["முக்கால்", 0.75], ["ஒன்னு", 1], ["ஒண்ணு", 1]] as const).map(([w, v]) => [w.normalize("NFC"), v]),
);
/** Colloquial Tamil numerals matched as word stems. */
export const TA_COLLOQUIAL_STEMS: [string, number][] = ([["ரெண்டு", 2], ["மூணு", 3], ["நாலு", 4], ["அஞ்சு", 5]] as const).map(([w, v]) => [w.normalize("NFC"), v] as [string, number]);
/**
 * Romanised Hindi/Tamil number words (F8). Many are also English or ordinary words ("do", "teen", "das",
 * "oru"), so every one of them counts as a number only before a unit or multiplier word.
 */
export const ROMAN_NUMBER_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10, bees: 20, pachaas: 50, sau: 100,
  aadha: 0.5, adha: 0.5, aadhi: 0.5, aadhe: 0.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5, sawa: 1.25, sava: 1.25, dedh: 1.5, dedhh: 1.5, pauna: 0.75, paune: 0.75,
  onnu: 1, onru: 1, oru: 1, rendu: 2, randu: 2, irandu: 2, moonu: 3, munu: 3, moondru: 3, naalu: 4, nalu: 4, anju: 5, ainthu: 5, aaru: 6, pathu: 10,
  arai: 0.5, ara: 0.5, kaal: 0.25, mukkaal: 0.75,
};
/** Romanised multipliers (Latin script). */
export const ROMAN_MULTIPLIERS: [TermList, number][] = [
  [{ en: ["hazaa?r", "hajaa?r", "aayiram", "ayiram"] }, 1000],
  [{ en: ["latcham", "latsam", "laksham"] }, 100000],
];

/** Single words that are also ordinary words ("one", "दो" = give, "ஒரு" = a, "ஆறு" = river): numbers only before a unit/multiplier. */
export const AMBIGUOUS_NUMBER_WORDS = new Set(["one", "एक", "दो", "ஒரு", "இரு", "ஆறு", "கால்", ...Object.keys(ROMAN_NUMBER_WORDS)].map((s) => s.normalize("NFC")));

/** Multipliers that scale the preceding number. */
export const MULTIPLIERS: [TermList, number][] = [
  [{ en: ["hundreds?"], indic: ["सौ$", "நூறு", "நூற்று", "நூற"] }, 100],
  [{ en: ["thousands?"], indic: ["हज़ार", "हजार", "ஆயிரம்", "ஆயிரத்", "ஆயிர"] }, 1000],
  [{ en: ["lakhs?", "lacs?", "lac"], indic: ["लाख", "லட்சம்", "லட்சத்", "லட்ச"] }, 100000],
  [{ en: ["millions?"], indic: ["मिलियन"] }, 1000000],
  [{ en: ["crores?"], indic: ["करोड़", "करोड", "கோடி"] }, 10000000],
  [{ en: ["dozens?"], indic: ["दर्जन", "டஜன்"] }, 12],
  ...ROMAN_MULTIPLIERS,
];

// ------------------------------------------------------------------ high-risk vocabularies
export const DOSAGE_VERBS: TermList = {
  en: ["spray(?:ing|ed)?", "apply(?:ing)?", "dose", "dosage", "mix(?:ing)?", "dissolve", "drench(?:ing)?", "dilute", "add(?:ing)?", "sprinkle", "use", "put", "pour", "broadcast", "top[\\s-]?dress(?:ing)?", "inject", "fumigate", "treat"],
  indic: ["छिड़काव", "छिड़कें", "छिड़कना", "छिड़क", "डालें", "डालना", "डालकर", "डाल$", "मिलाएं", "मिलाएँ", "मिलाकर", "मिलाना", "मिलायें", "घोलें", "घोलकर", "प्रयोग करें", "इस्तेमाल करें",
    "தெளிக்", "தெளியுங்கள்", "மிளிக்கவும்", "இடவும்", "இடுங்கள்", "இட்டு", "கலக்கவும்", "கலந்து", "கரைத்து", "ஊற்றவும்", "பயன்படுத்தவும்",
    // Colloquial Tamil (F8): போடுங்க / போடவும் ("put/apply"), தெளிங்க, அடிங்க ("spray").
    "போடுங்க", "போடுங்கள்", "போடவும்", "போட்டு", "தெளிங்க", "அடிங்க", "அடிக்கவும்"],
};
/** Romanised Hindi/Tamil application verbs (Latin script, F8). */
export const ROMAN_DOSAGE_VERBS: TermList = {
  en: ["karo", "karein", "karen", "kariye", "dalo", "daalo", "dalein", "daalein", "daaliye", "dale", "chhidko", "chidko", "chhidkav", "chidkav", "chhidkaav", "milao", "ghol(?:o|ein)?",
    "podunga", "podungal", "podu", "podavum", "theliyunga", "theliungal", "thelikkavum", "thelinga", "thelikanum", "idunga", "idungal", "idavum", "adinga", "adikkanum"],
};
/** Romanised Hindi/Tamil input and chemical nouns (Latin script, F8). */
export const ROMAN_CHEMICAL_NOUNS: TermList = {
  en: ["dawa", "dawai", "dava", "davai", "dawaai", "khaad", "khad", "keetnashak", "marundhu", "marunthu", "marundu", "uram", "yoorea", "yuria", "yuriya", "uriya", "potash", "dap"],
};
export const CHEMICAL_NOUNS: TermList = {
  en: ["dawa", "dawai", "davai", "marundhu", "marunthu", "yoorea", "yuriya", "khaad", "manure", "nitrogen", "npk", "zinc\\s+sulphate", "gypsum", "urea", "dap", "potash", "fertili[sz]ers?", "pesticides?", "fungicides?", "insecticides?", "herbicides?", "weedicides?", "chlorpyrifos", "mancozeb", "carbendazim", "copper\\s+oxychloride", "metalaxyl", "imidacloprid", "bordeaux", "neem\\s+oil", "chemicals?"],
  indic: ["खाद", "डीएपी", "पोटाश", "यूरिया", "दवा", "दवाई", "कीटनाशक", "फफूंदनाशक", "खरपतवारनाशक", "उर्वरक", "रसायन", "யூரியா", "மருந்து", "பூச்சிக்கொல்லி", "பூஞ்சைக்கொல்லி", "உரம்", "ரசாயன"],
};
export const CERTAINTY: TermList = {
  en: ["definitely", "certainly", "surely", "undoubtedly", "clearly", "confirmed", "for\\s+sure", "without\\s+doubt"],
  indic: ["निश्चित", "पक्का", "पक्की", "पक्के", "ज़रूर", "जरूर", "बिल्कुल", "बेशक", "நிச்சயமாக", "நிச்சய", "கண்டிப்பாக", "உறுதியாக"],
};
export const GUARANTEE: TermList = {
  en: ["guarantee[sd]?", "assured", "risk[\\s-]?free", "no\\s+risk", "sure\\s+(?:profit|income|returns?|shot)"],
  indic: ["गारंटी", "गारण्टी", "पक्का मुनाफा", "मुनाफा पक्का", "मुनाफ़ा पक्का", "निश्चित लाभ", "निश्चित मुनाफा", "உத்தரவாத", "நிச்சய லாப", "உறுதியான லாப", "உறுதியான வருமான"],
};
export const MULTIPLY_GAIN: TermList = {
  en: ["double[sd]?", "triple[sd]?", "quadruple[sd]?", "twice", "thrice", "\\d+\\s*(?:x|times|fold)"],
  indic: ["दोगुना", "दोगुनी", "दुगना", "दुगनी", "दुगुना", "तिगुना", "तिगुनी", "गुना", "இரட்டிப்பு", "இருமடங்கு", "மும்மடங்கு", "மடங்கு"],
};
export const MONEY: TermList = {
  en: ["profits?", "income", "returns?", "earn(?:ings?)?", "money", "revenue", "margins?", "rich", "wealthy"],
  indic: ["मुनाफ", "लाभ", "कमाई", "आय$", "आमदनी", "फायदा", "फ़ायदा", "லாப", "வருமான", "வருவாய", "சம்பாத்திய", "சம்பாதி"],
};
export const DISEASE: TermList = {
  en: ["disease", "diseases", "infection", "infected", "blight", "wilt", "rot", "rust", "virus", "viral", "mildew", "fung(?:us|al|i)", "bacterial", "mites?", "borers?", "aphids?", "nematodes?", "deficiency", "toxicity", "smut", "canker", "mosaic", "blast", "leaf\\s+spot", "pests?"],
  indic: ["ब्लाइट", "रोग", "सड़न", "सडन", "बीमारी", "झुलसा", "गलन", "कीट", "संक्रमण", "विल्ट", "उकठा", "फफूंद", "அழுகல்", "அழுகல", "நோய்", "நோய", "கருகல்", "வாடல்", "பூச்சி", "தொற்று", "பூஞ்சை"],
};
export const DIAGNOSIS_SUBJECT: TermList = { indic: ["आपकी", "आपके", "आपका", "फसल", "पौध", "अदरक", "पत्त", "உங்கள்", "உங்களுடைய", "பயிர்", "பயிரி", "செடி", "இஞ்சி", "இலை"] };
export const HEDGE: TermList = {
  en: ["may", "might", "could", "possibly", "possible", "likely", "probably", "perhaps", "suspect(?:ed)?", "appears?", "seems?", "looks?\\s+like", "consistent\\s+with", "suggests?", "uncertain", "not\\s+sure", "cannot\\s+(?:be\\s+)?confirm(?:ed)?"],
  indic: ["सकता", "सकती", "सकते", "शायद", "संभवतः", "संभव", "लगता", "लगती", "இருக்கலாம்", "ஒருவேளை", "தெரிகிறது", "போல", "வாய்ப்பு", "ஆகலாம்"],
};
export const NEGATION_EN = /\b(no|not|cannot|can't|cant|never|without|isn't|aren't|don't|doesn't|won't|nor|neither)\b/iu;
export const RAIN: TermList = {
  en: ["rain", "rainfall", "rains", "raining", "rainy", "shower", "showers", "precipitation", "downpours?", "drizzle", "storms?", "thunderstorms?", "cyclones?", "cloudburst", "wet\\s+spell", "baarish", "barish", "mazhai", "malai"],
  indic: ["बारिश", "वर्षा", "बरसात", "मॉनसून", "आंधी", "तूफान", "तूफ़ान", "मझை", "மழை", "புயல்", "இடிமழை"],
};
/** Loss/failure words: a guarantee about these is a guaranteed-outcome claim (F8). */
export const LOSS: TermList = {
  en: ["loss(?:es)?", "lose", "losing", "damage", "fail(?:ure|s)?", "crop\\s+failure", "wiped\\s+out"],
  indic: ["नुकसान", "घाटा", "हानि", "நஷ்ட", "இழப்பு", "சேதம்"],
};
/**
 * Product-form words (F8). A claim or block naming a product form must be scoped to products of that
 * form. Keys are contract ProductBasis values.
 */
const FORM_CROPS = "(?:ginger|turmeric|rhizomes?|chill?i(?:es|s)?|chilly|chillies|tomato(?:es)?|potato(?:es)?|okra|brinjals?|produce|form|product)";
export const PRODUCT_FORM_WORDS: Record<string, TermList> = {
  fresh: { en: [`fresh\\s+${FORM_CROPS}`, "green\\s+ginger"], indic: ["ताज़ा अदरक", "ताजा अदरक", "ताज़ी अदरक", "ताजी अदरक", "हरी अदरक", "ताज़ी हल्दी", "ताजी हल्दी", "பச்சை இஞ்சி", "புதிய இஞ்சி"] },
  dry: { en: [`(?:dry|dried)\\s+${FORM_CROPS}`, "sonth", "sukku", "chukku"], indic: ["सूखी अदरक", "सूखा अदरक", "सूखी हल्दी", "सूखी मिर्च", "सोंठ", "சுக்கு", "உலர்ந்த இஞ்சி", "உலர் இஞ்சி", "காய்ந்த மிளகாய்", "வர மிளகாய்"] },
  green: { en: ["green\\s+(?:chill?i(?:es|s)?|chilly|chillies|pepper)"], indic: ["हरी मिर्च", "பச்சை மிளகாய்"] },
  milled: { en: ["milled(?:\\s+rice)?", "polished\\s+rice"], indic: [] },
  kapas: { en: ["kapas", "seed\\s+cotton"], indic: ["कपास"] },
  lint: { en: ["lint", "ginned\\s+cotton"], indic: [] },
};
export const RAIN_FUTURE_VERB: TermList = {
  en: ["will\\s+(?:rain|pour|receive|get)", "it\\s+will\\s+rain", "expect(?:ed)?", "forecast\\s+to", "going\\s+to\\s+rain"],
  indic: ["होगी", "होगा", "पड़ेगी", "पड़ेगा", "गिरेगी", "आएगी", "आयेगी", "बरसेगा", "பெய்யும்", "பொழியும்", "வரும்"],
};
export const RELATIVE_TIME: TermList = {
  en: ["tomorrow", "next\\s+(?:week|month|fortnight)", "in\\s+\\d+\\s+(?:days?|weeks?|months?)"],
  indic: ["कल$", "परसों", "अगले", "अगली", "अगला", "आने वाले", "நாளை", "அடுத்த", "வரும் வார", "வரும் மாத"],
};
export const CANOPY: TermList = {
  en: ["canopy", "green\\s+cover", "ndvi", "leaf\\s+area", "vegetation\\s+index", "plant\\s+density", "photo", "photograph", "picture", "image"],
  indic: ["फोटो", "फ़ोटो", "तस्वीर", "छवि", "चित्र", "புகைப்பட", "படத்த", "படம்"],
};
export const YIELD: TermList = {
  en: ["yield", "harvest", "production", "tonnes?", "tons?", "quintals?"],
  indic: ["उपज", "पैदावार", "उत्पादन", "விளைச்சல", "மகசூல"],
};
/** Romanised Hindi/Tamil risk words checked in Latin-script text of a hi/ta turn (F8). */
export const ROMAN_RISK: TermList = {
  en: [...(ROMAN_DOSAGE_VERBS.en ?? []), ...(ROMAN_CHEMICAL_NOUNS.en ?? []), "pakka", "zaroor", "jaroor", "guarantee", "nishchit", "rog", "bimari", "beemari", "keeda", "nichayam", "kandippa", "noi", "azhugal"],
};

export const CONFIDENCE: TermList = {
  en: ["confiden\\w*", "certain\\w*", "sure", "accura\\w*", "probab\\w*", "likel\\w*", "chance"],
  indic: ["भरोसा", "विश्वास", "निश्चित", "संभावना", "सटीक", "நம்பிக்கை", "உறுதி", "வாய்ப்பு", "துல்லிய"],
};

/** Labels that make a coarser claim granularity explicit in the answer text. */
export const GRANULARITY_LABEL: Record<"state" | "region" | "national", TermList> = {
  state: { en: ["at\\s+(?:the\\s+)?state\\s+level", "state[\\s-]level"], indic: ["राज्य स्तर", "மாநில அளவில்", "மாநில அளவ"] },
  region: { en: ["at\\s+(?:the\\s+)?regional\\s+level", "region(?:al)?[\\s-]level"], indic: ["क्षेत्रीय स्तर", "பிராந்திய அளவில்", "பிராந்திய அளவ"] },
  national: { en: ["at\\s+(?:the\\s+)?national\\s+level", "national[\\s-]level", "india[\\s-]wide"], indic: ["राष्ट्रीय स्तर", "தேசிய அளவில்", "தேசிய அளவ"] },
};

/** Hindi/Tamil high-risk lexicon used by the non-English fail-closed rule (Indic terms only). */
export const NATIVE_RISK_LEXICON: { name: string; list: TermList }[] = [
  { name: "dosage_verb", list: { indic: DOSAGE_VERBS.indic ?? [] } },
  { name: "chemical", list: { indic: CHEMICAL_NOUNS.indic ?? [] } },
  { name: "certainty", list: { indic: CERTAINTY.indic ?? [] } },
  { name: "guarantee", list: { indic: [...(GUARANTEE.indic ?? []), ...(MULTIPLY_GAIN.indic ?? [])] } },
  { name: "disease", list: { indic: DISEASE.indic ?? [] } },
  { name: "rain", list: { indic: RAIN.indic ?? [] } },
  { name: "relative_time", list: { indic: RELATIVE_TIME.indic ?? [] } },
];

/**
 * Latin-script risk lexicon used by the fail-closed rule when the turn language is hi/ta (F8): romanised
 * Hindi/Tamil terms plus the English dosage, chemical, certainty, guarantee and disease words. A weather
 * noun alone is not withheld (the future-rain detector runs on every text in every language).
 */
export const LATIN_RISK_LEXICON: { name: string; list: TermList }[] = [
  { name: "romanised", list: ROMAN_RISK },
  { name: "dosage_verb", list: { en: DOSAGE_VERBS.en ?? [] } },
  { name: "chemical", list: { en: CHEMICAL_NOUNS.en ?? [] } },
  { name: "certainty", list: { en: CERTAINTY.en ?? [] } },
  { name: "guarantee", list: { en: [...(GUARANTEE.en ?? []), ...(MULTIPLY_GAIN.en ?? [])] } },
  { name: "disease", list: { en: DISEASE.en ?? [] } },
];

/** Hindi and Tamil month names (clarification option values). */
export const MONTH_NAMES_INDIC = ["जनवरी", "फरवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई$", "जून", "जुलाई", "अगस्त", "सितंबर", "सितम्बर", "अक्टूबर", "अक्तूबर", "नवंबर", "नवम्बर", "दिसंबर", "दिसम्बर",
  "ஜனவரி", "பிப்ரவரி", "மார்ச்", "ஏப்ரல்", "மே$", "ஜூன்", "ஜூலை", "ஆகஸ்ட்", "செப்டம்பர்", "அக்டோபர்", "நவம்பர்", "டிசம்பர்", "சித்திரை", "வைகாசி", "ஆனி", "ஆடி", "ஆவணி", "புரட்டாசி", "ஐப்பசி", "கார்த்திகை", "மார்கழி", "தை$", "மாசி", "பங்குனி"];

export const INDIC_SCRIPT = /[\p{Script=Devanagari}\p{Script=Tamil}]/u;
