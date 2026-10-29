import { afterEach, describe, expect, it } from "vitest";
import { clearSessionState, csrfHeaders, ensureSession } from "./session";

const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

afterEach(() => clearSessionState());

describe("session bootstrap", () => {
  it("reuses an existing session (GET only), keeps the token in memory, and attaches it to unsafe methods only", async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return reply({ authenticated: true, csrfToken: "tok" });
    }) as unknown as typeof fetch;
    expect(await ensureSession(f)).toBe(true);
    expect(await ensureSession(f)).toBe(true);
    expect(calls).toEqual(["GET"]);
    expect(csrfHeaders("POST")).toEqual({ "x-csrf-token": "tok" });
    expect(csrfHeaders("delete")).toEqual({ "x-csrf-token": "tok" });
    expect(csrfHeaders("GET")).toEqual({});
    expect(csrfHeaders()).toEqual({});
  });

  it("creates a session when none exists, once for concurrent callers", async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init?: RequestInit) => {
      const m = init?.method ?? "GET";
      calls.push(m);
      return m === "GET" ? reply({ authenticated: false }) : reply({ authenticated: true, csrfToken: "new" }, 201);
    }) as unknown as typeof fetch;
    expect(await Promise.all([ensureSession(f), ensureSession(f)])).toEqual([true, true]);
    expect(calls).toEqual(["GET", "POST"]);
    expect(csrfHeaders("PUT")).toEqual({ "x-csrf-token": "new" });
  });

  it("reports failure without a token when the server refuses", async () => {
    const f = (async () => reply(null, 429)) as unknown as typeof fetch;
    expect(await ensureSession(f)).toBe(false);
    expect(csrfHeaders("POST")).toEqual({});
  });
});
