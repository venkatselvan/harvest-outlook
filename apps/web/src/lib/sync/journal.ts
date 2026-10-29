import { ApiError } from "../api";
import { createIdb } from "../idb";
import { getOwnerScope } from "../../features/offline/scope";
import { apiRequest, jsonInit, newEntryId } from "../../features/photo-region/http";
import { SyncQueue, type QueueItem, type SendResult, type Sender } from "./queue";

/** Sends one queued journal entry. Classification (network/5xx/429/401 retry; 409/422/other 4xx conflict) lives here. */
export const journalSender: Sender = async (item) => {
  try {
    const env = await apiRequest<{ entry: { id: string } }>("/api/v1/journal", jsonInit("POST", item.body, { "idempotency-key": item.idempotencyKey }));
    return { kind: "ok", entryId: env.data!.entry.id, entry: env.data!.entry };
  } catch (e) {
    if (!(e instanceof ApiError)) return { kind: "retry", status: 0, code: "network_error", message: "Could not reach the server" };
    return classify(e, item);
  }
};

export function classifyStatus(status: number): "retry" | "conflict" {
  return status === 0 || status >= 500 || status === 429 || status === 401 || status === 408 ? "retry" : "conflict";
}

async function classify(e: ApiError, item: QueueItem): Promise<SendResult> {
  if (classifyStatus(e.status) === "retry") return { kind: "retry", status: e.status, code: e.code, message: e.message };
  return { kind: "conflict", status: e.status, code: e.code, message: e.message, serverEntry: (await findServerEntry(item)) ?? undefined };
}

/** Best effort: the entry the server already holds for this clientEntryId, found in the farm timeline. */
async function findServerEntry(item: QueueItem): Promise<unknown | null> {
  try {
    const t = await apiRequest<{ entries: { clientEntryId?: string | null }[] }>(`/api/v1/farms/${encodeURIComponent(item.farmId)}/journal`);
    return t.data!.entries.find((x) => x.clientEntryId === item.clientEntryId) ?? null;
  } catch {
    return null;
  }
}

export const syncQueue = new SyncQueue(createIdb("harvest-sync"), () => getOwnerScope());

export type Flushed = (items: QueueItem[]) => void;
const flushedListeners = new Set<Flushed>();
/** Called after a flush pass in which entries reached the server (the journal page refreshes its timeline from this). */
export function onFlushed(fn: Flushed): () => void {
  flushedListeners.add(fn);
  return () => flushedListeners.delete(fn);
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Flushes now (cross-tab safe where Web Locks exist) and schedules the next attempt at the earliest backoff deadline. */
export async function flushJournalQueue(opts: { force?: boolean } = {}): Promise<QueueItem[]> {
  if (typeof navigator !== "undefined" && navigator.onLine === false && !opts.force) return [];
  const pass = async () => syncQueue.flush(journalSender, opts);
  let done: QueueItem[] = [];
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    done = locks ? ((await locks.request("ho-sync-flush", { ifAvailable: true }, async (lock) => (lock ? pass() : []))) as QueueItem[]) : await pass();
  } catch {
    /* storage failure: items stay where they are */
  }
  if (done.length) for (const fn of flushedListeners) fn(done);
  scheduleNext();
  return done;
}

function scheduleNext(): void {
  clearTimeout(timer);
  void syncQueue.nextDueAt().then((at) => {
    if (at === null) return;
    timer = setTimeout(() => void flushJournalQueue(), Math.max(500, at - Date.now()));
  });
}

export const newClientEntryId = (): string => newEntryId("entry");
