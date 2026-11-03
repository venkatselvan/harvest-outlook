import { FarmMap, type MapPoint } from "../FarmMap";
import type { Boundary } from "../state";
import "./scouting.css";

/**
 * "Mark on map" (FIELD_OPERATIONS_SPEC.md 5.1): the farm map in its tap-to-locate mode, fitted to the field (or the farm),
 * with the farm outline dashed around it. Loaded on demand so the map library stays out of Today until it is needed.
 */
export default function LocateMap(props: {
  within: Boundary | null;
  farmBoundary: Boundary | null;
  point: MapPoint | null;
  placeName: string;
  outsideText: string;
  onPick: (point: MapPoint) => void;
}) {
  return (
    <div class="sc-locate-map" data-testid="sc-locate-map">
      <FarmMap
        boundary={props.within}
        context={props.farmBoundary}
        fitTo={props.within ?? props.farmBoundary}
        editing={false}
        onBoundary={() => undefined}
        farmName={props.placeName}
        locate={{ onPick: props.onPick, within: props.within, point: props.point, outsideText: props.outsideText }}
      />
    </div>
  );
}
