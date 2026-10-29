import { Show, createSignal, onCleanup } from "solid-js";
import { capabilitiesState } from "../../lib/capabilities";
import { newEntryId } from "./http";
import { DEFAULT_MAX_BYTES, precheckFile } from "./precheck";
import type { MediaInfo } from "./types";
import { uploadErrorMessage, uploadPhoto, type UploadHandle } from "./upload";

/**
 * Photo step: camera capture input, file picker and drag/drop. The Idempotency-Key is a client entry id that
 * stays the same when the same selection is retried, so a flaky connection cannot create duplicate uploads.
 */
export function PhotoUploader(props: { farmId: string; onUploaded: (m: MediaInfo) => void; onCancel?: () => void }) {
  const [progress, setProgress] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);
  let current: UploadHandle | null = null;
  let lastFile: File | null = null;
  let lastKey: string | null = null;
  onCleanup(() => current?.cancel());

  const maxBytes = () => {
    const s = capabilitiesState();
    return s.status === "ready" && s.envelope.data ? s.envelope.data.limits.maxUploadImageBytes : DEFAULT_MAX_BYTES;
  };

  const start = async (file: File) => {
    setError(null);
    const pre = precheckFile(file, maxBytes());
    if (!pre.ok) {
      setError(pre.message);
      return;
    }
    if (lastFile !== file || !lastKey) {
      lastFile = file;
      lastKey = newEntryId("photo");
    }
    setFileName(file.name);
    setProgress(0);
    current = uploadPhoto(file, props.farmId, lastKey, setProgress);
    try {
      const media = await current.promise;
      setProgress(null);
      lastFile = null;
      lastKey = null;
      props.onUploaded(media);
    } catch (e) {
      setProgress(null);
      if ((e as { code?: string }).code !== "cancelled") setError(uploadErrorMessage(e));
    }
  };

  const pick = (e: Event & { currentTarget: HTMLInputElement }) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (f) void start(f);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 1) setError("Drop one photo at a time. Using the first one.");
    const f = files?.[0];
    if (f) void start(f);
  };

  return (
    <section class="pr-upload" aria-labelledby="pr-up-title">
      <h2 id="pr-up-title">Add a photo of your planting area</h2>
      <p class="pr-help">Take a clear photo of the land you plan to plant, or choose one from your device. JPEG, PNG or WebP, up to {Math.round(maxBytes() / 1024 / 1024)} MB. The photo stays private to this device's workspace.</p>
      <div
        class="pr-drop"
        classList={{ over: dragOver() }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={drop}
      >
        <label class="btn pr-file-btn">
          Take a photo
          <input class="sr-only-input" type="file" accept="image/*" capture="environment" onChange={pick} disabled={progress() !== null} data-testid="photo-capture" />
        </label>
        <label class="btn secondary pr-file-btn">
          Choose a photo
          <input class="sr-only-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} disabled={progress() !== null} data-testid="photo-file" />
        </label>
        <p class="pr-help" aria-hidden="true">or drop a photo here</p>
      </div>
      <Show when={progress() !== null}>
        <div role="status" aria-live="polite">
          <label for="pr-progress">Uploading {fileName()} — {Math.round((progress() ?? 0) * 100)}%</label>
          <progress id="pr-progress" max="1" value={progress() ?? 0} style={{ width: "100%" }} />
          <button type="button" class="btn secondary" onClick={() => current?.cancel()}>Cancel upload</button>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert" class="pr-error" data-testid="upload-error">{error()}</p>
      </Show>
      <Show when={props.onCancel && progress() === null}>
        <button type="button" class="btn secondary" onClick={() => props.onCancel?.()}>Keep current photo</button>
      </Show>
    </section>
  );
}
