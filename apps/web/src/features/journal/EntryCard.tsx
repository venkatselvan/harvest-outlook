import { For, Show, createSignal } from "solid-js";
import { ApiError } from "../../lib/api";
import { analysisFailureMessage, loadEntry, requestAnalysis, waitForJob, type ConfirmResult, type JournalEntry, type JournalRevision, type Timeline } from "./api";
import { ACTIVITIES } from "./model";
import { fieldLabel, ProposalItem, valueLabel } from "./ProposalItem";
import { WhyChanged } from "./WhyChanged";

const QUALITY_TEXT: Record<string, string> = {
  blur: "may be blurry",
  too_dark: "looks too dark",
  too_bright: "looks too bright",
  low_contrast: "has little contrast",
  too_small: "is small",
  too_far: "is taken from far away",
  occluded: "is partly blocked",
  no_crop_visible: "does not clearly show the crop",
  other: "may not be clear",
};

function Analysis(props: { entry: JournalEntry; plan: Timeline["currentPlan"]; stageNames: Record<string, string>; onEntry: (e: JournalEntry) => void; onResult: (r: ConfirmResult) => void; onReload: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  const a = () => props.entry.analysis;

  const analyze = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const q = await requestAnalysis(props.entry.id);
      if (q.jobId) await waitForJob(q.jobId);
      const fresh = await loadEntry(props.entry.id);
      props.onEntry(fresh);
      if (fresh.analysis?.status !== "succeeded") setMessage(analysisFailureMessage(fresh.analysis?.errorCode ?? null));
    } catch (e) {
      setMessage(e instanceof ApiError && e.code === "timeout" ? e.message : e instanceof ApiError ? e.message : "The analysis did not finish. Your entry is saved. You can try again.");
    } finally {
      setBusy(false);
    }
  };

  const proposals = () => props.entry.facts.filter((f) => f.kind === "proposed" && (f.analysisId === a()?.id || f.source === "farmer"));
  const photoIssues = () => (props.entry.imageQuality?.issues ?? []).map((i) => QUALITY_TEXT[i] ?? i);

  return (
    <div class="jr-analysis">
      <Show when={props.entry.media.length > 0 && (!a() || a()!.status === "failed" || a()!.status === "unavailable")}>
        <button type="button" class="btn" onClick={analyze} disabled={busy()}>{a() ? "Analyze photo again" : "Analyze photo"}</button>
      </Show>
      <Show when={busy()}>
        <p role="status" aria-live="polite">Analyzing your photo… you can keep this page open.</p>
      </Show>
      <Show when={message()}>
        <p role="alert" class="jr-error">{message()}</p>
      </Show>
      <Show when={!busy() && (a()?.status === "failed" || a()?.status === "unavailable") && !message()}>
        <p role="alert" class="jr-error">{analysisFailureMessage(a()!.errorCode)}</p>
      </Show>
      <Show when={photoIssues().length > 0}>
        <p class="jr-note" role="status">Photo check (computed on the server, a rough guide): the photo {photoIssues().join(", ")}. A clearer photo gives the AI more to work with.</p>
      </Show>
      <Show when={a()?.status === "succeeded"}>
        <section class="jr-ai" aria-label="AI reading of your photo">
          <p class="jr-ai-label">{a()!.label}</p>
          <Show when={a()!.provenance === "synthetic_fixture"}>
            <p class="jr-synthetic" role="note">Synthetic demonstration answer from a fixture. It is not a reading of your photo.</p>
          </Show>
          <Show when={a()!.requestAnotherAngle}>
            <p class="jr-warn" role="status">The photo was not clear enough to propose anything. Please take a closer photo in daylight, showing a few plants and the soil.</p>
          </Show>
          <Show when={a()!.aiNarrative}>
            <p data-testid="ai-narrative">{a()!.aiNarrative!.text}</p>
            <p class="jr-small">{a()!.aiNarrative!.label}</p>
          </Show>
          <Show when={a()!.visibleObservations.length > 0}>
            <h4>What the AI says it sees</h4>
            <ul><For each={a()!.visibleObservations}>{(o) => <li>{o}</li>}</For></ul>
          </Show>
          <Show when={a()!.competingInterpretations.length > 0}>
            <h4>Possible explanations</h4>
            <ul><For each={a()!.competingInterpretations}>{(c) => <li><strong>{c.label}.</strong> {c.rationale}</li>}</For></ul>
          </Show>
          <Show when={a()!.missingContext.length > 0}>
            <h4>What would help</h4>
            <ul><For each={a()!.missingContext}>{(m) => <li>{m}</li>}</For></ul>
          </Show>
        </section>
      </Show>
      <Show when={proposals().length > 0}>
        <section aria-label="Proposals to confirm">
          <h4>Proposals</h4>
          <ul class="jr-proposals">
            <For each={proposals()}>
              {(f) => <ProposalItem fact={f} entry={props.entry} plan={props.plan} stageNames={props.stageNames} onResult={(r) => r && props.onResult(r)} onReload={props.onReload} />}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  );
}

export function EntryCard(props: {
  entry: JournalEntry;
  revisions: JournalRevision[];
  plan: Timeline["currentPlan"];
  stageNames: Record<string, string>;
  onEntry: (e: JournalEntry) => void;
  onResult: (r: ConfirmResult) => void;
  onReload: () => void;
}) {
  const e = () => props.entry;
  const activity = () => ACTIVITIES.find((a) => a.value === e().activity)?.label ?? "Entry";
  const confirmed = () => e().facts.filter((f) => f.kind === "confirmed");
  return (
    <article class="card jr-entry" data-testid="journal-entry" aria-label={`${activity()} on ${e().observedOn}`}>
      <h3>{activity()} <span class="jr-date">· {e().observedOn}</span></h3>
      <Show when={e().media.length > 0}>
        <div class="jr-photos">
          <For each={e().media}>
            {(m) => (
              <figure>
                <img src={m.contentPath} alt={m.label} loading="lazy" width="240" />
                <figcaption>{m.label}</figcaption>
              </figure>
            )}
          </For>
        </div>
      </Show>
      <Show when={e().note}><p class="jr-notetext">{e().note}</p></Show>
      <dl class="facts">
        <Show when={e().quantity}><dt>Quantity</dt><dd>{e().quantity!.value} {e().quantity!.unit}</dd></Show>
        <Show when={e().expense}><dt>Expense</dt><dd>₹{e().expense!.amountInr} ({e().expense!.category})</dd></Show>
      </dl>
      <p class="jr-small">{e().provenanceLabel}</p>
      <Show when={confirmed().length > 0}>
        <div data-testid="confirmed-facts">
          <h4>Confirmed by you</h4>
          <ul><For each={confirmed()}>{(f) => <li>{fieldLabel(f.field)}: {valueLabel(f, props.stageNames)}</li>}</For></ul>
        </div>
      </Show>
      <Analysis entry={e()} plan={props.plan} stageNames={props.stageNames} onEntry={props.onEntry} onResult={props.onResult} onReload={props.onReload} />
      <For each={props.revisions}>
        {(r, i) => (
          <details class="jr-revision" open={i() === 0} data-testid="revision">
            <summary>Plan updated {r.createdAt.slice(0, 10)}</summary>
            <WhyChanged changes={r.changes} summary={r.changeSummary} stageNames={props.stageNames} />
          </details>
        )}
      </For>
    </article>
  );
}
