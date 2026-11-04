import { For, Show } from "solid-js";
import type { OverviewPoint, OverviewPointKind, TodayOverview as OverviewData } from "@harvest/contracts";
import { AiSpark } from "../ui/AiSpark";
import { Icon } from "../icons";
import { alertDomId } from "./AlertsList";
import type { CardKind } from "./TodayCards";
import { stepDomId } from "./UpcomingSteps";

export const POINT_KIND_LABEL: Record<OverviewPointKind, string> = {
  do_now: "Do now",
  watch: "Watch",
  money: "Money",
  later: "Later",
  good_news: "Good news",
};
const CARD_KINDS: readonly string[] = ["harvest", "price", "weather", "health", "profit", "residue", "energy", "carbon"] satisfies CardKind[];
export const isCardKind = (id: string): id is CardKind => CARD_KINDS.includes(id);

/** What a point's button does, resolved from its ref: the DOM id to scroll to, or the card whose sheet opens. Null: the point is plain text. */
export type PointTarget = { kind: "dom"; domId: string; hint: string } | { kind: "card"; card: CardKind; hint: string };
export function pointTarget(point: Pick<OverviewPoint, "ref">): PointTarget | null {
  const ref = point.ref;
  if (!ref) return null;
  if (ref.kind === "step") return { kind: "dom", domId: stepDomId(ref.id), hint: "go to the step" };
  if (ref.kind === "alert") return { kind: "dom", domId: alertDomId(ref.id), hint: "go to the alert" };
  return isCardKind(ref.id) ? { kind: "card", card: ref.id, hint: "open the details" } : null;
}

/** Scroll a step or alert card into view and move focus to it (the same move `showStep` makes). */
function jumpTo(domId: string) {
  const node = document.getElementById(domId);
  node?.scrollIntoView({ block: "center", behavior: "smooth" });
  node?.focus({ preventScroll: true });
}

/** Whether the AI mark shows: a model-written overview, or one still being written. */
export const showsAiMark = (overview: Pick<OverviewData, "status" | "origin">) => overview.status === "pending" || overview.origin === "model";

/**
 * "Today for you": the headline and up to five points that say what today's facts mean and what to do. A point with a
 * ref is a button (step or alert: scroll and focus; card: open its details sheet). Pending shows the code-written
 * points with a quiet "Updating with AI…" line. Unavailable, null, or nothing to say: no card at all.
 */
export function TodayOverview(props: { overview: OverviewData | null | undefined; onDetails: (kind: CardKind) => void }) {
  const shown = () => {
    const o = props.overview;
    return o && o.status !== "unavailable" && (o.headline || o.points.length) ? o : null;
  };
  const lead = () => shown()?.points.find((point) => point.kind === "do_now") ?? shown()?.points.find((point) => point.kind === "watch");
  const leadTarget = () => lead() ? pointTarget(lead()!) : null;
  const activate = (target: PointTarget) => {
    if (target.kind === "dom") jumpTo(target.domId);
    else props.onDetails(target.card);
  };
  const pointRow = (point: OverviewPoint) => {
    const target = pointTarget(point);
    return (
      <li class="today-overview-point" data-kind={point.kind}>
        <span class="today-chip today-overview-chip">{POINT_KIND_LABEL[point.kind]}</span>
        <Show when={target} fallback={<span class="today-overview-text">{point.text}</span>}>
          {(t) => (
            <button
              type="button"
              class="today-overview-text today-overview-button"
              data-ref-kind={point.ref!.kind}
              data-ref-id={point.ref!.id}
              data-target={t().kind === "dom" ? (t() as { domId: string }).domId : undefined}
              onClick={() => {
                activate(t());
              }}
            >
              <span>{point.text}</span>
              <span class="today-sr"> ({t().hint})</span>
              <Icon name="arrow" size={12} />
            </button>
          )}
        </Show>
      </li>
    );
  };
  return (
    <Show when={shown()}>
      {(overview) => (
        <section class={`today-overview ${overview().status}`} aria-labelledby="today-overview-title" data-testid="today-overview">
          <div class="today-overview-brief">
            <div class="today-overview-head">
              <h2 id="today-overview-title">Today for you</h2>
              <Show when={showsAiMark(overview())}>
                <AiSpark use="today_overview" size={14} />
              </Show>
            </div>
            <Show when={overview().headline || lead()?.text}>
              <p class="today-overview-headline">{overview().headline || lead()?.text}</p>
            </Show>
            <Show when={leadTarget()}>
              {(target) => <button type="button" class="btn compact secondary today-overview-action" onClick={() => activate(target())}>
                {lead()?.ref?.kind === "step" ? "Review next step" : lead()?.ref?.kind === "alert" ? "Review alert" : "View details"}
                <Icon name="arrow" size={14} />
              </button>}
            </Show>
          </div>
          <Show when={overview().status === "pending"}>
            <p class="today-overview-pending" aria-live="polite" data-testid="today-overview-pending">
              Updating with AI…
            </p>
          </Show>
          {/* Keep the entire brief and all its original references, with urgent notes first. */}
          <Show when={overview().points.length}>
            <details class="today-overview-more">
              <summary>Notes and updates <span>{overview().points.length} notes<Show when={overview().points.some((point) => point.kind === "watch")}> · Watch updates</Show></span><Icon name="down" size={15} /></summary>
              <ol class="today-overview-points">
                <For each={overview().points.filter((point) => point.kind === "do_now" || point.kind === "watch")}>{pointRow}</For>
                <For each={overview().points.filter((point) => point.kind !== "do_now" && point.kind !== "watch")}>{pointRow}</For>
              </ol>
            </details>
          </Show>
        </section>
      )}
    </Show>
  );
}
