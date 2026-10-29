import type { ListableStore } from "../../lib/idb";

/**
 * On-device snapshots of GET responses, keyed by (ownerScope, resourceKey). For a plan the resourceKey is `plan:<planId>`
 * and one record holds every response the plan page fetched ({plan, timeline per scenario, visuals metadata, ...});
 * other readable resources (farm, journal timeline) are one record each. Only successful, enveloped responses are kept.
 */
export interface CachedResponse {
  fetchedAt: number;
  envelope: unknown;
}
export interface Snapshot {
  resourceKey: string;
  fetchedAt: number;
  responses: Record<string, CachedResponse>;
}

const PREFIX = "snap:";
const MAX_SNAPSHOTS_PER_SCOPE = 40;

const dbKey = (scope: string, resourceKey: string) => `${PREFIX}${scope}:${resourceKey}`;

export class SnapshotStore {
  constructor(
    private readonly store: ListableStore,
    private readonly scope: () => string,
  ) {}

  async save(resourceKey: string, path: string, envelope: unknown, now: number): Promise<void> {
    const key = dbKey(this.scope(), resourceKey);
    const prev = (await this.store.get(key)) as Snapshot | undefined;
    const snap: Snapshot = { resourceKey, fetchedAt: now, responses: { ...(prev?.responses ?? {}), [path]: { fetchedAt: now, envelope } } };
    await this.store.set(key, snap);
    await this.evict();
  }

  async load(resourceKey: string): Promise<Snapshot | null> {
    const s = (await this.store.get(dbKey(this.scope(), resourceKey))) as Snapshot | undefined;
    return s && typeof s.fetchedAt === "number" && s.responses ? s : null;
  }

  async loadResponse(resourceKey: string, path: string): Promise<CachedResponse | null> {
    return (await this.load(resourceKey))?.responses[path] ?? null;
  }

  /** Forget the freshly fetched copy of one path set, e.g. nothing: kept for the plan page "refresh" semantic. */
  async remove(resourceKey: string): Promise<void> {
    await this.store.delete(dbKey(this.scope(), resourceKey));
  }

  /** Drop every snapshot of every scope (logout, farm deletion). */
  async clearAll(): Promise<void> {
    for (const k of await this.store.keys(PREFIX)) await this.store.delete(k);
  }

  private async evict(): Promise<void> {
    const keys = await this.store.keys(`${PREFIX}${this.scope()}:`);
    if (keys.length <= MAX_SNAPSHOTS_PER_SCOPE) return;
    const all = await Promise.all(keys.map(async (k) => ({ k, at: ((await this.store.get(k)) as Snapshot | undefined)?.fetchedAt ?? 0 })));
    all.sort((a, b) => a.at - b.at);
    for (const old of all.slice(0, keys.length - MAX_SNAPSHOTS_PER_SCOPE)) await this.store.delete(old.k);
  }
}

/** Registry of resources currently shown from a snapshot (resourceKey -> fetchedAt). Cleared per key when live data returns. */
export class StaleRegistry {
  private map = new Map<string, number>();
  private listeners = new Set<() => void>();
  mark(key: string, fetchedAt: number): void {
    this.map.set(key, fetchedAt);
    this.emit();
  }
  clear(key: string): void {
    if (this.map.delete(key)) this.emit();
  }
  clearAll(): void {
    if (this.map.size) {
      this.map.clear();
      this.emit();
    }
  }
  get(key: string): number | undefined {
    return this.map.get(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
}
