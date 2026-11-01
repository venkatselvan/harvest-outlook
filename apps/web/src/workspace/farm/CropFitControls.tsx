import { For, Show } from "solid-js";
import { addDaysIso, MAX_DAYS_AHEAD, MODES, SEASONS, sowingProblem, type ControlsState } from "./cropFitModel";

/**
 * Crop fit controls (ROUND2_SPEC.md 4.2): segmented Next crop | By season | Pick a date, season chips, a date input and
 * the line that states the resolved sowing date and the previous crop. Toggle buttons expose aria-pressed; the date is
 * checked here (today to about a year ahead) before it is sent.
 */
export function CropFitControls(props: {
  state: ControlsState;
  todayIso: string;
  resolved: string;
  busy: boolean;
  stale: boolean;
  refreshing: boolean;
  dateError: string | null;
  onChange: (next: ControlsState) => void;
  onDateError: (message: string | null) => void;
  onRefresh: () => void;
}) {
  const pick = (next: Partial<ControlsState>) => props.onChange({ ...props.state, ...next });
  return (
    <div class="cf-controls">
      <div class="cf-segmented" role="group" aria-label="When to sow">
        <For each={MODES}>
          {(m) => (
            <button type="button" class="cf-segment" aria-pressed={props.state.mode === m.id} onClick={() => props.state.mode !== m.id && pick({ mode: m.id })}>
              {m.label}
            </button>
          )}
        </For>
      </div>
      <Show when={props.state.mode === "season"}>
        <div class="cf-season-chips" role="group" aria-label="Season">
          <For each={SEASONS}>
            {(s) => (
              <button type="button" class="cf-season" aria-pressed={props.state.season === s.id} onClick={() => props.state.season !== s.id && pick({ season: s.id })}>
                {s.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.state.mode === "date"}>
        <label class="cf-date">
          <span>Sowing date</span>
          <input
            type="date"
            value={props.state.sowing}
            min={props.todayIso}
            max={addDaysIso(props.todayIso, MAX_DAYS_AHEAD)}
            aria-invalid={props.dateError ? "true" : undefined}
            aria-describedby={props.dateError ? "cf-date-error" : undefined}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const problem = sowingProblem(value, props.todayIso);
              props.onDateError(problem);
              if (!problem && value !== props.state.sowing) pick({ sowing: value });
            }}
          />
        </label>
        <Show when={props.dateError}>
          <p id="cf-date-error" class="cf-date-error" role="alert">
            {props.dateError}
          </p>
        </Show>
      </Show>
      <p class="cf-resolved" aria-live="polite">
        {props.resolved}
        <Show when={props.stale && !props.busy}>
          {" · "}
          <button type="button" class="cf-link" disabled={props.refreshing} onClick={() => props.onRefresh()}>
            {props.refreshing ? "Refreshing…" : "Out of date, refresh"}
          </button>
        </Show>
      </p>
    </div>
  );
}
