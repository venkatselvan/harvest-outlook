import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { MemoryListableStore, createIdb } from "./idb";

describe("createIdb (IndexedDB)", () => {
  it("round-trips structured values and lists keys by prefix", async () => {
    const s = createIdb("t-roundtrip");
    expect(s.persistent).toBe(true);
    await s.set("q:a:1", { n: 1, nested: { x: [1, 2] } });
    await s.set("q:a:2", "two");
    await s.set("snap:a:1", 3);
    expect(await s.get("q:a:1")).toEqual({ n: 1, nested: { x: [1, 2] } });
    expect((await s.keys("q:a:")).sort()).toEqual(["q:a:1", "q:a:2"]);
    expect(await s.get("missing")).toBeUndefined();
    await s.delete("q:a:1");
    expect(await s.keys("q:")).toEqual(["q:a:2"]);
  });
  it("persists across store instances (reload) in the same database", async () => {
    await createIdb("t-persist").set("k", { draft: "kept" });
    expect(await createIdb("t-persist").get("k")).toEqual({ draft: "kept" });
    expect(await createIdb("t-other").get("k")).toBeUndefined();
  });
  it("memory fallback returns copies, not shared references", async () => {
    const m = new MemoryListableStore();
    const v = { a: 1 };
    await m.set("k", v);
    v.a = 2;
    expect(await m.get("k")).toEqual({ a: 1 });
  });
});
