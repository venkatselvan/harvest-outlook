import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { SeasonController, SCHEMATIC_REASON_TEXT, type SeasonApi } from "./controller";
import { makePlan, makeTimeline, makeVisuals } from "./fixtures";
import type { MediaInfo } from "../photo-region/types";

const media: MediaInfo = {
  id: "m1",
  farmId: "farm-1",
  exifOrientation: null,
  orientedWidth: 800,
  orientedHeight: 600,
  normalized: { width: 800, height: 600, bytes: 1, contentType: "image/jpeg" },
  contentPath: "/x",
  region: { polygon: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]], source: "manual", transform: { orientationApplied: true, normalizedWidth: 800, normalizedHeight: 600 }, version: 3 },
};
const wrap = <T,>(data: T) => ({ data, mode: "synthetic" as const, warnings: [] as string[] });

function fakeApi(over: Partial<SeasonApi> = {}) {
  const api = {
    getPlan: vi.fn(async () => wrap(makePlan())),
    getTimeline: vi.fn(async (_id: string, s: "early" | "late") => wrap(makeTimeline({ scenarioId: s }))),
    getVisuals: vi.fn(async () => wrap(makeVisuals())),
    getJob: vi.fn(async () => wrap({ id: "j", state: "succeeded" })),
    listFarmMedia: vi.fn(async () => [media]),
    startVisuals: vi.fn(async () => wrap({ jobId: null, state: "cached", cached: true })),
    getCropEvidence: vi.fn(async () => []),
    ...over,
  } as unknown as SeasonApi & Record<string, ReturnType<typeof vi.fn>>;
  return api;
}
const totalCalls = (api: Record<string, unknown>) => Object.values(api).reduce<number>((n, f) => n + ((f as ReturnType<typeof vi.fn>).mock?.calls.length ?? 0), 0);
const NOW = () => new Date("2026-08-01T06:00:00Z");

describe("SeasonController", () => {
  it("loads plan, one timeline, visuals and the base photo once; today inside the range is selected", async () => {
    const api = fakeApi();
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    expect(c.snapshot.status).toBe("ready");
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(api.getTimeline).toHaveBeenCalledTimes(1);
    expect(api.getVisuals).toHaveBeenCalledTimes(1);
    expect(api.listFarmMedia).toHaveBeenCalledTimes(1);
    expect(c.snapshot.selectedDate).toBe("2026-08-01");
    expect(c.snapshot.media?.id).toBe("m1");
  });

  it("moving the slider (positions, dates, steps, dap) never touches the network or visuals", async () => {
    const api = fakeApi();
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    const before = totalCalls(api);
    const seen: (string | null)[] = [];
    c.subscribe((s) => seen.push(s.selectedDate));
    for (let p = 0; p < 200; p++) c.selectPos(p);
    for (let n = 0; n < 50; n++) c.step(n % 2 ? 7 : -7);
    c.select("2026-12-01");
    c.selectDap(10);
    c.select("2099-01-01"); // clamped
    expect(c.snapshot.selectedDate).toBe(c.index!.to);
    expect(totalCalls(api)).toBe(before);
    expect(seen.length).toBeGreaterThan(100); // state did change; only local state
    expect(c.record!.calendarDate).toBe(c.snapshot.selectedDate);
    expect(c.dap).toBe(c.record!.daysAfterPlanting);
  });

  it("the other scenario is fetched once on first use, then switched locally", async () => {
    const api = fakeApi();
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    await c.setScenario("late");
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    expect(api.getTimeline).toHaveBeenLastCalledWith("plan-1", "late");
    await c.setScenario("early");
    await c.setScenario("late");
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    expect(c.snapshot.scenario).toBe("late");
    expect(c.index!.scenarioId).toBe("late");
  });

  it("a visuals or photo failure never blocks the plan", async () => {
    const api = fakeApi({ getVisuals: vi.fn(async () => { throw new ApiError("boom", "x", 500); }), listFarmMedia: vi.fn(async () => { throw new ApiError("boom", "x", 500); }) } as never);
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    expect(c.snapshot.status).toBe("ready");
    expect(c.snapshot.visuals).toBeNull();
    expect(c.snapshot.media).toBeNull();
  });

  it("a plan load error is reported with its code", async () => {
    const api = fakeApi({ getPlan: vi.fn(async () => { throw new ApiError("not_found", "Plan not found", 404); }) } as never);
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    expect(c.snapshot.status).toBe("error");
    expect(c.snapshot.error).toMatchObject({ code: "not_found" });
  });

  it("Generate illustrations: queued job is polled, visuals refreshed, and the server's schematic reason is surfaced", async () => {
    const api = fakeApi({
      startVisuals: vi.fn(async () => wrap({ jobId: "job-1", state: "queued", cached: false })),
      getJob: vi.fn().mockResolvedValueOnce(wrap({ id: "job-1", state: "running" })).mockResolvedValueOnce(wrap({ id: "job-1", state: "succeeded" })),
    } as never);
    const c = new SeasonController("plan-1", { api, now: NOW, sleep: async () => undefined });
    await c.load();
    await c.generateIllustrations();
    expect(api.startVisuals).toHaveBeenCalledWith("plan-1", "m1", 3, expect.stringMatching(/^visuals-/));
    expect(api.getJob).toHaveBeenCalledTimes(2);
    expect(api.getVisuals).toHaveBeenCalledTimes(2); // load + after the job
    expect(c.snapshot.generate.status).toBe("done");
    expect(c.snapshot.generate.reasons).toEqual(["synthetic_mode"]);
    expect(SCHEMATIC_REASON_TEXT.synthetic_mode).toMatch(/schematic/);
    expect(c.snapshot.generate.message).toMatch(/Schematic drawings are shown/);
  });

  it("Generate illustrations with no confirmed region makes no request", async () => {
    const api = fakeApi({ listFarmMedia: vi.fn(async () => [{ ...media, region: null }]) } as never);
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    await c.generateIllustrations();
    expect(api.startVisuals).not.toHaveBeenCalled();
    expect(c.snapshot.generate.status).toBe("error");
  });

  it("a failed job leaves the plan usable and says so", async () => {
    const api = fakeApi({
      startVisuals: vi.fn(async () => wrap({ jobId: "job-2", state: "queued", cached: false })),
      getJob: vi.fn(async () => wrap({ id: "job-2", state: "failed" })),
    } as never);
    const c = new SeasonController("plan-1", { api, now: NOW, sleep: async () => undefined });
    await c.load();
    await c.generateIllustrations();
    expect(c.snapshot.generate.status).toBe("error");
    expect(c.snapshot.generate.message).toMatch(/plan, tasks and economics are unaffected/);
    expect(c.snapshot.status).toBe("ready");
  });

  it("history and citations load lazily, once", async () => {
    const api = fakeApi();
    const c = new SeasonController("plan-1", { api, now: NOW });
    await c.load();
    const planCalls = vi.mocked(api.getPlan).mock.calls.length;
    await c.loadHistory();
    await c.loadHistory();
    expect(c.snapshot.history.items).toHaveLength(1);
    expect(vi.mocked(api.getPlan).mock.calls.length).toBe(planCalls); // current plan already held
    await c.loadCitations();
    await c.loadCitations();
    expect(api.getCropEvidence).toHaveBeenCalledTimes(1);
  });
});
