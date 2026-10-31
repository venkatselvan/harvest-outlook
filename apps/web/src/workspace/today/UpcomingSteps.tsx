import { createSignal, For, Show, type JSX } from "solid-js";
import type { FarmCommandCenter, UpcomingStep } from "@harvest/contracts";
import { Icon } from "../icons";
import { formatDay, rangeLabel } from "./model";

export interface UpcomingStepsProps {
  steps: UpcomingStep[];
  /** Id of the step whose completion is being saved, or "". */
  busyId: string;
  onDone: (step: UpcomingStep) => void;
  /** Error from the last completion (the optimistic update was rolled back). */
  error: string;
  /** Command-center sources, to link care-task source references when they are loaded. */
  sources?: FarmCommandCenter["sources"] | undefined;
  /** Caption under the heading, for example when steps come from the care schedule because the Today view failed. */
  note?: string | undefined;
  /** Rendered at the end of the section (undated guidance). */
  children?: JSX.Element;
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
};
const VISIBLE = 5;

export function UpcomingSteps(props: UpcomingStepsProps) {
  const [all, setAll] = createSignal(false);
  const visible = () => (all() ? props.steps : props.steps.slice(0, VISIBLE));
  const source = (id: string) => props.sources?.find((item) => item.id === id);
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
      <Show when={props.steps.length} fallback={<p class="today-empty-line">Nothing scheduled for the next 14 days.</p>}>
        <ul class="today-step-list">
          <For each={visible()}>
            {(step) => (
              <li class={`today-step ${step.status} ${step.kind}`} id={stepDomId(step.id)} tabIndex={-1} data-step-id={step.id}>
                <span class="today-step-icon" aria-hidden="true">
                  <Icon name={step.status === "completed" ? "check" : kindIcon[step.kind]} size={16} />
                </span>
                <div class="today-step-body">
                  <h3>{step.title}</h3>
                  <p class="today-step-when">
                    {step.kind === "stage_transition"
                      ? `Expected ${formatDay(step.dueFrom, false)}`
                      : step.dueFrom === step.dueTo
                        ? formatDay(step.dueFrom, false)
                        : rangeLabel(step.dueFrom, step.dueTo)}
                    <Show when={statusChip[step.status]}>
                      <span class={`today-chip step ${step.status}`}>{statusChip[step.status]}</span>
                    </Show>
                    <Show when={step.kind === "alert_step"}>
                      <span class="today-step-origin">From an alert</span>
                    </Show>
                  </p>
                  <Show when={step.careTask}>
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
                  <Show when={!step.careTask && step.detail}>
                    <p class="today-step-detail">{step.detail}</p>
                  </Show>
                </div>
                <Show when={step.kind === "care_task" && step.careTask && step.status !== "completed"}>
                  <button
                    type="button"
                    class="btn compact secondary today-step-done"
                    disabled={!!props.busyId}
                    aria-label={`Mark done: ${step.title}`}
                    onClick={() => props.onDone(step)}
                  >
                    <Icon name="check" size={14} /> {props.busyId === step.id ? "Saving…" : "Done"}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.steps.length > VISIBLE}>
          <button type="button" class="text-button" aria-expanded={all()} onClick={() => setAll(!all())}>
            {all() ? "Show fewer steps" : `Show all ${props.steps.length} steps`}
          </button>
        </Show>
      </Show>
      {props.children}
    </section>
  );
}
