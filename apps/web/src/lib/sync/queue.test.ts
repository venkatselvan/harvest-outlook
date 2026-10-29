import { beforeEach, describe, expect, it } from "vitest";
import { MemoryListableStore } from "../idb";
import { SyncQueue, backoffMs, hashPayload, type QueueItem, type SendResult } from "./queue";

let now = 1_000_000;
let scope = "scope-a";
let store: MemoryListableStore;
let q: SyncQueue;
const body = (note: string) => ({ clientEntryId: "entry-0001", farmId: "farm-1", observedOn: "2026-10-01", note });
const input = (id = "entry-0001", note = "hello") => ({ clientEntryId: id, farmId: "farm-1", body: { ...body(note), clientEntryId: id } });
const ok = (id = "srv-1"): SendResult => ({ kind: "ok", entryId: id, entry: { id } });
const retry = (status = 0): SendResult => ({ kind: "retry", status, code: status ? "http_error" : "network_error", message: "down" });

beforeEach(async () => {
  now = 1_000_000;
  scope = "scope-a";
  store = new MemoryListableStore();
  q = new SyncQueue(store, () => scope, () => now);
  await q.list(); // runs (and records) the one-time legacy-scope sweep on the empty store
});

describe("backoff", () => {
  it("doubles from 2 s and caps at 5 minutes", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(30)).toBe(300_000);
  });
});

describe("enqueue", () => {
  it("writes the item before any send and is idempotent per clientEntryId", async () => {
    const a = await q.enqueue(input());
    expect(a.item.state).toBe("queued");
    expect(a.item.idempotencyKey).toBe("jrnl-entry-0001");
    const b = await q.enqueue(input());
    expect(b.deduped).toBe(true);
    expect(await q.list()).toHaveLength(1);
  });
  it("replaces the payload of an unsent item with changed content but never of one in conflict or done", async () => {
    await q.enqueue(input("entry-0001", "v1"));
    const r = await q.enqueue(input("entry-0001", "v2"));
    expect(r.deduped).toBe(false);
    expect((await q.get("entry-0001"))!.body.note).toBe("v2");
    await q.flush(async () => ({ kind: "conflict", status: 409, code: "conflict", message: "different content" }));
    const c = await q.enqueue(input("entry-0001", "v3"));
    expect(c.deduped).toBe(true);
    expect((await q.get("entry-0001"))!.body.note).toBe("v2");
  });
  it("hash ignores key order and differs on content", async () => {
    expect(await hashPayload({ a: 1, b: 2 })).toBe(await hashPayload({ b: 2, a: 1 }));
    expect(await hashPayload({ a: 1 })).not.toBe(await hashPayload({ a: 2 }));
  });
});

describe("flush", () => {
  it("sends once and marks done; a second flush does not resend", async () => {
    await q.enqueue(input());
    let calls = 0;
    const send = async () => (calls++, ok());
    const done = await q.flush(send);
    expect(done.map((d) => d.serverEntryId)).toEqual(["srv-1"]);
    await q.flush(send);
    expect(calls).toBe(1);
    expect((await q.get("entry-0001"))!.state).toBe("done");
    await q.acknowledge("entry-0001");
    expect(await q.list()).toHaveLength(0);
  });
  it("retries with exponential backoff and does not send before the deadline", async () => {
    await q.enqueue(input());
    let calls = 0;
    const send = async () => (calls++, retry());
    await q.flush(send);
    let it = (await q.get("entry-0001"))!;
    expect([it.state, it.attempts, it.nextAttemptAt - now]).toEqual(["queued", 1, 2000]);
    await q.flush(send); // too early
    expect(calls).toBe(1);
    now += 2000;
    await q.flush(send);
    it = (await q.get("entry-0001"))!;
    expect([calls, it.attempts, it.nextAttemptAt - now]).toEqual([2, 2, 4000]);
    expect(it.lastError?.code).toBe("network_error");
  });
  it("force ignores the deadline and the retry succeeds with the same idempotency key", async () => {
    await q.enqueue(input());
    const keys: string[] = [];
    await q.flush(async (i) => (keys.push(i.idempotencyKey), retry(503)));
    await q.flush(async (i) => (keys.push(i.idempotencyKey), ok()), { force: true });
    expect(keys).toEqual(["jrnl-entry-0001", "jrnl-entry-0001"]);
    expect((await q.get("entry-0001"))!.state).toBe("done");
  });
  it("stops the pass on a network failure so later items are not hammered", async () => {
    await q.enqueue(input("entry-0001"));
    now += 1;
    await q.enqueue(input("entry-0002"));
    const seen: string[] = [];
    await q.flush(async (i) => (seen.push(i.clientEntryId), retry()));
    expect(seen).toEqual(["entry-0001"]);
  });
  it("409 and 422 move to conflict with the server message and are not retried automatically", async () => {
    await q.enqueue(input());
    let calls = 0;
    await q.flush(async () => (calls++, { kind: "conflict", status: 409, code: "idempotency_conflict", message: "same id, different content", serverEntry: { id: "srv-9", note: "server" } }));
    const it = (await q.get("entry-0001"))!;
    expect(it.state).toBe("conflict");
    expect(it.conflict).toMatchObject({ status: 409, code: "idempotency_conflict", serverEntry: { id: "srv-9" } });
    now += 10 * 60_000;
    await q.flush(async () => (calls++, ok()));
    expect(calls).toBe(1);
  });
  it("recovers an item stuck in sending (page closed mid-request) and replays it", async () => {
    const { item } = await q.enqueue(input());
    await store.set(`q:scope-a:${item.clientEntryId}`, { ...item, state: "sending", attempts: 1 } satisfies QueueItem);
    const done = await q.flush(async () => ok());
    expect(done).toHaveLength(1);
    expect(done[0]!.attempts).toBe(2);
  });
  it("a send that throws is treated as a retryable failure, never lost", async () => {
    await q.enqueue(input());
    await q.flush(async () => {
      throw new Error("boom");
    });
    expect((await q.get("entry-0001"))!.state).toBe("queued");
  });
  it("concurrent flush calls share one pass (single send)", async () => {
    await q.enqueue(input());
    let calls = 0;
    const send = async () => (await Promise.resolve(), calls++, ok());
    await Promise.all([q.flush(send), q.flush(send)]);
    expect(calls).toBe(1);
  });
});

describe("conflict resolution", () => {
  const conflict = async () => {
    await q.enqueue(input());
    await q.flush(async () => ({ kind: "conflict", status: 422, code: "validation_error", message: "bad" }));
  };
  it("keep server removes the local copy", async () => {
    await conflict();
    await q.keepServer("entry-0001");
    expect(await q.list()).toHaveLength(0);
  });
  it("resubmit as new re-queues the same content under a fresh id and key", async () => {
    await conflict();
    const fresh = await q.resubmitAsNew("entry-0001", "entry-0002");
    expect(fresh).toMatchObject({ clientEntryId: "entry-0002", idempotencyKey: "jrnl-entry-0002", state: "queued", attempts: 0 });
    expect(fresh!.body).toMatchObject({ clientEntryId: "entry-0002", note: "hello" });
    expect((await q.list()).map((i) => i.clientEntryId)).toEqual(["entry-0002"]);
    expect(fresh!.payloadHash).not.toBe((await hashPayload(input().body)));
  });
  it("only items in conflict can be resolved", async () => {
    await q.enqueue(input());
    await q.keepServer("entry-0001");
    expect(await q.resubmitAsNew("entry-0001", "entry-0002")).toBeNull();
    expect(await q.list()).toHaveLength(1);
  });
});

describe("legacy scope migration (H1)", () => {
  it("moves items saved under older per-tab scopes to the current scope once, then sends them exactly once", async () => {
    const legacy = new MemoryListableStore();
    const old = new SyncQueue(legacy, () => "old-tab-scope", () => now);
    await old.list(); // (the old build had no marker; simulate by removing it)
    await legacy.delete("meta:legacy-scopes-swept-v2");
    await old.enqueue(input("entry-0001", "queued in an old tab"));
    await legacy.set("q:another-old-scope:entry-0002", { ...(await old.get("entry-0001"))!, clientEntryId: "entry-0002" });
    const fresh = new SyncQueue(legacy, () => "stable-scope", () => now);
    expect((await fresh.list()).map((i) => i.clientEntryId).sort()).toEqual(["entry-0001", "entry-0002"]);
    expect((await legacy.keys("q:")).every((k) => k.startsWith("q:stable-scope:"))).toBe(true);
    const sent: string[] = [];
    await fresh.flush(async (i) => (sent.push(i.clientEntryId), ok(`srv-${i.clientEntryId}`)));
    await fresh.flush(async (i) => (sent.push(i.clientEntryId), ok()));
    expect(sent.sort()).toEqual(["entry-0001", "entry-0002"]);
  });
  it("does not adopt another scope's items after the sweep has been recorded", async () => {
    await q.enqueue(input("entry-0009"));
    const other = new SyncQueue(store, () => "scope-z", () => now);
    expect(await other.list()).toHaveLength(0);
  });
});

describe("isolation and logout", () => {
  it("never lists or sends another owner scope's items", async () => {
    await q.enqueue(input("entry-0001"));
    scope = "scope-b";
    expect(await q.list()).toHaveLength(0);
    const sent: string[] = [];
    await q.flush(async (i) => (sent.push(i.clientEntryId), ok()));
    expect(sent).toEqual([]);
    scope = "scope-a";
    expect(await q.list()).toHaveLength(1);
  });
  it("clearAll removes every scope and survives a reload of the queue object", async () => {
    await q.enqueue(input("entry-0001"));
    scope = "scope-b";
    await q.enqueue(input("entry-0002"));
    const reloaded = new SyncQueue(store, () => "scope-b", () => now);
    expect(await reloaded.list()).toHaveLength(1); // drafts survive reload
    await reloaded.clearAll();
    expect(await store.keys("q:")).toEqual([]);
  });
});
