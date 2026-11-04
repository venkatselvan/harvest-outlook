import { Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoFarm } from '../state';
import { fitPadding, mapLayerState, suppressBackdrop, type FitPadding, type FocusRect, type MapCommand } from '../mapLayer';
import { farmPoint, type FarmLoads } from './model';
import { pinNumber } from './status';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const compactQuery = '(max-width: 767px)';
const isCompact = () => typeof window !== 'undefined' && !!window.matchMedia?.(compactQuery).matches;
/** Room for the pin chips (number circle at the anchor, the farm name to its right). */
const CHIP = { left: 24, top: 30, right: 150, bottom: 24 } as const;
/** Phone band: the farms are fitted inside the band with room for the chips and the credit line. */
const BAND: FitPadding = { topLeft: [28, 40], bottomRight: [130, 40] };

/** A numbered pin chip, built with textContent so a farm name is never parsed as markup. */
function pinChip(number: string, name: string, selected: boolean): HTMLElement {
  const chip = document.createElement('span');
  chip.className = selected ? 'af-pin is-selected' : 'af-pin';
  const n = document.createElement('span');
  n.className = 'af-pin-number';
  n.textContent = number;
  const label = document.createElement('span');
  label.className = 'af-pin-name';
  label.textContent = name;
  chip.append(n, label);
  return chip;
}

export interface FarmsMapStatus {
  located: number;
  layer: 'map' | 'flat';
}

/**
 * The All farms map (docs/research/ALL_FARMS_LAYOUT_SPEC.md item 1). On wide screens it is fixed behind the whole route
 * (the panels float over it and the farms are fitted into the open centre the page publishes as `focus`); on a phone it is
 * a top band. Like the Today map layer it takes no pointer or keyboard input and the canvas is hidden from assistive
 * technology: farms are selected from the list, and the page's zoom buttons drive it through `controller`. Only saved
 * boundaries or explicitly saved points locate a farm. Pins are numbered in list order; the selected farm's pin and
 * outline are highlighted, and selecting another farm pans it into the open centre (no animation with reduced motion).
 * When imagery fails (no tile loaded, at least one error) the tiles hide and the outlines and pins stay on a flat backdrop.
 */
export function FarmsMap(props: {
  farms: GeoFarm[];
  loads: FarmLoads;
  selected: string | undefined;
  focus: FocusRect | null;
  controller?: (handler: ((command: MapCommand) => void) | undefined) => void;
  onStatus?: (status: FarmsMapStatus) => void;
}) {
  let host!: HTMLDivElement;
  let map: L.Map | undefined;
  let layers: L.LayerGroup | undefined;
  let overview: L.LatLngBounds | null = null;
  const anchors = new Map<string, L.LatLng>();
  let geometryKey = '';
  let shownSelected: string | undefined;
  const [ready, setReady] = createSignal(false),
    [located, setLocated] = createSignal(0),
    [tiles, setTiles] = createSignal({ loaded: 0, errors: 0 }),
    [compact, setCompact] = createSignal(isCompact());
  const layer = () => mapLayerState({ located: located() > 0, tilesLoaded: tiles().loaded, tileErrors: tiles().errors });

  /** Fit padding in map-container pixels: the open centre on wide screens (the map is the viewport), the band on a phone. */
  const padding = (): FitPadding => {
    if (!map) return BAND;
    if (compact()) return BAND;
    const size = map.getSize();
    const base = fitPadding(untrack(() => props.focus), { width: size.x, height: size.y });
    const pad: FitPadding = {
      topLeft: [base.topLeft[0] + CHIP.left, base.topLeft[1] + CHIP.top],
      bottomRight: [base.bottomRight[0] + CHIP.right, base.bottomRight[1] + CHIP.bottom],
    };
    // Never pad the map to nothing (Leaflet cannot fit into a negative box): fall back to the unpadded open centre.
    return size.x - pad.topLeft[0] - pad.bottomRight[0] < 80 || size.y - pad.topLeft[1] - pad.bottomRight[1] < 80 ? base : pad;
  };
  const centreOf = (pad: FitPadding) => {
    const size = map!.getSize();
    return L.point((pad.topLeft[0] + size.x - pad.bottomRight[0]) / 2, (pad.topLeft[1] + size.y - pad.bottomRight[1]) / 2);
  };
  /** Show every located farm in the open centre. */
  const fitOverview = (animate: boolean) => {
    if (!map || !overview?.isValid()) return;
    map.invalidateSize();
    const pad = padding();
    map.fitBounds(overview, { paddingTopLeft: pad.topLeft, paddingBottomRight: pad.bottomRight, maxZoom: 16, animate });
  };
  /** Move the selected farm into the middle of the open centre, keeping the zoom. */
  const panToSelected = (id: string, animate: boolean) => {
    const at = anchors.get(id);
    if (!map || !at) return;
    const point = map.latLngToContainerPoint(at);
    const target = centreOf(padding());
    map.panBy([point.x - target.x, point.y - target.y], { animate });
  };

  // This route draws its own map: the shell backdrop's imagery credit, outline and tiles stay off while it is mounted.
  suppressBackdrop();
  onMount(() => {
    map = L.map(host, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      boxZoom: false,
      keyboard: false,
      maxZoom: 19,
      zoomAnimation: !reducedMotion(),
      fadeAnimation: !reducedMotion(),
    });
    // Plain-text prefix: the attribution sits inside an aria-hidden, non-interactive layer, so it carries no links.
    map.attributionControl.setPrefix('Leaflet');
    const base = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri · Maxar · Earthstar Geographics',
    });
    base.on('tileerror', () => setTiles((t) => ({ ...t, errors: t.errors + 1 })));
    base.on('tileload', () => setTiles((t) => ({ ...t, loaded: t.loaded + 1 })));
    base.addTo(map);
    layers = L.layerGroup().addTo(map);
    setReady(true);
    let lastSize = '';
    const resize = new ResizeObserver(() => {
      if (!map) return;
      const size = `${host.clientWidth}x${host.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      map.invalidateSize();
      fitOverview(false);
    });
    resize.observe(host);
    const mq = window.matchMedia?.(compactQuery);
    const onMq = () => setCompact(!!mq?.matches);
    mq?.addEventListener?.('change', onMq);
    props.controller?.((command) => {
      if (!map || !located()) return;
      const animate = !reducedMotion();
      // Zoom about the middle of the open centre (where the farms are fitted), not the middle of the whole viewport.
      if (command === 'zoom-in' || command === 'zoom-out') map.setZoomAround(centreOf(padding()), map.getZoom() + (command === 'zoom-in' ? 1 : -1), { animate });
      else fitOverview(animate);
    });
    onCleanup(() => {
      props.controller?.(undefined);
      mq?.removeEventListener?.('change', onMq);
      resize.disconnect();
      map?.remove();
      map = undefined;
    });
  });

  // Draw outlines and numbered pins; refit only when the set of located farms changes, otherwise pan to a new selection.
  createEffect(() => {
    if (!ready() || !map || !layers) return;
    layers.clearLayers();
    anchors.clear();
    const bounds = L.latLngBounds([]);
    const key: string[] = [];
    let count = 0;
    props.farms.forEach((farm, index) => {
      const selected = props.selected === farm.id;
      const load = props.loads[farm.id];
      const boundary = load?.status === 'ready' ? load.workspace.boundary : null;
      let anchor: L.LatLng | null = null;
      const ring = boundary?.coordinates[0] ?? [];
      if (ring.length > 2) {
        const polygon = L.polygon(ring.map((p) => [p[1]!, p[0]!] as [number, number]), {
          color: selected ? '#e2f9ae' : '#c1d8bb',
          weight: selected ? 3 : 1.5,
          fillOpacity: selected ? 0.2 : 0.1,
          interactive: false,
        }).addTo(layers!);
        bounds.extend(polygon.getBounds());
        anchor = polygon.getBounds().getCenter();
      } else {
        const point = farmPoint(farm);
        if (point) {
          anchor = L.latLng(point);
          bounds.extend(anchor);
        }
      }
      if (!anchor) return;
      count++;
      anchors.set(farm.id, anchor);
      key.push(`${farm.id}@${anchor.lat.toFixed(6)},${anchor.lng.toFixed(6)}`);
      L.marker(anchor, {
        interactive: false,
        keyboard: false,
        zIndexOffset: selected ? 1000 : 0,
        icon: L.divIcon({ className: 'af-pin-icon', html: pinChip(pinNumber(index), farm.name, selected), iconSize: undefined }),
      }).addTo(layers!);
    });
    setLocated(count);
    overview = bounds.isValid() ? bounds : null;
    const nextKey = key.join('|');
    const selected = props.selected;
    untrack(() => {
      if (nextKey !== geometryKey) {
        geometryKey = nextKey;
        fitOverview(false);
      } else if (selected && selected !== shownSelected && shownSelected !== undefined) {
        panToSelected(selected, !reducedMotion());
      }
    });
    shownSelected = selected;
  });
  // A new open centre (header height, a window resize, the breakpoint) refits the overview without animation.
  createEffect(
    on(
      () => [props.focus?.left, props.focus?.right, props.focus?.top, compact()] as const,
      () => fitOverview(false),
      { defer: true },
    ),
  );
  createEffect(() => props.onStatus?.({ located: located(), layer: layer() }));

  return (
    <div class="af-map" classList={{ 'is-flat': layer() === 'flat', 'has-location': located() > 0 }}>
      <div ref={host} class="af-map-canvas" aria-hidden="true" style={{ visibility: located() ? 'visible' : 'hidden' }} />
      <div class="af-map-wash" />
      <Show when={!located()}>
        <div class="af-map-empty">
          <strong>No saved map locations yet</strong>
          <p>Add a boundary or location in your farm records to see it here.</p>
        </div>
      </Show>
      <Show when={located()}>
        <div class="af-map-caption">
          {located()} of {props.farms.length} farms located · Basemap imagery, not a current field observation
        </div>
      </Show>
      <Show when={located() && layer() === 'flat'}>
        <div class="af-map-warning" role="status">
          Satellite imagery unavailable. Saved farm locations and records remain available.
        </div>
      </Show>
    </div>
  );
}
