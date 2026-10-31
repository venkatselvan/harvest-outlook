import { For, Show } from "solid-js";
import type { FarmCommandCenter } from "@harvest/contracts";
import type { CommandCycle } from "./types";

/**
 * Undated care guidance from the command center for the shown crop, kept from the previous Today tab and collapsed:
 * stage-dependent guidance (observation required, no date) and references from other regions (no scheduled dates).
 * Neither is a dated step, so neither has a Done button.
 */
export function CareGuidance(props: { entry: CommandCycle | undefined; sources: FarmCommandCenter["sources"] | undefined }) {
  const source = (id: string) => props.sources?.find((item) => item.id === id);
  const refs = (list: { sourceId: string; locator: string }[]) => (
    <For each={list}>
      {(ref) => (
        <Show when={source(ref.sourceId)} fallback={<p>{ref.locator}</p>}>
          {(item) => (
            <a href={item().url} target="_blank" rel="noreferrer noopener">
              {item().publisher} · {ref.locator} <span aria-hidden="true">↗</span>
            </a>
          )}
        </Show>
      )}
    </For>
  );
  return (
    <>
      <Show when={props.entry?.stageGuidance?.length}>
        <details class="stage-guidance-panel">
          <summary>Stage checks without a date ({props.entry!.stageGuidance!.length})</summary>
          <For each={props.entry!.stageGuidance}>
            {(guidance) => (
              <article>
                <h3>{guidance.title}</h3>
                <p>{guidance.action}</p>
                <Show when={guidance.applicability && guidance.applicability !== "matched"}>
                  <p class="source-applicability-note">
                    {guidance.applicability === "outside_source_region"
                      ? "This source covers another region. Confirm local applicability before acting."
                      : "The field location has not been matched to this source region. Confirm local applicability before acting."}
                  </p>
                </Show>
                <For each={guidance.conditions}>{(condition) => <p>{condition}</p>}</For>
                {refs(guidance.sourceRefs)}
                <p class="muted">No date has been assigned. Check the actual crop stage before acting.</p>
              </article>
            )}
          </For>
        </details>
      </Show>
      <Show when={props.entry?.referenceGuidance?.length}>
        <details class="stage-guidance-panel">
          <summary>Other-region care references ({props.entry!.referenceGuidance!.length})</summary>
          <p class="source-applicability-note">
            These references have no scheduled field dates. Confirm local applicability with an agronomist before acting.
          </p>
          <For each={props.entry!.referenceGuidance}>
            {(guidance) => (
              <article>
                <h3>{guidance.title}</h3>
                <p>{guidance.action}</p>
                <p>{guidance.reason}</p>
                <For each={guidance.conditions}>{(condition) => <p>{condition}</p>}</For>
                {refs(guidance.sourceRefs)}
              </article>
            )}
          </For>
        </details>
      </Show>
    </>
  );
}
