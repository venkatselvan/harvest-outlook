import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { CarbonFootprint as carbonSchema, EnergyFootprint as energySchema, FarmAlert as alertSchema, FarmAlertType, HarvestEconomics as economicsSchema, INDEX_IDS, ResidueIncome as residueSchema, IndexStageReading as curveSchema, TodayView as todaySchema, type FarmAlert, type NdviSeries, type SceneRef, type StageTimeline } from "@harvest/contracts";
import { ApiError } from "../../lib/api";
import {
  carbonFootprintFixture,
  overviewDeterministicFixture,
  overviewFixture,
  overviewPendingFixture,
  overviewUnavailableFixture,
  carbonFootprintNoAreaFixture,
  carbonFootprintPartialFixture,
  carbonFootprintUnavailableFixture,
  energyFootprintFixture,
  energyFootprintPartialFixture,
  energyFootprintUnavailableFixture,
  harvestEconomicsFixture,
  harvestEconomicsPartialFixture,
  harvestEconomicsUnavailableFixture,
  residueIncomeFixture,
  residueIncomeUnavailableFixture,
  FIXTURE_ALERT_IDS,
  FIXTURE_FARM_ID,
  FIXTURE_HARVEST,
  FIXTURE_SOWN,
  FIXTURE_TODAY,
  LATEST_ITEM_ID,
  itemIdFor,
  indexStageFixture,
  indexStageInsufficientFixture,
  indexStageSpanFixture,
  indexStageUnavailableFixture,
  indicesFor,
  todayEmptyFixture,
  todayFixture,
} from "./fixtures";
import {
  addDays,
  bestResidueOption,
  carbonTermLine,
  co2eParts,
  compactInr,
  energyBasisShort,
  compactInrRange,
  costValue,
  formatCo2e,
  formatGJ,
  formatTonnes,
  largestCarbonTerm,
  profitValue,
  rangeText,
  rankChip,
  residueTitle,
  unavailableReason,
  CURVE_MIN_READINGS,
  CURVE_MIN_SPAN_DAYS,
  curveAsOfNote,
  curveLine,
  curvePhaseText,
  dateAtIndex,
  dayNumber,
  daysBetween,
  formatDay,
  formatIndex,
  growthProgress,
  INDEX_INFO,
  indexLine,
  indexOfDate,
  nextStage,
  priceAt,
  priceTrend,
  rangeLabel,
  sceneFor,
  shortInrRange,
  sliderModel,
  stageAt,
  stageTicks,
  weatherAt,
  windowLabel,
  nextActionWhen,
  pickNextStep,
} from "./model";
import { describeTodayError, sceneImageUrl } from "./todayApi";
import { TodayEmpty } from "./TodayEmpty";
import { TodayOverview, pointTarget, showsAiMark } from "./TodayOverview";
import { alertDomId } from "./AlertsList";
import { stepDomId } from "./UpcomingSteps";
import { TodayOverview as overviewSchema } from "@harvest/contracts";
import { CarbonCard, EnergyCard, HealthCard, OutlookLine, ProfitCard, ResidueCard, TodayCards } from "./TodayCards";
import { CarbonSheetBody, CurveSheetBody, EnergySheetBody, IndexTable, ProfitSheetBody, ResidueSheetBody, sheetTitle, TodaySheetBody } from "./TodaySheet";
import { UpcomingSteps } from "./UpcomingSteps";
import { AlertsList } from "./AlertsList";
import type { UpcomingStep } from "@harvest/contracts";
import { CurveLine, TodayHero, stageOverlay } from "./TodayHero";
import { newsReviewText, sortAlerts } from "./AlertsList";
import { careTaskStep } from "./TodayView";

const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const fixture = todayFixture();
const timeline = fixture.timeline!;

describe("Today fixture", () => {
  it("validates against the TodayView contract, with and without a crop", () => {
    expect(todaySchema.safeParse(fixture).success).toBe(true);
    expect(todaySchema.safeParse(todayEmptyFixture()).success).toBe(true);
    const other = "22222222-2222-4222-8222-222222222222";
    const parsed = todaySchema.parse(todayFixture(other));
    expect(parsed.farmId).toBe(other);
    expect(parsed.alerts.every((alert) => alert.farmId === other)).toBe(true);
    expect(parsed.scenes.every((scene) => !scene.imagePath || scene.imagePath.startsWith(`/api/v1/farms/${other}/`))).toBe(true);
  });
  it("covers the scenario the brief asks for", () => {
    expect(fixture.cycle).toMatchObject({ cropId: "maize", sowingDate: "2026-09-15" });
    expect(timeline.stages).toHaveLength(5);
    expect(fixture.scenes.filter((scene) => scene.kind === "observed")).toHaveLength(8);
    expect(fixture.scenes.filter((scene) => scene.kind === "illustration")).toHaveLength(1);
    expect(new Set(fixture.alerts.map((alert) => alert.type)).size).toBe(3);
    expect(fixture.upcoming).toHaveLength(4);
    // Weather has one point per slider day; price points are never more than a week apart across the slider.
    const days = daysBetween(fixture.slider!.from, fixture.slider!.to);
    for (let i = 0; i <= days; i++) {
      const date = addDays(fixture.slider!.from, i);
      expect(weatherAt(fixture.weatherTrack, date)?.date).toBe(date);
      expect(priceAt(fixture.priceTrack, date)).not.toBeNull();
    }
    // Nothing beyond the forecast horizon is labelled a forecast.
    const lastForecast = fixture.weatherTrack.filter((p) => p.kind === "forecast").at(-1)!;
    expect(daysBetween(FIXTURE_TODAY, lastForecast.date)).toBe(15);
    expect(fixture.weatherTrack.filter((p) => p.date > lastForecast.date).every((p) => p.kind === "typical" && p.basis.years?.length === 3)).toBe(true);
    // Every alert links to a dated source.
    expect(fixture.alerts.every((alert) => /^https:\/\//.test(alert.source.url) && /^\d{4}-\d{2}-\d{2}$/.test(alert.source.date))).toBe(true);
  });
});

describe("slider date math", () => {
  it("opens at the server's today and maps every step to one calendar day", () => {
    const model = sliderModel(fixture)!;
    expect(model).toMatchObject({ from: FIXTURE_SOWN, to: FIXTURE_HARVEST.latest, total: 120, todayIndex: 47 });
    expect(dateAtIndex(model, model.todayIndex)).toBe(FIXTURE_TODAY);
    expect(dateAtIndex(model, 0)).toBe(FIXTURE_SOWN);
    expect(dateAtIndex(model, model.total)).toBe(FIXTURE_HARVEST.latest);
    expect(dateAtIndex(model, -5)).toBe(FIXTURE_SOWN);
    expect(dateAtIndex(model, 999)).toBe(FIXTURE_HARVEST.latest);
    expect(dateAtIndex(model, 86)).toBe("2026-12-10");
    expect(indexOfDate(model, "2026-12-10")).toBe(86);
    expect(indexOfDate(model, "2030-01-01")).toBe(120);
  });
  it("clamps today into the range and falls back to todayProgress only when today does not parse", () => {
    expect(sliderModel({ ...fixture, today: "2027-03-01" })!.todayIndex).toBe(120);
    expect(sliderModel({ ...fixture, today: "2026-09-01" })!.todayIndex).toBe(0);
    expect(sliderModel({ ...fixture, today: "not-a-date" })!.todayIndex).toBe(Math.round(fixture.slider!.todayProgress * 120));
    expect(sliderModel({ ...fixture, slider: null })).toBeNull();
    expect(sliderModel({ ...fixture, slider: { from: "2026-10-01", to: "2026-09-01", todayProgress: 0 } })).toBeNull();
  });
  it("does calendar arithmetic in UTC, across month, year and leap-day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
    expect(Number.isNaN(dayNumber("2026-02-31"))).toBe(true);
    expect(Number.isNaN(dayNumber("2026-11-1"))).toBe(true);
    expect(formatDay("2026-11-01")).toBe("1 Nov 2026");
    expect(rangeLabel("2026-11-12", "2026-12-03")).toBe("12 Nov to 3 Dec");
    expect(rangeLabel("2026-12-29", "2027-01-08")).toBe(`${formatDay("2026-12-29")} to ${formatDay("2027-01-08")}`);
  });
});

describe("stage lookup", () => {
  it("finds the calendar stage for a date, with inclusive boundaries", () => {
    const at = (date: string) => {
      const found = stageAt(timeline, date);
      return found.kind === "stage" ? found.stage.id : found.kind;
    };
    expect(at("2026-09-15")).toBe("emergence");
    expect(at(FIXTURE_TODAY)).toBe("vegetative");
    expect(at("2026-11-08")).toBe("vegetative");
    expect(at("2026-11-09")).toBe("tasselling");
    expect(at("2026-12-10")).toBe("grain_fill");
    expect(at("2027-01-08")).toBe("maturity");
    expect(at("2027-01-10")).toBe("harvest");
    expect(at("2027-02-01")).toBe("after");
    expect(at("2026-09-01")).toBe("before");
    expect(stageAt(null, FIXTURE_TODAY).kind).toBe("none");
  });
  it("assigns a gap between stages to the earlier stage and labels basis honestly", () => {
    const gapped: StageTimeline = {
      ...timeline,
      stages: [
        { id: "a", name: "A", from: "2026-01-01", to: "2026-01-10", basis: "estimate" },
        { id: "b", name: "B", from: "2026-01-13", to: "2026-01-20", basis: "fao_generic" },
      ],
      harvest: null,
    };
    const gap = stageAt(gapped, "2026-01-11");
    expect(gap.kind === "stage" && gap.stage.id).toBe("a");
    expect(stageAt(gapped, "2026-01-21")).toEqual({ kind: "after", lastDate: "2026-01-20" });
    expect(stageOverlay(stageAt(gapped, "2026-01-15"))).toEqual({ name: "B", range: "13 Jan to 20 Jan", caption: "Stage estimate from standard crop coefficients" });
    expect(stageOverlay(stageAt(gapped, "2026-01-02")).caption).toBe("Stage estimate");
  });
  it("gives the next stage, stage-boundary ticks and schematic growth progress", () => {
    expect(nextStage(timeline, FIXTURE_TODAY)?.id).toBe("tasselling");
    expect(nextStage(timeline, "2027-01-01")).toBeNull();
    const ticks = stageTicks(timeline, sliderModel(fixture)!);
    expect(ticks.map((tick) => tick.id)).toEqual(["after-sowing", "vegetative", "tasselling", "grain_fill", "maturity", "before-harvest", "harvest"]);
    expect(ticks.find(tick => tick.id === "tasselling")!.fraction).toBeCloseTo(55 / 120, 6);
    expect(growthProgress(timeline, FIXTURE_SOWN)).toBe(0);
    expect(growthProgress(timeline, FIXTURE_HARVEST.latest)).toBe(1);
    expect(growthProgress(timeline, "2030-01-01")).toBe(1);
    expect(growthProgress(timeline, FIXTURE_TODAY)).toBeCloseTo(47 / 120, 6);
    expect(growthProgress(null, FIXTURE_TODAY)).toBe(0);
  });
});

describe("price and weather lookup by date", () => {
  it("uses the latest weekly price point within seven days, observed before today and reference after", () => {
    expect(priceAt(fixture.priceTrack, FIXTURE_TODAY)).toMatchObject({ date: "2026-10-26", kind: "observed" });
    expect(priceAt(fixture.priceTrack, "2026-12-10")).toMatchObject({ date: "2026-12-07", kind: "reference" });
    expect(priceAt(fixture.priceTrack, "2025-10-01")).toBeNull();
    const sparse = [fixture.priceTrack[0]!];
    expect(priceAt(sparse, addDays(sparse[0]!.date, 7))).not.toBeNull();
    expect(priceAt(sparse, addDays(sparse[0]!.date, 8))).toBeNull();
    // Order of the track does not matter.
    expect(priceAt([...fixture.priceTrack].reverse(), "2026-12-10")?.date).toBe("2026-12-07");
  });
  it("uses only the exact weather day and keeps observed, forecast and typical apart", () => {
    expect(weatherAt(fixture.weatherTrack, "2026-10-31")?.kind).toBe("observed");
    expect(weatherAt(fixture.weatherTrack, FIXTURE_TODAY)?.kind).toBe("forecast");
    expect(weatherAt(fixture.weatherTrack, "2026-12-10")).toMatchObject({ kind: "typical", basis: { years: [2023, 2024, 2025] } });
    expect(weatherAt(fixture.weatherTrack, "2027-02-01")).toBeNull();
    expect(weatherAt(fixture.weatherTrack.filter((p) => p.date !== "2026-12-10"), "2026-12-10")).toBeNull();
  });
  it("states a price trend only over observed points in the last 12 months", () => {
    const trend = priceTrend(fixture.priceTrack, FIXTURE_TODAY)!;
    expect(trend).toMatchObject({ direction: "up", since: "2025-11-03", until: "2026-10-26" });
    expect(trend.pct).toBeGreaterThanOrEqual(3);
    expect(priceTrend(fixture.priceTrack.filter((p) => p.kind === "reference"), FIXTURE_TODAY)).toBeNull();
    expect(priceTrend(fixture.priceTrack.slice(-13, -11), FIXTURE_TODAY)).toBeNull();
  });
  it("formats card ranges outward so they never look narrower than the data", () => {
    expect(shortInrRange(19.2, 23.8)).toBe("₹19–24");
    expect(shortInrRange(4.25, 6.81)).toBe("₹4.2–6.9");
    expect(shortInrRange(20, 24)).toBe("₹20–24");
    expect(shortInrRange(1840.5, 2210.2)).toBe("₹1,840–2,211");
  });
});

describe("satellite scene selection", () => {
  const scenes = fixture.scenes;
  it("shows the nearest observed scene on or before a past date", () => {
    const pick = sceneFor(scenes, "2026-10-20", FIXTURE_TODAY, "vegetative");
    expect(pick.mode).toBe("observed");
    expect(pick.mode !== "none" && pick.scene.acquisitionDate).toBe("2026-10-17");
    const exact = sceneFor(scenes, "2026-10-17", FIXTURE_TODAY, "vegetative");
    expect(exact.mode !== "none" && exact.scene.acquisitionDate).toBe("2026-10-17");
    expect(sceneFor(scenes, "2026-09-01", FIXTURE_TODAY, null)).toEqual({ mode: "none", reason: "none_before_date" });
    expect(sceneFor([], FIXTURE_TODAY, FIXTURE_TODAY, null)).toEqual({ mode: "none", reason: "no_scenes" });
  });
  it("shows the stage illustration for a future date, else the latest observed scene", () => {
    const future = sceneFor(scenes, "2026-12-10", FIXTURE_TODAY, "grain_fill");
    expect(future.mode).toBe("illustration");
    expect(future.mode === "illustration" && future.derivedFrom?.itemId).toBe(LATEST_ITEM_ID);
    const noIllustration = sceneFor(scenes, "2026-11-15", FIXTURE_TODAY, "tasselling");
    expect(noIllustration.mode).toBe("latest");
    expect(noIllustration.mode === "latest" && noIllustration.scene.acquisitionDate).toBe("2026-10-27");
    // An illustration without an image falls back to the latest observed scene.
    const withoutImage = scenes.map((scene): SceneRef => (scene.kind === "illustration" ? { ...scene, imagePath: null } : scene));
    expect(sceneFor(withoutImage, "2026-12-10", FIXTURE_TODAY, "grain_fill").mode).toBe("latest");
  });
  it("only loads owner-private same-origin image paths", () => {
    expect(sceneImageUrl(`/api/v1/farms/${FIXTURE_FARM_ID}/ndvi/${itemIdFor("2026-10-27", 7)}/image?kind=visual`)).toContain("/ndvi/");
    expect(sceneImageUrl("https://example.org/scene.png")).toBeNull();
    expect(sceneImageUrl("//example.org/api/v1/farms/x")).toBeNull();
    expect(sceneImageUrl("/api/v1/farms//x")).toBeNull();
    expect(sceneImageUrl(null)).toBeNull();
  });
});

describe("rendered states", () => {
  it("no crop: the planting entry and the year plan link replace the hero", () => {
    let planted = 0;
    const html = renderToString(() => (
      <Router url="/farm">
        <Route path="/farm" component={() => <TodayEmpty onPlant={() => planted++} canPlant />} />
      </Router>
    ));
    expect(text(html)).toContain("What's growing on this field?");
    expect(text(html)).toContain("Plant a crop");
    expect(html).toContain('href="/planner"');
    expect(planted).toBe(0);
  });
  it("no crop: only weather (and health when present) cards, weather from the server's today", () => {
    const empty = todayEmptyFixture();
    const html = text(
      renderToString(() => (
        <TodayCards view={empty} date={empty.today} price={null} weather={weatherAt(empty.weatherTrack, empty.today)} weatherOnly onDetails={() => undefined} />
      )),
    );
    expect(html).toContain("Weather on 1 Nov");
    expect(html).toContain("Forecast");
    expect(html).not.toContain("Days to harvest");
    expect(html).not.toContain("Expected price at harvest");
    expect(html).not.toContain("Vegetation health");
  });
  it("cards show ranges with basis lines and the slider-date price when it differs", () => {
    const date = "2026-12-10";
    const html = text(
      renderToString(() => (
        <TodayCards view={fixture} date={date} price={priceAt(fixture.priceTrack, date)} weather={weatherAt(fixture.weatherTrack, date)} onDetails={() => undefined} />
      )),
    );
    expect(html).toContain("63–73 days");
    expect(html).toContain("Harvest window 3 Jan to 13 Jan");
    expect(html).toContain("₹19–24 /kg");
    expect(html).toContain("₹19.2 to ₹23.8 per kg");
    expect(html).toContain("Historical mandi range · not a farm-gate forecast");
    expect(html).toMatch(/10 Dec: ₹21\.\d\/kg typical/);
    expect(html).toContain("Seasonal reference, not a forecast");
    expect(html).toContain("0.62");
    expect(html).toContain("Within the stage greenness range");
    expect(html).toContain("Satellite signal, not a diagnosis");
  });
  it("satellite hero names the observed date, cloud and the illustration label", () => {
    const hero = (date: string) =>
      renderToString(() => (
        <TodayHero
          mode="satellite"
          onMode={() => undefined}
          date={date}
          today={FIXTURE_TODAY}
          stage={stageAt(timeline, date)}
          progress={growthProgress(timeline, date)}
          cropId="maize"
          cropName="Maize"
          boundary={null}
          scenes={fixture.scenes}
          imageBbox={fixture.ndvi!.imageBbox}
        />
      ));
    const past = hero("2026-10-20");
    // Spec section 10: the caption names which image is shown and how old it is; the 17 Oct scene has a 10 m field render.
    expect(text(past)).toContain("Observed Image of 17 Oct 2026 (3 days before this date) Cloud 6%");
    expect(past).toContain(`alt="Satellite image of your field, observed 17 Oct 2026, 6% cloud in the scene. Close-up at 10 m pixels"`);
    const future = text(hero("2026-12-10"));
    expect(future).toContain("Grain filling · 29 Nov to 28 Dec");
    expect(future).toContain("Illustration of a typical Grain filling");
    expect(future).toContain("10 Dec 2026");
    const later = text(hero("2026-11-15"));
    expect(later).toContain("Latest image 27 Oct 2026");
  });
});

describe("alerts, steps and errors", () => {
  it("orders alerts by severity and words the news review status", () => {
    expect(sortAlerts(fixture.alerts).map((alert) => alert.severity)).toEqual(["warning", "watch", "info"]);
    expect(newsReviewText(fixture.newsReview, FIXTURE_TODAY)).toBe("News and official warnings checked today via Meta search");
    expect(newsReviewText({ status: "active", reason: null, lastReviewedAt: "2026-10-30T03:00:00Z" }, FIXTURE_TODAY)).toBe("News and official warnings checked 30 Oct via Meta search");
    expect(newsReviewText({ status: "paused", reason: "cap", lastReviewedAt: null }, FIXTURE_TODAY)).toBe("News and warnings search paused");
    expect(newsReviewText(null, FIXTURE_TODAY)).toBe("News and warnings search not set up");
    expect(fixture.upcoming.find((step) => step.kind === "alert_step")?.alertId).toBe(FIXTURE_ALERT_IDS.weather);
  });
  it("maps a care-schedule task to a step for the degraded view", () => {
    const task = fixture.upcoming[0]!.careTask!;
    expect(careTaskStep(task)).toMatchObject({ id: "care:task-moisture", kind: "care_task", status: "due", careTask: task, alertId: null });
  });
  it("describes a missing endpoint, a network failure and a malformed response in plain words", () => {
    expect(describeTodayError(new ApiError("not_found", "Not Found", 404)).kind).toBe("not_available");
    expect(describeTodayError(new ApiError("network_error", "Could not reach the server", 0)).kind).toBe("network");
    expect(describeTodayError(new ApiError("invalid_envelope", "bad", 200)).kind).toBe("invalid");
    expect(describeTodayError(new Error("boom")).kind).toBe("server");
  });
});

describe("Today v2: next action, dated steps, outlook line, warnings header", () => {
  const step = (o: Partial<UpcomingStep> & Pick<UpcomingStep, "id" | "kind" | "status" | "dueFrom">): UpcomingStep => ({
    title: o.id, detail: null, dueTo: o.dueFrom, careTask: null, alertId: null, ...o,
  });
  it("every window reads as dates, never Expected without a date", () => {
    expect(windowLabel("2026-11-03", "2026-11-09")).toBe("3 to 9 Nov");
    expect(windowLabel("2026-10-28", "2026-11-03")).toBe("28 Oct to 3 Nov");
    expect(windowLabel("2026-12-28", "2027-01-03")).toBe("28 Dec 2026 to 3 Jan 2027");
    expect(windowLabel("2026-11-09", "2026-11-09")).toBe("9 Nov");
  });
  it("words the next action's window: between, on, due today, overdue since, done", () => {
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "upcoming", dueFrom: "2026-11-03", dueTo: "2026-11-09" }), FIXTURE_TODAY)).toBe("Do between 3 and 9 Nov");
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "upcoming", dueFrom: "2026-11-09" }), FIXTURE_TODAY)).toBe("Do on 9 Nov");
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "due", dueFrom: "2026-10-30", dueTo: FIXTURE_TODAY }), FIXTURE_TODAY)).toBe("Due today");
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "due", dueFrom: "2026-10-31", dueTo: "2026-11-02" }), FIXTURE_TODAY)).toBe("Do between 31 Oct and 2 Nov");
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "overdue", dueFrom: "2026-10-25", dueTo: "2026-10-28" }), FIXTURE_TODAY)).toBe("Overdue since 28 Oct");
    expect(nextActionWhen(step({ id: "a", kind: "care_task", status: "completed", dueFrom: "2026-10-25" }), FIXTURE_TODAY)).toBe("Done");
  });
  it("the client rule matches the server: care and alert steps first, then overdue, due, upcoming", () => {
    const check = step({ id: "check", kind: "stage_check", status: "overdue", dueFrom: "2026-10-20", dueTo: "2026-10-25" });
    const care = step({ id: "care", kind: "care_task", status: "upcoming", dueFrom: "2026-11-05" });
    const alert = step({ id: "alert", kind: "alert_step", status: "due", dueFrom: "2026-11-01", dueTo: "2026-11-03" });
    expect(pickNextStep([check, care])?.id).toBe("care");
    expect(pickNextStep([check, care, alert])?.id).toBe("alert");
    expect(pickNextStep([check])?.id).toBe("check");
    expect(pickNextStep([{ ...care, status: "completed" }])).toBeNull();
  });
  it("renders the bold next action with its window, action and Done, and the list from the second step", () => {
    const html = renderToString(() => (
      <UpcomingSteps steps={fixture.upcoming} nextAction={fixture.nextAction} today={FIXTURE_TODAY} busyId="" onDone={() => undefined} error="" />
    ));
    const t = text(html);
    expect(html).toContain('data-testid="today-next-action"');
    expect(t).toMatch(/Next action Check field moisture Do between 31 Oct and 2 Nov Inspect the field before deciding on irrigation\./);
    expect(html).toContain('aria-label="Mark done: Check field moisture"');
    // The list starts with the second step and every line has a window.
    expect(t.indexOf("Clear field drains before 4 Nov")).toBeGreaterThan(t.indexOf("Check field moisture"));
    expect(t).toContain("1 to 3 Nov");
    expect(t).toContain("5 to 10 Nov");
    expect(t).toContain("9 Nov");
    expect(t).not.toContain("Expected");
    expect((html.match(/data-step-id="care:task-moisture"/g) ?? []).length).toBe(1);
    expect((html.match(/<li /g) ?? []).length).toBe(3);
  });
  it("a stage check or guidance step has no Done button, even as the next action", () => {
    const guidance = step({ id: "ref:1", kind: "care_task", status: "due", dueFrom: "2026-11-01", dueTo: "2026-11-04", title: "Check stand and thin doubles", detail: "Guidance from Tamil Nadu sources (no local schedule for Hassan). Thin doubles." });
    const check = step({ id: "check:1", kind: "stage_check", status: "upcoming", dueFrom: "2026-11-20", dueTo: "2026-12-30", title: "Check: Protect flowering moisture" });
    const html = renderToString(() => <UpcomingSteps steps={[guidance, check]} nextAction={guidance} today={FIXTURE_TODAY} busyId="" onDone={() => undefined} error="" />);
    expect(text(html)).toContain("Guidance from Tamil Nadu sources (no local schedule for Hassan)");
    expect(text(html)).toContain("20 Nov to 30 Dec");
    expect(html).not.toContain("Mark done");
  });
  it("outlook line: the sentence with the AI mark, Writing the outlook while pending, nothing when unavailable", () => {
    const ready = renderToString(() => <OutlookLine note={fixture.outlookNote ?? null} />);
    expect(text(ready)).toContain("Maize grain in Karnataka has usually fetched ₹19 to ₹24 per kg around harvest");
    expect(ready).toContain("AI used: Harvest price outlook in words");
    const pending = renderToString(() => <OutlookLine note={{ status: "pending", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null }} />);
    expect(text(pending)).toContain("Writing the outlook…");
    const code = renderToString(() => <OutlookLine note={{ ...fixture.outlookNote!, origin: "deterministic", text: "Prices for maize grain around the harvest weeks have ranged ₹19 to ₹24 per kg over the last 3 years in Karnataka." }} />);
    expect(text(code)).toContain("over the last 3 years in Karnataka");
    expect(code).not.toContain("AI used");
    expect(text(renderToString(() => <OutlookLine note={{ status: "unavailable", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null }} />))).toBe("");
    expect(text(renderToString(() => <OutlookLine note={null} />))).toBe("");
    // On the card, under the range.
    const card = text(renderToString(() => <TodayCards view={fixture} date={FIXTURE_TODAY} price={null} weather={null} onDetails={() => undefined} />));
    expect(card.indexOf("Maize grain in Karnataka")).toBeGreaterThan(card.indexOf("₹19–24 /kg"));
  });
  it("alerts header names the Meta search with the AI mark; the IMD line is not on the main surface", () => {
    const html = renderToString(() => (
      <AlertsList alerts={fixture.alerts} newsReview={fixture.newsReview} today={FIXTURE_TODAY} stepAlertIds={new Set()} onDismiss={() => undefined} onSuggested={() => undefined} error="" />
    ));
    expect(text(html)).toContain("News and official warnings checked today via Meta search");
    expect(html).toContain("AI used: Daily news check");
    expect(text(html)).not.toContain("IMD");
  });
});

describe("spectral indices and the stage reader", () => {
  const latest = () => fixture.ndvi!.latestUsable!;
  /** The fixture's NdviSeries with the latest reading's index summaries replaced. */
  const withIndices = (indices: NdviSeries["readings"][number]["field"]["indices"]): NdviSeries => {
    const field = { ...latest().field };
    if (indices) field.indices = indices;
    else delete field.indices;
    return { ...fixture.ndvi!, latestUsable: { ...latest(), field } };
  };
  /** What a sighted reader sees: the screen-reader-only spans are dropped. */
  const seen = (html: string) => text(html.replace(/<span class="today-sr"[^>]*>[\s\S]*?<\/span>/g, ""));
  const card = (ndvi: NdviSeries | null) => renderToString(() => <HealthCard health={fixture.health} ndvi={ndvi} onDetails={() => undefined} />);
  const hero = (indexStage: TodayHeroIndexStage, date = FIXTURE_TODAY) =>
    renderToString(() => (
      <TodayHero
        mode="satellite"
        onMode={() => undefined}
        date={date}
        today={FIXTURE_TODAY}
        stage={stageAt(timeline, date)}
        progress={growthProgress(timeline, date)}
        cropId="maize"
        cropName="Maize"
        boundary={null}
        scenes={fixture.scenes}
        imageBbox={fixture.ndvi!.imageBbox}
        indexStage={indexStage}
        onCurveDetails={() => undefined}
      />
    ));
  type TodayHeroIndexStage = Parameters<typeof curveLine>[0];

  it("the fixtures satisfy the contract in all three reader states", () => {
    for (const reading of [indexStageFixture(), indexStageInsufficientFixture(), indexStageSpanFixture(), indexStageUnavailableFixture()]) expect(curveSchema.safeParse(reading).success).toBe(true);
    expect(todaySchema.parse(fixture).indexStage?.status).toBe("available");
    expect(fixture.ndvi!.readings.every((reading) => reading.field.indices && reading.neighbourhood?.indices)).toBe(true);
  });
  it("has a label, a meaning and a formula for every index the contract names, in a fixed order", () => {
    expect(Object.keys(INDEX_INFO).sort()).toEqual([...INDEX_IDS].sort());
    for (const id of INDEX_IDS) {
      expect(INDEX_INFO[id].label.length).toBeGreaterThan(0);
      expect(INDEX_INFO[id].meaning).toMatch(/\.$/);
      expect(INDEX_INFO[id].formula).toMatch(/B\d/);
    }
    expect(new Set(Object.values(INDEX_INFO).map((info) => info.order)).size).toBe(INDEX_IDS.length);
    // Formulas are the contract's: the 20 m bands appear only where the contract uses them.
    expect(INDEX_INFO.ndre.formula).toContain("B5");
    expect(INDEX_INFO.lswi.formula).toContain("B8A");
    expect(INDEX_INFO.ndmi.formula).toContain("B11");
    expect(INDEX_INFO.ndwi.formula).toBe("(B3 − B8) / (B3 + B8)");
  });
  it("the card line takes moisture, red-edge and surface water in that order and skips what is missing", () => {
    expect(indexLine(latest().field).map((item) => [item.id, item.label, item.value])).toEqual([
      ["ndmi", "Moisture index", 0.18],
      ["ndre", "Red-edge greenness", 0.31],
      ["ndwi", "Water index", -0.45],
    ]);
    const all = indicesFor(0.5);
    expect(indexLine({ indices: { ...all, ndre: null } }).map((item) => item.id)).toEqual(["ndmi", "ndwi"]);
    expect(indexLine({ indices: { ...all, ndmi: { mean: null, median: null, p10: null, p90: null }, ndwi: null } }).map((item) => item.id)).toEqual(["ndre"]);
    expect(indexLine({ indices: { ...all, evi: null, savi: null } })).toHaveLength(3);
    expect(indexLine({})).toEqual([]);
    expect(indexLine(null)).toEqual([]);
    expect(indexLine({ indices: { ...all, ndmi: null, ndre: null, ndwi: null } })).toEqual([]);
  });
  it("formats indices to two decimals with a true minus and a dash for no value", () => {
    expect(formatIndex(0.18)).toBe("0.18");
    expect(formatIndex(-0.4526)).toBe("−0.45");
    expect(formatIndex(-0.001)).toBe("0.00");
    expect(formatIndex(null)).toBe("–");
    expect(formatIndex(Number.NaN)).toBe("–");
  });
  it("Health card shows the interpretation, raw NDVI and date; full raw indices stay in Details", () => {
    const visible = seen(card(fixture.ndvi));
    expect(visible).toContain("Within the stage greenness range");
    expect(visible).toContain("NDVI 0.62");
    expect(visible).toContain("image of 27 Oct");
    expect(visible).toContain("Satellite signal, not a diagnosis");
    expect(visible).not.toContain("NDMI");
    const sheet = text(renderToString(() => <TodaySheetBody kind="health" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />));
    for (const code of ["NDMI", "NDRE", "NDWI"]) expect(sheet).toContain(code);
    expect(sheet).toContain("−0.45");
  });
  it("Health details name the index image independently from the headline's observation date", () => {
    const earlier = { ...fixture.ndvi!, latestUsable: { ...latest(), date: "2026-10-22" } };
    const sheet = text(renderToString(() => <TodaySheetBody kind="health" view={{ ...fixture, ndvi: earlier }} date={FIXTURE_TODAY} price={null} weather={null} />));
    expect(sheet).toContain("NDVI 0.62 on 27 Oct 2026");
    expect(sheet).toContain("image of 22 Oct 2026");
  });
  it("Health sheet: a table of all seven indices with value, meaning and formula, the 20 m note and the attribution", () => {
    const html = renderToString(() => <TodaySheetBody kind="health" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />);
    const t = text(html);
    expect(t).toContain("NDVI 0.62 on 27 Oct 2026");
    expect(t).toContain("Basis: Satellite field mean (test fixture)");
    for (const id of INDEX_IDS) {
      const row = text(html.slice(html.indexOf(`data-index-id="${id}"`)).split("</div>")[0]!);
      expect(row).toContain(INDEX_INFO[id].label);
      expect(row).toContain(`(${id.toUpperCase()})`);
      expect(row).toContain(INDEX_INFO[id].meaning);
      expect(row).toContain(`Formula: ${INDEX_INFO[id].formula}`);
      expect(row).toContain(formatIndex(indicesFor(0.62)[id]!.mean));
    }
    expect(t).toContain("B5, B8A and B11 are 20 m bands resampled to the 10 m grid, so these three indices rest on fewer independent pixels.");
    expect(t).toContain("not a field inspection");
    expect(t).toContain("Test fixture shaped like Copernicus Sentinel-2 L2A");
    expect(t.indexOf("Basis:")).toBeLessThan(t.indexOf("Other indices from the same image"));
    expect(t.indexOf("Other indices from the same image")).toBeLessThan(t.indexOf("Test fixture shaped like Copernicus"));
  });
  it("Health sheet: a null mean shows a dash and a scene without summaries says so instead of a table", () => {
    const partial = { ...indicesFor(0.62), lswi: null, evi: { mean: null, median: null, p10: null, p90: null } };
    const reading = withIndices(partial).latestUsable!;
    const html = renderToString(() => <IndexTable reading={reading} />);
    expect(text(html.slice(html.indexOf('data-index-id="lswi"')).split("</div>")[0]!)).toContain("–");
    expect(text(html.slice(html.indexOf('data-index-id="evi"')).split("</div>")[0]!)).toContain("–");
    const none = renderToString(() => <IndexTable reading={withIndices(undefined).latestUsable} />);
    expect(text(none)).toContain("The other indices have not been calculated for this image yet.");
    expect(none).not.toContain("data-index-id");
    expect(text(renderToString(() => <IndexTable reading={null} />))).toContain("have not been calculated");
  });

  it("curveLine words each phase, the green-up date and the comparison with the calendar estimate", () => {
    const reading = indexStageFixture();
    expect(curveLine(reading)).toBe("Satellite curve: greening, green-up seen 2 Oct, in line with the calendar estimate");
    const phases = { bare: "bare soil or very sparse cover", green_up: "greening up", rising: "greening", plateau: "steady near its peak", falling: "drying down", harvested: "harvested look", unknown: "unclear" } as const;
    // latestSmoothed 0.30 is below the dense band, so a plateau makes no canopy claim.
    for (const [phase, words] of Object.entries(phases)) expect(curveLine({ ...reading, phase: phase as keyof typeof phases, latestSmoothed: 0.3, greenUpDate: null, agreement: "unknown" })).toBe(`Satellite curve: ${words}`);
    const agreements = { consistent: "in line with the calendar estimate", curve_earlier: "behind the calendar", curve_later: "ahead of the calendar", no_calendar: "no calendar to compare" } as const;
    for (const [agreement, words] of Object.entries(agreements)) expect(curveLine({ ...reading, agreement: agreement as keyof typeof agreements })).toContain(`, ${words}`);
    expect(curveLine({ ...reading, greenUpDate: null })).toBe("Satellite curve: greening, in line with the calendar estimate");
    expect(curveLine({ ...reading, greenUpDate: "2026-02-31" })).not.toContain("green-up");
    expect(curveLine({ ...reading, agreement: "unknown" })).toBe("Satellite curve: greening, green-up seen 2 Oct");
    // "matches" and "stubble" overstate what a curve can show.
    for (const phase of Object.keys(phases)) expect(curveLine({ ...reading, phase: phase as keyof typeof phases })).not.toMatch(/matches|stubble|full canopy/);
  });
  it("a plateau says only that the curve is steady near its peak, and adds dense canopy only from 0.60", () => {
    const plateau = { ...indexStageFixture(), phase: "plateau" as const };
    expect(curvePhaseText({ ...plateau, latestSmoothed: 0.4 })).toBe("steady near its peak");
    expect(curvePhaseText({ ...plateau, latestSmoothed: 0.59 })).toBe("steady near its peak");
    expect(curvePhaseText({ ...plateau, latestSmoothed: 0.6 })).toBe("steady near its peak (dense canopy)");
    expect(curvePhaseText({ ...plateau, latestSmoothed: null })).toBe("steady near its peak");
    // Other phases never claim a canopy, even at a high value.
    expect(curvePhaseText({ phase: "rising", latestSmoothed: 0.8 })).toBe("greening");
    expect(curveLine({ ...plateau, latestSmoothed: 0.64, greenUpDate: null, agreement: "consistent" })).toBe("Satellite curve: steady near its peak (dense canopy), in line with the calendar estimate");
    expect(curveLine({ ...plateau, latestSmoothed: 0.4, greenUpDate: null, agreement: "consistent" })).toBe("Satellite curve: steady near its peak, in line with the calendar estimate");
  });
  it("curveLine: an insufficient reading follows its reason, so a long enough list of images never reads as too few", () => {
    expect(CURVE_MIN_READINGS).toBe(4);
    expect(CURVE_MIN_SPAN_DAYS).toBe(30);
    expect(curveLine(indexStageInsufficientFixture())).toBe("Satellite curve: not enough clear images yet (2 used, 4 needed)");
    expect(curveLine({ ...indexStageInsufficientFixture(), readingsUsed: 0 })).toBe("Satellite curve: not enough clear images yet (0 used, 4 needed)");
    // Five images is above the minimum of four: the shortfall is the span, and the minimum is not quoted.
    const span = curveLine(indexStageSpanFixture())!;
    expect(span).toBe("Satellite curve: clear images span under 30 days so far (5 used)");
    expect(span).not.toMatch(/not enough|needed/);
    // Any other reason shows the reader's own summary, never the count wording.
    const other = { ...indexStageInsufficientFixture(), reason: "something_else_later", readingsUsed: 9 };
    expect(curveLine(other)).toBe(other.summary);
    expect(curveLine({ ...other, reason: null })).toBe(other.summary);
    expect(curveLine({ ...other, summary: "" })).toBe("Satellite curve: not enough satellite data yet");
    expect(curveLine(indexStageUnavailableFixture())).toBeNull();
    expect(curveLine(null)).toBeNull();
    expect(curveLine(undefined)).toBeNull();
  });
  it("curveAsOfNote names the image on another slider date, and on today when the latest image is over 10 days old", () => {
    const reading = indexStageFixture(); // latest clear image 27 Oct, today 1 Nov: 5 days
    expect(curveAsOfNote(reading, FIXTURE_TODAY, FIXTURE_TODAY)).toBeNull();
    expect(curveAsOfNote(reading, "2026-12-10", FIXTURE_TODAY)).toBe("reading of 27 Oct");
    expect(curveAsOfNote({ asOf: "2026-10-22" }, FIXTURE_TODAY, FIXTURE_TODAY)).toBeNull(); // 10 days is not more than 10
    expect(curveAsOfNote({ asOf: "2026-10-21" }, FIXTURE_TODAY, FIXTURE_TODAY)).toBe("reading of 21 Oct");
    expect(curveAsOfNote({ asOf: "2026-08-02" }, FIXTURE_TODAY, FIXTURE_TODAY)).toBe("reading of 2 Aug");
    expect(curveAsOfNote({ asOf: null }, "2026-12-10", FIXTURE_TODAY)).toBeNull();
    expect(curveAsOfNote(null, FIXTURE_TODAY, FIXTURE_TODAY)).toBeNull();
  });
  it("Hero: the curve line sits under the image with an info button, and is plain evidence beside the calendar stage", () => {
    const html = hero(indexStageFixture());
    const t = text(html);
    expect(t).toContain(`Vegetative · ${rangeLabel("2026-09-25", "2026-11-08")}`);
    expect(t).toContain("Satellite curve: greening, green-up seen 2 Oct, in line with the calendar estimate");
    expect(html).toContain('data-testid="today-curve-line"');
    expect(html).toContain('aria-label="About the satellite curve reading"');
    // The line is outside the stage overlay and after the image frame: it never rewrites the stage label.
    expect(html.indexOf("today-curve")).toBeGreaterThan(html.indexOf('data-testid="today-stage"'));
    const overlay = text(html.slice(html.indexOf('data-testid="today-stage"'), html.indexOf('data-testid="today-curve-line"')));
    expect(overlay).toContain("Vegetative");
    expect(overlay).not.toContain("Satellite curve");
    // On today the line needs no date; on another slider date, or when the latest clear image is over 10 days old, it names the reading.
    expect(t).not.toContain("reading of");
    expect(text(hero(indexStageFixture(), "2026-12-10"))).toContain("reading of 27 Oct");
    expect(text(hero({ ...indexStageFixture(), asOf: "2026-10-20" }))).toContain("reading of 20 Oct");
    expect(text(hero({ ...indexStageFixture(), asOf: "2026-10-22" }))).not.toContain("reading of");
  });
  it("Hero: the insufficient wording shows, and the line is absent when the reading is null, absent or unavailable", () => {
    expect(text(hero(indexStageInsufficientFixture()))).toContain("Satellite curve: not enough clear images yet (2 used, 4 needed)");
    expect(text(hero(indexStageSpanFixture()))).toContain("Satellite curve: clear images span under 30 days so far (5 used)");
    expect(text(hero(indexStageSpanFixture()))).not.toContain("4 needed");
    for (const reading of [null, undefined, indexStageUnavailableFixture()]) {
      const html = hero(reading);
      expect(html).not.toContain("today-curve-line");
      expect(html).not.toContain("About the satellite curve reading");
      expect(text(html)).not.toContain("Satellite curve");
      expect(text(html)).toContain("Vegetative");
    }
    expect(renderToString(() => <CurveLine reading={null} date={FIXTURE_TODAY} today={FIXTURE_TODAY} />)).toBe("");
  });
  it("Curve sheet: status, phase, dates, values, readings, the compared calendar stage, the evidence-only line, limitations and basis", () => {
    const html = renderToString(() => <TodaySheetBody kind="curve" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />);
    const t = text(html);
    expect(t).toContain("Read from the field's own satellite images");
    expect(t).toContain("Phase Greening");
    expect(t).toContain("Green-up Seen 2 Oct 2026");
    expect(t).toContain("Peak 0.62 on 27 Oct 2026");
    expect(t).toContain(`Lowest 0.21 on ${formatDay("2026-09-12")}`);
    expect(t).toContain("Latest smoothed NDVI 0.61");
    expect(t).toContain("Change over 15 days +0.13");
    expect(t).toContain(`Readings used 7 clear images, window ${rangeLabel("2026-07-17", FIXTURE_TODAY)}`);
    expect(t).not.toContain("needed");
    expect(t).toContain("Latest clear image 27 Oct 2026");
    expect(t).toContain(`Calendar stage compared Vegetative · ${rangeLabel("2026-09-25", "2026-11-08")}`);
    expect(t).toContain("Against the calendar In line with the calendar estimate");
    expect(t).toContain("Satellite greenness has been rising since the green-up on 2 Oct (latest clear scene 27 Oct); the calendar puts the crop in Vegetative and expects fast canopy growth, so the curve and the calendar agree.");
    const evidence = "Evidence only: the stage dates above are calendar estimates and are not changed by this reading.";
    expect(t).toContain(evidence);
    expect(t).toContain("The curve is read from clear images only, so a cloudy spell can hide a turn in it.");
    expect(t).toContain("A green curve does not confirm a crop stage; the calendar stays the stage estimate.");
    expect(t).toContain("Basis: Field NDVI curve from clear satellite images (test fixture)");
    expect(t.indexOf("so the curve and the calendar agree")).toBeLessThan(t.indexOf(evidence));
    expect(t.indexOf(evidence)).toBeLessThan(t.indexOf("The curve is read from clear images only"));
    expect(t.indexOf("The curve is read from clear images only")).toBeLessThan(t.indexOf("Basis:"));
    expect((html.match(/<li[ >]/g) ?? []).length).toBe(2);
  });
  it("Curve sheet: a falling curve that runs ahead of the calendar signs a negative change and keeps the evidence-only line", () => {
    const reading = { ...indexStageFixture(), phase: "falling" as const, change15d: -0.08, agreement: "curve_later" as const, greenUpDate: null, peakDate: "2026-10-12", peakValue: 0.68 };
    const t = text(renderToString(() => <CurveSheetBody reading={reading} />));
    expect(t).toContain("Phase Drying down");
    expect(t).toContain("Change over 15 days −0.08");
    expect(t).toContain("Green-up Not seen in this window");
    expect(t).toContain("Against the calendar Ahead of the calendar");
    expect(t).toContain("Evidence only: the stage dates above are calendar estimates");
  });
  it("Curve sheet: too few images gives no phase or values, quotes the minimum and names the calendar stage it fell in", () => {
    const html = renderToString(() => <CurveSheetBody reading={indexStageInsufficientFixture()} />);
    const t = text(html);
    expect(t).toContain("Status Not enough clear images yet");
    expect(t).toContain(`Readings used 2 clear images, window ${rangeLabel("2026-07-17", FIXTURE_TODAY)} (at least 4 needed)`);
    expect(t).toContain(`Calendar stage compared Vegetative · ${rangeLabel("2026-09-25", "2026-11-08")}`);
    expect(html).not.toContain("<dt>Phase</dt>");
    expect(html).not.toContain("<dt>Peak</dt>");
    expect(html).not.toContain("<dt>Against the calendar</dt>");
    expect(t).not.toContain("Change over 15 days");
    expect(t).toContain("Only 2 of the 4 clear satellite scenes needed are available in this window");
    expect(t).toContain("Evidence only");
    expect(t).toContain("Cloud cover left too few clear images of this field.");
  });
  it("Curve sheet: a span under 30 days does not call five images too few, and another reason lets the summary speak", () => {
    const span = text(renderToString(() => <CurveSheetBody reading={indexStageSpanFixture()} />));
    expect(span).toContain("Status Clear images span under 30 days so far");
    expect(span).toContain(`Readings used 5 clear images, window ${rangeLabel("2026-07-17", FIXTURE_TODAY)} (spanning under 30 days so far)`);
    expect(span).not.toMatch(/not enough|at least 4|needed\)/i);
    expect(span).toContain("The 5 clear satellite scenes span 22 days, fewer than the 30 needed");
    const other = { ...indexStageInsufficientFixture(), reason: "something_else_later", readingsUsed: 9 };
    const html = renderToString(() => <CurveSheetBody reading={other} />);
    const t = text(html);
    expect(t).toContain("Status Not enough satellite data yet");
    expect(t).toContain(`Readings used 9 clear images, window ${rangeLabel("2026-07-17", FIXTURE_TODAY)}`);
    expect(t).not.toMatch(/at least 4|spanning under/);
    // The summary is the headline and is not printed a second time.
    expect(t.split(other.summary).length - 1).toBe(1);
    expect(html).not.toContain("today-curve-summary");
  });
  it("the sheet for a view without a reading falls back to a sentence instead of an empty dialog body", () => {
    const view = { ...fixture, indexStage: null };
    expect(text(renderToString(() => <TodaySheetBody kind="curve" view={view} date={FIXTURE_TODAY} price={null} weather={null} />))).toContain("No satellite curve reading is available for this field.");
  });
  it("the Satellite alert type has its own label, and no alert type renders without one", () => {
    const base = fixture.alerts[0]!;
    const satellite: FarmAlert = {
      ...base,
      id: "5f0c6b1e-1a2b-4c3d-8e4f-000000000009",
      type: "satellite",
      severity: "watch",
      title: "Greenness fell between the last two clear images",
      source: { name: "Sentinel-2 scene (test fixture)", url: "https://example.org/stac/item", date: "2026-10-27" },
    };
    expect(alertSchema.safeParse(satellite).success).toBe(true);
    const render = (alert: FarmAlert) =>
      renderToString(() => <AlertsList alerts={[alert]} newsReview={fixture.newsReview} today={FIXTURE_TODAY} stepAlertIds={new Set()} onDismiss={() => undefined} onSuggested={() => undefined} error="" />);
    const html = render(satellite);
    expect(html.match(/today-alert-kicker[\s\S]*?<\/p>/)![0]).toMatch(/>Satellite</);
    expect(text(html)).toContain("Greenness fell between the last two clear images");
    const labels = new Set<string>();
    for (const type of FarmAlertType.options) {
      const kicker = text(render({ ...base, type }).match(/today-alert-kicker[\s\S]*?<\/p>/)![0]);
      expect(kicker).not.toMatch(/undefined/);
      expect(kicker).toMatch(/Watch|Warning|Info/);
      labels.add(kicker.replace(/^.*?(Watch|Warning|Info)\s*/, "").replace(/\s*· until.*$/, ""));
    }
    expect(labels.size).toBe(FarmAlertType.options.length);
    expect([...labels]).toContain("Satellite");
  });
});

describe("economics and footprint: fixtures", () => {
  it("every synthetic block, whole and by variant, validates with the contract", () => {
    for (const block of [harvestEconomicsFixture(), harvestEconomicsPartialFixture(), harvestEconomicsUnavailableFixture()]) expect(economicsSchema.safeParse(block).success).toBe(true);
    for (const block of [residueIncomeFixture(), residueIncomeUnavailableFixture()]) expect(residueSchema.safeParse(block).success).toBe(true);
    for (const block of [energyFootprintFixture(), energyFootprintPartialFixture(), energyFootprintUnavailableFixture()]) expect(energySchema.safeParse(block).success).toBe(true);
    for (const block of [carbonFootprintFixture(), carbonFootprintPartialFixture(), carbonFootprintNoAreaFixture(), carbonFootprintUnavailableFixture()]) expect(carbonSchema.safeParse(block).success).toBe(true);
    // The view parses with the four blocks, with every unavailable variant, and without them (an API that predates the fields).
    expect(todaySchema.safeParse(fixture).success).toBe(true);
    expect(fixture.harvestEconomics?.status).toBe("available");
    expect(
      todaySchema.safeParse({ ...fixture, harvestEconomics: harvestEconomicsUnavailableFixture(), residueIncome: residueIncomeUnavailableFixture(), energyFootprint: energyFootprintUnavailableFixture(), carbonFootprint: carbonFootprintUnavailableFixture() }).success,
    ).toBe(true);
    const { harvestEconomics, residueIncome, energyFootprint, carbonFootprint, ...legacy } = fixture;
    void [harvestEconomics, residueIncome, energyFootprint, carbonFootprint];
    expect(todaySchema.safeParse(legacy).success).toBe(true);
  });
  it("the carbon baseline terms add up to the stated total, and the maize numbers are internally consistent", () => {
    const carbon = carbonFootprintFixture();
    const baseline = carbon.terms.filter((t) => t.kind === "baseline");
    expect(baseline.reduce((s, t) => s + t.tCO2eForField!.low, 0)).toBeCloseTo(carbon.emissionsForField!.low, 6);
    expect(baseline.reduce((s, t) => s + t.tCO2eForField!.high, 0)).toBeCloseTo(carbon.emissionsForField!.high, 6);
    // Incorporating the stover claims no credit: its net equals the baseline, and the note says why.
    const incorporate = carbon.residueScenarios.find((s) => s.id === "incorporate")!;
    expect(incorporate.netForField).toEqual(carbon.emissionsForField);
    const econ = harvestEconomicsFixture();
    expect(econ.profitForField!.central).toBeCloseTo(econ.profitPerHa!.central * econ.fieldAreaHa!, 6);
  });
});

describe("economics and footprint: formatting and picking helpers", () => {
  it("formatTonnes takes kilograms and prints one decimal; ranges round outward", () => {
    expect(formatTonnes(4200)).toBe("4.2 t");
    expect(formatTonnes(949)).toBe("0.9 t");
    expect(formatTonnes(12_345)).toBe("12.3 t");
    expect(rangeText({ low: 2.04, high: 3.41 }, 1)).toBe("2.0–3.5");
    expect(rangeText({ low: 3.2, high: 3.2 }, 1)).toBe("3.2");
    expect(rangeText({ low: 3.21, high: 3.24 }, 1)).toBe("3.2–3.3");
  });
  it("formatGJ keeps one decimal below 100 GJ and whole gigajoules from 100", () => {
    expect(formatGJ({ low: 16.8, high: 21.6 })).toBe("16.8–21.6 GJ");
    expect(formatGJ({ low: 96, high: 144.2 })).toBe("96–145 GJ");
  });
  it("formatCo2e switches to kilograms only when the whole range is under 1 t, and never prints -0", () => {
    expect(formatCo2e({ low: 3.5, high: 6.65 })).toBe("3.5–6.7 t CO₂e");
    expect(formatCo2e({ low: 0.42, high: 0.61 })).toBe("420–610 kg CO₂e");
    expect(formatCo2e({ low: 0.4, high: 1.2 })).toBe("0.4–1.2 t CO₂e");
    expect(formatCo2e({ low: -1.8, high: -0.6 })).toBe("−1.8 to −0.6 t CO₂e");
    expect(co2eParts({ low: 0.42, high: 0.61 })).toEqual({ short: "420–610", unit: "kg CO₂e" });
    expect(formatCo2e({ low: 0, high: 0 })).toBe("0 kg CO₂e");
  });
  it("compact rupee forms never overflow a card and never narrow the range", () => {
    expect(compactInr(950)).toBe("₹950");
    expect(compactInr(4500)).toBe("₹4.5k");
    expect(compactInr(52800)).toBe("₹52.8k");
    expect(compactInr(120000)).toBe("₹1.2 L");
    expect(compactInr(-4200)).toBe("−₹4.2k");
    expect(compactInrRange(33600, 72000)).toBe("₹33–72k");
    expect(compactInrRange(96000, 134400)).toBe("₹96–135k");
    expect(compactInrRange(120000, 190000)).toBe("₹1.2–1.9 L");
    expect(compactInrRange(5227, 18900)).toBe("₹5.2–18.9k");
    expect(compactInrRange(500, 900)).toBe("₹500–900");
    expect(compactInrRange(-4000, 12000)).toBe("−₹4k to ₹12k");
  });
  it("profitValue: the field total when the area is known, per hectare otherwise, revenue when there is no profit", () => {
    const econ = harvestEconomicsFixture();
    expect(profitValue(econ)).toMatchObject({ kind: "profit", scope: "field", estimate: { central: 94800 } });
    expect(profitValue({ ...econ, fieldAreaHa: null, profitForField: null, revenueForField: null })).toMatchObject({ kind: "profit", scope: "ha", estimate: { central: 79000 } });
    expect(profitValue({ ...econ, profitForField: null })).toMatchObject({ kind: "profit", scope: "ha" });
    expect(profitValue(harvestEconomicsPartialFixture())).toMatchObject({ kind: "revenue", scope: "field", estimate: { central: 152400 } });
    expect(profitValue(harvestEconomicsUnavailableFixture())).toBeNull();
    expect(costValue(econ)).toEqual({ label: "A2+FL cost", scope: "field", value: 57600 });
    expect(costValue({ fieldAreaHa: null, cost: { ...econ.cost!, a2flPerHa: null } })).toEqual({ label: "C2 cost", scope: "ha", value: 68000 });
    expect(costValue({ fieldAreaHa: 1, cost: null })).toBeNull();
  });
  it("bestResidueOption: highest central income first, options with no income after every priced one", () => {
    const options = residueIncomeFixture().options;
    expect(options.map((o) => o.use)).toEqual(["dry_fodder", "biomass_fuel", "cbg_feedstock"]);
    expect(bestResidueOption(options)?.use).toBe("cbg_feedstock");
    const unpricedOnly = options.filter((o) => o.incomeForField == null);
    expect(bestResidueOption(unpricedOnly)?.use).toBe("biomass_fuel");
    expect(bestResidueOption([])).toBeNull();
    // An unpriced option never outranks a priced one, even a small one.
    const tiny = { ...options[0]!, incomeForField: { low: 1, high: 2 } };
    expect(bestResidueOption([options[1]!, tiny])?.use).toBe("dry_fodder");
  });
  it("largestCarbonTerm is the baseline term with the largest high value; scenario terms never count", () => {
    const terms = carbonFootprintFixture().terms;
    expect(largestCarbonTerm(terms)?.source).toBe("fertiliser_n2o");
    expect(terms.some((t) => t.source === "rice_methane")).toBe(false);
    expect(largestCarbonTerm(terms.filter((t) => t.kind === "scenario"))).toBeNull();
    expect(largestCarbonTerm([])).toBeNull();
    expect(carbonTermLine(terms)).toBe("Mostly nitrous oxide from fertiliser nitrogen");
    // No term reaches half of the baseline: "Largest part", never "Mostly".
    const baseline = terms.filter((t) => t.kind === "baseline");
    const even = baseline.map((t) => ({ ...t, tCO2eForField: { low: 0.3, high: 0.5 } }));
    expect(carbonTermLine(even)).toMatch(/^Largest part: /);
    // Terms with no field figure (area unknown) are compared per hectare, for every term, never in mixed units.
    const noArea = carbonFootprintNoAreaFixture().terms;
    expect(noArea.every((t) => t.tCO2eForField === null)).toBe(true);
    expect(largestCarbonTerm(noArea)?.source).toBe("fertiliser_n2o");
    expect(carbonTermLine(noArea)).toBe("Mostly nitrous oxide from fertiliser nitrogen");
    const mixed = terms.map((t, i) => (i === 0 ? { ...t, tCO2eForField: null } : t));
    expect(largestCarbonTerm(mixed)?.source).toBe("fertiliser_n2o");
    // A paddy-style block (flooded field) still reads from its methane term.
    const flooded = [{ ...baseline[1]!, source: "rice_methane" as const, label: "Methane from the flooded field", tCO2eForField: { low: 2.4, high: 4.6 } }, baseline[0]!, baseline[2]!];
    expect(largestCarbonTerm(flooded)?.source).toBe("rice_methane");
    expect(carbonTermLine(flooded)).toBe("Mostly methane from the flooded field");
  });
  it("small helpers: residue title, rank chip and the reason sentence", () => {
    expect(residueTitle("maize stover")).toBe("Maize stover income");
    expect(residueTitle(null)).toBe("Residue income");
    expect(residueTitle("  ")).toBe("Residue income");
    expect(rankChip({ rank: 12, of: 14, lowest: null, highest: null })).toMatchObject({ text: "12 of 14 crops" });
    expect(rankChip({ rank: 1, of: 14, lowest: null, highest: null }).spoken).toContain("first lowest");
    expect(unavailableReason({ reason: "no_yield_row", limitations: ["Sentence one.", "Two."] }, "fallback")).toBe("Sentence one.");
    expect(unavailableReason({ reason: "No row for this crop", limitations: [] }, "fallback")).toBe("No row for this crop");
    expect(unavailableReason({ reason: "no_yield_row", limitations: [] }, "fallback")).toBe("fallback");
  });
});

describe("economics and footprint: cards", () => {
  const cards = (view = fixture, weatherOnly = false) =>
    renderToString(() => <TodayCards view={view} date={FIXTURE_TODAY} price={null} weather={null} weatherOnly={weatherOnly} onDetails={() => undefined} />);
  const one = (el: () => unknown) => text(renderToString(() => el() as never));
  const noop = () => undefined;

  it("six main answers followed by the two disclosed planning references", () => {
    const html = cards();
    const kinds = [...html.matchAll(/data-card="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["health", "weather", "harvest", "profit", "price", "residue", "energy", "carbon"]);
  });
  it("profit card: field profit with the likely band, harvest dates, revenue and cost, basis", () => {
    const html = one(() => <ProfitCard econ={harvestEconomicsFixture()} onDetails={noop} />);
    expect(html).toContain("Expected profit at harvest");
    expect(html).toContain("₹94.8k");
    expect(html).not.toContain("/ha");
    expect(html).toContain("likely ₹68–123k");
    expect(html).toContain("₹68,400 to ₹1,22,400, likely range");
    expect(html).toContain("Expected profit for the field, about ₹94,800");
    expect(html).toContain("Revenue ₹1,52,400 − Costs ₹57,600 = Profit ₹94.8k");
    const sheet = text(renderToString(() => <TodaySheetBody kind="profit" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />));
    expect(sheet).toContain("District maize yield, 2021 to 2023 (test fixture)");
    expect(sheet).toContain("Based on 3 years of Karnataka mandi prices (test fixture)");
  });
  it("profit card without an area: per hectare with /ha", () => {
    const econ = { ...harvestEconomicsFixture(), fieldAreaHa: null, profitForField: null, revenueForField: null };
    const html = one(() => <ProfitCard econ={econ} onDetails={noop} />);
    expect(html).toContain("₹79k");
    expect(html).toContain("/ha");
    expect(html).toContain("per hectare");
    expect(html).toContain("Revenue ₹1,27,000 − Costs ₹48,000 = Profit ₹79k /ha");
  });
  it("profit card partial shows revenue, labels it, and says the cost is not sourced; a loss reads as a loss", () => {
    const partial = one(() => <ProfitCard econ={harvestEconomicsPartialFixture()} onDetails={noop} />);
    expect(partial).toContain("Revenue before costs");
    expect(partial).toContain("Revenue ₹1,52,400");
    expect(partial).toContain("Profit estimate Not available");
    expect(partial).toContain("cost not sourced; profit unavailable");
    const loss = { ...harvestEconomicsFixture(), profitForField: { central: -4200, likely: { low: -9000, high: 1500 }, possible: { low: -15000, high: 8000 } } };
    const text1 = one(() => <ProfitCard econ={loss} onDetails={noop} />);
    expect(text1).toContain("−₹4.2k");
    expect(text1).toContain("minus ₹4,200");
    expect(text1).toContain("likely −₹9k to ₹1.5k");
  });
  it("unavailable profit, residue, energy and carbon cards show a dash and the reason sentence, no figure", () => {
    const profit = one(() => <ProfitCard econ={harvestEconomicsUnavailableFixture()} onDetails={noop} />);
    expect(profit).toContain("–");
    expect(profit).toContain("No regional yield is sourced for this crop, so profit at harvest is not estimated.");
    expect(profit).not.toContain("likely");
    const residue = one(() => <ResidueCard residue={residueIncomeUnavailableFixture()} onDetails={noop} />);
    expect(residue).toContain("Residue income");
    expect(residue).toContain("The haulm of this crop is usually left on the field, so no income is estimated.");
    const energy = one(() => <EnergyCard energy={energyFootprintUnavailableFixture()} residueName={null} onDetails={noop} />);
    expect(energy).toContain("No energy figures are sourced for this crop.");
    const carbon = one(() => <CarbonCard carbon={carbonFootprintUnavailableFixture()} onDetails={noop} />);
    expect(carbon).toContain("No emission factors are sourced for this crop.");
    expect(carbon).not.toContain("CO₂e");
    // No limitation and a code-like reason: the plain fallback, never the code.
    const bare = one(() => <ProfitCard econ={{ ...harvestEconomicsUnavailableFixture(), limitations: [] }} onDetails={noop} />);
    expect(bare).toContain("Profit at harvest cannot be estimated for this crop yet.");
    expect(bare).not.toContain("no_yield_row");
  });
  it("residue card: titled from the residue name, best option's income first, others after 'or', alternatives line, no sum", () => {
    const residue = residueIncomeFixture();
    const html = renderToString(() => <ResidueCard residue={residue} onDetails={noop} />);
    const t = text(html);
    expect(t).toContain("Maize stover income");
    expect(t).toContain("₹5.2–18.9k");
    expect(t).toContain("₹5,227 to ₹18,900 for the field, as CBG feedstock");
    expect(t).toContain("as CBG feedstock");
    expect(t).toContain("One possible use");
    expect(t).not.toContain("Dry fodder");
    const sheet = renderToString(() => <TodaySheetBody kind="residue" view={{ ...fixture, residueIncome: residue }} date={FIXTURE_TODAY} price={null} weather={null} />);
    expect(text(sheet)).toContain("The incomes do not add up");
    expect([...sheet.matchAll(/data-use="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["cbg_feedstock", "dry_fodder", "biomass_fuel"]);
    expect(text(sheet)).toContain("2.9–7.6 t");
    // No total of the options anywhere: neither the sum of the centres nor of the ends.
    const sums = [5227 + 5250, 18900 + 16500, 12063.5 + 10875, 10477, 35400];
    for (const sum of sums) expect(t).not.toContain(sum.toLocaleString("en-IN"));
    expect(t).not.toContain("₹10.4");
    expect(t).not.toContain("₹35.4k");
  });
  it("residue card without a name says 'Residue income'; with no priced option it shows no income, not zero", () => {
    const residue = { ...residueIncomeFixture(), residueName: null, options: residueIncomeFixture().options.filter((o) => o.incomeForField == null) };
    const t = one(() => <ResidueCard residue={residue} onDetails={noop} />);
    expect(t).toContain("Residue income");
    expect(t).toContain("No reported price for these uses yet");
    expect(t).toContain("Biomass fuel");
    expect(t).not.toContain("₹0");
    expect(t).toContain("One possible use");
  });
  it("energy card: used-to-grow figure and breakdown words, then the residue energy and the LPG cylinders", () => {
    const html = one(() => <EnergyCard energy={energyFootprintFixture()} residueName="maize stover" onDetails={noop} />);
    expect(html).toContain("14.4–19.2");
    expect(html).toContain("GJ");
    expect(html).toContain("14.4 to 19.2 gigajoules used to grow this crop");
    expect(html).toContain("used to grow this crop (fertiliser, fuel, labour)");
    expect(html).toContain("Maize stover holds 39–129 GJ · about 61–198 LPG cylinders");
  });
  it("energy card basis: a short form on the card, the full citation only in the sheet", () => {
    const citation = "Energy Use and Its Efficiency in Andhra Pradesh Agriculture (Subrahmanyam, Reddy and Mitra), Indian Journal of Agricultural Economics 53(3) 1998, IN-AP (Andhra Pradesh, 20 districts), 1996-97";
    expect(energyBasisShort(citation)).toBe("Published energy study · Andhra Pradesh 1996-97");
    // From the energy_reference BasisRef when the text has no region or year.
    expect(energyBasisShort("A farm energy survey", [{ kind: "energy_reference", scope: "Karnataka", note: "Survey of 2019-20 farms" }])).toBe("Published energy study · Karnataka 2019-20");
    expect(energyBasisShort("Study of 2004", [])).toBe("Published energy study · 2004");
    // Nothing parses: first 60 characters and an ellipsis; a short text is kept whole; no basis at all gets the generic line.
    const long = "A long description of a study with no place and no year in it at all, really";
    expect(energyBasisShort(long)).toBe(`${long.slice(0, 60)}…`);
    expect(energyBasisShort("Short note")).toBe("Short note");
    expect(energyBasisShort(null)).toBe("Published energy-use studies and calorific values");
    const energy = { ...energyFootprintFixture(), inputEnergyBasis: citation };
    const card = one(() => <EnergyCard energy={energy} residueName="maize stover" onDetails={noop} />);
    expect(card).toContain("Published energy study · Andhra Pradesh 1996-97");
    expect(card).not.toContain("Subrahmanyam");
    expect(text(renderToString(() => <TodaySheetBody kind="energy" view={{ ...fixture, energyFootprint: energy }} date={FIXTURE_TODAY} price={null} weather={null} />))).toContain("Subrahmanyam, Reddy and Mitra");
  });
  it("energy card partial: whichever figure exists, and it says which one it is", () => {
    const html = one(() => <EnergyCard energy={energyFootprintPartialFixture()} residueName="maize stover" onDetails={noop} />);
    expect(html).toContain("39–129");
    expect(html).toContain("held in the maize stover; the energy used to grow the crop is not sourced");
    expect(html).toContain("about 61–198 LPG cylinders");
    expect(html).not.toContain("used to grow this crop (");
  });
  it("carbon card: the band, the largest term's line, the rank chip and the lowest crop; the summary stays in the sheet", () => {
    const html = renderToString(() => <CarbonCard carbon={carbonFootprintFixture()} onDetails={noop} />);
    const t = text(html);
    expect(t).toContain("1.2–2.1");
    expect(t).toContain("t CO₂e");
    expect(t).toContain("1.2 to 2.1 tonnes of carbon dioxide equivalent emitted this season");
    expect(t).toContain("Mostly nitrous oxide from fertiliser nitrogen");
    expect(t).not.toContain("methane");
    expect(t).toContain("9 of 14 crops");
    expect(t).toContain("Ranked number 9 lowest of 14 crops by emissions per hectare");
    expect(t).toContain("lowest here: Finger millet 500–900 kg CO₂e");
    expect(t).not.toContain("A maize season on 1.2 ha");
  });
  it("carbon card without a field area: the per-hectare figure, marked /ha, and the largest term's line from per-hectare values", () => {
    const html = one(() => <CarbonCard carbon={carbonFootprintNoAreaFixture()} onDetails={noop} />);
    expect(html).toContain("1.0–1.8");
    expect(html).toContain("/ha");
    expect(html).toContain("1.0 to 1.8 tonnes of carbon dioxide equivalent per hectare emitted this season");
    expect(html).toContain("Mostly nitrous oxide from fertiliser nitrogen");
    expect(html).toContain("per hectare reference");
    expect(html).not.toContain("crops");
    expect(html).not.toContain("on 1.2 ha");
  });
  it("carbon card partial (no comparison) and the lowest-crop case", () => {
    const partial = one(() => <CarbonCard carbon={carbonFootprintPartialFixture()} onDetails={noop} />);
    expect(partial).toContain("1.2–2.1");
    expect(partial).not.toContain("crops");
    expect(partial).not.toContain("lowest here");
    const best = { ...carbonFootprintFixture(), comparison: { ...carbonFootprintFixture().comparison!, rank: 1 } };
    expect(one(() => <CarbonCard carbon={best} onDetails={noop} />)).toContain("the lowest here is this crop");
    const small = { ...carbonFootprintFixture(), emissionsForField: { low: 0.42, high: 0.61 } };
    expect(one(() => <CarbonCard carbon={small} onDetails={noop} />)).toContain("420–610");
  });
  it("every card carries an aria-label and a details button named for it; spoken forms exist for the numbers", () => {
    const html = cards();
    for (const [kind, title] of [["profit", "Expected profit at harvest"], ["residue", "Maize stover income"], ["energy", "Energy"], ["carbon", "Carbon"]] as const) {
      expect(html).toMatch(new RegExp(`data-card="${kind}" aria-label="${title}"`));
      expect(html).toContain(`aria-label="${title}: details and sources"`);
    }
    // The short number is hidden from screen readers and a spoken form is present beside it.
    expect(html).toContain('class="today-sr"');
    expect(html.match(/today-econ-value/g)!.length).toBe(3);
    expect(html).toContain('aria-label="Revenue minus costs equals profit"');
  });
  it("the outlook line wraps and keeps its mark: the sentence span may shrink, the spark does not", () => {
    const css = readFileSync(new URL("./today.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.today-outlook-note\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.today-outlook-note > span:first-child\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.today-outlook-note > \.ai-spark-host\s*\{[^}]*flex:\s*none/);
  });
  it("a block the API did not send renders no card; the weather-only layout shows none of the new cards", () => {
    const legacy = { ...fixture, harvestEconomics: undefined, residueIncome: null, energyFootprint: undefined, carbonFootprint: null };
    const kinds = [...cards(legacy).matchAll(/data-card="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["health", "weather", "harvest", "price"]);
    const only = [...cards(fixture, true).matchAll(/data-card="([a-z]+)"/g)].map((m) => m[1]);
    expect(only).toEqual(["health", "weather"]);
    const empty = { ...todayEmptyFixture(), harvestEconomics: harvestEconomicsFixture(), residueIncome: residueIncomeFixture(), energyFootprint: energyFootprintFixture(), carbonFootprint: carbonFootprintFixture() };
    const emptyKinds = [...cards(empty, true).matchAll(/data-card="([a-z]+)"/g)].map((m) => m[1]);
    expect(emptyKinds).toEqual(["weather"]);
  });
});

describe("economics and footprint: sheets", () => {
  const sheet = (kind: "profit" | "residue" | "energy" | "carbon", view = fixture) =>
    text(renderToString(() => <TodaySheetBody kind={kind} view={view} date={FIXTURE_TODAY} price={null} weather={null} />));
  const unavailableView = {
    ...fixture,
    harvestEconomics: harvestEconomicsUnavailableFixture(),
    residueIncome: residueIncomeUnavailableFixture(),
    energyFootprint: energyFootprintUnavailableFixture(),
    carbonFootprint: carbonFootprintUnavailableFixture(),
  };

  it("profit sheet: figures per hectare and for the field with both bands, basis, limitations", () => {
    const t = sheet("profit");
    expect(t).toContain("Profit at harvest around 8 Jan 2027");
    expect(t).toContain("5,500–7,000 kg/ha (district yield)");
    expect(t).toContain("6,600–8,400 kg");
    expect(t).toContain("95%");
    expect(t).toContain("₹19.2 to ₹23.8 per kg, middle ₹21.4");
    expect(t).toContain("₹48,000");
    expect(t).toContain("CACP · Karnataka · 2024-25");
    expect(t).toContain("₹79,000 (likely ₹57,000 to ₹1,02,000; possible ₹40,000 to ₹1,20,000)");
    expect(t).toContain("₹94,800 (likely ₹68,400 to ₹1,22,400; possible ₹48,000 to ₹1,44,000)");
    expect(t).toContain("not a forecast and not a promised sale");
    expect(t).toContain("Basis: District maize yield, 2021 to 2023 (test fixture)");
    expect(t).toContain("Basis: A2+FL cost of cultivation, 2024-25 (test fixture)");
    expect(t).toContain("What this does not tell you");
    expect(t).toContain("The price is a past harvest-week reference, not a forecast.");
  });
  it("profit sheet partial and unavailable", () => {
    const partial = sheet("profit", { ...fixture, harvestEconomics: harvestEconomicsPartialFixture() });
    expect(partial).toContain("incomplete estimate");
    expect(partial).toContain("not sourced");
    expect(partial).toContain("Profit per hectare not computed");
    expect(partial).toContain("No cost of cultivation is sourced for this crop and state, so profit is not shown.");
    const none = sheet("profit", unavailableView);
    expect(none).toContain("No regional yield is sourced for this crop, so profit at harvest is not estimated.");
    expect(none).not.toContain("Likely is the middle half");
  });
  it("residue sheet: every option best first with quantity, price and basis, the not-additive sentence, no sum", () => {
    const html = renderToString(() => <TodaySheetBody kind="residue" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />);
    const t = text(html);
    expect(t).toContain("These are alternatives for the same residue. The incomes do not add up: the residue can be used once.");
    expect(t).toContain("1.1–1.5 kg dry residue (published ratio)");
    expect(t).toContain("7.2–12.6 t dry");
    expect(t).toContain("2.9–7.6 t dry");
    expect(t).toContain("40–60% after on-farm uses");
    const uses = [...html.matchAll(/data-use="([a-z_]+)"/g)].map((m) => m[1]);
    expect(uses).toEqual(["cbg_feedstock", "dry_fodder", "biomass_fuel"]);
    expect(t).toContain("₹1,800 to ₹2,500 per tonne, plant-gate, as reported, 2025 (test fixture)");
    expect(t).toContain("₹5,227 to ₹18,900");
    expect(t).toContain("₹3,500 to ₹5,500 per tonne, farm-gate, dry basis, Karnataka 2025 (test fixture)");
    expect(t).toContain("no price sourced");
    expect(t).toContain("not estimated without a price");
    expect(t).toContain("Needs a compressed biogas plant within hauling distance.");
    expect(t).toContain("Basis: Published residue-to-product ratio for maize (test fixture)");
    expect(t).toContain("Prices are as reported by one plant and one region; yours may differ.");
    expect(t).not.toContain("₹10,477");
    expect(t).not.toContain("₹35,400");
    expect(sheet("residue", unavailableView)).toContain("The haulm of this crop is usually left on the field, so no income is estimated.");
  });
  it("energy sheet: both figures, breakdown, equivalents, the 'different questions' sentence, basis", () => {
    const t = sheet("energy");
    expect(t).toContain("12.0–16.0 GJ");
    expect(t).toContain("14.4–19.2 GJ");
    expect(t).toContain("Energy-use study of maize farms in southern India (test fixture)");
    expect(t).toContain("15.0–17.0 MJ per kg");
    expect(t).toContain("39–129 GJ");
    expect(t).toContain("Fertiliser: 38%");
    expect(t).toContain("Household LPG cylinders (14.2 kg): about 61–198 cylinders");
    expect(t).toContain("Diesel: about 1,040–3,380 litres");
    expect(t).toContain("not netted against each other");
    expect(t).toContain("Basis: Calorific value of maize stover (test fixture)");
    expect(t).toContain("The input energy is a study average, not what this farm used.");
    expect(sheet("energy", unavailableView)).toContain("No energy figures are sourced for this crop.");
    expect(sheet("energy", { ...fixture, energyFootprint: energyFootprintPartialFixture() })).not.toContain("Where the energy to grow the crop goes");
  });
  it("carbon sheet: summary, baseline terms with their methods, residue scenarios with net totals and notes, the GWP line, limits", () => {
    const html = renderToString(() => <TodaySheetBody kind="carbon" view={fixture} date={FIXTURE_TODAY} price={null} weather={null} />);
    const t = text(html);
    expect(t).toContain("A maize season on 1.2 ha emits about 1.2 to 2.1 t CO₂e, mostly nitrous oxide from fertiliser nitrogen.");
    expect(t).toContain("1.2–2.1 t CO₂e");
    expect(t).toContain("1.0–1.8 t CO₂e");
    expect(t).toContain("110 days");
    expect(t).toContain("9 of 14 crops (1 is the lowest emissions per hectare)");
    expect(t).toContain("Finger millet, 500–900 kg CO₂e");
    expect(t).toContain("Paddy, 3.5–6.7 t CO₂e");
    for (const label of ["Nitrous oxide from fertiliser nitrogen", "Making the fertiliser", "Diesel and machinery"]) expect(t).toContain(label);
    expect(t).not.toContain("Methane from");
    expect(t).toContain("150 kg N per ha x 1.2 ha x emission factor 0.01 x 44/28 x 273 (test fixture)");
    // Baseline terms first, then scenarios.
    expect(t.indexOf("What the emissions are made of")).toBeLessThan(t.indexOf("What happens to the residue"));
    const scenarios = [...html.matchAll(/data-scenario="([a-z_]+)"/g)].map((m) => m[1]);
    expect(scenarios).toEqual(["burn", "incorporate", "sell_cbg", "sell_fodder"]);
    expect(t).toContain("Burn the stover");
    expect(t).toContain("1.5–2.7 t CO₂e");
    expect(t).toContain("Burning adds methane and nitrous oxide on top of the season's emissions.");
    expect(t).toContain("No credit is claimed for the carbon in the stover: only part of it stays in the soil and that part is not estimated, so the total equals the emissions above.");
    expect(t).not.toContain("0.3–1.8 t CO₂e");
    expect(t).toContain("−900 to −300 kg CO₂e");
    expect(t).toContain("carbon the residue holds; not a removal and not counted");
    expect(t).toContain("alternatives for the same residue, not added together");
    expect(t).toContain("Global warming potentials (100-year): methane 27, nitrous oxide 273. IPCC AR6 100-year values (test fixture)");
    expect(t).toContain("Basis: IPCC 2019 Refinement emission factors (test fixture)");
    expect(t).toContain("Nitrogen rates are the state recommendation, not what this farm applied.");
    expect(sheet("carbon", unavailableView)).toContain("No emission factors are sourced for this crop.");
  });
  it("carbon sheet without a field area: each term says 'per hectare only' and gives its per-hectare figure; no scenario nets", () => {
    const t = sheet("carbon", { ...fixture, carbonFootprint: carbonFootprintNoAreaFixture() });
    expect(t.match(/per hectare only \(field area not known\)/g)).toHaveLength(3);
    expect(t).toContain("500–920 kg CO₂e");
    expect(t).toContain("1.0–1.8 t CO₂e");
    expect(t).not.toContain("Emitted this season, for the field");
    expect(t).not.toContain("What happens to the residue");
    expect(t).toContain("The field area is not known, so the figures are per hectare only.");
  });
  it("the dialog titles follow the card titles, and a missing block says so instead of rendering blank", () => {
    expect(sheetTitle("profit", fixture, FIXTURE_TODAY)).toBe("Expected profit at harvest");
    expect(sheetTitle("residue", fixture, FIXTURE_TODAY)).toBe("Maize stover income");
    expect(sheetTitle("energy", fixture, FIXTURE_TODAY)).toBe("Energy");
    expect(sheetTitle("carbon", fixture, FIXTURE_TODAY)).toBe("Carbon");
    expect(sheetTitle("residue", { residueIncome: null }, FIXTURE_TODAY)).toBe("Residue income");
    expect(sheetTitle("weather", fixture, FIXTURE_TODAY)).toBe("Weather on 1 Nov 2026");
    const legacy = { ...fixture, harvestEconomics: null, residueIncome: undefined, energyFootprint: null, carbonFootprint: undefined };
    expect(sheet("profit", legacy)).toContain("No profit estimate was returned");
    expect(sheet("residue", legacy)).toContain("No residue income estimate was returned");
    expect(sheet("energy", legacy)).toContain("No energy estimate was returned");
    expect(sheet("carbon", legacy)).toContain("No carbon footprint estimate was returned");
  });
});

describe("Today overview ('Today for you')", () => {
  const noop = () => undefined;
  const render = (overview: Parameters<typeof TodayOverview>[0]["overview"], onDetails: (kind: never) => void = noop) =>
    renderToString(() => <TodayOverview overview={overview} onDetails={onDetails as never} />);

  it("every fixture validates with the contract, the wired view carries the ready model overview, and refs point at real fixture ids", () => {
    for (const o of [overviewFixture(), overviewPendingFixture(), overviewDeterministicFixture(), overviewUnavailableFixture()]) expect(overviewSchema.safeParse(o).success).toBe(true);
    expect(fixture.overview).toMatchObject({ status: "ready", origin: "model" });
    expect(todaySchema.safeParse({ ...fixture, overview: overviewPendingFixture() }).success).toBe(true);
    expect(todaySchema.safeParse({ ...fixture, overview: null }).success).toBe(true);
    const stepIds = new Set(fixture.upcoming.map((step) => step.id));
    const alertIds = new Set(fixture.alerts.map((alert) => alert.id));
    const cardKinds = new Set(["harvest", "price", "weather", "health", "profit", "residue", "energy", "carbon"]);
    for (const o of [overviewFixture(), overviewDeterministicFixture()]) {
      const factIds = new Set(o.facts.map((f) => f.id));
      for (const ref of [...o.facts.map((f) => f.ref), ...o.points.map((p) => p.ref)]) {
        if (!ref) continue;
        expect(ref.kind === "step" ? stepIds.has(ref.id) : ref.kind === "alert" ? alertIds.has(ref.id) : cardKinds.has(ref.id)).toBe(true);
      }
      // A point's ref is its first cited fact's ref.
      for (const p of o.points) {
        expect(p.factIds.every((id) => factIds.has(id))).toBe(true);
        expect(p.ref).toEqual(o.facts.find((f) => f.id === p.factIds[0])!.ref);
      }
    }
  });
  it("keeps the headline and next-step shortcut visible and retains every complete note in a disclosure", () => {
    const markup = render(overviewFixture());
    const detailStart = markup.indexOf('class="today-overview-more"');
    expect(detailStart).toBeGreaterThan(0);
    expect(markup.slice(0, detailStart)).toContain('today-overview-headline');
    expect(markup.slice(0, detailStart)).toContain('Review next step');
    expect(markup.slice(detailStart)).toContain('data-kind="do_now"');
    expect(markup.slice(detailStart)).toContain('data-kind="watch"');
    for (const point of overviewFixture().points) expect(text(markup)).toContain(point.text);
    expect(markup.slice(0, detailStart)).not.toContain('data-kind="money"');
    expect(markup.slice(detailStart)).toContain('data-ref-id="profit"');
    expect(markup.slice(detailStart)).toContain("Expect about ₹94,800");
    expect(markup).not.toContain('<details class="today-overview-more" open');
  });
  it("shows the headline and the points in order, each with its kind chip", () => {
    const html = render(overviewFixture());
    const t = text(html);
    expect(t).toContain("Today for you");
    expect(t).toContain("Maize is on track for harvest in 63 to 73 days; check moisture and clear the drains now.");
    const kinds = [...html.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["do_now", "watch", "money", "later", "good_news"]);
    const chips = ["Do now", "Watch", "Money", "Later", "Good news"];
    const notes = text(html.slice(html.indexOf('class="today-overview-points"')));
    const positions = chips.map((c) => notes.indexOf(c));
    expect(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!))).toBe(true);
    expect(t.indexOf("Check field moisture today")).toBeLessThan(t.indexOf("Heavy rain is due on 4 Nov"));
    expect(t.indexOf("Expect about ₹94,800")).toBeLessThan(t.indexOf("Your crop looks near typical"));
    expect(html).toContain('aria-labelledby="today-overview-title"');
  });
  it("a step ref is a button aimed at the step's DOM id, an alert ref at the alert's, a card ref carries its kind", () => {
    const html = render(overviewFixture());
    // do_now cites the moisture step first.
    expect(html).toContain(`data-target="${stepDomId("care:task-moisture")}"`);
    expect(stepDomId("care:task-moisture")).toBe("today-step-care-task-moisture");
    // watch cites the rain alert.
    expect(html).toContain(`data-target="${alertDomId(FIXTURE_ALERT_IDS.weather)}"`);
    expect(html).toContain('data-ref-kind="card" data-ref-id="profit"');
    expect(html).toContain('data-ref-kind="card" data-ref-id="residue"');
    expect(text(html)).toContain("(go to the step)");
    expect(text(html)).toContain("(go to the alert)");
    expect(text(html)).toContain("(open the details)");
    // The ids the buttons aim at are the ids the real lists render.
    const list = renderToString(() => (
      <AlertsList alerts={fixture.alerts} newsReview={fixture.newsReview} today={FIXTURE_TODAY} stepAlertIds={new Set()} onDismiss={noop} onSuggested={noop} error="" />
    ));
    expect(list).toContain(`id="${alertDomId(FIXTURE_ALERT_IDS.weather)}"`);
    const steps = renderToString(() => <UpcomingSteps steps={fixture.upcoming} nextAction={fixture.nextAction ?? null} today={FIXTURE_TODAY} busyId="" onDone={noop} error="" />);
    expect(steps).toContain(`id="${stepDomId("care:task-moisture")}"`);
  });
  it("pointTarget resolves each ref kind, and a card ref that is not a card makes plain text, not a dead button", () => {
    expect(pointTarget({ ref: { kind: "step", id: "alert:abc" } })).toMatchObject({ kind: "dom", domId: "today-step-alert-abc" });
    expect(pointTarget({ ref: { kind: "alert", id: "a/b" } })).toMatchObject({ kind: "dom", domId: "today-alert-a-b" });
    expect(pointTarget({ ref: { kind: "card", id: "carbon" } })).toMatchObject({ kind: "card", card: "carbon" });
    expect(pointTarget({ ref: { kind: "card", id: "nonsense" } })).toBeNull();
    expect(pointTarget({ ref: null })).toBeNull();
    const o = { ...overviewFixture(), points: [{ ...overviewFixture().points[0]!, ref: null }, { ...overviewFixture().points[1]!, ref: { kind: "card" as const, id: "nonsense" } }] };
    const html = render(o);
    expect(html).not.toContain("today-overview-button");
    expect(text(html)).toContain("Check field moisture today");
  });
  it("model-written shows the AI mark; pending shows the code-written points, the quiet line and the mark; deterministic shows neither", () => {
    const model = render(overviewFixture());
    expect(model).toContain("AI used: Today overview");
    expect(model).not.toContain("Updating with AI");
    const pending = render(overviewPendingFixture());
    expect(text(pending)).toContain("Updating with AI…");
    expect(pending).toContain('aria-live="polite"');
    expect(pending).toContain("AI used: Today overview");
    expect(text(pending)).toContain("Do next: Check field moisture, due 31 Oct to 2 Nov");
    const code = render(overviewDeterministicFixture());
    expect(code).not.toContain("AI used");
    expect(code).not.toContain("Updating with AI");
    expect(text(code)).toContain("Do next: Check field moisture");
    expect(showsAiMark({ status: "ready", origin: "deterministic" })).toBe(false);
    expect(showsAiMark({ status: "ready", origin: "model" })).toBe(true);
    expect(showsAiMark({ status: "pending", origin: "deterministic" })).toBe(true);
  });
  it("null, undefined, unavailable and an empty overview render nothing", () => {
    expect(render(null)).not.toContain("Today for you");
    expect(render(undefined)).not.toContain("Today for you");
    expect(render(overviewUnavailableFixture())).not.toContain("Today for you");
    expect(render({ ...overviewFixture(), headline: null, points: [] })).not.toContain("Today for you");
    expect(text(render(null))).toBe("");
  });
  it("the card button reports the card kind to openDetails; the weather-only (no crop) layout has no overview at all", () => {
    // Solid's server render has no click, so check the handler contract through the props the view passes: the kind is the ref id.
    const seen: string[] = [];
    const target = pointTarget(overviewFixture().points[2]!);
    expect(target).toMatchObject({ kind: "card", card: "profit" });
    if (target?.kind === "card") seen.push(target.card);
    expect(seen).toEqual(["profit"]);
    // TodayCards never renders an overview, and the empty fixture carries none.
    expect(text(renderToString(() => <TodayCards view={fixture} date={FIXTURE_TODAY} price={null} weather={null} weatherOnly onDetails={noop} />))).not.toContain("Today for you");
    expect(todayEmptyFixture().overview ?? null).toBeNull();
  });
});
