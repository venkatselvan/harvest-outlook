import { describe, expect, it } from "vitest";
import { ApiError, getCapabilities, parseEnvelope } from "./api";

const good = {
  requestId: "r1",
  mode: "synthetic",
  asOf: "2026-10-30T00:00:00.000Z",
  data: { mode: "synthetic" },
  warnings: [],
  error: null,
};
const jsonResponse = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("api client envelope handling", () => {
  it("parses a valid envelope", () => {
    expect(parseEnvelope(good).mode).toBe("synthetic");
  });

  it.each([
    ["null", null],
    ["unknown mode", { ...good, mode: "production" }],
    ["missing error key", (({ error: _e, ...r }) => r)(good)],
    ["warnings not array", { ...good, warnings: "x" }],
  ])("rejects malformed envelope: %s", (_n, body) => {
    expect(() => parseEnvelope(body)).toThrow(ApiError);
  });

  it("returns the envelope on success", async () => {
    const env = await getCapabilities(jsonResponse(good));
    expect(env.requestId).toBe("r1");
  });

  it("surfaces structured server errors with their code and request id", async () => {
    const body = { ...good, data: null, error: { code: "rate_limited", message: "slow down" } };
    await expect(getCapabilities(jsonResponse(body, 429))).rejects.toMatchObject({ code: "rate_limited", status: 429, requestId: "r1" });
  });

  it("maps network failure and non-JSON bodies to ApiError", async () => {
    await expect(getCapabilities((async () => { throw new TypeError("fail"); }) as typeof fetch)).rejects.toMatchObject({ code: "network_error" });
    await expect(getCapabilities((async () => new Response("<html>", { status: 502 })) as typeof fetch)).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });
});
