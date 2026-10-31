import { GeographicBoundary } from "@harvest/contracts";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  on,
  Show,
} from "solid-js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icon } from "./icons";
import { boundaryArea, type Boundary } from "./state";
export function FarmMap(props: {
  boundary: Boundary | null;
  center?: [number, number];
  editing: boolean;
  saving?: boolean;
  onBoundary: (b: Boundary | null) => void;
  farmName?: string;
  onEdit?: () => void;
}) {
  let container!: HTMLDivElement;
  let map: L.Map | undefined;
  let shape: L.Polygon | undefined;
  let line: L.Polyline | undefined;
  const dots: L.CircleMarker[] = [];
  const [vertices, setVertices] = createSignal<L.LatLng[]>([]);
  const [validationError, setValidationError] = createSignal("");
  const [satellite, setSatellite] = createSignal(true);
  const [tileError, setTileError] = createSignal(false);
  const [locationError, setLocationError] = createSignal("");
  let base: L.TileLayer;
  let labels: L.TileLayer;
  const redraw = () => {
    if (!map) return;
    shape?.remove();
    line?.remove();
    dots.splice(0).forEach((d) => d.remove());
    const points = props.editing
      ? vertices()
      : (props.boundary?.coordinates[0]?.map((p) => L.latLng(p[1]!, p[0]!)) ??
        []);
    if (points.length > 2)
      shape = L.polygon(points, {
        color: "#e7ff8e",
        weight: 3,
        fillColor: "#b5d670",
        fillOpacity: 0.23,
      }).addTo(map);
    else if (points.length)
      line = L.polyline(points, { color: "#e7ff8e", weight: 3 }).addTo(map);
    if (props.editing)
      points.forEach((point, i) => {
        const dot = L.circleMarker(point, {
          radius: 6,
          color: "#274f36",
          weight: 2,
          fillColor: "#f7ffe9",
          fillOpacity: 1,
        }).addTo(map!);
        dot.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          if (i === 0 && points.length >= 3) finish();
        });
        dots.push(dot);
      });
  };
  const finish = () => {
    const p = vertices();
    if (p.length < 3) return;
    const ring = p.map((v) => [v.lng, v.lat]);
    ring.push([...ring[0]!]);
    const boundary = { type: "Polygon" as const, coordinates: [ring] };
    const valid = GeographicBoundary.safeParse(boundary);
    if (!valid.success) {
      setValidationError(
        "This outline crosses itself or has no area. Undo a point and follow the corners around your field. Your points are kept.",
      );
      return;
    }
    setValidationError("");
    props.onBoundary(boundary);
  };
  onMount(() => {
    map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: true,
      doubleClickZoom: false,
      maxZoom: 20,
    }).setView(props.center ?? [11.0168, 76.9558], props.boundary ? 16 : 14);
    base = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 20,
        attribution: "Tiles © Esri · Maxar · Earthstar Geographics",
      },
    ).addTo(map);
    labels = L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 20 },
    ).addTo(map);
    base.on("tileerror", () => setTileError(true));
    base.on("tileload", () => setTileError(false));
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (props.editing && !props.saving)
        setVertices([...vertices(), e.latlng]);
    });
    if (props.boundary)
      map.fitBounds(L.geoJSON(props.boundary as GeoJSON.Polygon).getBounds(), {
        padding: [70, 70],
        maxZoom: 18,
      });
    redraw();
    const observer = new ResizeObserver(() => map?.invalidateSize());
    observer.observe(container);
    onCleanup(() => {
      observer.disconnect();
      map?.remove();
    });
  });
  createEffect(
    on(
      () => [props.boundary, props.editing] as const,
      ([b, edit]) => {
        if (edit)
          setVertices(
            b?.coordinates[0]
              ?.slice(0, -1)
              .map((p) => L.latLng(p[1]!, p[0]!)) ?? [],
          );
        redraw();
      },
    ),
  );
  createEffect(() => {
    vertices();
    redraw();
  });
  createEffect(on(vertices, () => setValidationError(""), { defer: true }));
  createEffect(() => {
    const c = props.center;
    if (map && c) map.setView(c, 15);
  });
  createEffect(() => {
    const b = props.boundary;
    if (map && b && !props.editing)
      map.fitBounds(L.geoJSON(b as GeoJSON.Polygon).getBounds(), {
        padding: [70, 70],
        maxZoom: 18,
      });
  });
  function locate() {
    setLocationError("");
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        map?.setView([p.coords.latitude, p.coords.longitude], 17);
      },
      () =>
        setLocationError(
          "Location permission unavailable. Search or pan the map instead.",
        ),
      { timeout: 10000 },
    );
  }
  function toggleLayer() {
    if (!map) return;
    base.remove();
    labels.remove();
    setSatellite(!satellite());
    if (satellite()) {
      base = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 20,
          attribution: "Tiles © Esri · Maxar · Earthstar Geographics",
        },
      ).addTo(map);
      labels.addTo(map);
    } else
      base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
  }
  return (
    <div class={`farm-map ${props.editing ? "is-drawing" : ""}`}>
      <div
        class="map-canvas"
        ref={container}
        aria-label="Interactive farm boundary map"
      />
      <div class="map-top-label">
        <span class="status-dot" />{" "}
        {satellite() ? "Satellite map" : "Street map"}
        <span class="map-label-separator" />{" "}
        {props.farmName ?? "Find your land"}
      </div>
      <div class="map-controls">
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => map?.zoomIn()}
        >
          +
        </button>
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => map?.zoomOut()}
        >
          −
        </button>
        <span />
        <button
          title="Use my location"
          aria-label="Use my location"
          onClick={locate}
        >
          <Icon name="target" />
        </button>
        <button
          title="Switch map layer"
          aria-label="Switch map layer"
          onClick={toggleLayer}
        >
          <Icon name="layers" />
        </button>
      </div>
      <Show when={props.editing}>
        <div class="draw-instructions">
          <span class="draw-icon">
            <Icon name="draw" />
          </span>
          <div>
            <strong>
              {vertices().length
                ? `${vertices().length} boundary points`
                : "Trace the edge of your farm"}
            </strong>
            <span>
              {vertices().length >= 3
                ? "Add more points or finish your boundary."
                : "Click each corner on the map. Pan to move around."}
            </span>
          </div>
          <div class="draw-actions">
            <button
              class="text-button"
              disabled={props.saving || !vertices().length}
              onClick={() => setVertices(vertices().slice(0, -1))}
            >
              Undo
            </button>
            <button
              class="text-button"
              disabled={props.saving || !vertices().length}
              onClick={() => {
                setVertices([]);
                props.onBoundary(null);
              }}
            >
              Clear
            </button>
            <button
              class="btn compact"
              disabled={props.saving || vertices().length < 3}
              onClick={finish}
            >
              {props.saving ? "Saving boundary…" : "Finish boundary"}{" "}
              <Icon name="check" size={16} />
            </button>
          </div>
        </div>
      </Show>
      <Show when={!props.editing && props.boundary}>
        <div class="boundary-label">
          <span class="status-dot" />
          <strong>{boundaryArea(props.boundary).toFixed(2)} ha</strong>
          <span>Mapped boundary</span>
          <Show when={props.onEdit}>
            <button onClick={() => props.onEdit?.()}>Edit</button>
          </Show>
        </div>
      </Show>
      <Show when={validationError()}>
        <div class="map-validation-error" role="alert">
          {validationError()}
        </div>
      </Show>
      <Show when={tileError() || locationError()}>
        <div class="map-notice" role="status">
          {locationError() ||
            "Map imagery could not load. Check your internet connection or switch to the street map."}
        </div>
      </Show>
    </div>
  );
}
