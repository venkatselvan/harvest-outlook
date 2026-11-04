import { For, Show } from "solid-js";
import type { UpcomingStep } from "@harvest/contracts";
import { Icon } from "../icons";
import { day, generalItems, isRecheck, riskItems } from "./scoutingModel";
import "./scouting.css";

/** The condition that prompted this check and its specific inspection steps. */
export function FieldCheckDetails(props: { step: UpcomingStep }) {
  const check = () => props.step.fieldCheck ?? null;
  return (
    <Show when={check()} fallback={<Show when={props.step.detail}>{(detail) => <p class="today-step-detail">{detail()}</p>}</Show>}>
      {(c) => (
        <div class="sc-check" data-testid="sc-check-details">
          <Show when={c().reason}>{(reason) => <p class="sc-check-caption">{reason()}</p>}</Show>
          <Show when={c().kind === "recheck"}>
            <p class="sc-check-caption">The recheck date you recorded for this issue.</p>
          </Show>
          <Show when={c().checklist.length}>
            <details class="today-step-details sc-checklist">
              <summary>What to check</summary>
              <Show when={riskItems(c()).length}>
                <p class="sc-checklist-head">Based on the current alert</p>
                <ul class="sc-checklist-list" data-testid="sc-risk-items">
                  <For each={riskItems(c())}>
                    {(item) => (
                      <li>
                        <span>{item.text}</span>
                        <Show when={item.sourceName || item.sourceUrl}>
                          <span class="sc-source">
                            <Show when={item.sourceUrl && /^https?:\/\//.test(item.sourceUrl)} fallback={<>{item.sourceName}</>}>
                              <a href={item.sourceUrl!} target="_blank" rel="noreferrer noopener">
                                {item.sourceName ?? "Source"} <span aria-hidden="true">↗</span>
                              </a>
                            </Show>
                            <Show when={item.sourceDate}> · {day(item.sourceDate)}</Show>
                          </span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={generalItems(c()).length}>
                <p class="sc-checklist-head">Follow-up</p>
                <ul class="sc-checklist-list" data-testid="sc-general-items">
                  <For each={generalItems(c())}>{(item) => <li>{item.text}</li>}</For>
                </ul>
              </Show>
            </details>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Actions of a field check step: Done (opens the completion sheet) and, for a recheck, Open issue. */
export function FieldCheckActions(props: {
  step: UpcomingStep;
  busyId: string;
  onCheck?: ((step: UpcomingStep) => void) | undefined;
  onOpenIssue?: ((issueId: string) => void) | undefined;
}) {
  const issueId = () => props.step.issueId ?? props.step.fieldCheck?.issueId ?? null;
  return (
    <div class="sc-step-actions">
      <Show when={isRecheck(props.step) && issueId() && props.onOpenIssue}>
        <button type="button" class="btn compact secondary" aria-label={`Open issue: ${props.step.title}`} onClick={() => props.onOpenIssue?.(issueId()!)}>
          Open issue
        </button>
      </Show>
      <Show when={props.step.status !== "completed" && props.step.fieldCheck && props.onCheck}>
        <button
          type="button"
          class="btn compact secondary today-step-done"
          disabled={!!props.busyId}
          aria-label={`Mark done: ${props.step.title}`}
          onClick={() => props.onCheck?.(props.step)}
        >
          <Icon name="check" size={14} /> {props.busyId === props.step.id ? "Saving…" : "Done"}
        </button>
      </Show>
    </div>
  );
}
