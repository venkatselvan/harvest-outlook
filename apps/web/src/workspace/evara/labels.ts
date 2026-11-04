import type { EvaraCompareColumn, EvaraPromptKey } from "@harvest/contracts";
import type { AskLanguage } from "../../features/ask/model";
import { longDate } from "../year/format";

/**
 * Code-written text of the Evara UI kit (docs/research/EVARA_ACTIONS_SPEC.md 2.5, 2.8). The model never writes these:
 * the questions an `ask` action sends, the table headings, the chrome of the journey strip and the Plan-this-crop sheet.
 * English is the complete table; Hindi and Tamil override what they translate and every other key falls back to English.
 */

/** The question each `@Ask(promptKey)` sends, per panel language. The English texts of the first five match the welcome prompts. */
export const ASK_QUESTIONS: Record<AskLanguage, Record<EvaraPromptKey, string>> = {
  en: {
    care_15_days: "How should I care for my crop in the next 15 days?",
    plant_next: "What should I plant next?",
    compare_season: "Help me compare crops for this season",
    weather_market: "Review my farm's weather and market outlook",
    what_could_have_been: "What could I have planted instead of my current crop?",
    show_journey: "Show me how ginger would grow here",
  },
  hi: {
    care_15_days: "अगले 15 दिनों में मुझे अपनी फसल की देखभाल कैसे करनी चाहिए?",
    plant_next: "मुझे आगे क्या बोना चाहिए?",
    compare_season: "इस मौसम के लिए फसलों की तुलना करने में मेरी मदद करें",
    weather_market: "मेरे खेत के मौसम और बाज़ार के अनुमान की समीक्षा करें",
    what_could_have_been: "मेरी मौजूदा फसल की जगह मैं और क्या बो सकता था?",
    show_journey: "मुझे दिखाइए कि यहाँ अदरक कैसे बढ़ेगी",
  },
  ta: {
    care_15_days: "அடுத்த 15 நாட்களில் என் பயிரை எப்படி பராமரிக்க வேண்டும்?",
    plant_next: "அடுத்து நான் எதை பயிரிட வேண்டும்?",
    compare_season: "இந்தப் பருவத்துக்கான பயிர்களை ஒப்பிட எனக்கு உதவுங்கள்",
    weather_market: "என் பண்ணையின் வானிலை மற்றும் சந்தை நிலவரத்தை ஆய்வு செய்யுங்கள்",
    what_could_have_been: "என் தற்போதைய பயிருக்குப் பதிலாக வேறு எதை பயிரிட்டிருக்கலாம்?",
    show_journey: "இங்கே இஞ்சி எப்படி வளரும் என்று காட்டுங்கள்",
  },
};

export const askQuestion = (language: AskLanguage, key: EvaraPromptKey): string => ASK_QUESTIONS[language]?.[key] ?? ASK_QUESTIONS.en[key];

export interface KitLabels {
  crop: string;
  columns: Record<EvaraCompareColumn, string>;
  compareCaption: string;
  compareHint: string;
  tones: { good: string; watch: string; short: string };
  rowActions: string;
  snapshot: { field: string; crop: string; stage: string; day: string; rain: string; next: string; alerts: string };
  planTitles: { plan: string; alternatives: string; saved: string };
  slotSow: string;
  slotHarvest: string;
  slotHarvestUnknown: string;
  slotProfit: string;
  slotReplaces: string;
  journeyTitle: (crop: string) => string;
  journeySowing: string;
  journeyPredict: string;
  journeyPredicting: string;
  journeyAgain: string;
  journeyRetry: string;
  journeyIllustrative: string;
  journeyFromSatellite: (date: string) => string;
  journeyFromPhoto: (date: string) => string;
  journeyStageReady: (n: number, total: number) => string;
  journeyTimeout: string;
  journeyNoStages: string;
  journeyLoading: string;
  journeyUnavailable: Record<string, string>;
  journeyUnavailableOther: string;
  stageReason: Record<string, string>;
  stageReasonOther: string;
  schematicNote: string;
  choiceGroup: string;
  warningLabel: string;
  sheet: {
    title: (crop: string) => string;
    subtitleAdd: string;
    subtitleReplace: string;
    loading: string;
    loadError: string;
    retry: string;
    stages: string;
    noStages: string;
    sowing: string;
    harvest: string;
    harvestUnknown: string;
    field: string;
    wholeFarm: string;
    changeTitle: string;
    addChange: (crop: string, sowing: string, harvest: string | null, field: string) => string;
    replaceChange: (from: string, fromDate: string, to: string, sowing: string, harvest: string | null) => string;
    noWrite: string;
    add: string;
    replace: (crop: string, date: string) => string;
    saving: string;
    cancel: string;
    reload: string;
    overlapNote: string;
    notReplaceable: string;
    missingOccupant: string;
    pastSowing: (date: string) => string;
    blocked: (crop: string, from: string, to: string) => string;
    growingUnknown: (crop: string, from: string) => string;
    unchanged: string;
    conflict: string;
    saveFailed: string;
    notReady: string;
    noFarm: string;
    close: string;
  };
  saved: {
    added: (crop: string, date: string) => string;
    replaced: (crop: string, from: string, date: string) => string;
    openPlan: string;
  };
}

const EN: KitLabels = {
  crop: "Crop",
  columns: { fit: "Fit", sowing: "Sowing", duration: "Duration", water: "Water", harvest: "Harvest", profit: "Profit for field", replaces: "Replaces" },
  compareCaption: "Crop comparison",
  compareHint: "Swipe sideways to see every column.",
  tones: { good: "Good", watch: "Watch", short: "Short" },
  rowActions: "Actions for",
  snapshot: { field: "Field", crop: "Crop", stage: "Stage", day: "Day of season", rain: "Rain, next 7 days", next: "Next step", alerts: "Open alerts" },
  planTitles: { plan: "Plan options", alternatives: "Alternatives", saved: "Saved seasons" },
  slotSow: "Sow",
  slotHarvest: "Harvest",
  slotHarvestUnknown: "not known",
  slotProfit: "Profit for field",
  slotReplaces: "Replaces",
  journeyTitle: (crop) => `How ${crop} could grow`,
  journeySowing: "Sowing",
  journeyPredict: "Predict how it could look on this field",
  journeyPredicting: "Making the images. This can take a few minutes.",
  journeyAgain: "Check again",
  journeyRetry: "Try again",
  journeyIllustrative: "Illustrative growth, generated image, not a prediction",
  journeyFromSatellite: (date) => `Derived from the satellite image of ${date}`,
  journeyFromPhoto: (date) => `Derived from your field photo of ${date}`,
  journeyStageReady: (n, total) => `${n} of ${total} images ready`,
  journeyTimeout: "The images are taking longer than usual. Check again in a moment.",
  journeyNoStages: "No stage calendar is available for this crop at this sowing date.",
  journeyLoading: "Loading the stages…",
  journeyUnavailable: {
    runtime_mode: "Generated images need the live service, which is not running in this mode. The stages below are drawn without a camera view.",
    no_source_image: "There is no usable satellite scene or field photo to start from, so no images can be made. The stages below are drawn without a camera view.",
    budget: "The image budget for now is used up, so no images were made. Try again later.",
    daily_cap: "The limit of crop journeys for today is reached. Try again tomorrow.",
  },
  journeyUnavailableOther: "Images could not be made this time.",
  stageReason: {
    outside_field_changed: "The image changed more than the field, so it was not used.",
    qa_failed: "The image did not pass the checks, so it was not used.",
    budget: "The image budget is used up.",
    daily_cap: "The limit for today is reached.",
    provider_unavailable: "The image service is unavailable.",
    timeout: "The image took too long.",
  },
  stageReasonOther: "This image could not be made.",
  schematicNote: "Drawn from the stage calendar, not a camera view.",
  choiceGroup: "Choices",
  warningLabel: "Warning",
  sheet: {
    title: (crop) => `Plan ${crop}`,
    subtitleAdd: "Season preview · calculated reference",
    subtitleReplace: "Replace a planned season · calculated reference",
    loading: "Building the season preview…",
    loadError: "The season preview could not be loaded. Check your connection and try again.",
    retry: "Try again",
    stages: "Stages",
    noStages: "No sourced stage calendar for this crop.",
    sowing: "Sowing",
    harvest: "Harvest window",
    harvestUnknown: "No sourced harvest window",
    field: "Field",
    wholeFarm: "Whole farm",
    changeTitle: "What will be saved",
    addChange: (crop, sowing, harvest, field) => `Adds ${crop} to your plan on ${field}: sow ${sowing}${harvest ? `, harvest by ${harvest}` : ""}.`,
    replaceChange: (from, fromDate, to, sowing, harvest) => `${from} (planned ${fromDate}) is replaced by ${to}: sow ${sowing}${harvest ? `, harvest by ${harvest}` : ""}.`,
    noWrite: "Nothing is saved until you confirm. Dates are calculated references, not predictions.",
    add: "Add as planned season",
    replace: (crop, date) => `Replace ${crop} (planned ${date})`,
    saving: "Saving…",
    cancel: "Not now",
    reload: "Reload plan and try again",
    overlapNote: "This crop would occupy the field at the same time as a planned season, so it can only replace it.",
    notReplaceable: "This season is already sown or no longer planned, so it cannot be replaced.",
    missingOccupant: "That planned season is no longer on the field. Reload and try again.",
    pastSowing: (date) => `The sowing date ${date} has passed. Pick a date that can still be sown.`,
    blocked: (crop, from, to) => `${crop} is already sown on this field from ${from} to ${to}, so this crop cannot be planned at the same time.`,
    growingUnknown: (crop, from) => `The field is growing ${crop}; its harvest date is not known yet, so a new season cannot be placed from ${from}.`,
    unchanged: "That planned season already has this crop on this date.",
    conflict: "Your saved seasons changed elsewhere. Reload the plan and try again.",
    saveFailed: "The season could not be saved. Try again.",
    notReady: "Farm details are still loading. Try again in a moment.",
    noFarm: "Select a farm first.",
    close: "Close",
  },
  saved: {
    added: (crop, date) => `Saved: ${crop} is planned for ${date}`,
    replaced: (crop, from, date) => `Saved: ${crop} replaces ${from}, planned for ${date}`,
    openPlan: "Open plan",
  },
};

const HI: Partial<KitLabels> = {
  crop: "फसल",
  columns: { fit: "मेल", sowing: "बुवाई", duration: "अवधि", water: "पानी", harvest: "कटाई", profit: "खेत का मुनाफ़ा", replaces: "किसकी जगह" },
  compareCaption: "फसलों की तुलना",
  compareHint: "सभी कॉलम देखने के लिए बगल में खिसकाएँ।",
  tones: { good: "अच्छा", watch: "ध्यान दें", short: "कम" },
  rowActions: "इसके विकल्प",
  snapshot: { field: "खेत", crop: "फसल", stage: "चरण", day: "मौसम का दिन", rain: "अगले 7 दिनों की बारिश", next: "अगला काम", alerts: "खुली चेतावनियाँ" },
  planTitles: { plan: "योजना विकल्प", alternatives: "विकल्प", saved: "सहेजे गए मौसम" },
  slotSow: "बुवाई",
  slotHarvest: "कटाई",
  slotProfit: "खेत का मुनाफ़ा",
  slotReplaces: "किसकी जगह",
  journeyTitle: (crop) => `${crop} कैसे बढ़ सकती है`,
  journeySowing: "बुवाई",
  journeyPredict: "देखें कि यह इस खेत में कैसी दिख सकती है",
  journeyPredicting: "चित्र बन रहे हैं। इसमें कुछ मिनट लग सकते हैं।",
  journeyAgain: "फिर देखें",
  journeyRetry: "फिर कोशिश करें",
  journeyIllustrative: "उदाहरण के लिए बनी वृद्धि, एआई चित्र, पूर्वानुमान नहीं",
  journeyFromSatellite: (date) => `${date} के उपग्रह चित्र से बना`,
  journeyFromPhoto: (date) => `आपके खेत की ${date} की फ़ोटो से बना`,
  journeyStageReady: (n, total) => `${total} में से ${n} चित्र तैयार`,
  journeyTimeout: "चित्र बनने में सामान्य से ज़्यादा समय लग रहा है। थोड़ी देर बाद फिर देखें।",
  journeyNoStages: "इस बुवाई तारीख़ के लिए इस फसल का चरण कैलेंडर उपलब्ध नहीं है।",
  journeyLoading: "चरण लोड हो रहे हैं…",
  schematicNote: "चरण कैलेंडर से बना चित्र, कैमरे का दृश्य नहीं।",
  warningLabel: "चेतावनी",
  sheet: {
    ...EN.sheet,
    title: (crop) => `${crop} की योजना`,
    loading: "मौसम का पूर्वावलोकन बन रहा है…",
    stages: "चरण",
    sowing: "बुवाई",
    harvest: "कटाई की अवधि",
    noWrite: "आपके पुष्टि करने तक कुछ भी सहेजा नहीं जाएगा। तारीख़ें गणना किए गए संदर्भ हैं, पूर्वानुमान नहीं।",
    add: "नियोजित मौसम के रूप में जोड़ें",
    replace: (crop, date) => `${crop} बदलें (योजना ${date})`,
    saving: "सहेजा जा रहा है…",
    cancel: "अभी नहीं",
    close: "बंद करें",
  },
  saved: {
    added: (crop, date) => `सहेजा गया: ${crop} की योजना ${date} के लिए है`,
    replaced: (crop, from, date) => `सहेजा गया: ${crop} अब ${from} की जगह है, योजना ${date}`,
    openPlan: "योजना खोलें",
  },
};

const TA: Partial<KitLabels> = {
  crop: "பயிர்",
  columns: { fit: "பொருத்தம்", sowing: "விதைப்பு", duration: "காலம்", water: "தண்ணீர்", harvest: "அறுவடை", profit: "வயல் லாபம்", replaces: "மாற்றுவது" },
  compareCaption: "பயிர் ஒப்பீடு",
  compareHint: "எல்லா நெடுவரிசைகளையும் காண பக்கவாட்டில் நகர்த்தவும்.",
  tones: { good: "நன்று", watch: "கவனிக்க", short: "குறைவு" },
  rowActions: "இதற்கான செயல்கள்",
  snapshot: { field: "வயல்", crop: "பயிர்", stage: "நிலை", day: "பருவ நாள்", rain: "அடுத்த 7 நாள் மழை", next: "அடுத்த பணி", alerts: "திறந்த எச்சரிக்கைகள்" },
  planTitles: { plan: "திட்ட விருப்பங்கள்", alternatives: "மாற்று வழிகள்", saved: "சேமித்த பருவங்கள்" },
  slotSow: "விதைப்பு",
  slotHarvest: "அறுவடை",
  slotProfit: "வயல் லாபம்",
  slotReplaces: "மாற்றுவது",
  journeyTitle: (crop) => `${crop} எப்படி வளரக்கூடும்`,
  journeySowing: "விதைப்பு",
  journeyPredict: "இந்த வயலில் இது எப்படி இருக்கக்கூடும் என்று பாருங்கள்",
  journeyPredicting: "படங்கள் உருவாகின்றன. சில நிமிடங்கள் ஆகலாம்.",
  journeyAgain: "மீண்டும் பார்க்கவும்",
  journeyRetry: "மீண்டும் முயலவும்",
  journeyIllustrative: "விளக்கப் படம்: உருவாக்கப்பட்ட வளர்ச்சிப் படம், கணிப்பு அல்ல",
  journeyFromSatellite: (date) => `${date} செயற்கைக்கோள் படத்திலிருந்து உருவாக்கப்பட்டது`,
  journeyFromPhoto: (date) => `உங்கள் வயலின் ${date} புகைப்படத்திலிருந்து உருவாக்கப்பட்டது`,
  journeyStageReady: (n, total) => `${total} இல் ${n} படங்கள் தயார்`,
  journeyTimeout: "படங்கள் வழக்கத்தைவிட நேரம் எடுக்கின்றன. சிறிது நேரம் கழித்து மீண்டும் பாருங்கள்.",
  journeyNoStages: "இந்த விதைப்பு தேதிக்கு இந்தப் பயிரின் நிலை நாட்காட்டி இல்லை.",
  journeyLoading: "நிலைகள் ஏற்றப்படுகின்றன…",
  schematicNote: "நிலை நாட்காட்டியிலிருந்து வரையப்பட்டது, கேமரா காட்சி அல்ல.",
  warningLabel: "எச்சரிக்கை",
  sheet: {
    ...EN.sheet,
    title: (crop) => `${crop} திட்டம்`,
    loading: "பருவ முன்னோட்டம் உருவாகிறது…",
    stages: "நிலைகள்",
    sowing: "விதைப்பு",
    harvest: "அறுவடை காலம்",
    noWrite: "நீங்கள் உறுதிப்படுத்தும் வரை எதுவும் சேமிக்கப்படாது. தேதிகள் கணக்கிடப்பட்ட குறிப்புகள், கணிப்புகள் அல்ல.",
    add: "திட்டமிட்ட பருவமாகச் சேர்",
    replace: (crop, date) => `${crop} ஐ மாற்று (திட்டம் ${date})`,
    saving: "சேமிக்கிறது…",
    cancel: "இப்போது வேண்டாம்",
    close: "மூடு",
  },
  saved: {
    added: (crop, date) => `சேமிக்கப்பட்டது: ${crop} ${date} க்கு திட்டமிடப்பட்டுள்ளது`,
    replaced: (crop, from, date) => `சேமிக்கப்பட்டது: ${crop} இப்போது ${from} க்குப் பதிலாக, திட்டம் ${date}`,
    openPlan: "திட்டத்தைத் திற",
  },
};

const LOCALE: Record<AskLanguage, string> = { en: "en-IN", hi: "hi-IN", ta: "ta-IN" };

/** Kit text for a panel language; keys a translation does not cover read in English. */
export function kitLabels(language: AskLanguage): KitLabels {
  const own = language === "hi" ? HI : language === "ta" ? TA : null;
  return own ? { ...EN, ...own } : EN;
}

/** "12 Feb 2027" (en, the app's own month names, so the text does not change with the runtime's ICU), localised for hi and ta. Calendar date, no time zone shift; an unparseable value is returned as written. */
export function labelDate(iso: string, language: AskLanguage = "en"): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso.slice(0, 10)) ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : null;
  if (!day || Number.isNaN(day.getTime())) return iso;
  if (language === "en") return longDate(iso);
  try {
    return day.toLocaleDateString(LOCALE[language] ?? "en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  } catch {
    return iso;
  }
}
