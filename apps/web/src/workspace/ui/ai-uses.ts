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
  | "today_overview"
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
    title: "Comparing your crop plans",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Plan tab",
    does: "Helps choose and explain crop sequences from the scored options for your field. The calendar includes saved seasons and crops already growing.",
    code: "Code checks sowing windows, field availability, soil, water and rotation, then computes scores and estimated returns. Edited plans are scored again from those inputs.",
    benefit: "Compare plans, inspect a season, and see how your own changes affect the choices.",
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
    title: "Satellite predicted look",
    model: "Meta Muse Image 1.0",
    where: "Today tab, satellite view",
    does: "Edits the latest real satellite picture of the field to show how its green cover is expected to look on a later date or stage.",
    code: "Code picks the scene, writes the expected change from the calendar stage, the field's own greenness curve and the weather, keeps every pixel outside the field, and labels the result as predicted with AI, never an observation.",
    benefit: "Preview a possible later appearance, compare it with observations, or request another prediction.",
    status: "live",
  },
  soil_extraction: {
    key: "soil_extraction",
    title: "Reading your soil report",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm details, soil reports",
    does: "Reads the uploaded report pages and extracts each printed value with its unit, method and a page quote.",
    code: "Code checks every value against the page text and the farmer confirms before anything uses it.",
    benefit: "No retyping, and every number traces back to the page.",
    status: "live",
  },
  soil_review: {
    key: "soil_review",
    title: "Soil review in plain words",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Farm details, soil reports",
    does: "Explains the confirmed soil values against standard soil-test ratings, the crop in the field and the crop likely to follow.",
    code: "Code rates each value (low, medium, high) from cited ranges and computes the crop's nutrient uptake; the model only explains those facts.",
    benefit: "A report becomes advice a farmer can act on.",
    status: "live",
  },
  crop_fit_picks: {
    key: "crop_fit_picks",
    title: "Top crop picks for your field",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Crop library and crop picker",
    does: "Explains a shortlist of scored crops for the chosen sowing date, including relevant crop combinations and options to replace a planned crop.",
    code: "Code scores every pool crop on price at harvest, yield, soil and rotation fit, water and data confidence, and compares the soil report with each crop's needs.",
    benefit: "A short, local shortlist instead of a catalogue.",
    status: "live",
  },
  harvest_outlook_note: {
    key: "harvest_outlook_note",
    title: "Harvest price outlook in words",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Today, harvest outlook",
    does: "Writes a one-line outlook from the computed harvest-week price range and the seasonal pattern of past years.",
    code: "Code computes the range from three years of mandi history for the same weeks; the model may not add numbers of its own.",
    benefit: "A number with a reason, not a bare range.",
    status: "live",
  },
  today_overview: {
    key: "today_overview",
    title: "Today overview",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Today, Today for you",
    does: "Turns the facts the code computed for today into a headline and up to five points that say what to do and why, in plain words.",
    code: "Code computes every fact and number, resolves the links to steps, alerts and cards, and rejects any number the facts do not hold. A code-written version is always available.",
    benefit: "What today's numbers mean for you and what to do next, not just a list of figures.",
    status: "live",
  },
  assistant: {
    key: "assistant",
    title: "Evara assistant",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Every tab",
    does: "Answers questions using the chat’s farm records, current crops, weather, soil and plans. Responses can include cards and actions that open the relevant screen.",
    code: "Code supplies the data through constrained tools and checks every cited source.",
    benefit: "Keep a conversation as you move between screens, revisit past chats by farm, and expand the panel for more room.",
    status: "live",
  },
  speech: {
    key: "speech",
    title: "Voice input",
    model: "Meta speech recognition",
    where: "Journal and assistant",
    does: "Turns spoken notes into text (speech recognition only; the app does not synthesise speech).",
    code: "Code inserts the transcript into the draft for you to review before sending or saving.",
    benefit: "Speak a question or note, review the transcript, then send it.",
    status: "live",
  },
  journal_observation: {
    key: "journal_observation",
    title: "Reading journal notes",
    model: "Meta Muse Spark 1.3 (text)",
    where: "Journal, recorded observations",
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
  "Meta provides the AI features shown here. Availability depends on the live service and the evidence available for your farm.";
