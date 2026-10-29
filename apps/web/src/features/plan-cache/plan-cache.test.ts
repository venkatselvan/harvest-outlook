import { describe, expect, it } from "vitest";
import { MemoryListableStore } from "../../lib/idb";
import { createCachingFetch, resourceFor } from "./fetch";
import { relativeTime, staleLabelText } from "./freshness";
import { SnapshotStore, StaleRegistry } from "./store";

describe("freshness labels", () => {
  const t0 = 1_000_000_000;
  it("formats relative time without inventing precision", () => {
    expect(relativeTime(t0, t0 + 20_000)).toBe("just now");
    expect(relativeTime(t0, t0 + 60_000)).toBe("1 minute ago");
    expect(relativeTime(t0, t0 + 5 * 60_000)).toBe("5 minutes ago");
    expect(relativeTime(t0, t0 + 3 * 3600_000)).toBe("3 hours ago");
    expect(relativeTime(t0, t0 + 72 * 3600_000)).toBe("3 days ago");
    expect(relativeTime(t0, t0 - 5000)).toBe("just now");
  });
  it("labels offline versus server-unavailable", () => {
    expect(staleLabelText(t0, t0 + 300_000, false)).toBe("Saved 5 minutes ago · offline");
    expect(staleLabelText(t0, t0 + 300_000, true)).toBe("Saved 5 minutes ago · server unavailable");
    expect(staleLabelText(null, t0, false)).toBe("Saved at an unknown time · offline");
  });
});

describe("resourceFor", () => {
  const r = (m: string, p: string) => resourceFor(m, new URL(p, "http://x"));
  it("caches reads of plans, farms and journal only", () => {
    expect(r("GET", "/api/v1/plans/p1")?.resourceKey).toBe("plan:p1");
    expect(r("GET", "/api/v1/plans/p1/timeline?scenarioId=late")?.resourceKey).toBe("plan:p1");
    expect(r("GET", "/api/v1/farms")).not.toBeNull();
    expect(r("GET", "/api/v1/farms/f1/journal")).not.toBeNull();
    for (const p of ["/api/v1/media/m1/content", "/api/v1/assistant/x", "/api/v1/speech/tts", "/api/v1/jobs/j1", "/api/v1/crops", "/api/v1/session"]) expect(r("GET", p)).toBeNull();
    expect(r("POST", "/api/v1/plans")).toBeNull();
    expect(r("POST", "/api/v1/plans/p1/visuals")).toBeNull();
  });
});

const env = (data: unknown) => ({ requestId: "r", mode: "synthetic", asOf: "2026-10-01T00:00:00Z", data, warnings: [], error: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup() {
  let t = 5_000_000;
  let scope = "s1";
  const store = new MemoryListableStore();
  const snapshots = new SnapshotStore(store, () => scope);
  const stale = new StaleRegistry();
  let net: (u: string, init?: RequestInit) => Promise<Response> = async () => json(env({ plan: 1 }));
  const calls: string[] = [];
  const deleted: string[] = [];
  const f = createCachingFetch({
    base: (async (i: RequestInfo | URL, init?: RequestInit) => (calls.push(`${init?.method ?? "GET"} ${String(i)}`), net(String(i), init))) as typeof fetch,
    snapshots,
    stale,
    now: () => t,
    onWorkspaceDeleted: (w) => deleted.push(w),
  });
  return { f, store, snapshots, stale, calls, deleted, setNet: (n: typeof net) => (net = n), tick: (ms: number) => (t += ms), setScope: (s: string) => (scope = s) };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("caching fetch", () => {
  it("serves the saved plan with a warning and marks it stale when the network is down", async () => {
    const x = setup();
    await x.f("/api/v1/plans/p1");
    await x.f("/api/v1/plans/p1/timeline?scenarioId=early");
    await settle();
    x.tick(5 * 60_000);
    x.setNet(async () => {
      throw new TypeError("offline");
    });
    const res = await x.f("/api/v1/plans/p1");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ plan: 1 });
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain("offline_snapshot");
    expect(res.headers.get("x-ho-stale-at")).toBe(new Date(5_000_000).toISOString());
    expect(x.stale.get("plan:p1")).toBe(5_000_000);
    expect((await (await x.f("/api/v1/plans/p1/timeline?scenarioId=early")).json()).data).toBeTruthy();
  });
  it("falls back on 5xx but returns real 4xx answers untouched", async () => {
    const x = setup();
    await x.f("/api/v1/plans/p1");
    await settle();
    x.setNet(async () => json({ ...env(null), error: { code: "boom", message: "x" } }, 503));
    expect((await (await x.f("/api/v1/plans/p1")).json()).data).toEqual({ plan: 1 });
    x.setNet(async () => json({ ...env(null), error: { code: "not_found", message: "x" } }, 404));
    expect((await x.f("/api/v1/plans/p1")).status).toBe(404);
  });
  it("throws the network error when nothing is saved, and never answers writes from the cache", async () => {
    const x = setup();
    x.setNet(async () => {
      throw new TypeError("offline");
    });
    await expect(x.f("/api/v1/plans/never-seen")).rejects.toThrow();
    x.setNet(async () => json(env({ ok: 1 })));
    await x.f("/api/v1/plans/p1");
    await settle();
    x.setNet(async () => {
      throw new TypeError("offline");
    });
    await expect(x.f("/api/v1/plans/p1/visuals", { method: "POST" })).rejects.toThrow();
  });
  it("live data clears the stale mark; snapshots are isolated per owner scope", async () => {
    const x = setup();
    await x.f("/api/v1/plans/p1");
    await settle();
    x.setNet(async () => {
      throw new TypeError("offline");
    });
    await x.f("/api/v1/plans/p1");
    expect(x.stale.keys()).toEqual(["plan:p1"]);
    x.setScope("s2");
    await expect(x.f("/api/v1/plans/p1")).rejects.toThrow(); // other session sees nothing
    x.setScope("s1");
    x.setNet(async () => json(env({ plan: 2 })));
    await x.f("/api/v1/plans/p1");
    expect(x.stale.keys()).toEqual([]);
  });
  it("reports workspace deletion only after a successful DELETE /session or /farms/:id", async () => {
    const x = setup();
    x.setNet(async () => json(env({}), 500));
    await x.f("/api/v1/session", { method: "DELETE" });
    expect(x.deleted).toEqual([]);
    x.setNet(async () => json(env({})));
    await x.f("/api/v1/session", { method: "DELETE" });
    await x.f("/api/v1/farms/f1", { method: "DELETE" });
    expect(x.deleted).toEqual(["session", "farm"]);
  });
  it("clearAll wipes snapshots of all scopes", async () => {
    const x = setup();
    await x.f("/api/v1/plans/p1");
    await settle();
    await x.snapshots.clearAll();
    expect(await x.store.keys("snap:")).toEqual([]);
  });
});
