import { For, Show } from "solid-js";
import type { FarmAlert, FarmNewsReviewStatus } from "@harvest/contracts";
import { Icon } from "../icons";
import { formatDay, rangeLabel } from "./model";

export interface AlertsListProps {
  alerts: FarmAlert[];
  newsReview: FarmNewsReviewStatus | null;
  /** Server's today, to say "News checked today". */
  today: string;
  /** Alert ids with a matching upcoming step; their suggested step becomes a button that jumps to it. */
  stepAlertIds: ReadonlySet<string>;
  onDismiss: (alert: FarmAlert) => void;
  onSuggested: (alert: FarmAlert) => void;
  /** Error from the last dismiss, shown above the list. */
  error: string;
}

const severityOrder: Record<FarmAlert["severity"], number> = { warning: 0, watch: 1, info: 2 };
const severityLabel: Record<FarmAlert["severity"], string> = { warning: "Warning", watch: "Watch", info: "Info" };
const typeLabel: Record<FarmAlert["type"], string> = {
  weather: "Weather",
  price: "Price",
  market_event: "Market news",
  crop_threat: "Crop threat",
};

/** Header line for the once-a-day grounded news review. */
export function newsReviewText(status: FarmNewsReviewStatus | null, today: string): string {
  if (!status) return "News check not set up";
  switch (status.status) {
    case "active": {
      const day = status.lastReviewedAt ? new Date(status.lastReviewedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : null;
      return day === today ? "News checked today" : day ? `News checked ${formatDay(day, false)}` : "News check active";
    }
    case "paused":
      return "News check paused";
    case "not_run":
      return "News check not run yet";
    default:
      return "News check unavailable";
  }
}

export function sortAlerts(alerts: readonly FarmAlert[]): FarmAlert[] {
  return [...alerts].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

export function AlertsList(props: AlertsListProps) {
  let heading: HTMLHeadingElement | undefined;
  const sorted = () => sortAlerts(props.alerts);
  return (
    <section class="today-section today-alerts" aria-labelledby="today-alerts-title">
      <div class="today-section-head">
        <h2 id="today-alerts-title" ref={heading} tabIndex={-1}>
          Alerts
        </h2>
        <p class="today-section-status">
          <span>{newsReviewText(props.newsReview, props.today)}</span>
          <span>IMD warnings not connected</span>
        </p>
      </div>
      <Show when={props.error}>
        <p class="inline-error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={sorted().length} fallback={<p class="today-empty-line">No active alerts for this field.</p>}>
        <ul class="today-alert-list">
          <For each={sorted()}>
            {(alert) => (
              <li class={`today-alert ${alert.severity}`} data-alert-id={alert.id}>
                <span class="today-alert-bar" aria-hidden="true" />
                <div class="today-alert-body">
                  <p class="today-alert-kicker">
                    <span class={`today-chip severity ${alert.severity}`}>{severityLabel[alert.severity]}</span>
                    <span>{typeLabel[alert.type]}</span>
                    <span>· until {formatDay(alert.validTo, false)}</span>
                  </p>
                  <h3>{alert.title}</h3>
                  <p class="today-alert-detail">{alert.detail}</p>
                  <a class="today-alert-source" href={alert.source.url} target="_blank" rel="noreferrer noopener">
                    {alert.source.name} · {formatDay(alert.source.date)} <span aria-hidden="true">↗</span>
                    <span class="today-sr"> (opens in a new tab)</span>
                  </a>
                  <Show when={alert.suggestedStep}>
                    <Show
                      when={props.stepAlertIds.has(alert.id)}
                      fallback={
                        <p class="today-alert-step">
                          <Icon name="check" size={13} /> {alert.suggestedStep}
                        </p>
                      }
                    >
                      <button type="button" class="today-alert-step-button" onClick={() => props.onSuggested(alert)}>
                        <Icon name="check" size={13} /> {alert.suggestedStep}
                      </button>
                    </Show>
                  </Show>
                  <span class="today-sr">Valid {rangeLabel(alert.validFrom, alert.validTo)}.</span>
                </div>
                <button
                  type="button"
                  class="today-alert-dismiss"
                  aria-label={`Dismiss alert: ${alert.title}`}
                  onClick={() => {
                    props.onDismiss(alert);
                    heading?.focus();
                  }}
                >
                  <Icon name="close" size={15} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
