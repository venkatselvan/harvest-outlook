import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "solid-js/web";
import { FieldConditions as conditionsSchema, TodayView as todaySchema, type FieldConditionPoint, type RainClass, type SceneRef } from "@harvest/contracts";
import {
  FIXTURE_ALERT_IDS,
  FIXTURE_BOUNDARY,
  FIXTURE_FIELD_BBOX,
  FIXTURE_TODAY,
  fixtureRainClass,
  paddyConditionPoints,
  todayFixture,
} from "./fixtures";
import {
  addDays,
  conditionAt,
  conditionCaption,
  conditionKindChip,
  CROSS_FADE_MS,
  createSeasonPlayer,
  crossFadeMs,
  daysBetween,
  futureImageLabel,
  growthProgress,
  PLAY_STEP_MS,
  rainStreakCount,
  satelliteImage,
  sceneAgeCaption,
  sceneFor,
  sceneMarks,
  sliderModel,
  stageAt,
  withoutDismissed,
} from "./model";
import {
  canopyColor,
  conditionLayers,
  createFieldScene,
  insideField,
  needsAnimation,
  normalizedField,
  rainStreaks,
  rgbOf,
  RAIN_STREAKS,
  sceneLook,
  SOIL_FACTOR,
  WATER_ALPHA,
} from "../fieldGeometry";
import { SCENE_FOOTNOTE } from "../FieldGrowthScene";
import { ConditionsLine, EventBadges, NdviLegend, SatelliteConditions, TodayHero, type HeroMode } from "./TodayHero";
import { StageSlider } from "./StageSlider";

/**
 * Season progression on the Today hero (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 10.1 items 1, 2, 3, 5, 6, 7). Canvas
 * drawing is checked through the pure layer and geometry functions it paints from; the components through SSR markup.
 * Every value here comes from the synthetic fixture.
 */
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const fixture = todayFixture();
const timeline = fixture.timeline!;
const model = sliderModel(fixture)!;
const at = (date: string) => conditionAt(fixture.conditions, date)!;

/** A minimal condition point; tests override what they exercise. */
const point = (over: Partial<FieldConditionPoint> = {}): FieldConditionPoint => ({
  date: "2026-09-19",
  kind: "observed",
  rain: { mm: 0, class: "none" },
  water: { state: "dry", basis: "none" },
  heat: { tMaxC: 30, stress: false, thresholdC: 40 },
  greenness: { ndvi: 0.5, verdict: "near_typical", observedOn: "2026-09-19", daysSince: 0 },
  events: [],
  stage: null,
  ...over,
});
const rain = (mm: number | null, rainClass: RainClass, kind: FieldConditionPoint["kind"] = "observed") => point({ kind, rain: { mm, class: rainClass } });

const hero = (date: string, mode: HeroMode = "satellite", view = fixture, condition: FieldConditionPoint | null | undefined = conditionAt(view.conditions, date)) =>
  renderToString(() => (
    <TodayHero
      mode={mode}
      onMode={() => undefined}
      date={date}
      today={FIXTURE_TODAY}
      stage={stageAt(timeline, date)}
      progress={growthProgress(timeline, date)}
      cropId="maize"
      cropName="Maize"
      boundary={FIXTURE_BOUNDARY}
      scenes={view.scenes}
      imageBbox={view.ndvi!.imageBbox}
      fieldImageBbox={view.fieldImageBbox ?? null}
      condition={condition}
      hasConditions={!!view.conditions}
    />
  ));

describe("fixtures for the season progression", () => {
  it("every fixture validates against the contract, with conditions, field-zoom paths and the field bbox", () => {
    expect(todaySchema.safeParse(fixture).success).toBe(true);
    expect(conditionsSchema.safeParse(fixture.conditions).success).toBe(true);
    const other = "22222222-2222-4222-8222-222222222222";
    const parsed = todaySchema.parse(todayFixture(other));
    expect(parsed.scenes.every((scene) => !scene.fieldImagePath || scene.fieldImagePath.startsWith(`/api/v1/farms/${other}/`))).toBe(true);
    // The paddy window as a whole view (inline fixture) also validates.
    const paddy = { ...fixture, conditions: { ...fixture.conditions!, points: paddyConditionPoints() } };
    expect(todaySchema.safeParse(paddy).success).toBe(true);
    expect(fixture.fieldImageBbox).toEqual(FIXTURE_FIELD_BBOX);
  });
  it("one point per slider day, and the maize series covers dry, moist, ponded, heavy rain, heat stress and alert days", () => {
    const points = fixture.conditions!.points;
    expect(points).toHaveLength(model.total + 1);
    points.forEach((p, i) => expect(p.date).toBe(addDays(model.from, i)));
    const states = new Set(points.map((p) => p.water.state));
    for (const state of ["dry", "moist", "ponded"] as const) expect(states.has(state)).toBe(true);
    expect(at("2026-09-28").rain.class).toBe("heavy");
    expect(at("2026-09-28").water).toEqual({ state: "ponded", basis: "rain_rule" });
    expect(at("2026-10-14").rain.class).toBe("very_heavy");
    expect(at("2026-10-05").heat).toEqual({ tMaxC: 40.6, stress: true, thresholdC: 40 });
    expect(at(FIXTURE_TODAY).events.map((e) => e.severity)).toEqual(["warning", "watch", "info"]);
    expect(new Set(points.map((p) => p.kind))).toEqual(new Set(["observed", "forecast", "typical"]));
    // Rain and temperature agree with the weather track the cards show.
    for (const p of points) {
      const w = fixture.weatherTrack.find((entry) => entry.date === p.date)!;
      expect(p.rain.mm).toBe(w.rainMm);
      expect(p.heat.tMaxC).toBe(w.tMaxC);
      expect(p.kind).toBe(w.kind);
    }
    // Greenness is held from the latest usable scene and never interpolated.
    expect(at("2026-10-10").greenness).toMatchObject({ observedOn: "2026-10-07", daysSince: 3, ndvi: 0.42 });
  });
  it("the fixture's IMD classes follow the quoted bands at their edges", () => {
    const edges: [number | null, RainClass][] = [
      [null, "unknown"], [0, "none"], [0.1, "very_light"], [2.4, "very_light"], [2.5, "light"], [15.5, "light"], [15.6, "moderate"],
      [64.4, "moderate"], [64.5, "heavy"], [115.5, "heavy"], [115.6, "very_heavy"], [204.4, "very_heavy"], [204.5, "extremely_heavy"],
    ];
    for (const [mm, rainClass] of edges) expect(fixtureRainClass(mm)).toBe(rainClass);
  });
  it("the paddy window keeps standing water by crop practice, then drains", () => {
    const paddy = paddyConditionPoints();
    expect(paddy.slice(0, 3).every((p) => p.water.state === "flooded" && p.water.basis === "crop_practice")).toBe(true);
    expect(paddy.at(-1)!.water.state).toBe("dry");
    expect(paddy.some((p) => p.kind === "unavailable")).toBe(true);
  });
  it("conditionAt takes the exact day only, and dismissed alerts drop out of the day's events", () => {
    expect(conditionAt(fixture.conditions, "2026-09-28")?.date).toBe("2026-09-28");
    expect(conditionAt(fixture.conditions, "2027-02-01")).toBeNull();
    expect(conditionAt(null, "2026-09-28")).toBeNull();
    expect(conditionAt(undefined, "2026-09-28")).toBeNull();
    const today = at(FIXTURE_TODAY);
    const without = withoutDismissed(today, new Set([FIXTURE_ALERT_IDS.price]))!;
    expect(without.events.map((e) => e.alertId)).toEqual([FIXTURE_ALERT_IDS.threat, FIXTURE_ALERT_IDS.weather]);
    expect(withoutDismissed(today, new Set())).toBe(today);
  });
});

describe("condition layers (what the canvas and the SVG overlay draw)", () => {
  it("rain streak count per class: none and unknown draw nothing, then strictly more through extremely heavy", () => {
    expect(rainStreakCount("none")).toBe(0);
    expect(rainStreakCount("unknown")).toBe(0);
    expect(rainStreakCount(null)).toBe(0);
    const order: RainClass[] = ["very_light", "light", "moderate", "heavy", "very_heavy", "extremely_heavy"];
    const counts = order.map((c) => rainStreakCount(c));
    counts.forEach((count, i) => expect(count).toBeGreaterThan(i ? counts[i - 1]! : 0));
    for (const c of order) expect(conditionLayers(rain(10, c)).rain.count).toBe(RAIN_STREAKS[c]);
    // Heavier classes fall faster in longer streaks.
    expect(conditionLayers(rain(120, "very_heavy")).rain.speed).toBeGreaterThan(conditionLayers(rain(5, "light")).rain.speed);
    // The same deterministic streaks every time for a count.
    expect(rainStreaks(48)).toEqual(rainStreaks(48));
    expect(rainStreaks(48).every((s) => s.x >= 0 && s.x < 1 && s.y >= 0 && s.y < 1)).toBe(true);
  });
  it("forecast and typical days draw the same streaks dashed; a day without a weather record draws no weather", () => {
    const observed = conditionLayers(rain(30, "moderate"));
    const forecast = conditionLayers(rain(30, "moderate", "forecast"));
    const typical = conditionLayers(rain(30, "moderate", "typical"));
    expect(observed.rain.dashed).toBe(false);
    expect(forecast.rain).toEqual({ ...observed.rain, dashed: true });
    expect(typical.rain.dashed).toBe(true);
    const unavailable = conditionLayers(point({ kind: "unavailable", rain: { mm: null, class: "heavy" }, water: { state: "ponded", basis: "rain_rule" } }));
    expect(unavailable).toMatchObject({ weather: false, sky: "none", rain: { count: 0 }, water: { look: "none" } });
    expect(conditionLayers(null)).toMatchObject({ weather: false, sky: "none", rain: { count: 0 }, water: { look: "none" }, canopy: { shift: "none" }, events: [] });
  });
  it("sky tone: heat haze on heat-stress days, overcast on rain days, clear otherwise", () => {
    expect(conditionLayers(point({ heat: { tMaxC: 41, stress: true, thresholdC: 40 } })).sky).toBe("heat");
    expect(conditionLayers(rain(5, "light")).sky).toBe("overcast");
    expect(conditionLayers(point({ rain: { mm: 30, class: "moderate" }, heat: { tMaxC: 41, stress: true, thresholdC: 40 } })).sky).toBe("overcast");
    expect(conditionLayers(point()).sky).toBe("clear");
    expect(conditionLayers(point({ rain: { mm: null, class: "unknown" }, heat: { tMaxC: null, stress: false, thresholdC: null } })).sky).toBe("none");
  });
  it("water plane per state: dry and moist none (moist darkens the soil), ponded patches, flooded a sheet", () => {
    const of = (state: FieldConditionPoint["water"]["state"], basis: FieldConditionPoint["water"]["basis"] = "rain_rule") => conditionLayers(point({ water: { state, basis } }));
    expect(of("dry", "none")).toMatchObject({ water: { look: "none", shimmer: false, alpha: 0 }, soil: { factor: SOIL_FACTOR.dry } });
    expect(of("moist", "none")).toMatchObject({ water: { look: "none", shimmer: false }, soil: { factor: SOIL_FACTOR.moist } });
    expect(of("ponded")).toMatchObject({ water: { look: "patches", shimmer: true, alpha: WATER_ALPHA.patches }, soil: { factor: SOIL_FACTOR.wet } });
    expect(of("flooded", "crop_practice")).toMatchObject({ water: { look: "sheet", shimmer: true, alpha: WATER_ALPHA.sheet } });
    expect(of("unknown", "none").water.look).toBe("none");
    expect(SOIL_FACTOR.moist).toBeLessThan(SOIL_FACTOR.dry);
    // Crop-practice flooding does not depend on weather, so it still draws on a day without a weather record.
    expect(conditionLayers(paddyConditionPoints()[2]!)).toMatchObject({ weather: false, water: { look: "sheet" }, rain: { count: 0 } });
  });
  it("the scene geometry: ponded patches lie inside the field, flooded is one sheet, and the soil darkens when wet", () => {
    const ring = normalizedField(FIXTURE_BOUNDARY);
    const plain = createFieldScene(ring, "maize", 0.4);
    const ponded = createFieldScene(ring, "maize", 0.4, sceneLook(conditionLayers(point({ water: { state: "ponded", basis: "rain_rule" } }))));
    const flooded = createFieldScene(ring, "paddy", 0.4, sceneLook(conditionLayers(paddyConditionPoints()[0]!)));
    const patches = ponded.filter((f) => f.tag === "water");
    expect(patches.length).toBeGreaterThanOrEqual(3);
    expect(patches.every((f) => f.points.every(([x, , z]) => insideField(x, z, ring)))).toBe(true);
    expect(flooded.filter((f) => f.tag === "water")).toHaveLength(1);
    expect(plain.some((f) => f.tag === "water")).toBe(false);
    // Water sits above the soil and below the plants in the painter's order.
    expect(patches.every((f) => f.layer! > 0 && f.layer! < 1)).toBe(true);
    const soil = (faces: typeof plain) => rgbOf(faces[0]!.color);
    expect(soil(ponded)[1]).toBeLessThan(soil(plain)[1]);
    // No look keeps the original scene exactly.
    expect(createFieldScene(ring, "maize", 0.4, null)).toEqual(plain);
  });
  it("canopy tint per verdict: below typical paler and yellower, above deeper green, otherwise the stage colour", () => {
    const shift = (verdict: FieldConditionPoint["greenness"]["verdict"]) => conditionLayers(point({ greenness: { ndvi: 0.5, verdict, observedOn: "2026-09-19", daysSince: 0 } })).canopy.shift;
    expect(shift("below_typical")).toBe("paler");
    expect(shift("above_typical")).toBe("deeper");
    expect(shift("near_typical")).toBe("none");
    expect(shift("no_reference")).toBe("none");
    expect(shift(null)).toBe("none");
    const leaf = "#72964f",
      [r, g, b] = rgbOf(leaf);
    const pale = rgbOf(canopyColor(leaf, "paler")),
      deep = rgbOf(canopyColor(leaf, "deeper"));
    expect(pale[0] - pale[1]).toBeGreaterThan(r - g); // yellower: red closes on green
    expect(pale[0] + pale[1] + pale[2]).toBeGreaterThan(r + g + b); // paler
    expect(deep[0] + deep[1] + deep[2]).toBeLessThan(r + g + b); // deeper
    expect(canopyColor(leaf, "none")).toBe(leaf);
    // In the scene only leaf faces change; soil and row marks keep their colour.
    const ring = normalizedField(FIXTURE_BOUNDARY);
    const plain = createFieldScene(ring, "maize", 0.5),
      pale2 = createFieldScene(ring, "maize", 0.5, { canopy: "paler" });
    expect(pale2.filter((f) => f.layer === 0)).toEqual(plain.filter((f) => f.layer === 0));
    expect(pale2.filter((f, i) => f.color !== plain[i]!.color).length).toBeGreaterThan(100);
  });
  it("reduced motion: no animation loop and no cross-fade, but the rain is still drawn (static) and play still steps", () => {
    const wet = conditionLayers(rain(80, "heavy"));
    const ponded = conditionLayers(point({ water: { state: "ponded", basis: "rain_rule" } }));
    const dry = conditionLayers(point());
    expect(needsAnimation(wet, false)).toBe(true);
    expect(needsAnimation(ponded, false)).toBe(true);
    expect(needsAnimation(dry, false)).toBe(false);
    expect(needsAnimation(wet, true)).toBe(false);
    expect(needsAnimation(ponded, true)).toBe(false);
    expect(wet.rain.count).toBe(RAIN_STREAKS.heavy);
    expect(crossFadeMs(false)).toBe(CROSS_FADE_MS);
    expect(CROSS_FADE_MS).toBe(150);
    expect(crossFadeMs(true)).toBe(0);
    const css = readFileSync(new URL("./today.css", import.meta.url), "utf8");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.today-sat-rain,\s*\.today-sat-water \{\s*animation: none;/);
    expect(reduced).toMatch(/\.today-sat-prev \{\s*display: none;/);
    // The rain and shimmer animations exist only under no-preference.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.today-sat-rain \{\s*animation: today-rain-fall/);
    expect(readFileSync(new URL("../field-growth.css", import.meta.url), "utf8")).toContain("@media (prefers-reduced-motion:reduce){.field-growth-sky{transition:none}}");
  });
});

describe("conditions caption", () => {
  const alert = { alertId: FIXTURE_ALERT_IDS.weather, type: "weather", severity: "watch" as const, title: "Heavy rain watch" };
  it("reads the day's conditions in words, in the spec's order", () => {
    expect(
      conditionCaption(point({ rain: { mm: 17, class: "moderate" }, water: { state: "ponded", basis: "rain_rule" }, events: [alert] })),
    ).toBe("19 Sept: 17 mm rain (moderate), field ponded, canopy near typical, alert: Heavy rain watch");
  });
  it("names forecast and typical days, heat stress, a held reading, flooding by practice and several alerts", () => {
    expect(conditionCaption(rain(48, "moderate", "forecast"))).toBe("19 Sept (forecast): 48 mm rain (moderate), soil dry, canopy near typical");
    expect(conditionCaption(rain(1.8, "very_light", "typical"))).toBe("19 Sept (typical weather): 1.8 mm rain (very light), soil dry, canopy near typical");
    expect(conditionCaption(at("2026-10-05"))).toBe("5 Oct: no rain, heat stress (41°, threshold 40°), soil dry, canopy near typical as of 2 Oct");
    expect(conditionCaption(paddyConditionPoints()[0]!)).toBe("22 Aug: no rain, standing water kept by crop practice, canopy near typical as of 20 Aug");
    expect(conditionCaption(at(FIXTURE_TODAY))).toBe(
      "1 Nov (forecast): no rain, soil moist, canopy near typical as of 27 Oct, alerts: Leaf-feeding pest window for vegetative maize; Heavy rain expected on 4 Nov; Maize prices fell 9% in 30 days",
    );
    expect(conditionCaption(point({ greenness: { ndvi: null, verdict: null, observedOn: null, daysSince: null } }))).toBe("19 Sept: no rain, soil dry, no satellite reading yet");
    expect(conditionCaption(point({ greenness: { ndvi: 0.21, verdict: "no_reference", observedOn: "2026-09-12", daysSince: 7 } }))).toBe("19 Sept: no rain, soil dry, greenness 0.21 as of 12 Sept");
    expect(conditionCaption(rain(null, "unknown"))).toBe("19 Sept: rain not recorded, soil dry, canopy near typical");
  });
  it("a day without a weather record says so and keeps what does not depend on weather", () => {
    expect(conditionCaption(paddyConditionPoints()[2]!)).toBe("27 Aug: No weather record for this day, standing water kept by crop practice, canopy near typical as of 20 Aug");
    expect(conditionCaption(point({ kind: "unavailable", rain: { mm: null, class: "unknown" }, water: { state: "unknown", basis: "none" } }))).toBe(
      "19 Sept: No weather record for this day, canopy near typical",
    );
    expect(conditionCaption(null, "2026-09-21")).toBe("21 Sept: No weather record for this day");
    expect(conditionCaption(null)).toBe("No weather record for this day");
  });
  it("the chip names the weather basis: Observed, Forecast or Typical, none without a record", () => {
    expect(conditionKindChip(point())?.label).toBe("Observed");
    expect(conditionKindChip(rain(1, "very_light", "forecast"))?.label).toBe("Forecast");
    expect(conditionKindChip(rain(1, "very_light", "typical"))?.label).toBe("Typical");
    expect(conditionKindChip(point({ kind: "unavailable" }))).toBeNull();
    expect(conditionKindChip(null)).toBeNull();
    const html = renderToString(() => <ConditionsLine point={rain(48, "moderate", "forecast")} date="2026-09-19" />);
    expect(html).toContain('class="today-chip forecast"');
    expect(text(html)).toBe("Forecast 19 Sept (forecast): 48 mm rain (moderate), soil dry, canopy near typical");
  });
});

describe("hero: conditions in both modes", () => {
  it("the caption line sits under the hero, and the canvas label includes it; the footnote says it is an illustration", () => {
    const html = hero("2026-09-28", "illustration");
    const caption = "28 Sept: 82 mm rain (heavy), field ponded, greenness 0.21 as of 12 Sept";
    expect(text(html)).toContain(`Observed ${caption}`);
    expect(html).toContain('data-testid="today-conditions"');
    expect(html.indexOf('data-testid="today-conditions"')).toBeGreaterThan(html.indexOf('data-testid="today-stage"'));
    expect(html).toContain(`aria-label="Illustration of Maize on your field on 28 Sept 2026. ${caption}. Drawn from weather records and forecasts, not a camera view.`);
    expect(SCENE_FOOTNOTE).toBe("Illustration drawn from weather records and forecasts, not a camera view");
    expect(html).toContain(`<p class="field-growth-footnote">${SCENE_FOOTNOTE}</p>`);
    expect(html).not.toContain("Schematic plants and soil");
    // The scene section exposes what it draws.
    expect(html).toMatch(/data-sky="overcast"[^>]*data-rain-count="84"[^>]*data-water="patches"/);
    expect(html).toContain('class="field-growth-sky" data-sky="overcast"');
  });
  it("a heat day draws the heat haze and no rain; without a conditions series there is no caption line", () => {
    const html = hero("2026-10-05", "illustration");
    expect(html).toMatch(/data-sky="heat"[^>]*data-rain-count="0"[^>]*data-water="none"/);
    const none = hero("2026-10-05", "illustration", { ...fixture, conditions: null }, undefined);
    expect(none).not.toContain("today-conditions");
    expect(none).toContain('data-sky="none"');
    // A series without a point for the day says so.
    expect(text(hero("2026-10-05", "illustration", fixture, null))).toContain("5 Oct: No weather record for this day");
  });
  it("event badges carry severity colour and title, at most two then a count, in both modes", () => {
    const events = at(FIXTURE_TODAY).events;
    const badges = renderToString(() => <EventBadges events={events} />);
    expect(badges).toContain('aria-label="Alerts on this date"');
    expect(badges).toContain('class="today-event severity warning" title="Leaf-feeding pest window for vegetative maize"');
    expect(badges).toContain('class="today-event severity watch" title="Heavy rain expected on 4 Nov"');
    expect(text(badges)).toBe("Leaf-feeding pest window for vegetative maize Heavy rain expected on 4 Nov +1 more");
    expect(renderToString(() => <EventBadges events={[]} />)).toBe("");
    for (const mode of ["illustration", "satellite"] as const) expect(hero(FIXTURE_TODAY, mode)).toContain('data-testid="today-events"');
    expect(hero("2026-09-28")).not.toContain('data-testid="today-events"');
  });
  it("weather depth (WEATHER_DEPTH_SPEC.md 6.4): a wetness badge beside the alerts when high or moderate, with the grid-cell label; caption and chip name the class and the soil-moisture basis", () => {
    // SYNTHETIC pressure and soil-moisture values on the minimal point.
    const pressure = (wetness: "high" | "moderate" | "low" | "unknown") =>
      ({
        wetness,
        leafWetnessPct: wetness === "high" ? 62 : wetness === "moderate" ? 30 : wetness === "low" ? 10 : null,
        rhMeanPct: wetness === "low" ? 60 : wetness === "unknown" ? null : 88.4,
        vpdMaxKpa: 0.42,
        gustMaxKmh: 31,
        basis: wetness === "unknown" ? "none" : "engine_assumption",
      }) as const;
    const wet = point({ water: { state: "moist", basis: "model_soil_moisture", soilMoisture0to7: 0.312 }, pressure: pressure("high") });
    const badges = renderToString(() => <EventBadges events={[]} condition={wet} />);
    expect(badges).toContain('aria-label="Alerts and conditions on this date"');
    expect(badges).toContain('data-wetness="high"');
    expect(text(badges)).toBe("Wet leaves likely");
    expect(badges).toContain(
      'title="High leaf wetness: conditions favour fungal spread (leaf wetness probability 62%, mean humidity 88%). Open-Meteo model estimate for the grid cell, not a field reading. Weather data by Open-Meteo.com."',
    );
    expect(badges).not.toMatch(/blast|blight|mildew|disease/i);
    // Beside the alerts, after them; moderate on a typical day says it is climatology.
    const moderate = renderToString(() => (
      <EventBadges events={at(FIXTURE_TODAY).events} condition={point({ kind: "typical", pressure: pressure("moderate") })} />
    ));
    expect(text(moderate)).toBe("Leaf-feeding pest window for vegetative maize Heavy rain expected on 4 Nov +1 more Leaves wet at times");
    expect(moderate).toContain('data-wetness="moderate"');
    expect(moderate).toContain("Typical (climatology), not a forecast.");
    // Low, unknown and absent pressure draw nothing.
    for (const p of [point({ pressure: pressure("low") }), point({ pressure: pressure("unknown") }), point()])
      expect(renderToString(() => <EventBadges events={[]} condition={p} />)).toBe("");
    // The hero passes the day's point through.
    const view = { ...fixture, conditions: { ...fixture.conditions!, points: fixture.conditions!.points.map((p) => (p.date === "2026-09-28" ? { ...p, pressure: pressure("high") } : p)) } };
    expect(hero("2026-09-28", "satellite", view)).toContain('data-testid="today-wetness"');
    expect(hero("2026-09-28", "satellite")).not.toContain('data-testid="today-wetness"');
    // Caption and chip: the class in words and the soil-moisture basis; the chip note carries the label (one decimal, % of volume).
    expect(conditionCaption(wet)).toBe(
      "19 Sept: no rain, soil moist (model soil moisture), high leaf wetness (model estimate), conditions favour fungal spread, canopy near typical",
    );
    expect(conditionCaption(point({ water: { state: "dry", basis: "model_soil_moisture", soilMoisture0to7: 0.05 }, pressure: pressure("low") }))).toBe(
      "19 Sept: no rain, soil dry (model soil moisture), low leaf wetness (model estimate), canopy near typical",
    );
    expect(conditionKindChip(wet)).toEqual({
      label: "Observed",
      tone: "observed",
      note: "Observed: water: moist (model soil moisture 31.2% by volume), leaf wetness: high. Open-Meteo model estimate for the grid cell, not a field reading. Weather data by Open-Meteo.com.",
    });
    expect(conditionKindChip(point())).toEqual({ label: "Observed", tone: "observed" });
    expect(renderToString(() => <ConditionsLine point={wet} date="2026-09-19" />)).toContain('aria-label="Observed: water: moist (model soil moisture 31.2% by volume)');
    // Review L2: when mean humidity, not leaf wetness, set the class, the words say humidity.
    const humid = (over: Partial<NonNullable<FieldConditionPoint["pressure"]>>) =>
      point({ pressure: { ...pressure("high"), leafWetnessPct: null, rhMeanPct: 92, ...over } });
    expect(text(renderToString(() => <EventBadges events={[]} condition={humid({})} />))).toBe("Humid, leaves may stay wet");
    expect(renderToString(() => <EventBadges events={[]} condition={humid({})} />)).toContain('title="High humidity: conditions favour fungal spread (mean humidity 92%).');
    expect(conditionCaption(humid({}))).toBe("19 Sept: no rain, soil dry, high humidity (model estimate), conditions favour fungal spread, canopy near typical");
    expect(conditionKindChip(humid({}))?.note).toMatch(/^Observed: humidity: high\./);
    // Both inputs, leaf wetness low (10%) and humidity high (92%): humidity drove the class.
    expect(conditionCaption(humid({ leafWetnessPct: 10 }))).toContain("high humidity (model estimate)");
    expect(text(renderToString(() => <EventBadges events={[]} condition={humid({ leafWetnessPct: 10, wetness: "moderate", rhMeanPct: 84 })} />))).toBe("Humid at times");
    // Both inputs with leaf wetness at the class: leaf wetness is named; sourced thresholds the web cannot attribute: both named.
    expect(conditionCaption(humid({ leafWetnessPct: 70 }))).toContain("high leaf wetness (model estimate)");
    expect(conditionCaption(humid({ leafWetnessPct: 10, basis: "sourced_threshold" }))).toContain("high leaf wetness or humidity (model estimate)");
    // Review L3: the illustration canvas label carries the grid-cell label and attribution on such days only.
    const wetView = { ...fixture, conditions: { ...fixture.conditions!, points: fixture.conditions!.points.map((p) => (p.date === "2026-09-28" ? { ...p, pressure: pressure("high") } : p)) } };
    expect(hero("2026-09-28", "illustration", wetView)).toContain(
      "conditions favour fungal spread, greenness 0.21 as of 12 Sept. Open-Meteo model estimate for the grid cell, not a field reading. Weather data by Open-Meteo.com. Drawn from weather records",
    );
    expect(hero("2026-09-28", "illustration")).not.toContain("Open-Meteo model estimate");
  });
  it("the satellite overlay draws rain by class and a water tint over the field polygon, labelled as an overlay", () => {
    const html = hero("2026-10-14");
    expect(html).toContain('class="today-sat-conditions"');
    expect(html).toMatch(/data-rain-count="128" data-water="patches"/);
    expect(html).toContain('class="today-sat-water patches"');
    expect((html.match(/<line /g) ?? []).length).toBe(2 * 128); // each streak plus its wrap-around copy
    expect(text(html)).toContain("Weather overlay");
    // The overlay is a separate SVG; the boundary outline stays one polygon.
    expect((html.match(/class="today-sat-outline"/g) ?? []).length).toBe(1);
    // Forecast rain is dashed.
    const forecast = renderToString(() => <SatelliteConditions layers={conditionLayers(rain(48, "moderate", "forecast"))} water={null} />);
    expect(forecast).toMatch(/class="today-sat-rain\s+is-dashed/);
    // Nothing to draw: no SVG at all.
    expect(renderToString(() => <SatelliteConditions layers={conditionLayers(point())} water="0,0 1,0 1,1" />)).toBe("");
    expect(hero("2026-10-08")).not.toContain("today-sat-conditions");
    expect(text(hero("2026-10-08"))).not.toContain("Weather overlay");
  });
});

describe("satellite field view", () => {
  const observed = (date: string) => sceneFor(fixture.scenes, date, FIXTURE_TODAY, null);
  it("the field close-up is drawn pixelated with the 10 m caption, and the outline uses the field bbox", () => {
    const html = hero("2026-10-20");
    expect(html).toMatch(/<img[^>]*src="[^"]*20261017[^"]*\/image\?kind=visual&amp;zoom=field"[^>]*data-zoom="field"[^>]*style="image-rendering:\s*pixelated/);
    expect(text(html)).toContain("Sentinel-2, 10 m pixels: each square is 10 m");
    expect(html).toMatch(/class="today-sat-box\s+is-field\s*"/);
    expect(html).toMatch(/<button[^>]* type="button" aria-pressed="false">Greenness<\/button>/);
    expect(html).toMatch(/<button[^>]* type="button" aria-pressed="false">Wider view<\/button>/);
    // The field outline is drawn in the field-zoom bbox: a 108 m field fills the middle of a 178 m window.
    const outline = /<polygon points="([^"]+)" vector-effect/.exec(html)![1]!;
    const xs = outline.split(" ").map((pair) => Number(pair.split(",")[0]));
    expect(Math.min(...xs)).toBeGreaterThan(0.15);
    expect(Math.max(...xs)).toBeLessThan(0.85);
  });
  it("Greenness switches to the NDVI colour map of the same zoom, Wider view back to the 600 m image", () => {
    const pick = observed("2026-10-20");
    expect(satelliteImage(pick, { wide: false, greenness: false })).toMatchObject({ zoom: "field", layer: "visual", fieldAvailable: true, ndviAvailable: true });
    expect(satelliteImage(pick, { wide: false, greenness: true }).path).toMatch(/kind=ndvi&zoom=field$/);
    expect(satelliteImage(pick, { wide: true, greenness: false }).path).toMatch(/kind=visual$/);
    expect(satelliteImage(pick, { wide: true, greenness: true }).path).toMatch(/kind=ndvi$/);
    // A scene without the field render shows the wide image; no Wider view toggle, Greenness stays.
    const latest = observed(FIXTURE_TODAY);
    expect(satelliteImage(latest, { wide: false, greenness: false })).toMatchObject({ zoom: "wide", fieldAvailable: false, ndviAvailable: true });
    const html = hero(FIXTURE_TODAY);
    expect(html).not.toContain("image-rendering");
    expect(html).not.toContain("Wider view");
    expect(html).toContain(">Greenness</button>");
    expect(text(html)).not.toContain("10 m pixels");
    // An illustration has no options; no image has none either.
    const illustration = sceneFor(fixture.scenes, "2026-12-10", FIXTURE_TODAY, "grain_fill");
    expect(satelliteImage(illustration, { wide: false, greenness: true })).toMatchObject({ layer: "visual", fieldAvailable: false, ndviAvailable: false });
    expect(satelliteImage({ mode: "none", reason: "no_scenes" }, { wide: false, greenness: false }).path).toBeNull();
    // A field render without its NDVI twin offers no Greenness at the field zoom.
    const noNdvi = fixture.scenes.map((s): SceneRef => ({ ...s, fieldNdviImagePath: null }));
    expect(satelliteImage(sceneFor(noNdvi, "2026-10-20", FIXTURE_TODAY, null), { wide: false, greenness: true })).toMatchObject({ layer: "visual", ndviAvailable: false });
  });
  it("the NDVI legend runs -0.2 to 0.9, red to green, with a spoken description", () => {
    const html = renderToString(() => <NdviLegend />);
    expect(text(html)).toBe("−0.2 0.9");
    expect(html).toContain('role="img"');
    expect(html).toContain("red at NDVI −0.2 or lower");
    const css = readFileSync(new URL("./today.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.today-ndvi-bar \{[^}]*linear-gradient\(90deg, #a50026,[^}]*#006837\)/);
    expect(css).toMatch(/\.today-sat-box\.is-field img,\s*\.today-sat-prev\.is-field \{\s*image-rendering: pixelated;/);
  });
  it("the caption names which image is shown and how many days before the slider date it was taken", () => {
    expect(sceneAgeCaption(observed("2026-09-19"), "2026-09-19")).toBe("Image of 12 Sept 2026 (7 days before this date)");
    expect(sceneAgeCaption(observed("2026-10-17"), "2026-10-17")).toBe("Image of 17 Oct 2026 (taken on this date)");
    expect(sceneAgeCaption(observed("2026-10-18"), "2026-10-18")).toBe("Image of 17 Oct 2026 (1 day before this date)");
    expect(sceneAgeCaption(sceneFor(fixture.scenes, "2026-11-15", FIXTURE_TODAY, "tasselling"), "2026-11-15")).toBe("Latest image 27 Oct 2026 (19 days before this date)");
    expect(text(hero("2026-09-19"))).toContain("Observed Image of 12 Sept 2026 (7 days before this date) Cloud 34%");
  });
  it("a future date without an illustration dims the latest image under the overlay and says there is no image yet", () => {
    const later = sceneFor(fixture.scenes, "2026-11-15", FIXTURE_TODAY, "tasselling");
    expect(futureImageLabel(later)).toBe("No image yet for this date; latest image 27 Oct");
    const html = hero("2026-11-15");
    expect(html).toMatch(/class="today-sat-box\s+is-dimmed\s*"/);
    expect(html).toContain('data-testid="today-sat-future"');
    expect(text(html)).toContain("No image yet for this date; latest image 27 Oct");
    expect(text(html)).toContain("Latest image 27 Oct 2026");
    expect(html).toContain("No image yet for this date\"");
    // Past the forecast horizon the typical (climatology) drizzle still draws over the dimmed image, dashed.
    const typical = hero("2026-11-20");
    expect(typical).toMatch(/class="today-sat-box\s+is-dimmed/);
    expect(typical).toMatch(/class="today-sat-rain\s+is-dashed/);
    // With a stage illustration the illustration shows, undimmed, without the label.
    const illustration = hero("2026-12-10");
    expect(illustration).toContain('data-scene-kind="illustration"');
    expect(illustration).not.toContain("is-dimmed");
    expect(illustration).not.toContain("today-sat-future");
    expect(futureImageLabel(sceneFor(fixture.scenes, "2026-10-20", FIXTURE_TODAY, null))).toBeNull();
  });
});

describe("slider scene marks and play", () => {
  afterEach(() => vi.useRealTimers());
  it("marks every observed scene date and the illustration date inside the slider range, positioned by day", () => {
    const marks = sceneMarks(fixture.scenes, model);
    // 12 Sep is before sowing (15 Sep) and is left off.
    expect(marks.map((m) => `${m.kind}:${m.date}`)).toEqual([
      "observed:2026-09-22", "observed:2026-10-02", "observed:2026-10-07", "observed:2026-10-12",
      "observed:2026-10-17", "observed:2026-10-22", "observed:2026-10-27", "illustration:2026-12-10",
    ]);
    for (const mark of marks) expect(mark.fraction).toBeCloseTo(daysBetween(model.from, mark.date) / model.total, 10);
    // Duplicate dates collapse; scenes without an image are not marked.
    const doubled = [...fixture.scenes, { ...fixture.scenes[3]! }, { ...fixture.scenes[4]!, imagePath: null, acquisitionDate: "2026-10-30", date: "2026-10-30" }];
    expect(sceneMarks(doubled, model)).toEqual(marks);
    const html = renderToString(() => (
      <StageSlider model={model} value={model.todayIndex} onChange={() => undefined} valueDate={FIXTURE_TODAY} ticks={[]} onBackToToday={() => undefined} startLabel="Sown" endLabel="Harvest" marks={marks} />
    ));
    expect((html.match(/class="today-slider-mark observed"/g) ?? []).length).toBe(7);
    expect(html).toContain(`class="today-slider-mark illustration" style="left:${(daysBetween(model.from, "2026-12-10") / model.total) * 100}%"`);
    expect(html).toContain('title="Satellite image 22 Sept 2026"');
    expect(text(html)).toContain("Dots on the slider mark the 7 dates with a satellite image.");
  });
  it("Play and Pause: a toggle button with aria-pressed beside Back to today", () => {
    const slider = (playing: boolean, value = 10) =>
      renderToString(() => (
        <StageSlider model={model} value={value} onChange={() => undefined} valueDate="2026-09-25" ticks={[]} onBackToToday={() => undefined} startLabel="Sown" endLabel="Harvest" playing={playing} onPlay={() => undefined} />
      ));
    const idle = slider(false);
    expect(idle).toMatch(/<button[^>]* type="button" class="today-play\s*" aria-pressed="false" data-testid="today-play">.*<span>Play<\/span><\/button>/);
    expect(idle.indexOf("Back to today")).toBeLessThan(idle.indexOf("today-play"));
    const on = slider(true);
    expect(on).toMatch(/class="today-play\s+is-playing\s*" aria-pressed="true"/);
    expect(text(on)).toContain("Pause");
    // Without a handler there is no button.
    expect(
      renderToString(() => (
        <StageSlider model={model} value={1} onChange={() => undefined} valueDate="2026-09-16" ticks={[]} onBackToToday={() => undefined} startLabel="Sown" endLabel="Harvest" />
      )),
    ).not.toContain("today-play");
  });
  it("the player steps one day per 120 ms from the current position to the end, then stops", () => {
    vi.useFakeTimers();
    let position = 10;
    const states: boolean[] = [];
    const player = createSeasonPlayer({ position: () => position, total: () => 14, step: (i) => (position = i), onChange: (p) => states.push(p) });
    player.start();
    expect(player.playing).toBe(true);
    vi.advanceTimersByTime(PLAY_STEP_MS - 1);
    expect(position).toBe(10);
    vi.advanceTimersByTime(1);
    expect(position).toBe(11);
    vi.advanceTimersByTime(PLAY_STEP_MS * 3);
    expect(position).toBe(14);
    expect(player.playing).toBe(false);
    vi.advanceTimersByTime(PLAY_STEP_MS * 5);
    expect(position).toBe(14);
    expect(states).toEqual([true, false]);
  });
  it("any interaction stops it at once; at the end Play restarts from the first day; nothing plays on an empty range", () => {
    vi.useFakeTimers();
    let position = 3;
    const player = createSeasonPlayer({ position: () => position, total: () => 50, step: (i) => (position = i) });
    player.start();
    player.start(); // a second start does not double the speed
    vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    expect(position).toBe(5);
    player.stop();
    vi.advanceTimersByTime(PLAY_STEP_MS * 10);
    expect(position).toBe(5);
    expect(player.playing).toBe(false);
    position = 50;
    player.start();
    expect(position).toBe(0);
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(position).toBe(1);
    player.stop();
    const empty = createSeasonPlayer({ position: () => 0, total: () => 0, step: () => undefined });
    empty.start();
    expect(empty.playing).toBe(false);
  });
});
