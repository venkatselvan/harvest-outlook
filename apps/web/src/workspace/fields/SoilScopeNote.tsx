import { Show } from "solid-js";
import { Icon } from "../icons";

/**
 * Soil reports and markers are farm-level records (FIELDS_MULTICROP_SOIL_SPEC.md 12.6): on a farm with fields one line says
 * so, so a farmer looking at one field does not read the values as that field's own. Rendered at the top of FarmSettings
 * (the Soil records section and the soil drawer).
 */
export function SoilScopeNote(props: { fieldCount: number }) {
  return (
    <Show when={props.fieldCount > 0}>
      <p class="inline-note soil-scope-note" data-testid="soil-scope-note">
        <Icon name="info" size={14} /> Soil reports are for the whole farm.
      </p>
    </Show>
  );
}
