import { Show } from "solid-js";
import type { CropFitCandidate } from "@harvest/contracts";
import { Sheet } from "../ui/Sheet";
import { replaceConfirmText, replaceConfirmTitle } from "./cropFitModel";

/**
 * The confirm step of "Replace with <crop>" (review of the Evara actions round, finding 2): one line with what the planned
 * season becomes, and nothing is saved until Confirm. The write re-checks the season against the workspace's cycles.
 */
export function ReplaceConfirm(props: { candidate: CropFitCandidate; busy: boolean; error: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet
      title={replaceConfirmTitle(props.candidate)}
      subtitle={<span>Nothing is saved until you confirm</span>}
      closeLabel="Close replace confirmation"
      class="cf-replace-confirm"
      onClose={() => {
        if (!props.busy) props.onClose();
      }}
      footer={
        <>
          <button type="button" class="btn secondary" disabled={props.busy} onClick={() => props.onClose()}>
            Cancel
          </button>
          <button type="button" class="btn" disabled={props.busy} onClick={() => props.onConfirm()}>
            {props.busy ? "Saving…" : "Confirm"}
          </button>
        </>
      }
    >
      <p class="cf-replace-confirm-line">{replaceConfirmText(props.candidate)}</p>
      <p class="cf-muted">Dates are calculated references, not predictions.</p>
      <Show when={props.error}>{(m) => <p class="cf-inline-error" role="alert">{m()}</p>}</Show>
    </Sheet>
  );
}
