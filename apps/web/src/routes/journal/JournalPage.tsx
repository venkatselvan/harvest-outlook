import "../../features/photo-region/photo-region.css";
import "../../features/journal/journal.css";
import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js";
import { apiRequest } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";
import { loadTimeline, type ConfirmResult, type JournalEntry, type Timeline } from "../../features/journal/api";
import { EntryCard } from "../../features/journal/EntryCard";
import { getOwnerScope } from "../../features/offline/scope";
import { scopedStore } from "../../features/journal/model";
import { createIdbStore } from "../../features/journal/idbStore";
import { JournalForm } from "../../features/journal/JournalForm";
import { issueHref } from "../../features/journal/issueFromFacts";
import { useWorkspace, today, type Boundary } from "../../workspace/state";
import { Sheet } from "../../workspace/ui/Sheet";
import { IssueForm, type FieldOption } from "../../workspace/scouting/IssueForm";
import type { IssuePrefill } from "../../workspace/scouting/scoutingModel";

const SELECTED_KEY = "ho.selectedFarm";
interface FarmLite {
  id: string;
  name: string;
  location: { districtName: string | null };
}

async function loadFarms(): Promise<FarmLite[]> {
  return (await apiRequest<{ farms: FarmLite[] }>("/api/v1/farms")).data!.farms;
}
const selectedFarm = (farms: FarmLite[]): FarmLite | null => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SELECTED_KEY);
  } catch {
    /* storage blocked */
  }
  return farms.find((f) => f.id === saved) ?? farms[0] ?? null;
};

const store = scopedStore(createIdbStore(), () => getOwnerScope());

/** Functional Journal screen: entry form, analysis with confirmable proposals, and the season timeline. */
export function JournalPage() {
  const [farms] = createResource(loadFarms);
  const farm = createMemo(() => (farms() ? selectedFarm(farms()!) : null));
  const [timeline, { refetch, mutate }] = createResource(
    () => farm()?.id,
    (id) => loadTimeline(id),
  );
  const [notice, setNotice] = createSignal<string | null>(null);
  const [lastSaved, setLastSaved] = createSignal<string | null>(null);
  const ws = useWorkspace();
  /** "Log as an issue": the entry's prefill while the sheet is open, and the issue each confirmed fact was logged as (this visit). */
  const [logging, setLogging] = createSignal<{ farmId: string; prefill: IssuePrefill } | null>(null);
  const [logged, setLogged] = createSignal<Record<string, string>>({});
  const [issueNotice, setIssueNotice] = createSignal<string | null>(null);
  const fieldOptions = (farmId: string): FieldOption[] => {
    const w = ws.workspace();
    return w && w.farmId === farmId ? (w.fields ?? []).map((x) => ({ id: x.id, name: x.name, boundary: x.boundary })) : [];
  };
  const farmBoundary = (farmId: string): Boundary | null => {
    const w = ws.workspace();
    return w && w.farmId === farmId ? w.boundary : null;
  };

  const stageNames = createMemo(() => Object.fromEntries((timeline()?.currentPlan?.stages ?? []).map((s) => [s.stageId, s.name])));
  const patchEntry = (e: JournalEntry) => mutate((t: Timeline | undefined) => (t ? { ...t, entries: t.entries.map((x) => (x.id === e.id ? e : x)) } : t));

  const onSaved = async (e: JournalEntry) => {
    setNotice("Saved. Your entry is recorded exactly as you entered it.");
    setLastSaved(e.id);
    await refetch();
    queueMicrotask(() => document.getElementById(`entry-${e.id}`)?.scrollIntoView({ block: "nearest" }));
  };
  const onResult = async (r: ConfirmResult) => {
    setNotice(r.revision ? "Your plan was updated to a new version. The earlier version stays saved." : "Your decision was saved.");
    patchEntry(r.entry);
    await refetch();
  };

  return (
    <div class="jr-page">
      <h1>Journal</h1>
      <p class="jr-small">Photos, notes and costs for your season. What you enter is saved as you entered it. AI proposals only count after you confirm them.</p>
      <Switch>
        <Match when={farms.error}>
          <p role="alert" class="jr-error">Could not load your farm{farms.error instanceof ApiError ? `: ${farms.error.message}` : ""}. <button type="button" class="btn secondary" onClick={() => location.reload()}>Reload</button></p>
        </Match>
        <Match when={farms.loading}>
          <p role="status">Loading your farm…</p>
        </Match>
        <Match when={!farm()}>
          <div class="card">
            <p>Add your farm first so entries can be linked to it.</p>
            <a class="btn" href="/farm">Go to My farm</a>
          </div>
        </Match>
        <Match when={farm()}>
          {(f) => (
            <>
              <Show when={notice()}>
                <p class="jr-note" role="status" data-testid="journal-notice">{notice()}</p>
              </Show>
              <Show when={issueNotice()}>
                <p class="jr-note" role="status" data-testid="issue-notice">
                  Issue logged. <a href={issueHref(issueNotice()!)}>View it on Today</a>
                </p>
              </Show>
              <Show when={logging()}>
                {(open) => (
                  <Sheet title="Log an issue" subtitle="From your confirmed journal entry" closeLabel="Close new issue" class="sc-sheet" onClose={() => setLogging(null)}>
                    <IssueForm
                      farmId={open().farmId}
                      fields={fieldOptions(open().farmId)}
                      farmBoundary={farmBoundary(open().farmId)}
                      today={today()}
                      prefill={open().prefill}
                      onCreated={(issue) => {
                        const factId = open().prefill.fromFactId;
                        if (factId) setLogged((m) => ({ ...m, [factId]: issue.id }));
                        setIssueNotice(issue.id);
                        setLogging(null);
                      }}
                      onCancel={() => setLogging(null)}
                    />
                  </Sheet>
                )}
              </Show>
              <JournalForm cycles={ws.farm()?.id === f().id ? ws.workspace()?.cycles.map(c => ({id:c.id,name:`${ws.workspace()?.fields?.find(field => field.id === c.fieldId)?.name ?? 'Farm'} · ${c.cropName ?? c.cropId}`})) : undefined} farmId={f().id} stages={timeline()?.currentPlan?.stages ?? []} store={store} onSaved={onSaved} />
              <section class="jr-timeline" aria-labelledby="jr-timeline-title">
                <h2 id="jr-timeline-title">Season timeline</h2>
                <Switch>
                  <Match when={timeline.error}>
                    <p role="alert" class="jr-error">Could not load the timeline. <button type="button" class="btn secondary" onClick={() => void refetch()}>Try again</button></p>
                  </Match>
                  <Match when={timeline.loading && !timeline()}>
                    <p role="status">Loading your timeline…</p>
                  </Match>
                  <Match when={timeline()}>
                    {(t) => (
                      <>
                        <Show when={t().entries.length === 0}>
                          <p>No entries yet. Your first entry will appear here.</p>
                        </Show>
                        <For each={t().entries}>
                          {(e) => (
                            <div id={`entry-${e.id}`} tabindex="-1" data-latest={lastSaved() === e.id ? "true" : undefined}>
                              <EntryCard
                                entry={e}
                                revisions={t().revisions.filter((r) => r.entryId === e.id)}
                                plan={t().currentPlan}
                                stageNames={stageNames()}
                                onEntry={patchEntry}
                                onResult={onResult}
                                onReload={() => void refetch()}
                                onLogIssue={(_entry, prefill) => {
                                  setIssueNotice(null);
                                  setLogging({ farmId: f().id, prefill });
                                }}
                                loggedIssueId={(factId) => logged()[factId]}
                              />
                            </div>
                          )}
                        </For>
                        <Show when={t().completedTasks.length > 0}>
                          <section class="card" aria-label="Completed tasks">
                            <h3>Completed tasks</h3>
                            <ul class="jr-tasks">
                              <For each={t().completedTasks}>{(c) => <li>{c.taskId} · done {c.completedOn}</li>}</For>
                            </ul>
                          </section>
                        </Show>
                      </>
                    )}
                  </Match>
                </Switch>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}
