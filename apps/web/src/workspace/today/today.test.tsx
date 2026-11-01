import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { FarmAlert as alertSchema, FarmAlertType, INDEX_IDS, IndexStageReading as curveSchema, TodayView as todaySchema, type FarmAlert, type NdviSeries, type SceneRef, type StageTimeline } from "@harvest/contracts";
import { ApiError } from "../../lib/api";
import {
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
import { HealthCard, OutlookLine, TodayCards } from "./TodayCards";
import { CurveSheetBody, IndexTable, TodaySheetBody } from "./TodaySheet";
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
    expect(ticks.map((tick) => tick.id)).toEqual(["vegetative", "tasselling", "grain_fill", "maturity"]);
    expect(ticks[1]!.fraction).toBeCloseTo(55 / 120, 6);
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
    expect(html).toContain("Next: Tasselling and silking on 9 Nov");
    expect(html).toContain("₹19–24 /kg");
    expect(html).toContain("₹19.2 to ₹23.8 per kg");
    expect(html).toContain("Based on 3 years of Karnataka mandi prices (test fixture)");
    expect(html).toMatch(/10 Dec: ₹21\.\d\/kg typical/);
    expect(html).toContain("Typical for this date, 2023 to 2025");
    expect(html).toContain("0.62");
    expect(html).toContain("Near typical");
    expect(html).toContain("typical 0.55 to 0.70");
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
    expect(text(past)).toContain("Observed 17 Oct 2026 Cloud 6%");
    expect(past).toContain(`alt="Satellite image of your field, observed 17 Oct 2026, 6% cloud in the scene"`);
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
  it("Health card: the index line sits under the basis line, with a spoken form, and hides without index data", () => {
    const html = card(fixture.ndvi);
    const visible = seen(html);
    // One line per index, name and code then value, in this order; a bare "Moisture 0.18" is never shown.
    expect(visible).toContain("Moisture index (NDMI) 0.18 Red-edge greenness (NDRE) 0.31 Water index (NDWI) −0.45");
    expect(visible).not.toMatch(/Moisture 0\.18|Surface water/);
    expect(visible.indexOf("Moisture index (NDMI)")).toBeGreaterThan(visible.indexOf("Image of 27 Oct"));
    expect(html).toContain("Moisture index, NDMI 0.18");
    expect(html).toContain("Red-edge greenness, NDRE 0.31");
    expect(html).toContain("Water index, NDWI minus 0.45");
    expect((html.match(/data-index-id=/g) ?? []).length).toBe(3);
    expect(html).toContain('data-testid="today-index-line"');
    // The NDVI headline and verdict are unchanged.
    expect(visible).toContain("0.62");
    expect(visible).toContain("Near typical");
    // No summaries (a row analysed before the indices existed), only null summaries, or no series: no line, no blank dashes.
    expect(card(withIndices(undefined))).not.toContain("today-index-line");
    const nulls = { evi: null, ndre: null, gndvi: null, savi: null, ndmi: null, lswi: null, ndwi: null };
    expect(card(withIndices(nulls))).not.toContain("today-index-line");
    expect(card(null)).not.toContain("today-index-line");
    expect(text(card(withIndices(undefined)))).toContain("Near typical");
  });
  it("Health card names the image when the index scene is not the one behind the NDVI headline", () => {
    const earlier = { ...fixture.ndvi!, latestUsable: { ...latest(), date: "2026-10-22" } };
    expect(seen(card(earlier))).toContain("Water index (NDWI) −0.45 Indices from the image of 22 Oct");
    expect(text(card(fixture.ndvi))).not.toContain("Indices from the image of");
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
