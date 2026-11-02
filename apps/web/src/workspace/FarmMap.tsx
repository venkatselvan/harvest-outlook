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
/** A saved field drawn on the map in its crop colour (FIELDS_MULTICROP_SOIL_SPEC.md 6.1). */
export interface MapField {
  id: string;
  name: string;
  boundary: Boundary;
  color: string;
}
export function FarmMap(props: {
  boundary: Boundary | null;
  center?: [number, number];
  editing: boolean;
  saving?: boolean;
  onBoundary: (b: Boundary | null) => void;
  farmName?: string;
  onEdit?: () => void;
  /** 2026-11-03: the farm boundary, dashed, as context while a field is drawn. */
  context?: Boundary | null;
  /** 2026-11-03: saved fields in their crop colours, with name tooltips. */
  fields?: readonly MapField[];
  /** 2026-11-03: an extra check on a finished outline (inside the farm, no overlap); a message keeps the points. */
  validate?: (b: Boundary) => string | null;
  /** 2026-11-03: what is being drawn; changes the instructions and button labels. */
  subject?: "farm" | "field";
  /** 2026-11-03: fit the view to this outline instead of `boundary` (drawing a field keeps the whole farm in view). */
  fitTo?: Boundary | null;
}) {
  let container!: HTMLDivElement;
  let map: L.Map | undefined;
  let shape: L.Polygon | undefined;
  let line: L.Polyline | undefined;
  let contextShape: L.Polygon | undefined;
  const fieldShapes: L.Polygon[] = [];
  const dots: L.CircleMarker[] = [];
  const field = () => props.subject === "field";
  const latLngs = (b: Boundary | null | undefined) =>
    b?.coordinates[0]?.slice(0, -1).map((p) => L.latLng(p[1]!, p[0]!)) ?? [];
  /** Context layers under the outline being drawn: the farm boundary (dashed) and the saved fields in crop colours. */
  const redrawContext = () => {
    if (!map) return;
    contextShape?.remove();
    contextShape = undefined;
    fieldShapes.splice(0).forEach((f) => f.remove());
    const ctx = latLngs(props.context);
    if (ctx.length > 2)
      contextShape = L.polygon(ctx, {
        color: "#ffffff",
        weight: 2,
        dashArray: "6 6",
        fill: false,
        interactive: false,
      }).addTo(map);
    for (const f of props.fields ?? []) {
      const points = latLngs(f.boundary);
      if (points.length < 3) continue;
      const polygon = L.polygon(points, {
        color: f.color,
        weight: 2,
        fillColor: f.color,
        fillOpacity: 0.28,
        // While drawing, clicks must reach the map so a corner can sit on a shared edge.
        interactive: !props.editing,
      }).addTo(map);
      polygon.bindTooltip(f.name, { direction: "center", className: "map-field-tooltip" });
      fieldShapes.push(polygon);
    }
  };
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
    const problem = props.validate?.(boundary);
    if (problem) {
      setValidationError(problem);
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
    const fit = props.fitTo ?? props.boundary;
    if (fit)
      map.fitBounds(L.geoJSON(fit as GeoJSON.Polygon).getBounds(), {
        padding: [70, 70],
        maxZoom: 18,
      });
    redrawContext();
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
  createEffect(() => {
    props.context;
    props.fields;
    props.editing;
    redrawContext();
    redraw();
  });
  createEffect(on(vertices, () => setValidationError(""), { defer: true }));
  createEffect(() => {
    const c = props.center;
    if (map && c) map.setView(c, 15);
  });
  createEffect(() => {
    const b = props.fitTo ?? props.boundary;
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
                ? `${vertices().length} ${field() ? "field" : "boundary"} points`
                : field()
                  ? "Trace the edge of the field"
                  : "Trace the edge of your farm"}
            </strong>
            <span>
              {vertices().length >= 3
                ? field()
                  ? "Add more points or finish the field."
                  : "Add more points or finish your boundary."
                : field()
                  ? "Click each corner inside the dashed farm outline. Corners may sit on its edge or on another field's edge."
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
              {props.saving
                ? "Saving boundary…"
                : field()
                  ? "Finish field"
                  : "Finish boundary"}{" "}
              <Icon name="check" size={16} />
            </button>
          </div>
        </div>
      </Show>
      <Show when={!props.editing && props.boundary}>
        <div class="boundary-label">
          <span class="status-dot" />
          <strong>{boundaryArea(props.boundary).toFixed(2)} ha</strong>
          <span>{field() ? "New field" : "Mapped boundary"}</span>
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
