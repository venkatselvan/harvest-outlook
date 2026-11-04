import { For, Show } from "solid-js";
import type { YearPlanOption } from "@harvest/contracts";
import { Sheet } from "../ui/Sheet";
import { longDate, longSpan } from "./format";
import { displayLabel, intercropName, isIntercrop, joinNames, replacementText, slotsToApply, type YearPlanReplacement } from "./model";

/**
 * Confirmation before applying an option. Lists exactly the seasons that will be appended to the saved seasons (the
 * crop already growing is not added again). After success it says how many were added; an option that is already
 * applied cannot be applied twice from here.
 */
export function ApplyConfirm(props: {
  option: YearPlanOption;
  applied: boolean;
  busy: boolean;
  error: string;
  /** Number of seasons added by the request that just succeeded; null before. */
  added: number | null;
  /**
   * The planned, unsown saved seasons an alternative takes over (EVARA_ACTIONS_SPEC.md 1.3); they are removed in the same
   * write as the new seasons are added. Empty or omitted for the review's own plans.
   */
  replaces?: readonly YearPlanReplacement[] | undefined;
  /** True for an option of the alternatives block (replace_planned): when `replaces` is then empty, the sheet says no planned season is removed. */
  alternative?: boolean | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const seasons = () => slotsToApply(props.option);
  const fixed = () => props.option.slots.find((s) => s.fixed);
  const done = () => props.added != null;
  const replaced = () => props.replaces ?? [];
  const keepsAll = () => !!props.alternative && replaced().length === 0;
  return (
    <Sheet
      title={done() ? (replaced().length ? "Your saved seasons were changed" : "Added to your saved seasons") : replaced().length ? "Use these seasons instead?" : "Add these seasons?"}
      subtitle={<span>{displayLabel(props.option)}</span>}
      closeLabel="Close add seasons"
      onClose={() => props.onClose()}
      class="yp-apply"
      footer={
        <Show
          when={!done()}
          fallback={
            <button type="button" class="btn" onClick={() => props.onClose()}>
              Done
            </button>
          }
        >
          <button type="button" class="btn secondary" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            disabled={props.busy || props.applied || seasons().length === 0}
            onClick={() => {
              if (!props.busy && !props.applied) props.onConfirm();
            }}
          >
            {props.applied
              ? "Already in saved seasons"
              : props.busy
                ? replaced().length
                  ? "Replacing…"
                  : "Adding…"
                : `${replaced().length ? "Replace with" : "Add"} ${seasons().length} season${seasons().length === 1 ? "" : "s"}`}
          </button>
        </Show>
      }
    >
      <Show
        when={!done()}
        fallback={
          <p class="yp-apply-done" role="status">
            {props.added === 0
              ? "These seasons were already saved; nothing was added."
              : `${props.added} season${props.added === 1 ? " was" : "s were"} added.${replaced().length ? ` Removed: ${joinNames(replaced().map((r) => r.cropName))}.` : keepsAll() ? " No planned season was removed." : ""} You can find them under Saved seasons.`}
          </p>
        }
      >
        <p class="yp-apply-intro">
          {keepsAll()
            ? "These will be added to your saved seasons. No planned season is removed."
            : replaced().length
            ? "These will be added to your saved seasons and the planned seasons listed after them will be removed. Nothing has been sown for those yet."
            : "These will be added to your saved seasons. You can edit or remove them there later."}
        </p>
        <ul class="yp-apply-list">
          <For each={seasons()}>
            {(s) => (
              <li>
                <strong>
                  {isIntercrop(s) ? intercropName(s) : `${s.cropName} · ${s.productName}`}
                </strong>
                <span>
                  Sow {longDate(s.sowing)} · harvest {longSpan(s.harvest.earliest, s.harvest.latest)}
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={keepsAll()}>
          <p class="yp-apply-note">No planned season is removed.</p>
        </Show>
        <Show when={replaced().length}>
          <ul class="yp-apply-list yp-apply-removed" aria-label="Planned seasons that will be removed">
            <For each={replaced()}>
              {(r) => (
                <li>
                  <strong>Removed: {replacementText(r)}</strong>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={fixed()}>
          {(f) => <p class="yp-apply-note">{f().cropName} is already recorded as growing, so it is not added again.</p>}
        </Show>
        <Show when={props.error}>
          <p class="yp-inline-error" role="alert">
            {props.error}
          </p>
        </Show>
      </Show>
    </Sheet>
  );
}
