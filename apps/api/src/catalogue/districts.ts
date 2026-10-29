import { readCatalogueFiles } from "./files";

interface Registry {
  states: Set<string>;
  byId: Map<string, { id: string; stateId: string; name: string }>;
  /** state id -> normalised name -> district id (null when two districts normalise identically). */
  byState: Map<string, Map<string, string | null>>;
}

let cached: Registry | null = null;

/** Case/diacritic/punctuation-insensitive key, e.g. "  Hássan " -> "hassan". */
export function normaliseName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function registry(): Registry {
  if (cached) return cached;
  const areas = readCatalogueFiles().areas;
  const r: Registry = { states: new Set(), byId: new Map(), byState: new Map() };
  for (const a of areas) {
    if (a.level === "state") r.states.add(a.id);
    else if (a.level === "district" && a.stateId) {
      r.byId.set(a.id, { id: a.id, stateId: a.stateId, name: a.names.en });
      const m = r.byState.get(a.stateId) ?? new Map<string, string | null>();
      for (const n of Object.values(a.names)) {
        if (!n) continue;
        const k = normaliseName(n);
        if (!k) continue;
        m.set(k, m.has(k) && m.get(k) !== a.id ? null : a.id);
      }
      r.byState.set(a.stateId, m);
    }
  }
  cached = r;
  return r;
}

export const districtDisplayName = (districtId: string): string | null => registry().byId.get(districtId)?.name ?? null;
export const isKnownState = (stateId: string): boolean => registry().states.has(stateId);
export const isKnownDistrict = (districtId: string): boolean => registry().byId.has(districtId);

/** Accepts `IN-KA` or the legacy bare `KA`; returns the registry state id or null. */
export function canonicalStateId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const id = /^IN-/i.test(t) ? `IN-${t.slice(3).toUpperCase()}` : `IN-${t.toUpperCase()}`;
  return isKnownState(id) ? id : null;
}

export interface ResolvedDistrict {
  /** Canonical `IN-XX-slug`, or null when the district could not be matched to the registry. */
  districtId: string | null;
  /** Registry state implied by the match (used to reject a district that contradicts the given state). */
  stateId: string | null;
}

/**
 * Resolves a canonical district id or farmer-typed name against the registry. Never invents an id.
 * Names match exactly after normalisation (no alias table yet: "Bangalore" does not resolve to Bengaluru).
 * Without a state, a name resolves only when it is unique across all district lists.
 */
export function resolveDistrict(input: { stateId?: string | null; districtIdOrName?: string | null }): ResolvedDistrict {
  const raw = input.districtIdOrName?.trim();
  if (!raw) return { districtId: null, stateId: input.stateId ?? null };
  const r = registry();
  const exact = r.byId.get(raw);
  if (exact) return { districtId: exact.id, stateId: exact.stateId };
  const key = normaliseName(raw);
  if (!key) return { districtId: null, stateId: input.stateId ?? null };
  if (input.stateId) {
    const hit = r.byState.get(input.stateId)?.get(key) ?? null;
    return { districtId: hit, stateId: input.stateId };
  }
  const hits = new Set<string>();
  for (const m of r.byState.values()) {
    const h = m.get(key);
    if (h) hits.add(h);
  }
  if (hits.size === 1) {
    const id = [...hits][0]!;
    return { districtId: id, stateId: r.byId.get(id)!.stateId };
  }
  return { districtId: null, stateId: null };
}
