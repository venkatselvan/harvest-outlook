import { For, Show, createSignal } from "solid-js";
import type { YearPlanOption } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { longSpan } from "./format";
import { ROLE_LABEL, ROLE_ORDER, draftFromOption, isLegume, type CropChoice, type DraftSlot } from "./model";

const MAX_SLOTS = 6;

/** Default sowing date for an added crop: 30 days after the latest sowing in the draft, kept inside the horizon. */
function nextSowing(drafts: readonly DraftSlot[], horizon: { from: string; to: string }): string {
  const latest = drafts.map((d) => d.sowing).filter(Boolean).sort().at(-1) ?? horizon.from;
  const d = new Date(`${latest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  const iso = d.toISOString().slice(0, 10);
  return iso > horizon.to ? horizon.to : iso < horizon.from ? horizon.from : iso;
}

/**
 * Inline editor for one option, shown inside the detail sheet. The crop already growing stays fixed. Each other crop
 * can be swapped (pool crops only, grouped by rotation role, legumes badged), moved to another sowing date, or removed.
 * Submitting asks the server to re-score by code; no model call is involved.
 */
export function SlotEditor(props: {
  option: YearPlanOption;
  horizon: { from: string; to: string };
  choices: readonly CropChoice[];
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (drafts: DraftSlot[]) => void;
}) {
  const [drafts, setDrafts] = createSignal<DraftSlot[]>(draftFromOption(props.option));
  let added = 0;
  const update = (key: string, patch: Partial<DraftSlot>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const choice = (cropId: string) => props.choices.find((c) => c.cropId === cropId);
  const groups = () =>
    ROLE_ORDER.map((role) => ({ role, crops: props.choices.filter((c) => c.role === role) })).filter((g) => g.crops.length);

  return (
    <form
      class="yp-editor"
      aria-label={`Edit ${props.option.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.busy) props.onSubmit(drafts());
      }}
    >
      <p class="yp-editor-intro">Change a crop or its sowing date. The plan is re-scored straight away.</p>
      <For each={drafts()}>
        {(draft, index) => {
          const slot = () => props.option.slots.find((s) => s.slotId === draft.slotId);
          return (
            <Show
              when={!draft.fixed}
              fallback={
                <div class="yp-edit-fixed">
                  <strong>{slot()?.cropName ?? draft.cropId}</strong>
                  <span>
                    Growing now
                    <Show when={slot()}>{(s) => <> · harvest {longSpan(s().harvest.earliest, s().harvest.latest)}</>}</Show>
                  </span>
                </div>
              }
            >
              <fieldset class="yp-edit-slot">
                <legend>Crop {index() + 1}</legend>
                <div class="yp-edit-fields">
                  <label>
                    <span>Crop</span>
                    <select
                      value={draft.cropId}
                      onChange={(event) => {
                        const next = choice(event.currentTarget.value);
                        update(draft.key, { cropId: event.currentTarget.value, productId: next?.products[0]?.productId ?? "" });
                      }}
                    >
                      <Show when={!draft.cropId}>
                        <option value="">Choose a crop</option>
                      </Show>
                      <For each={groups()}>
                        {(group) => (
                          <optgroup label={ROLE_LABEL[group.role]}>
                            <For each={group.crops}>
                              {(crop) => (
                                <option value={crop.cropId}>
                                  {crop.name}
                                  {crop.role === "nitrogen_fixer" ? " (legume)" : ""}
                                </option>
                              )}
                            </For>
                          </optgroup>
                        )}
                      </For>
                    </select>
                  </label>
                  <Show when={(choice(draft.cropId)?.products.length ?? 0) > 1}>
                    <label>
                      <span>Product</span>
                      <select value={draft.productId} onChange={(event) => update(draft.key, { productId: event.currentTarget.value })}>
                        <For each={choice(draft.cropId)?.products ?? []}>
                          {(product) => <option value={product.productId}>{product.name}</option>}
                        </For>
                      </select>
                    </label>
                  </Show>
                  <label>
                    <span>Sowing date</span>
                    <input
                      type="date"
                      value={draft.sowing}
                      min={props.horizon.from}
                      max={props.horizon.to}
                      onInput={(event) => update(draft.key, { sowing: event.currentTarget.value })}
                    />
                  </label>
                </div>
                <div class="yp-edit-actions">
                  <Show when={isLegume(draft.cropId)}>
                    <Chip tone="legume">Legume, adds nitrogen</Chip>
                  </Show>
                  <button
                    type="button"
                    class="yp-link-button is-danger"
                    disabled={drafts().length <= 1}
                    onClick={() => setDrafts((list) => list.filter((d) => d.key !== draft.key))}
                  >
                    Remove {choice(draft.cropId)?.name ?? "this crop"}
                  </button>
                </div>
              </fieldset>
            </Show>
          );
        }}
      </For>
      <Show when={drafts().length < MAX_SLOTS}>
        <button
          type="button"
          class="yp-link-button"
          onClick={() =>
            setDrafts((list) => [
              ...list,
              { key: `added-${++added}`, fixed: false, cropId: "", productId: "", sowing: nextSowing(list, props.horizon) },
            ])
          }
        >
          + Add a crop
        </button>
      </Show>
      <Show when={props.error}>
        <p class="yp-inline-error" role="alert">
          {props.error}
        </p>
      </Show>
      <div class="yp-editor-buttons">
        <button type="button" class="btn secondary" onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button type="submit" class="btn" disabled={props.busy}>
          {props.busy ? "Re-scoring…" : "Re-score plan"}
        </button>
      </div>
    </form>
  );
}
