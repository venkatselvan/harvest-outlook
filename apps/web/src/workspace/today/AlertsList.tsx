import { For, Show } from "solid-js";
import type { FarmAlert, FarmNewsReviewStatus } from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
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

/** DOM id of an alert card, so the Today overview can scroll to it. */
export const alertDomId = (alertId: string) => `today-alert-${alertId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const severityOrder: Record<FarmAlert["severity"], number> = { warning: 0, watch: 1, info: 2 };
const severityLabel: Record<FarmAlert["severity"], string> = { warning: "Warning", watch: "Watch", info: "Info" };
const typeLabel: Record<FarmAlert["type"], string> = {
  weather: "Weather",
  price: "Price",
  market_event: "Market news",
  crop_threat: "Crop threat",
  satellite: "Satellite",
};

/**
 * Header line for the once-a-day grounded review (ROUND2_SPEC 2.3): Meta's web search covers news and official warnings
 * (IMD bulletins, state disaster authorities). The missing direct IMD feed is named in the limitations sheet only.
 */
export function newsReviewText(status: FarmNewsReviewStatus | null, today: string): string {
  if (!status) return "News and warnings search not set up";
  switch (status.status) {
    case "active": {
      const day = status.lastReviewedAt ? new Date(status.lastReviewedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : null;
      return day === today
        ? "News and official warnings checked today via Meta search"
        : day
          ? `News and official warnings checked ${formatDay(day, false)} via Meta search`
          : "News and official warnings search active";
    }
    case "paused":
      return "News and warnings search paused";
    case "not_run":
      return "News and warnings search not run yet";
    default:
      return "News and warnings search unavailable";
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
          <span data-testid="today-news-status">{newsReviewText(props.newsReview, props.today)}</span>
          <AiSpark use="news_review" size={14} />
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
              <li class={`today-alert ${alert.severity}`} id={alertDomId(alert.id)} tabIndex={-1} data-alert-id={alert.id}>
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
