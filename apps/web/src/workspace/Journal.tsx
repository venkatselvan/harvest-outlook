import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { A } from "@solidjs/router";
import {
  useWorkspace,
  today,
  dateLabel,
  type Cycle,
  type Workspace,
} from "./state";
import { PageHeading } from "./FarmPage";
import { Icon } from "./icons";
import { loadTimeline, submitDraft } from "../features/journal/api";
import { newDraft } from "../features/journal/model";
import {
  apiRequest,
  jsonInit,
  newEntryId,
} from "../features/photo-region/http";
const STAGES = [
  { id: "sowed", label: "Sowed", icon: "leaf" },
  { id: "growing", label: "Growing", icon: "leaf" },
  { id: "flowering", label: "Flowering", icon: "sun" },
  { id: "harvested", label: "Harvested", icon: "check" },
];
export function JournalWorkspace() {
  const s = useWorkspace();
  const [timeline, { refetch }] = createResource(
    () => s.farm()?.id,
    loadTimeline,
  );
  const [editor, setEditor] = createSignal<Partial<Cycle> | null>(null);
  const [observed, setObserved] = createSignal(today());
  const [note, setNote] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let draftId = newEntryId("journal");
  let savedJournal = false;
  let editorFarmId: string | undefined;
  const [filter, setFilter] = createSignal("all");
  const update = (p: Partial<Cycle>) => setEditor({ ...editor(), ...p });
  createEffect(
    on(
      () => s.farm()?.id,
      () => {
        setEditor(null);
        setError("");
      },
    ),
  );
  function open(c?: Cycle) {
    if (busy()) return;
    draftId = newEntryId("journal");
    savedJournal = false;
    editorFarmId = s.farm()?.id;
    setEditor(
      c ?? { id: newEntryId("cycle"), stage: "sowed", sowingDate: today() },
    );
    setObserved(today());
    setNote("");
    setError("");
  }
  async function save() {
    if (busy()) return;
    if (editorFarmId !== s.farm()?.id || s.workspace.loading) {
      setError(
        "The selected farm changed or is still loading. Reopen this record for the current farm.",
      );
      return;
    }
    const c = editor();
    if (!c?.cropId || !c.sowingDate) {
      setError("Choose a crop and its sowing date.");
      return;
    }
    if (observed() < c.sowingDate) {
      setError("Observation must be on or after sowing.");
      return;
    }
    if (c.sowingDate > today() || observed() > today()) {
      setError(
        "Recorded events must be today or earlier. Add future crops in your rotation planner.",
      );
      return;
    }
    if (
      c.stage === "harvested" &&
      (!c.harvestDate ||
        c.harvestDate < c.sowingDate ||
        c.harvestDate > today())
    ) {
      setError("Choose a harvest date between sowing and today.");
      return;
    }
    const targetFarmId = editorFarmId!;
    const epoch = s.sessionEpoch();
    const capturedWorkspace = s.workspace()!;
    setBusy(true);
    setError("");
    try {
      const cropName = s.cropName(c.cropId);
      const cycle = {
        ...c,
        id: c.id ?? newEntryId("cycle"),
        cropName,
      } as Cycle;
      const d = newDraft(targetFarmId, draftId);
      d.observedOn =
        c.stage === "sowed"
          ? c.sowingDate
          : c.stage === "harvested"
            ? c.harvestDate!
            : observed();
      d.note =
        `${cropName} · ${STAGES.find((x) => x.id === c.stage)?.label ?? c.stage}. ${note()}`.trim();
      d.activity =
        c.stage === "sowed"
          ? "planting"
          : c.stage === "harvested"
            ? "harvest"
            : "observation";
      if (!savedJournal) {
        await submitDraft(d);
        savedJournal = true;
      }
      if (epoch !== s.sessionEpoch()) return;
      await apiRequest<Workspace>(
        `/api/v1/farms/${targetFarmId}/workspace`,
        jsonInit("PUT", {
          expectedVersion: capturedWorkspace.version,
          boundary: capturedWorkspace.boundary,
          previousHarvest:
            cycle.stage === "harvested" &&
            cycle.harvestDate &&
            (capturedWorkspace.previousHarvest.status !== "known" ||
              cycle.harvestDate >=
                capturedWorkspace.previousHarvest.harvestDate)
              ? {
                  status: "known",
                  cropId: cycle.cropId,
                  cropName,
                  harvestDate: cycle.harvestDate,
                }
              : capturedWorkspace.previousHarvest,
          cycles: [
            ...capturedWorkspace.cycles.filter((x) => x.id !== cycle.id),
            cycle,
          ],
          rotationPlans: capturedWorkspace.rotationPlans,
        }),
      );
      if (s.farm()?.id === targetFarmId && epoch === s.sessionEpoch()) {
        await s.refreshWorkspace();
        await refetch();
        setEditor(null);
        s.setNotice("Crop progress recorded.");
      }
    } catch (e) {
      if (s.farm()?.id === targetFarmId && epoch === s.sessionEpoch()) {
        void s.refreshWorkspace();
        setError(
          `${savedJournal ? "Your journal event is saved; the progress card could not update. Retry to finish without duplicating the event. " : ""}${(e as Error).message}`,
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const cycles = () => s.workspace()?.cycles ?? [];
  const entries = () =>
    timeline()?.entries.filter(
      (e) => filter() === "all" || e.activity === filter(),
    ) ?? [];
  return (
    <div class="workspace-page">
      <PageHeading
        eyebrow="A RECORD OF REAL PROGRESS"
        title="Every season has a story."
        description="Record when you sowed, what you noticed, and when you harvested. Keep your field history together."
      >
        <A class="btn secondary" href="/journal/detail">
          Photos & detailed journal
          <Icon name="arrow" size={17} />
        </A>
        <button
          class="btn"
          disabled={!s.farm() || s.workspace.loading}
          onClick={() => open()}
        >
          <Icon name="plus" size={17} />
          Record crop progress
        </button>
      </PageHeading>
      <Show
        when={s.farm()}
        fallback={
          <div class="empty-state">
            <Icon name="journal" size={36} />
            <h2>Give your season a home.</h2>
            <p>Set up your farm before recording crop progress.</p>
            <A href="/farm" class="btn">
              Set up your farm
            </A>
          </div>
        }
      >
        <div class="journal-summary">
          <div>
            <Icon name="leaf" />
            <span>
              Active crops
              <strong>
                {cycles().filter((c) => c.stage !== "harvested").length}
              </strong>
            </span>
          </div>
          <div>
            <Icon name="check" />
            <span>
              Harvested crops
              <strong>
                {cycles().filter((c) => c.stage === "harvested").length}
              </strong>
            </span>
          </div>
          <div>
            <Icon name="journal" />
            <span>
              Journal entries<strong>{timeline()?.entries.length ?? 0}</strong>
            </span>
          </div>
          <div>
            <Icon name="pin" />
            <span>
              Current farm
              <strong class="farm-summary-name">{s.farm()?.name}</strong>
            </span>
          </div>
        </div>
        <section class="crop-progress-section">
          <div class="section-heading">
            <div>
              <h2>Crop progress</h2>
              <span class="tiny-pill">Farmer recorded</span>
            </div>
            <button class="text-button" onClick={() => open()}>
              + Start a crop record
            </button>
          </div>
          <Show
            when={cycles().length}
            fallback={
              <div class="journal-start">
                <span class="round-feature">
                  <Icon name="leaf" size={30} />
                </span>
                <div>
                  <h3>Start with the day you sowed.</h3>
                  <p>
                    Add a crop and follow it from the first seed to the last
                    harvest.
                  </p>
                </div>
                <button class="btn secondary" onClick={() => open()}>
                  Record your first crop
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            }
          >
            <div class="crop-progress-grid">
              <For each={cycles()}>
                {(c) => (
                  <article class="progress-card">
                    <div class="progress-card-header">
                      <span class="season-row-icon">
                        <Icon name="leaf" size={24} />
                      </span>
                      <div>
                        <h3>{c.cropName ?? s.cropName(c.cropId)}</h3>
                        <p>Sowed {dateLabel(c.sowingDate)}</p>
                      </div>
                      <span
                        class={`tiny-pill ${c.stage === "harvested" ? "completed" : ""}`}
                      >
                        {STAGES.find((x) => x.id === c.stage)?.label}
                      </span>
                    </div>
                    <div class="progress-stages">
                      <For each={STAGES}>
                        {(stage, i) => (
                          <div
                            classList={{
                              done:
                                i() <=
                                STAGES.findIndex((x) => x.id === c.stage),
                            }}
                          >
                            <span>
                              <Icon
                                name={
                                  i() <
                                  STAGES.findIndex((x) => x.id === c.stage)
                                    ? "check"
                                    : stage.icon
                                }
                                size={16}
                              />
                            </span>
                            <small>{stage.label}</small>
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="progress-card-footer">
                      <span>
                        {c.harvestDate
                          ? `Harvested ${dateLabel(c.harvestDate)}`
                          : "Stage reported by you"}
                      </span>
                      <button class="text-link" onClick={() => open(c)}>
                        Update progress
                        <Icon name="arrow" size={15} />
                      </button>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </section>
        <section class="journal-log">
          <div class="section-heading">
            <div>
              <Icon name="journal" />
              <h2>From your field</h2>
            </div>
            <div class="segmented-control">
              <For
                each={[
                  { id: "all", label: "All entries" },
                  { id: "planting", label: "Sowing" },
                  { id: "observation", label: "Observations" },
                  { id: "harvest", label: "Harvests" },
                ]}
              >
                {(f) => (
                  <button
                    classList={{ active: filter() === f.id }}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <Show when={timeline.error}>
            <p class="inline-error" role="alert">
              Could not load your journal.{" "}
              <button class="text-button" onClick={() => void refetch()}>
                Try again
              </button>
            </p>
          </Show>
          <Show
            when={entries().length}
            fallback={
              <div class="small-empty">
                <Icon name="journal" />
                <p>
                  {timeline.loading
                    ? "Loading your field journal…"
                    : "Your field notes and crop events will appear here."}
                </p>
              </div>
            }
          >
            <div class="journal-timeline">
              <For each={entries()}>
                {(e) => (
                  <article class="journal-event">
                    <div class="journal-event-mark">
                      <Icon
                        name={
                          e.activity === "harvest"
                            ? "check"
                            : e.activity === "planting"
                              ? "leaf"
                              : "journal"
                        }
                        size={19}
                      />
                    </div>
                    <div class="journal-event-body">
                      <div>
                        <span class="eyebrow">
                          {(e.activity ?? "Observation").replace(/_/g, " ")}
                        </span>
                        <time>{dateLabel(e.observedOn)}</time>
                      </div>
                      <h3>{e.note ?? "Field entry"}</h3>
                      <Show when={e.media.length}>
                        <div class="journal-event-photos">
                          <For each={e.media}>
                            {(m) => <img src={m.contentPath} alt={m.label} />}
                          </For>
                        </div>
                      </Show>
                      <span class="entry-source">
                        {e.provenanceLabel ?? "Recorded by you"}
                      </span>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>
      <Show when={editor()}>
        <div class="modal-backdrop">
          <section
            class="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="progress-title"
          >
            <button
              class="modal-close icon-button"
              aria-label="Close crop progress"
              onClick={() => setEditor(null)}
            >
              <Icon name="close" />
            </button>
            <p class="eyebrow">A NOTE FROM YOUR FIELD</p>
            <h2 id="progress-title">
              {editor()?.cropId
                ? "How is your crop doing?"
                : "Start a crop record"}
            </h2>
            <p class="muted">
              Record what happened. These dates and stages are your
              observations.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset
                class="unstyled-fieldset"
                disabled={busy() || savedJournal}
              >
                <label>
                  Crop
                  <select
                    value={editor()?.cropId ?? ""}
                    onChange={(e) => update({ cropId: e.currentTarget.value })}
                    required
                  >
                    <option value="">Choose a crop</option>
                    <For each={s.crops() ?? []}>
                      {(c) => <option value={c.cropId}>{c.name}</option>}
                    </For>
                  </select>
                </label>
                <div class="form-grid">
                  <label>
                    Sowed on
                    <input
                      type="date"
                      value={editor()?.sowingDate ?? ""}
                      max={today()}
                      onInput={(e) =>
                        update({ sowingDate: e.currentTarget.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Current stage
                    <select
                      value={editor()?.stage ?? "sowed"}
                      onChange={(e) =>
                        update({
                          stage: e.currentTarget.value as Cycle["stage"],
                        })
                      }
                    >
                      <For each={STAGES}>
                        {(st) => <option value={st.id}>{st.label}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <Show
                  when={editor()?.stage === "harvested"}
                  fallback={
                    <Show when={editor()?.stage !== "sowed"}>
                      <label>
                        Observed on
                        <input
                          type="date"
                          value={observed()}
                          min={editor()?.sowingDate}
                          max={today()}
                          onInput={(e) => setObserved(e.currentTarget.value)}
                        />
                      </label>
                    </Show>
                  }
                >
                  <label>
                    Harvested on
                    <input
                      type="date"
                      value={editor()?.harvestDate ?? ""}
                      min={editor()?.sowingDate}
                      max={today()}
                      onInput={(e) =>
                        update({ harvestDate: e.currentTarget.value })
                      }
                      required
                    />
                  </label>
                </Show>
                <label>
                  Field note <small>optional</small>
                  <textarea
                    rows="3"
                    placeholder="What are you noticing in the field?"
                    value={note()}
                    onInput={(e) => setNote(e.currentTarget.value)}
                  />
                </label>
              </fieldset>
              <Show when={error()}>
                <p class="inline-error" role="alert">
                  {error()}
                </p>
              </Show>
              <button class="btn full-width" disabled={busy()}>
                {busy() ? "Saving…" : "Save crop progress"}
                <Icon name="check" size={17} />
              </button>
            </form>
          </section>
        </div>
      </Show>
    </div>
  );
}
