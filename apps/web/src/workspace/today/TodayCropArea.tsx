import { For, Show } from "solid-js";
import type { FieldSummary } from "@harvest/contracts";
import { cropColor, formatDay } from "./model";

/** Recorded polygon areas grouped by main crop; intercrops are never counted twice. */
export function cropAreas(fields: readonly FieldSummary[]) {
  const groups = new Map<string, { id: string; name: string; area: number; fields: number }>();
  for (const field of fields) {
    const id = field.cycle?.cropId ?? "unplanted";
    const row = groups.get(id) ?? { id, name: field.cycle?.cropName ?? "No active crop", area: 0, fields: 0 };
    row.area += field.areaHa;
    row.fields++;
    groups.set(id, row);
  }
  return [...groups.values()].sort((a, b) => b.area - a.area);
}

/** A factual crop-area composition, instead of combining unrelated indices into an invented agronomic score. */
export function TodayCropArea(props: { fields: readonly FieldSummary[] }) {
  const rows = () => cropAreas(props.fields);
  const total = () => rows().reduce((sum, row) => sum + row.area, 0);
  const number = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return (
    <Show when={props.fields.length}>
      <section class="today-crop-area" aria-labelledby="today-crop-area-title">
        <div class="today-section-head"><h2 id="today-crop-area-title">Across your fields</h2><span class="today-chip">{number(total())} ha</span></div>
        <Show when={total() > 0}>
          <div class="today-crop-area-bar" aria-hidden="true">
            <For each={rows()}>{(row) => <span style={{ width: `${row.area / total() * 100}%`, background: cropColor(row.id) }} />}</For>
          </div>
        </Show>
        <ul>
          <For each={rows()}>{(row) => (
            <li><span class="today-field-swatch" style={{ background: cropColor(row.id) }} /><span>{row.name}</span><strong>{number(row.area)} ha</strong><small>{row.fields} {row.fields === 1 ? "field" : "fields"}</small></li>
          )}</For>
        </ul>
        <TodayGreennessWeb fields={props.fields} />
        <p class="today-note">Drawn field areas, not a survey. Grouped by main crop; companion crops share the same area.</p>
      </section>
    </Show>
  );
}

/** One common raw NDVI scale, never a composite health or crop-fitness score. Missing readings are not plotted. */
export function TodayGreennessWeb(props: { fields: readonly FieldSummary[] }) {
  const active = () => props.fields.filter((field) => field.cycle);
  const readings = () => active().filter((field) => field.greenness && Number.isFinite(field.greenness.ndvi) && field.greenness.ndvi >= -1 && field.greenness.ndvi <= 1);
  const canDraw = () => readings().length >= 3 && readings().length <= 8;
  const point = (index: number, radius: number) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / readings().length;
    return [150 + Math.cos(angle) * radius, 150 + Math.sin(angle) * radius];
  };
  const ring = (radius: number) => readings().map((_, index) => point(index, radius).join(",")).join(" ");
  return <Show when={active().length}>
    <div class="today-greenness-web">
      <h3>Active crops · greenness</h3>
      <p class="today-note">Raw satellite NDVI by field, on the same −1 to 1 scale. This compares greenness, not crop fitness.</p>
      <Show when={canDraw()} fallback={<p class="today-note">{readings().length > 8 ? "The web supports up to eight measured fields; all field readings are listed below." : "At least three fields with valid satellite readings are needed for a web."}</p>}>
        <svg viewBox="0 0 300 300" role="img" aria-label="Active field greenness web. Centre minus one NDVI, middle ring zero, outer ring one. Values and observation dates are listed below.">
          <polygon points={ring(78)} class="today-web-grid" />
          <polygon points={ring(39)} class="today-web-grid" />
          <For each={readings()}>{(field, index) => <>
            <line x1="150" y1="150" x2={point(index(), 78)[0]} y2={point(index(), 78)[1]} class="today-web-grid" />
            <text x={point(index(), 101)[0]} y={point(index(), 101)[1]} text-anchor="middle" dominant-baseline="middle">{index() + 1}</text>
          </>}</For>
          <polygon points={readings().map((field, index) => point(index, (field.greenness!.ndvi + 1) / 2 * 78).join(",")).join(" ")} class="today-web-shape" />
          <text x="155" y="145" class="today-web-scale">−1</text><text x="155" y="108" class="today-web-scale">0</text><text x="155" y="69" class="today-web-scale">1</text>
        </svg>
      </Show>
      <ul class="today-web-values">
        <For each={active()}>{(field) => <li>
          <span>{canDraw() && readings().some((reading) => reading.id === field.id) ? `${readings().findIndex((reading) => reading.id === field.id) + 1}. ` : ""}{field.name} · {field.cycle!.cropName}</span>
          <strong>{readings().some((reading) => reading.id === field.id) ? field.greenness!.ndvi.toFixed(2) : "Unavailable"}</strong>
          <small>{readings().some((reading) => reading.id === field.id) ? `Observed ${formatDay(field.greenness!.observedOn)}` : "No valid satellite reading"}</small>
        </li>}</For>
      </ul>
      <Show when={canDraw() && readings().length < active().length}><p class="today-note">Fields without readings are omitted from the web and listed as unavailable.</p></Show>
    </div>
  </Show>;
}
