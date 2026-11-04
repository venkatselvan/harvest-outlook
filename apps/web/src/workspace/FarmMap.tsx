import { GeographicBoundary, pointInRing } from "@harvest/contracts";
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
import { boundaryDraft, commitBoundaryDraft, undoBoundaryDraft } from "./boundaryEditorModel";
import "./farm-map-editor.css";
import { boundaryArea, type Boundary } from "./state";
/** A saved field drawn on the map in its crop colour (FIELDS_MULTICROP_SOIL_SPEC.md 6.1). */
export interface MapField {
  id: string;
  name: string;
  boundary: Boundary;
  color: string;
}
/** A picked point (degrees). */
export interface MapPoint {
  lat: number;
  lon: number;
}
export interface LocateMode {
  onPick: (point: MapPoint) => void;
  within?: Boundary | null | undefined;
  point?: MapPoint | null | undefined;
  outsideText?: string | undefined;
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
  /**
   * 2026-11-03 (FIELD_OPERATIONS_SPEC.md 5.1): tap-to-locate, additive. While set and not drawing, a tap inside `within`
   * (when given) calls `onPick` with the point; a tap outside shows `outsideText` and picks nothing. `point` is drawn as a
   * dot. Without this prop the map behaves exactly as before.
   */
  locate?: LocateMode | undefined;
}) {
  let container!: HTMLDivElement;
  let map: L.Map | undefined;
  let shape: L.Polygon | undefined;
  let line: L.Polyline | undefined;
  let contextShape: L.Polygon | undefined;
  const fieldShapes: L.Polygon[] = [];
  let pickMarker: L.CircleMarker | undefined;
  const dots: L.Marker[] = [];
  let suppressVertexClickUntil = 0;
  let restoreMapDragging: (() => void) | undefined;
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
  const [draft, setDraft] = createSignal(boundaryDraft<L.LatLng>());
  const vertices = () => draft().points;
  const commitVertices = (points: readonly L.LatLng[]) => setDraft((current) => commitBoundaryDraft(current, points));
  const [validationError, setValidationError] = createSignal("");
  const [satellite, setSatellite] = createSignal(true);
  const [tileError, setTileError] = createSignal(false);
  const [locationError, setLocationError] = createSignal("");
  let base: L.TileLayer;
  let labels: L.TileLayer;
  const redraw = () => {
    if (!map) return;
    restoreMapDragging?.();
    shape?.remove();
    shape = undefined;
    line?.remove();
    line = undefined;
    dots.splice(0).forEach((d) => d.remove());
    const points = props.editing
      ? vertices()
      : (props.boundary?.coordinates[0]?.map((p) => L.latLng(p[1]!, p[0]!)) ??
        []);
    if (points.length > 2)
      shape = L.polygon([...points], {
        color: "#e7ff8e",
        weight: 3,
        fillColor: "#b5d670",
        fillOpacity: 0.23,
      }).addTo(map);
    else if (points.length)
      line = L.polyline([...points], { color: "#e7ff8e", weight: 3 }).addTo(map);
    if (props.editing)
      points.forEach((point, i) => {
        const dot = L.marker(point, {
          icon: L.divIcon({ className: "boundary-vertex", html: '<span aria-hidden="true"></span>', iconSize: [44, 44], iconAnchor: [22, 22] }),
          draggable: !props.saving,
          keyboard: true,
          bubblingMouseEvents: false,
          title: `${field() ? "Field" : "Farm boundary"} point ${i + 1}: drag to move, or use arrow keys. Shift moves farther.`,
          autoPan: false,
          autoPanOnFocus: false,
        }).addTo(map!);
        const element = dot.getElement();
        if (element) {
          element.setAttribute("aria-label", `${field() ? "Field" : "Farm boundary"} point ${i + 1}`);
          element.setAttribute("data-vertex-index", String(i));
          element.addEventListener("pointerdown", () => {
            if (!map || props.saving) return;
            // Stop camera motion before Leaflet captures the handle's starting pixel position.
            map.stop();
            if (!restoreMapDragging) {
              const wasEnabled = map.dragging.enabled();
              map.dragging.disable();
              restoreMapDragging = () => { if (wasEnabled) map?.dragging.enable(); restoreMapDragging = undefined; };
            }
          }, { capture: true });
          element.addEventListener("touchstart", (event) => event.preventDefault(), { capture: true, passive: false });
          L.DomEvent.disableClickPropagation(element);
          element.addEventListener("keydown", (event) => {
            const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const direction = directions[event.key];
            if (!direction || props.saving || !map) return;
            event.preventDefault(); event.stopPropagation();
            map.stop();
            const pixel = map.latLngToLayerPoint(vertices()[i]!);
            const distance = event.shiftKey ? 10 : 1;
            const moved = map.layerPointToLatLng(pixel.add(L.point(direction[0] * distance, direction[1] * distance)));
            commitVertices(vertices().map((value, index) => index === i ? moved : value));
            queueMicrotask(() => dots[i]?.getElement()?.focus());
          });
        }
        dot.on("dragstart", () => {
          if (!map || restoreMapDragging) return;
          map.stop();
          const wasEnabled = map.dragging.enabled();
          map.dragging.disable();
          restoreMapDragging = () => { if (wasEnabled) map?.dragging.enable(); restoreMapDragging = undefined; };
        });
        dot.on("drag", () => {
          const moved = vertices().map((value, index) => index === i ? dot.getLatLng() : value);
          if (shape) shape.setLatLngs([...moved]);
          else line?.setLatLngs([...moved]);
        });
        dot.on("dragend", () => {
          const moved = dot.getLatLng();
          restoreMapDragging?.();
          suppressVertexClickUntil = Date.now() + 400;
          commitVertices(vertices().map((value, index) => index === i ? moved : value));
        });
        dot.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          // A tap selects an edit handle; only Finish commits the draft. A short drag must never save it.
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
    const releaseVertex = () => restoreMapDragging?.();
    window.addEventListener("pointerup", releaseVertex);
    window.addEventListener("pointercancel", releaseVertex);
    onCleanup(() => { window.removeEventListener("pointerup", releaseVertex); window.removeEventListener("pointercancel", releaseVertex); });
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
      if (Date.now() < suppressVertexClickUntil) return;
      if (props.editing && !props.saving)
        commitVertices([...vertices(), e.latlng]);
      else if (props.locate && !props.editing) pick(e.latlng);
    });
    const fit = props.fitTo ?? props.boundary;
    if (fit)
      map.fitBounds(L.geoJSON(fit as GeoJSON.Polygon).getBounds(), {
        padding: [70, 70],
        maxZoom: 18,
        animate: false,
      });
    redrawContext();
    redraw();
    const observer = new ResizeObserver(() => map?.invalidateSize());
    observer.observe(container);
    onCleanup(() => {
      observer.disconnect();
      restoreMapDragging?.();
      map?.remove();
    });
  });
  createEffect(
    on(
      () => [props.boundary, props.editing] as const,
      ([b, edit]) => {
        if (edit)
          setDraft(boundaryDraft(b?.coordinates[0]?.slice(0, -1).map((p) => L.latLng(p[1]!, p[0]!)) ?? []));
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
    if (map && c) map.setView(c, 15, { animate: false });
  });
  createEffect(() => {
    const b = props.fitTo ?? props.boundary;
    if (map && b)
      map.fitBounds(L.geoJSON(b as GeoJSON.Polygon).getBounds(), {
        paddingTopLeft: [70, 70],
        paddingBottomRight: [70, props.editing ? (window.innerWidth < 768 ? 190 : 110) : 70],
        maxZoom: 18,
        animate: false,
      });
  });
  /** Tap-to-locate: a point inside `locate.within` (when given) is handed to `onPick`; outside shows a message. */
  function pick(latlng: L.LatLng) {
    const mode = props.locate;
    if (!mode) return;
    const point = { lat: latlng.lat, lon: latlng.lng };
    const ring = mode.within?.coordinates[0];
    if (ring && ring.length >= 4 && !pointInRing([point.lon, point.lat], ring as [number, number][])) {
      setValidationError(mode.outsideText ?? "That spot is outside the field. Tap inside it.");
      return;
    }
    setValidationError("");
    mode.onPick(point);
  }
  createEffect(() => {
    const point = props.locate?.point;
    pickMarker?.remove();
    pickMarker = undefined;
    if (map && point)
      pickMarker = L.circleMarker([point.lat, point.lon], {
        radius: 8,
        color: "#ffffff",
        weight: 3,
        fillColor: "#d9622b",
        fillOpacity: 1,
        interactive: false,
      }).addTo(map);
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
                  ? "Drag a point to adjust it, or finish the field."
                  : "Drag a point to adjust it, or finish your boundary."
                : field()
                  ? "Click each corner inside the dashed farm outline. Corners may sit on its edge or on another field's edge."
                  : "Click corners to add points. Drag a point to adjust; drag elsewhere to pan."}
            </span>
          </div>
          <div class="draw-actions">
            <button
              class="text-button"
              disabled={props.saving || !draft().history.length}
              onClick={() => setDraft(undoBoundaryDraft)}
            >
              Undo
            </button>
            <button
              class="text-button"
              disabled={props.saving || !vertices().length}
              onClick={() => {
                commitVertices([]);
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
      <Show when={props.locate && !props.editing}>
        <div class="map-locate-hint" role="status">
          {props.locate?.point ? "Spot marked. Tap again to move it." : "Tap the spot on the map."}
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
