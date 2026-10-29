import { SnapshotStore, StaleRegistry } from "./store";
import { relativeTime } from "./freshness";

/**
 * A fetch wrapper that gives the existing screens read-through offline behaviour without changing them:
 *  - successful GETs of plans, farms and the journal timeline are saved on the device (IndexedDB, per owner scope);
 *  - when such a GET cannot be answered (network down, or 5xx) the saved copy is returned instead, flagged with an
 *    `offline_snapshot` warning in the envelope and an `x-ho-stale-at` header, and the resource is marked stale;
 *  - writes are never answered from the cache, and nothing else (media, speech, assistant, jobs) is cached here.
 */
export function resourceFor(method: string, url: URL): { resourceKey: string; path: string } | null {
  if (method !== "GET") return null;
  const path = url.pathname + url.search;
  const plan = /^\/api\/v1\/plans\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (plan) return { resourceKey: `plan:${decodeURIComponent(plan[1]!)}`, path };
  if (/^\/api\/v1\/farms(\/[^/]+(\/(journal|media|plans))?)?$/.test(url.pathname)) return { resourceKey: `res:${path}`, path };
  return null;
}

export interface CachingFetchDeps {
  base: typeof fetch;
  snapshots: SnapshotStore;
  stale: StaleRegistry;
  now?: () => number;
  /** Called after a successful DELETE /session or DELETE /farms/:id so local data of the workspace can be purged. */
  onWorkspaceDeleted?: (what: "session" | "farm") => void;
  isOnline?: () => boolean;
}

export function createCachingFetch(deps: CachingFetchDeps): typeof fetch {
  const now = deps.now ?? Date.now;
  return async (input, init) => {
    const req = input instanceof Request ? input : null;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    let url: URL | null = null;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://local.invalid");
    } catch {
      url = null;
    }
    const res = url && method === "DELETE" ? await deps.base(input, init) : null;
    if (res && url) {
      if (res.ok && url.pathname === "/api/v1/session") deps.onWorkspaceDeleted?.("session");
      else if (res.ok && /^\/api\/v1\/farms\/[^/]+$/.test(url.pathname)) deps.onWorkspaceDeleted?.("farm");
      return res;
    }
    const target = url ? resourceFor(method, url) : null;
    if (!target) return deps.base(input, init);

    let live: Response | null = null;
    try {
      live = await deps.base(input, init);
    } catch {
      live = null;
    }
    if (live && live.ok) {
      try {
        const envelope = await live.clone().json();
        if (envelope && typeof envelope === "object" && (envelope as { data?: unknown }).data != null && !(envelope as { error?: unknown }).error) {
          deps.stale.clear(target.resourceKey);
          void deps.snapshots.save(target.resourceKey, target.path, envelope, now()).catch(() => undefined);
        }
      } catch {
        /* not JSON: pass through untouched */
      }
      return live;
    }
    // Only fall back for "unreachable" outcomes; 4xx (not found, forbidden, invalid) are real answers.
    if (live && live.status < 500) return live;
    const cached = await deps.snapshots.loadResponse(target.resourceKey, target.path).catch(() => null);
    if (!cached) {
      if (live) return live;
      throw new TypeError("Failed to fetch");
    }
    deps.stale.mark(target.resourceKey, cached.fetchedAt);
    const env = cached.envelope as { warnings?: { code: string; message: string }[] };
    const warnings = [...(env.warnings ?? []), { code: "offline_snapshot", message: `Shown from a copy saved on this device ${relativeTime(cached.fetchedAt, now())}; live data is unavailable.` }];
    return new Response(JSON.stringify({ ...env, warnings }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ho-stale-at": new Date(cached.fetchedAt).toISOString() },
    });
  };
}
