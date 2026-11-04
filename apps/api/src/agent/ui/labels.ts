import type { EvaraOpenTarget, EvaraPromptKey } from "@harvest/contracts";

/**
 * Code-written labels, cells, chips and notes of the Evara UI kit, per turn language (en, hi, ta; anything else reads
 * English). Nothing here comes from a model, so it does not pass the output gate; the only variable parts are crop names
 * from the catalogue and dates and amounts computed by code. The Hindi and Tamil wording was written for this build and
 * has not been reviewed by native-speaker agronomists (same status as agent/templates.ts).
 */
export type EvaraLangCode = "en" | "hi" | "ta";
export const langOf = (lang: string): EvaraLangCode => (/^hi(-|$)/i.test(lang) ? "hi" : /^ta(-|$)/i.test(lang) ? "ta" : "en");

const LOCALE: Record<EvaraLangCode, string> = { en: "en-IN", hi: "hi-IN", ta: "ta-IN" };

export const cut = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function fmtDate(iso: string, l: EvaraLangCode): string {
  return new Intl.DateTimeFormat(LOCALE[l], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(utc(iso));
}
/** "3 Nov – 5 Nov 2026" style range; the year is shown once when both dates share it. */
export function fmtRange(from: string, to: string, l: EvaraLangCode): string {
  if (from === to) return fmtDate(from, l);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const a = sameYear ? new Intl.DateTimeFormat(LOCALE[l], { day: "numeric", month: "short", timeZone: "UTC" }).format(utc(from)) : fmtDate(from, l);
  return `${a} – ${fmtDate(to, l)}`;
}
export function fmtMonth(m: number, l: EvaraLangCode): string {
  return new Intl.DateTimeFormat(LOCALE[l], { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, m - 1, 15)));
}
export function fmtMonths(from: number, to: number, l: EvaraLangCode): string {
  return from === to ? fmtMonth(from, l) : `${fmtMonth(from, l)} – ${fmtMonth(to, l)}`;
}
const int = (n: number, l: EvaraLangCode) => new Intl.NumberFormat(LOCALE[l], { maximumFractionDigits: 0 }).format(Math.round(n));
const dec = (n: number, l: EvaraLangCode) => new Intl.NumberFormat(LOCALE[l], { maximumFractionDigits: 1 }).format(n);
export const fmtInr = (n: number, l: EvaraLangCode) => `${n < 0 ? "−" : ""}₹${int(Math.abs(n), l)}`;
/** Central value with the likely band, for the field. */
export const fmtInrEstimate = (central: number, low: number, high: number, l: EvaraLangCode) => `${fmtInr(central, l)} (${fmtInr(low, l)} – ${fmtInr(high, l)})`;

const DAYS: Record<EvaraLangCode, string> = { en: "days", hi: "दिन", ta: "நாட்கள்" };
export function fmtDays(low: number, high: number | null, l: EvaraLangCode): string {
  if (high === null || Math.round(high) === Math.round(low)) return `${int(low, l)} ${DAYS[l]}`;
  return `${int(low, l)} – ${int(high, l)} ${DAYS[l]}`;
}
export function fmtMm(n: number, l: EvaraLangCode): string {
  return `${dec(n, l)} ${l === "hi" ? "मिमी" : l === "ta" ? "மிமீ" : "mm"}`;
}
export function fmtDayOfSeason(n: number, l: EvaraLangCode): string {
  return l === "hi" ? `दिन ${int(n, l)}` : l === "ta" ? `நாள் ${int(n, l)}` : `Day ${int(n, l)}`;
}

type T = Record<EvaraLangCode, string>;
const fill = (t: string, vars: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

const ACTION: Record<"pick_crop" | "show_journey" | "compare" | "use_plan" | "use_alternative" | "replace_season" | "add_season", T> = {
  pick_crop: { en: "Plan {crop}", hi: "{crop} की योजना बनाएँ", ta: "{crop} திட்டமிடுக" },
  show_journey: { en: "See how {crop} grows", hi: "देखें {crop} कैसे बढ़ती है", ta: "{crop} எப்படி வளரும் எனப் பார்க்க" },
  compare: { en: "Compare these crops", hi: "इन फसलों की तुलना करें", ta: "இந்தப் பயிர்களை ஒப்பிடுக" },
  use_plan: { en: "Use this plan", hi: "यह योजना अपनाएँ", ta: "இந்தத் திட்டத்தைப் பயன்படுத்துக" },
  use_alternative: { en: "Use instead of {crops}", hi: "{crops} की जगह अपनाएँ", ta: "{crops} க்குப் பதிலாகப் பயன்படுத்துக" },
  replace_season: { en: "Replace {from} with {crop}", hi: "{from} की जगह {crop}", ta: "{from} க்குப் பதில் {crop}" },
  add_season: { en: "Add {crop} as a planned season", hi: "{crop} को नियोजित मौसम में जोड़ें", ta: "{crop} ஐத் திட்டமிட்ட பருவமாகச் சேர்க்க" },
};
export function actionLabel(kind: keyof typeof ACTION, l: EvaraLangCode, vars: Record<string, string> = {}): string {
  return cut(fill(ACTION[kind][l], vars), 80);
}

const OPEN: Record<EvaraOpenTarget, T> = {
  plan: { en: "Open the year plan", hi: "साल की योजना खोलें", ta: "ஆண்டுத் திட்டத்தைத் திறக்க" },
  fit: { en: "Open crop fit", hi: "फसल उपयुक्तता खोलें", ta: "பயிர் பொருத்தத்தைத் திறக்க" },
  compare: { en: "Open compare", hi: "तुलना खोलें", ta: "ஒப்பீட்டைத் திறக்க" },
  today: { en: "Open Today", hi: "आज का दृश्य खोलें", ta: "இன்றைய பக்கத்தைத் திறக்க" },
  journal: { en: "Open the journal", hi: "डायरी खोलें", ta: "குறிப்பேட்டைத் திறக்க" },
};
export const openLabel = (t: EvaraOpenTarget, l: EvaraLangCode) => OPEN[t][l];

const ASK: Record<EvaraPromptKey, T> = {
  care_15_days: { en: "Care for the next 15 days", hi: "अगले 15 दिनों की देखभाल", ta: "அடுத்த 15 நாள் பராமரிப்பு" },
  plant_next: { en: "What to plant next", hi: "आगे क्या बोएँ", ta: "அடுத்து என்ன பயிரிடலாம்" },
  compare_season: { en: "Compare crops for this season", hi: "इस मौसम की फसलों की तुलना", ta: "இந்தப் பருவப் பயிர்களை ஒப்பிடுக" },
  weather_market: { en: "Weather and market", hi: "मौसम और बाज़ार", ta: "வானிலை மற்றும் சந்தை" },
  what_could_have_been: { en: "What could have been planted instead", hi: "इसकी जगह क्या बोया जा सकता था", ta: "இதற்குப் பதில் என்ன பயிரிட்டிருக்கலாம்" },
  show_journey: { en: "Show how a crop would grow", hi: "दिखाएँ फसल कैसे बढ़ेगी", ta: "பயிர் எப்படி வளரும் எனக் காட்டுக" },
};
export const askLabel = (k: EvaraPromptKey, l: EvaraLangCode) => ASK[k][l];

const OUTCOME: Record<string, T> = {
  eligible: { en: "Suitable", hi: "उपयुक्त", ta: "ஏற்றது" },
  requires_review: { en: "Needs review", hi: "जाँच ज़रूरी", ta: "சரிபார்க்க வேண்டும்" },
  unknown: { en: "Unknown", hi: "अज्ञात", ta: "தெரியவில்லை" },
  ineligible: { en: "Not suitable", hi: "उपयुक्त नहीं", ta: "ஏற்றதல்ல" },
  excluded_by_farmer: { en: "Excluded by you", hi: "आपने हटाया", ta: "நீங்கள் நீக்கியது" },
};
export const outcomeLabel = (o: string, l: EvaraLangCode) => (OUTCOME[o] ?? OUTCOME.unknown!)[l];

export const rankLabel = (rank: number, score: number, l: EvaraLangCode) =>
  l === "hi" ? `क्रम ${int(rank, l)}, अंक ${int(score, l)}` : l === "ta" ? `தரம் ${int(rank, l)}, மதிப்பெண் ${int(score, l)}` : `Rank ${int(rank, l)}, score ${int(score, l)}`;

const WATER: Record<"good" | "partial" | "short" | "matches" | "mismatch", T> = {
  good: { en: "Water fits", hi: "पानी पर्याप्त", ta: "நீர் போதும்" },
  partial: { en: "Water partly fits", hi: "पानी आंशिक", ta: "நீர் ஓரளவு" },
  short: { en: "Water short", hi: "पानी कम", ta: "நீர் குறைவு" },
  matches: { en: "Water fits", hi: "पानी पर्याप्त", ta: "நீர் போதும்" },
  mismatch: { en: "Water short", hi: "पानी कम", ta: "நீர் குறைவு" },
};
export const waterLabel = (k: keyof typeof WATER, l: EvaraLangCode) => WATER[k][l];
const NEED: T = { en: "need {need}", hi: "ज़रूरत {need}", ta: "தேவை {need}" };
const NEED_WORD: Record<string, T> = { low: { en: "low", hi: "कम", ta: "குறைவு" }, medium: { en: "medium", hi: "मध्यम", ta: "நடுத்தரம்" }, high: { en: "high", hi: "अधिक", ta: "அதிகம்" } };
export const needLabel = (need: string, l: EvaraLangCode) => fill(NEED[l], { need: (NEED_WORD[need] ?? { en: need, hi: need, ta: need })[l] });

const SEASON: Record<string, T> = {
  kharif: { en: "kharif", hi: "खरीफ़", ta: "காரீஃப்" },
  rabi: { en: "rabi", hi: "रबी", ta: "ராபி" },
  summer: { en: "summer", hi: "गर्मी", ta: "கோடை" },
  zaid: { en: "zaid", hi: "ज़ायद", ta: "ஜாயித்" },
  perennial: { en: "perennial", hi: "बहुवर्षीय", ta: "பல்லாண்டு" },
};
export const seasonLabel = (s: string, l: EvaraLangCode) => (SEASON[s] ?? { en: s, hi: s, ta: s })[l];

const PLANNED: T = { en: "{crop}, planned {date}", hi: "{crop}, नियोजित {date}", ta: "{crop}, திட்டம் {date}" };
export const plannedLabel = (crop: string, date: string | null, l: EvaraLangCode) => (date ? fill(PLANNED[l], { crop, date: fmtDate(date, l) }) : crop);

const CHIP: Record<"planned" | "overdue" | "sown" | "replace_planned" | "sown_comparison" | "applied" | "comparison_only", T> = {
  planned: { en: "Planned, not sown", hi: "नियोजित, बोया नहीं", ta: "திட்டம், விதைக்கவில்லை" },
  overdue: { en: "Planned date passed, not sown", hi: "तारीख़ निकल गई, बोया नहीं", ta: "தேதி கடந்தது, விதைக்கவில்லை" },
  sown: { en: "Sown", hi: "बोया गया", ta: "விதைக்கப்பட்டது" },
  replace_planned: { en: "Replaces planned seasons", hi: "नियोजित मौसम की जगह", ta: "திட்டமிட்ட பருவத்துக்குப் பதில்" },
  sown_comparison: { en: "Comparison with what is sown", hi: "बोई फसल से तुलना", ta: "விதைத்ததுடன் ஒப்பீடு" },
  applied: { en: "Saved to your seasons", hi: "आपके मौसमों में सहेजा", ta: "உங்கள் பருவங்களில் சேமிக்கப்பட்டது" },
  comparison_only: { en: "For comparison only", hi: "केवल तुलना के लिए", ta: "ஒப்பீட்டுக்கு மட்டும்" },
};
export const chipLabel = (k: keyof typeof CHIP, l: EvaraLangCode) => cut(CHIP[k][l], 60);

const NOTE: Record<
  "fit_review" | "fit_replace" | "fit_screening" | "unknown_cells" | "plan_saved" | "plan_review" | "alternatives_replace" | "alternatives_sown" | "journey" | "profit" | "not_ranked" | "no_duration" | "no_water" | "no_harvest" | "no_sowing" | "no_profit",
  T
> = {
  fit_review: { en: "Ranks, dates and profit come from the latest crop-fit review for this field.", hi: "क्रम, तारीख़ें और मुनाफ़ा इस खेत की ताज़ा फसल-उपयुक्तता समीक्षा से हैं।", ta: "தரம், தேதிகள், லாபம் இந்த வயலின் சமீபத்திய பயிர் பொருத்த ஆய்விலிருந்து." },
  fit_replace: { en: "Ranked as replacements for planned seasons that are not sown yet.", hi: "अभी न बोए गए नियोजित मौसमों के बदले के रूप में क्रमित।", ta: "இன்னும் விதைக்காத திட்டப் பருவங்களுக்கு மாற்றாக வரிசைப்படுத்தப்பட்டது." },
  fit_screening: { en: "From crop screening only; run crop fit for this field to see ranks and profit.", hi: "केवल फसल जाँच से; क्रम और मुनाफ़ा देखने के लिए इस खेत की फसल उपयुक्तता चलाएँ।", ta: "பயிர் சோதனையிலிருந்து மட்டும்; தரமும் லாபமும் காண இந்த வயலுக்குப் பயிர் பொருத்தம் இயக்கவும்." },
  unknown_cells: { en: "A dash means the value is not known.", hi: "डैश का मतलब है जानकारी उपलब्ध नहीं।", ta: "கோடு என்றால் மதிப்பு தெரியவில்லை." },
  plan_saved: { en: "Your saved seasons on this field.", hi: "इस खेत पर आपके सहेजे गए मौसम।", ta: "இந்த வயலில் நீங்கள் சேமித்த பருவங்கள்." },
  plan_review: { en: "Plans from the latest year-plan review; profit is an estimate, not a guarantee.", hi: "ताज़ा साल-योजना समीक्षा से; मुनाफ़ा अनुमान है, गारंटी नहीं।", ta: "சமீபத்திய ஆண்டுத் திட்ட ஆய்விலிருந்து; லாபம் மதிப்பீடு, உத்தரவாதம் அல்ல." },
  alternatives_replace: { en: "Your planned seasons are not sown yet; these plans could take their place.", hi: "आपके नियोजित मौसम अभी बोए नहीं गए; ये योजनाएँ उनकी जगह ले सकती हैं।", ta: "உங்கள் திட்டப் பருவங்கள் இன்னும் விதைக்கப்படவில்லை; இந்தத் திட்டங்கள் அவற்றின் இடத்தைப் பெறலாம்." },
  alternatives_sown: { en: "What could have fitted this field from the sowing date; the sown crop stays.", hi: "बुवाई की तारीख़ से इस खेत में क्या हो सकता था; बोई फसल वैसी ही रहेगी।", ta: "விதைப்புத் தேதியிலிருந்து இந்த வயலில் என்ன பொருந்தியிருக்கலாம்; விதைத்த பயிர் அப்படியே இருக்கும்." },
  journey: { en: "Stages from the crop calendar. Images, when you ask for them, are illustrations, not predictions.", hi: "चरण फसल कैलेंडर से। माँगने पर बनी तस्वीरें केवल चित्रण हैं, भविष्यवाणी नहीं।", ta: "நிலைகள் பயிர் நாட்காட்டியிலிருந்து. நீங்கள் கேட்கும் படங்கள் விளக்கப்படங்கள் மட்டுமே, கணிப்புகள் அல்ல." },
  profit: { en: "Estimate for this field; not a guarantee.", hi: "इस खेत का अनुमान; गारंटी नहीं।", ta: "இந்த வயலுக்கான மதிப்பீடு; உத்தரவாதம் அல்ல." },
  not_ranked: { en: "Not in the crop-fit review for this field.", hi: "इस खेत की फसल-उपयुक्तता समीक्षा में नहीं।", ta: "இந்த வயலின் பயிர் பொருத்த ஆய்வில் இல்லை." },
  no_duration: { en: "No sourced crop duration.", hi: "फसल अवधि का स्रोत नहीं।", ta: "பயிர் காலத்துக்கு ஆதாரம் இல்லை." },
  no_water: { en: "Water need or the field's irrigation is not known.", hi: "पानी की ज़रूरत या खेत की सिंचाई ज्ञात नहीं।", ta: "நீர்த் தேவை அல்லது வயலின் பாசனம் தெரியவில்லை." },
  no_harvest: { en: "No harvest window without a sourced duration.", hi: "अवधि के स्रोत के बिना कटाई का समय नहीं।", ta: "ஆதாரக் காலம் இல்லாமல் அறுவடைக் காலம் இல்லை." },
  no_sowing: { en: "No sourced sowing window for this area.", hi: "इस क्षेत्र के लिए बुवाई का स्रोत नहीं।", ta: "இந்தப் பகுதிக்கு விதைப்புக் காலத்துக்கு ஆதாரம் இல்லை." },
  no_profit: { en: "Profit is shown only from a crop-fit review.", hi: "मुनाफ़ा केवल फसल-उपयुक्तता समीक्षा से दिखता है।", ta: "லாபம் பயிர் பொருத்த ஆய்விலிருந்து மட்டுமே." },
};
export const noteLabel = (k: keyof typeof NOTE, l: EvaraLangCode) => NOTE[k][l];

/** 2.7: the code-authored callout when no answer block was approved (it does not need the gate). */
export const NO_ANSWER: T = {
  en: "I could not produce a checked answer; here is what the farm shows.",
  hi: "मैं जाँचा हुआ उत्तर नहीं दे सका; खेत की मौजूदा जानकारी यह है।",
  ta: "சரிபார்க்கப்பட்ட பதிலைத் தர முடியவில்லை; பண்ணையின் தற்போதைய நிலை இதோ.",
};
/** When only a clarification question was approved (the web shows the question itself). */
export const CLARIFY_FIRST: T = {
  en: "Please answer the question below so I can check the rest.",
  hi: "कृपया नीचे दिए सवाल का जवाब दें, ताकि मैं बाकी जाँच सकूँ।",
  ta: "மீதியைச் சரிபார்க்க கீழே உள்ள கேள்விக்குப் பதில் அளிக்கவும்.",
};
