import {
  createSignal,
  createUniqueId,
  createEffect,
  on,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { ApiError } from "../../lib/api";
import {
  fetchSpeechStatus,
  uploadTranscription,
  type UploadHandle,
} from "./speechApi";
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
import { prepareTranscriptionWav } from "./wav";

export interface VoiceInputProps {
  language: SpeechLang;
  /** Called with the farmer-confirmed text only. Nothing is sent onward automatically. */
  onConfirmText: (text: string) => void;
  farmId?: string;
  maxSeconds?: number;
}

const ACK_KEY = "ho.metaTranscriptionDisclosure.v1";
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
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined" &&
  typeof AudioContext !== "undefined" &&
  typeof OfflineAudioContext !== "undefined" &&
  pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder)) !== null;

/**
 * Record, transcribe, edit, confirm. The text box is always present and always editable, so typing
 * works with no microphone, no key, no connection or no recorder support. The microphone is requested
 * only when the farmer taps Record, after a one-time provider disclosure.
 */
export function VoiceInput(props: VoiceInputProps) {
  const inputId = createUniqueId();
  const [serverMax, setServerMax] = createSignal(DEFAULT_MAX_SECONDS);
  const max = () =>
    Math.min(props.maxSeconds ?? DEFAULT_MAX_SECONDS, serverMax());
  const [state, setState] = createSignal<VoiceState>(
    initialVoiceState(recorderSupported()),
  );
  const [text, setText] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  const [availabilityError, setAvailabilityError] = createSignal("");
  const dispatch = (e: VoiceEvent) => setState((s) => voiceReducer(s, e));

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let upload: UploadHandle | null = null;
  let generation = 0;
  let disposed = false;
  const active = (request: number) => !disposed && request === generation;
  const releaseMic = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const cancel = () => {
    ++generation;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* Already stopped by the browser. */
      }
    }
    releaseMic();
    chunks = [];
    upload?.abort();
    upload = null;
    setChecking(false);
    dispatch({ type: "cancel" });
  };
  const sessionEnded = () => {
    cancel();
    setText("");
  };
  window.addEventListener("ho:session-ended", sessionEnded);
  createEffect(
    on(
      [() => props.farmId, () => props.language],
      (next, previous) => {
        cancel();
        if (next[0] !== previous?.[0]) setText("");
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    disposed = true;
    cancel();
    window.removeEventListener("ho:session-ended", sessionEnded);
  });

  const send = (
    blob: Blob,
    request: number,
    language: SpeechLang,
    farmId?: string,
  ) => {
    if (!active(request)) return;
    const handle = uploadTranscription(blob, language, {
      ...(farmId ? { farmId } : {}),
      onProgress: (fraction) => {
        if (active(request)) dispatch({ type: "upload_progress", fraction });
      },
      onSent: () => {
        if (active(request)) dispatch({ type: "upload_sent" });
      },
    });
    upload = handle;
    handle.promise
      .then((result) => {
        if (!active(request)) return;
        setText((previous) =>
          previous.trim()
            ? `${previous.trimEnd()} ${result.transcript}`
            : result.transcript,
        );
        dispatch({ type: "result", result });
      })
      .catch((error: unknown) => {
        if (!active(request)) return;
        const code = error instanceof ApiError ? error.code : "unknown";
        if (code !== "client_cancelled") dispatch({ type: "fail", code });
      })
      .finally(() => {
        if (upload === handle) upload = null;
      });
  };

  const beginCapture = async (request: number) => {
    const picked = pickMimeType(
      typeof MediaRecorder !== "undefined"
        ? MediaRecorder.isTypeSupported?.bind(MediaRecorder)
        : undefined,
    );
    if (!picked || !active(request)) return;
    const language = props.language,
      farmId = props.farmId;
    let captured: MediaStream;
    try {
      captured = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 } },
      });
    } catch {
      if (active(request)) dispatch({ type: "permission_denied" });
      return;
    }
    if (!active(request)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = captured;
    chunks = [];
    try {
      const capture = new MediaRecorder(captured, { mimeType: picked });
      recorder = capture;
      capture.ondataavailable = (event) => {
        if (active(request) && event.data.size > 0) chunks.push(event.data);
      };
      capture.onerror = () => {
        if (!active(request)) return;
        releaseMic();
        dispatch({ type: "fail", code: "recording_failed" });
        ++generation;
      };
      capture.onstop = async () => {
        if (!active(request)) return;
        releaseMic();
        const recording = new Blob(chunks, {
          type: picked.split(";")[0] ?? picked,
        });
        chunks = [];
        dispatch({ type: "recorded" });
        try {
          const wav = await prepareTranscriptionWav(recording, max());
          if (!active(request)) return;
          dispatch({ type: "prepared" });
          send(wav, request, language, farmId);
        } catch {
          if (active(request))
            dispatch({ type: "fail", code: "audio_preparation_failed" });
        }
      };
      capture.start();
      dispatch({ type: "permission_granted" });
      const started = Date.now();
      timer = setInterval(() => {
        if (!active(request)) return;
        const elapsed = (Date.now() - started) / 1000;
        dispatch({ type: "tick", elapsed, maxSeconds: max() });
        if (elapsed >= max() && capture.state === "recording") capture.stop();
      }, 250);
    } catch {
      releaseMic();
      if (active(request)) dispatch({ type: "fail", code: "recording_failed" });
    }
  };

  const tapRecord = async () => {
    if (checking() || isBusy(state())) return;
    if (!recorderSupported()) {
      dispatch({
        type: "tap_record",
        supported: false,
        disclosureAcknowledged: false,
      });
      return;
    }
    const request = ++generation;
    setChecking(true);
    setAvailabilityError("");
    try {
      const status = await fetchSpeechStatus();
      if (!active(request)) return;
      if (!status?.available || status.provider !== "meta") {
        setAvailabilityError(
          "Meta voice input is unavailable right now. You can type your message below.",
        );
        return;
      }
      if (Number.isFinite(status.maxSeconds) && status.maxSeconds! > 0)
        setServerMax(status.maxSeconds!);
      const acknowledged = readAck();
      dispatch({
        type: "tap_record",
        supported: true,
        disclosureAcknowledged: acknowledged,
      });
      if (acknowledged) await beginCapture(request);
    } catch {
      if (active(request))
        setAvailabilityError(
          "Voice availability could not be checked. You can type your message below.",
        );
    } finally {
      if (active(request)) setChecking(false);
    }
  };
  const acknowledge = () => {
    writeAck();
    dispatch({ type: "acknowledge_disclosure" });
    void beginCapture(++generation);
  };
  const stopRecording = () => {
    if (recorder?.state === "recording") recorder.stop();
  };

  const warning = () => {
    const s = state();
    return s.kind === "review"
      ? languageMismatchWarning(s.result.detectedLanguage, props.language)
      : null;
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
            Voice recording is not available in this browser. Type your message
            instead.
          </p>
        </Match>
        <Match when={state().kind === "disclosure"}>
          <div
            class="speech-disclosure"
            role="group"
            aria-label="Voice privacy notice"
          >
            <p>
              Your recording is sent to Meta to turn it into text. Check and
              edit the transcript before using it. Meta’s processing terms
              apply; this is not a promise of zero audio retention. You can type
              instead.
            </p>
            <div class="speech-actions">
              <button type="button" class="btn" onClick={acknowledge}>
                I understand, start recording
              </button>
              <button
                type="button"
                class="btn speech-secondary"
                onClick={cancel}
              >
                Type instead
              </button>
            </div>
          </div>
        </Match>
        <Match when={state().kind === "recording"}>
          <div class="speech-status" role="status" aria-live="polite">
            <span class="speech-dot" aria-hidden="true" />
            Recording…{" "}
            {formatTimer(
              (state() as Extract<VoiceState, { kind: "recording" }>).elapsed,
            )}{" "}
            of {formatTimer(max())}
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
          <p class="speech-status" role="status">
            Waiting for microphone permission…
          </p>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match when={state().kind === "preparing"}>
          <p class="speech-status" role="status">
            Preparing your recording for Meta…
          </p>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match when={state().kind === "uploading"}>
          <div class="speech-status" role="status" aria-live="polite">
            <label for={`${inputId}-progress`}>Uploading recording</label>{" "}
            <progress
              id={`${inputId}-progress`}
              max="1"
              value={
                (state() as Extract<VoiceState, { kind: "uploading" }>).progress
              }
            />
          </div>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match when={state().kind === "processing"}>
          <div class="speech-status" role="status" aria-live="polite">
            Turning your voice into text…
          </div>
          <button type="button" class="btn speech-secondary" onClick={cancel}>
            Cancel
          </button>
        </Match>
        <Match
          when={
            state().kind === "idle" ||
            state().kind === "review" ||
            state().kind === "error"
          }
        >
          <button
            type="button"
            class="btn"
            disabled={checking()}
            onClick={() => void tapRecord()}
          >
            {checking()
              ? "Checking Meta voice…"
              : `Record voice (${langName()})`}
          </button>
        </Match>
      </Switch>

      <Show when={availabilityError()}>
        <p class="speech-note" role="status">
          {availabilityError()}
        </p>
      </Show>
      <Show when={state().kind === "review"}>
        <p class="speech-note">
          Transcribed by Meta
          {(state() as Extract<VoiceState, { kind: "review" }>).result.model
            ? ` · ${(state() as Extract<VoiceState, { kind: "review" }>).result.model}`
            : ""}
          . Check names, dates and quantities.
        </p>
      </Show>
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
      <Show
        when={
          state().kind === "review" &&
          (state() as Extract<VoiceState, { kind: "review" }>).result.synthetic
        }
      >
        <p class="speech-warning" role="status">
          Synthetic fixture transcript, not real speech recognition.
        </p>
      </Show>

      <label class="speech-label" for={`${inputId}-text`}>
        Your message (edit before using)
      </label>
      <textarea
        id={`${inputId}-text`}
        class="speech-text"
        rows="4"
        lang={props.language}
        value={text()}
        disabled={false}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder="Type here, or record a voice note"
      />
      <button
        type="button"
        class="btn"
        disabled={!text().trim() || isBusy(state()) || checking()}
        onClick={confirm}
      >
        Use this text
      </button>
    </section>
  );
}
