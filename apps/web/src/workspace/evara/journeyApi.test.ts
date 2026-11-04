import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { FARM_ID, JOURNEY_ID, journeyFixture, journeyWith } from "./fixtures";
import { JOURNEY_POLL_LIMIT_MS, JOURNEY_POLL_MS, JourneyDataError, illustratedIndexes, journeyErrorText, loadCropJourney, pollCropJourney, requestCropJourney, stageProgress } from "./journeyApi";

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ requestId: "t", mode: "live", asOf: "2026-11-04T08:00:00Z", data, warnings: [], error: null }), { status, headers: { "content-type": "application/json" } });
const errorEnvelope = (status: number, code = "x") =>
  new Response(JSON.stringify({ requestId: "t", mode: "live", asOf: "2026-11-04T08:00:00Z", data: null, warnings: [], error: { code, message: "boom" } }), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers the session bootstrap, then hands out the queued responses in order and records every call. */
function stubFetch(queue: (() => Response)[]) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "csrf" });
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const noWait = () => {
  const waits: number[] = [];
  return { wait: async (ms: number) => void waits.push(ms), waits };
};

describe("crop journey client", () => {
  it("posts the request to the contract path and validates the journey (farm id checked)", async () => {
    const { impl, calls } = stubFetch([() => envelope(journeyFixture(), 202), () => envelope(journeyFixture({ farmId: "22222222-2222-4222-8222-222222222222" }))]);
    const created = await requestCropJourney(FARM_ID, { cropId: "ginger", fieldId: "field-a", sowingDate: "2027-02-12" }, impl);
    expect(created.journeyId).toBe(JOURNEY_ID);
    expect(calls[0]).toMatchObject({ url: `/api/v1/farms/${FARM_ID}/crop-journey`, method: "POST" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ cropId: "ginger", fieldId: "field-a", sowingDate: "2027-02-12" });
    await expect(requestCropJourney(FARM_ID, { cropId: "ginger" }, impl)).rejects.toThrow("another farm");
    const bad = stubFetch([() => envelope({ journeyId: "nope" })]);
    await expect(loadCropJourney(FARM_ID, JOURNEY_ID, bad.impl)).rejects.toBeInstanceOf(JourneyDataError);
  });

  it("polls every 3 seconds, reports each read in order so ready stages show as they finish, and stops at ready", async () => {
    const seq = [journeyWith("running", ["ready", "running", "queued"]), journeyWith("running", ["ready", "ready", "running"]), journeyWith("ready", ["ready", "ready", "ready"])];
    const { impl, calls } = stubFetch(seq.map((j) => () => envelope(j)));
    const { wait, waits } = noWait();
    const seen: string[][] = [];
    const outcome = await pollCropJourney(FARM_ID, journeyFixture(), { fetchImpl: impl, wait, onUpdate: (j) => seen.push(j.stages.map((s) => s.status)) });
    expect(outcome.status).toBe("done");
    expect(outcome.journey.status).toBe("ready");
    expect(seen).toEqual([
      ["ready", "running", "queued"],
      ["ready", "ready", "running"],
      ["ready", "ready", "ready"],
    ]);
    expect(waits).toEqual([JOURNEY_POLL_MS, JOURNEY_POLL_MS, JOURNEY_POLL_MS]);
    expect(calls.map((c) => c.url)).toEqual(Array(3).fill(`/api/v1/farms/${FARM_ID}/crop-journey/${JOURNEY_ID}`));
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("does not poll a journey that is already finished (a deduplicated or unavailable one)", async () => {
    const { impl, calls } = stubFetch([]);
    const unavailable = journeyWith("unavailable", [], { reason: "runtime_mode" });
    expect((await pollCropJourney(FARM_ID, unavailable, { fetchImpl: impl, wait: async () => undefined })).status).toBe("done");
    expect(calls).toEqual([]);
  });

  it("gives up after four minutes with the last journey it saw, then a later check can pick it up", async () => {
    expect(JOURNEY_POLL_LIMIT_MS).toBe(240_000);
    const rounds = JOURNEY_POLL_LIMIT_MS / JOURNEY_POLL_MS;
    const { impl, calls } = stubFetch(Array.from({ length: rounds }, () => () => envelope(journeyWith("running", ["ready", "running", "queued"]))));
    const { wait, waits } = noWait();
    const outcome = await pollCropJourney(FARM_ID, journeyFixture(), { fetchImpl: impl, wait });
    expect(outcome.status).toBe("timeout");
    expect(outcome.journey.stages[0]!.status).toBe("ready");
    expect(calls.length).toBe(80);
    expect(waits.length).toBe(80);
  });

  it("skips a transient failure (network, 429, 5xx) and keeps polling, but stops on a client error", async () => {
    const ok = journeyWith("ready", ["ready", "ready", "ready"]);
    const { impl } = stubFetch([() => errorEnvelope(503), () => errorEnvelope(429, "rate_limited"), () => envelope(ok)]);
    expect((await pollCropJourney(FARM_ID, journeyFixture(), { fetchImpl: impl, wait: async () => undefined })).status).toBe("done");
    const gone = stubFetch([() => errorEnvelope(404, "not_found")]);
    await expect(pollCropJourney(FARM_ID, journeyFixture(), { fetchImpl: gone.impl, wait: async () => undefined })).rejects.toBeInstanceOf(ApiError);
  });

  it("stops at once when cancelled (the strip unmounted), without reading again", async () => {
    const { impl, calls } = stubFetch([() => envelope(journeyWith("running", ["ready", "queued", "queued"]))]);
    let cancelled = false;
    const outcome = await pollCropJourney(FARM_ID, journeyFixture(), { fetchImpl: impl, wait: async () => void (cancelled = true), cancelled: () => cancelled });
    expect(outcome.status).toBe("cancelled");
    expect(calls).toEqual([]);
  });
});

describe("stage selection and error text", () => {
  it("illustrates every stage up to five, else the first, the last and three evenly spaced", () => {
    expect([...illustratedIndexes(3)]).toEqual([0, 1, 2]);
    expect([...illustratedIndexes(5)].length).toBe(5);
    expect([...illustratedIndexes(9)].sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8]);
    expect([...illustratedIndexes(12)].sort((a, b) => a - b)).toEqual([0, 3, 6, 8, 11]);
  });
  it("derives schematic progress from the stage index: the first stage is bare, the last is full, one stage sits in the middle", () => {
    expect([stageProgress(0, 5), stageProgress(2, 5), stageProgress(4, 5)]).toEqual([0, 0.5, 1]);
    expect(stageProgress(0, 1)).toBe(0.5);
  });
  it("turns errors into plain sentences", () => {
    expect(journeyErrorText(new ApiError("rate_limited", "x", 429))).toContain("Too many requests");
    expect(journeyErrorText(new ApiError("network_error", "x", 0))).toContain("Could not reach the server");
    expect(journeyErrorText(new Error("odd"))).toContain("could not be made");
  });
});
