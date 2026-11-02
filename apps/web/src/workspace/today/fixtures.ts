import type {
  BasisRef,
  CarbonFootprint,
  EnergyFootprint,
  FarmAlert,
  FieldConditionPoint,
  FieldConditions,
  HarvestEconomics,
  IndexId,
  IndexStageReading,
  IndexSummaries,
  NdviReading,
  NdviSeries,
  OverviewFact,
  OverviewPoint,
  PricePoint,
  RainClass,
  ResidueIncome,
  SceneRef,
  TodayOverview,
  TodayView,
  UpcomingStep,
  WeatherPoint,
} from "@harvest/contracts";
import { addDays, daysBetween, stageAt } from "./model";

/**
 * SYNTHETIC TEST FIXTURE for unit tests, Playwright route mocks and interface screenshots only.
 *
 * Every number below (stage dates, NDVI, prices, weather, alerts) is invented to exercise the Today view. None of it is
 * agronomy, a mandi observation, a forecast or a satellite reading, and nothing here may be copied into the API or the
 * catalogue. Source names and URLs point at example.org so a screenshot can never be mistaken for real evidence.
 *
 * Scenario: maize (direct sowing) in Hassan sown 2026-09-15, viewed on 2026-11-01.
 *
 * The economics and footprint blocks (profit, residue income, energy, carbon) belong to the same maize cycle on 1.2 ha:
 * invented yields, prices, residue ratios, energy and emission figures that exercise the four cards. They are not research
 * data and must not be copied into the API.
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
/**
 * Field-zoom render window (spec section 10.1 item 1): a square of 1.6 x the larger field side (about 111 m, so about
 * 178 m), centred on the field, rounded to 4 decimals. Synthetic like the rest of the fixture.
 */
export const FIXTURE_FIELD_BBOX: [number, number, number, number] = [76.0997, 12.9997, 76.1013, 13.0013];

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

/** Invented multiples of the scene NDVI, so the other indices move with it. Not agronomy and not a reading. */
const INDEX_FROM_NDVI: Record<IndexId, number> = { evi: 0.78, ndre: 0.5, gndvi: 0.86, savi: 0.72, ndmi: 0.29, lswi: 0.26, ndwi: -0.73 };
const round2 = (value: number) => Math.round(value * 100) / 100;
/** Synthetic index summaries for one scene, derived from its NDVI mean (the spread is a fixed +/- 0.05). */
export function indicesFor(ndviMean: number): IndexSummaries {
  const entry = (id: IndexId) => {
    const mean = round2(ndviMean * INDEX_FROM_NDVI[id]);
    return { mean, median: mean, p10: round2(mean - 0.05), p90: round2(mean + 0.05) };
  };
  return { evi: entry("evi"), ndre: entry("ndre"), gndvi: entry("gndvi"), savi: entry("savi"), ndmi: entry("ndmi"), lswi: entry("lswi"), ndwi: entry("ndwi") };
}

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
    indices: indicesFor(mean),
  };
}

function scenes(farmId: string): SceneRef[] {
  const observed: SceneRef[] = OBSERVED_SCENES.map(([date, cloud], i) => {
    const itemId = itemIdFor(date, i);
    // Every scene but the latest has its field-zoom render; the latest (27 Oct) is "not rendered yet" (null), so the
    // fixture exercises both the crisp 10 m view and the 600 m fallback.
    const field = i < OBSERVED_SCENES.length - 1;
    return {
      date,
      kind: "observed",
      itemId,
      acquisitionDate: date,
      cloudPct: cloud,
      imagePath: `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=visual`,
      ndviImagePath: `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=ndvi`,
      fieldImagePath: field ? `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=visual&zoom=field` : null,
      fieldNdviImagePath: field ? `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=ndvi&zoom=field` : null,
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
      fieldImagePath: null,
      fieldNdviImagePath: null,
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

/**
 * Invented weather days that give the season progression something to show: a moderate shower, a heavy-rain day that
 * ponds the field, a two-day heat spell, a very heavy day and the forecast rain behind the 4 Nov alert. Synthetic.
 */
export const FIXTURE_WEATHER_DAYS: Readonly<Record<string, { rainMm?: number; tMaxC?: number }>> = {
  "2026-09-19": { rainMm: 17 },
  "2026-09-27": { rainMm: 0 },
  "2026-09-28": { rainMm: 82 },
  "2026-10-04": { rainMm: 0 },
  "2026-10-05": { rainMm: 0, tMaxC: 40.6 },
  "2026-10-06": { rainMm: 0, tMaxC: 41.2 },
  "2026-10-14": { rainMm: 128 },
  "2026-11-03": { rainMm: 22 },
  "2026-11-04": { rainMm: 48 },
};

/** Daily: observed before today, a 16-day forecast from today, typical (three-year climatology) after. */
export function fixtureWeatherTrack(from: string, to: string, today = FIXTURE_TODAY): WeatherPoint[] {
  const days = daysBetween(from, to);
  const points: WeatherPoint[] = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(from, i);
    const ahead = daysBetween(today, date);
    const kind = ahead < 0 ? "observed" : ahead <= 15 ? "forecast" : "typical";
    const special = FIXTURE_WEATHER_DAYS[date];
    const tMaxC = special?.tMaxC ?? Math.round((29 + 2 * Math.sin(i / 9) - (date >= "2026-12-01" ? 1.5 : 0)) * 10) / 10;
    const rainMm = special?.rainMm ?? (kind === "typical" ? 1.8 : i % 7 === 3 ? 12.4 : i % 5 === 0 ? 3 : 0);
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

// ---------------------------------------------------------------- daily field conditions (spec section 10)

/** Lower bound (mm) of each IMD daily rainfall class, as section 10.1 item 4 quotes them. The API engine is the authority. */
const RAIN_CLASS_FROM: readonly [RainClass, number][] = [
  ["extremely_heavy", 204.5],
  ["very_heavy", 115.6],
  ["heavy", 64.5],
  ["moderate", 15.6],
  ["light", 2.5],
  ["very_light", 0.1],
];
export function fixtureRainClass(mm: number | null): RainClass {
  if (mm == null) return "unknown";
  return RAIN_CLASS_FROM.find(([, from]) => mm >= from)?.[0] ?? "none";
}
/** Synthetic greenness verdict per observed scene (index into OBSERVED_SCENES); the 22 Sep scene is too cloudy to use. */
const SCENE_VERDICT: readonly ("above_typical" | "near_typical" | "below_typical" | "no_reference")[] = [
  "no_reference",
  "near_typical",
  "near_typical",
  "below_typical",
  "below_typical",
  "near_typical",
  "above_typical",
  "near_typical",
];
/** Heat threshold used by the fixture for maize: the project's 40 degree alert threshold (no crop figure; flagged). */
const FIXTURE_HEAT_C = 40;
const SEVERITY_RANK = { warning: 0, watch: 1, info: 2 } as const;

/**
 * SYNTHETIC daily conditions for the maize fixture, built with the same rules section 10.1 item 4 gives the API engine
 * (IMD classes; ponded on heavy rain or a 100 mm three-day sum, held two days; moist for two days after light rain or
 * more; heat stress at 40 degrees; greenness held from the latest usable scene; alerts by validity, warnings first).
 * The days it covers: dry, moist, ponded (28 to 29 Sep, 14 to 15 Oct), heat stress (5 to 6 Oct), heavy and very heavy
 * rain, forecast rain under the 4 Nov alert, typical days after the forecast and alert days from 20 Oct.
 */
export function fixtureConditions(view: Pick<TodayView, "weatherTrack" | "alerts" | "timeline" | "slider">): FieldConditions {
  const points: FieldConditionPoint[] = [];
  const slider = view.slider!;
  const weather = new Map(view.weatherTrack.map((point) => [point.date, point]));
  const usable = OBSERVED_SCENES.map(([date, cloud], i) => ({ date, i, usable: 1 - cloud / 100 >= 0.6 })).filter((scene) => scene.usable);
  let wetUntil = -1,
    pondUntil = -1;
  const days = daysBetween(slider.from, slider.to);
  for (let d = 0; d <= days; d++) {
    const date = addDays(slider.from, d);
    const w = weather.get(date) ?? null;
    const mm = w?.rainMm ?? null;
    const rainClass = fixtureRainClass(mm);
    const threeDay = [0, 1, 2].reduce((sum, back) => sum + (weather.get(addDays(date, -back))?.rainMm ?? 0), 0);
    if (rainClass === "heavy" || rainClass === "very_heavy" || rainClass === "extremely_heavy" || threeDay >= 100) pondUntil = d + 1;
    if (mm != null && mm >= 2.5) wetUntil = d + 2;
    const state = d <= pondUntil ? "ponded" : d <= wetUntil ? "moist" : w ? "dry" : "unknown";
    const reading = usable.filter((scene) => scene.date <= date).at(-1);
    const stage = stageAt(view.timeline, date);
    const events = view.alerts
      .filter((alert) => alert.validFrom <= date && (alert.validTo ? date <= alert.validTo : daysBetween(alert.validFrom, date) <= 3))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, 5)
      .map((alert) => ({ alertId: alert.id, type: alert.type, severity: alert.severity, title: alert.title }));
    points.push({
      date,
      kind: w ? w.kind : "unavailable",
      rain: { mm, class: rainClass },
      water: { state, basis: state === "ponded" ? "rain_rule" : "none" },
      heat: { tMaxC: w?.tMaxC ?? null, stress: w?.tMaxC != null && w.tMaxC >= FIXTURE_HEAT_C, thresholdC: w?.tMaxC != null ? FIXTURE_HEAT_C : null },
      greenness: reading
        ? { ndvi: SCENE_NDVI[reading.i]!, verdict: SCENE_VERDICT[reading.i]!, observedOn: reading.date, daysSince: daysBetween(reading.date, date) }
        : { ndvi: null, verdict: null, observedOn: null, daysSince: null },
      events,
      stage:
        stage.kind === "stage"
          ? {
              id: stage.stage.id,
              name: stage.stage.name,
              progress: Math.round(Math.min(1, Math.max(0, daysBetween(stage.stage.from, date) / Math.max(1, daysBetween(stage.stage.from, stage.stage.to)))) * 100) / 100,
            }
          : null,
    });
  }
  return {
    points,
    basis: [
      { kind: "climatology", label: "IMD daily rainfall classes (test fixture)", sourceId: null, url: "https://example.org/imd-rainfall-classes", scope: "India", note: "Bands as quoted in the build spec; the API engine cites the IMD page." },
      { kind: "model", label: "Ponding rule: heavy rain or 100 mm in three days, held two days (test fixture)", sourceId: null, url: null, scope: "field", note: "Engine assumption, flagged." },
      { kind: "model", label: "Heat threshold 40 degrees C, the project's alert threshold (test fixture)", sourceId: null, url: null, scope: "maize", note: "No crop figure in the fixture; flagged." },
    ],
    limitations: [
      "Test fixture: every condition is synthetic.",
      "The scene is drawn from weather records and forecasts, not seen on the field.",
    ],
  };
}

/**
 * SYNTHETIC paddy-style days for tests and static renders: standing water kept by crop practice through tillering
 * (flooded, basis crop_practice) on an observed dry day, a forecast heavy-rain day and a day with no weather record, then
 * a drained day at grain filling.
 */
export function paddyConditionPoints(): FieldConditionPoint[] {
  const base = (date: string, over: Partial<FieldConditionPoint>): FieldConditionPoint => ({
    date,
    kind: "observed",
    rain: { mm: 0, class: "none" },
    water: { state: "flooded", basis: "crop_practice" },
    heat: { tMaxC: 31, stress: false, thresholdC: 35 },
    greenness: { ndvi: 0.48, verdict: "near_typical", observedOn: "2026-08-20", daysSince: 2 },
    events: [],
    stage: { id: "tillering", name: "Tillering", progress: 0.4 },
    ...over,
  });
  return [
    base("2026-08-22", {}),
    base("2026-08-26", {
      kind: "forecast",
      rain: { mm: 92, class: "heavy" },
      greenness: { ndvi: 0.48, verdict: "near_typical", observedOn: "2026-08-20", daysSince: 6 },
      events: [{ alertId: "5f0c6b1e-1a2b-4c3d-8e4f-000000000011", type: "weather", severity: "warning", title: "Heavy rain warning for the district" }],
    }),
    base("2026-08-27", { kind: "unavailable", rain: { mm: null, class: "unknown" }, heat: { tMaxC: null, stress: false, thresholdC: null }, greenness: { ndvi: 0.48, verdict: "near_typical", observedOn: "2026-08-20", daysSince: 7 } }),
    base("2026-10-02", {
      water: { state: "dry", basis: "none" },
      heat: { tMaxC: 36.2, stress: true, thresholdC: 35 },
      greenness: { ndvi: 0.71, verdict: "above_typical", observedOn: "2026-09-29", daysSince: 3 },
      stage: { id: "flowering", name: "Flowering", progress: 0.5 },
    }),
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

const CURVE_BASIS: IndexStageReading["basis"] = {
  kind: "ndvi",
  label: "Field NDVI curve from clear satellite images (test fixture)",
  sourceId: null,
  url: null,
  scope: "field",
  note: "Phase thresholds and the green-up level are invented for the fixture.",
};
/**
 * SYNTHETIC reading of the fixture field's own NDVI curve (rising through the vegetative stage, matching the
 * calendar). Dates and values follow the invented SCENE_NDVI series; none of it is a satellite reading.
 */
export function indexStageFixture(): IndexStageReading {
  return {
    status: "available",
    reason: null,
    index: "ndvi",
    asOf: "2026-10-27",
    phase: "rising",
    greenUpDate: "2026-10-02",
    peakDate: "2026-10-27",
    peakValue: 0.62,
    troughDate: "2026-09-12",
    troughValue: 0.21,
    latestSmoothed: 0.61,
    change15d: 0.13,
    noise: 0.02,
    changeThreshold: 0.05,
    readingsUsed: 7,
    window: { from: "2026-07-17", to: FIXTURE_TODAY },
    calendarStage: { id: "vegetative", name: "Vegetative", from: "2026-09-25", to: "2026-11-08" },
    agreement: "consistent",
    summary: "Satellite greenness has been rising since the green-up on 2 Oct (latest clear scene 27 Oct); the calendar puts the crop in Vegetative and expects fast canopy growth, so the curve and the calendar agree.",
    basis: { ...CURVE_BASIS },
    limitations: [
      "The curve is read from clear images only, so a cloudy spell can hide a turn in it.",
      "A green curve does not confirm a crop stage; the calendar stays the stage estimate.",
    ],
  };
}
/**
 * Fewer than 4 clear scenes in the window (reason `too_few_clear_scenes`, as apps/api/src/services/today/index-stage.ts
 * writes it): no phase is read, the calendar stage the latest scene falls in is still named, agreement is unknown.
 */
export function indexStageInsufficientFixture(): IndexStageReading {
  return {
    ...emptyCurve(),
    status: "insufficient",
    reason: "too_few_clear_scenes",
    asOf: "2026-10-27",
    readingsUsed: 2,
    window: { from: "2026-07-17", to: FIXTURE_TODAY },
    calendarStage: { id: "vegetative", name: "Vegetative", from: "2026-09-25", to: "2026-11-08" },
    summary: "Only 2 of the 4 clear satellite scenes needed are available in this window, so no greenness phase is read yet; the calendar stage estimate stands alone.",
    limitations: ["Cloud cover left too few clear images of this field."],
  };
}
/** Enough clear scenes but they span under 30 days (reason `clear_scenes_span_too_short`): the count is not the shortfall. */
export function indexStageSpanFixture(): IndexStageReading {
  return {
    ...indexStageInsufficientFixture(),
    reason: "clear_scenes_span_too_short",
    readingsUsed: 5,
    summary: "The 5 clear satellite scenes span 22 days, fewer than the 30 needed, so no greenness phase is read yet; the calendar stage estimate stands alone.",
    limitations: ["The clear images all fall in the last three weeks."],
  };
}
/** No satellite readings at all (reason `no_satellite_readings`); the Today view hides the line. */
export function indexStageUnavailableFixture(): IndexStageReading {
  return {
    ...emptyCurve(),
    status: "unavailable",
    reason: "no_satellite_readings",
    summary: "No satellite readings of this field are available now, so the calendar stage estimate stands alone.",
    limitations: [],
  };
}
function emptyCurve(): IndexStageReading {
  return {
    status: "insufficient",
    reason: null,
    index: "ndvi",
    asOf: null,
    phase: "unknown",
    greenUpDate: null,
    peakDate: null,
    peakValue: null,
    troughDate: null,
    troughValue: null,
    latestSmoothed: null,
    change15d: null,
    noise: null,
    changeThreshold: null,
    readingsUsed: 0,
    window: null,
    calendarStage: null,
    agreement: "unknown",
    summary: "",
    basis: { ...CURVE_BASIS },
    limitations: [],
  };
}


// ---------------------------------------------------------------- economics and footprint blocks (synthetic maize case, 1.2 ha)

const fixtureBasis = (kind: BasisRef["kind"], label: string, scope: string | null = "Hassan", note: string | null = null): BasisRef => ({
  kind,
  label,
  sourceId: null,
  url: "https://example.org/test-fixture",
  scope,
  note,
});
const FIXTURE_AREA_HA = 1.2;

/** Everything sourced: profit for the field with the likely and possible bands. */
export function harvestEconomicsFixture(): HarvestEconomics {
  return {
    status: "available",
    reason: null,
    harvest: { ...FIXTURE_HARVEST },
    harvestDate: "2027-01-08",
    fieldAreaHa: FIXTURE_AREA_HA,
    yieldKgPerHa: { low: 5500, high: 7000 },
    yieldBasis: "district",
    yieldForFieldKg: { low: 6600, high: 8400 },
    keepFraction: 0.95,
    price: {
      status: "available",
      unit: "INR/kg",
      p50: 21.4,
      likely: { low: 19.2, high: 23.8 },
      scopeLabel: "Based on 3 years of Karnataka mandi prices (test fixture)",
    },
    cost: { a2flPerHa: 48000, c2PerHa: 68000, authority: "cacp", year: "2024-25", region: "Karnataka" },
    revenuePerHa: { central: 127000, likely: { low: 105000, high: 150000 }, possible: { low: 88000, high: 168000 } },
    revenueForField: { central: 152400, likely: { low: 126000, high: 180000 }, possible: { low: 105600, high: 201600 } },
    profitPerHa: { central: 79000, likely: { low: 57000, high: 102000 }, possible: { low: 40000, high: 120000 } },
    profitForField: { central: 94800, likely: { low: 68400, high: 122400 }, possible: { low: 48000, high: 144000 } },
    basis: [
      fixtureBasis("yield_reference", "District maize yield, 2021 to 2023 (test fixture)", "Hassan"),
      fixtureBasis("price_history", "Harvest-week prices, 2023 to 2025 (test fixture)", "Karnataka"),
      fixtureBasis("cost_reference", "A2+FL cost of cultivation, 2024-25 (test fixture)", "Karnataka"),
    ],
    limitations: ["Test fixture: every number here is invented.", "The price is a past harvest-week reference, not a forecast."],
  };
}
/** Revenue is known, the cost is not: the card shows the revenue and says the cost is missing. */
export function harvestEconomicsPartialFixture(): HarvestEconomics {
  return {
    ...harvestEconomicsFixture(),
    status: "partial",
    cost: null,
    profitPerHa: null,
    profitForField: null,
    limitations: ["No cost of cultivation is sourced for this crop and state, so profit is not shown."],
  };
}
export function harvestEconomicsUnavailableFixture(): HarvestEconomics {
  return {
    status: "unavailable",
    reason: "no_yield_row",
    harvest: null,
    harvestDate: null,
    fieldAreaHa: null,
    yieldKgPerHa: null,
    yieldBasis: null,
    yieldForFieldKg: null,
    keepFraction: 1,
    price: null,
    cost: null,
    revenuePerHa: null,
    revenueForField: null,
    profitPerHa: null,
    profitForField: null,
    basis: [],
    limitations: ["No regional yield is sourced for this crop, so profit at harvest is not estimated."],
  };
}

/** Three alternatives for the same stover, sent in the wrong order on purpose (fodder, biomass fuel, CBG) so the card must sort; one has no price. */
export function residueIncomeFixture(): ResidueIncome {
  return {
    status: "available",
    reason: null,
    residueName: "maize stover",
    residueToProductRatio: { low: 1.1, high: 1.5 },
    residueForFieldKg: { low: 7260, high: 12600 },
    surplusFraction: { low: 0.4, high: 0.6 },
    surplusForFieldKg: { low: 2904, high: 7560 },
    options: [
      {
        use: "dry_fodder",
        label: "Dry fodder",
        quantityKg: { low: 1500, high: 3000 },
        priceInrPerTonne: { low: 3500, high: 5500 },
        priceBasis: "farm-gate, dry basis, Karnataka 2025 (test fixture)",
        incomeForField: { low: 5250, high: 16500 },
        note: "Only the part cattle owners nearby will take.",
        sourceIds: [],
      },
      {
        use: "biomass_fuel",
        label: "Biomass fuel",
        quantityKg: { low: 1000, high: 2500 },
        priceInrPerTonne: null,
        priceBasis: null,
        incomeForField: null,
        note: "No price is sourced for stover sold as boiler fuel.",
        sourceIds: [],
      },
      {
        use: "cbg_feedstock",
        label: "CBG feedstock",
        quantityKg: { low: 2904, high: 7560 },
        priceInrPerTonne: { low: 1800, high: 2500 },
        priceBasis: "plant-gate, as reported, 2025 (test fixture)",
        incomeForField: { low: 5227, high: 18900 },
        note: "Needs a compressed biogas plant within hauling distance.",
        sourceIds: [],
      },
    ],
    basis: [fixtureBasis("yield_reference", "Published residue-to-product ratio for maize (test fixture)", "India"), fixtureBasis("model", "Surplus share of the residue (test fixture)", "India", "India-wide figure, flagged.")],
    limitations: ["Test fixture: invented ratio, share and prices.", "Prices are as reported by one plant and one region; yours may differ."],
  };
}
/** A crop whose residue is usually not sold: no figure, a reason. */
export function residueIncomeUnavailableFixture(): ResidueIncome {
  return {
    status: "unavailable",
    reason: "residue_not_usually_sold",
    residueName: null,
    residueToProductRatio: null,
    residueForFieldKg: null,
    surplusFraction: null,
    surplusForFieldKg: null,
    options: [],
    basis: [],
    limitations: ["The haulm of this crop is usually left on the field, so no income is estimated."],
  };
}

export function energyFootprintFixture(): EnergyFootprint {
  return {
    status: "available",
    reason: null,
    inputEnergyGJPerHa: { low: 12, high: 16 },
    inputEnergyGJForField: { low: 14.4, high: 19.2 },
    inputEnergyBasis: "Energy-use study of maize farms in southern India (test fixture)",
    inputBreakdown: [
      { item: "Fertiliser", share: 0.38 },
      { item: "Fuel", share: 0.27 },
      { item: "Irrigation", share: 0.12 },
      { item: "Labour", share: 0.13 },
      { item: "Seed", share: 0.1 },
    ],
    calorificValueMJPerKg: { low: 15, high: 17 },
    residueEnergyGJForField: { low: 39.6, high: 128.5 },
    equivalents: [
      { label: "Household LPG cylinders (14.2 kg)", amount: { low: 61, high: 198 }, unit: "cylinders", sourceIds: [] },
      { label: "Diesel", amount: { low: 1040, high: 3380 }, unit: "litres", sourceIds: [] },
    ],
    basis: [fixtureBasis("model", "Calorific value of maize stover (test fixture)", "India")],
    limitations: ["Test fixture: invented energy figures.", "The input energy is a study average, not what this farm used."],
  };
}
/** The residue energy is known but no energy-use study is sourced for the crop. */
export function energyFootprintPartialFixture(): EnergyFootprint {
  return {
    ...energyFootprintFixture(),
    status: "partial",
    inputEnergyGJPerHa: null,
    inputEnergyGJForField: null,
    inputEnergyBasis: null,
    inputBreakdown: [],
    limitations: ["No energy-use study is sourced for this crop, so only the energy in the residue is shown."],
  };
}
export function energyFootprintUnavailableFixture(): EnergyFootprint {
  return {
    status: "unavailable",
    reason: "no_energy_row",
    inputEnergyGJPerHa: null,
    inputEnergyGJForField: null,
    inputEnergyBasis: null,
    inputBreakdown: [],
    calorificValueMJPerKg: null,
    residueEnergyGJForField: null,
    equivalents: [],
    basis: [],
    limitations: ["No energy figures are sourced for this crop."],
  };
}

export function carbonFootprintFixture(): CarbonFootprint {
  return {
    status: "available",
    reason: null,
    fieldAreaHa: FIXTURE_AREA_HA,
    seasonDays: 110,
    emissionsForField: { low: 1.2, high: 2.1 },
    emissionsPerHa: { low: 1, high: 1.75 },
    // Maize is not flooded: no methane term. The largest term (nitrous oxide) is not first, so the card has to pick it.
    terms: [
      { source: "fertiliser_manufacture", label: "Making the fertiliser", tCO2eForField: { low: 0.4, high: 0.6 }, tCO2ePerHa: { low: 0.33, high: 0.5 }, method: "150 kg N per ha x 1.2 ha x embodied factor (test fixture)", kind: "baseline", sourceIds: [] },
      { source: "fertiliser_n2o", label: "Nitrous oxide from fertiliser nitrogen", tCO2eForField: { low: 0.6, high: 1.1 }, tCO2ePerHa: { low: 0.5, high: 0.92 }, method: "150 kg N per ha x 1.2 ha x emission factor 0.01 x 44/28 x 273 (test fixture)", kind: "baseline", sourceIds: [] },
      { source: "fuel_and_machinery", label: "Diesel and machinery", tCO2eForField: { low: 0.2, high: 0.4 }, tCO2ePerHa: { low: 0.17, high: 0.33 }, method: "study diesel use x 1.2 ha x diesel factor (test fixture)", kind: "baseline", sourceIds: [] },
      { source: "residue_burning", label: "Burning the stover in the field", tCO2eForField: { low: 0.3, high: 0.6 }, tCO2ePerHa: { low: 0.25, high: 0.5 }, method: "stover burnt x methane and nitrous oxide factors; the carbon dioxide is biogenic and not counted (test fixture)", kind: "scenario", sourceIds: [] },
      { source: "residue_carbon", label: "Carbon held in stover worked into the soil", tCO2eForField: { low: -0.9, high: -0.3 }, tCO2ePerHa: { low: -0.75, high: -0.25 }, method: "stover carbon share x 44/12; only part stays in the soil and that part is not estimated (test fixture)", kind: "scenario", sourceIds: [] },
    ],
    residueScenarios: [
      { id: "burn", label: "Burn the stover", netForField: { low: 1.5, high: 2.7 }, note: "Burning adds methane and nitrous oxide on top of the season's emissions." },
      { id: "incorporate", label: "Work the stover into the soil", netForField: { low: 1.2, high: 2.1 }, note: "No credit is claimed for the carbon in the stover: only part of it stays in the soil and that part is not estimated, so the total equals the emissions above." },
      { id: "sell_cbg", label: "Sell it for CBG", netForField: { low: 1.2, high: 2.1 }, note: "No emission in the field; no credit is claimed for the fuel it replaces." },
      { id: "sell_fodder", label: "Sell it as dry fodder", netForField: { low: 1.2, high: 2.1 }, note: "No emission in the field; no credit is claimed." },
    ],
    comparison: {
      rank: 9,
      of: 14,
      lowest: { cropId: "finger-millet", cropName: "Finger millet", tCO2eForField: { low: 0.5, high: 0.9 } },
      highest: { cropId: "paddy", cropName: "Paddy", tCO2eForField: { low: 3.5, high: 6.7 } },
    },
    gwp: { ch4: 27, n2o: 273, basis: "IPCC AR6 100-year values (test fixture)" },
    summary: "A maize season on 1.2 ha emits about 1.2 to 2.1 t CO₂e, mostly nitrous oxide from fertiliser nitrogen.",
    basis: [fixtureBasis("model", "IPCC 2019 Refinement emission factors (test fixture)", "India")],
    limitations: ["Test fixture: invented factors.", "Nitrogen rates are the state recommendation, not what this farm applied."],
  };
}
/** The field area is not known: every term carries only its per-hectare figure, there is no field total and no scenario net. */
export function carbonFootprintNoAreaFixture(): CarbonFootprint {
  const full = carbonFootprintFixture();
  return {
    ...full,
    status: "partial",
    fieldAreaHa: null,
    emissionsForField: null,
    terms: full.terms.map((term) => ({ ...term, tCO2eForField: null })),
    residueScenarios: [],
    comparison: null,
    summary: "A maize season emits about 1.0 to 1.75 t CO₂e per hectare, mostly nitrous oxide from fertiliser nitrogen.",
    limitations: ["The field area is not known, so the figures are per hectare only."],
  };
}
/** The baseline is known but the pool comparison is not (too few crops with a figure). */
export function carbonFootprintPartialFixture(): CarbonFootprint {
  return { ...carbonFootprintFixture(), status: "partial", comparison: null, residueScenarios: [], limitations: ["Fewer than three crops have a footprint figure here, so no comparison is shown."] };
}
export function carbonFootprintUnavailableFixture(): CarbonFootprint {
  return {
    status: "unavailable",
    reason: "no_footprint_row",
    fieldAreaHa: null,
    seasonDays: null,
    emissionsForField: null,
    emissionsPerHa: null,
    terms: [],
    residueScenarios: [],
    comparison: null,
    gwp: null,
    summary: "",
    basis: [],
    limitations: ["No emission factors are sourced for this crop."],
  };
}

// ---------------------------------------------------------------- the AI overview (synthetic; refs point at real fixture steps, alerts and cards)

const MOISTURE_STEP_ID = "care:task-moisture";
const TASSELLING_STEP_ID = "stage:tasselling";
/** Code-written facts the overview rests on (invented, consistent with the rest of this fixture). */
export const OVERVIEW_FACTS: OverviewFact[] = [
  { id: "stage", text: "Day 47 since sowing, vegetative stage", ref: { kind: "card", id: "harvest" } },
  { id: "harvest", text: "Harvest in 63 to 73 days, window 3 Jan to 13 Jan", ref: { kind: "card", id: "harvest" } },
  { id: "next", text: "Next: Check field moisture, due 31 Oct to 2 Nov", ref: { kind: "step", id: MOISTURE_STEP_ID } },
  { id: "alert1", text: "Warning: Leaf-feeding pest window for vegetative maize", ref: { kind: "alert", id: FIXTURE_ALERT_IDS.threat } },
  { id: "alert2", text: "Watch: Heavy rain expected on 4 Nov", ref: { kind: "alert", id: FIXTURE_ALERT_IDS.weather } },
  { id: "price", text: "Harvest price likely ₹19 to ₹24 per kg", ref: { kind: "card", id: "price" } },
  { id: "profit", text: "Profit for the field about ₹94,800, likely ₹68,400 to ₹1,22,400", ref: { kind: "card", id: "profit" } },
  { id: "health", text: "Vegetation near typical, NDVI 0.62 on 27 Oct", ref: { kind: "card", id: "health" } },
  { id: "residue", text: "Maize stover could bring ₹5,227 to ₹18,900 as CBG feedstock", ref: { kind: "card", id: "residue" } },
  { id: "later", text: "Tasselling and silking begins on 9 Nov", ref: { kind: "step", id: TASSELLING_STEP_ID } },
];
const point = (kind: OverviewPoint["kind"], text: string, factIds: string[]): OverviewPoint => ({
  kind,
  text,
  factIds,
  ref: OVERVIEW_FACTS.find((fact) => fact.id === factIds[0])?.ref ?? null,
});

/** Model-written, ready. Every point cites facts; each ref is the first cited fact's ref (a step, an alert or a card). */
export function overviewFixture(): TodayOverview {
  return {
    status: "ready",
    headline: "Maize is on track for harvest in 63 to 73 days; check moisture and clear the drains now.",
    points: [
      point("do_now", "Check field moisture today before you decide on irrigation, because rain is on the way.", ["next", "alert2"]),
      point("watch", "Heavy rain is due on 4 Nov: clear the field drains first so water does not stand on your maize.", ["alert2"]),
      point("money", "Expect about ₹94,800 profit from this field, likely ₹68,400 to ₹1,22,400, if prices stay near ₹19 to ₹24 per kg.", ["profit", "price"]),
      point("later", "The stover could earn ₹5,227 to ₹18,900 as CBG feedstock: line up a buyer before harvest.", ["residue"]),
      point("good_news", "Your crop looks near typical for this stage, so nothing needs fixing in the field itself.", ["health"]),
    ],
    facts: OVERVIEW_FACTS.map((fact) => ({ ...fact })),
    origin: "model",
    generatedAt: "2026-11-01T04:25:00Z",
    modelInvocation: {
      id: "33333333-3333-4333-8333-333333333333",
      provider: "meta",
      requestedModel: "muse-spark",
      model: "muse-spark",
      purpose: "today_overview",
      status: "succeeded",
      startedAt: "2026-11-01T04:24:30Z",
      finishedAt: "2026-11-01T04:25:00Z",
      processing: "standard",
      requestedStorage: false,
      responseDeleted: true,
    },
  };
}
/** Code-written points shown while the model job runs: pending, origin deterministic. */
export function overviewPendingFixture(): TodayOverview {
  return { ...overviewDeterministicFixture(), status: "pending" };
}
/** Code-written and final (synthetic and replay modes, or the model answer was rejected): no AI mark. */
export function overviewDeterministicFixture(): TodayOverview {
  return {
    status: "ready",
    headline: "Maize, vegetative stage: harvest in 63 to 73 days.",
    points: [
      point("do_now", "Do next: Check field moisture, due 31 Oct to 2 Nov", ["next"]),
      point("watch", "Watch: Heavy rain expected on 4 Nov", ["alert2"]),
      point("money", "Profit for the field about ₹94,800, likely ₹68,400 to ₹1,22,400", ["profit"]),
      point("later", "Tasselling and silking begins on 9 Nov", ["later"]),
      point("good_news", "Vegetation near typical, NDVI 0.62 on 27 Oct", ["health"]),
    ],
    facts: OVERVIEW_FACTS.map((fact) => ({ ...fact })),
    origin: "deterministic",
    generatedAt: "2026-11-01T04:30:00Z",
    modelInvocation: null,
  };
}
export function overviewUnavailableFixture(): TodayOverview {
  return { status: "unavailable", headline: null, points: [], facts: [], origin: null, generatedAt: null, modelInvocation: null };
}

const monitoring = {
  enabled: true,
  lastCheckedAt: "2026-11-01T03:00:00Z",
  nextCheckAt: "2026-11-02T03:00:00Z",
};

/** The full maize scenario. Pass another farm id to get the same data owned by that farm. */
export function todayFixture(farmId = FIXTURE_FARM_ID): TodayView {
  const view: TodayView = {
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
    indexStage: indexStageFixture(),
    overview: overviewFixture(),
    harvestEconomics: harvestEconomicsFixture(),
    residueIncome: residueIncomeFixture(),
    energyFootprint: energyFootprintFixture(),
    carbonFootprint: carbonFootprintFixture(),
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
    fieldImageBbox: FIXTURE_FIELD_BBOX,
    monitoring,
    limitations: ["Test fixture: every value on this view is synthetic.", "Direct IMD feed not connected (needs a key); official warnings are searched daily."],
  };
  view.conditions = fixtureConditions(view);
  return view;
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
