import { describe, expect, it } from "vitest";
import { MetaClient } from "../src/providers/meta/client";

/** L5: `store` request parameter and DELETE /v1/responses/{id}. Synthetic fetch only; no network. */
const KEY = "sk-synthetic-l5";
function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { c: new MetaClient({ apiKey: KEY, baseUrl: "https://api.example.test/v1/", fetchImpl, sleep: async () => undefined }), calls };
}

describe("MetaClient store and deleteResponse (L5)", () => {
  it("sends store only when set", () => {
    const { c } = client(() => new Response("{}"));
    const base = { model: "m", instructions: "i", input: "x", maxOutputTokens: 10 };
    expect(c.buildBody(base)).not.toHaveProperty("store");
    expect(c.buildBody({ ...base, store: false }).store).toBe(false);
    expect(c.buildBody({ ...base, store: true }).store).toBe(true);
  });
  it("DELETE /responses/{id} with the bearer key; 200 deleted, 404 already absent, 500 failure, network error", async () => {
    const { c, calls } = client((url) => {
      if (url.endsWith("/resp_ok")) return new Response(JSON.stringify({ object: "response.deleted", deleted: true }), { status: 200 });
      if (url.endsWith("/resp_gone")) return new Response("{}", { status: 404 });
      if (url.endsWith("/resp_err")) return new Response("{}", { status: 500 });
      throw new TypeError("network down");
    });
    expect(await c.deleteResponse("resp_ok")).toEqual({ ok: true, status: 200, code: null });
    expect(calls[0]!.url).toBe("https://api.example.test/v1/responses/resp_ok");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(await c.deleteResponse("resp_gone")).toEqual({ ok: true, status: 404, code: "already_absent" });
    expect(await c.deleteResponse("resp_err")).toEqual({ ok: false, status: 500, code: "http_500" });
    expect(await c.deleteResponse("resp_net")).toEqual({ ok: false, status: null, code: "network" });
    expect(calls).toHaveLength(4); // never retried
    expect(await c.deleteResponse("../files/x")).toEqual({ ok: false, status: null, code: "invalid_id" });
    expect(calls).toHaveLength(4);
  });
  it("without a key nothing is sent", async () => {
    const calls: unknown[] = [];
    const c = new MetaClient({ apiKey: "", baseUrl: "https://api.example.test/v1", fetchImpl: (async (...a: unknown[]) => { calls.push(a); return new Response("{}"); }) as unknown as typeof fetch });
    expect(await c.deleteResponse("resp_1")).toEqual({ ok: false, status: null, code: "provider_unavailable" });
    expect(calls).toHaveLength(0);
  });
});
