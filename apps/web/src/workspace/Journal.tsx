import {
  For,
  Show,
  createEffect,
  createMemo,
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
import {
  POST_HARVEST_WINDOW_DAYS,
  amountsOutsideCycles,
  formatKg,
  formatRupees,
  newDraft,
  seasonTotals,
} from "../features/journal/model";
import "../features/journal/season-totals.css";
import { cycleRecords } from "../features/journal/records";
import { RecordsSection } from "../features/journal/RecordsSection";
import { ReportLauncher } from "./report/ReportLauncher";
import { polygonAreaHa } from "./fields/fieldsModel";
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
      if (c.id) d.cycleId = c.id;
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
  // Reading a failed resource throws; the load error is shown below instead of breaking the whole tab.
  const journal = () => (timeline.error ? undefined : timeline());
  // Totals are shown only once this farm's journal has loaded, so they never show another farm's or partial numbers.
  const loadedEntries = () => {
    const t = journal();
    return t &&
      (timeline.state === "ready" || timeline.state === "refreshing") &&
      t.farmId === s.farm()?.id
      ? t.entries
      : null;
  };
  const season = createMemo(() => {
    const entries = loadedEntries();
    return entries ? seasonTotals(entries, cycles(), today()) : [];
  });
  // Harvest and inputs: the same loaded-journal guard and attribution as the season totals. A cycle on a field gets that
  // field's drawn area (hectares) so irrigation in mm can also be shown as m3; a farm-wide cycle gets none.
  const records = createMemo(() => {
    const entries = loadedEntries();
    if (!entries) return [];
    const fields = s.workspace()?.fields ?? [];
    const areaHaByCycle: Record<string, number> = {};
    for (const c of cycles()) {
      const f = c.fieldId ? fields.find((x) => x.id === c.fieldId) : undefined;
      const ha = f ? polygonAreaHa(f.boundary) : 0;
      if (ha > 0) areaHaByCycle[c.id] = ha;
    }
    return cycleRecords(entries, cycles(), today(), { areaHaByCycle });
  });
  const outsideAmounts = createMemo(() => {
    const entries = loadedEntries();
    return entries ? amountsOutsideCycles(entries, cycles(), today()) : 0;
  });
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const entries = () =>
    journal()?.entries.filter(
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
              Journal entries<strong>{journal()?.entries.length ?? 0}</strong>
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
        <Show when={season().length > 0}>
          <section class="season-totals" aria-labelledby="season-totals-title">
            <div class="season-totals-heading">
              <Icon name="journal" />
              <h2 id="season-totals-title">Season totals</h2>
            </div>
            <div class="season-totals-grid">
              <For each={season()}>
                {(r) => (
                  <article
                    class="season-total-card"
                    data-testid="season-total"
                    aria-label={`Season totals for ${r.cropName ?? s.cropName(r.cropId)}`}
                  >
                    <div class="season-total-top">
                      <h3>{r.cropName ?? s.cropName(r.cropId)}</h3>
                      <span class="season-total-pill">
                        Farmer recorded · not an estimate
                      </span>
                    </div>
                    <p class="season-total-range">
                      sown {dateLabel(r.sowingDate)}
                      {r.from !== r.sowingDate
                        ? ` · counted from ${dateLabel(r.from)}`
                        : ""}
                      {" · "}
                      {r.ongoing ? "to today" : `to ${dateLabel(r.to)}`}
                      {r.windowTo !== r.to
                        ? ` · including entries up to ${dateLabel(r.windowTo)}`
                        : ""}
                    </p>
                    <p class="season-total-entries">
                      {plural(r.entries, "entry", "entries")}
                    </p>
                    <p class="season-total-money">
                      <span>Spent {formatRupees(r.expenseInr)}</span>
                      {" · "}
                      <span>Sold {formatRupees(r.saleInr)}</span>
                      {" · "}
                      <span
                        classList={{ "season-negative": r.netInr < 0 }}
                      >
                        Net {formatRupees(r.netInr)}
                      </span>
                    </p>
                    <p class="season-total-harvest">
                      Harvest recorded:{" "}
                      {r.harvestKg === null
                        ? "none recorded"
                        : formatKg(r.harvestKg)}
                      <Show when={r.harvestUnitsSkipped > 0}>
                        {" "}
                        <small>
                          (
                          {plural(
                            r.harvestUnitsSkipped,
                            "harvest entry",
                            "harvest entries",
                          )}{" "}
                          in other units not added)
                        </small>
                      </Show>
                    </p>
                    <p class="season-total-note">
                      {`Totals add your journal expenses and sale amounts from sowing to harvest and up to ${POST_HARVEST_WINDOW_DAYS} days after; they are not the plan's profit estimate.`}
                    </p>
                    <Show when={r.overlapping > 0}>
                      <p class="season-total-note">
                        {r.overlapping === 1
                          ? "1 entry also falls inside another crop's dates and is counted here, in the crop that started last."
                          : `${r.overlapping} entries also fall inside another crop's dates and are counted here, in the crop that started last.`}
                      </p>
                    </Show>
                  </article>
                )}
              </For>
            </div>
            <Show when={outsideAmounts() > 0}>
              <p class="season-total-note season-total-outside" role="note">
                {outsideAmounts() === 1
                  ? "1 entry with a money amount falls outside every crop's dates (for example seed bought before sowing or a sale long after the harvest) and is not counted above."
                  : `${outsideAmounts()} entries with money amounts fall outside every crop's dates (for example seed bought before sowing or a sale long after the harvest) and are not counted above.`}
              </p>
            </Show>
          </section>
        </Show>
        {/* No Today view is loaded on this tab, so no regional yield band is passed (yieldBands is left unset). */}
        <Show when={records().length > 0}>
          <RecordsSection records={records()} dateLabel={dateLabel} cropName={s.cropName} />
        </Show>
        <Show when={cycles().length > 0}>
          <ReportLauncher cycles={cycles()} cropName={s.cropName} dateLabel={dateLabel} fieldName={(id) => s.workspace()?.fields?.find((f) => f.id === id)?.name} />
        </Show>
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
                      <Show when={e.sale}>
                        <p class="journal-event-money">
                          Sale ₹{e.sale!.amountInr}
                          {e.sale!.note ? ` (${e.sale!.note})` : ""}
                        </p>
                      </Show>
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
