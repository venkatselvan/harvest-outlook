import { createSignal, For, Show } from "solid-js";
import type { FarmCommandCenter, UpcomingStep } from "@harvest/contracts";
import { Icon } from "../icons";
import { nextActionWhen, pickNextStep, windowLabel } from "./model";
import { FieldCheckActions, FieldCheckDetails } from "../scouting/ChecksSteps";

export interface UpcomingStepsProps {
  steps: UpcomingStep[];
  /** Server's next action (ROUND2_SPEC 2.1). Undefined in the degraded care-schedule list: the same rule runs here. */
  nextAction?: UpcomingStep | null | undefined;
  /** Server's today (browser today in the degraded list), for "Due today" and "Overdue since". */
  today: string;
  /** Id of the step whose completion is being saved, or "". */
  busyId: string;
  onDone: (step: UpcomingStep) => void;
  /** Error from the last completion (the optimistic update was rolled back). */
  error: string;
  /** Command-center sources, to link care-task source references when they are loaded. */
  sources?: FarmCommandCenter["sources"] | undefined;
  /** Caption under the heading, for example when steps come from the care schedule because the Today view failed. */
  note?: string | undefined;
  /** 2026-11-03 (FIELD_OPERATIONS_SPEC.md 4.2): Done on a field check opens the completion sheet. Without it no Done shows. */
  onCheck?: ((step: UpcomingStep) => void) | undefined;
  /** Opens the issue a recheck step looks at again. */
  onOpenIssue?: ((issueId: string) => void) | undefined;
  /**
   * 2026-11-04 (TODAY_MAP_LAYOUT_SPEC.md, Actions tab): "actions" shapes each step as an action card: an eyebrow (farm ·
   * field), the title, "01 · Evidence", "02 · Suggested action" and the step's one existing button. Same data and buttons.
   */
  variant?: "actions" | undefined;
  /** The eyebrow line of an action card ("Kabini farm · North strip"). */
  eyebrow?: ((step: UpcomingStep) => string) | undefined;
}

/** DOM id for a step, so an alert's suggested step can scroll to it. */
export const stepDomId = (stepId: string) => `today-step-${stepId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const statusChip: Record<UpcomingStep["status"], string | null> = {
  due: "Due",
  overdue: "Overdue",
  completed: "Done",
  upcoming: null,
};
const kindIcon: Record<UpcomingStep["kind"], string> = {
  care_task: "leaf",
  stage_transition: "calendar",
  alert_step: "info",
  stage_check: "calendar",
  field_check: "leaf",
};
const VISIBLE = 5;

/** Only scheduled care tasks can be completed (the completion endpoint accepts their ids); never stage checks or guidance. */
const canComplete = (step: UpcomingStep) => step.kind === "care_task" && !!step.careTask && step.status !== "completed";

function StepSources(props: { step: UpcomingStep; sources: FarmCommandCenter["sources"] | undefined }) {
  const source = (id: string) => props.sources?.find((item) => item.id === id);
  return (
    <Show when={props.step.careTask}>
      {(task) => (
        <details class="today-step-details">
          <summary>Action and source</summary>
          <p>{task().action}</p>
          <For each={task().conditions}>{(condition) => <p>{condition}</p>}</For>
          <For each={task().sourceRefs}>
            {(ref) => (
              <Show when={source(ref.sourceId)} fallback={<p>{ref.locator}</p>}>
                {(item) => (
                  <a href={item().url} target="_blank" rel="noreferrer noopener">
                    {item().publisher} · {ref.locator} <span aria-hidden="true">↗</span>
                  </a>
                )}
              </Show>
            )}
          </For>
        </details>
      )}
    </Show>
  );
}

function DoneButton(props: { step: UpcomingStep; busyId: string; onDone: (step: UpcomingStep) => void }) {
  return (
    <button
      type="button"
      class="btn compact secondary today-step-done"
      disabled={!!props.busyId}
      aria-label={`Mark done: ${props.step.title}`}
      onClick={() => props.onDone(props.step)}
    >
      <Icon name="check" size={14} /> {props.busyId === props.step.id ? "Saving…" : "Done"}
    </button>
  );
}

const FIELD_CHECK_ACTION = "Walk the field, then tap Done to record what you found.";
/** What the action card suggests: the care task's action, the step's own detail, or the field check's recording step. */
const suggestedAction = (step: UpcomingStep): string =>
  step.careTask?.action ?? (step.kind === "field_check" ? FIELD_CHECK_ACTION : step.detail) ?? "No action text was given for this step.";

/** One step as an action card (Actions tab): evidence first, then the suggested action, then the step's existing button. */
function ActionStepBody(props: {
  step: UpcomingStep;
  when: string;
  titleId?: string | undefined;
  kicker?: string | undefined;
  /** The next-action card shows only the Done chip (its line already says due or overdue), like the regular card. */
  doneChipOnly?: boolean | undefined;
  eyebrow?: ((step: UpcomingStep) => string) | undefined;
  sources: FarmCommandCenter["sources"] | undefined;
  busyId: string;
  onDone: (step: UpcomingStep) => void;
  onCheck?: ((step: UpcomingStep) => void) | undefined;
  onOpenIssue?: ((issueId: string) => void) | undefined;
}) {
  return (
    <div class="today-action-card">
      <p class="today-action-eyebrow">
        <span>{props.eyebrow?.(props.step) ?? ""}</span>
        <Show when={props.kicker}>
          <span class="today-step-origin">{props.kicker}</span>
        </Show>
        <Show when={props.step.kind === "alert_step"}>
          <span class="today-step-origin">From an alert</span>
        </Show>
      </p>
      <h3 id={props.titleId} class={props.titleId ? "today-next-title" : undefined}>
        {props.step.title}
      </h3>
      <dl class="today-action-evidence">
        <div>
          <dt>01 · Evidence</dt>
          <dd>
            <span class={`today-action-when ${props.step.status}`}>
              {props.when}
              <Show when={props.doneChipOnly ? (props.step.status === "completed" ? "Done" : null) : statusChip[props.step.status]}>
                {(chip) => <span class={`today-chip step ${props.step.status}`}>{chip()}</span>}
              </Show>
            </span>
            <Show when={props.step.kind === "field_check"}>
              <FieldCheckDetails step={props.step} />
            </Show>
            <StepSources step={props.step} sources={props.sources} />
          </dd>
        </div>
        <div>
          <dt>02 · Suggested action</dt>
          <dd>{suggestedAction(props.step)}</dd>
        </div>
      </dl>
      <div class="today-action-footer">
        <Show when={props.step.kind === "field_check"}>
          <FieldCheckActions step={props.step} busyId={props.busyId} onCheck={props.onCheck} onOpenIssue={props.onOpenIssue} />
        </Show>
        <Show when={canComplete(props.step)}>
          <DoneButton step={props.step} busyId={props.busyId} onDone={props.onDone} />
        </Show>
      </div>
    </div>
  );
}

export function UpcomingSteps(props: UpcomingStepsProps) {
  const actions = () => props.variant === "actions";
  const [all, setAll] = createSignal(false);
  /** The next action as it is in the list (so an optimistic Done shows on the card too). */
  const next = () => {
    const chosen = props.nextAction === undefined ? pickNextStep(props.steps) : props.nextAction;
    return chosen ? props.steps.find((step) => step.id === chosen.id) ?? chosen : null;
  };
  /** The list below the card starts with the second step. */
  const rest = () => props.steps.filter((step) => step.id !== next()?.id);
  const visible = () => (all() ? rest() : rest().slice(0, VISIBLE));
  return (
    <section class="today-section today-steps" aria-labelledby="today-steps-title">
      <div class="today-section-head">
        <h2 id="today-steps-title">Upcoming steps</h2>
        <p class="today-section-status">
          <span>{props.note ?? "Next 14 days"}</span>
        </p>
      </div>
      <Show when={props.error}>
        <p class="inline-error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={next()}>
        {(step) => (
          <article
            class={`today-next ${step().status} ${step().kind}`}
            id={stepDomId(step().id)}
            tabIndex={-1}
            data-step-id={step().id}
            data-testid="today-next-action"
            aria-labelledby="today-next-title"
          >
            <Show
              when={!actions()}
              fallback={
                <ActionStepBody
                  step={step()}
                  when={nextActionWhen(step(), props.today)}
                  titleId="today-next-title"
                  kicker="Next action"
                  doneChipOnly
                  eyebrow={props.eyebrow}
                  sources={props.sources}
                  busyId={props.busyId}
                  onDone={props.onDone}
                  onCheck={props.onCheck}
                  onOpenIssue={props.onOpenIssue}
                />
              }
            >
            <p class="today-next-kicker">
              <Icon name={step().status === "completed" ? "check" : kindIcon[step().kind]} size={14} /> Next action
              <Show when={step().kind === "alert_step"}>
                <span class="today-step-origin">From an alert</span>
              </Show>
            </p>
            <h3 id="today-next-title" class="today-next-title">
              {step().title}
            </h3>
            <p class={`today-next-when ${step().status}`}>
              {nextActionWhen(step(), props.today)}
              <Show when={step().status === "completed"}>
                <span class="today-chip step completed">Done</span>
              </Show>
            </p>
            <Show when={step().kind !== "field_check" && (step().careTask?.action ?? step().detail)}>
              {(action) => <p class="today-next-action">{action()}</p>}
            </Show>
            <StepSources step={step()} sources={props.sources} />
            <Show when={step().kind === "field_check"}>
              <FieldCheckDetails step={step()} />
              <FieldCheckActions step={step()} busyId={props.busyId} onCheck={props.onCheck} onOpenIssue={props.onOpenIssue} />
            </Show>
            <Show when={canComplete(step())}>
              <DoneButton step={step()} busyId={props.busyId} onDone={props.onDone} />
            </Show>
            </Show>
          </article>
        )}
      </Show>
      <Show when={props.steps.length} fallback={<p class="today-empty-line">Nothing scheduled for the next 14 days.</p>}>
        <Show when={rest().length}>
          <ul class="today-step-list" aria-label="Later steps">
            <For each={visible()}>
              {(step) => (
                <li class={`today-step ${step.status} ${step.kind}`} classList={{ "is-action-card": actions() }} id={stepDomId(step.id)} tabIndex={-1} data-step-id={step.id}>
                  <Show
                    when={!actions()}
                    fallback={
                      <ActionStepBody
                        step={step}
                        when={windowLabel(step.dueFrom, step.dueTo)}
                        eyebrow={props.eyebrow}
                        sources={props.sources}
                        busyId={props.busyId}
                        onDone={props.onDone}
                        onCheck={props.onCheck}
                        onOpenIssue={props.onOpenIssue}
                      />
                    }
                  >
                  <span class="today-step-icon" aria-hidden="true">
                    <Icon name={step.status === "completed" ? "check" : kindIcon[step.kind]} size={16} />
                  </span>
                  <div class="today-step-body">
                    <h3>{step.title}</h3>
                    <p class="today-step-when">
                      {windowLabel(step.dueFrom, step.dueTo)}
                      <Show when={statusChip[step.status]}>
                        <span class={`today-chip step ${step.status}`}>{statusChip[step.status]}</span>
                      </Show>
                      <Show when={step.kind === "alert_step"}>
                        <span class="today-step-origin">From an alert</span>
                      </Show>
                    </p>
                    <StepSources step={step} sources={props.sources} />
                    <Show when={step.kind !== "field_check" && !step.careTask && step.detail}>
                      <p class="today-step-detail">{step.detail}</p>
                    </Show>
                    <Show when={step.kind === "field_check"}>
                      <FieldCheckDetails step={step} />
                    </Show>
                  </div>
                  <Show when={canComplete(step)}>
                    <DoneButton step={step} busyId={props.busyId} onDone={props.onDone} />
                  </Show>
                  <Show when={step.kind === "field_check"}>
                    <FieldCheckActions step={step} busyId={props.busyId} onCheck={props.onCheck} onOpenIssue={props.onOpenIssue} />
                  </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={rest().length > VISIBLE}>
            <button type="button" class="text-button" aria-expanded={all()} onClick={() => setAll(!all())}>
              {all() ? "Show fewer steps" : `Show all ${rest().length} later steps`}
            </button>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
