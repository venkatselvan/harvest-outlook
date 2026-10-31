import type { PlanningProposal } from "@harvest/contracts";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onMount,
  onCleanup,
} from "solid-js";
import { A } from "@solidjs/router";
import { Evara } from "./Evara";
import { Icon } from "./icons";
import { useWorkspace, dateLabel } from "./state";
export function PlanningReviewPanel(props: {
  compact?: boolean;
  comparison?: boolean;
  onEditProposal?: (proposal: PlanningProposal) => void;
}) {
  const s = useWorkspace();
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [error, setError] = createSignal("");
  const [retrying, setRetrying] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    onCleanup(() => clearInterval(timer));
  });
  const review = s.planningReview;
  const retryBlocked = () =>
    retrying() ||
    (!!review()?.retryAfter && Date.parse(review()!.retryAfter!) > clock());
  const pending = () =>
    s.planningLoading() ||
    ["pending", "running"].includes(review()?.status ?? "");
  const drafts = () => review()?.rotationDraft ?? [];
  const shortlist = () =>
    [...(review()?.comparisonShortlist ?? [])].sort((a, b) => a.rank - b.rank);
  const leadReason = (reason: string) =>
    reason.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? reason;
  const evidenceStatus = (refs: string[]) =>
    review()?.evidence.some(
      (source) => refs.includes(source.id) && source.reviewStatus === "pending",
    )
      ? "Source review pending"
      : "Source checked";
  const alreadyApplied = (id: string) =>
    review()?.appliedProposalIds.includes(id) ?? false;
  createEffect(
    on(
      () =>
        [
          s.farm()?.id,
          review()?.reviewId,
          drafts()
            .map((p) => p.id)
            .join("|"),
        ] as const,
      () => {
        setChosen(
          drafts()
            .filter((p) => !alreadyApplied(p.id))
            .map((p) => p.id),
        );
        setError("");
      },
    ),
  );
  createEffect(
    on(
      () => review()?.appliedProposalIds.join("|"),
      () =>
        setChosen((previous) => previous.filter((id) => !alreadyApplied(id))),
    ),
  );
  const toggle = (id: string) =>
    setChosen(
      chosen().includes(id)
        ? chosen().filter((x) => x !== id)
        : [...chosen(), id],
    );
  async function retry() {
    setError("");
    setRetrying(true);
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    try {
      await s.refreshPlanningReview();
    } catch (e) {
      if (farmId === s.farm()?.id && epoch === s.sessionEpoch())
        setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  }
  async function apply() {
    setError("");
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    try {
      await s.applyPlanningReview(chosen());
      if (farmId === s.farm()?.id && epoch === s.sessionEpoch()) setChosen([]);
    } catch (e) {
      if (farmId === s.farm()?.id && epoch === s.sessionEpoch()) {
        setError((e as Error).message);
        void s.refreshWorkspace();
      }
    }
  }
  const context = () => review()?.localContext;
  const history = () => context()?.history.previousHarvest;
  const status = () =>
    s.planningSetupPending()
      ? "setup"
      : s.planningError()
        ? "error"
        : pending()
          ? "preparing"
          : (review()?.status ?? "preparing");
  return (
    <section
      class={`evara-planning-panel ${props.compact ? "compact" : ""} ${props.comparison ? "for-comparison" : ""}`}
      aria-label="Evara localized planning review"
    >
      <div class="evara-planning-heading">
        <Evara size={51} />
        <div>
          <p class="eyebrow">EVARA · A STARTING POINT FOR YOUR LAND</p>
          <h2>
            {props.comparison
              ? "Your shortlist starts with local context."
              : "The next twelve months, considered."}
          </h2>
          <p>
            {s.planningSetupPending()
              ? "Confirm your harvest history to start Evara's first planning review."
              : pending()
                ? "Gathering sourced crop windows, your farm history, local weather and dated market references."
                : (review()?.summary ??
                  "Evara prepares an initial review from the evidence available for this farm.")}
          </p>
        </div>
        <span class={`planning-status ${status()}`}>
          {status() === "preparing"
            ? "Preparing your review"
            : status() === "ready"
              ? "Ready to review"
              : status() === "partial"
                ? "Partial evidence"
                : status() === "setup"
                  ? "One step to go"
                  : status() === "error"
                    ? "Review unavailable"
                    : status() === "unavailable"
                      ? "Evidence unavailable"
                      : status()}
        </span>
      </div>
      <Show when={s.planningSetupPending()}>
        <div class="planning-setup-callout">
          <Icon name="history" size={19} />
          <p>
            Choose a previous harvest, first season, or explicitly unknown
            history. Unknown history is a valid starting point.
          </p>
          <A class="btn secondary compact" href="/farm?history=1">
            Confirm harvest history
            <Icon name="arrow" size={15} />
          </A>
        </div>
      </Show>
      <Show when={context()}>
        <div class="planning-context-row">
          <span>
            <Icon name="pin" size={14} />
            <strong>
              {context()?.location.districtName ??
                context()?.location.stateId ??
                "Location unknown"}
            </strong>{" "}
            · {context()?.location.granularity} context
          </span>
          <span>
            <Icon name="sun" size={14} />
            {context()?.weather.status === "unavailable"
              ? "Forecast unavailable"
              : `${context()?.weather.status === "stale" ? "Stale forecast" : "Forecast"} issued ${context()?.weather.issuedAt ? dateLabel(context()!.weather.issuedAt!.slice(0, 10)) : "date unavailable"}`}
          </span>
          <span>
            <Icon name="trend" size={14} />
            {context()?.mandi.references.length
              ? `${context()!.mandi.references.length} dated mandi references`
              : "No dated mandi quotes"}
          </span>
          <span>
            <Icon name="history" size={14} />
            {history()?.status === "known"
              ? `Last harvest: ${history()!.status === "known" ? ((history() as { cropName?: string; cropId: string }).cropName ?? s.cropName((history() as { cropId: string }).cropId)) : ""}`
              : history()?.status === "none"
                ? "First season"
                : "Harvest history unknown"}
            {context()?.history.basis === "illustrative"
              ? " · historical demo record; confirm before use"
              : ""}
          </span>
        </div>
      </Show>
      <Show when={pending() && !s.planningSetupPending()}>
        <div class="planning-preparing" role="status">
          <span class="planning-progress-line" />
          <div>
            <strong>
              {review()?.status === "running"
                ? "Reviewing the evidence for your farm"
                : "Preparing your first options"}
            </strong>
            <p>
              Recommendations will appear here automatically. Your saved seasons
              stay in place.
            </p>
          </div>
          <span class="activity-pulse">
            <i />
            <i />
            <i />
          </span>
        </div>
      </Show>
      <Show
        when={
          !pending() &&
          ["error", "unavailable"].includes(review()?.status ?? "")
        }
      >
        <div class="planning-retry-row">
          <p>
            {review()?.retryAfter
              ? `Next retry window: ${new Date(review()!.retryAfter!).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
              : "Available records are kept; this review has not produced a complete proposal."}
          </p>
          <button
            class="text-button"
            disabled={retryBlocked()}
            onClick={() => void retry()}
          >
            {retrying() ? "Checking…" : "Check review availability"}
          </button>
        </div>
      </Show>
      <Show when={s.planningError()}>
        <div class="planning-error" role="status">
          <p>{s.planningError()?.message}</p>
          <button
            class="text-button"
            disabled={retryBlocked()}
            onClick={() => void retry()}
          >
            {retrying() ? "Checking…" : "Try the review again"}
          </button>
        </div>
      </Show>
      <Show when={!pending() && review() && !s.planningSetupPending()}>
        <Show when={drafts().length && !props.comparison}>
          <div class="planning-draft-title">
            <div>
              <Icon name="calendar" size={17} />
              <h3>Proposed sequence</h3>
              <span>
                {review()?.horizon.from
                  ? dateLabel(review()!.horizon.from)
                  : ""}{" "}
                → {review()?.horizon.to ? dateLabel(review()!.horizon.to) : ""}
              </span>
            </div>
            <span class="tiny-pill">
              Reviewable proposals · {drafts().length} seasons
            </span>
          </div>
          <div class="planning-sequence">
            <For each={props.compact ? drafts().slice(0, 3) : drafts()}>
              {(proposal, i) => (
                <article
                  class={`planning-proposal ${alreadyApplied(proposal.id) ? "applied" : ""}`}
                >
                  <div class="planning-proposal-top">
                    <span class="proposal-order">
                      {String(i() + 1).padStart(2, "0")}
                    </span>
                    <span class="proposal-scope">
                      {proposal.scope} evidence
                    </span>
                    <Show when={!props.compact}>
                      <label class="proposal-checkbox">
                        <input
                          type="checkbox"
                          aria-label={`Include ${proposal.cropName} in rotation`}
                          checked={chosen().includes(proposal.id)}
                          disabled={
                            alreadyApplied(proposal.id) || s.applyingPlanning()
                          }
                          onChange={() => toggle(proposal.id)}
                        />
                      </label>
                    </Show>
                  </div>
                  <h3>{proposal.cropName}</h3>
                  <span class="proposal-product">{proposal.productName}</span>
                  <div class="proposal-dates">
                    <span>
                      Sow{" "}
                      <strong>{dateLabel(proposal.plannedSowingDate)}</strong>
                    </span>
                    <Icon name="arrow" size={14} />
                    <span>
                      Estimated harvest{" "}
                      <strong>{dateLabel(proposal.plannedHarvestDate)}</strong>
                    </span>
                  </div>
                  <p>{proposal.reason}</p>
                  <Show
                    when={
                      !props.compact &&
                      props.onEditProposal &&
                      !alreadyApplied(proposal.id)
                    }
                  >
                    <button
                      class="text-link proposal-edit"
                      onClick={() => props.onEditProposal?.(proposal)}
                    >
                      Edit proposal
                      <Icon name="settings" size={13} />
                    </button>
                  </Show>
                  <Show when={proposal.conditional}>
                    <span class="proposal-conditional">
                      <Icon name="settings" size={12} />
                      Conditional · confirm open requirements
                    </span>
                  </Show>
                  <Show when={alreadyApplied(proposal.id)}>
                    <span class="proposal-added">
                      <Icon name="check" size={13} />
                      Added to your rotation
                    </span>
                  </Show>
                  <Show when={proposal.uncertainties.length}>
                    <details>
                      <summary>Open conditions</summary>
                      <For each={proposal.uncertainties}>
                        {(text) => <p>{text}</p>}
                      </For>
                    </details>
                  </Show>
                </article>
              )}
            </For>
          </div>
          <div class="planning-apply-row">
            <p>
              Proposed dates use sourced crop windows and crop-duration ranges.
              Rotation suitability remains unassessed.
            </p>
            <Show
              when={!props.compact}
              fallback={
                <A class="btn" href="/planner">
                  Review proposed seasons
                  <Icon name="arrow" size={16} />
                </A>
              }
            >
              <button
                class="btn"
                disabled={
                  !chosen().length ||
                  s.applyingPlanning() ||
                  s.workspace.loading ||
                  s.planningLoading() ||
                  !!review()?.stale
                }
                onClick={() => void apply()}
              >
                {s.applyingPlanning()
                  ? "Adding selected seasons…"
                  : `Add ${chosen().length} selected to rotation`}
                <Icon name="plus" size={16} />
              </button>
            </Show>
          </div>
        </Show>
        <Show when={shortlist().length}>
          <div class="planning-shortlist">
            <div class="planning-shortlist-title">
              <h3>Crops worth comparing</h3>
              <span>
                Prioritized options, with their next sourced sowing dates
              </span>
            </div>
            <div class="planning-picks">
              <For each={shortlist().slice(0, 3)}>
                {(pick) => (
                  <article>
                    <span
                      class="planning-pick-icon"
                      aria-label={`Priority ${pick.rank}`}
                    >
                      #{pick.rank}
                    </span>
                    <div>
                      <strong>
                        {pick.cropName}
                        <small>{pick.productName}</small>
                      </strong>
                      <p>{leadReason(pick.reason)}</p>
                      <span class="planning-pick-window">
                        Next window: {dateLabel(pick.nextSowingDate)} ·{" "}
                        {pick.scope} evidence
                        {pick.availability === "conflicts_with_existing_plan"
                          ? " · overlaps a saved season"
                          : pick.availability === "unknown_current_harvest"
                            ? " · current harvest date unknown"
                            : ""}
                      </span>
                      <span class="planning-pick-evidence">
                        {evidenceStatus(pick.evidenceRefs)}
                      </span>
                      <details class="planning-option-reason">
                        <summary>Why this option</summary>
                        <p>{pick.reason}</p>
                        <For each={pick.uncertainties}>
                          {(condition) => <p>{condition}</p>}
                        </For>
                        <For
                          each={
                            review()?.evidence.filter((source) =>
                              pick.evidenceRefs.includes(source.id),
                            ) ?? []
                          }
                        >
                          {(source) => (
                            <p>
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {source.title}
                              </a>{" "}
                              · {source.scope} ·{" "}
                              {source.reviewStatus === "pending"
                                ? "source review pending"
                                : "source checked"}
                            </p>
                          )}
                        </For>
                      </details>
                    </div>
                  </article>
                )}
              </For>
            </div>
            <Show when={!props.comparison}>
              <A href="/explore" class="text-link">
                Compare Evara's shortlist
                <Icon name="arrow" size={16} />
              </A>
            </Show>
          </div>
        </Show>
        <Show when={!drafts().length && !shortlist().length}>
          <div class="planning-no-options">
            <Icon name="leaf" size={27} />
            <div>
              <strong>
                {context()?.occupancy.some((o) => o.end === null)
                  ? "Current harvest date is needed"
                  : context()?.occupancy.length
                    ? "No unoccupied planting window yet"
                    : "No supported planting window yet"}
              </strong>
              <p>
                {review()?.summary ||
                  "The available sources do not support a proposal for this farm yet."}{" "}
                You can keep planning manually while the missing context is
                resolved.
              </p>
            </div>
          </div>
        </Show>
        <Show when={review()?.stale}>
          <p class="planning-stale" role="status">
            This review was prepared before the latest farm context. Check it
            against your current records before applying.
            <button
              class="text-button"
              disabled={retryBlocked()}
              onClick={() => void retry()}
            >
              Refresh review
            </button>
          </p>
        </Show>
        <details class="planning-evidence">
          <summary>Location, sources and limits of this review</summary>
          <p>
            <strong>Location scope:</strong>{" "}
            {context()?.location.granularity ?? "unknown"}.{" "}
            {context()?.location.village
              ? `${context()!.location.village} · farmer reported`
              : "Village-level evidence is not available."}{" "}
            {context()?.location.limitations.join(" ")}
          </p>
          <p>
            <strong>Weather:</strong> {context()?.weather.source} ·{" "}
            {context()?.weather.status}. Forecast data covers the returned
            near-term days and does not establish next year's rainfall.{" "}
            {context()?.weather.limitations.join(" ")}
          </p>
          <p>
            <strong>Mandi references:</strong> stored dated quotes, not a price
            forecast. {context()?.mandi.limitations.join(" ")}
          </p>
          <For each={context()?.mandi.references.slice(0, 4) ?? []}>
            {(ref) => (
              <p>
                {ref.marketName} · {dateLabel(ref.date)} · ₹
                {Number(ref.inrPerKg).toLocaleString("en-IN")} / kg ·{" "}
                {ref.scope}
              </p>
            )}
          </For>
          <For each={review()?.evidence ?? []}>
            {(source) => (
              <p>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>{" "}
                · {source.scope} evidence ·{" "}
                {source.reviewStatus === "pending"
                  ? "source review pending"
                  : "source checked"}
                . {source.limitations.join(" ")}
              </p>
            )}
          </For>
          <For each={review()?.limitations ?? []}>
            {(limitation) => <p>{limitation}</p>}
          </For>
          <Show when={review()?.modelInvocation}>
            <p>
              Model:{" "}
              {review()?.modelInvocation?.model ??
                review()?.modelInvocation?.requestedModel}{" "}
              · {review()?.modelInvocation?.status}.
            </p>
          </Show>
        </details>
      </Show>
      <Show when={error()}>
        <p class="inline-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
