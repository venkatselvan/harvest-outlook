import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { FarmAlert, FarmCommandCenter, FarmNewsReviewStatus, UpcomingStep } from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import { AlertActionCard, alertDomId, newsReviewText, sortAlerts } from "./AlertsList";
import { ActionStepBody, stepDomId, VISIBLE } from "./UpcomingSteps";
import { nextActionWhen, pickNextStep, windowLabel } from "./model";
import { ACTION_RANK, actionItems } from "./todayMapModel";

/**
 * The Actions tab's board (TODAY_REFINEMENT_SPEC.md 1): alerts and steps as one masonry flow of action cards, directly under
 * the "Alerts & tasks" heading, in the existing priority order (overdue, due, warnings, watch, upcoming). The cards are the
 * same as before (eyebrow, title, 01 Evidence, 02 Suggested action, one button) with the same ids, so the attention links,
 * "This week" and an alert's "Review step" still jump to them. Upcoming steps after the first five wait behind "Show all".
 */
export interface ActionsBoardProps {
  /** Id of the heading that names the board ("Alerts & tasks"); focus returns there after a dismissal. */
  labelledBy: string;
  alerts: FarmAlert[];
  newsReview: FarmNewsReviewStatus | null;
  today: string;
  stepAlertIds: ReadonlySet<string>;
  onDismiss: (alert: FarmAlert) => void;
  onSuggested: (alert: FarmAlert) => void;
  alertError: string;
  /** Steps of the described crop; empty without a crop. */
  steps: UpcomingStep[];
  nextAction?: UpcomingStep | null | undefined;
  busyId: string;
  onDone: (step: UpcomingStep) => void;
  stepError: string;
  sources?: FarmCommandCenter["sources"] | undefined;
  onCheck?: ((step: UpcomingStep) => void) | undefined;
  onOpenIssue?: ((issueId: string) => void) | undefined;
  alertEyebrow?: ((alert: FarmAlert) => string) | undefined;
  stepEyebrow?: ((step: UpcomingStep) => string) | undefined;
}

export function ActionsBoard(props: ActionsBoardProps) {
  const [all, setAll] = createSignal(false);
  const next = () => {
    const chosen = props.nextAction === undefined ? pickNextStep(props.steps) : props.nextAction;
    return chosen ? (props.steps.find((step) => step.id === chosen.id) ?? chosen) : null;
  };
  const items = createMemo(() => actionItems(sortAlerts(props.alerts), props.steps, next()?.id));
  const upcoming = () => items().filter((item) => item.rank === ACTION_RANK.upcoming).length;
  const visible = () => {
    if (all()) return items();
    let shown = 0;
    return items().filter((item) => item.rank !== ACTION_RANK.upcoming || (item.kind === "step" && item.next) || shown++ < VISIBLE);
  };
  const hidden = () => items().length - visible().length;
  /** The cards render the alert and step objects themselves, so an unchanged card keeps its DOM (and focus) when another changes. */
  const cards = () => visible().map((item) => (item.kind === "alert" ? item.alert : item.step));
  const isAlert = (card: FarmAlert | UpcomingStep): card is FarmAlert => "severity" in card;
  const focusHeading = () => document.getElementById(props.labelledBy)?.focus();
  return (
    <section class="today-actions-board" aria-labelledby={props.labelledBy} data-testid="today-actions-board">
      <div class="today-actions-board-head">
        <p class="today-section-status">
          <span data-testid="today-news-status">{newsReviewText(props.newsReview, props.today)}</span>
          <AiSpark use="news_review" size={14} />
        </p>
        <p class="today-section-status">Steps for the next 14 days</p>
      </div>
      <Show when={props.alertError}>
        <p class="inline-error" role="alert">
          {props.alertError}
        </p>
      </Show>
      <Show when={props.stepError}>
        <p class="inline-error" role="alert">
          {props.stepError}
        </p>
      </Show>
      <Show when={items().length} fallback={<p class="today-empty-line">No active alerts and nothing scheduled for the next 14 days.</p>}>
        <ol class="today-actions-masonry" aria-label="Alerts and steps, most urgent first">
          <For each={cards()}>
            {(card) => (
              <li class="today-actions-item" data-item-kind={isAlert(card) ? "alert" : "step"}>
                <Switch>
                  <Match when={isAlert(card) ? card : null}>
                    {(alert) => (
                      <div class={`today-alert ${alert().severity}`} id={alertDomId(alert().id)} tabIndex={-1} data-alert-id={alert().id}>
                        <span class="today-alert-bar" aria-hidden="true" />
                        <AlertActionCard alert={alert()} eyebrow={props.alertEyebrow} hasStep={props.stepAlertIds.has(alert().id)} onSuggested={props.onSuggested} />
                        <button
                          type="button"
                          class="today-alert-dismiss"
                          aria-label={`Dismiss alert: ${alert().title}`}
                          onClick={() => {
                            props.onDismiss(alert());
                            focusHeading();
                          }}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      </div>
                    )}
                  </Match>
                  <Match when={isAlert(card) ? null : (card as UpcomingStep)}>
                    {(step) => {
                      const isNext = () => step().id === next()?.id;
                      return (
                        <article
                          class={isNext() ? `today-next ${step().status} ${step().kind}` : `today-step ${step().status} ${step().kind} is-action-card`}
                          id={stepDomId(step().id)}
                          tabIndex={-1}
                          data-step-id={step().id}
                          data-testid={isNext() ? "today-next-action" : undefined}
                          aria-labelledby={isNext() ? "today-next-title" : undefined}
                        >
                          <ActionStepBody
                            step={step()}
                            when={isNext() ? nextActionWhen(step(), props.today) : windowLabel(step().dueFrom, step().dueTo)}
                            titleId={isNext() ? "today-next-title" : undefined}
                            kicker={isNext() ? "Next action" : undefined}
                            doneChipOnly={isNext()}
                            eyebrow={props.stepEyebrow}
                            sources={props.sources}
                            busyId={props.busyId}
                            onDone={props.onDone}
                            onCheck={props.onCheck}
                            onOpenIssue={props.onOpenIssue}
                          />
                        </article>
                      );
                    }}
                  </Match>
                </Switch>
              </li>
            )}
          </For>
        </ol>
        <Show when={hidden() > 0 || (all() && upcoming() > VISIBLE)}>
          <button type="button" class="text-button today-actions-all" aria-expanded={all()} onClick={() => setAll(!all())}>
            {all() ? "Show fewer steps" : `Show all ${upcoming()} upcoming steps`}
          </button>
        </Show>
      </Show>
    </section>
  );
}
