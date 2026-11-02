import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Icon } from "../icons";
import { cropColor } from "../today/model";
import {
  areaText,
  checkFieldName,
  checkFieldOutline,
  cropLabel,
  currentCycleOf,
  deleteRefusal,
  MAX_STRIPS,
  MIN_STRIPS,
  newFieldId,
  polygonAreaHa,
  stripFields,
  type FieldCycleLike,
  type FieldLike,
  type FieldPlanLike,
  type Polygon,
} from "./fieldsModel";
import "./fields.css";

export interface FieldsPanelProps {
  /** The farm's fields in drawn order. */
  fields: readonly FieldLike[];
  farmBoundary: Polygon | null;
  cycles: readonly FieldCycleLike[];
  plans: readonly FieldPlanLike[];
  cropName: (cropId: string) => string;
  /** A workspace save is running (any part of the workspace). */
  saving: boolean;
  /** Disable every action (for example while the farm boundary is being edited). */
  disabled?: boolean;
  /** Save the whole list with the expected workspace version; rejects with the error to show. */
  onSave: (fields: FieldLike[], notice: string) => Promise<void>;
  /** The map is in field-drawing mode (owned by the page, which holds the map). */
  drawing: boolean;
  /** The finished outline from the map, waiting for a name; null until one is finished. */
  drawn: Polygon | null;
  /** Switch the map into field drawing (keeps a finished outline when `keep`, for adjusting its corners). */
  onStartDraw: (keep?: boolean) => void;
  /** Leave field drawing and drop the unsaved outline. */
  onEndDraw: () => void;
  /** Link to Today with this field selected. */
  todayHref: (fieldId: string) => string;
}

/**
 * Fields on the Farm page, under the boundary map (FIELDS_MULTICROP_SOIL_SPEC.md 6.1): the list (name, area in acres and
 * hectares, current crop, "Show on Today"), Add field (drawn on the map with the farm boundary as context, checked with the
 * contract's `ringWithin` and `ringsOverlap` before saving), Rename, Delete (refused while a crop record names the field)
 * and Split into equal strips (only on a farm without fields). Every save sends the whole list with the expected workspace
 * version, like the boundary.
 */
export function FieldsPanel(props: FieldsPanelProps) {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [refusal, setRefusal] = createSignal<{ id: string; text: string } | null>(null);
  const [newName, setNewName] = createSignal("");
  const [splitting, setSplitting] = createSignal(false);
  const [stripCount, setStripCount] = createSignal(4);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const locked = () => busy() || props.saving || !!props.disabled;
  const hasFarm = () => (props.farmBoundary?.coordinates[0]?.length ?? 0) >= 4;

  // A finished outline gets a default name; a new drawing clears the old messages.
  createEffect(
    on(
      () => props.drawn,
      (drawn) => {
        if (drawn) setNewName((current) => current || nextFieldName(props.fields));
        setError("");
      },
    ),
  );

  const cycleOf = (fieldId: string) => currentCycleOf(fieldId, props.cycles);
  const split = createMemo(() => (splitting() ? stripFields(props.farmBoundary, props.fields, stripCount(), (i) => `strip-${i + 1}`) : null));

  async function save(fields: FieldLike[], notice: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await props.onSave(fields, notice);
      return true;
    } catch (issue) {
      setError((issue as Error).message || "The fields could not be saved. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveNew(event: SubmitEvent) {
    event.preventDefault();
    const outline = props.drawn;
    if (!outline || locked()) return;
    const problem = checkFieldName(newName(), props.fields) ?? checkFieldOutline(props.farmBoundary, props.fields, outline);
    if (problem) {
      setError(problem);
      return;
    }
    const name = newName().trim();
    if (await save([...props.fields, { id: newFieldId(), name, boundary: outline }], `${name} saved. Plant a crop on it from Today.`)) {
      setNewName("");
      props.onEndDraw();
    }
  }

  async function saveRename(event: SubmitEvent, field: FieldLike) {
    event.preventDefault();
    if (locked()) return;
    const problem = checkFieldName(renameText(), props.fields, field.id);
    if (problem) {
      setError(problem);
      return;
    }
    const name = renameText().trim();
    if (await save(props.fields.map((f) => (f.id === field.id ? { ...f, name } : f)), `Field renamed to ${name}.`)) setRenaming(null);
  }

  function askDelete(field: FieldLike) {
    setError("");
    setRenaming(null);
    const refused = deleteRefusal(field, props.cycles, props.plans, props.cropName);
    if (refused) {
      setConfirmDelete(null);
      setRefusal({ id: field.id, text: refused });
      return;
    }
    setRefusal(null);
    setConfirmDelete(field.id);
  }

  async function doDelete(field: FieldLike) {
    if (locked()) return;
    // Re-check at the moment of saving: a crop may have been recorded on it since the question was asked.
    const refused = deleteRefusal(field, props.cycles, props.plans, props.cropName);
    if (refused) {
      setConfirmDelete(null);
      setRefusal({ id: field.id, text: refused });
      return;
    }
    if (await save(props.fields.filter((f) => f.id !== field.id), `${field.name} deleted.`)) setConfirmDelete(null);
  }

  async function doSplit(event: SubmitEvent) {
    event.preventDefault();
    if (locked()) return;
    const result = stripFields(props.farmBoundary, props.fields, stripCount());
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (await save(result.fields, `Farm split into ${result.fields.length} strips.`)) setSplitting(false);
  }

  return (
    <section class="fields-panel" aria-labelledby="fields-title" data-testid="fields-panel">
      <div class="fields-head">
        <div>
          <h2 id="fields-title">Fields</h2>
          <p>Divide the farm into fields so each one gets its own crop, satellite view and care steps.</p>
        </div>
        <span class="fields-count">{props.fields.length === 1 ? "1 field" : `${props.fields.length} fields`}</span>
      </div>

      <Show
        when={props.fields.length}
        fallback={
          <p class="fields-empty" data-testid="fields-empty">
            No fields yet: the whole farm is one field. Add fields to grow a different crop on each part.
          </p>
        }
      >
        <ul class="fields-list" data-testid="fields-list">
          <For each={props.fields}>
            {(field) => {
              const cycle = () => cycleOf(field.id);
              return (
                <li class="fields-item" data-field-id={field.id}>
                  <div class="fields-item-row">
                    <span class="fields-swatch" style={{ background: cropColor(cycle()?.cropId) }} aria-hidden="true" />
                    <div class="fields-item-main">
                      <strong>{field.name}</strong>
                      <span class="fields-item-meta">
                        {areaText(polygonAreaHa(field.boundary))} · {cropLabel(cycle(), props.cropName)}
                      </span>
                    </div>
                    <div class="fields-item-actions">
                      <a class="text-link" href={props.todayHref(field.id)}>
                        Show on Today <Icon name="arrow" size={13} />
                      </a>
                      <button
                        type="button"
                        class="text-button"
                        disabled={locked()}
                        aria-label={`Rename ${field.name}`}
                        onClick={() => {
                          setError("");
                          setRefusal(null);
                          setConfirmDelete(null);
                          setRenameText(field.name);
                          setRenaming(field.id);
                        }}
                      >
                        Rename
                      </button>
                      <button type="button" class="text-button danger" disabled={locked()} aria-label={`Delete ${field.name}`} onClick={() => askDelete(field)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  <Show when={renaming() === field.id}>
                    <form class="fields-inline-form" onSubmit={(event) => void saveRename(event, field)}>
                      <label>
                        New name
                        <input type="text" maxlength="80" required value={renameText()} onInput={(e) => setRenameText(e.currentTarget.value)} />
                      </label>
                      <div class="fields-inline-actions">
                        <button type="submit" class="btn compact" disabled={locked()}>
                          {busy() ? "Saving…" : "Save name"}
                        </button>
                        <button type="button" class="text-button" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  </Show>
                  <Show when={refusal()?.id === field.id}>
                    <p class="fields-refusal" role="alert" data-testid="fields-delete-refused">
                      {refusal()!.text}
                    </p>
                  </Show>
                  <Show when={confirmDelete() === field.id}>
                    <div class="fields-confirm" role="group" aria-label={`Delete ${field.name}?`}>
                      <p>Delete {field.name}? Its outline is removed; nothing else changes.</p>
                      <div class="fields-inline-actions">
                        <button type="button" class="btn compact danger" disabled={locked()} onClick={() => void doDelete(field)}>
                          {busy() ? "Deleting…" : "Delete field"}
                        </button>
                        <button type="button" class="text-button" onClick={() => setConfirmDelete(null)}>
                          Keep it
                        </button>
                      </div>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <Show when={!hasFarm()}>
        <p class="fields-note">Draw the farm boundary first. Fields are drawn inside it.</p>
      </Show>

      <Show when={props.drawing || props.drawn}>
        <div class="fields-draw" data-testid="fields-draw">
          <Show
            when={props.drawn}
            fallback={
              <>
                <p>
                  <strong>Drawing a new field.</strong> Click each corner on the map, inside the dashed farm outline, then choose Finish field.
                </p>
                <button type="button" class="text-button" onClick={() => props.onEndDraw()}>
                  Cancel
                </button>
              </>
            }
          >
            {(outline) => (
              <form class="fields-inline-form" onSubmit={(event) => void saveNew(event)}>
                <p>
                  New field: <strong>{areaText(polygonAreaHa(outline()))}</strong>
                </p>
                <label>
                  Field name
                  <input type="text" maxlength="80" required value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} data-testid="fields-new-name" />
                </label>
                <div class="fields-inline-actions">
                  <button type="submit" class="btn compact" disabled={locked()}>
                    {busy() ? "Saving…" : "Save field"}
                  </button>
                  <button type="button" class="text-button" disabled={locked()} onClick={() => props.onStartDraw(true)}>
                    Adjust corners
                  </button>
                  <button type="button" class="text-button" onClick={() => props.onEndDraw()}>
                    Discard
                  </button>
                </div>
              </form>
            )}
          </Show>
        </div>
      </Show>

      <Show when={splitting()}>
        <form class="fields-split" onSubmit={(event) => void doSplit(event)} aria-labelledby="fields-split-title" data-testid="fields-split-form">
          <h3 id="fields-split-title">Split into equal strips</h3>
          <p>
            The farm is cut across its longer side into strips of equal width, named Strip 1 to Strip {stripCount()}. Widths are equal; areas are
            approximately equal when the farm is not a rectangle. You can rename the strips afterwards.
          </p>
          <label>
            Number of strips
            <input
              type="number"
              min={MIN_STRIPS}
              max={MAX_STRIPS}
              step="1"
              required
              value={stripCount()}
              onInput={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isInteger(n)) setStripCount(Math.max(MIN_STRIPS, Math.min(MAX_STRIPS, n)));
              }}
              data-testid="fields-strip-count"
            />
          </label>
          <Show when={split()}>
            {(result) => (
              <Show when={result().ok} fallback={<p class="fields-refusal" role="alert">{(result() as { reason: string }).reason}</p>}>
                <p class="fields-split-preview" data-testid="fields-split-preview">
                  {(result() as { areasHa: number[] }).areasHa.map((ha, i) => `Strip ${i + 1}: ${areaText(ha)}`).join("; ")}
                </p>
              </Show>
            )}
          </Show>
          <div class="fields-inline-actions">
            <button type="submit" class="btn compact" disabled={locked() || !split()?.ok}>
              {busy() ? "Saving…" : `Create ${stripCount()} strips`}
            </button>
            <button type="button" class="text-button" onClick={() => setSplitting(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Show>

      <Show when={error()}>
        <p class="inline-error" role="alert" data-testid="fields-error">
          {error()}
        </p>
      </Show>

      <Show when={!props.drawing && !props.drawn && !splitting()}>
        <div class="fields-actions">
          <button
            type="button"
            class="btn compact secondary"
            disabled={locked() || !hasFarm()}
            onClick={() => {
              setError("");
              setRefusal(null);
              setNewName("");
              props.onStartDraw();
            }}
            data-testid="fields-add"
          >
            <Icon name="plus" size={15} /> Add field
          </button>
          <button
            type="button"
            class="btn compact secondary"
            disabled={locked() || !hasFarm() || props.fields.length > 0}
            aria-describedby={props.fields.length ? "fields-split-why" : undefined}
            onClick={() => {
              setError("");
              setSplitting(true);
            }}
            data-testid="fields-split"
          >
            <Icon name="grid" size={15} /> Split into equal strips
          </button>
          <Show when={props.fields.length}>
            <span class="fields-note" id="fields-split-why">
              Splitting works only on a farm without fields.
            </span>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** "Field 1", "Field 2", ...: the first free name. */
export function nextFieldName(fields: readonly Pick<FieldLike, "name">[]): string {
  const taken = new Set(fields.map((f) => f.name.trim().toLowerCase()));
  for (let i = fields.length + 1; ; i++) if (!taken.has(`field ${i}`)) return `Field ${i}`;
}
