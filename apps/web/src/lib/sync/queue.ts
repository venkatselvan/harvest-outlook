import type { ListableStore } from "../idb";

/**
 * Durable sync queue for journal submissions. Each entry is written here BEFORE any network call, keyed by owner scope
 * and clientEntryId (which is also the basis of the Idempotency-Key), so a reload, a crash mid-send or a dropped
 * connection never loses it and a replay never creates a second server entry (the server answers a repeat with the
 * saved entry; the same id with different content is a 409, which we surface as a conflict for the user to resolve).
 *
 * State machine: queued -> sending -> done | queued (retry with backoff) | conflict.
 * conflict -> (keep server) removed | (resubmit as new) queued under a fresh clientEntryId.
 */
export type SyncState = "queued" | "sending" | "conflict" | "done";

export interface QueueItem {
  clientEntryId: string;
  idempotencyKey: string;
  farmId: string;
  /** Request body for POST /api/v1/journal, built when the user pressed Save. */
  body: Record<string, unknown>;
  payloadHash: string;
  createdAt: number;
  attempts: number;
  state: SyncState;
  nextAttemptAt: number;
  lastError: { code: string; message: string; status: number } | null;
  /** Present in state "conflict": what the server said (and the saved server entry when it could be fetched). */
  conflict: { status: number; code: string; message: string; serverEntry: unknown | null } | null;
  /** Set in state "done". */
  serverEntryId: string | null;
  serverEntry?: unknown;
}

export type SendResult =
  | { kind: "ok"; entryId: string; entry?: unknown }
  | { kind: "conflict"; status: number; code: string; message: string; serverEntry?: unknown }
  | { kind: "retry"; status: number; code: string; message: string };

export type Sender = (item: QueueItem) => Promise<SendResult>;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Exponential backoff for the nth failed attempt (1-based): 2 s, 4 s, 8 s ... capped at 5 min. No jitter, so it is testable. */
export function backoffMs(attempts: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

export async function hashPayload(body: unknown): Promise<string> {
  const text = stableStringify(body);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5; // FNV-1a fallback for insecure contexts
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `fnv-${(h >>> 0).toString(16)}`;
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const PREFIX = "q:";
const SWEPT_MARKER = "meta:legacy-scopes-swept-v2";

export interface EnqueueInput {
  clientEntryId: string;
  farmId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}

export class SyncQueue {
  private listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly store: ListableStore,
    private readonly scope: () => string,
    private readonly clock: () => number = Date.now,
  ) {}

  private key(id: string, scope = this.scope()): string {
    return `${PREFIX}${scope}:${id}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private swept: Promise<void> | null = null;

  /**
   * One-time migration (per device, recorded by a marker): items stored under any other scope (an older build kept the
   * scope per tab, so a reopened app could not see them) are moved to the current scope, so nothing is orphaned.
   */
  private sweepLegacy(): Promise<void> {
    this.swept ??= (async () => {
      if ((await this.store.get(SWEPT_MARKER)) !== undefined) return;
      const mine = `${PREFIX}${this.scope()}:`;
      for (const k of await this.store.keys(PREFIX)) {
        if (k.startsWith(mine)) continue;
        const item = (await this.store.get(k)) as QueueItem | undefined;
        if (item && typeof item.clientEntryId === "string") {
          const target = this.key(item.clientEntryId);
          if ((await this.store.get(target)) === undefined) await this.store.set(target, item);
        }
        await this.store.delete(k);
      }
      // Written last and only once per device: later scopes are real, separate workspaces and must stay isolated.
      await this.store.set(SWEPT_MARKER, Date.now());
    })().catch(() => {
      this.swept = null;
    });
    return this.swept;
  }

  /** Items for the current owner scope (after the one-time legacy sweep), oldest first. */
  async list(): Promise<QueueItem[]> {
    await this.sweepLegacy();
    const keys = await this.store.keys(`${PREFIX}${this.scope()}:`);
    const items = await Promise.all(keys.map((k) => this.store.get(k) as Promise<QueueItem | undefined>));
    return items.filter((i): i is QueueItem => !!i && typeof i.clientEntryId === "string").sort((a, b) => a.createdAt - b.createdAt || a.clientEntryId.localeCompare(b.clientEntryId));
  }

  async get(id: string): Promise<QueueItem | undefined> {
    return (await this.store.get(this.key(id))) as QueueItem | undefined;
  }

  private async put(item: QueueItem): Promise<void> {
    await this.store.set(this.key(item.clientEntryId), item);
  }

  /**
   * Writes the submission to the queue. Same clientEntryId: an identical payload is a no-op (dedupe); a changed payload
   * replaces it only while nothing has been sent (queued or conflict-resolved), otherwise the stored item wins.
   */
  async enqueue(input: EnqueueInput): Promise<{ item: QueueItem; deduped: boolean }> {
    const payloadHash = await hashPayload(input.body);
    const existing = await this.get(input.clientEntryId);
    if (existing) {
      if (existing.payloadHash === payloadHash || existing.state !== "queued") return { item: existing, deduped: true };
      const replaced: QueueItem = { ...existing, body: input.body, payloadHash, nextAttemptAt: this.clock(), attempts: 0, lastError: null };
      await this.put(replaced);
      this.emit();
      return { item: replaced, deduped: false };
    }
    const now = this.clock();
    const item: QueueItem = {
      clientEntryId: input.clientEntryId,
      idempotencyKey: input.idempotencyKey ?? `jrnl-${input.clientEntryId}`.slice(0, 128),
      farmId: input.farmId,
      body: input.body,
      payloadHash,
      createdAt: now,
      attempts: 0,
      state: "queued",
      nextAttemptAt: now,
      lastError: null,
      conflict: null,
      serverEntryId: null,
    };
    await this.put(item);
    this.emit();
    return { item, deduped: false };
  }

  /**
   * One flush pass (single-flight in this tab; across tabs the caller wraps it in a Web Lock). Items stuck in "sending"
   * from an interrupted page are recovered to "queued" first: replay is safe because the Idempotency-Key is unchanged.
   * Returns the items that reached "done" in this pass.
   */
  flush(send: Sender, opts: { force?: boolean } = {}): Promise<QueueItem[]> {
    const done: QueueItem[] = [];
    this.flushing ??= this.run(send, opts, done).finally(() => {
      this.flushing = null;
    });
    return this.flushing.then(() => done);
  }

  private async run(send: Sender, opts: { force?: boolean }, done: QueueItem[]): Promise<void> {
    const items = await this.list();
    for (let item of items) {
      if (item.state === "sending") item = { ...item, state: "queued" };
      if (item.state !== "queued") continue;
      if (!opts.force && item.nextAttemptAt > this.clock()) continue;
      item = { ...item, state: "sending", attempts: item.attempts + 1 };
      await this.put(item);
      this.emit();
      let result: SendResult;
      try {
        result = await send(item);
      } catch (e) {
        result = { kind: "retry", status: 0, code: "network_error", message: e instanceof Error ? e.message : "Could not reach the server" };
      }
      if (result.kind === "ok") {
        item = { ...item, state: "done", lastError: null, conflict: null, serverEntryId: result.entryId, serverEntry: result.entry };
        done.push(item);
      } else if (result.kind === "conflict") {
        item = { ...item, state: "conflict", lastError: { code: result.code, message: result.message, status: result.status }, conflict: { status: result.status, code: result.code, message: result.message, serverEntry: result.serverEntry ?? null } };
      } else {
        item = { ...item, state: "queued", nextAttemptAt: this.clock() + backoffMs(item.attempts), lastError: { code: result.code, message: result.message, status: result.status } };
        await this.put(item);
        this.emit();
        // Offline or the server is down: later items would fail the same way, so stop this pass.
        if (result.status === 0 || result.status >= 500 || result.status === 429 || result.status === 401) break;
        continue;
      }
      await this.put(item);
      this.emit();
    }
  }

  /** Earliest time a queued item is due, or null when none is waiting. */
  async nextDueAt(): Promise<number | null> {
    const due = (await this.list()).filter((i) => i.state === "queued").map((i) => i.nextAttemptAt);
    return due.length ? Math.min(...due) : null;
  }

  /** Conflict choice 1: keep what the server has and drop the local copy. */
  async keepServer(id: string): Promise<void> {
    const item = await this.get(id);
    if (!item || item.state !== "conflict") return;
    await this.store.delete(this.key(id));
    this.emit();
  }

  /** Conflict choice 2: resubmit the local content as a brand-new entry under a fresh clientEntryId. */
  async resubmitAsNew(id: string, newId: string): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item || item.state !== "conflict") return null;
    const body = { ...item.body, clientEntryId: newId };
    const fresh: QueueItem = {
      ...item,
      clientEntryId: newId,
      idempotencyKey: `jrnl-${newId}`.slice(0, 128),
      body,
      payloadHash: await hashPayload(body),
      attempts: 0,
      state: "queued",
      nextAttemptAt: this.clock(),
      lastError: null,
      conflict: null,
      createdAt: this.clock(),
    };
    await this.store.delete(this.key(id));
    await this.put(fresh);
    this.emit();
    return fresh;
  }

  /** Remove a finished item once the UI has shown it. */
  async acknowledge(id: string): Promise<void> {
    const item = await this.get(id);
    if (item?.state === "done") {
      await this.store.delete(this.key(id));
      this.emit();
    }
  }

  /** Deletes every queued item of every scope (logout / farm deletion: the data belongs to a workspace that is gone). */
  async clearAll(): Promise<void> {
    this.swept = null;
    for (const k of await this.store.keys(PREFIX)) await this.store.delete(k);
    this.emit();
  }
}
