import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { classifyFailure, getCropEvidence } from "../../lib/catalogue-api";
import { evidenceIdsOf, humanize, locatorText, safeLink } from "./logic";
import type { CompareItem, EvidenceCitation } from "./types";

const cache = new Map<string, Promise<EvidenceCitation[]>>();
/** One request per crop per page load. A failed request is dropped from the cache so the next open retries. */
export function loadEvidence(cropId: string, fetcher: (id: string) => Promise<EvidenceCitation[]> = getCropEvidence): Promise<EvidenceCitation[]> {
  let p = cache.get(cropId);
  if (!p) {
    p = fetcher(cropId).catch((e) => {
      cache.delete(cropId);
      throw e;
    });
    cache.set(cropId, p);
  }
  return p;
}
export const clearEvidenceCache = (): void => cache.clear();

function Citation(props: { id: string; ev: EvidenceCitation | undefined }) {
  return (
    <li class="cmp-cite">
      <Show when={props.ev} fallback={<span>Evidence record <code>{props.id}</code>: citation details are not in the catalogue response.</span>}>
        {(ev) => (
          <>
            <span>{ev().citation.publisher}, {ev().citation.documentTitle}, {locatorText(ev().locator)}.</span>{" "}
            <Show when={safeLink(ev())} fallback={<span class="cmp-muted">No public link available.</span>}>
              {(href) => <a href={href()} target="_blank" rel="noopener noreferrer">Open source</a>}
            </Show>
            <Show when={ev().excerpt}><q class="cmp-excerpt">{ev().excerpt}</q></Show>
            <span class="cmp-muted"> Source check: {ev().validationStatus === "validated" ? "validated" : "pending review"}. <code>{props.id}</code></span>
          </>
        )}
      </Show>
    </li>
  );
}

/** Expandable rule IDs and evidence citations. Citations load only when the section is opened. */
export function EvidenceDetails(props: { item: CompareItem }) {
  const [open, setOpen] = createSignal(false);
  const [evidence] = createResource(open, async (isOpen) => (isOpen ? await loadEvidence(props.item.cropId) : []));
  const ids = () => evidenceIdsOf(props.item);
  return (
    <details class="cmp-details" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Rule IDs and evidence ({props.item.screening.appliedRuleIds.length} rule{props.item.screening.appliedRuleIds.length === 1 ? "" : "s"}, {ids().length} evidence record{ids().length === 1 ? "" : "s"})</summary>
      <h4>Rules applied</h4>
      <Show when={props.item.screening.reasons.length} fallback={<p class="cmp-muted">No rule applied to this crop for your inputs.</p>}>
        <ul class="cmp-list">
          <For each={props.item.screening.reasons}>
            {(r) => (
              <li>
                <code>{r.ruleId}</code>: {humanize(r.effect)}, {r.truth === "unknown" ? "condition unknown" : `condition ${r.truth}`}; {r.reasonCodes.map(humanize).join(", ") || "no reason code"}.
                {" "}Review: {r.reviewStatus === "approved" ? "approved" : r.reviewStatus === "synthetic" ? "synthetic (candidate, unreviewed)" : r.reviewStatus}.
                <Show when={r.appliedExceptionId}> Regional exception applied: <code>{r.appliedExceptionId}</code>.</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h4>Evidence</h4>
      <Show when={ids().length} fallback={<p class="cmp-muted">No evidence record is attached to this card.</p>}>
        <Switch>
          <Match when={evidence.error}>
            <p role="alert" class="cmp-error">Could not load citations: {classifyFailure(evidence.error).message}</p>
          </Match>
          <Match when={evidence.loading}><p role="status">Loading citations…</p></Match>
          <Match when={evidence()}>
            {(list) => (
              <ul class="cmp-list">
                <For each={ids()}>{(id) => <Citation id={id} ev={list().find((e) => e.id === id)} />}</For>
              </ul>
            )}
          </Match>
        </Switch>
      </Show>
    </details>
  );
}

