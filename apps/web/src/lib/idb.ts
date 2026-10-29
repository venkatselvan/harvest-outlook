import type { KeyValueStore } from "../features/journal/model";

/**
 * Shared tiny IndexedDB key-value helper (single object store "kv", schema version 1, the same layout the journal
 * drafts have always used so existing drafts stay readable). Falls back to memory when IndexedDB is unavailable
 * (private mode, old browsers, tests): the app keeps working but nothing survives a reload.
 */
export interface ListableStore extends KeyValueStore {
  /** Keys that start with `prefix` (all keys when omitted). */
  keys(prefix?: string): Promise<string[]>;
  /** False when this store is memory-only. */
  persistent: boolean;
}

const STORE = "kv";

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}

export class MemoryListableStore implements ListableStore {
  persistent = false;
  constructor(readonly map = new Map<string, unknown>()) {}
  async get(key: string) {
    const v = this.map.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  async set(key: string, value: unknown) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys(prefix = "") {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

export function createIdb(name: string): ListableStore {
  if (typeof indexedDB === "undefined") return new MemoryListableStore();
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= open(name).catch((e) => {
    dbp = null;
    throw e;
  }));
  return {
    persistent: true,
    get: async (k) => run(await db(), "readonly", (s) => s.get(k)),
    set: async (k, v) => void (await run(await db(), "readwrite", (s) => s.put(v, k))),
    delete: async (k) => void (await run(await db(), "readwrite", (s) => s.delete(k))),
    keys: async (prefix = "") => (await run(await db(), "readonly", (s) => s.getAllKeys())).map(String).filter((k) => k.startsWith(prefix)),
  };
}
