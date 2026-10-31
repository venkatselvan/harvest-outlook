import { For, Show, createEffect, createSignal, on } from "solid-js";
import { Evara } from "./Evara";
import type { BoundaryAssessment } from "@harvest/contracts";
export type { BoundaryAssessment } from "@harvest/contracts";
export type BoundaryContext = Pick<
  BoundaryAssessment,
  "location" | "sources" | "areaHectares" | "centroid" | "suggestedName"
>;
export function BoundaryAssessmentCard(props: {
  assessment: BoundaryAssessment | null;
  context: BoundaryContext | null;
  loading: boolean;
  error: string;
  accepted: boolean;
  onAccept: () => void;
  onRetry: () => void;
}) {
  const [previewFailed, setPreviewFailed] = createSignal(false);
  createEffect(
    on(
      () => props.assessment?.imagery.previewUrl,
      () => setPreviewFailed(false),
    ),
  );
  const imageDate = () => {
    const raw = props.assessment?.imagery.imageryDate;
    if (!raw) return "image date unknown";
    const date = new Date(raw);
    return Number.isNaN(date.getTime())
      ? raw
      : date.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
  };
  const context = () => props.context ?? props.assessment;
  const irrigation = () => props.assessment?.suggestions.irrigation;
  const land = () => props.assessment?.suggestions.landCondition;
  const label = (value: string) =>
    (
      ({
        rainfed: "Rainfed",
        supplemental: "Rain + supplemental irrigation",
        irrigated: "Irrigated",
        unknown: "Not established",
      }) as Record<string, string>
    )[value] ?? value;
  return (
    <section
      class="boundary-assessment-card"
      aria-label="Evara boundary review"
    >
      <div class="assessment-heading">
        <Evara size={37} />
        <div>
          <strong>Evara's first look</strong>
          <span>
            {props.loading
              ? context()
                ? "Location ready · reviewing the evidence…"
                : "Locating your boundary…"
              : props.assessment?.modelInvocation?.status === "succeeded"
                ? "Evidence-aware model assessment"
                : props.assessment?.modelInvocation?.status === "failed"
                  ? "Context only · model review unavailable"
                  : "Map-derived context"}
          </span>
        </div>
        <Show when={props.assessment?.status}>
          <span class="tiny-pill">{props.assessment?.status}</span>
        </Show>
      </div>
      <Show when={props.loading}>
        <p class="assessment-loading" role="status">
          {context()
            ? "The map-derived fields are ready to review. Evara is checking the available imagery and regional evidence; irrigation stays unconfirmed."
            : "Matching your boundary to an administrative area. Your manual edits stay yours."}
        </p>
      </Show>
      <Show when={props.error}>
        <p class="inline-error" role="alert">
          {props.error}
          <button class="text-button" onClick={props.onRetry}>
            Try again
          </button>
        </p>
      </Show>
      <Show when={context()}>
        <div class="assessment-location-source">
          <strong>
            {[context()?.location.districtName, context()?.location.stateName]
              .filter(Boolean)
              .join(", ") || "Location not resolved"}
          </strong>
          <p>
            {context()?.location.source ?? "No administrative source available"}{" "}
            · {context()?.areaHectares.toFixed(2)} ha from the drawn boundary
          </p>
          <p>
            Prefilled fields are suggestions. Check the name and district before
            saving.
          </p>
          <Show when={context()?.location.uncertainties?.length}>
            <p>{context()?.location.uncertainties.join(" ")}</p>
          </Show>
        </div>
      </Show>
      <Show when={props.assessment && !props.loading}>
        <Show
          when={
            props.assessment?.imagery?.kind &&
            props.assessment?.imagery.kind !== "none"
          }
        >
          <div class="assessment-imagery-source">
            <Show when={props.assessment?.imagery.previewUrl}>
              <figure class="assessment-preview">
                <Show
                  when={!previewFailed()}
                  fallback={
                    <div class="assessment-preview-error" role="status">
                      The private reference image could not be loaded. Its dated
                      source information is shown below.
                    </div>
                  }
                >
                  <a
                    href={props.assessment!.imagery.previewUrl!}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open assessment reference image at full size"
                  >
                    <img
                      src={props.assessment!.imagery.previewUrl!}
                      alt={
                        props.assessment?.imagery.kind === "farmer_photo"
                          ? "Farmer field photo used for Evara's assessment."
                          : `Satellite reference image from ${imageDate()} with the farm boundary outlined in red.`
                      }
                      decoding="async"
                      onError={() => setPreviewFailed(true)}
                    />
                  </a>
                </Show>
                <figcaption>
                  {props.assessment?.imagery.kind === "farmer_photo"
                    ? "Photo used for this review"
                    : "Your boundary is outlined in red · reference imagery"}
                </figcaption>
              </figure>
            </Show>
            <strong>
              {props.assessment?.imagery.kind === "farmer_photo"
                ? "Farmer photo"
                : "Map imagery"}{" "}
              · {imageDate()}
            </strong>
            <p>
              {props.assessment?.imagery.attribution ??
                props.assessment?.imagery.source ??
                "Image source not specified"}
            </p>
            <Show when={props.assessment?.imagery.capturedAt}>
              <p>
                Acquired for this review{" "}
                {new Date(props.assessment!.imagery.capturedAt!).toLocaleString(
                  "en-IN",
                  {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  },
                )}
                . Acquisition time is not the imagery date.
              </p>
            </Show>
            <For each={props.assessment?.imagery.limitations ?? []}>
              {(limitation) => <p>{limitation}</p>}
            </For>
          </div>
        </Show>
        <Show when={props.assessment?.weather?.issuedAt}>
          <div class="assessment-weather-source">
            <strong>Regional weather context</strong>
            <p>
              {props.assessment?.weather.attribution} · issued{" "}
              {new Date(props.assessment!.weather.issuedAt!).toLocaleString(
                "en-IN",
                {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                },
              )}
            </p>
            <p>
              Regional weather does not establish this field's irrigation or
              soil moisture.
            </p>
          </div>
        </Show>
        <Show when={irrigation()}>
          <div class="assessment-suggestion">
            <div>
              <strong>Water access: {label(irrigation()!.value)}</strong>
              <span>
                {irrigation()!.confidence} confidence
                {props.assessment?.modelInvocation ? " (uncalibrated)" : ""} ·
                not confirmed
              </span>
            </div>
            <p>{irrigation()?.reason}</p>
            <Show when={irrigation()?.value !== "unknown"}>
              <button
                class="btn secondary compact"
                type="button"
                onClick={props.onAccept}
                disabled={props.accepted}
              >
                {props.accepted ? "Suggestion accepted" : "Use this suggestion"}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={land()?.summary}>
          <div class="assessment-land">
            <strong>Land conditions</strong>
            <p>{land()?.summary}</p>
            <span>
              {land()?.confidence} confidence
              {props.assessment?.modelInvocation ? " (uncalibrated)" : ""} · no
              soil sensor or soil test
            </span>
          </div>
        </Show>
        <details class="assessment-evidence">
          <summary>Sources, uncertainty & limitations</summary>
          <Show when={props.assessment?.modelInvocation}>
            <p>
              Model:{" "}
              {props.assessment?.modelInvocation?.model ??
                props.assessment?.modelInvocation?.requestedModel}{" "}
              · {props.assessment?.modelInvocation?.status}
            </p>
          </Show>
          <For each={props.assessment?.sources ?? []}>
            {(source) => (
              <p>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>{" "}
                · {source.attribution}
                <Show when={source.limitations.length}>
                  <span> {source.limitations.join(" ")}</span>
                </Show>
              </p>
            )}
          </For>
          <For
            each={[
              ...new Set([
                ...(irrigation()?.uncertainties ?? []),
                ...(land()?.uncertainties ?? []),
                ...(props.assessment?.limitations ?? []),
              ]),
            ]}
          >
            {(limitation) => <p>{limitation}</p>}
          </For>
        </details>
      </Show>
    </section>
  );
}
