import { Index, Show } from "solid-js";
import type { PhotoMark } from "@harvest/contracts";
import { normalizedUrl } from "../../features/photo-region/types";
import { addMark, labelMark, markPosition, marksOn, MAX_MARKS, removeMark } from "./scoutingModel";

/**
 * One issue photo with its marks (FIELD_OPERATIONS_SPEC.md 5.2). Marks are stored normalised, 0..1 from the top-left of the
 * normalised derivative, so they sit on the same spot at any display size. Editable: a tap on the photo adds a numbered mark
 * (Enter or Space on the focused photo adds one at the centre), a tap on a mark removes it, and each mark has an optional
 * label (40 characters) and a Remove button in the list under the photo. Read-only: the marks are drawn and listed.
 */
export function PhotoMarks(props: {
  mediaId: string;
  /** All marks of the issue (across its photos); the numbers follow this list. */
  marks: readonly PhotoMark[];
  /** Photo number for the alternative text. */
  photoNumber: number;
  editable?: boolean | undefined;
  onChange?: ((marks: PhotoMark[]) => void) | undefined;
  /** Prefix for element ids (unique per form). */
  idPrefix?: string | undefined;
}) {
  const mine = () => marksOn(props.marks, props.mediaId);
  const full = () => props.marks.length >= MAX_MARKS;
  const id = (suffix: string) => `${props.idPrefix ?? "sc-marks"}-${props.photoNumber}-${suffix}`;
  const add = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    if (!props.editable || full()) return;
    const image = event.currentTarget.querySelector("img");
    const rect = (image ?? event.currentTarget).getBoundingClientRect();
    const point = markPosition(rect, event.clientX, event.clientY, event.detail === 0);
    props.onChange?.(addMark(props.marks, props.mediaId, point.x, point.y));
  };
  const alt = () => `Photo ${props.photoNumber}${mine().length ? `, ${mine().length} mark${mine().length === 1 ? "" : "s"}` : ""}`;
  return (
    <figure class="sc-photo" data-testid="sc-photo">
      <div class="sc-photo-frame">
        <Show
          when={props.editable}
          fallback={<img src={normalizedUrl(props.mediaId)} alt={alt()} loading="lazy" />}
        >
          <button
            type="button"
            class="sc-photo-tap"
            aria-describedby={id("help")}
            aria-label={full() ? `${alt()}. All ${MAX_MARKS} marks are used.` : `${alt()}. Tap the photo to add a mark.`}
            aria-disabled={full()}
            onClick={add}
          >
            <img src={normalizedUrl(props.mediaId)} alt="" />
          </button>
        </Show>
        <Index each={mine()}>
          {(item) => {
            const mark = () => item();
            return (
            <Show
              when={props.editable}
              fallback={
                <span class="sc-mark" style={{ left: `${mark().x * 100}%`, top: `${mark().y * 100}%` }} aria-hidden="true">
                  {mark().number}
                </span>
              }
            >
              <button
                type="button"
                class="sc-mark"
                style={{ left: `${mark().x * 100}%`, top: `${mark().y * 100}%` }}
                aria-label={`Remove mark ${mark().number}${mark().label ? ` (${mark().label})` : ""}`}
                onClick={() => props.onChange?.(removeMark(props.marks, mark().index))}
                data-testid="sc-mark"
              >
                {mark().number}
              </button>
            </Show>
            );
          }}
        </Index>
      </div>
      <Show when={props.editable}>
        <figcaption id={id("help")} class="sc-small">
          {full() ? `All ${MAX_MARKS} marks are used. Remove one to add another.` : "Tap the photo where you saw it to add a numbered mark. Tap a mark to remove it."}
        </figcaption>
      </Show>
      <Show when={mine().length}>
        <ol class="sc-mark-list" aria-label={`Marks on photo ${props.photoNumber}`}>
          <Index each={mine()}>
            {(item) => {
              const mark = () => item();
              return (
              <li value={mark().number}>
                <Show when={props.editable} fallback={<span>{mark().label || "Marked spot"}</span>}>
                  <label class="sc-mark-label" for={id(`label-${mark().index}`)}>
                    Mark {mark().number} label (optional)
                  </label>
                  <div class="sc-mark-row">
                    <input
                      id={id(`label-${mark().index}`)}
                      type="text"
                      maxlength="40"
                      value={mark().label ?? ""}
                      onInput={(e) => props.onChange?.(labelMark(props.marks, mark().index, e.currentTarget.value))}
                    />
                    <button type="button" class="btn compact secondary" aria-label={`Remove mark ${mark().number}`} onClick={() => props.onChange?.(removeMark(props.marks, mark().index))}>
                      Remove
                    </button>
                  </div>
                </Show>
              </li>
              );
            }}
          </Index>
        </ol>
      </Show>
    </figure>
  );
}
