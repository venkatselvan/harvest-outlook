import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { useLocation } from "@solidjs/router";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useWorkspace, type GeoFarm } from "./state";
import { activeFarmTab, tabField } from "./farmTabs";
import { currentCycleOf, type FieldCycleLike } from "./fields/fieldsModel";
import { cropColor } from "./today/model";
import {
  DEFAULT_PADDING,
  fitPadding,
  isMapTab,
  mapFocus,
  mapLayerState,
  pinAnchor,
  registerMapController,
  ringCentre,
  samePadding,
  setMapPin,
  setMapReady,
  type FitPadding,
} from "./mapLayer";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/** A field name chip for the map, built with textContent so a field name is never parsed as markup. */
function fieldTag(name: string, selected: boolean): HTMLElement {
  const tag = document.createElement("span");
  tag.className = selected ? "workspace-field-tag is-selected" : "workspace-field-tag";
  tag.textContent = name;
  return tag;
}

/**
 * The geographic backdrop. Only saved geometry or an explicit saved point can locate it.
 *
 * On the Today and Actions tabs (docs/research/TODAY_MAP_LAYOUT_SPEC.md) it is the full-tab map layer: the saved farm
 * boundary, every saved field outline in its crop colour with a field name chip, fitted into the open centre the view
 * publishes; the view draws the farm pin and the zoom buttons from the state in `mapLayer.ts`. On every other tab it
 * stays the quiet backdrop (outline only). The map is never interactive (no drag, no scroll zoom, no keyboard) and is
 * hidden from assistive technology. Without a boundary or point, or when imagery fails (no tile loaded and at least one
 * error), the flat gradient shows instead and nothing around it moves.
 */
export function WorkspaceBackdrop() {
  const s = useWorkspace();
  const location = useLocation();
  let container!: HTMLDivElement;
  let map: L.Map | undefined;
  let drawn: L.Layer[] = [];
  let bounds: L.LatLngBounds | null = null;
  let centre: L.LatLng | null = null;
  let anchor: L.LatLng | null = null;
  const [mounted, setMounted] = createSignal(false);
  const [tiles, setTiles] = createSignal({ loaded: 0, errors: 0 });
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const fullTab = createMemo(() => isMapTab(activeFarmTab(location.pathname, location.search)));
  const workspace = createMemo(() => {
    const ws = s.workspace.error ? undefined : s.workspace();
    return ws?.farmId === s.farm()?.id ? ws : undefined;
  });
  const boundary = createMemo(() => workspace()?.boundary ?? null);
  const savedPoint = createMemo<[number, number] | null>(() => {
    const farm = s.farm() as GeoFarm | undefined;
    const lat = farm?.location.lat;
    const lon = farm?.location.lon;
    if (typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
    const value = farm?.facts.location?.value;
    if (!value || typeof value !== "object") return null;
    const point = (value as { point?: { coordinates?: unknown } }).point?.coordinates;
    if (Array.isArray(point) && point.length === 2 && typeof point[0] === "number" && typeof point[1] === "number" && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90) return [point[1], point[0]];
    return null;
  });
  /** Saved fields with their crop colour, only on the map tabs. */
  const fields = createMemo(() => {
    if (!fullTab()) return [];
    const ws = workspace();
    const cycles = (ws?.cycles ?? []) as FieldCycleLike[];
    return (ws?.fields ?? []).map((field) => ({ id: field.id, name: field.name, ring: field.boundary?.coordinates?.[0] ?? [], color: cropColor(currentCycleOf(field.id, cycles)?.cropId) }));
  });
  const located = () => !!boundary() || !!savedPoint();
  const layer = () => mapLayerState({ located: located(), tilesLoaded: tiles().loaded, tileErrors: tiles().errors });
  const padding = createMemo<FitPadding>(
    () => {
      size();
      return fullTab() && mounted() ? fitPadding(mapFocus(), viewport()) : DEFAULT_PADDING;
    },
    DEFAULT_PADDING,
    { equals: samePadding },
  );

  const updatePin = () => {
    if (!map || !anchor || !fullTab() || layer() !== "map") {
      setMapPin(null);
      return;
    }
    const point = map.latLngToContainerPoint(anchor);
    setMapPin({ x: Math.round(point.x), y: Math.round(point.y) });
  };
  /** Fit the farm into the open centre (or the default padding); a saved point is centred in the same box. */
  const fit = (animate: boolean) => {
    if (!map) return;
    map.invalidateSize();
    const pad = padding();
    if (bounds) map.fitBounds(bounds, { paddingTopLeft: pad.topLeft, paddingBottomRight: pad.bottomRight, maxZoom: 17, animate });
    else if (centre) {
      map.setView(centre, 15, { animate: false });
      const { width, height } = viewport();
      const fx = (pad.topLeft[0] + width - pad.bottomRight[0]) / 2;
      const fy = (pad.topLeft[1] + height - pad.bottomRight[1]) / 2;
      map.panBy([width / 2 - fx, height / 2 - fy], { animate });
    }
    updatePin();
  };

  onMount(() => {
    setMounted(true);
    const resize = () => setSize(viewport());
    resize();
    window.addEventListener("resize", resize);
    const unregister = registerMapController((command) => {
      if (!map || layer() !== "map") return;
      const animate = !reducedMotion();
      if (command === "zoom-in") map.zoomIn(1, { animate });
      else if (command === "zoom-out") map.zoomOut(1, { animate });
      else fit(animate);
    });
    onCleanup(() => {
      window.removeEventListener("resize", resize);
      unregister();
    });
  });

  // Create or remove the map, then draw the outline, the fields and their name chips.
  createEffect(() => {
    if (!mounted()) return;
    const b = boundary();
    const point = savedPoint();
    const shapes = fields();
    const selected = fullTab() ? tabField() : null;
    if (!b && !point) {
      map?.remove();
      map = undefined;
      drawn = [];
      bounds = centre = anchor = null;
      setTiles({ loaded: 0, errors: 0 });
      setMapPin(null);
      return;
    }
    if (!map) {
      map = L.map(container, { zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, keyboard: false });
      const tileLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri · Maxar · Earthstar Geographics" }).addTo(map);
      tileLayer.on("tileerror", () => setTiles((t) => ({ ...t, errors: t.errors + 1 })));
      tileLayer.on("tileload", () => setTiles((t) => ({ ...t, loaded: t.loaded + 1 })));
      map.on("move zoom resize viewreset", updatePin);
    }
    for (const item of drawn) item.remove();
    drawn = [];
    bounds = centre = anchor = null;
    const ring = b?.coordinates[0] ?? [];
    const points = ring.map((p) => L.latLng(p[1]!, p[0]!));
    if (points.length > 2) {
      const outline = L.polygon(points, { color: "#dbf7b3", weight: 2, fillOpacity: shapes.length ? 0.02 : 0.08, interactive: false }).addTo(map);
      drawn.push(outline);
      bounds = outline.getBounds();
    }
    for (const field of shapes) {
      const fieldPoints = field.ring.map((p) => L.latLng(p[1]!, p[0]!));
      if (fieldPoints.length < 3) continue;
      const isSelected = field.id === selected;
      drawn.push(L.polygon(fieldPoints, { color: field.color, weight: isSelected ? 3 : 2, fillColor: field.color, fillOpacity: isSelected ? 0.24 : 0.12, interactive: false }).addTo(map));
      const at = ringCentre(field.ring);
      if (at)
        drawn.push(
          L.marker(at, {
            icon: L.divIcon({ className: "workspace-field-tag-icon", html: fieldTag(field.name, isSelected), iconSize: undefined }),
            interactive: false,
            keyboard: false,
          }).addTo(map),
        );
    }
    const pinAt = pinAnchor(ring, point);
    anchor = pinAt ? L.latLng(pinAt[0], pinAt[1]) : null;
    centre = bounds ? bounds.getCenter() : point ? L.latLng(point[0], point[1]) : null;
    // Fitting reads the padding and the tile state; neither should redraw the shapes.
    untrack(() => fit(false));
  });
  // Another farm's imagery starts its own tile count.
  createEffect(on([boundary, savedPoint], () => setTiles({ loaded: 0, errors: 0 }), { defer: true }));
  // A new open centre (a resize, the view mounting or leaving) refits without animation.
  createEffect(on(padding, () => untrack(() => fit(false)), { defer: true }));
  createEffect(() => {
    setMapReady(fullTab() && located() && layer() === "map");
    updatePin();
  });
  onCleanup(() => {
    map?.remove();
    map = undefined;
    setMapPin(null);
    setMapReady(false);
  });
  return (
    <div class="workspace-backdrop" classList={{ "has-location": located(), "imagery-unavailable": located() && layer() === "flat", "is-map-layer": fullTab(), "credit-in-band": fullTab() && !!mapFocus() }}>
      <div ref={container} class="workspace-backdrop-map" aria-hidden="true" />
      <div class="workspace-backdrop-wash" />
      <Show when={!located()}><div class="workspace-geography-note">Save your farm boundary to see its satellite context.</div></Show>
      <Show when={located() && layer() === "flat"}><div class="workspace-geography-note" role="status">Satellite imagery unavailable · your saved farm records remain accessible.</div></Show>
      <Show when={located() && layer() === "map"}><span class="workspace-imagery-credit">Satellite basemap · Imagery © Esri · Maxar · Earthstar Geographics</span></Show>
    </div>
  );
}
