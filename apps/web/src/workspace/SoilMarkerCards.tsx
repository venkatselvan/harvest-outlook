import "./soil-marker-cards.css";
import { SoilPrintedReference } from "./SoilPrintedReference";
import type {
  FarmSoilMarkers,
  SoilParameter,
  SoilReport,
} from "@harvest/contracts";
import { For, Show, createSignal, createEffect, on } from "solid-js";
import { dateLabel } from "./state";
import { SOIL_BASELINE, soilLabel } from "./soil";
import { Icon } from "./icons";
export function SoilMarkerCards(props: {
  data?: FarmSoilMarkers | undefined;
  onReport?: (reportId: string, page?: number) => void;
}) {
  const [sampleId, setSampleId] = createSignal("");
  const samples = () =>
    [...(props.data?.samples ?? [])].sort((a, b) =>
      (b.collectionDate ?? b.reportDate ?? b.confirmedAt).localeCompare(
        a.collectionDate ?? a.reportDate ?? a.confirmedAt,
      ),
    );
  createEffect(
    on(
      () =>
        samples()
          .map((s) => s.id)
          .join("|"),
      () => {
        if (!samples().some((s) => s.id === sampleId()))
          setSampleId(samples()[0]?.id ?? "");
      },
    ),
  );
  const sample = () =>
    samples().find((s) => s.id === sampleId()) ?? samples()[0];
  const confirmed = () =>
    sample()?.markers.filter((m) => m.reviewStatus === "confirmed") ?? [];
  type Card = {
    parameter: SoilParameter;
    marker: FarmSoilMarkers["samples"][number]["markers"][number] | undefined;
  };
  const cards = () => [
    ...SOIL_BASELINE.flatMap<Card>((parameter) => {
      const matches = confirmed().filter((m) => m.parameter === parameter);
      return matches.length
        ? matches.map((marker) => ({ parameter, marker }))
        : [{ parameter, marker: undefined }];
    }),
    ...confirmed()
      .filter((m) => !SOIL_BASELINE.includes(m.parameter))
      .map((marker) => ({ parameter: marker.parameter, marker })),
  ];
  return (
    <section class="soil-markers-section" aria-label="Confirmed soil markers">
      <div class="section-heading">
        <div>
          <Icon name="layers" />
          <h2>Soil markers</h2>
          <span class="tiny-pill">
            {sample()
              ? `${sample()!.markers.filter((m) => m.reviewStatus === "confirmed").length} confirmed values`
              : "No confirmed measurements"}
          </span>
        </div>
        <Show when={samples().length}>
          <label class="soil-sample-select">
            Sample
            <select
              aria-label="Soil sample"
              value={sampleId()}
              onChange={(e) => setSampleId(e.currentTarget.value)}
            >
              <For each={samples()}>
                {(s) => (
                  <option value={s.id} selected={s.id === sampleId()}>
                    {s.sampleLabel ?? "Unnamed sample"} ·{" "}
                    {s.collectionDate
                      ? dateLabel(s.collectionDate)
                      : s.reportDate
                        ? `Report ${dateLabel(s.reportDate)}`
                        : "Date unreported"}
                    {s.depth
                      ? ` · ${s.depth.from}–${s.depth.to} ${s.depth.unit}`
                      : ""}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
      </div>

      <Show when={sample()}>
        {(s) => (
          <details class="soil-sample-details"><summary>Report details</summary>
          <div class="soil-sample-provenance">
            <span>
              <Icon name="calendar" size={14} />
              {s().collectionDate
                ? `Collected ${dateLabel(s().collectionDate!)}`
                : "Collection date unreported"}
            </span>
            <Show when={s().receivedDate}>
              <span>Received {dateLabel(s().receivedDate!)}</span>
            </Show>
            <Show when={s().reportDate}>
              <span>Report {dateLabel(s().reportDate!)}</span>
            </Show>
            <span>{s().laboratory ?? "Laboratory unreported"}</span>
            <Show when={s().depth}>
              <span>
                Depth {s().depth!.from}–{s().depth!.to} {s().depth!.unit}
              </span>
            </Show>
            <button
              class="text-button"
              onClick={() => props.onReport?.(s().reportId)}
            >
              View report & review trail
              <Icon name="arrow" size={14} />
            </button>
          </div>
          </details>
        )}
      </Show>
      <div class="soil-marker-grid">
        <For each={cards().filter(entry => entry.marker)}>
          {(entry) => (
            <article
              class={`soil-marker-card ${entry.marker ? "measured" : "unmeasured"}`}
            >
              <div class="soil-marker-top">
                <span>
                  {entry.marker?.rawLabel ?? soilLabel(entry.parameter)}
                </span>
                <Icon
                  name={entry.parameter === "ph" ? "target" : "leaf"}
                  size={16}
                />
              </div>
              <Show
                when={entry.marker}
                fallback={
                  <>
                    <strong class="soil-marker-empty">—</strong>
                    <p>No confirmed measurement</p>
                  </>
                }
              >
                {(m) => (
                  <>
                    <div class="soil-marker-value">
                      <strong>{m().rawValue}</strong>
                      <span>
                        {m().rawUnit ??
                          (entry.parameter === "ph"
                            ? "dimensionless"
                            : "unit unreported")}
                      </span>
                    </div>
                    <details class="soil-marker-details"><summary>Details</summary>
                    <p class="soil-marker-method">
                      {m().analyteForm ??
                        (entry.parameter === "unknown_other"
                          ? "Analyte identity unclassified"
                          : soilLabel(entry.parameter))}
                    </p>
                    <p class="soil-marker-method">
                      {[m().method, m().extractant, m().soilWaterRatio]
                        .filter(Boolean)
                        .join(" · ") || "Method unreported"}
                    </p>
                    <SoilPrintedReference
                      marker={m()}
                      onPage={(page) =>
                        sample() && props.onReport?.(sample()!.reportId, page)
                      }
                    />
                    <Show when={m().reportedRating}>
                      <p class="soil-lab-rating">
                        Lab rating: “{m().reportedRating}”
                      </p>
                    </Show>
                    <div class="soil-marker-bottom">
                      <span>Confirmed from report</span>
                      <button
                        class="text-button"
                        onClick={() =>
                          sample() &&
                          props.onReport?.(
                            sample()!.reportId,
                            m().evidence.page,
                          )
                        }
                      >
                        p. {m().evidence.page}
                        <Icon name="arrow" size={12} />
                      </button>
                    </div>
                    <details>
                      <summary>
                        Measurement context
                        {m().warnings.length
                          ? ` · ${m().warnings.length} flags`
                          : ""}
                      </summary>
                      <p>
                        Matrix: {m().matrix} · mass basis:{" "}
                        {m().massBasis ?? "unreported"}
                      </p>
                      <p>
                        Analyte: {m().analyteForm ?? "unreported"} ·
                        temperature:{" "}
                        {m().temperatureC === null
                          ? "unreported"
                          : `${m().temperatureC} °C`}
                      </p>
                      <Show when={m().canonical.missingReason}>
                        <p>
                          Normalization withheld: {m().canonical.missingReason}
                        </p>
                      </Show>
                      <For each={m().warnings}>
                        {(warning) => <p>{warning}</p>}
                      </For>
                    </details>
                    <Show when={m().canonical.conversion}>
                      <details>
                        <summary>Unit normalization</summary>
                        <p>
                          {m().canonical.value} {m().canonical.unit} ·{" "}
                          {m().canonical.conversion!.formula}
                        </p>
                      </details>
                    </Show>
                    </details>
                  </>
                )}
              </Show>
            </article>
          )}
        </For>
      </div>
      <Show when={cards().some(entry => !entry.marker)}>
        <details class="soil-missing-markers"><summary>Not reported ({cards().filter(entry => !entry.marker).length})</summary>
          <ul><For each={cards().filter(entry => !entry.marker)}>{entry => <li>{soilLabel(entry.parameter)} · No confirmed measurement</li>}</For></ul>
        </details>
      </Show>
      <Show when={!sample()}>
        <div class="soil-unmeasured-note">
          <Icon name="journal" size={18} />
          <p>
            Upload a soil report and review Evara’s extraction to add
            measurements for this farm. A map, crop choice or public sample does
            not establish its soil condition.
          </p>
        </div>
      </Show>
      <Show when={props.data?.limitations.length}>
        <details class="soil-missing-markers"><summary>About these results</summary>
          <For each={props.data?.limitations ?? []}>{line => <p class="soil-data-limitation">{line}</p>}</For>
        </details>
      </Show>
    </section>
  );
}

export function SoilReferenceCards(props: {
  report: SoilReport;
  farmName: string;
  onReview: (page?: number) => void;
}) {
  const draft = () => props.report.reviewed ?? props.report.extraction;
  const [selected, setSelected] = createSignal("");
  const samples = () => draft()?.samples ?? [];
  const sample = () =>
    samples().find((sample) => sample.id === selected()) ?? samples()[0];
  const [filter, setFilter] = createSignal("");
  const ordered = () =>
    [...(sample()?.markers ?? [])].sort((a, b) => {
      const ai = SOIL_BASELINE.indexOf(a.parameter),
        bi = SOIL_BASELINE.indexOf(b.parameter);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
  const shown = () =>
    ordered().filter((marker) =>
      [
        marker.rawLabel,
        marker.rawValue,
        marker.rawUnit,
        marker.analyteForm,
        marker.method,
        marker.matrix,
        soilLabel(marker.parameter),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(filter().trim().toLowerCase()),
    );
  return (
    <section
      class="soil-markers-section soil-reference-markers"
      aria-label="Sample marker overview"
    >
      <div class="section-heading">
        <div>
          <Icon name="layers" />
          <h2>Sample results</h2>
          <span class="tiny-pill">
            {props.report.reviewed
              ? "Reviewed reference record"
              : "Draft extraction · needs review"}
          </span>
        </div>
        <button class="text-button" onClick={() => props.onReview()}>
          Review source extraction
          <Icon name="arrow" size={14} />
        </button>
      </div>
      <div class="soil-reference-card-notice">
        <strong>
          Sample report · not added to {props.farmName}
        </strong>
        <p>
          {props.report.referenceSource?.title ?? props.report.filename}. These
          values stay outside farm measurements and recommendations.
        </p>
      </div>
      <Show when={samples().length > 1}>
        <label class="soil-sample-select">
          Reference sample
          <select
            aria-label="Reference soil sample"
            value={sample()?.id ?? ""}
            onChange={(e) => setSelected(e.currentTarget.value)}
          >
            <For each={samples()}>
              {(s) => (
                <option value={s.id}>
                  {s.sampleLabel ?? "Unnamed reference sample"}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <Show when={sample()}>
        {(s) => (
          <>
            <div class="soil-sample-provenance">
              <span>{s().sampleLabel ?? "Sample label unreported"}</span>
              <span>
                {s().collectionDate
                  ? `Collected ${dateLabel(s().collectionDate!)}`
                  : "Collection date unreported"}
              </span>
              <Show when={s().receivedDate ?? draft()?.receivedDate}>
                <span>
                  Received{" "}
                  {dateLabel((s().receivedDate ?? draft()?.receivedDate)!)}
                </span>
              </Show>
              <Show when={s().reportDate ?? draft()?.reportDate}>
                <span>
                  Report {dateLabel((s().reportDate ?? draft()?.reportDate)!)}
                </span>
              </Show>
              <span>
                {s().laboratory ??
                  draft()?.laboratory ??
                  "Laboratory unreported"}
              </span>
              <span>
                {s().depth
                  ? `${s().depth!.from}–${s().depth!.to} ${s().depth!.unit}`
                  : "Depth unreported"}
              </span>
            </div>
            <div class="soil-marker-search">
              <label>
                Search soil markers
                <input
                  aria-label="Search soil markers"
                  type="search"
                  value={filter()}
                  placeholder="Find pH, available nitrogen, digested iron…"
                  onInput={(e) => setFilter(e.currentTarget.value)}
                />
              </label>
              <span>
                {shown().length} of {s().markers.length} values · SHC parameters
                first; other pools kept separate
              </span>
            </div>
            <div class="soil-marker-grid">
              <For each={shown()}>
                {(marker) => (
                  <article class="soil-marker-card reference-value">
                    <div class="soil-marker-top">
                      <span>{marker.rawLabel}</span>
                      <Icon name="journal" size={15} />
                    </div>
                    <div
                      class={`soil-marker-value ${marker.rawValue.length > 14 ? "text-value" : ""}`}
                    >
                      <strong>{marker.rawValue}</strong>
                      <span>
                        {marker.rawUnit ??
                          (marker.parameter === "ph"
                            ? "dimensionless"
                            : "unit unreported")}
                      </span>
                    </div>
                    <details class="soil-marker-details"><summary>Details</summary>
                    <p class="soil-marker-method">
                      {marker.analyteForm ??
                        (marker.parameter === "unknown_other"
                          ? "Analyte pool unclassified"
                          : soilLabel(marker.parameter))}
                    </p>
                    <p class="soil-marker-method">
                      {[marker.method, marker.extractant, marker.soilWaterRatio]
                        .filter(Boolean)
                        .join(" · ") || "Method unreported"}
                    </p>
                    <SoilPrintedReference
                      marker={marker}
                      onPage={(page) => props.onReview(page)}
                    />
                    <Show when={marker.reportedRating}>
                      <p class="soil-lab-rating">
                        Lab rating: “{marker.reportedRating}”
                      </p>
                    </Show>
                    <div class="soil-marker-bottom">
                      <span>
                        {marker.extractionConfidence} extraction confidence
                      </span>
                      <button
                        class="text-button"
                        onClick={() => props.onReview(marker.evidence.page)}
                      >
                        p. {marker.evidence.page}
                        <Icon name="arrow" size={12} />
                      </button>
                    </div>
                    <details>
                      <summary>Measurement context</summary>
                      <p>
                        Matrix: {marker.matrix} · mass basis:{" "}
                        {marker.massBasis ?? "unreported"}
                      </p>
                      <p>
                        Analyte: {marker.analyteForm ?? "unreported"} ·
                        temperature:{" "}
                        {marker.temperatureC === null
                          ? "unreported"
                          : `${marker.temperatureC} °C`}
                      </p>
                    </details>
                    <Show when={marker.warnings.length}>
                      <details>
                        <summary>
                          Reading flags ({marker.warnings.length})
                        </summary>
                        <For each={marker.warnings}>
                          {(warning) => <p>{warning}</p>}
                        </For>
                      </details>
                    </Show>
                    </details>
                  </article>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <div class="soil-reference-links">
        <Show when={props.report.referenceSource?.url}>
          <a
            href={props.report.referenceSource!.url!}
            target="_blank"
            rel="noreferrer"
          >
            View public source ↗
          </a>
        </Show>
        <a href={props.report.originalUrl} download={props.report.filename}>
          Download report
        </a>
        <details>
          <summary>Source & extraction provenance</summary>
          <For each={props.report.referenceSource?.limitations ?? []}>
            {(line) => <p>{line}</p>}
          </For>
          <p>
            Extraction model:{" "}
            {props.report.modelInvocation?.model ??
              props.report.modelInvocation?.requestedModel ??
              "Metadata unavailable"}{" "}
            · {props.report.modelInvocation?.status ?? "Status unavailable"}
          </p>
        </details>
      </div>
    </section>
  );
}
