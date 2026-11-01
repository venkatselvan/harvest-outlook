import { For, Show, createSignal } from "solid-js";
import type { CropFitCandidate, YearPlanOption } from "@harvest/contracts";
import { Icon } from "../icons";
import { Chip } from "../ui/Chip";
import { longSpan } from "./format";
import { isLegume } from "../cropPool";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  appendPick,
  applyPick,
  draftFromOption,
  nextCropContext,
  pickChangesDraft,
  pickerCurrent,
  swapContext,
  type CropChoice,
  type DraftSlot,
} from "./model";
import { SwapSheet } from "./SwapSheet";

const MAX_SLOTS = 6;

/** Default sowing date for an added crop: 30 days after the latest sowing in the draft, kept inside the horizon. */
function nextSowing(drafts: readonly DraftSlot[], horizon: { from: string; to: string }): string {
  const latest =
    drafts
      .map((d) => d.sowing)
      .filter(Boolean)
      .sort()
      .at(-1) ?? horizon.from;
  const d = new Date(`${latest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  const iso = d.toISOString().slice(0, 10);
  return iso > horizon.to ? horizon.to : iso < horizon.from ? horizon.from : iso;
}

/**
 * Inline editor for one option, shown inside the detail sheet. The crop already growing stays fixed. Each other crop
 * can be swapped (pool crops only, grouped by rotation role, legumes badged), moved to another sowing date, or removed.
 * A green manure can be inserted from the "Green manure" group (it is sent as kind 'green_manure' with productId equal
 * to the crop id). Round 3: every row has a swap button that opens the crop picker for that row's sowing date and previous
 * crop, and "Suggest next crop" opens it for the day after the last row; picking a crop puts it in the draft and
 * re-scores straight away. A swapped intercrop stays in the draft with its system id. Submitting asks the server to
 * re-score by code; no model call is involved.
 */
export function SlotEditor(props: {
  farmId: string;
  /** The crop before the plan's first free row (the scenario's previous crop); null when unknown. */
  previousCropId: string | null;
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
  const nameOf = (cropId: string) => choice(cropId)?.name ?? cropId;
  const [swapKey, setSwapKey] = createSignal<string | null>(null);
  const [suggesting, setSuggesting] = createSignal(false);
  const swapPicker = () => {
    const key = swapKey();
    const target = key ? drafts().find((d) => d.key === key) : undefined;
    if (!key || !target) return undefined;
    const context = swapContext(drafts(), key, props.previousCropId, props.horizon);
    return context ? { context, current: pickerCurrent(target), key, target } : undefined;
  };
  const next = () => nextCropContext(drafts(), props.horizon, props.previousCropId);
  const nextReason = () => {
    const n = next();
    return n.ok ? undefined : n.reason;
  };
  /** Put the new rows in the draft and re-score at once (the picker already showed the score for that date). */
  const commit = (rows: DraftSlot[]) => {
    setDrafts(rows);
    if (!props.busy) props.onSubmit(rows);
  };
  const onSwapPick = (candidate: CropFitCandidate) => {
    const picker = swapPicker();
    setSwapKey(null);
    if (!picker || !pickChangesDraft(picker.target, candidate)) return;
    commit(applyPick(drafts(), picker.key, candidate));
  };
  const onSuggestPick = (candidate: CropFitCandidate) => {
    setSuggesting(false);
    commit(appendPick(drafts(), `added-${++added}`, candidate));
  };
  const groups = () =>
    GROUP_ORDER.map((role) => ({
      role,
      crops: props.choices.filter((c) => c.role === role),
    })).filter((g) => g.crops.length);
  const manures = () => props.choices.filter((c) => c.role === "green_manure");
  /** Switch a row to another crop; a green manure also sets kind and uses its crop id as the product. */
  const pick = (key: string, cropId: string) => {
    const chosen = choice(cropId);
    // A hand-picked crop is a sole crop: an intercrop system belongs to the crop it was found for.
    const cleared = {
      systemId: undefined,
      companionLabel: undefined,
      endsOn: undefined,
      picked: undefined,
    };
    if (chosen?.role === "green_manure")
      update(key, {
        cropId,
        productId: cropId,
        kind: "green_manure",
        ...cleared,
      });
    else
      update(key, {
        cropId,
        productId: chosen?.products[0]?.productId ?? "",
        kind: "crop",
        ...cleared,
      });
  };

  return (
    <>
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
                      <Show when={slot()}>
                        {(s) => <> · harvest {longSpan(s().harvest.earliest, s().harvest.latest)}</>}
                      </Show>
                    </span>
                  </div>
                }
              >
                <fieldset class="yp-edit-slot">
                  <legend>Crop {index() + 1}</legend>
                  <div class="yp-edit-fields">
                    <label>
                      <span>Crop</span>
                      <select value={draft.cropId} onChange={(event) => pick(draft.key, event.currentTarget.value)}>
                        <Show when={!draft.cropId}>
                          <option value="">Choose a crop</option>
                        </Show>
                        <For each={groups()}>
                          {(group) => (
                            <optgroup label={GROUP_LABEL[group.role]}>
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
                        <select
                          value={draft.productId}
                          onChange={(event) =>
                            update(draft.key, {
                              productId: event.currentTarget.value,
                              kind: "crop",
                              systemId: undefined,
                              companionLabel: undefined,
                              endsOn: undefined,
                            })
                          }
                        >
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
                        onInput={(event) =>
                          update(draft.key, {
                            sowing: event.currentTarget.value,
                            endsOn: undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                  <div class="yp-edit-actions">
                    <Show when={isLegume(draft.cropId)}>
                      <Chip tone="legume">Legume, adds nitrogen</Chip>
                    </Show>
                    <Show when={draft.kind === "green_manure"}>
                      <Chip tone="legume">Green manure, ploughed in</Chip>
                    </Show>
                    <Show when={draft.kind === "intercrop" && draft.companionLabel}>
                      <Chip tone="info">Intercrop with {draft.companionLabel}</Chip>
                    </Show>
                    <button
                      type="button"
                      class="yp-swap-button"
                      disabled={props.busy}
                      aria-label={`Swap crop ${index() + 1}, ${draft.cropId ? nameOf(draft.cropId) : "not chosen yet"}`}
                      onClick={() => setSwapKey(draft.key)}
                    >
                      <Icon name="swap" size={16} />
                      <span>Swap crop</span>
                    </button>
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
          <div class="yp-edit-add">
            <button
              type="button"
              class="yp-link-button"
              onClick={() =>
                setDrafts((list) => [
                  ...list,
                  {
                    key: `added-${++added}`,
                    fixed: false,
                    cropId: "",
                    productId: "",
                    sowing: nextSowing(list, props.horizon),
                  },
                ])
              }
            >
              + Add a crop
            </button>
            <button
              type="button"
              class="yp-link-button"
              disabled={props.busy || !next().ok}
              onClick={() => setSuggesting(true)}
            >
              Suggest next crop
            </button>
            <Show when={manures().length}>
              <button
                type="button"
                class="yp-link-button"
                onClick={() =>
                  setDrafts((list) => {
                    const first = manures()[0]!;
                    return [
                      ...list,
                      {
                        key: `added-${++added}`,
                        fixed: false,
                        cropId: first.cropId,
                        productId: first.cropId,
                        kind: "green_manure",
                        sowing: nextSowing(list, props.horizon),
                      },
                    ];
                  })
                }
              >
                + Add green manure
              </button>
            </Show>
          </div>
          <Show when={nextReason()}>{(reason) => <p class="yp-edit-hint">{reason()}</p>}</Show>
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
      <Show when={swapPicker()}>
        {(picker) => (
          <SwapSheet
            title={`Swap ${picker().target.cropId ? nameOf(picker().target.cropId) : "this crop"}`}
            farmId={props.farmId}
            context={picker().context}
            current={picker().current}
            onPick={onSwapPick}
            onClose={() => setSwapKey(null)}
          />
        )}
      </Show>
      <Show when={suggesting() ? next() : undefined}>
        {(result) => {
          const n = result();
          return n.ok ? (
            <SwapSheet
              title="Suggest the next crop"
              farmId={props.farmId}
              context={n.context}
              current={null}
              onPick={onSuggestPick}
              onClose={() => setSuggesting(false)}
            />
          ) : null;
        }}
      </Show>
    </>
  );
}
