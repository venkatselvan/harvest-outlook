import { describe, expect, it } from "vitest";
import { computeStageBlend } from "../season-scene";
import { makeTimeline, STAGES } from "./fixtures";
import {
  addDaysIso,
  clampDate,
  dapToDate,
  dateToDap,
  dateToPos,
  indexTimeline,
  markerPercent,
  outlookView,
  posToDate,
  recordAt,
  sceneChoice,
  stageWindowsFromDays,
  taskRows,
  todayInKolkata,
  weatherView,
  SCENARIO_WEATHER_TEXT,
  PRICE_PENDING_TEXT,
} from "./model";
import { makePlan } from "./fixtures";
import { outputsOf } from "../../lib/plan-api";

const tl = makeTimeline({ photoDates: { "2026-06-20": "media-photo-1" } });
const ix = indexTimeline(tl, "2026-06-01");

describe("slider and date mapping", () => {
  it("position, date and days-after-planting convert both ways", () => {
    expect(ix.from).toBe("2026-05-18");
    expect(posToDate(ix, 0)).toBe("2026-05-18");
    expect(posToDate(ix, 14)).toBe("2026-06-01");
    expect(dateToPos(ix, "2026-06-01")).toBe(14);
    for (const p of [0, 1, 14, 100, ix.days.length - 1]) expect(dateToPos(ix, posToDate(ix, p))).toBe(p);
    expect(dateToDap("2026-06-01", "2026-06-01")).toBe(0);
    expect(dateToDap("2026-06-01", "2026-05-25")).toBe(-7);
    expect(dapToDate("2026-06-01", 90)).toBe("2026-08-30");
    expect(dapToDate("2026-06-01", dateToDap("2026-06-01", "2026-12-31"))).toBe("2026-12-31");
    // Day arithmetic does not drift across month ends or a leap day.
    expect(addDaysIso("2028-02-28", 2)).toBe("2028-03-01");
  });
  it("clamps out-of-range dates and positions", () => {
    expect(clampDate(ix, "2000-01-01")).toBe(ix.from);
    expect(clampDate(ix, "2100-01-01")).toBe(ix.to);
    expect(posToDate(ix, -50)).toBe(ix.from);
    expect(posToDate(ix, 1e9)).toBe(ix.to);
  });
  it("marker positions are percentages along the track, null when outside", () => {
    expect(markerPercent(ix, ix.from)).toBe(0);
    expect(markerPercent(ix, ix.to)).toBe(100);
    expect(markerPercent(ix, "2026-06-01")).toBeCloseTo((14 / (ix.days.length - 1)) * 100, 6);
    expect(markerPercent(ix, "2099-01-01")).toBeNull();
  });
  it("today is the Asia/Kolkata calendar date, not the UTC date", () => {
    expect(todayInKolkata(new Date("2026-10-30T20:00:00Z"))).toBe("2026-10-31"); // 01:30 IST next day
    expect(todayInKolkata(new Date("2026-10-30T18:29:00Z"))).toBe("2026-10-30");
  });
});

describe("selected record lookup", () => {
  it("is a single indexed read, not a scan of the timeline", () => {
    let reads = 0;
    const counted = new Proxy([...tl.days], {
      get(t, k, r) {
        if (typeof k === "string" && /^\d+$/.test(k)) reads++;
        return Reflect.get(t, k, r);
      },
    });
    const probe = { ...ix, days: counted as typeof ix.days };
    for (let i = 0; i < 50; i++) recordAt(probe, "2026-07-15");
    expect(reads).toBe(50); // exactly one element read per lookup, independent of timeline length (250+ days)
    expect(recordAt(ix, "2026-07-15")!.calendarDate).toBe("2026-07-15");
    expect(recordAt(ix, "1999-01-01")).toBeNull();
  });
});

describe("weather horizon rendering", () => {
  const day = (date: string) => recordAt(ix, date)!;
  it("observed shows values and the source", () => {
    const v = weatherView(day("2026-07-30"));
    expect(v.kind).toBe("observed");
    expect(v.badge).toBe("observed");
    expect(v.lines.join("|")).toMatch(/Rain 3\.2 mm/);
  });
  it("a past day without an observation is a labelled gap, with no numbers", () => {
    const v = weatherView(day("2026-06-10"));
    expect(v.kind).toBe("gap");
    expect(v.title).toBe("No record");
    expect(v.lines.join("|")).not.toMatch(/\d+(\.\d+)? mm/);
  });
  it("forecast carries the issue time and horizon", () => {
    const v = weatherView(day("2026-08-03"));
    expect(v.kind).toBe("forecast");
    const text = v.lines.join("|");
    expect(text).toMatch(/Issued 1 Aug 2026, 06:00 IST/);
    expect(text).toMatch(/Horizon: 10 days/);
    expect(text).toMatch(/not the rain that fell/);
  });
  it("beyond the forecast horizon only the seasonal scenario wording appears and no daily rain value", () => {
    const v = weatherView(day("2026-09-20"));
    expect(v.kind).toBe("scenario");
    expect(v.badge).toBe("scenario");
    expect(v.lines[0]).toBe(SCENARIO_WEATHER_TEXT);
    expect(v.lines.join("|")).not.toMatch(/Rain \d/);
    expect(v.lines.join("|")).not.toMatch(/\d+(\.\d+)? mm/);
  });
  it("other unavailable reasons are reported, not hidden", () => {
    const d = { ...day("2026-09-20"), weather: { ...day("2026-09-20").weather, state: "unavailable" as const, values: null, missingReason: "forecast_day_missing" } };
    expect(weatherView(d).kind).toBe("unavailable");
    expect(weatherView(d).lines[0]).toMatch(/does not cover/);
  });
});

describe("scene choice", () => {
  it("an observed journal photo takes precedence over the illustration, with its own label", () => {
    // Make the photo day also a future day that would otherwise show an illustration.
    const future = makeTimeline({ asOf: "2026-06-01", photoDates: { "2026-07-01": "media-9" } });
    const fx = indexTimeline(future, "2026-06-01");
    const d = recordAt(fx, "2026-07-01")!;
    expect(d.expectedStage).not.toBeNull();
    const c = sceneChoice(fx, d);
    expect(c).toMatchObject({ kind: "photo", assetId: "media-9" });
    expect((c as { label: string }).label).toBe("Your photo · 1 Jul 2026");
    // Without the photo the same day is an illustration.
    expect(sceneChoice(fx, recordAt(fx, "2026-07-02")!).kind).toBe("illustration");
  });
  it("a past date without a photo stays empty (no synthetic image is offered as an observation)", () => {
    const c = sceneChoice(ix, recordAt(ix, "2026-06-10")!);
    expect(c.kind).toBe("absent");
  });
  it("illustration progress comes from computeStageBlend over the timeline's own stage windows", () => {
    const w = stageWindowsFromDays(tl.days);
    expect(w.map((x) => x.stageId)).toEqual(STAGES.map((s) => s.stageId));
    expect(w[0]).toMatchObject({ startDap: 0, endDap: 90 });
    expect(w[1]).toMatchObject({ startDap: 90, endDap: 135 });
    const future = makeTimeline({ asOf: "2026-05-01" });
    const fx = indexTimeline(future, "2026-06-01");
    const at = (dap: number) => (sceneChoice(fx, recordAt(fx, dapToDate("2026-06-01", dap))!) as { kind: "illustration"; progress: ReturnType<typeof computeStageBlend> }).progress;
    expect(at(10)).toEqual(computeStageBlend(10, fx.stageWindows));
    expect(at(10)).toMatchObject({ fromStageId: "s_veg", toStageId: "s_veg", t: 0 });
    expect(at(90)).toMatchObject({ fromStageId: "s_veg", toStageId: "s_init" });
    expect(at(90).t).toBeCloseTo(0.5, 5);
    expect(computeStageBlend(-5, fx.stageWindows)).toMatchObject({ fromStageId: null, toStageId: "s_veg" });
    const before = sceneChoice(fx, recordAt(fx, dapToDate("2026-06-01", -5))!);
    expect(before).toMatchObject({ kind: "absent" });
    expect((before as { message: string }).message).toMatch(/No stage is expected/);
  });
});

describe("price and tasks", () => {
  it("price outlook says access is pending when the plan outlook is unavailable for that reason", () => {
    const d = recordAt(ix, "2026-07-15")!;
    const v = outlookView(d, { state: "unavailable", missingReason: "price_access_key_gated", issueDate: "2026-08-01", issuedAt: null, periods: [] }, null);
    expect(v.badge).toBe("unavailable");
    expect(v.lines[0]).toBe(PRICE_PENDING_TEXT);
    expect(v.lines.join("|")).toMatch(/applies to harvest periods only/);
  });
  it("a forecast range names the issue time and says it is not a guaranteed price", () => {
    const d = { ...recordAt(ix, "2026-07-15")!, outlook: { state: "forecast" as const, harvestPeriodId: "h1", artifactId: "a", issuedAt: "2026-06-01T00:00:00+05:30", missingReason: null } };
    const v = outlookView(d, { state: "forecast", missingReason: null, issueDate: "2026-08-01", issuedAt: "2026-06-01T00:00:00+05:30", periods: [{ periodId: "h1", period: { start: "2026-07-01", end: "2026-07-31" }, price: { low: 30, central: 45, high: 60, levels: [0.1, 0.5, 0.9] }, missingReason: null }] }, null);
    expect(v.badge).toBe("forecast");
    expect(v.lines[0]).toMatch(/low 30, central 45, high 60/);
    expect(v.lines[1]).toMatch(/issued 31 May 2026|issued 1 Jun 2026/i);
  });
  it("task rows carry reason, citations and the rain flag with its assumption wording", () => {
    const outputs = outputsOf(makePlan());
    const byId = new Map(outputs.tasks!.tasks.map((t) => [t.task.id, t]));
    const plantDay = { ...recordAt(indexTimeline(makeTimeline({ asOf: "2026-05-01" }), "2026-06-01"), "2026-06-01")! };
    const rows = taskRows(plantDay, byId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "due", reason: "Plant seed rhizome pieces", evidenceIds: ["ev.one"] });
    expect(rows[0]!.flag).toMatch(/60 mm is at or above the 50 mm threshold \(a planning assumption/);
    expect(rows[0]!.trigger).toMatch(/named assumption/);
  });
});
