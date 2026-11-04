import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoFarm } from '../state';
import { farmPoint, type FarmLoads } from './model';
export function FarmsMap(props: {
  farms: GeoFarm[];
  loads: FarmLoads;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  let host!: HTMLDivElement;
  let map: L.Map | undefined;
  let layers: L.LayerGroup | undefined;
  const [ready, setReady] = createSignal(false),
    [located, setLocated] = createSignal(0),
    [tileError, setTileError] = createSignal(false);
  onMount(() => {
    map = L.map(host, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      maxZoom: 19
    });
    const base = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri · Maxar · Earthstar Geographics'
    });
    base.on('tileerror', () => setTileError(true));
    base.on('load', () => {
      const tiles = host.querySelectorAll<HTMLImageElement>('.leaflet-tile');
      setTileError([...tiles].some(t => t.complete && !t.naturalWidth));
    });
    base.addTo(map);
    layers = L.layerGroup().addTo(map);
    setReady(true);
    const resize = new ResizeObserver(() => map?.invalidateSize());
    resize.observe(host);
    onCleanup(() => {
      resize.disconnect();
      map?.remove();
      map = undefined;
    });
  });
  createEffect(() => {
    if (!ready() || !map || !layers) return;
    layers.clearLayers();
    const bounds = L.latLngBounds([]);
    let count = 0;
    for (const farm of props.farms) {
      const load = props.loads[farm.id];
      const boundary = load?.status === 'ready' ? load.workspace.boundary : null;
      let anchor: L.LatLng | null = null;
      if (boundary) {
        const polygon = L.polygon(boundary.coordinates[0]!.map(p => [p[1]!, p[0]!] as [number, number]), {
          color: props.selected === farm.id ? '#e2f9ae' : '#c1d8bb',
          weight: props.selected === farm.id ? 3 : 1.5,
          fillOpacity: .15
        }).addTo(layers);
        bounds.extend(polygon.getBounds());
        anchor = polygon.getBounds().getCenter();
        polygon.on('click', () => props.onSelect(farm.id));
      } else {
        const point = farmPoint(farm);
        if (point) {
          anchor = L.latLng(point);
          bounds.extend(anchor);
        }
      }
      if (anchor) {
        count++;
        const label = document.createElement('span');
        label.textContent = farm.name;
        L.marker(anchor, {
          keyboard: true,
          title: farm.name,
          icon: L.divIcon({
            className: 'af-map-pin',
            html: '<span aria-hidden="true"></span>',
            iconSize: [22, 22]
          })
        }).addTo(layers).bindTooltip(label, {
          direction: 'top',
          permanent: true
        }).on('click', () => props.onSelect(farm.id));
      }
    }
    setLocated(count);
    if (bounds.isValid()) map.fitBounds(bounds, {
      padding: [50, 65],
      maxZoom: 16,
      animate: false
    });
  });
  return <section class="af-map" aria-label="Your farms on satellite imagery"><div ref={host} class="af-map-canvas" style={{
      visibility: located() ? 'visible' : 'hidden'
    }} /><Show when={!located()}><div class="af-map-empty"><strong>No saved map locations yet</strong><p>Add a boundary or location in your farm records to see it here.</p></div></Show><Show when={located()}><div class="af-map-caption">{located()} of {props.farms.length} farms located · Basemap imagery, not a current field observation</div></Show><Show when={tileError()}><div class="af-map-warning" role="status">Satellite tiles could not all load. Saved farm locations and records remain available.</div></Show></section>;
}
