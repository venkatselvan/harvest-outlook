import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { ApiError } from "../../lib/api";
import { uploadTranscription, type UploadHandle } from "./speechApi";
import {
  DEFAULT_MAX_SECONDS,
  formatTimer,
  initialVoiceState,
  isBusy,
  languageMismatchWarning,
  LANGUAGE_NAMES,
  pickMimeType,
  voiceReducer,
  type SpeechLang,
  type VoiceEvent,
  type VoiceState,
} from "./speechMachine";
import "./speech.css";

export interface VoiceInputProps {
  language: SpeechLang;
  /** Called with the farmer-confirmed text only. Nothing is sent onward automatically. */
  onConfirmText: (text: string) => void;
  farmId?: string;
  maxSeconds?: number;
}

const ACK_KEY = "ho.speechDisclosureAck";
const readAck = (): boolean => {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
};
const writeAck = () => {
  try {
    localStorage.setItem(ACK_KEY, "1");
  } catch {
    /* private mode: the notice will show again */
  }
};

const recorderSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder)) !== null;

/**
 * Record, transcribe, edit, confirm. The text box is always present and always editable, so typing
 * works with no microphone, no key, no connection or no recorder support. The microphone is requested
 * only when the farmer taps Record, after a one-time provider disclosure.
 */
export function VoiceInput(props: VoiceInputProps) {
  const max = () => props.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const [state, setState] = createSignal<VoiceState>(initialVoiceState(recorderSupported()));
  const [text, setText] = createSignal("");
  const dispatch = (e: VoiceEvent) => setState((s) => voiceReducer(s, e));

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let mime = "";
  let discard = false;
  let upload: UploadHandle | null = null;

  const releaseMic = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  onCleanup(() => {
    discard = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseMic();
    upload?.abort();
  });

  const send = (blob: Blob) => {
    upload = uploadTranscription(
      blob,
      props.language,
      {
        ...(props.farmId ? { farmId: props.farmId } : {}),
        onProgress: (f) => dispatch({ type: "upload_progress", fraction: f }),
        onSent: () => dispatch({ type: "upload_sent" }),
      },
    );
    upload.promise
      .then((result) => {
        // Never overwrite typed text: append the transcript below it.
        setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${result.transcript}` : result.transcript));
        dispatch({ type: "result", result });
      })
      .catch((e: unknown) => {
        const code = e instanceof ApiError ? e.code : "unknown";
        if (code === "client_cancelled") return;
        dispatch({ type: "fail", code });
      })
      .finally(() => {
        upload = null;
      });
  };

  const beginCapture = async () => {
    const picked = pickMimeType(typeof MediaRecorder !== "undefined" ? MediaRecorder.isTypeSupported?.bind(MediaRecorder) : undefined);
    if (!picked) {
      dispatch({ type: "tap_record", supported: false, disclosureAcknowledged: true });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // permission prompt happens here, on a tap
    } catch {
      dispatch({ type: "permission_denied" });
      return;
    }
    mime = picked;
    chunks = [];
    discard = false;
    recorder = new MediaRecorder(stream, { mimeType: picked });
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      releaseMic();
      if (discard) return;
      const blob = new Blob(chunks, { type: mime.split(";")[0] ?? mime });
      chunks = [];
      dispatch({ type: "recorded" });
      send(blob);
    };
    recorder.start();
    dispatch({ type: "permission_granted" });
    const t0 = Date.now();
    timer = setInterval(() => {
      const elapsed = (Date.now() - t0) / 1000;
      dispatch({ type: "tick", elapsed, maxSeconds: max() });
      if (elapsed >= max() && recorder?.state === "recording") recorder.stop(); // hard stop at the cap
    }, 250);
  };

  const tapRecord = () => {
    const ack = readAck();
    dispatch({ type: "tap_record", supported: recorderSupported(), disclosureAcknowledged: ack });
    if (ack && recorderSupported()) void beginCapture();
  };
  const acknowledge = () => {
    writeAck();
    dispatch({ type: "acknowledge_disclosure" });
    void beginCapture();
  };
  const stopRecording = () => {
    if (recorder?.state === "recording") recorder.stop();
  };
  const cancel = () => {
    discard = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseMic();
    upload?.abort();
    dispatch({ type: "cancel" });
  };

  const warning = () => {
    const s = state();
    return s.kind === "review" ? languageMismatchWarning(s.result.detectedLanguage, props.language) : null;
  };
  const confirm = () => {
    const v = text().trim();
    if (!v) return;
    props.onConfirmText(v);
    setText("");
    dispatch({ type: "reset" });
  };
  const langName = () => LANGUAGE_NAMES[props.language];

  return (
    <section class="speech" aria-label="Voice or text input">
      <Switch>
        <Match when={state().kind === "unsupported"}>
          <p class="speech-note" role="status">
            Voice recording is not available in this browser. Type your message instead.
          </p>
        </Match>
        <Match when={state().kind === "disclosure"}>
          <div class="speech-disclosure" role="group" aria-label="Voice privacy notice">
            <p>
              Your recording is sent to our speech provider (ElevenLabs) to turn it into text. It is not saved by this app, and the provider keeps
              audio according to its own terms. You can type instead at any time.
            </p>
            <div class="speech-actions">
              <button type="button" class="btn" onClick={acknowledge}>
                I understand, start recording
              </button>
              <button type="button" class="btn speech-secondary" onClick={cancel}>
                Type instead
              </button>
            </div>
          </div>
        </Match>
        <Match when={state().kind === "recording"}>
          <div class="speech-status" role="status" aria-live="polite">
            <span class="speech-dot" aria-hidden="true" />
            Recording… {formatTimer((state() as Extract<VoiceState, { kind: "recording" }>).elapsed)} of {formatTimer(max())}
          </div>
          <div class="speech-actions">
            <button type="button" class="btn" onClick={stopRecording}>
              Stop and transcribe
            </button>
            <button type="button" class="btn speech-secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
        </Match>
        <Match when={state().kind === "requesting_permission"}>
          <p class="speech-status" role="status">Waiting for microphone permission…</p>
        </Match>
        <Match when={state().kind === "uploading"}>
          <div class="speech-status" role="status" aria-live="polite">
            <label for="speech-upload-progress">Uploading recording</label>{" "}
            <progress id="speech-upload-progress" max="1" value={(state() as Extract<VoiceState, { kind: "uploading" }>).progress} />
          </div>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match when={state().kind === "processing"}>
          <div class="speech-status" role="status" aria-live="polite">Turning your voice into text…</div>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match when={state().kind === "idle" || state().kind === "review" || state().kind === "error"}>
          <button type="button" class="btn" onClick={tapRecord}>
            Record voice ({langName()})
          </button>
        </Match>
      </Switch>

      <Show when={state().kind === "error"}>
        <p class="speech-error" role="alert">
          {(state() as Extract<VoiceState, { kind: "error" }>).message}
        </p>
      </Show>
      <Show when={warning()}>
        <p class="speech-warning" role="status">
          {warning()}
        </p>
      </Show>
      <Show when={state().kind === "review" && (state() as Extract<VoiceState, { kind: "review" }>).result.synthetic}>
        <p class="speech-warning" role="status">
          Synthetic fixture transcript, not real speech recognition.
        </p>
      </Show>

      <label class="speech-label" for="speech-text">
        Your message (edit before using)
      </label>
      <textarea
        id="speech-text"
        class="speech-text"
        rows="4"
        lang={props.language}
        value={text()}
        disabled={false}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder="Type here, or record a voice note"
      />
      <button type="button" class="btn" disabled={!text().trim() || isBusy(state())} onClick={confirm}>
        Use this text
      </button>
    </section>
  );
}
