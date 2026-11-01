/**
 * Registry of every place Harvest Outlook uses an AI model. One entry per use, shown by the AI spark mark
 * (`AiSpark.tsx`) and by the "AI in this app" list in the header.
 *
 * Copy rules: each entry says what the model does, what code does instead and why that helps. `status` must be
 * "planned" for any use that is not yet running in the app, so the UI never presents a planned use as live.
 * Meta is the only runtime AI provider; speech is recognition only (no speech synthesis).
 */
export type AiUseKey =
  | "year_plan_select"
  | "news_review"
  | "future_look"
  | "soil_extraction"
  | "soil_review"
  | "crop_fit_picks"
  | "harvest_outlook_note"
  | "assistant"
  | "speech"
  | "journal_observation";

export type AiModelName = "Meta Muse Spark 1.3 (text)" | "Meta Muse Image 1.0" | "Meta speech recognition";

export type AiUse = {
  key: AiUseKey;
  title: string;
  model: AiModelName;
  /** Which screen the use appears on. */
  where: string;
  /** What the model does, one or two sentences. */
  does: string;
  /** What code does instead, one sentence. */
  code: string;
  /** Why it helps the farmer, one sentence. */
  benefit: string;
  status: "live" | "planned";
};

export const AI_USES: Record<AiUseKey, AiUse> = {
  year_plan_select: {
    key: "year_plan_select",
    title: "Choosing your three year plans",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Plan tab",
    does: "Reads the code-scored shortlist of crop sequences, picks three distinct plans, labels them and writes at most three plain-language reasons for each.",
    code: "Code enumerates candidates inside sourced sowing windows and scores them: price 40, yield 30, soil and rotation 15, water 10, confidence 5. The model never invents a crop, a date or a number.",
    benefit: "Three understandable choices instead of a table of scores.",
    status: "live",
  },
  news_review: {
    key: "news_review",
    title: "Daily news check",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Today tab, alerts",
    does: "Once a day per farm, searches the web (built-in search, at most three queries) for cyclones, price crashes, strikes, policy changes and pest outbreaks that name the farm's crops and district, and classifies what it finds.",
    code: "Code keeps only items with a cited URL and date from that same search, drops predictions and expires old items. Forecast thresholds and mandi price drops are computed in code without a model.",
    benefit: "Alerts a farmer would otherwise hear about late.",
    status: "live",
  },
  future_look: {
    key: "future_look",
    title: "Satellite future look",
    model: "Meta Muse Image 1.0",
    where: "Today tab, satellite view",
    does: "Edits the latest satellite picture of the field into an illustration of how a later crop stage typically looks.",
    code: "Code picks the scene, masks clouds and labels the result as an illustration, never a prediction or an observation.",
    benefit: "Helps picture what the field should look like weeks ahead.",
    status: "live",
  },
  soil_extraction: {
    key: "soil_extraction",
    title: "Reading your soil report",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm tab, soil records",
    does: "Reads the uploaded report pages and extracts each printed value with its unit, method and a page quote.",
    code: "Code checks every value against the page text and the farmer confirms before anything uses it.",
    benefit: "No retyping, and every number traces back to the page.",
    status: "live",
  },
  soil_review: {
    key: "soil_review",
    title: "Soil review in plain words",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm tab, soil records",
    does: "Explains the confirmed soil values against standard soil-test ratings, the crop in the field and the crop likely to follow.",
    code: "Code rates each value (low, medium, high) from cited ranges and computes the crop's nutrient uptake; the model only explains those facts.",
    benefit: "A report becomes advice a farmer can act on.",
    status: "live",
  },
  crop_fit_picks: {
    key: "crop_fit_picks",
    title: "Top crop picks for your field",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm tab, crop fit",
    does: "Picks the top three crops from the code-ranked list for the chosen sowing date and explains each in three short points.",
    code: "Code scores every pool crop on price at harvest, yield, soil and rotation fit, water and data confidence, and compares the soil report with each crop's needs.",
    benefit: "A short, local shortlist instead of a catalogue.",
    status: "live",
  },
  harvest_outlook_note: {
    key: "harvest_outlook_note",
    title: "Harvest price outlook in words",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Today tab, price card",
    does: "Writes a one-line outlook from the computed harvest-week price range and the seasonal pattern of past years.",
    code: "Code computes the range from three years of mandi history for the same weeks; the model may not add numbers of its own.",
    benefit: "A number with a reason, not a bare range.",
    status: "live",
  },
  assistant: {
    key: "assistant",
    title: "Evara assistant",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Every tab",
    does: "Answers questions about the farm using its own records, plans and sources.",
    code: "Code supplies the data through constrained tools and checks every cited source.",
    benefit: "Ask instead of hunting through screens.",
    status: "live",
  },
  speech: {
    key: "speech",
    title: "Voice input",
    model: "Meta speech recognition",
    where: "Journal and assistant",
    does: "Turns spoken notes into text (speech recognition only; the app does not synthesise speech).",
    code: "Code stores the text only after the farmer sees it.",
    benefit: "Hands-free notes in the field.",
    status: "live",
  },
  journal_observation: {
    key: "journal_observation",
    title: "Reading journal notes",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm tab, activity",
    does: "Interprets a free-text or photo journal note into structured observations.",
    code: "Code asks the farmer to confirm each observation before it counts.",
    benefit: "Notes become usable records.",
    status: "live",
  },
};

/** Registry keys in display order (the order of the object above). */
export const AI_USE_KEYS = Object.keys(AI_USES) as AiUseKey[];

export const AI_PRIVACY_NOTE =
  "Farm data is sent with standard processing and without provider-side storage (store: false); responses are deleted after use. Only the district is shared for searches, never field coordinates.";

export const AI_PROVIDER_NOTE =
  "Meta is the only runtime AI provider in Harvest Outlook. Claude was used to build the app, not to run it.";
