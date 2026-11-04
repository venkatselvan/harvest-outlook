import { createSignal, onCleanup } from "solid-js";
import type { FarmTab } from "./farmTabs";

/**
 * Shared state of the full-tab map layer (docs/research/TODAY_MAP_LAYOUT_SPEC.md). The Leaflet map lives in the shell
 * (`WorkspaceBackdrop`, fixed behind every panel, aria-hidden and non-interactive); the Today and Actions views own the
 * open centre, the farm pin and the zoom buttons. They meet here: the view publishes the screen box the farm should be
 * fitted into, the map publishes where the farm pin falls on screen and whether the map is showing at all, and the zoom
 * buttons send commands. Nothing here imports Leaflet, so the view and its tests stay free of the map library.
 */

/** Tabs that promote the backdrop to the full map layer: outlines, field name chips, farm pin and zoom buttons. */
export const MAP_TABS: readonly FarmTab[] = ["today", "actions"];
export const isMapTab = (tab: FarmTab | undefined | null): boolean => !!tab && MAP_TABS.includes(tab);

/**
 * "map": the satellite map shows. "flat": the plain gradient backdrop, used when the farm has no saved boundary or
 * point, and when imagery fails (at least one tile error and no tile loaded). A single failed edge tile next to loaded
 * ones keeps the map. The layout around the map never changes with this state.
 */
export type MapLayerState = "map" | "flat";
export function mapLayerState(input: { located: boolean; tilesLoaded: number; tileErrors: number }): MapLayerState {
  if (!input.located) return "flat";
  return input.tileErrors > 0 && input.tilesLoaded === 0 ? "flat" : "map";
}

/** Page box (CSS pixels; top and bottom in document coordinates, left and right in viewport coordinates) of the open centre. */
export interface FocusRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}
export interface FitPadding {
  topLeft: [number, number];
  bottomRight: [number, number];
}
/** The quiet backdrop's padding (unchanged from before the map layer): the outline sits a little inside the screen. */
export const DEFAULT_PADDING: FitPadding = { topLeft: [120, 100], bottomRight: [120, 100] };
/** Smallest box the farm is fitted into; a narrower open centre falls back to the default padding. */
export const MIN_FOCUS = { width: 120, height: 100 } as const;
const EDGE = 16;
const BOTTOM_GAP = 24;

/**
 * Leaflet fit padding that places the farm inside the open centre. The box is clamped to the viewport (a tall centre
 * column ends at the bottom of the screen), and a box smaller than `MIN_FOCUS` (a narrow window, or a hidden centre)
 * returns the default padding.
 */
export function fitPadding(rect: FocusRect | null, viewport: { width: number; height: number }): FitPadding {
  if (!rect) return DEFAULT_PADDING;
  const left = Math.max(EDGE, rect.left);
  const top = Math.max(EDGE, rect.top);
  const right = Math.max(EDGE, viewport.width - rect.right);
  const bottom = Math.max(EDGE, viewport.height - Math.min(rect.bottom, viewport.height - BOTTOM_GAP));
  if (viewport.width - left - right < MIN_FOCUS.width || viewport.height - top - bottom < MIN_FOCUS.height) return DEFAULT_PADDING;
  return { topLeft: [Math.round(left), Math.round(top)], bottomRight: [Math.round(right), Math.round(bottom)] };
}
export const samePadding = (a: FitPadding, b: FitPadding) =>
  a.topLeft[0] === b.topLeft[0] && a.topLeft[1] === b.topLeft[1] && a.bottomRight[0] === b.bottomRight[0] && a.bottomRight[1] === b.bottomRight[1];

/** Centre of a ring's bounding box as [lat, lon] (rings are GeoJSON [lon, lat]); null for fewer than three valid points. */
export function ringCentre(ring: readonly (readonly number[])[] | undefined): [number, number] | null {
  const points = (ring ?? []).filter((p) => typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length < 3) return null;
  const lons = points.map((p) => p[0]!),
    lats = points.map((p) => p[1]!);
  return [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];
}

/** Where the farm pin is anchored: the middle of the outline's southern edge (so the pin card hangs below the farm and never covers a field name), or the saved point. */
export function pinAnchor(ring: readonly (readonly number[])[] | undefined, point: [number, number] | null): [number, number] | null {
  const centre = ringCentre(ring);
  if (centre) {
    const lats = (ring ?? []).map((p) => p[1]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return [Math.min(...lats), centre[1]];
  }
  return point;
}

// ---------------------------------------------------------------- shared signals (one map per page)
const [focus, setFocus] = createSignal<FocusRect | null>(null, { equals: (a, b) => !!a && !!b && a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom });
/** The open centre's box, published by the Today or Actions view; null when no view owns the centre. */
export const mapFocus = focus;
export const setMapFocus = setFocus;

const [pin, setPin] = createSignal<{ x: number; y: number } | null>(null);
/** Viewport position of the farm pin anchor, published by the map; null when the map is not showing. */
export const mapPin = pin;
export const setMapPin = setPin;

const [ready, setReady] = createSignal(false);
/** True while the full map layer is showing (a map tab, a located farm, imagery available). The pin and zoom buttons show only then. */
export const mapReady = ready;
export const setMapReady = setReady;

export type MapCommand = "zoom-in" | "zoom-out" | "recenter";
let controller: ((command: MapCommand) => void) | null = null;
/** The map registers its command handler; the returned function unregisters it (only if it is still the current one). */
export function registerMapController(handler: (command: MapCommand) => void): () => void {
  controller = handler;
  return () => {
    if (controller === handler) controller = null;
  };
}
export function sendMapCommand(command: MapCommand): void {
  controller?.(command);
}

const [suppressions, setSuppressions] = createSignal(0);
/**
 * True while a route draws its own full map (the All farms dashboard). The shell backdrop then removes its Leaflet map, outline,
 * imagery credit and notes on every width, so nothing of the selected farm shows through a phone's map band or under the panels.
 * A count, not a flag, so a view mounting before the previous one has cleaned up cannot clear the other's claim.
 */
export const backdropSuppressed = () => suppressions() > 0;
/** Claim the backdrop; the returned release is idempotent. Prefer `suppressBackdrop` inside a component. */
export function claimBackdrop(): () => void {
  setSuppressions((n) => n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setSuppressions((n) => Math.max(0, n - 1));
  };
}
/** Claim the backdrop for the calling component and release it when the component is disposed. */
export function suppressBackdrop(): () => void {
  const release = claimBackdrop();
  onCleanup(release);
  return release;
}
