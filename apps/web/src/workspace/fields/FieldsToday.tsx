import { For, Show } from "solid-js";
import type { FieldSummary } from "@harvest/contracts";
import { Icon } from "../icons";
import { cropColor, formatDay, formatIndex, harvestInText } from "../today/model";
import { verdictLabel } from "../today/TodayCards";
import { areaText } from "./fieldsModel";

/**
 * Today's field controls on a farm with fields (FIELDS_MULTICROP_SOIL_SPEC.md 6.3): the chips row ("All fields" then one
 * chip per field), the legend under the farm scene, and the "Your fields" table. Pure components; the selection lives in
 * the shell (`?field=`), and greenness is shown only where the server returned a stored reading for that field's own polygon.
 */
export interface FieldChipItem {
  id: string;
  name: string;
  /** "Maize", "Paddy + black gram" or "No crop". */
  crop: string;
  cropId: string | null;
}

/** Display text for a summary's crop: "Paddy / rice + black gram", or "No crop". */
export function summaryCrop(field: Pick<FieldSummary, "cycle">): string {
  const cycle = field.cycle;
  if (!cycle) return "No crop";
  if (!cycle.companion) return cycle.cropName;
  const companion = cycle.companion.cropName;
  return `${cycle.cropName} + ${companion.charAt(0).toLowerCase()}${companion.slice(1)}`;
}
export const chipItemOf = (field: FieldSummary): FieldChipItem => ({ id: field.id, name: field.name, crop: summaryCrop(field), cropId: field.cycle?.cropId ?? null });

/** "0.62 on 27 Oct" (with the year when it differs), or null when the field has no stored reading. */
export function greennessText(field: Pick<FieldSummary, "greenness">): string | null {
  const g = field.greenness;
  return g ? `${formatIndex(g.ndvi)} on ${formatDay(g.observedOn, false)}` : null;
}

export function FieldChips(props: { items: readonly FieldChipItem[]; selected: string | null | undefined; onSelect: (fieldId: string | null) => void }) {
  return (
    <div class="today-field-chips" role="group" aria-label="Choose a field" data-testid="today-field-chips">
      <button type="button" class="today-field-chip" aria-pressed={!props.selected} data-field-chip="all" onClick={() => props.onSelect(null)}>
        <Icon name="grid" size={14} />
        <span class="today-field-chip-name">All fields</span>
      </button>
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            class="today-field-chip"
            aria-pressed={props.selected === item.id}
            data-field-chip={item.id}
            onClick={() => props.onSelect(item.id)}
          >
            <span class="today-field-swatch" style={{ background: cropColor(item.cropId) }} aria-hidden="true" />
            <span class="today-field-chip-name">{item.name}</span>
            <span class="today-field-chip-crop">{item.crop}</span>
          </button>
        )}
      </For>
    </div>
  );
}

/** Legend under the farm scene: each field's number (its position in the stored order, matching the numbered badge on narrow satellite fields), crop colour, name, crop and latest stored greenness (or "No reading yet"). */
export function FieldsLegend(props: { fields: readonly FieldSummary[] }) {
  return (
    <ul class="today-field-legend" aria-label="Fields on the farm" data-testid="today-field-legend">
      <For each={props.fields}>
        {(field, index) => (
          <li data-field-id={field.id}>
            <span class="today-field-num" data-field-number={index() + 1} title={`Field ${index() + 1}, the number on the satellite image`}>
              {index() + 1}
            </span>
            <span class="today-field-swatch" style={{ background: cropColor(field.cycle?.cropId) }} aria-hidden="true" />
            <strong>{field.name}</strong>
            <span class="today-field-legend-crop">{summaryCrop(field)}</span>
            <Show
              when={greennessText(field)}
              fallback={
                <span class="today-chip" title="No satellite reading is stored for this field yet; open the field to fetch one">
                  No reading yet
                </span>
              }
            >
              {(text) => (
                <span class={`today-chip verdict ${field.greenness!.verdict}`} title={`Greenness (NDVI) ${text()}, ${verdictLabel[field.greenness!.verdict].toLowerCase()}`}>
                  NDVI {text()}
                </span>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * "Your fields": one row per field. The field name is a button (keyboard), and a click anywhere on the row opens the field
 * too. On a phone each row becomes a small card with labelled values (CSS, `data-label`), so the page never scrolls sideways.
 */
export function FieldsTable(props: { fields: readonly FieldSummary[]; selected?: string | null | undefined; onSelect: (fieldId: string) => void }) {
  return (
    <section class="today-fields" aria-labelledby="today-fields-title" data-testid="today-fields-table">
      <h2 id="today-fields-title">Your fields</h2>
      <table class="today-fields-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Crop</th>
            <th scope="col">Stage</th>
            <th scope="col">Harvest in</th>
            <th scope="col">Greenness</th>
            <th scope="col">Alerts (incl. farm-wide)</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.fields}>
            {(field, index) => (
              <tr data-field-row={field.id} classList={{ "is-selected": props.selected === field.id }} onClick={() => props.onSelect(field.id)}>
                <th scope="row">
                  <button
                    type="button"
                    class="today-fields-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onSelect(field.id);
                    }}
                  >
                    <span class="today-field-num" data-field-number={index() + 1} aria-hidden="true">
                      {index() + 1}
                    </span>
                    <span class="today-field-swatch" style={{ background: cropColor(field.cycle?.cropId) }} aria-hidden="true" />
                    <span>{field.name}</span>
                    <Icon name="arrow" size={13} />
                  </button>
                  <span class="today-fields-area">{areaText(field.areaHa)}</span>
                </th>
                <td data-label="Crop">{summaryCrop(field)}</td>
                <td data-label="Stage">{field.cycle ? field.cycle.stage?.name ?? "Stage dates not available" : "Not planted"}</td>
                <td data-label="Harvest in">{field.cycle ? harvestInText(field.cycle.daysToHarvest) ?? "Not available" : "—"}</td>
                <td data-label="Greenness">
                  <Show when={greennessText(field)} fallback={<span class="today-fields-muted">No reading yet</span>}>
                    {(text) => (
                      <>
                        {text()}
                        <span class="today-fields-muted"> · {verdictLabel[field.greenness!.verdict]}</span>
                      </>
                    )}
                  </Show>
                </td>
                <td data-label="Alerts (incl. farm-wide)" title="Alerts on this field plus farm-wide alerts, which are counted on every field">{field.alertCount === 0 ? "None" : field.alertCount}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}
