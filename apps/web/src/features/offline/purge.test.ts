import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdb } from "../../lib/idb";
import { clearSessionState, ensureSession, endSession } from "../../lib/session";
import { syncQueue } from "../../lib/sync/journal";
import { saveDraft, newDraft, scopedStore } from "../journal/model";
import { getOwnerScope } from "./scope";
import { installPurgeListeners, purgeLocalData } from "./purge";
import { snapshots } from "./status";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), get size() { return m.size; }, keys: () => [...m.keys()] };
};
let local: ReturnType<typeof mem>;
let session: ReturnType<typeof mem>;
let win: EventTarget;
let off: () => void;

beforeEach(() => {
  local = mem();
  session = mem();
  win = new EventTarget();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", win);
  off = installPurgeListeners(win);
  clearSessionState();
});
afterEach(() => {
  off();
  vi.unstubAllGlobals();
});

const sessionFetch = (opts: { authenticatedOnGet: boolean; deleteOk?: boolean }) =>
  (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (method === "DELETE") return new Response("{}", { status: opts.deleteOk === false ? 500 : 200 });
    if (method === "GET") return body(opts.authenticatedOnGet ? { authenticated: true, csrfToken: "c1" } : { authenticated: false });
    return body({ authenticated: true, csrfToken: "c2" });
  }) as unknown as typeof fetch;

async function seedDevice() {
  const journal = scopedStore(createIdb("harvest-journal"), () => getOwnerScope());
  await saveDraft(journal, newDraft("farm-1", "entry-12345678"));
  await syncQueue.enqueue({ clientEntryId: "entry-queued-1", farmId: "farm-1", body: { note: "x" } });
  await snapshots.save("plan:p1", "/api/v1/plans/p1", { data: { id: "p1" } }, 1);
  local.setItem("ho.exploreProfile.v1", "{}");
  local.setItem("ho.selectedFarm", "farm-1");
  session.setItem("ho.selectedCrop", "ginger");
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("purge after the workspace ends (M2)", () => {
  it("DELETE /session leaves no drafts, queue items, snapshots, profile or selection keys, and rotates the scope", async () => {
    await seedDevice();
    const before = getOwnerScope();
    expect(await createIdb("harvest-journal").keys()).not.toEqual([]);
    await endSession(sessionFetch({ authenticatedOnGet: true }));
    await settle();
    const drafts = await createIdb("harvest-journal").keys();
    expect(drafts.filter((k) => k.includes("draft:") || k.includes("current:"))).toEqual([]);
    expect(await createIdb("harvest-sync").keys("q:")).toEqual([]);
    expect(await snapshots.load("plan:p1")).toBeNull();
    expect(local.getItem("ho.exploreProfile.v1")).toBeNull();
    expect(local.getItem("ho.selectedFarm")).toBeNull();
    expect(session.getItem("ho.selectedCrop")).toBeNull();
    expect(getOwnerScope()).not.toBe(before);
  });
  it("a failed DELETE purges nothing", async () => {
    await seedDevice();
    await endSession(sessionFetch({ authenticatedOnGet: true, deleteOk: false }));
    await settle();
    expect(local.getItem("ho.selectedFarm")).toBe("farm-1");
    expect(await createIdb("harvest-sync").keys("q:")).not.toEqual([]);
  });
  it("ho:farm-deleted purges too", async () => {
    await seedDevice();
    win.dispatchEvent(new CustomEvent("ho:farm-deleted"));
    await settle();
    expect(local.getItem("ho.selectedFarm")).toBeNull();
  });
  it("a session check that finds no session for a device that had one is a new identity: local data is purged", async () => {
    await ensureSession(sessionFetch({ authenticatedOnGet: true })); // marks "a session was known"
    clearSessionState();
    await seedDevice();
    await ensureSession(sessionFetch({ authenticatedOnGet: false }));
    await settle();
    expect(local.getItem("ho.selectedFarm")).toBeNull();
    expect(await createIdb("harvest-sync").keys("q:")).toEqual([]);
  });
  it("an unreachable server is not an identity change", async () => {
    await ensureSession(sessionFetch({ authenticatedOnGet: true }));
    clearSessionState();
    await seedDevice();
    await ensureSession((async () => new Response("x", { status: 503 })) as unknown as typeof fetch);
    await settle();
    expect(local.getItem("ho.selectedFarm")).toBe("farm-1");
  });
  it("purgeLocalData itself is safe to call twice", async () => {
    await seedDevice();
    await purgeLocalData();
    await purgeLocalData();
    expect(local.getItem("ho.selectedFarm")).toBeNull();
  });
});
