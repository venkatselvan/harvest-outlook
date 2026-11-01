import type {
  FarmAlert,
  NdviReading,
  NdviSeries,
  PricePoint,
  SceneRef,
  TodayView,
  UpcomingStep,
  WeatherPoint,
} from "@harvest/contracts";
import { addDays, daysBetween } from "./model";

/**
 * SYNTHETIC TEST FIXTURE for unit tests, Playwright route mocks and interface screenshots only.
 *
 * Every number below (stage dates, NDVI, prices, weather, alerts) is invented to exercise the Today view. None of it is
 * agronomy, a mandi observation, a forecast or a satellite reading, and nothing here may be copied into the API or the
 * catalogue. Source names and URLs point at example.org so a screenshot can never be mistaken for real evidence.
 *
 * Scenario: maize (direct sowing) in Hassan sown 2026-09-15, viewed on 2026-11-01.
 */
export const FIXTURE_FARM_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_TODAY = "2026-11-01";
export const FIXTURE_SOWN = "2026-09-15";
export const FIXTURE_HARVEST = { earliest: "2027-01-03", latest: "2027-01-13" } as const;
/** A 1.2 ha square near Hassan used by the e2e workspace mock, and the matching rendered-image bbox. */
export const FIXTURE_BOUNDARY = {
  type: "Polygon" as const,
  coordinates: [[[76.1, 13.0], [76.101, 13.0], [76.101, 13.001], [76.1, 13.001], [76.1, 13.0]]],
};
const IMAGE_BBOX: [number, number, number, number] = [76.0977, 12.9978, 76.1033, 13.0032];

export const FIXTURE_STAGES: NonNullable<TodayView["timeline"]>["stages"] = [
  { id: "emergence", name: "Emergence", from: "2026-09-15", to: "2026-09-24", basis: "sourced" },
  { id: "vegetative", name: "Vegetative", from: "2026-09-25", to: "2026-11-08", basis: "sourced" },
  { id: "tasselling", name: "Tasselling and silking", from: "2026-11-09", to: "2026-11-28", basis: "sourced" },
  { id: "grain_fill", name: "Grain filling", from: "2026-11-29", to: "2026-12-28", basis: "fao_generic" },
  { id: "maturity", name: "Maturity", from: "2026-12-29", to: "2027-01-08", basis: "fao_generic" },
];

const OBSERVED_SCENES = [
  ["2026-09-12", 34],
  ["2026-09-22", 41],
  ["2026-10-02", 18],
  ["2026-10-07", 9],
  ["2026-10-12", 22],
  ["2026-10-17", 6],
  ["2026-10-22", 12],
  ["2026-10-27", 4],
] as const;
/** Synthetic field-mean NDVI per observed scene (rising through vegetative growth). */
const SCENE_NDVI = [0.21, 0.27, 0.36, 0.42, 0.49, 0.55, 0.59, 0.62];

export const itemIdFor = (date: string, i: number) =>
  `S2${i % 2 ? "B" : "A"}_MSIL2A_${date.replace(/-/g, "")}T051651_R062_T43PGP_${date.replace(/-/g, "")}T100000`;
export const LATEST_ITEM_ID = itemIdFor("2026-10-27", 7);
export const ILLUSTRATION_DATE = "2026-12-10";

export const FIXTURE_ALERT_IDS = {
  weather: "5f0c6b1e-1a2b-4c3d-8e4f-000000000001",
  price: "5f0c6b1e-1a2b-4c3d-8e4f-000000000002",
  threat: "5f0c6b1e-1a2b-4c3d-8e4f-000000000003",
} as const;

function stats(mean: number, clearFraction: number) {
  return {
    mean,
    median: mean,
    p10: Math.round((mean - 0.08) * 100) / 100,
    p90: Math.round((mean + 0.07) * 100) / 100,
    clearPixels: Math.round(120 * clearFraction),
    totalPixels: 120,
    clearFraction,
    cloudOrShadowFraction: Math.round((1 - clearFraction) * 100) / 100,
    b04P95: 1840,
    usable: clearFraction >= 0.6,
    rejection: clearFraction >= 0.6 ? null : ("low_clear_fraction" as const),
  };
}

function scenes(farmId: string): SceneRef[] {
  const observed: SceneRef[] = OBSERVED_SCENES.map(([date, cloud], i) => {
    const itemId = itemIdFor(date, i);
    return {
      date,
      kind: "observed",
      itemId,
      acquisitionDate: date,
      cloudPct: cloud,
      imagePath: `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=visual`,
      ndviImagePath: `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=ndvi`,
      derivedFromItemId: null,
      stageId: null,
    };
  });
  return [
    ...observed,
    {
      date: ILLUSTRATION_DATE,
      kind: "illustration",
      itemId: null,
      acquisitionDate: null,
      cloudPct: null,
      imagePath: `/api/v1/farms/${farmId}/ndvi/${LATEST_ITEM_ID}/future?stageId=grain_fill`,
      ndviImagePath: null,
      derivedFromItemId: LATEST_ITEM_ID,
      stageId: "grain_fill",
    },
  ];
}

function ndvi(farmId: string): NdviSeries {
  const readings: NdviReading[] = OBSERVED_SCENES.map(([date, cloud], i) => {
    const clear = Math.round((1 - cloud / 100) * 100) / 100;
    const field = stats(SCENE_NDVI[i]!, clear);
    return {
      itemId: itemIdFor(date, i),
      date,
      acquiredAt: `${date}T05:16:51Z`,
      tileId: "43PGP",
      baseline: "05.11",
      offsetApplied: true,
      sceneCloudPct: cloud,
      usable: field.usable,
      field,
      neighbourhood: stats(Math.round((SCENE_NDVI[i]! - 0.04) * 100) / 100, clear),
    };
  });
  return {
    farmId,
    status: "available",
    reason: null,
    window: { from: "2026-09-01", to: FIXTURE_TODAY },
    polygonBasis: "boundary",
    polygonPixels: 120,
    smallField: false,
    imageBbox: IMAGE_BBOX,
    scenesListed: 8,
    scenesAnalysed: 8,
    scenesPending: 0,
    scenesFailed: 0,
    readings,
    latestUsable: readings.at(-1)!,
    method: { version: "fixture-1", sclClassesKept: [4, 5, 6], minClearFraction: 0.6, minClearPixels: 8, maxSceneCloudPct: 60 },
    attribution: "Test fixture shaped like Copernicus Sentinel-2 L2A",
    limitations: ["Test fixture: NDVI values are invented."],
  };
}

/** Weekly observed points for the 12 months before today, then weekly seasonal-reference points to the harvest. */
export function fixturePriceTrack(): PricePoint[] {
  const points: PricePoint[] = [];
  for (let i = 0; i < 52; i++) {
    const p50 = Math.round((20 + 2.2 * (i / 51) + 0.6 * Math.sin(i / 3)) * 10) / 10;
    points.push({ date: addDays("2025-11-03", i * 7), kind: "observed", p50, range: { low: Math.round((p50 - 1.4) * 10) / 10, high: Math.round((p50 + 1.4) * 10) / 10 }, unit: "INR/kg" });
  }
  for (let i = 0; i < 11; i++) {
    const p50 = Math.round((20.6 + 0.12 * i) * 10) / 10;
    points.push({ date: addDays("2026-11-02", i * 7), kind: "reference", p50, range: { low: Math.round((p50 - 2.1) * 10) / 10, high: Math.round((p50 + 2.4) * 10) / 10 }, unit: "INR/kg" });
  }
  return points;
}

/** Daily: observed before today, a 16-day forecast from today, typical (three-year climatology) after. */
export function fixtureWeatherTrack(from: string, to: string, today = FIXTURE_TODAY): WeatherPoint[] {
  const days = daysBetween(from, to);
  const points: WeatherPoint[] = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(from, i);
    const ahead = daysBetween(today, date);
    const kind = ahead < 0 ? "observed" : ahead <= 15 ? "forecast" : "typical";
    const tMaxC = Math.round((29 + 2 * Math.sin(i / 9) - (date >= "2026-12-01" ? 1.5 : 0)) * 10) / 10;
    const rainMm = kind === "typical" ? 1.8 : i % 7 === 3 ? 12.4 : i % 5 === 0 ? 3 : 0;
    points.push({
      date,
      kind,
      rainMm,
      tMinC: Math.round((tMaxC - 9.5) * 10) / 10,
      tMaxC,
      basis:
        kind === "observed"
          ? { source: "Weather archive (test fixture)", issuedAt: null, years: null }
          : kind === "forecast"
            ? { source: "Weather forecast (test fixture)", issuedAt: `${today}T00:00:00Z`, years: null }
            : { source: "Weather archive climatology (test fixture)", issuedAt: null, years: [2023, 2024, 2025] },
    });
  }
  return points;
}

function alerts(farmId: string): FarmAlert[] {
  return [
    {
      id: FIXTURE_ALERT_IDS.weather,
      farmId,
      type: "weather",
      severity: "watch",
      origin: "rule",
      title: "Heavy rain expected on 4 Nov",
      detail: "The forecast shows more than 40 mm of rain in 24 hours over the field point. Standing water can damage young maize roots.",
      source: { name: "Forecast fixture", url: "https://example.org/forecast", date: "2026-11-01" },
      validFrom: "2026-11-01",
      validTo: "2026-11-05",
      suggestedStep: "Clear field drains before 4 Nov",
      createdAt: "2026-11-01T03:00:00Z",
    },
    {
      id: FIXTURE_ALERT_IDS.price,
      farmId,
      type: "price",
      severity: "info",
      origin: "rule",
      title: "Maize prices fell 9% in 30 days",
      detail: "The state weekly median moved from ₹23.5 to ₹21.4 per kg. Harvest is still two months away.",
      source: { name: "Mandi price fixture", url: "https://example.org/mandi", date: "2026-10-30" },
      validFrom: "2026-10-30",
      validTo: "2026-11-13",
      suggestedStep: null,
      createdAt: "2026-10-30T03:00:00Z",
    },
    {
      id: FIXTURE_ALERT_IDS.threat,
      farmId,
      type: "crop_threat",
      severity: "warning",
      origin: "rule",
      title: "Leaf-feeding pest window for vegetative maize",
      detail: "The crop advisory fixture lists this stage as the main window for leaf-feeding caterpillars in the district.",
      source: { name: "Crop advisory fixture", url: "https://example.org/advisory", date: "2026-10-20" },
      validFrom: "2026-10-20",
      validTo: "2026-11-15",
      suggestedStep: "Scout 20 plants for fresh leaf damage this week",
      createdAt: "2026-10-20T03:00:00Z",
    },
  ];
}

function upcoming(): UpcomingStep[] {
  const careTask = (id: string, title: string, action: string, dueFrom: string, dueTo: string, status: "due" | "upcoming") => ({
    id,
    actionId: id,
    cycleId: "maize-cycle",
    cropId: "maize",
    title,
    action,
    anchor: "direct_sowing",
    dueFrom,
    dueTo,
    conditions: ["Use field observations; a calendar date is not a field reading."],
    sourceRefs: [{ sourceId: "care-source", locator: "Crop guide fixture" }],
    status,
    completedOn: null,
    journalEntryId: null,
    evidenceState: "source_schedule" as const,
  });
  return [
    {
      id: "care:task-moisture",
      kind: "care_task",
      title: "Check field moisture",
      detail: "Inspect the field before deciding on irrigation.",
      dueFrom: "2026-10-31",
      dueTo: "2026-11-02",
      status: "due",
      careTask: careTask("task-moisture", "Check field moisture", "Inspect the field before deciding on irrigation.", "2026-10-31", "2026-11-02", "due"),
      alertId: null,
    },
    {
      id: `alert:${FIXTURE_ALERT_IDS.weather}`,
      kind: "alert_step",
      title: "Clear field drains before 4 Nov",
      detail: "From the heavy rain alert.",
      dueFrom: "2026-11-01",
      dueTo: "2026-11-03",
      status: "due",
      careTask: null,
      alertId: FIXTURE_ALERT_IDS.weather,
    },
    {
      id: "care:task-scout",
      kind: "care_task",
      title: "Scout for leaf damage",
      detail: "Walk the field and look for fresh feeding marks.",
      dueFrom: "2026-11-05",
      dueTo: "2026-11-10",
      status: "upcoming",
      careTask: careTask("task-scout", "Scout for leaf damage", "Walk the field and look for fresh feeding marks.", "2026-11-05", "2026-11-10", "upcoming"),
      alertId: null,
    },
    {
      id: "stage:tasselling",
      kind: "stage_transition",
      title: "Tasselling and silking begins",
      detail: null,
      dueFrom: "2026-11-09",
      dueTo: "2026-11-09",
      status: "upcoming",
      careTask: null,
      alertId: null,
    },
  ];
}

const monitoring = {
  enabled: true,
  lastCheckedAt: "2026-11-01T03:00:00Z",
  nextCheckAt: "2026-11-02T03:00:00Z",
};

/** The full maize scenario. Pass another farm id to get the same data owned by that farm. */
export function todayFixture(farmId = FIXTURE_FARM_ID): TodayView {
  return {
    farmId,
    asOf: "2026-11-01T04:30:00Z",
    today: FIXTURE_TODAY,
    cycle: {
      id: "maize-cycle",
      cropId: "maize",
      cropName: "Maize",
      productId: "maize-grain",
      productName: "Maize grain",
      sowingDate: FIXTURE_SOWN,
      establishmentDate: FIXTURE_SOWN,
      establishmentMethod: "direct_sowing",
      stage: "growing",
    },
    product: { productId: "maize-grain", productName: "Maize grain", cropName: "Maize" },
    timeline: {
      cropId: "maize",
      productId: "maize-grain",
      establishmentMethod: "direct_sowing",
      anchorDate: FIXTURE_SOWN,
      stages: FIXTURE_STAGES.map((stage) => ({ ...stage })),
      harvest: { ...FIXTURE_HARVEST },
      basis: { kind: "duration", label: "Stage days from a test fixture", sourceId: null, url: null, scope: "Hassan", note: "Synthetic stage lengths for interface checks." },
    },
    slider: {
      from: FIXTURE_SOWN,
      to: FIXTURE_HARVEST.latest,
      todayProgress: daysBetween(FIXTURE_SOWN, FIXTURE_TODAY) / daysBetween(FIXTURE_SOWN, FIXTURE_HARVEST.latest),
    },
    daysToHarvest: {
      earliest: daysBetween(FIXTURE_TODAY, FIXTURE_HARVEST.earliest),
      latest: daysBetween(FIXTURE_TODAY, FIXTURE_HARVEST.latest),
    },
    scenes: scenes(farmId),
    ndvi: ndvi(farmId),
    health: {
      date: "2026-10-27",
      ndviMean: 0.62,
      neighbourhoodMean: 0.58,
      typicalRange: { low: 0.55, high: 0.7 },
      verdict: "near_typical",
      clearFraction: 0.96,
      basis: { kind: "ndvi", label: "Satellite field mean (test fixture)", sourceId: null, url: null, scope: "field", note: "Typical range for the vegetative stage is invented for the fixture." },
    },
    priceTrack: fixturePriceTrack(),
    harvestPrice: {
      p50: 21.4,
      range: { low: 19.2, high: 23.8 },
      status: "available",
      reason: null,
      scopeLabel: "Based on 3 years of Karnataka mandi prices (test fixture)",
    },
    weatherTrack: fixtureWeatherTrack(FIXTURE_SOWN, FIXTURE_HARVEST.latest),
    alerts: alerts(farmId),
    newsReview: { status: "active", reason: null, lastReviewedAt: "2026-11-01T03:10:00Z" },
    imdStatus: "not_connected",
    upcoming: upcoming(),
    nextAction: upcoming()[0]!,
    outlookNote: {
      status: "ready",
      text: "Maize grain in Karnataka has usually fetched ₹19 to ₹24 per kg around harvest, close to the yearly average.",
      facts: [
        "Likely price in the harvest weeks: ₹19 to ₹24 per kg (middle half of past years), typical ₹21 per kg",
        "Harvest weeks usually run close to the yearly average price",
        "Years used: 2023, 2024, 2025 (3 years)",
      ],
      origin: "model",
      generatedAt: "2026-11-01T04:20:00Z",
      modelInvocation: null,
    },
    monitoring,
    limitations: ["Test fixture: every value on this view is synthetic.", "Direct IMD feed not connected (needs a key); official warnings are searched daily."],
  };
}

/** A farm with no current crop: no timeline or slider, but weather and alerts still arrive. */
export function todayEmptyFixture(farmId = FIXTURE_FARM_ID): TodayView {
  return {
    farmId,
    asOf: "2026-11-01T04:30:00Z",
    today: FIXTURE_TODAY,
    cycle: null,
    product: null,
    timeline: null,
    slider: null,
    daysToHarvest: null,
    scenes: [],
    ndvi: null,
    health: null,
    priceTrack: [],
    harvestPrice: null,
    weatherTrack: fixtureWeatherTrack(FIXTURE_TODAY, addDays(FIXTURE_TODAY, 15)),
    alerts: [alerts(farmId)[0]!],
    newsReview: { status: "paused", reason: "daily_cap", lastReviewedAt: null },
    imdStatus: "not_connected",
    upcoming: [],
    nextAction: null,
    outlookNote: null,
    monitoring,
    limitations: ["Test fixture: every value on this view is synthetic."],
  };
}
