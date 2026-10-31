import { Show } from "solid-js";
import type { SoilMarkerDraft } from "@harvest/contracts";
import { printedResult } from "./soil";
type Reference = NonNullable<SoilMarkerDraft["reportedReference"]>;

/** A laboratory's printed criteria are separate from the measured result and crop requirements. */
export function SoilPrintedReference(props: {
  marker: SoilMarkerDraft;
  onPage?: (page: number) => void;
  onChange?: (reference: Reference | null) => void;
}) {
  const reference = () => props.marker.reportedReference;
  const editText = (rawText: string) => {
    const current = reference();
    if (!current) return;
    const parsed = printedResult(rawText);
    props.onChange?.({
      ...current,
      rawText,
      qualifier: ["below_detection", "unreadable"].includes(parsed.qualifier)
        ? "text"
        : (parsed.qualifier as Reference["qualifier"]),
      numericValue: parsed.numericValue,
      range: parsed.range
        ? { ...parsed.range, lowInclusive: null, highInclusive: null }
        : null,
    });
  };
  return (
    <Show when={reference()}>
      {(ref) => (
        <section
          class="soil-printed-reference"
          aria-label="This report’s printed reference"
        >
          <p class="soil-reference-kicker">THIS REPORT’S PRINTED REFERENCE</p>
          <p>
            <strong>{ref().label}</strong>: {ref().rawText}
            <Show when={ref().rawUnit}>
              {" "}
              <span>{ref().rawUnit}</span>
            </Show>
          </p>
          <p class="soil-reference-caution">
            Laboratory guidance for this report; not a crop target, measured
            result, or fertilizer prescription.
          </p>
          <details>
            <summary>
              Reference source{props.onChange ? " & correction" : ""}
            </summary>
            <blockquote>“{ref().evidence.quote}”</blockquote>
            <Show
              when={props.onPage}
              fallback={<p>Source p. {ref().evidence.page}</p>}
            >
              <button
                type="button"
                class="text-button"
                onClick={() => props.onPage?.(ref().evidence.page)}
              >
                View reference p. {ref().evidence.page}
              </button>
            </Show>
            <Show when={props.onChange}>
              <div class="form-grid">
                <label>
                  Reference column label
                  <input
                    value={ref().label}
                    required
                    maxlength="300"
                    onInput={(e) =>
                      props.onChange?.({
                        ...ref(),
                        label: e.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  Printed reference criteria
                  <input
                    value={ref().rawText}
                    required
                    maxlength="1000"
                    onInput={(e) => editText(e.currentTarget.value)}
                  />
                </label>
                <label>
                  Reference unit
                  <input
                    value={ref().rawUnit ?? ""}
                    maxlength="300"
                    placeholder="Not printed"
                    onInput={(e) =>
                      props.onChange?.({
                        ...ref(),
                        rawUnit: e.currentTarget.value || null,
                      })
                    }
                  />
                </label>
                <label>
                  Reference source page
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={ref().evidence.page}
                    onInput={(e) =>
                      props.onChange?.({
                        ...ref(),
                        evidence: {
                          ...ref().evidence,
                          page: Number(e.currentTarget.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <button
                type="button"
                class="text-button"
                onClick={() => props.onChange?.(null)}
              >
                Remove incorrectly extracted reference
              </button>
            </Show>
          </details>
        </section>
      )}
    </Show>
  );
}
