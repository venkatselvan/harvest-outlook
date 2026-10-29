import { STATE_HELP, STATE_LABEL, OUTCOME_LABEL, type EvidenceState } from "./logic";
import type { Outcome } from "./types";

/** Text badges: meaning never depends on colour alone. */
export function StateBadge(props: { state: EvidenceState }) {
  return (
    <span class="cmp-badge" data-state={props.state} title={STATE_HELP[props.state]}>
      {STATE_LABEL[props.state]}
    </span>
  );
}

export function OutcomeBadge(props: { outcome: Outcome }) {
  return (
    <span class="cmp-outcome" data-outcome={props.outcome}>
      Eligibility: {OUTCOME_LABEL[props.outcome]}
    </span>
  );
}
