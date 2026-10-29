import { clockNow, isOnline } from "../features/offline/status";
import { staleLabelText } from "../features/plan-cache/freshness";

/** "Saved 5 minutes ago · offline". Shown on every panel that is rendered from a snapshot. */
export function StaleLabel(props: { fetchedAt: number | null }) {
  return (
    <p class="stale-label" data-testid="stale-label">
      {staleLabelText(props.fetchedAt, clockNow(), isOnline())}
    </p>
  );
}
