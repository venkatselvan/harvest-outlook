import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { clearSessionState } from "../../lib/session";
import { apiRequest } from "./http";

afterEach(() => clearSessionState());

const env = (data: unknown, status = 200) => new Response(JSON.stringify({ requestId: "r", mode: "synthetic", asOf: "x", data, warnings: [], error: null }), { status });
const err401 = () => new Response(JSON.stringify({ requestId: "r", mode: "synthetic", asOf: "x", data: null, warnings: [], error: { code: "unauthenticated", message: "no" } }), { status: 401 });
const session = (token: string) => new Response(JSON.stringify({ data: { authenticated: true, csrfToken: token } }), { status: 200 });

describe("apiRequest session handling", () => {
  it("bootstraps a session first and sends the CSRF header on state-changing calls", async () => {
    const seen: { url: string; csrf: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, csrf: new Headers(init?.headers).get("x-csrf-token") });
      return url.includes("/session") ? session("tok1") : env({ ok: 1 });
    }) as unknown as typeof fetch;
    await apiRequest("/api/v1/farms", { method: "POST", body: "{}" }, f);
    expect(seen.map((s) => s.url)).toEqual(["/api/v1/session", "/api/v1/farms"]);
    expect(seen[1]!.csrf).toBe("tok1");
  });
  it("on 401 mints a fresh session and retries exactly once", async () => {
    let tokens = 0;
    let farmCalls = 0;
    const f = (async (url: string, init?: RequestInit) => {
      if (url.includes("/session")) return session(`tok${++tokens}`);
      farmCalls++;
      return new Headers(init?.headers).get("x-csrf-token") === "tok2" ? env({ ok: 1 }) : err401();
    }) as unknown as typeof fetch;
    const r = await apiRequest("/api/v1/farms", { method: "POST", body: "{}" }, f);
    expect(r.data).toEqual({ ok: 1 });
    expect(farmCalls).toBe(2);
    expect(tokens).toBe(2);
  });
  it("does not loop when the retry is also rejected", async () => {
    let calls = 0;
    const f = (async (url: string) => {
      if (url.includes("/session")) return session("t");
      calls++;
      return err401();
    }) as unknown as typeof fetch;
    await expect(apiRequest("/api/v1/farms", undefined, f)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
  });
});
