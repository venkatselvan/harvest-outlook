import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { FutureLookRequestBody, TodayView as todaySchema, type FutureLookAsset, type SceneRef } from "@harvest/contracts";
import {
  FIXTURE_BOUNDARY,
  FIXTURE_FARM_ID,
  FIXTURE_TODAY,
  fieldSummariesFixture,
  ILLUSTRATION_DATE,
  LATEST_ITEM_ID,
  PREDICTED_DATES,
  predictedAssetId,
  predictedSceneFixture,
  todayFixture,
  todayPredictedFixture,
} from "./fixtures";
import {
  conditionAt,
  daysBetween,
  growthProgress,
  latestObservedDate,
  PREDICTED_MAX_GAP_DAYS,
  predictedCaption,
  predictionBlockedReason,
  predictionSourceScene,
  satelliteImage,
  sceneFor,
  sceneMarks,
  sliderModel,
  stageAt,
} from "./model";
import {
  loadPrediction,
  pollPrediction,
  PredictionError,
  predictionBody,
  predictionErrorReason,
  predictionMessage,
  predictionPath,
  requestPrediction,
} from "./todayApi";
import { FutureImageLabel, TodayHero, type FarmHero, type HeroPrediction } from "./TodayHero";
import { StageSlider } from "./StageSlider";
import { ApiError } from "../../lib/api";

/**
 * FIELDS_MULTICROP_SOIL_SPEC.md 11.4: AI-predicted looks on the Today satellite hero. Synthetic fixtures only (fixtures.ts):
 * latest real image 27 Oct, today 1 Nov, predicted looks for 28 Oct (automatic) and 16 Nov (asked for), and a 20 Oct look
 * superseded by the 27 Oct image.
 */
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const view = todayPredictedFixture();
const timeline = view.timeline!;
const stageIdAt = (date: string) => {
  const at = stageAt(timeline, date);
  return at.kind === "stage" ? at.stage.id : null;
};
const pickAt = (date: string, scenes: readonly SceneRef[] = view.scenes) => sceneFor(scenes, date, FIXTURE_TODAY, stageIdAt(date));

const hero = (date: string, options: { prediction?: HeroPrediction | null; scenes?: SceneRef[]; farm?: FarmHero } = {}) =>
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
      boundary={FIXTURE_BOUNDARY}
      scenes={options.scenes ?? view.scenes}
      imageBbox={view.ndvi!.imageBbox}
      fieldImageBbox={view.fieldImageBbox ?? null}
      prediction={options.prediction ?? null}
      condition={conditionAt(view.conditions, date)}
      hasConditions
      farm={options.farm ?? null}
    />
  ));
const livePrediction = (over: Partial<HeroPrediction> = {}): HeroPrediction => ({ pending: false, blocked: null, message: null, onPredict: () => undefined, ...over });

describe("predicted fixtures", () => {
  it("validate against the TodayView contract and keep the base fixture without predicted scenes", () => {
    expect(todaySchema.safeParse(view).success).toBe(true);
    expect(todaySchema.safeParse(todayPredictedFixture(FIXTURE_FARM_ID, { autoRequested: true, pending: 1, reason: null })).success).toBe(true);
    expect(view.scenes.filter((scene) => scene.kind === "predicted")).toHaveLength(3);
    expect(todayFixture().scenes.some((scene) => scene.kind === "predicted")).toBe(false);
    expect(todayFixture().predictions).toBeUndefined();
  });
});

describe("sceneFor with AI-predicted looks", () => {
  it("picks the predicted look whose target is the latest on or before the date, within 10 days, today included", () => {
    expect(latestObservedDate(view.scenes)).toBe("2026-10-27");
    const today = pickAt(FIXTURE_TODAY);
    expect(today.mode).toBe("predicted");
    expect(today.mode === "predicted" && today.scene.targetDate).toBe(PREDICTED_DATES.auto);
    expect(today.mode === "predicted" && today.derivedFrom?.itemId).toBe(LATEST_ITEM_ID);
    for (const date of ["2026-11-05", "2026-11-07"]) {
      const pick = pickAt(date);
      expect(pick.mode === "predicted" && pick.scene.targetDate).toBe(PREDICTED_DATES.auto);
    }
    expect(daysBetween(PREDICTED_DATES.auto, "2026-11-07")).toBe(PREDICTED_MAX_GAP_DAYS);
    const asked = pickAt("2026-11-26");
    expect(asked.mode === "predicted" && asked.scene.targetDate).toBe(PREDICTED_DATES.manual);
  });
  it("does not use a predicted look more than 10 days before the date", () => {
    // 11 days after 28 Oct and before 16 Nov: the vegetative stage has no illustration, so the dimmed latest image shows.
    const gap = pickAt("2026-11-08");
    expect(gap.mode).toBe("latest");
    expect(gap.mode === "latest" && gap.scene.acquisitionDate).toBe("2026-10-27");
    expect(pickAt("2026-11-27").mode).toBe("latest");
    expect(pickAt("2026-11-15").mode).toBe("latest");
  });
  it("prefers a predicted look over the stage illustration and over the latest image", () => {
    expect(pickAt(ILLUSTRATION_DATE).mode).toBe("illustration");
    const withLook = [...view.scenes, predictedSceneFixture(FIXTURE_FARM_ID, "2026-12-07", 4)];
    const pick = pickAt(ILLUSTRATION_DATE, withLook);
    expect(pick.mode).toBe("predicted");
    expect(pick.mode === "predicted" && pick.scene.targetDate).toBe("2026-12-07");
    // Without the 16 Nov look the same date would show the dimmed latest image.
    expect(pickAt("2026-11-16", view.scenes.filter((s) => s.targetDate !== PREDICTED_DATES.manual)).mode).toBe("latest");
    expect(pickAt("2026-11-16").mode).toBe("predicted");
  });
  it("leaves dates up to the latest real image unchanged and ignores superseded or imageless looks", () => {
    const past = pickAt("2026-10-20");
    expect(past.mode).toBe("observed");
    expect(past.mode === "observed" && past.scene.acquisitionDate).toBe("2026-10-17");
    expect(pickAt("2026-10-27").mode).toBe("observed");
    expect(pickAt("2026-10-24").mode).toBe("observed");
    const noImage = view.scenes.map((s): SceneRef => (s.kind === "predicted" ? { ...s, imagePath: null } : s));
    expect(pickAt(FIXTURE_TODAY, noImage).mode).toBe("observed");
    expect(pickAt("2026-11-16", noImage).mode).toBe("latest");
  });
  it("a predicted look uses its own wide image without the zoom or greenness toggles", () => {
    const pick = pickAt("2026-11-16");
    expect(satelliteImage(pick, { wide: false, greenness: true })).toEqual({
      path: `/api/v1/farms/${FIXTURE_FARM_ID}/future-look/${predictedAssetId(2)}/image`,
      zoom: "wide",
      layer: "visual",
      fieldAvailable: false,
      ndviAvailable: false,
    });
    expect(pick.mode === "predicted" && predictedCaption(pick)).toBe("Predicted look for 16 Nov 2026, made from the real image of 27 Oct 2026. Not an observation.");
  });
});

describe("hero for a predicted look", () => {
  it("shows the Predicted with AI chip with the AI mark, the caption, the alt text and the disclaimer; not dimmed, outline drawn", () => {
    const html = hero("2026-11-16");
    expect(html).toContain('data-scene-kind="predicted"');
    expect(html).toContain('data-testid="today-predicted-caption"');
    expect(html).toMatch(/class="today-chip predicted"[^>]*>Predicted with AI</);
    expect(html).toContain("ai-spark");
    expect(text(html)).toContain("Predicted with AI");
    expect(text(html)).toContain("Predicted look for 16 Nov 2026, made from the real image of 27 Oct 2026. Not an observation.");
    expect(html).toContain('alt="Predicted look of your field for 16 Nov 2026, made with AI from the real satellite image of 27 Oct 2026. Not an observation."');
    expect(html).toContain('data-testid="today-sat-predicted-note"');
    expect(text(html)).toContain("Not an observation; the change it shows is not measured.");
    expect(html).not.toContain("is-dimmed");
    expect(html).not.toContain("today-sat-future");
    expect(html).toContain("today-sat-outline");
    expect(html).not.toContain("Observed");
  });
  it("draws the weather overlay over a predicted look as over an observed image", () => {
    // 4 Nov: 48 mm forecast rain in the synthetic track, shown over the 28 Oct predicted look.
    const html = hero("2026-11-04");
    expect(html).toContain('data-scene-kind="predicted"');
    expect(html).toMatch(/class="today-sat-conditions"[^>]*data-rain-count="[1-9]/);
    expect(html).toContain("today-sat-outline");
    expect(text(html)).toContain("Weather overlay");
  });
  it("the farm overview never shows a predicted look", () => {
    const farm: FarmHero = { boundary: FIXTURE_BOUNDARY, fields: fieldSummariesFixture(), selectedId: null };
    const html = hero(FIXTURE_TODAY, { farm, prediction: livePrediction() });
    expect(html).toContain('data-scene-kind="observed"');
    expect(html).not.toContain('data-scene-kind="predicted"');
    expect(html).not.toContain("Predicted with AI");
    expect(hero("2026-11-10", { farm, prediction: livePrediction() })).not.toContain("today-predict");
  });
});

describe("slider marks for predicted looks", () => {
  it("marks predicted dates as hollow rings and leaves superseded looks off", () => {
    const model = sliderModel(view)!;
    const marks = sceneMarks(view.scenes, model);
    expect(marks.filter((m) => m.kind === "predicted").map((m) => m.date)).toEqual([PREDICTED_DATES.auto, PREDICTED_DATES.manual]);
    const html = renderToString(() => (
      <StageSlider model={model} value={model.todayIndex} onChange={() => undefined} valueDate={FIXTURE_TODAY} ticks={[]} onBackToToday={() => undefined} startLabel="Sown" endLabel="Harvest" marks={marks} />
    ));
    expect((html.match(/class="today-slider-mark predicted"/g) ?? []).length).toBe(2);
    expect((html.match(/data-scene-kind="predicted"/g) ?? []).length).toBe(2);
    expect(html).toContain('title="AI-predicted look 16 Nov 2026"');
    expect(text(html)).toContain("Hollow rings mark 2 dates with an AI-predicted look, not an observation.");
    expect(text(html)).toContain("Dots on the slider mark the 7 dates with a satellite image.");
  });
});

describe("no image yet: Predicting with AI and Predict with AI", () => {
  it("shows Predicting with AI… in a polite live region instead of the no-image line while a look is pending", () => {
    const html = hero("2026-11-10", { prediction: livePrediction({ pending: true }) });
    expect(html).toContain("is-dimmed");
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(text(html)).toContain("Predicting with AI…");
    expect(text(html)).not.toContain("No image yet for this date");
    expect(html).not.toContain('data-testid="today-predict"');
  });
  it("offers Predict with AI beside the no-image line only in live mode", () => {
    const live = hero("2026-11-10", { prediction: livePrediction() });
    expect(text(live)).toContain("No image yet for this date; latest image 27 Oct");
    expect(live).toContain('data-testid="today-predict"');
    expect(text(live)).toContain("Predict with AI");
    // Without a prediction prop (not live, or the farm overview) the line stays as before, without the button.
    const offline = hero("2026-11-10");
    expect(text(offline)).toContain("No image yet for this date; latest image 27 Oct");
    expect(offline).not.toContain("today-predict");
    // Live mode is a view whose latest real scene carries a Sentinel-2 item id; TodayView passes no prediction otherwise.
    expect(predictionSourceScene(view.scenes)?.itemId).toBe(LATEST_ITEM_ID);
    expect(predictionSourceScene(view.scenes.map((s) => ({ ...s, itemId: null })))).toBeNull();
    expect(predictionSourceScene([])).toBeNull();
  });
  it("disables the button with the reason when a cap stops it, and shows the last message", () => {
    expect(predictionBlockedReason("cycle_limit_reached", "2026-11-10", FIXTURE_TODAY)).toBe("This crop has used all its AI predicted looks for the season.");
    expect(predictionBlockedReason("budget_exceeded", "2026-11-10", FIXTURE_TODAY)).toMatch(/budget/);
    expect(predictionBlockedReason("auto_daily_limit", "2026-11-10", FIXTURE_TODAY)).toBeNull();
    expect(predictionBlockedReason("week_exists", "2026-11-10", FIXTURE_TODAY)).toBeNull();
    expect(predictionBlockedReason(null, "2027-03-02", FIXTURE_TODAY)).toBe("Predicted looks are made up to 120 days ahead.");
    expect(predictionBlockedReason(null, "2027-03-01", FIXTURE_TODAY)).toBeNull();
    const blocked = hero("2026-11-10", { prediction: livePrediction({ blocked: "This crop has used all its AI predicted looks for the season.", message: "Too many requests. Wait a minute and try again." }) });
    expect(blocked).toMatch(/data-testid="today-predict" disabled/);
    expect(blocked).toContain('aria-describedby="today-predict-blocked"');
    expect(text(blocked)).toContain("This crop has used all its AI predicted looks for the season.");
    expect(blocked).toContain('role="alert" data-testid="today-predict-message"');
  });
  it("the button asks for the slider date", () => {
    const asked: string[] = [];
    const html = renderToString(() => <FutureImageLabel label="No image yet" date="2026-11-12" prediction={livePrediction({ onPredict: (d) => asked.push(d) })} />);
    expect(html).toContain("Predict with AI");
    // SSR cannot click; the handler is the prop called with the label's date.
    livePrediction({ onPredict: (d) => asked.push(d) }).onPredict("2026-11-12");
    expect(asked).toEqual(["2026-11-12"]);
  });
});

// ------------------------------------------------------------------ request, poll and error mapping

const envelope = (data: unknown, error: unknown = null) =>
  JSON.stringify({ requestId: "r1", mode: "live", asOf: "2026-11-01T04:30:00Z", warnings: [], data, error });
const assetId = predictedAssetId(9);
const asset = (status: FutureLookAsset["status"], over: Partial<FutureLookAsset> = {}): FutureLookAsset => ({
  assetId,
  farmId: FIXTURE_FARM_ID,
  cycleId: "maize-cycle",
  stageId: "tasselling",
  stageName: "Tasselling and silking",
  cropId: "maize",
  cropName: "Maize",
  sourceItemId: LATEST_ITEM_ID,
  sourceAcquiredAt: "2026-10-27T05:16:51Z",
  derivedFromDate: "2026-10-27",
  status,
  failureReason: null,
  label: "Predicted with AI",
  disclaimer: "Not an observation.",
  imagePath: status === "ready" ? `/api/v1/farms/${FIXTURE_FARM_ID}/future-look/${assetId}/image` : null,
  qa: null,
  model: null,
  responseDeleted: null,
  promptVersion: "future-look-v2",
  attempt: 1,
  kind: "gap",
  targetDate: "2026-11-09",
  guidance: null,
  createdAt: "2026-11-01T04:30:00Z",
  updatedAt: "2026-11-01T04:30:00Z",
  ...over,
});
interface Call {
  url: string;
  method: string;
  body: unknown;
}
/** A fetch that answers the session check and then the given responses in order, recording every call. */
function fakeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/session") return new Response(JSON.stringify({ data: { authenticated: true, csrfToken: "csrf-test" } }), { status: 200 });
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = queue.shift();
    if (!next) throw new TypeError("no more responses");
    return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const queued = { assetId, status: "queued", reason: null, cycleId: "maize-cycle", stageId: "tasselling", deduplicated: false, kind: "gap", targetDate: "2026-11-09" };

describe("requestPrediction and pollPrediction", () => {
  it("POSTs the strict gap body for the slider date to the latest scene, with the cycle id", async () => {
    expect(predictionBody("2026-11-12")).toEqual({ kind: "gap", targetDate: "2026-11-12" });
    expect(FutureLookRequestBody.safeParse(predictionBody("2026-11-12")).success).toBe(true);
    expect(predictionPath(FIXTURE_FARM_ID, LATEST_ITEM_ID, "maize-cycle")).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/ndvi/${LATEST_ITEM_ID}/future?cycleId=maize-cycle`);
    expect(predictionPath(FIXTURE_FARM_ID, LATEST_ITEM_ID)).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/ndvi/${LATEST_ITEM_ID}/future`);
    const { impl, calls } = fakeFetch([{ status: 202, body: envelope(queued) }]);
    const result = await requestPrediction(FIXTURE_FARM_ID, LATEST_ITEM_ID, "2026-11-12", "maize-cycle", impl);
    expect(result).toMatchObject({ assetId, status: "queued" });
    expect(calls).toEqual([{ url: predictionPath(FIXTURE_FARM_ID, LATEST_ITEM_ID, "maize-cycle"), method: "POST", body: { kind: "gap", targetDate: "2026-11-12" } }]);
  });
  it("maps API refusals to short messages through details.reason", async () => {
    const refuse = async (status: number, code: string, reason?: string) => {
      const { impl } = fakeFetch([{ status, body: envelope(null, { code, message: "refused", ...(reason ? { details: { reason } } : {}) }) }]);
      try {
        await requestPrediction(FIXTURE_FARM_ID, LATEST_ITEM_ID, "2026-11-12", "maize-cycle", impl);
      } catch (error) {
        return error as PredictionError;
      }
      throw new Error("expected a refusal");
    };
    const tooFar = await refuse(400, "validation_error", "target_too_far");
    expect(tooFar).toBeInstanceOf(PredictionError);
    expect(tooFar.reason).toBe("target_too_far");
    expect(tooFar.message).toBe("That date is too far ahead to predict. Pick a date within 120 days of today.");
    expect((await refuse(409, "conflict", "scene_not_latest")).message).toBe("The satellite images changed since this view loaded. Reloading the view.");
    expect((await refuse(409, "conflict", "target_not_after_scene")).reason).toBe("target_not_after_scene");
    expect((await refuse(429, "rate_limited")).reason).toBe("rate_limited");
    // Unavailable results carry their reason in the body.
    for (const [reason, message] of [
      ["cycle_limit_reached", "This crop has used all its AI predicted looks for the season."],
      ["budget_exceeded", "Today's AI budget is used up. Try again tomorrow."],
      ["provider_unavailable", "The AI image service is unavailable right now. Try again later."],
    ] as const) {
      const { impl } = fakeFetch([{ status: 200, body: envelope({ ...queued, assetId: null, status: "unavailable", reason }) }]);
      await expect(requestPrediction(FIXTURE_FARM_ID, LATEST_ITEM_ID, "2026-11-12", "maize-cycle", impl)).rejects.toMatchObject({ reason, message });
    }
    expect(predictionErrorReason(new ApiError("network_error", "x", 0))).toBe("network");
    expect(predictionMessage("provider_timeout")).toBe("The AI image service is unavailable right now. Try again later.");
    expect(predictionMessage("timeout")).toMatch(/longer than usual/);
    expect(predictionMessage("something_new")).toBe("The predicted look could not be made this time.");
  });
  it("polls the asset every interval until it is ready, tolerating a transient error", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: envelope(asset("queued")) },
      { status: 503, body: envelope(null, { code: "unavailable", message: "busy" }) },
      { status: 200, body: envelope(asset("running")) },
      { status: 200, body: envelope(asset("ready")) },
    ]);
    const waits: number[] = [];
    const outcome = await pollPrediction(FIXTURE_FARM_ID, assetId, { fetchImpl: impl, wait: async (ms) => void waits.push(ms) });
    expect(outcome.status).toBe("ready");
    expect(waits).toEqual([3000, 3000, 3000, 3000]);
    expect(calls.every((call) => call.method === "GET" && call.url === `/api/v1/farms/${FIXTURE_FARM_ID}/future-look/${assetId}`)).toBe(true);
  });
  it("stops after 3 minutes (60 polls), on a failed asset, and when cancelled", async () => {
    const running = Array.from({ length: 61 }, () => ({ status: 200, body: envelope(asset("running")) }));
    const slow = fakeFetch(running);
    const timeout = await pollPrediction(FIXTURE_FARM_ID, assetId, { fetchImpl: slow.impl, wait: async () => undefined });
    expect(timeout.status).toBe("timeout");
    expect(slow.calls).toHaveLength(60);
    const failed = fakeFetch([{ status: 200, body: envelope(asset("failed", { failureReason: "provider_timeout" })) }]);
    await expect(pollPrediction(FIXTURE_FARM_ID, assetId, { fetchImpl: failed.impl, wait: async () => undefined })).resolves.toMatchObject({ status: "failed", reason: "provider_timeout" });
    const never = fakeFetch([]);
    await expect(pollPrediction(FIXTURE_FARM_ID, assetId, { fetchImpl: never.impl, wait: async () => undefined, cancelled: () => true })).resolves.toMatchObject({ status: "cancelled" });
    expect(never.calls).toHaveLength(0);
  });
  it("rejects an asset of another farm", async () => {
    const { impl } = fakeFetch([{ status: 200, body: envelope(asset("ready", { farmId: "22222222-2222-4222-8222-222222222222" })) }]);
    await expect(loadPrediction(FIXTURE_FARM_ID, assetId, impl)).rejects.toThrow(/did not match/);
  });
});
