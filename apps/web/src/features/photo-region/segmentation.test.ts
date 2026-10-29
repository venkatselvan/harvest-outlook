import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { interpretJob, pollSuggestion, type JobView } from "./segmentation";

const ok = { status: "ok", polygon: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], segmentationScore: 0.8, proposals: [{}, {}] };
const done = (result: unknown, state: JobView["state"] = "succeeded"): JobView => ({ state, result });

describe("interpretJob", () => {
  it("shows a proposal only for a well-formed ok result", () => {
    expect(interpretJob(done(ok))).toMatchObject({ kind: "proposal", score: 0.8, extra: 1 });
    expect(interpretJob(done({ ...ok, segmentationScore: 7 }))).toMatchObject({ kind: "proposal", score: null });
  });
  it("never fabricates a polygon: malformed, short, out-of-range and missing polygons fail", () => {
    for (const polygon of [undefined, [[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 0]], [[0, 0], [1, "x"], [1, 0]], "abc", Array.from({ length: 65 }, () => [0.5, 0.5])]) {
      expect(interpretJob(done({ ...ok, polygon })).kind, JSON.stringify(polygon)).toBe("failed");
    }
    expect(interpretJob(done(null)).kind).toBe("failed");
  });
  it("maps unavailable reasons to plain text that points to the manual outline path", () => {
    for (const reason of ["synthetic_mode", "provider_not_configured", "budget_exceeded", "something_new"]) {
      const o = interpretJob(done({ status: "unavailable", reason }));
      expect(o).toMatchObject({ kind: "unavailable", reason });
      expect((o as { message: string }).message).toMatch(/AI suggestion/);
    }
  });
  it("no_match and failed jobs are not proposals", () => {
    expect(interpretJob(done({ status: "no_match" })).kind).toBe("no_match");
    expect(interpretJob(done(null, "failed")).kind).toBe("failed");
    expect(interpretJob(done(null, "cancelled")).kind).toBe("failed");
  });
});

describe("pollSuggestion", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  it("polls until the job finishes", async () => {
    const c = clock();
    let n = 0;
    const out = await pollSuggestion("j", { ...c, fetchJob: async () => (++n < 3 ? done(null, "queued") : done(ok)) });
    expect(out.kind).toBe("proposal");
    expect(n).toBe(3);
  });
  it("times out as a failure that mentions the worker, instead of hanging", async () => {
    const c = clock();
    const out = await pollSuggestion("j", { ...c, timeoutMs: 10_000, fetchJob: async () => done(null, "running") });
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as { message: string }).message).toMatch(/worker/);
  });
  it("tolerates two transient errors, gives up on the third, and stops on 404", async () => {
    const c = clock();
    let n = 0;
    const flaky = await pollSuggestion("j", { ...c, fetchJob: async () => { if (++n <= 2) throw new ApiError("network_error", "x", 0); return done(ok); } });
    expect(flaky.kind).toBe("proposal");
    const dead = await pollSuggestion("j", { ...c, fetchJob: async () => { throw new ApiError("network_error", "x", 0); } });
    expect(dead.kind).toBe("failed");
    let calls = 0;
    const nf = await pollSuggestion("j", { ...c, fetchJob: async () => { calls++; throw new ApiError("not_found", "x", 404); } });
    expect(nf.kind).toBe("failed");
    expect(calls).toBe(1);
  });
  it("returns aborted when the signal fires", async () => {
    const ctl = new AbortController();
    const c = clock();
    const out = await pollSuggestion("j", { ...c, signal: ctl.signal, fetchJob: async () => { ctl.abort(); return done(null, "queued"); } });
    expect(out).toEqual({ kind: "aborted" });
  });
});
