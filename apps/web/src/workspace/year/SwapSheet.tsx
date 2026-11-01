import { CropFitPicker } from "../farm/CropFitPicker";
import { AiSparkInline } from "../ui/AiSpark";
import { Sheet } from "../ui/Sheet";
import type { PickerContext } from "./model";
import type { CropFitCandidate } from "@harvest/contracts";

export interface SwapPickerProps {
  farmId: string;
  context: PickerContext;
  current: {
    cropId: string;
    productId: string;
    systemId?: string | null;
  } | null;
  onPick: (candidate: CropFitCandidate) => void;
  onClose: () => void;
}

/**
 * The body of the swap and suggest-next sheets: one line saying the plan is re-scored by code (Meta only ranks and
 * explains the suggestions), then the shared crop picker, which names the sowing date and the crop before it itself. Kept apart
 * from the sheet frame so tests can render it without a portal.
 */
export function SwapPicker(props: SwapPickerProps) {
  return (
    <div class="yp-swap">
      <p class="yp-swap-note">After you pick, the plan is re-scored by code, not by AI.</p>
      <CropFitPicker
        farmId={props.farmId}
        sowing={props.context.sowing}
        after={props.context.after}
        current={props.current}
        onPick={props.onPick}
        onClose={props.onClose}
      />
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
