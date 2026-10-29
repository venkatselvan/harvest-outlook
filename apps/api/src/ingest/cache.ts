import type { Pool } from "../db/pool";

export interface CacheEntry {
  key: string;
  provider: string;
  fetchedAt: Date;
  expiresAt: Date;
  payload: unknown;
}

/** Provider response cache. Only successful responses are stored; entries keep their original fetch time. */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  put(entry: CacheEntry): Promise<void>;
}

export function memoryCache(): CacheStore & { entries: Map<string, CacheEntry> } {
  const entries = new Map<string, CacheEntry>();
  return {
    entries,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(e) {
      entries.set(e.key, e);
    },
  };
}

export function pgCache(pool: Pool): CacheStore {
  return {
    async get(key) {
      const r = await pool.query<{ key: string; provider: string; fetched_at: Date; expires_at: Date; payload: unknown }>(
        "SELECT key, provider, fetched_at, expires_at, payload FROM provider_cache WHERE key=$1 AND status='ok'",
        [key],
      );
      const row = r.rows[0];
      return row ? { key: row.key, provider: row.provider, fetchedAt: row.fetched_at, expiresAt: row.expires_at, payload: row.payload } : null;
    },
    async put(e) {
      await pool.query(
        `INSERT INTO provider_cache (key, provider, fetched_at, expires_at, payload, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,'ok')
         ON CONFLICT (key) DO UPDATE SET provider=EXCLUDED.provider, fetched_at=EXCLUDED.fetched_at,
           expires_at=EXCLUDED.expires_at, payload=EXCLUDED.payload, status='ok'`,
        [e.key, e.provider, e.fetchedAt, e.expiresAt, JSON.stringify(e.payload)],
      );
    },
  };
}
