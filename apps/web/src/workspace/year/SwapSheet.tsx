import { Show } from "solid-js";
import { CropFitPicker } from "../farm/CropFitPicker";
import { AiSparkInline } from "../ui/AiSpark";
import { Sheet } from "../ui/Sheet";
import type { PickerContext } from "./model";
import type { CropFitCandidate } from "@harvest/contracts";

export interface SwapPickerProps {
  farmId: string;
  /** The field the plan is for (area and rotation are the field's); null or omitted = the whole farm. */
  fieldId?: string | null | undefined;
  context: PickerContext;
  current: {
    cropId: string;
    productId: string;
    systemId?: string | null;
  } | null;
  onPick: (candidate: CropFitCandidate) => void;
  onClose: () => void;
  /** The line above the picker; the default says the plan is re-scored by code. A saved season says what it changes instead. */
  note?: string | undefined;
  /** True while a pick is being saved: the picker's "Use this crop" buttons are disabled and a status line says so; Keep and Cancel still close it. */
  busy?: boolean | undefined;
  /** Why the last pick could not be saved; shown above the picker. */
  error?: string | undefined;
}

export const DEFAULT_SWAP_NOTE = "After you pick, the plan is re-scored by code, not by AI.";

/**
 * The body of the swap and suggest-next sheets: one line saying the plan is re-scored by code (Meta only ranks and
 * explains the suggestions), then the shared crop picker, which names the sowing date and the crop before it itself. Kept apart
 * from the sheet frame so tests can render it without a portal.
 */
export function SwapPicker(props: SwapPickerProps) {
  return (
    <div class="yp-swap">
      <p class="yp-swap-note">{props.note ?? DEFAULT_SWAP_NOTE}</p>
      <Show when={props.busy}>
        <p class="yp-swap-status" role="status">
          Saving the swap…
        </p>
      </Show>
      <Show when={props.error}>
        <p class="yp-inline-error" role="alert">
          {props.error}
        </p>
      </Show>
      <div class="yp-swap-body" aria-busy={props.busy === true}>
        <CropFitPicker
          farmId={props.farmId}
          fieldId={props.fieldId}
          sowing={props.context.sowing}
          after={props.context.after}
          current={props.current}
          onPick={props.onPick}
          onClose={props.onClose}
          busy={props.busy === true}
        />
      </div>
    </div>
  );
}

/** Bottom sheet around the picker, carrying the `crop_fit_picks` AI mark for the suggestions. */
export function SwapSheet(props: SwapPickerProps & { title: string }) {
  return (
    <Sheet
      title={props.title}
      closeLabel="Close crop picker"
      onClose={() => props.onClose()}
      class="yp-sheet yp-swap-sheet"
      subtitle={
        <span class="yp-swap-mark">
          <AiSparkInline use="crop_fit_picks" label="Suggestions picked by AI" />
        </span>
      }
    >
      <SwapPicker {...props} />
    </Sheet>
  );
}
