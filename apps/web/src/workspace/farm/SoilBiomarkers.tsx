import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import type { SoilReading } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { Sheet } from "../ui/Sheet";
import {
  bandRangeText,
  bandSegments,
  barDescription,
  barPosition,
  beyondAxis,
  needText,
  otherStatusText,
  ratedAsText,
  ratingChipTone,
  ratingLabel,
  sampleDateText,
  splitReadings,
  valueText,
  zoneIndexOf,
  zoneTone,
} from "./soilReviewModel";
import "./soil-review.css";

/**
 * Soil values as biomarker rows (ROUND2_SPEC.md 5.3). Each rated reading is a row: label, printed value with unit, a
 * horizontal band bar coloured per zone with the value marked on it, the rating chip ("Assumed form" when the rating rests
 * on an inferred form) and the sample date; tapping opens a sheet with the zones, source, method, assumption and the
 * crop needs. Readings that could not be rated sit in a collapsed "Other values" list with the reason. Ratings, bands and
 * axes come from the server; nothing here rates anything.
 */
const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

/** The band bar: zones tile the axis, the marker sits at the value (pinned to an edge when it is beyond the scale). */
export function BiomarkerBar(props: { reading: SoilReading; tall?: boolean }) {
  const segments = () => bandSegments(props.reading.bands, props.reading.axis);
  const position = () => barPosition(props.reading.ratedValue, props.reading.axis);
  const edge = () => beyondAxis(props.reading.ratedValue, props.reading.axis);
  return (
    <div class={`sb-bar${props.tall ? " sb-bar-tall" : ""}`} role="img" aria-label={barDescription(props.reading)}>
      <div class="sb-track">
        <For each={segments()}>
          {(segment) => <span class={`sb-zone sb-zone-${segment.tone}`} style={{ left: pct(segment.left), width: pct(segment.width) }} />}
        </For>
      </div>
      <Show when={position() !== null}>
        <span class={`sb-marker${edge() ? " sb-marker-edge" : ""}`} style={{ left: pct(position() ?? 0) }} aria-hidden="true" />
      </Show>
    </div>
  );
}

function Need(props: { title: string; need: NonNullable<SoilReading["cropNeed"]> }) {
  return (
    <div class="sb-need">
      <dt>{props.title}</dt>
      <dd>
        <strong>
          {props.need.cropName}: {needText(props.need.need)}
        </strong>
        <Show when={props.need.note}>
          <span class="sb-note">{props.need.note}</span>
        </Show>
      </dd>
    </div>
  );
}

/** Body of the reading sheet: zones, how it was rated, assumption, source, method, sample and the crop needs. */
export function ReadingDetail(props: { reading: SoilReading }) {
  const r = () => props.reading;
  const current = () => zoneIndexOf(r());
  return (
    <div class="sb-detail">
      <BiomarkerBar reading={r()} tall />
      <ol class="sb-zones" aria-label="Zones on this scale">
        <For each={r().bands}>
          {(band, i) => (
            <li class={i() === current() ? "is-current" : ""}>
              <span class={`sb-swatch sb-zone-${zoneTone(band.label)}`} aria-hidden="true" />
              <span class="sb-zone-name">{ratingLabel(band.label)}</span>
              <span class="sb-zone-range">{bandRangeText(band)}</span>
              <Show when={i() === current()}>
                <span class="sb-zone-here">Your value</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={ratedAsText(r())}>
        <p class="sb-rated-as">{ratedAsText(r())}.</p>
      </Show>
      <Show when={r().assumption}>
        <section class="sb-callout" aria-label="Assumed form">
          <h3>Assumed form</h3>
          <p>{r().assumption}</p>
        </section>
      </Show>
      <Show when={r().note}>
        <p class="sb-note">{r().note}</p>
      </Show>
      <dl class="sb-facts">
        <div>
          <dt>Sample</dt>
          <dd>{sampleDateText(r().collectionDate) ? `Taken ${sampleDateText(r().collectionDate)}` : "Sample date not printed on the report"}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{r().method ?? "Not printed on the report"}</dd>
        </div>
        <Show when={r().source}>
          <div>
            <dt>Rating source</dt>
            <dd>
              <span>{r().source!.title}</span>
              <Show when={r().source!.locator}>
                <span class="sb-note">{r().source!.locator}</span>
              </Show>
              <Show when={r().source!.url}>
                <a class="text-link" href={r().source!.url!} target="_blank" rel="noopener noreferrer">
                  Open the source
                </a>
              </Show>
            </dd>
          </div>
        </Show>
        <Show when={r().cropNeed}>
          <Need title="Current crop" need={r().cropNeed!} />
        </Show>
        <Show when={r().nextCropNeed}>
          <Need title="Next crop" need={r().nextCropNeed!} />
        </Show>
      </dl>
      <p class="sb-footnote">Rating compares your value with the cited bands. It is not a fertilizer dose.</p>
    </div>
  );
}

/** Readings that could not be rated: the printed value and the reason, collapsed by default. */
export function OtherValues(props: { readings: readonly SoilReading[] }) {
  return (
    <Show when={props.readings.length > 0}>
      <details class="sb-other">
        <summary>Other values ({props.readings.length})</summary>
        <ul class="sb-other-list">
          <For each={props.readings}>
            {(r) => (
              <li>
                <div class="sb-other-head">
                  <span class="sb-label">{r.label}</span>
                  <span class="sb-value">{valueText(r)}</span>
                </div>
                <div class="sb-row-foot">
                  <Chip tone="neutral">{otherStatusText(r.status)}</Chip>
                  <Show when={sampleDateText(r.collectionDate)}>
                    <span class="sb-date">Sampled {sampleDateText(r.collectionDate)}</span>
                  </Show>
                </div>
                <Show when={r.note}>
                  <p class="sb-note">{r.note}</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

export function SoilBiomarkers(props: { readings: readonly SoilReading[] }) {
  const split = createMemo(() => splitReadings(props.readings));
  const [open, setOpen] = createSignal<SoilReading | null>(null);
  const titleId = createUniqueId();
  return (
    <section class="sb-section" aria-labelledby={titleId}>
      <h3 id={titleId} class="sb-title">
        Your soil values
      </h3>
      <Show when={split().rated.length > 0} fallback={<p class="sb-empty">None of the confirmed values could be rated against a cited band.</p>}>
        <ul class="sb-list">
          <For each={split().rated}>
            {(r) => (
              <li class="sb-item">
                <button type="button" class="sb-row" aria-haspopup="dialog" onClick={() => setOpen(r)}>
                  <span class="sb-row-head">
                    <span class="sb-label">{r.label}</span>
                    <span class="sb-value">{valueText(r)}</span>
                  </span>
                  <Show when={ratedAsText(r)}>
                    <span class="sb-rated-as">{ratedAsText(r)}</span>
                  </Show>
                  <BiomarkerBar reading={r} />
                  <span class="sb-row-foot">
                    <Chip tone={ratingChipTone(r.rating)}>{ratingLabel(r.rating)}</Chip>
                    <Show when={r.assumption}>
                      <Chip tone="info">Assumed form</Chip>
                    </Show>
                    <Show when={sampleDateText(r.collectionDate)}>
                      <span class="sb-date">Sampled {sampleDateText(r.collectionDate)}</span>
                    </Show>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <OtherValues readings={split().other} />
      <Show when={open()}>
        <Sheet title={open()!.label} subtitle={`${valueText(open()!)} · ${ratingLabel(open()!.rating)}`} onClose={() => setOpen(null)} class="sb-sheet">
          <ReadingDetail reading={open()!} />
        </Sheet>
      </Show>
    </section>
  );
}

export default SoilBiomarkers;
