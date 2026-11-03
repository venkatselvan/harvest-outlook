import { For, Show, Suspense, createSignal, createUniqueId, lazy, onMount } from "solid-js";
import type { FieldIssue, IssueCategory, IssueSeverity } from "@harvest/contracts";
import { PhotoUploader } from "../../features/photo-region/PhotoUploader";
import { newEntryId } from "../../features/photo-region/http";
import type { MediaInfo } from "../../features/photo-region/types";
import { ErrorState } from "../../features/offline/ErrorState";
import type { Boundary } from "../state";
import { createIssue, describeScoutingError, KEPT_ON_DEVICE, type ScoutingErrorInfo } from "./scoutingApi";
import { scoutingStore, type DraftStore } from "./scoutingStore";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  clearScoutingDraft,
  geolocationMessage,
  isIssueDraft,
  issueBody,
  issueProblems,
  loadScoutingDraft,
  locationInside,
  locationText,
  MAX_PHOTOS,
  newIssueDraft,
  outsideMessage,
  saveScoutingDraft,
  SEVERITIES,
  SEVERITY_LABEL,
  withoutPhoto,
  type IssueDraft,
  type IssuePrefill,
  type IssueProblem,
} from "./scoutingModel";
import { PhotoMarks } from "./PhotoMarks";
import { VoiceNote, appendText } from "./VoiceNote";
import "./scouting.css";

const LocateMap = lazy(() => import("./LocateMap"));

/** A field the issue can be logged on (the workspace field). */
export interface FieldOption {
  id: string;
  name: string;
  boundary?: Boundary | null | undefined;
}

export interface IssueFormProps {
  farmId: string;
  /** The farm's fields; empty on a farm without fields (the issue is then farm-wide). */
  fields: readonly FieldOption[];
  farmBoundary?: Boundary | null | undefined;
  /** Preselected field (the `?field=` selection, or the check's field). */
  defaultFieldId?: string | null | undefined;
  /** The server's today (the latest allowed date). */
  today: string;
  /** Prefill for packet O2b ("Log as an issue" from an accepted AI suggestion). */
  prefill?: IssuePrefill | undefined;
  /** Draft slot on this farm: "new" (default), `check:<checkId>` inside a check, `fact:<factId>` for a prefill. */
  slot?: string | undefined;
  onCreated: (issue: FieldIssue) => void;
  onCancel?: (() => void) | undefined;
  /** Injected in tests. */
  store?: DraftStore | undefined;
  send?: ((farmId: string, body: ReturnType<typeof issueBody>) => Promise<FieldIssue>) | undefined;
  /** Start from this draft (tests render a given state without IndexedDB). */
  initialDraft?: IssueDraft | undefined;
  /** Show the validation messages at once (tests). */
  showProblems?: boolean | undefined;
  /** Heading level text; the form is embedded in a sheet that names it. */
  title?: string | undefined;
}

/**
 * Log an issue (FIELD_OPERATIONS_SPEC.md 5): what the farmer saw, in the farmer's words. Category, severity and title are
 * the farmer's; the app neither diagnoses nor suggests a treatment. Every change is written to the device (IndexedDB,
 * owner-scoped) at once, keyed by the client entry id, so a reload or a lost connection loses nothing; the same id is the
 * Idempotency-Key on every retry. A failed send keeps the draft ("Kept on this device; try again when online").
 */
export function IssueForm(props: IssueFormProps) {
  const store = () => props.store ?? scoutingStore();
  const slot = () => props.slot ?? (props.prefill?.fromFactId ? `fact:${props.prefill.fromFactId}` : "new");
  const fresh = () => newIssueDraft(props.farmId, newEntryId("issue"), props.today, props.defaultFieldId ?? (props.fields.length === 1 ? props.fields[0]!.id : null), props.prefill);
  const [draft, setDraft] = createSignal<IssueDraft>(props.initialDraft ?? fresh());
  const [restored, setRestored] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<(ScoutingErrorInfo & { kept: string }) | null>(null);
  const [showProblems, setShowProblems] = createSignal(!!props.showProblems);
  const [addingPhoto, setAddingPhoto] = createSignal(false);
  const [locating, setLocating] = createSignal(false);
  const [locationError, setLocationError] = createSignal("");
  const [mapOpen, setMapOpen] = createSignal(false);
  const [device, setDevice] = createSignal<"idle" | "saved" | "failed">("idle");
  const prefix = `sc-issue-${createUniqueId()}`;
  const id = (name: string) => `${prefix}-${name}`;

  onMount(async () => {
    if (props.initialDraft) return;
    try {
      const saved = await loadScoutingDraft(store(), "issue", props.farmId, slot(), isIssueDraft);
      if (saved) {
        setDraft({ ...fresh(), ...saved });
        setRestored(true);
      }
    } catch {
      /* unreadable draft store: start empty */
    }
  });

  const update = (patch: Partial<IssueDraft>) => {
    const next = { ...draft(), ...patch };
    setDraft(next);
    setDevice("idle");
    saveScoutingDraft(store(), "issue", slot(), next).then(
      () => setDevice("saved"),
      () => setDevice("failed"),
    );
  };

  const hasFields = () => props.fields.length > 0;
  const field = () => props.fields.find((f) => f.id === draft().fieldId) ?? null;
  const placeName = () => field()?.name ?? null;
  const problems = (): IssueProblem[] => issueProblems(draft(), { today: props.today, hasFields: hasFields() });
  const problemFor = (name: IssueProblem["field"]) => (showProblems() ? problems().find((p) => p.field === name)?.message : undefined);
  const polygons = () => [props.farmBoundary ?? null, field()?.boundary ?? null];

  function useDevice() {
    setLocationError("");
    const geo = typeof navigator === "undefined" ? undefined : navigator.geolocation;
    if (!geo) {
      setLocationError(geolocationMessage("unsupported"));
      return;
    }
    setLocating(true);
    geo.getCurrentPosition(
      (position) => {
        setLocating(false);
        const point = { lat: position.coords.latitude, lon: position.coords.longitude };
        if (!locationInside(point, polygons())) {
          setLocationError(outsideMessage(placeName()));
          return;
        }
        update({ location: point, locationSource: "device" });
      },
      (failure) => {
        setLocating(false);
        setLocationError(geolocationMessage(failure.code));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  async function submit(event?: Event) {
    event?.preventDefault();
    setShowProblems(true);
    if (problems().length || saving()) return;
    setSaving(true);
    setError(null);
    const sent = draft();
    try {
      const issue = await (props.send ?? createIssue)(props.farmId, issueBody(sent));
      await clearScoutingDraft(store(), "issue", props.farmId, slot(), sent.clientEntryId).catch(() => undefined);
      setDraft(fresh());
      setRestored(false);
      setShowProblems(false);
      props.onCreated(issue);
    } catch (failure) {
      const info = describeScoutingError(failure);
      setError({ ...info, kept: info.kind === "network" ? KEPT_ON_DEVICE : "Your draft is still in the form." });
    } finally {
      setSaving(false);
    }
  }

  /** A reused id with different data: keep the content, send it under a new id. */
  const sendAsNew = () => {
    update({ clientEntryId: newEntryId("issue") });
    void submit();
  };

  const onPhoto = (media: MediaInfo) => {
    setAddingPhoto(false);
    if (!draft().mediaIds.includes(media.id)) update({ mediaIds: [...draft().mediaIds, media.id].slice(0, MAX_PHOTOS) });
  };

  return (
    <form class="sc-form" onSubmit={(e) => void submit(e)} noValidate aria-label={props.title ?? "Log an issue"} data-testid="sc-issue-form">
      <Show when={restored()}>
        <p class="sc-note" role="status">
          Restored your unsent issue from this device.
        </p>
      </Show>
      <p class="sc-small">What you saw, in your own words. The app does not diagnose it or suggest a treatment.</p>

      <Show when={hasFields()}>
        <label for={id("field")}>Field</label>
        <select
          id={id("field")}
          value={draft().fieldId}
          aria-invalid={!!problemFor("fieldId")}
          aria-describedby={problemFor("fieldId") ? id("field-error") : undefined}
          onChange={(e) => update({ fieldId: e.currentTarget.value, location: null, locationSource: null })}
        >
          <option value="" selected={!draft().fieldId}>
            Choose a field
          </option>
          <For each={props.fields}>
            {(f) => (
              <option value={f.id} selected={draft().fieldId === f.id}>
                {f.name}
              </option>
            )}
          </For>
        </select>
        <FieldError id={id("field-error")} message={problemFor("fieldId")} />
      </Show>

      <label for={id("date")}>Date you saw it</label>
      <input
        id={id("date")}
        type="date"
        max={props.today}
        value={draft().observedOn}
        aria-invalid={!!problemFor("observedOn")}
        aria-describedby={problemFor("observedOn") ? id("date-error") : undefined}
        onInput={(e) => update({ observedOn: e.currentTarget.value })}
      />
      <FieldError id={id("date-error")} message={problemFor("observedOn")} />

      <label for={id("category")}>What kind of issue</label>
      <select
        id={id("category")}
        value={draft().category}
        aria-invalid={!!problemFor("category")}
        aria-describedby={problemFor("category") ? id("category-error") : undefined}
        onChange={(e) => update({ category: e.currentTarget.value as IssueCategory | "" })}
      >
        <option value="" selected={!draft().category}>
          Choose one
        </option>
        <For each={CATEGORIES}>
          {(c) => (
            <option value={c} selected={draft().category === c}>
              {CATEGORY_LABEL[c]}
            </option>
          )}
        </For>
      </select>
      <FieldError id={id("category-error")} message={problemFor("category")} />

      <fieldset class="sc-radios" aria-describedby={id("severity-help")}>
        <legend>How bad does it look to you?</legend>
        <For each={SEVERITIES}>
          {(level) => (
            <label class="sc-radio">
              <input type="radio" name={id("severity")} value={level} checked={draft().severity === level} onChange={() => update({ severity: level as IssueSeverity })} />
              {SEVERITY_LABEL[level]}
            </label>
          )}
        </For>
        <p id={id("severity-help")} class="sc-small">
          Your own judgement; the app does not rate it.
        </p>
        <FieldError id={id("severity-error")} message={problemFor("severity")} />
      </fieldset>

      <label for={id("title")}>Short title</label>
      <input
        id={id("title")}
        type="text"
        maxlength="120"
        autocomplete="off"
        value={draft().title}
        placeholder="For example: holes in young leaves near the gate"
        aria-invalid={!!problemFor("title")}
        aria-describedby={problemFor("title") ? id("title-error") : undefined}
        onInput={(e) => update({ title: e.currentTarget.value })}
      />
      <FieldError id={id("title-error")} message={problemFor("title")} />

      <label for={id("detail")}>What you saw (optional)</label>
      <textarea
        id={id("detail")}
        rows="3"
        maxlength="2000"
        value={draft().detail}
        aria-invalid={!!problemFor("detail")}
        onInput={(e) => update({ detail: e.currentTarget.value })}
      />
      <FieldError id={id("detail-error")} message={problemFor("detail")} />
      <VoiceNote farmId={props.farmId} onText={(text) => update({ detail: appendText(draft().detail, text).slice(0, 2000) })} />

      <div class="sc-photos" data-testid="sc-issue-photos">
        <p class="sc-label" id={id("photos-label")}>
          Photos ({draft().mediaIds.length} of {MAX_PHOTOS})
        </p>
        <For each={draft().mediaIds}>
          {(mediaId, i) => (
            <div class="sc-photo-item">
              <PhotoMarks
                mediaId={mediaId}
                marks={draft().photoMarks}
                photoNumber={i() + 1}
                editable
                idPrefix={id("marks")}
                onChange={(photoMarks) => update({ photoMarks })}
              />
              <button type="button" class="btn compact secondary" onClick={() => update(withoutPhoto(draft(), mediaId))}>
                Remove photo {i() + 1}
              </button>
            </div>
          )}
        </For>
        <FieldError id={id("photos-error")} message={problemFor("photos")} />
        <Show when={draft().mediaIds.length < MAX_PHOTOS}>
          <Show
            when={addingPhoto()}
            fallback={
              <button type="button" class="btn compact secondary" onClick={() => setAddingPhoto(true)}>
                {draft().mediaIds.length ? "Add another photo" : "Add a photo"}
              </button>
            }
          >
            <div class="sc-uploader">
              <p class="sc-small">Add a photo of what you saw. JPEG, PNG or WebP; it stays private to your workspace.</p>
              <PhotoUploader farmId={props.farmId} onUploaded={onPhoto} onCancel={() => setAddingPhoto(false)} />
            </div>
          </Show>
        </Show>
      </div>

      <fieldset class="sc-location" data-testid="sc-issue-location">
        <legend>Where in the field (optional)</legend>
        <Show when={draft().location} fallback={<p class="sc-small">No location. You can add one from this device or by tapping the map.</p>}>
          {(point) => (
            <p class="sc-location-line" data-testid="sc-location-line">
              Location: {locationText(point())} ({draft().locationSource === "map" ? "marked on the map" : "from this device"})
            </p>
          )}
        </Show>
        <div class="sc-actions">
          <button type="button" class="btn compact secondary" disabled={locating()} onClick={useDevice}>
            {locating() ? "Finding your location…" : "Use my location"}
          </button>
          <button type="button" class="btn compact secondary" aria-expanded={mapOpen()} onClick={() => setMapOpen(!mapOpen())}>
            {mapOpen() ? "Hide the map" : "Mark on map"}
          </button>
          <Show when={draft().location}>
            <button type="button" class="btn compact secondary" onClick={() => update({ location: null, locationSource: null })}>
              Remove location
            </button>
          </Show>
        </div>
        <Show when={locationError()}>
          <p class="inline-error" role="alert" data-testid="sc-location-error">
            {locationError()}
          </p>
        </Show>
        <Show when={mapOpen()}>
          <Suspense fallback={<p class="sc-small">Loading the map…</p>}>
            <LocateMap
              within={field()?.boundary ?? props.farmBoundary ?? null}
              farmBoundary={props.farmBoundary ?? null}
              point={draft().location}
              placeName={placeName() ?? "Your farm"}
              outsideText={outsideMessage(placeName())}
              onPick={(point) => {
                setLocationError("");
                update({ location: point, locationSource: "map" });
              }}
            />
          </Suspense>
        </Show>
      </fieldset>

      <Show when={showProblems() && problems().length}>
        <ul class="sc-problems" role="alert" data-testid="sc-issue-problems">
          <For each={problems()}>{(p) => <li>{p.message}</li>}</For>
        </ul>
      </Show>
      <Show when={error()}>
        {(e) => (
          <ErrorState
            code={e().code}
            message={e().message}
            kept={e().kept}
            busy={saving()}
            retryLabel={e().kind === "conflict" ? "Send as a new entry" : "Try again"}
            onRetry={e().kind === "conflict" ? sendAsNew : () => void submit()}
          />
        )}
      </Show>
      <div class="sc-actions">
        <button class="btn" type="submit" disabled={saving()}>
          {saving() ? "Saving…" : "Save issue"}
        </button>
        <Show when={props.onCancel}>
          <button type="button" class="btn secondary" onClick={() => props.onCancel?.()}>
            Cancel
          </button>
        </Show>
      </div>
      <p class="sc-small" role="status">
        {device() === "saved"
          ? "Draft saved on this device."
          : device() === "failed"
            ? "Could not save a draft on this device."
            : store().persistent === false
              ? "Drafts are not kept after a reload in this browser."
              : "Your draft is kept on this device until you save."}
      </p>
    </form>
  );
}

export function FieldError(props: { id: string; message: string | undefined }) {
  return (
    <Show when={props.message}>
      <p id={props.id} class="sc-field-error">
        {props.message}
      </p>
    </Show>
  );
}
