import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import type { FarmAlert, YearPlanReview } from "@harvest/contracts";
import { ShellFieldChips, fieldChipsShown, workspaceChipItems } from "./FieldsToday";
import { farmHref } from "../farmTabs";
import { apply, generateYearPlan, loadYearPlan, pollYearPlan, rescore, withFieldId, yearPlanPath } from "../year/yearPlanApi";
import { applyResult, occupiedReview, pendingReview, rescoredBestOverall } from "../year/fixtures";
import { PlansByField, nextSeasonOf, nextSeasonText, plansByField } from "../year/PlansByField";
import { cropFitPath, loadCropFit, pollCropFit, refreshCropFit } from "../farm/cropFitApi";
import { calculatedReview, pendingReview as cropFitPending } from "../farm/cropFitFixtures";
import { loadSoilReview, refreshAndPoll, soilReviewPath } from "../farm/soilReviewApi";
import { pendingSoilReview, readyCodeReview } from "../farm/soilReviewFixtures";
import { loadSeasonPreview, seasonPreviewPath, withPreviewField } from "../season/seasonPreviewApi";
import { FIXTURE_FARM_ID as SEASON_FARM_ID, seasonPreviewFixture } from "../season/fixtures";
import { AlertsList, isFarmWide } from "../today/AlertsList";
import { FIXTURE_TODAY, todayFixture } from "../today/fixtures";
import { SoilScopeNote } from "./SoilScopeNote";
import { assistantTurnBody, assistantWelcomeText } from "../../features/ask/model";

/**
 * FIELDS_MULTICROP_SOIL_SPEC.md 12.6 (packet Q2): the shell's field chips, the Plan tab's "Plans by field", and the field
 * travelling with every year-plan, crop-fit, soil-review, season-preview and assistant request. Invented values.
 */
const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;

const FIELDS = [
  { id: "strip-1", name: "Strip 1" },
  { id: "strip-2", name: "Strip 2" },
  { id: "strip-3", name: "Strip 3" },
];
const CYCLES = [
  { id: "c1", cropId: "maize", cropName: "Maize", sowingDate: "2026-07-01", stage: "growing", fieldId: "strip-1" },
  {
    id: "c2",
    cropId: "paddy",
    cropName: "Paddy",
    sowingDate: "2026-08-01",
    stage: "growing",
    fieldId: "strip-2",
    companion: { cropId: "black_gram", cropName: "Black gram", rowRatio: "4:2" },
  },
  { id: "c3", cropId: "onion", cropName: "Onion", sowingDate: "2026-01-10", stage: "harvested", fieldId: "strip-3" },
];
const PLANS = [
  { id: "p-late", year: 2027, season: "Kharif", cropId: "sorghum", cropName: "Sorghum", plannedSowingDate: "2027-06-15", fieldId: "strip-1" },
  { id: "p-next", year: 2027, season: "Rabi", cropId: "black_gram", cropName: "Black gram", plannedSowingDate: "2027-02-10", fieldId: "strip-1" },
  { id: "p-past", year: 2026, season: "Kharif", cropId: "maize", cropName: "Maize", plannedSowingDate: "2026-06-01", fieldId: "strip-1" },
  { id: "p-farm", year: 2027, season: "Rabi", cropId: "onion", cropName: "Onion", plannedSowingDate: "2027-01-05" },
  { id: "p-undated", year: 2027, season: "Kharif", cropId: "groundnut", cropName: "Groundnut", fieldId: "strip-2" },
];
const cropName = (id: string) => id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ requestId: "t", mode: "synthetic", asOf: "2026-11-03T00:00:00Z", data, warnings: [], error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
/** Records method, URL and JSON body of every call except the CSRF session read; answers from the queue (the last item repeats). */
function fake(queue: unknown[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "test" });
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return envelope(queue.length > 1 ? queue.shift() : queue[0]);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("shell field chips (12.6)", () => {
  const items = workspaceChipItems(FIELDS, CYCLES, cropName);
  it("builds the chips from the stored workspace: current crop with its companion, harvested fields have no crop", () => {
    expect(items).toEqual([
      { id: "strip-1", name: "Strip 1", crop: "Maize", cropId: "maize" },
      { id: "strip-2", name: "Strip 2", crop: "Paddy + black gram", cropId: "paddy" },
      { id: "strip-3", name: "Strip 3", crop: "No crop", cropId: null },
    ]);
  });
  it("a legacy whole-farm cycle is the crop of every chip without its own cycle, labelled (whole farm); a field's own cycle wins", () => {
    const legacy = { id: "old", cropId: "ragi", cropName: "Ragi", sowingDate: "2026-07-01", stage: "growing" };
    const chips = workspaceChipItems(FIELDS, [legacy, CYCLES[0]!], cropName);
    expect(chips.map((c) => [c.crop, c.cropId])).toEqual([
      ["Maize", "maize"],
      ["Ragi (whole farm)", "ragi"],
      ["Ragi (whole farm)", "ragi"],
    ]);
    expect(workspaceChipItems(FIELDS, [{ ...legacy, stage: "harvested" }], cropName).map((c) => c.crop)).toEqual(["No crop", "No crop", "No crop"]);
  });
  it("shows on Today, Plan and Farm when the farm has fields, never on Market or a farm without fields", () => {
    expect(fieldChipsShown("today", 3)).toBe(true);
    expect(fieldChipsShown("year", 3)).toBe(true);
    expect(fieldChipsShown("soil", 3)).toBe(true);
    expect(fieldChipsShown("harvest", 3)).toBe(false);
    expect(fieldChipsShown("year", 0)).toBe(false);
  });
  it("renders the chips row on the Plan tab with the selected field pressed", () => {
    const markup = html(() => <ShellFieldChips tab="year" items={items} selected="strip-2" onSelect={noop} />);
    expect(markup).toContain('data-testid="shell-field-chips"');
    expect(markup).toContain('data-tab="year"');
    expect(markup).toContain('data-testid="today-field-chips"');
    expect(markup).toMatch(/aria-pressed="true" data-field-chip="strip-2"/);
    expect(markup).toMatch(/aria-pressed="false" data-field-chip="all"/);
    expect(text(markup)).toContain("Paddy + black gram");
  });
  it("renders the chips row on the Farm tab with All fields pressed when no field is selected", () => {
    const markup = html(() => <ShellFieldChips tab="soil" items={items} selected={null} onSelect={noop} />);
    expect(markup).toContain('data-tab="soil"');
    expect(markup).toMatch(/aria-pressed="true" data-field-chip="all"/);
    expect((markup.match(/class="today-field-chip"/g) ?? []).length).toBe(4);
  });
  it("renders nothing on Market or without fields", () => {
    expect(html(() => <ShellFieldChips tab="harvest" items={items} selected={null} onSelect={noop} />)).toBe("");
    expect(html(() => <ShellFieldChips tab="today" items={[]} selected={null} onSelect={noop} />)).toBe("");
  });
  it("a chip on the Plan tab links back to the Plan tab with the field", () => {
    expect(farmHref("year", undefined, "strip-2")).toBe("/farm?tab=year&field=strip-2");
    expect(farmHref("soil", "records", "strip-2")).toBe("/farm?tab=soil&view=records&field=strip-2");
  });
});

describe("year plan client sends the field (12.2)", () => {
  it("builds ?from= and ?fieldId= for GET and ?fieldId= for POST", () => {
    expect(yearPlanPath("f1")).toBe("/api/v1/farms/f1/year-plan");
    expect(yearPlanPath("f1", { fieldId: "strip-2" })).toBe("/api/v1/farms/f1/year-plan?fieldId=strip-2");
    expect(yearPlanPath("f1", { from: "2027-09-01", fieldId: "strip-2" })).toBe("/api/v1/farms/f1/year-plan?from=2027-09-01&fieldId=strip-2");
    expect(yearPlanPath("f1", { fieldId: null })).toBe("/api/v1/farms/f1/year-plan");
  });
  it("load, generate and poll name the field; generate keeps from in its body", async () => {
    const { calls, fetchImpl } = fake([pendingReview, occupiedReview]);
    await loadYearPlan("f1", { fetchImpl, fieldId: "strip-2", from: "2027-09-01" });
    await generateYearPlan("f1", { fetchImpl, fieldId: "strip-2", from: "2027-09-01", force: true });
    await pollYearPlan("f1", pendingReview as YearPlanReview, { fetchImpl, fieldId: "strip-2", intervalMs: 1 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/farms/f1/year-plan?from=2027-09-01&fieldId=strip-2",
      "POST /api/v1/farms/f1/year-plan?fieldId=strip-2",
      "GET /api/v1/farms/f1/year-plan?fieldId=strip-2",
    ]);
    expect(calls[1]!.body).toEqual({ force: true, from: "2027-09-01" });
  });
  it("a farm without fields sends no fieldId anywhere", async () => {
    const { calls, fetchImpl } = fake([occupiedReview]);
    await loadYearPlan("f1", { fetchImpl, fieldId: null });
    await generateYearPlan("f1", { fetchImpl });
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/farms/f1/year-plan", "/api/v1/farms/f1/year-plan"]);
  });
  it("rescore and apply bodies carry fieldId", async () => {
    const reviewId = "00000000-0000-4000-8000-0000000000aa";
    const { calls, fetchImpl } = fake([rescoredBestOverall, applyResult(occupiedReview, "opt-best-overall")]);
    await rescore("f1", withFieldId({ reviewId, optionId: "o1", slots: [{ cropId: "maize", productId: "maize", sowing: "2027-06-15" }] }, "strip-2"), { fetchImpl });
    await apply("f1", withFieldId({ reviewId, optionId: "o1", expectedWorkspaceVersion: 4 }, "strip-2"), { fetchImpl, idempotencyKey: "k" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/v1/farms/f1/year-plan/rescore", "POST /api/v1/farms/f1/year-plan/apply"]);
    expect(calls[0]!.body).toMatchObject({ reviewId, optionId: "o1", fieldId: "strip-2" });
    expect(calls[1]!.body).toEqual({ reviewId, optionId: "o1", expectedWorkspaceVersion: 4, fieldId: "strip-2" });
    expect(withFieldId({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe("Plans by field (12.6)", () => {
  const rows = plansByField(FIELDS, CYCLES, PLANS, "2026-11-03", cropName);
  it("picks the earliest upcoming saved season of the field itself (not past, not farm-wide)", () => {
    expect(nextSeasonOf("strip-1", PLANS, "2026-11-03")?.id).toBe("p-next");
    expect(nextSeasonOf("strip-3", PLANS, "2026-11-03")).toBeNull();
    expect(nextSeasonOf("strip-2", PLANS, "2026-11-03")?.id).toBe("p-undated");
    expect(nextSeasonText(null, cropName)).toBe("None planned");
  });
  it("one row per field: current crop and the next season with its sowing month, or season and year when undated", () => {
    expect(rows).toEqual([
      { id: "strip-1", name: "Strip 1", crop: "Maize", wholeFarm: false, cropId: "maize", cycleId: "c1", cycleName: "Maize", next: "Black gram, sowing Feb 2027", nextPlanId: "p-next" },
      { id: "strip-2", name: "Strip 2", crop: "Paddy + black gram", wholeFarm: false, cropId: "paddy", cycleId: "c2", cycleName: "Paddy + black gram", next: "Groundnut, Kharif 2027", nextPlanId: "p-undated" },
      { id: "strip-3", name: "Strip 3", crop: "No crop", wholeFarm: false, cropId: null, cycleId: null, cycleName: "", next: "None planned", nextPlanId: null },
    ]);
  });
  it("renders the rows with an Open plan button per field", () => {
    const markup = html(() => <PlansByField rows={rows} onOpen={noop} />);
    expect(markup).toContain('data-testid="yp-plans-by-field"');
    expect(text(markup)).toContain("Plans by field");
    expect((markup.match(/data-field-plan="/g) ?? []).length).toBe(3);
    expect((markup.match(/data-open-field-plan="/g) ?? []).length).toBe(3);
    expect(markup).toContain('aria-label="Open the plan for Strip 2"');
    expect(text(markup)).toContain("Next: Black gram, sowing Feb 2027");
    expect(text(markup)).toContain("Now: Paddy + black gram");
    expect(text(markup)).toContain("Next: None planned");
  });
});

describe("crop fit, soil review and season preview clients send the field (12.3)", () => {
  it("crop fit appends fieldId to the mode query, or starts the query without one", () => {
    expect(cropFitPath("f1", null, "strip-2")).toBe("/api/v1/farms/f1/crop-fit?fieldId=strip-2");
    expect(cropFitPath("f1", { mode: "season", season: "kharif", sowing: "", after: null } as never, "strip-2")).toBe(
      "/api/v1/farms/f1/crop-fit?mode=season&season=kharif&fieldId=strip-2",
    );
    expect(cropFitPath("f1", null)).toBe("/api/v1/farms/f1/crop-fit");
  });
  it("crop fit load, refresh and poll name the field", async () => {
    const { calls, fetchImpl } = fake([cropFitPending, calculatedReview]);
    const first = await loadCropFit("f1", null, { fetchImpl, fieldId: "strip-2" });
    await pollCropFit("f1", null, first, { fetchImpl, fieldId: "strip-2", intervalMs: 1 });
    await refreshCropFit("f1", null, { fetchImpl, fieldId: "strip-2" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/farms/f1/crop-fit?fieldId=strip-2",
      "GET /api/v1/farms/f1/crop-fit?fieldId=strip-2",
      "POST /api/v1/farms/f1/crop-fit?fieldId=strip-2",
    ]);
  });
  it("soil review GET and refresh name the field; without a field the path is the farm's", async () => {
    expect(soilReviewPath("f1")).toBe("/api/v1/farms/f1/soil-review");
    expect(soilReviewPath("f1", "strip-2")).toBe("/api/v1/farms/f1/soil-review?fieldId=strip-2");
    const { calls, fetchImpl } = fake([readyCodeReview, pendingSoilReview, readyCodeReview]);
    await loadSoilReview("f1", { fetchImpl, fieldId: "strip-2" });
    await refreshAndPoll("f1", { fetchImpl, fieldId: "strip-2", intervalMs: 1 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/farms/f1/soil-review?fieldId=strip-2",
      "POST /api/v1/farms/f1/soil-review?fieldId=strip-2",
      "GET /api/v1/farms/f1/soil-review?fieldId=strip-2",
    ]);
  });
  it("season preview of a saved season names the season's field", async () => {
    expect(seasonPreviewPath("f1", withPreviewField({ planId: "rot-1" }, "strip-2"))).toBe("/api/v1/farms/f1/season-preview?planId=rot-1&fieldId=strip-2");
    expect(seasonPreviewPath("f1", withPreviewField({ planId: "rot-1" }, undefined))).toBe("/api/v1/farms/f1/season-preview?planId=rot-1");
    const { calls, fetchImpl } = fake([seasonPreviewFixture({ fieldId: "strip-2" })]);
    const preview = await loadSeasonPreview(SEASON_FARM_ID, withPreviewField({ planId: "rot-pigeon" }, "strip-2"), fetchImpl);
    expect(preview.fieldId).toBe("strip-2");
    expect(calls[0]!.url).toContain("fieldId=strip-2");
  });
  it("soil records say they are for the whole farm only when the farm has fields", () => {
    expect(text(html(() => <SoilScopeNote fieldCount={3} />))).toBe("Soil reports are for the whole farm.");
    expect(html(() => <SoilScopeNote fieldCount={0} />)).toBe("");
  });
});

describe("Farm-wide alerts in a field view (12.4, 12.6)", () => {
  const fixture = todayFixture();
  const base = fixture.alerts[0]!;
  const fieldAlert: FarmAlert = { ...base, id: "a-field", title: "Stem borer window", fieldId: "strip-2", scope: "field" };
  const farmAlert: FarmAlert = { ...base, id: "a-farm", title: "Heavy rain", scope: "farm" };
  const legacyAlert: FarmAlert = { ...base, id: "a-old", title: "Old farm alert" };
  const render = (fieldView: boolean | undefined) =>
    html(() => (
      <AlertsList
        alerts={[fieldAlert, farmAlert, legacyAlert]}
        newsReview={fixture.newsReview}
        today={FIXTURE_TODAY}
        stepAlertIds={new Set()}
        onDismiss={noop}
        onSuggested={noop}
        error=""
        {...(fieldView === undefined ? {} : { fieldView })}
      />
    ));
  it("scope decides; without scope a missing fieldId is farm-wide", () => {
    expect(isFarmWide(fieldAlert)).toBe(false);
    expect(isFarmWide(farmAlert)).toBe(true);
    expect(isFarmWide(legacyAlert)).toBe(true);
    expect(isFarmWide({ fieldId: "strip-1" })).toBe(false);
  });
  it("chips the farm-wide alerts only, and only in a field view", () => {
    const markup = render(true);
    expect((markup.match(/data-testid="alert-farm-wide"/g) ?? []).length).toBe(2);
    const card = (id: string) => markup.match(new RegExp(`data-alert-id="${id}"[\\s\\S]*?</li>`))![0];
    expect(card("a-field")).not.toContain("Farm-wide");
    expect(card("a-farm")).toContain("Farm-wide");
    expect(render(false)).not.toContain("Farm-wide");
    expect(render(undefined)).not.toContain("Farm-wide");
  });
});

describe("Evara sends the selected field (12.5)", () => {
  it("the turn body carries fieldId with the farm, and never without it", () => {
    expect(assistantTurnBody({ text: "q", language: "en", farmId: "f1", fieldId: "strip-2" })).toEqual({ text: "q", language: "en", farmId: "f1", fieldId: "strip-2" });
    expect(assistantTurnBody({ text: "q", language: "en", farmId: "f1", fieldId: null, planId: "p1" })).toEqual({ text: "q", language: "en", farmId: "f1", planId: "p1" });
    expect(assistantTurnBody({ text: "q", language: "ta", farmId: undefined, fieldId: "strip-2" })).toEqual({ text: "q", language: "ta" });
  });
  it("the welcome line names the field", () => {
    expect(assistantWelcomeText("Green Acre", "Strip 2")).toMatch(/^I'm looking at Green Acre, about Strip 2\. /);
    expect(assistantWelcomeText("Green Acre", null)).toMatch(/^I'm looking at Green Acre\. /);
  });
});
