import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../catalogue/files";
import { WORD_L, WORD_R } from "./lexicon";

/**
 * F13 (review R4 #3, #5): district/state names from the curated registry (data/curated/districts.json), used
 * by the output gate to (a) detect place names in evidence-cited text and (b) accept district/state
 * clarification options only when they name a registry area. Read once, lazily; a missing or unreadable
 * registry yields an empty list (options then fail closed; the text-scope check then has no place names).
 */
export interface PlaceName {
  id: string;
  level: "state" | "district";
  stateId: string;
  names: string[];
}

/**
 * Gate-only supplement: Kerala district names (Kerala has no district list in the registry, but it is a major
 * ginger/turmeric state, so evidence-cited text naming one must be caught). Detection only: this is NOT
 * coverage and these ids are not registry ids.
 */
const SUPPLEMENT: PlaceName[] = ["Thiruvananthapuram", "Kollam", "Pathanamthitta", "Alappuzha", "Kottayam", "Idukki", "Ernakulam", "Thrissur", "Palakkad", "Malappuram", "Kozhikode", "Wayanad", "Kannur", "Kasaragod"].map((n) => ({
  id: `gate-supplement:IN-KL:${n.toLowerCase()}`,
  level: "district",
  stateId: "IN-KL",
  names: [n],
}));

let cache: PlaceName[] | null = null;
export function placeRegistry(): PlaceName[] {
  // (registry areas + gate-only detection supplement; isRegistryPlace excludes the supplement)
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, "data", "curated", "districts.json"), "utf8")) as { areas?: { id?: unknown; level?: unknown; stateId?: unknown; names?: Record<string, unknown> }[] };
    cache = (raw.areas ?? []).flatMap((a) => {
      if (typeof a.id !== "string" || (a.level !== "state" && a.level !== "district") || typeof a.stateId !== "string") return [];
      const names = Object.values(a.names ?? {}).filter((n): n is string => typeof n === "string" && n.trim().length >= 3).map((n) => n.normalize("NFC").trim());
      return [{ id: a.id, level: a.level, stateId: a.stateId, names }];
    });
  } catch {
    cache = [];
  }
  cache = [...cache, ...SUPPLEMENT];
  return cache;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
export const nameRe = (name: string) => new RegExp(`${WORD_L}${esc(name)}${WORD_R}`, "iu");

/** Normalised comparison key for a place name or id ("IN-KA-hassan", "Hassan" -> "hassan"). */
const key = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

/** Registry areas the farm is in: its district ids and state ids, matched case-insensitively. */
export function farmPlaces(districtIds: string[], stateIds: string[]): Set<string> {
  const ids = new Set<string>();
  const dKeys = new Set(districtIds.map(key));
  const sKeys = new Set(stateIds.flatMap((s) => [key(s), key(s.startsWith("IN-") ? s : `IN-${s}`)]));
  for (const p of placeRegistry()) {
    if (p.level === "district" && (dKeys.has(key(p.id)) || p.names.some((n) => [...dKeys].some((d) => d.endsWith(key(n)))))) ids.add(p.id), ids.add(p.stateId);
    if (p.level === "state" && sKeys.has(key(p.id))) ids.add(p.id);
  }
  return ids;
}

/** Registry places named in a text, as ids. */
export function placesNamedIn(text: string): { id: string; name: string }[] {
  const t = text.normalize("NFC");
  return placeRegistry().flatMap((p) => p.names.filter((n) => nameRe(n).test(t)).map((name) => ({ id: p.id, name })));
}

/** True when an option is exactly a registry name of the given level (case-insensitive, NFC). */
export function isRegistryPlace(option: string, level: "state" | "district"): boolean {
  const o = key(option);
  return o.length > 0 && placeRegistry().some((p) => p.level === level && !p.id.startsWith("gate-supplement:") && p.names.some((n) => key(n) === o));
}
