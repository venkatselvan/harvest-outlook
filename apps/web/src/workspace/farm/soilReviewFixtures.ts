import { SoilReview, type SoilRatingBand, type SoilReading } from "@harvest/contracts";

/**
 * SYNTHETIC fixtures for the soil biomarker view and its tests. The values mirror the shape of the Hassan farm's confirmed
 * report (pH 7.2, EC 0.86, unspecified N 278 kg/ha, organic matter 2.4 %, total P 16 and total K 186 kg/ha) and the bands
 * copy data/research/soil/soil-ratings.json; none of it is a live server answer. Every fixture parses with SoilReview.parse.
 */
export const SOIL_FIXTURE_FARM_ID = "11111111-1111-4111-8111-111111111111";
const SAMPLE_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-01T06:00:00.000Z";

const DAC = {
  id: "dac-2011-table-1",
  title: "Methods Manual: Soil Testing in India, Department of Agriculture & Cooperation (January 2011), Table 1 Soil Fertility Ratings",
  url: "https://biharsoilhealth.in/documents/manualgoi.pdf",
  locator: "Section 4.1 Table 1, printed page 33 (PDF page 34)",
  verified: true,
};
const NRCS = {
  id: "nrcs-ssm-2017-table-3-15",
  title: "Soil Survey Manual 2017 (USDA NRCS), Table 3-15 Reaction Class Terms and Their Ranges in pH",
  url: "https://www.nrcs.usda.gov/sites/default/files/2022-09/The-Soil-Survey-Manual.pdf",
  locator: "Chapter 3, Table 3-15, printed pages 199-200",
  verified: true,
};
const TNAU = {
  id: "tnau-soil-rating-chart",
  title: "Resource Management, Soil, Soil Rating Chart, TNAU Agritech Portal (c) TNAU 2016, total soluble salts table",
  url: "https://agritech.tnau.ac.in/agriculture/agri_soil_soilratingchart.html",
  locator: "Total soluble salts (electrical conductivity)",
  verified: true,
};

const band = (label: SoilRatingBand["label"], from: number | null, to: number | null, note: string): SoilRatingBand => ({ label, from, to, note });
const PH_BANDS = [
  band("strongly_acidic", null, 5.6, "Ultra acid to strongly acid, 5.5 and below"),
  band("acidic", 5.6, 6.6, "Moderately and slightly acid, 5.6 to 6.5"),
  band("neutral", 6.6, 7.4, "Neutral, 6.6 to 7.3"),
  band("alkaline", 7.4, 8.5, "Slightly and moderately alkaline, 7.4 to 8.4"),
  band("strongly_alkaline", 8.5, null, "Strongly and very strongly alkaline, 8.5 and above"),
];
const EC_BANDS = [
  band("normal", null, 1, "Below 1 dS/m, normal"),
  band("critical", 1, 2, "1 to 2, critical for germination"),
  band("critical", 2, 4, "2 to 4, critical for growth of sensitive crops (upper limit included)"),
  band("injurious", 4, null, "Above 4, injurious to most crops"),
];
const OC_BANDS = [band("low", null, 0.5, "Below 0.5 %"), band("medium", 0.5, 0.75, "0.5 to 0.75 % (upper limit included)"), band("high", 0.75, null, "Above 0.75 %")];
const N_BANDS = [band("low", null, 280, "Below 280 kg/ha"), band("medium", 280, 560, "280 to 560 kg/ha (upper limit included)"), band("high", 560, null, "Above 560 kg/ha")];
const P_BANDS = [band("low", null, 10, "Below 10 kg P/ha"), band("medium", 10, 24.6, "10 to 24.6 kg P/ha (upper limit included)"), band("high", 24.6, null, "Above 24.6 kg P/ha")];
const K_BANDS = [band("low", null, 108, "Below 108 kg K/ha"), band("medium", 108, 280, "108 to 280 kg K/ha (upper limit included)"), band("high", 280, null, "Above 280 kg K/ha")];

const base = {
  sampleId: SAMPLE_ID,
  reportId: REPORT_ID,
  collectionDate: "2026-09-15",
  method: null,
  cropNeed: null,
  nextCropNeed: null,
  assumption: null,
  note: null,
} as const;

const paddyNeed = (need: "low" | "medium" | "high", note: string) => ({ cropId: "paddy", cropName: "Paddy", need, note });
const groundnutNeed = (need: "low" | "medium" | "high") => ({
  cropId: "groundnut",
  cropName: "Groundnut",
  need,
  note: `Groundnut's nutrient need is ${need} at the regional median yield.`,
});

export const HASSAN_READINGS: SoilReading[] = [
  { ...base, markerId: "ph", parameter: "ph", label: "pH", value: 7.2, unit: "-", ratedValue: 7.2, ratedUnit: "pH", rating: "neutral", status: "rated", bands: PH_BANDS, axis: { min: 4, max: 10 }, source: NRCS },
  {
    ...base, markerId: "ec", parameter: "electrical_conductivity", label: "EC", value: 0.86, unit: "ds/m", ratedValue: 0.86, ratedUnit: "dS/m", rating: "normal", status: "rated", bands: EC_BANDS, axis: { min: 0, max: 5 }, source: TNAU,
    note: "The report does not state the extract; the source does not either, so the report's soil to water ratio is shown separately and is not corrected.",
  },
  {
    ...base, markerId: "n", parameter: "nitrogen_unspecified", label: "Nitrogen", value: 278, unit: "kg/ha", ratedValue: 278, ratedUnit: "kg/ha", rating: "low", status: "rated", bands: N_BANDS, axis: { min: 0, max: 840 }, source: DAC,
    assumption: 'The report prints "Nitrogen" without saying which nitrogen pool; rated as available N (alkaline permanganate), the usual soil health card form in kg/ha.',
    note: "The report does not state the nitrogen method; the rating is defined for alkaline permanganate nitrogen.",
    cropNeed: paddyNeed("high", "Paddy takes up about 130 kg N/ha at the regional median yield of 5000 kg/ha."), nextCropNeed: groundnutNeed("medium"),
  },
  {
    ...base, markerId: "om", parameter: "organic_matter", label: "Total organic matter", value: 2.4, unit: "%", ratedValue: 1.392, ratedUnit: "%", rating: "high", status: "rated", bands: OC_BANDS, axis: { min: 0, max: 1.5 }, source: DAC,
    assumption: "The report gives organic matter (2.4 %), not organic carbon; converted to organic carbon (1.392 %) with the DAC manual factor 0.58 and rated on the organic carbon bands.",
  },
  {
    ...base, markerId: "p", parameter: "phosphorus_total", label: "Total Phosphorus", value: 16, unit: "kg/ha", ratedValue: 16, ratedUnit: "kg P/ha", rating: "medium", status: "rated", bands: P_BANDS, axis: { min: 0, max: 40 }, source: DAC,
    assumption: 'The report labels this "Total Phosphorus", but a kg/ha figure on a soil report is normally the available form; rated as available P (Olsen). Confirm with the laboratory.',
    note: "The report does not state the phosphorus method; the rating is defined for Olsen phosphorus.",
    cropNeed: paddyNeed("medium", "Paddy takes up about 40 kg P2O5/ha at the regional median yield of 5000 kg/ha."), nextCropNeed: groundnutNeed("low"),
  },
  {
    ...base, markerId: "k", parameter: "potassium_total", label: "Total potassium", value: 186, unit: "kg/ha", ratedValue: 186, ratedUnit: "kg K/ha", rating: "medium", status: "rated", bands: K_BANDS, axis: { min: 0, max: 420 }, source: DAC,
    assumption: 'The report labels this "Total potassium", but a kg/ha figure on a soil report is normally the available form; rated as available K (ammonium acetate). Confirm with the laboratory.',
    note: "The report does not state the potassium method; the rating is defined for neutral normal ammonium acetate potassium.",
    cropNeed: paddyNeed("medium", "Paddy takes up about 80 kg K2O/ha at the regional median yield of 5000 kg/ha."), nextCropNeed: groundnutNeed("low"),
  },
];

/** A zinc result printed as "less than 0.5" cannot be rated; it is listed under "Other values" with its reason. */
export const UNRATED_ZINC: SoilReading = {
  ...base, markerId: "zn", parameter: "zinc_available", label: "Zinc (DTPA)", value: 0.5, unit: "ppm", ratedValue: null, ratedUnit: null, rating: "unrated", status: "qualifier", bands: [], axis: null, source: null,
  note: "Printed as a range, limit, below-detection or text result; a single exact value is needed to rate.",
};

const FACTS = [
  "6 confirmed soil values: 6 rated against cited bands, 0 shown as printed.",
  "Nutrient ratings: 1 low, 2 medium, 1 high.",
  "Soil pH 7.2 rates neutral.",
  "Paddy is usually grown at pH 5.5 to 7.5; the field pH 7.2 is inside that range.",
  "Salinity (EC) 0.86 dS/m rates normal.",
  "Limiting for Paddy: nitrogen (soil low, crop need high).",
  "Paddy is expected to take up about 130 kg N/ha at the regional median yield of 5000 kg/ha.",
  "Next crop Groundnut: nutrient need at the regional median yield is nitrogen medium, phosphorus low, potassium low.",
  "Groundnut can leave about 54 to 58 kg N/ha for the crop after it.",
  "4 rated values rest on an inferred form and are flagged in the list.",
];
const LIMITATIONS = [
  "Ratings compare each confirmed value with cited soil-test bands (see each value's source). They are not fertilizer doses or crop advice.",
  "4 rated values did not print the extraction method; the bands were applied on the method they are defined for.",
];

const shell = {
  reviewId: REVIEW_ID,
  jobId: JOB_ID,
  farmId: SOIL_FIXTURE_FARM_ID,
  contextHash: "fixture-hash-hassan",
  stale: false,
  currentCrop: { cycleId: "cycle-1", cropId: "paddy", cropName: "Paddy" },
  nextCrop: { cropId: "groundnut", cropName: "Groundnut", source: "year_plan_applied" as const },
  facts: FACTS,
  ratingsVersion: "2026-11-01",
  limitations: LIMITATIONS,
};

const MODEL_NARRATIVE = {
  lines: [
    "Soil pH 7.2 rates neutral and salinity is normal.",
    "Nitrogen rates low, on an assumed form, against a high need.",
    "Phosphorus and potassium rate medium on assumed forms.",
  ],
  afterHarvest: ["Paddy is expected to take up about 130 kg N/ha.", "Groundnut can leave about 54 to 58 kg N/ha."],
  nextCrop: ["Groundnut needs medium nitrogen and low phosphorus and potassium."],
};

export const readyModelReview: SoilReview = SoilReview.parse({
  ...shell,
  status: "ready",
  generatedAt: NOW,
  modelInvocation: { id: "66666666-6666-4666-8666-666666666666", provider: "meta", requestedModel: "muse-spark-1.3", model: "muse-spark-1.3", purpose: "soil_review", status: "succeeded", startedAt: NOW, finishedAt: NOW, processing: "standard", requestedStorage: false, responseDeleted: true },
  readings: HASSAN_READINGS,
  narrative: MODEL_NARRATIVE,
  narrativeOrigin: "model",
});

export const readyCodeReview: SoilReview = SoilReview.parse({
  ...shell,
  status: "ready",
  generatedAt: NOW,
  modelInvocation: null,
  readings: HASSAN_READINGS,
  narrative: {
    lines: ["Soil pH 7.2 rates neutral.", "Salinity (EC) 0.86 dS/m rates normal.", "For Paddy, nitrogen needs attention."],
    afterHarvest: ["Paddy is expected to take up about 130 kg N/ha."],
    nextCrop: ["Groundnut needs: nitrogen medium, phosphorus low, potassium low."],
  },
  narrativeOrigin: "deterministic",
  limitations: [...LIMITATIONS, "Meta was not available in this runtime, so the review was written by code from the same facts."],
});

/** Code readings are filled in at once while the narrative job runs. */
export const pendingSoilReview: SoilReview = SoilReview.parse({ ...shell, status: "pending", generatedAt: null, modelInvocation: null, readings: HASSAN_READINGS, narrative: null, narrativeOrigin: null });

export const errorSoilReview: SoilReview = SoilReview.parse({ ...shell, status: "error", generatedAt: null, modelInvocation: null, readings: HASSAN_READINGS, narrative: null, narrativeOrigin: null });

export const withUnratedReview: SoilReview = SoilReview.parse({
  ...shell,
  status: "ready",
  generatedAt: NOW,
  modelInvocation: null,
  readings: [...HASSAN_READINGS, UNRATED_ZINC],
  narrative: readyCodeReview.narrative,
  narrativeOrigin: "deterministic",
});

export const noReportSoilReview: SoilReview = SoilReview.parse({
  reviewId: null, jobId: null, farmId: SOIL_FIXTURE_FARM_ID, contextHash: null, status: "no_report", stale: false, generatedAt: null, modelInvocation: null, readings: [],
  currentCrop: null, nextCrop: null, facts: [], narrative: null, narrativeOrigin: null, ratingsVersion: "2026-11-01",
  limitations: ["No confirmed soil report for this field yet. Upload a report and confirm its values to see them rated."],
});
