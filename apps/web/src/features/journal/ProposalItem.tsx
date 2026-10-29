import { Show, createSignal } from "solid-js";
import { ApiError } from "../../lib/api";
import { confirmFacts, previewRevision, type ConfirmResult, type JournalEntry, type JournalFact, type Preview, type Timeline } from "./api";
import { canConfirmPlanChange, isFinalProposal, proposalReducer, type ProposalState, type ProposalStatus } from "./model";
import { WhyChanged } from "./WhyChanged";

const FIELD_LABEL: Record<string, string> = {
  observed_stage: "Growth stage",
  irrigation_category: "Water source",
  planting_date: "Planting date",
  waterlogging_visible: "Standing water visible",
};
export const fieldLabel = (f: string): string => FIELD_LABEL[f] ?? f.replace(/_/g, " ");
export const valueLabel = (f: JournalFact, stageNames: Record<string, string>): string => {
  const v = f.field === "observed_stage" && typeof f.value === "string" ? (stageNames[f.value] ?? f.value) : String(f.value);
  return f.unit ? `${v} ${f.unit}` : v;
};

const initialFor = (f: JournalFact): ProposalState => ({ status: (f.status === "confirmed" ? "confirmed" : f.status === "rejected" ? "rejected" : "pending") as ProposalStatus, decision: null, error: null });

/** One proposal with Accept and Reject. Plan-changing accepts show the engine's diff first and need an explicit Confirm. */
export function ProposalItem(props: {
  fact: JournalFact;
  entry: JournalEntry;
  plan: Timeline["currentPlan"];
  stageNames: Record<string, string>;
  onResult: (r: ConfirmResult | null) => void;
  onReload: () => void;
}) {
  const [state, setState] = createSignal<ProposalState>(initialFor(props.fact));
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const dispatch = (e: Parameters<typeof proposalReducer>[1]) => setState((s) => proposalReducer(s, e));
  const planChanging = () => props.fact.planMapped && props.plan !== null;
  const mine = props.fact.source === "farmer";

  const send = async (decision: "accept" | "reject") => {
    try {
      const body = {
        expectedVersion: props.entry.version,
        ...(decision === "accept" ? { accept: [props.fact.id] } : { reject: [props.fact.id] }),
        ...(decision === "accept" && props.fact.planMapped && props.plan ? { expectedPlanContentHash: props.plan.contentHash } : {}),
      };
      const result = await confirmFacts(props.entry.id, body);
      dispatch({ type: "saved", decision });
      props.onResult(result);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "unknown";
      dispatch({ type: "failed", code, message: code === "version_conflict" ? "This entry or your plan changed. Reload to review the latest version." : e instanceof ApiError ? e.message : "Could not save your decision. Try again." });
    }
  };

  const accept = async () => {
    dispatch({ type: "accept", planChanging: planChanging() });
    if (!planChanging()) return void send("accept");
    await loadPreview();
  };
  const loadPreview = async () => {
    setPreview(null);
    setPreviewError(null);
    try {
      setPreview(await previewRevision(props.entry.id, [props.fact.id]));
    } catch (e) {
      setPreviewError(e instanceof ApiError ? e.message : "Could not prepare the preview.");
    }
  };
  const reject = () => {
    dispatch({ type: "reject" });
    void send("reject");
  };
  const confirm = () => {
    dispatch({ type: "confirm_plan_change" });
    void send("accept");
  };

  return (
    <li class="jr-proposal" data-testid="proposal" data-field={props.fact.field} data-status={state().status}>
      <p class="jr-ai-label">{props.fact.label ?? "AI proposal — confirm before it changes your plan"}</p>
      <p class="jr-proposal-main">
        <strong>{fieldLabel(props.fact.field)}:</strong> {valueLabel(props.fact, props.stageNames)}
        <Show when={props.fact.planMapped}>
          <span class="jr-tag">changes your plan if confirmed</span>
        </Show>
      </p>
      <Show when={state().status === "pending"}>
        <div class="jr-actions">
          <button type="button" class="btn" onClick={accept}>Accept {fieldLabel(props.fact.field).toLowerCase()}</button>
          <button type="button" class="btn secondary" onClick={reject}>Reject {fieldLabel(props.fact.field).toLowerCase()}</button>
        </div>
      </Show>
      <Show when={state().status === "reviewing"}>
        <div class="jr-review" role="group" aria-label="Plan change preview">
          <h4>What would change</h4>
          <Show when={preview()} fallback={<p role="status">{previewError() ?? "Calculating the new plan…"}</p>}>
            {(p) => (
              <>
                <WhyChanged heading={null} changes={p().changes} summary={p().preview?.changeSummary ?? null} stageNames={props.stageNames} />
                <p class="jr-small">{p().preview?.note}</p>
              </>
            )}
          </Show>
          <p class="jr-small">{mine ? "You chose this stage." : "This is an AI reading of one photo."} Nothing changes until you confirm.</p>
          <div class="jr-actions">
            <button type="button" class="btn" onClick={confirm} disabled={!canConfirmPlanChange(preview(), previewError())}>Confirm plan change</button>
            <Show when={previewError()}>
              <button type="button" class="btn secondary" onClick={() => void loadPreview()}>Retry preview</button>
            </Show>
            <button type="button" class="btn secondary" onClick={() => dispatch({ type: "cancel_review" })}>Not now</button>
            <button type="button" class="btn secondary" onClick={reject}>Reject</button>
          </div>
        </div>
      </Show>
      <Show when={state().status === "saving"}>
        <p role="status">Saving your decision…</p>
      </Show>
      <Show when={isFinalProposal(state())}>
        <p class="jr-decided" role="status">{state().status === "confirmed" ? "You accepted this. It is now recorded as confirmed by you." : "You rejected this. It was not used."}</p>
      </Show>
      <Show when={state().status === "stale"}>
        <p role="alert" class="jr-error">{state().error}</p>
        <button type="button" class="btn secondary" onClick={props.onReload}>Reload</button>
      </Show>
      <Show when={state().status === "error"}>
        <p role="alert" class="jr-error">{state().error}</p>
        <button type="button" class="btn secondary" onClick={() => dispatch({ type: "retry" })}>Try again</button>
      </Show>
    </li>
  );
}
