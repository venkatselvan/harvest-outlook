import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import type { FieldIssue, IssueStatus, TodayView } from "@harvest/contracts";
import { Icon } from "../icons";
import { Sheet } from "../ui/Sheet";
import type { Boundary } from "../state";
import { describeScoutingError, loadIssues } from "./scoutingApi";
import type { DraftStore } from "./scoutingStore";
import {
  CATEGORY_LABEL,
  CATEGORY_MARK,
  day,
  filterCount,
  filterIssues,
  filterLabel,
  issuesLine,
  placeName,
  SEVERITY_LABEL,
  STATUS_FILTERS,
  STATUS_LABEL,
  type StatusFilter,
} from "./scoutingModel";
import { IssueForm, type FieldOption } from "./IssueForm";
import "./scouting.css";

/** DOM id of the issue list section (the Today line under the alerts scrolls to it). */
export const ISSUES_SECTION_ID = "today-issues";

/**
 * The Today line under the alerts (FIELD_OPERATIONS_SPEC.md 5.2): "<n> open issues · <latest title>" from `TodayView.issues`,
 * a button that moves to the issue list. Nothing renders when nothing is open or treating.
 */
export function IssuesLine(props: { issues: TodayView["issues"] | undefined; onShow: () => void }) {
  return (
    <Show when={issuesLine(props.issues)}>
      {(line) => (
        <button type="button" class="sc-issues-line" onClick={() => props.onShow()} data-testid="sc-issues-line">
          <span class="sc-issues-dot" aria-hidden="true" />
          <span>{line()}</span>
          <Icon name="arrow" size={13} />
        </button>
      )}
    </Show>
  );
}

export interface IssuesListViewProps {
  issues: readonly FieldIssue[];
  counts: Record<IssueStatus, number>;
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
  fieldName: (fieldId: string) => string | null;
  onOpen: (issue: FieldIssue) => void;
  onNew: () => void;
  /** "Strip 2 and farm-wide" or "Whole farm". */
  scope: string;
  status: "loading" | "error" | "ready";
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  canLog?: boolean | undefined;
}

/** The list: heading with the scope, status filter chips with counts, rows, and "Log an issue". */
export function IssuesListView(props: IssuesListViewProps) {
  const shown = () => filterIssues(props.issues, props.filter);
  return (
    <section class="today-section sc-issues" id={ISSUES_SECTION_ID} tabIndex={-1} aria-labelledby="sc-issues-title" data-testid="sc-issues">
      <div class="today-section-head">
        <h2 id="sc-issues-title">Field issues</h2>
        <p class="today-section-status">
          <span>{props.scope} · what you reported</span>
        </p>
      </div>
      <div class="sc-filters" role="group" aria-label="Show issues by status">
        <For each={STATUS_FILTERS}>
          {(f) => (
            <button type="button" class="sc-filter" aria-pressed={props.filter === f} onClick={() => props.onFilter(f)} data-filter={f}>
              {filterLabel(f)} <span class="sc-filter-count">{filterCount(props.counts, f)}</span>
            </button>
          )}
        </For>
      </div>
      <Switch>
        <Match when={props.status === "loading"}>
          <p class="today-empty-line" aria-busy="true">
            Loading your issues…
          </p>
        </Match>
        <Match when={props.status === "error"}>
          <div class="sc-error-line" role="alert">
            <p>{props.error ?? "Your issues could not load."}</p>
            <Show when={props.onRetry}>
              <button type="button" class="btn compact secondary" onClick={() => props.onRetry?.()}>
                Try again
              </button>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <Show
            when={shown().length}
            fallback={
              <p class="today-empty-line" data-testid="sc-issues-empty">
                {props.issues.length ? `No ${filterLabel(props.filter).toLowerCase()} issues.` : "No issues logged here. When you see something on a field walk, log it here."}
              </p>
            }
          >
            <ul class="sc-issue-list" data-testid="sc-issue-list">
              <For each={shown()}>
                {(issue) => (
                  <li>
                    <button type="button" class="sc-issue-row" onClick={() => props.onOpen(issue)} data-issue-id={issue.id}>
                      <span class={`sc-cat cat-${issue.category}`}>
                        <span class="sc-cat-mark" aria-hidden="true">
                          {CATEGORY_MARK[issue.category]}
                        </span>
                        {CATEGORY_LABEL[issue.category]}
                      </span>
                      <span class="sc-issue-title">{issue.title}</span>
                      <span class="sc-issue-meta">
                        <span class={`sc-chip severity-${issue.severity}`}>{SEVERITY_LABEL[issue.severity]}</span>
                        <span class={`sc-chip status-${issue.status}`}>{STATUS_LABEL[issue.status]}</span>
                        <span>{day(issue.observedOn)}</span>
                        <span>{placeName(issue.fieldId ?? null, props.fieldName)}</span>
                        <Show when={issue.seenBefore.length}>
                          <span class="sc-seen" data-testid="sc-seen-count">
                            Seen before: {issue.seenBefore.length} time{issue.seenBefore.length === 1 ? "" : "s"}
                          </span>
                        </Show>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Match>
      </Switch>
      <Show when={props.canLog !== false}>
        <button type="button" class="btn compact secondary sc-new" onClick={() => props.onNew()}>
          <Icon name="plus" size={14} /> Log an issue
        </button>
      </Show>
    </section>
  );
}

export interface IssuesSectionProps {
  farmId: string;
  /** The selected field (its issues plus farm-wide ones); null = every issue of the farm. */
  fieldId: string | null;
  fields: readonly FieldOption[];
  farmBoundary?: Boundary | null | undefined;
  today: string;
  /** Opens the issue sheet (the caller sets `?issue=<id>` and renders the sheet, so a deep link works on any Today state). */
  onOpenIssue: (issueId: string) => void;
  /** Something changed on the server (an issue or an event was saved): the caller refreshes Today. */
  onChanged?: (() => void) | undefined;
  /** Bumped by the caller to reload the list (for example after a check logged issues). */
  reloadKey?: number | undefined;
  store?: DraftStore | undefined;
}

/** The issue list on Today with the new-issue sheet. */
export function IssuesSection(props: IssuesSectionProps) {
  const [filter, setFilter] = createSignal<StatusFilter>("all");
  const [creating, setCreating] = createSignal(false);
  const [bump, setBump] = createSignal(0);
  const [list, { refetch }] = createResource(
    () => ({ farmId: props.farmId, fieldId: props.fieldId, reload: (props.reloadKey ?? 0) + bump() }),
    ({ farmId, fieldId }) => loadIssues(farmId, { fieldId }),
  );
  const fieldName = (id: string) => props.fields.find((f) => f.id === id)?.name ?? null;
  const ready = () => (list.state === "ready" || list.state === "refreshing") && list.latest?.farmId === props.farmId ? list.latest : null;
  const status = (): "loading" | "error" | "ready" => (ready() ? "ready" : list.error ? "error" : "loading");
  const scope = () => {
    if (!props.fields.length) return "Whole farm";
    const name = props.fieldId ? fieldName(props.fieldId) : null;
    return name ? `${name} and farm-wide` : "All fields";
  };
  const changed = () => {
    setBump((n) => n + 1);
    props.onChanged?.();
  };
  return (
    <>
      <IssuesListView
        issues={ready()?.issues ?? []}
        counts={ready()?.counts ?? { open: 0, treating: 0, resolved: 0, dismissed: 0 }}
        filter={filter()}
        onFilter={setFilter}
        fieldName={fieldName}
        onOpen={(issue) => props.onOpenIssue(issue.id)}
        onNew={() => setCreating(true)}
        scope={scope()}
        status={status()}
        error={list.error ? describeScoutingError(list.error).message : undefined}
        onRetry={() => void refetch()}
      />
      <Show when={creating()}>
        <Sheet title="Log an issue" subtitle="What you saw" closeLabel="Close new issue" class="sc-sheet" onClose={() => setCreating(false)}>
          <IssueForm
            farmId={props.farmId}
            fields={props.fields}
            farmBoundary={props.farmBoundary}
            defaultFieldId={props.fieldId}
            today={props.today}
            store={props.store}
            onCreated={(issue) => {
              setCreating(false);
              changed();
              props.onOpenIssue(issue.id);
            }}
            onCancel={() => setCreating(false)}
          />
        </Sheet>
      </Show>
    </>
  );
}
