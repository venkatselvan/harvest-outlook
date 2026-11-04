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
  /**
   * 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.4, 12.6): the list belongs to one field of a farm with fields, so alerts that
   * cover the whole farm (weather, price, news) get a small "Farm-wide" chip. Omitted on a farm without fields.
   */
  fieldView?: boolean;
  /**
   * 2026-11-04 (TODAY_MAP_LAYOUT_SPEC.md, Actions tab): "actions" shapes each alert as an action card: an eyebrow (farm ·
   * field), the title, "01 · Evidence" (the alert text and its dated source), "02 · Suggested action" and one button.
   */
  variant?: "actions" | undefined;
  /** The eyebrow line of an action card ("Kabini farm · Farm-wide"). */
  eyebrow?: ((alert: FarmAlert) => string) | undefined;
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

/** An alert that is not tied to one field: `scope: 'farm'`, or (older servers without scope) no fieldId. */
export const isFarmWide = (alert: Pick<FarmAlert, "scope" | "fieldId">): boolean =>
  alert.scope ? alert.scope === "farm" : !alert.fieldId;

export function sortAlerts(alerts: readonly FarmAlert[]): FarmAlert[] {
  return [...alerts].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

/** One alert as an action card (Actions tab). The suggested step's button jumps to the step, as in the regular list. */
function AlertActionCard(props: { alert: FarmAlert; eyebrow?: ((alert: FarmAlert) => string) | undefined; hasStep: boolean; onSuggested: (alert: FarmAlert) => void }) {
  const alert = () => props.alert;
  return (
    <div class="today-alert-body today-action-card">
      <p class="today-action-eyebrow">
        <span>{props.eyebrow?.(alert()) ?? typeLabel[alert().type]}</span>
        <span class={`today-chip severity ${alert().severity}`}>{severityLabel[alert().severity]}</span>
      </p>
      <h3>{alert().title}</h3>
      <dl class="today-action-evidence">
        <div>
          <dt>01 · Evidence</dt>
          <dd>
            <span>{alert().detail}</span>
            <a class="today-alert-source" href={alert().source.url} target="_blank" rel="noreferrer noopener">
              {alert().source.name} · {formatDay(alert().source.date)} <span aria-hidden="true">↗</span>
              <span class="today-sr"> (opens in a new tab)</span>
            </a>
          </dd>
        </div>
        <div>
          <dt>02 · Suggested action</dt>
          <dd>{alert().suggestedStep ?? "This alert names no step; read it and decide whether it applies to your field."}</dd>
        </div>
      </dl>
      <div class="today-action-footer">
        <span>
          {typeLabel[alert().type]} · until {formatDay(alert().validTo, false)}
        </span>
        <Show when={alert().suggestedStep && props.hasStep}>
          <button type="button" class="btn compact secondary" aria-label={`Review the suggested step: ${alert().suggestedStep}`} onClick={() => props.onSuggested(alert())}>
            Review step <Icon name="arrow" size={13} />
          </button>
        </Show>
      </div>
      <span class="today-sr">Valid {rangeLabel(alert().validFrom, alert().validTo)}.</span>
    </div>
  );
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
                <Show when={props.variant !== "actions"} fallback={<AlertActionCard alert={alert} eyebrow={props.eyebrow} hasStep={props.stepAlertIds.has(alert.id)} onSuggested={props.onSuggested} />}>
                <div class="today-alert-body">
                  <p class="today-alert-kicker">
                    <span class={`today-chip severity ${alert.severity}`}>{severityLabel[alert.severity]}</span>
                    <span>{typeLabel[alert.type]}</span>
                    <span>· until {formatDay(alert.validTo, false)}</span>
                    <Show when={props.fieldView && isFarmWide(alert)}>
                      <span class="today-chip today-alert-scope" data-testid="alert-farm-wide" title="This alert covers the whole farm, not only this field">
                        Farm-wide
                      </span>
                    </Show>
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
                </Show>
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
