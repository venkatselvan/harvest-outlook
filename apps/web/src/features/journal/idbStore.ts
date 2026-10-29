import { MemoryStore, type KeyValueStore } from "./model";

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

/**
 * Thin IndexedDB key-value wrapper for journal drafts (T15 extends this with sync). When IndexedDB is unavailable
 * (private mode, old browser) it falls back to memory, which keeps the form usable but loses the draft on reload.
 */
export function createIdbStore(name = "harvest-journal"): KeyValueStore & { persistent: boolean } {
  if (typeof indexedDB === "undefined") return Object.assign(new MemoryStore(), { persistent: false });
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= open(name));
  return {
    persistent: true,
    get: async (k) => run(await db(), "readonly", (s) => s.get(k)),
    set: async (k, v) => void (await run(await db(), "readwrite", (s) => s.put(v, k))),
    delete: async (k) => void (await run(await db(), "readwrite", (s) => s.delete(k))),
  };
}
