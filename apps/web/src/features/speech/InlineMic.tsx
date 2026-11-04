import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { ApiError } from "../../lib/api";
import { Icon } from "../../workspace/icons";
import {
  fetchSpeechStatus,
  uploadTranscription,
  type UploadHandle,
} from "./speechApi";
import {
  DEFAULT_MAX_SECONDS,
  initialVoiceState,
  isBusy,
  languageMismatchWarning,
  pickMimeType,
  UNAVAILABLE_MESSAGE,
  voiceReducer,
  type SpeechLang,
  type TranscriptResult,
  type VoiceEvent,
  type VoiceState,
} from "./speechMachine";
import "./speech.css";
import { prepareTranscriptionWav } from "./wav";

/*
 * Inline microphone for a text composer. Presentation and DOM plumbing only: the state transitions are the shared
 * `voiceReducer`, and the upload and WAV preparation are the shared `uploadTranscription` / `prepareTranscriptionWav`.
 * The transcript is handed to the composer through `onTranscript`; nothing here ever sends a message.
 */

export const METER_BARS = 6;
const FLAT_LEVEL = 0.12;
const flatLevels = (): number[] => Array(METER_BARS).fill(FLAT_LEVEL);

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

export const recorderSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined" &&
  typeof AudioContext !== "undefined" &&
  typeof OfflineAudioContext !== "undefined" &&
  pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder)) !== null;

/** 00:02 style clock (two-digit minutes), as shown in the recording pill. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * Insert a transcript into the composer text at the selection. A space separates it from neighbouring text, the result
 * never exceeds `maxLength` (the transcript is shortened, and `truncated` says so), and the caret lands after the insertion.
 */
export function insertTranscript(
  current: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
  maxLength = 800,
): { value: string; caret: number; truncated: boolean } {
  const heard = transcript.trim();
  if (!heard) return { value: current, caret: selectionStart, truncated: false };
  const start = Math.max(0, Math.min(selectionStart, current.length));
  const end = Math.max(start, Math.min(selectionEnd, current.length));
  if (!current.trim()) {
    const value = heard.slice(0, maxLength);
    return { value, caret: value.length, truncated: value.length < heard.length };
  }
  const before = current.slice(0, start);
  const after = current.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const room = maxLength - before.length - after.length - lead.length - trail.length;
  if (room <= 0) return { value: current, caret: start, truncated: true };
  const inserted = heard.slice(0, room);
  const value = `${before}${lead}${inserted}${trail}${after}`;
  return {
    value,
    caret: before.length + lead.length + inserted.length,
    truncated: inserted.length < heard.length,
  };
}

/**
 * Bar heights (0..1) from an analyser's byte frequency data. The voice band is the lowest bins, so the bars take
 * consecutive groups from bin 1 upward; the square root makes quiet speech visible without clipping loud speech.
 */
export function barLevels(
  frequency: ArrayLike<number>,
  count = METER_BARS,
): number[] {
  const per = Math.max(1, Math.min(3, Math.floor((frequency.length - 1) / count)));
  return Array.from({ length: count }, (_, bar) => {
    let sum = 0;
    let n = 0;
    for (let i = 1 + bar * per; i < 1 + (bar + 1) * per && i < frequency.length; i++) {
      sum += frequency[i] ?? 0;
      n++;
    }
    const average = n ? sum / n / 255 : 0;
    return Math.max(FLAT_LEVEL, Math.min(1, Math.sqrt(average) * 1.15));
  });
}

export interface InlineMicOptions {
  language: () => SpeechLang;
  farmId: () => string | undefined;
  maxSeconds?: () => number | undefined;
  /** Receives the transcript only. Return a short note (for example, that it was shortened) to show under the composer. */
  onTranscript: (text: string, result: TranscriptResult) => string | void;
}

/** All recorder state and DOM plumbing for one composer microphone. Create it inside a component or root. */
export function createInlineMic(options: InlineMicOptions) {
  const [serverMax, setServerMax] = createSignal(DEFAULT_MAX_SECONDS);
  const max = () =>
    Math.min(options.maxSeconds?.() ?? DEFAULT_MAX_SECONDS, serverMax());
  const [state, setState] = createSignal<VoiceState>(
    initialVoiceState(recorderSupported()),
  );
  const [checking, setChecking] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [availabilityError, setAvailabilityError] = createSignal("");
  const [note, setNote] = createSignal("");
  const [levels, setLevels] = createSignal<number[]>(flatLevels());
  const dispatch = (e: VoiceEvent) => setState((s) => voiceReducer(s, e));

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let upload: UploadHandle | null = null;
  let generation = 0;
  let disposed = false;
  let meterContext: AudioContext | null = null;
  let frame = 0;
  const active = (request: number) => !disposed && request === generation;

  const stopMeter = () => {
    if (frame && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(frame);
    frame = 0;
    const context = meterContext;
    meterContext = null;
    if (context) void context.close().catch(() => undefined);
    setLevels(flatLevels());
  };
  /** Level bars are decoration: any failure here leaves flat bars and never affects recording. */
  const startMeter = (captured: MediaStream) => {
    try {
      const context = new AudioContext();
      meterContext = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      context.createMediaStreamSource(captured).connect(analyser);
      void context.resume?.().catch(() => undefined);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const reduced =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      const interval = reduced ? 250 : 60;
      let last = 0;
      const loop = (time: number) => {
        frame = requestAnimationFrame(loop);
        if (time - last < interval) return;
        last = time;
        analyser.getByteFrequencyData(data);
        setLevels(barLevels(data));
      };
      frame = requestAnimationFrame(loop);
    } catch {
      stopMeter();
    }
  };

  const releaseMic = () => {
    clearInterval(timer);
    stopMeter();
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
    recorder = null;
    releaseMic();
    chunks = [];
    upload?.abort();
    upload = null;
    setChecking(false);
    setAvailabilityError("");
    setNote("");
    dispatch({ type: "cancel" });
  };
  const reset = () => {
    if (!isBusy(state())) {
      setNote("");
      setAvailabilityError("");
      dispatch({ type: "reset" });
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && isBusy(state())) cancel();
  };
  const onSessionEnded = () => cancel();
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKey);
    window.addEventListener("ho:session-ended", onSessionEnded);
  }
  createEffect(
    on(
      [options.farmId, options.language],
      () => {
        cancel();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    disposed = true;
    cancel();
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ho:session-ended", onSessionEnded);
    }
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
        if (!result.transcript.trim()) {
          dispatch({ type: "fail", code: "audio_too_short" });
          return;
        }
        dispatch({ type: "result", result });
        setNote(options.onTranscript(result.transcript, result) ?? "");
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
    const language = options.language();
    const farmId = options.farmId();
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
      startMeter(captured);
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

  const stop = () => {
    if (recorder?.state === "recording") recorder.stop();
  };
  const tap = async () => {
    const s = state();
    if (s.kind === "recording") return stop();
    if (checking() || isBusy(s) || s.kind === "disclosure") return;
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
    setNote("");
    try {
      const status = await fetchSpeechStatus();
      if (!active(request)) return;
      if (!status?.available || status.provider !== "meta") {
        setUnavailable(true);
        setAvailabilityError(UNAVAILABLE_MESSAGE);
        return;
      }
      setUnavailable(false);
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
          "Voice availability could not be checked. Type instead.",
        );
    } finally {
      if (active(request)) setChecking(false);
    }
  };
  const acknowledge = () => {
    if (state().kind !== "disclosure") return;
    writeAck();
    dispatch({ type: "acknowledge_disclosure" });
    void beginCapture(++generation);
  };

  const busy = () => isBusy(state()) || checking();
  const transcribing = () => {
    const kind = state().kind;
    return kind === "preparing" || kind === "uploading" || kind === "processing";
  };
  const disabled = () => state().kind === "unsupported" || unavailable();
  const elapsed = () => {
    const s = state();
    return s.kind === "recording" ? s.elapsed : 0;
  };
  const errorText = () => {
    const s = state();
    return availabilityError() || (s.kind === "error" ? s.message : "");
  };
  const warnings = (): string[] => {
    const s = state();
    if (s.kind !== "review") return [] as string[];
    return [
      languageMismatchWarning(
        s.result.detectedLanguage,
        options.language(),
      ),
      s.result.synthetic
        ? "Synthetic fixture transcript, not real speech recognition."
        : null,
      note() || null,
    ].filter((line): line is string => !!line);
  };
  const announcement = (): string => {
    const s = state();
    if (s.kind === "recording") return "Listening";
    if (s.kind === "preparing" || s.kind === "uploading" || s.kind === "processing")
      return "Transcribing";
    if (s.kind === "review") return "Added to message";
    return "";
  };

  return {
    state,
    levels,
    max,
    elapsed,
    busy,
    transcribing,
    disabled,
    errorText,
    warnings,
    announcement,
    disclosure: () => state().kind === "disclosure",
    recording: () => state().kind === "recording",
    waitingForPermission: () => state().kind === "requesting_permission",
    checking,
    tap,
    stop,
    cancel,
    reset,
    acknowledge,
    declineDisclosure: cancel,
  };
}

export type InlineMic = ReturnType<typeof createInlineMic>;

/** The control that sits in the composer row: mic button, recording pill or transcribing pill, in the same slot. */
export function InlineMicControl(props: { mic: InlineMic }) {
  const mic = () => props.mic;
  const timeId = createUniqueId();
  let micButton: HTMLButtonElement | undefined;
  let stopButton: HTMLButtonElement | undefined;
  // The control swaps elements in place, so keyboard focus is moved with it instead of being dropped to the page.
  createEffect(
    on(
      () => mic().recording(),
      (recording) => {
        if (recording) queueMicrotask(() => stopButton?.focus());
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      mic().busy,
      (busy, wasBusy) => {
        if (wasBusy && !busy)
          queueMicrotask(() => {
            const focused = document.activeElement;
            if (!focused || focused === document.body) micButton?.focus();
          });
      },
      { defer: true },
    ),
  );
  return (
    <Switch
      fallback={
        <button
          type="button"
          class="mic-button"
          ref={micButton}
          aria-label="Record a voice message"
          title={mic().disabled() ? UNAVAILABLE_MESSAGE : "Record a voice message"}
          disabled={mic().disabled()}
          aria-busy={mic().checking()}
          onClick={() => void mic().tap()}
        >
          <Icon name="mic" size={17} />
        </button>
      }
    >
      <Match when={mic().recording()}>
        <div class="mic-pill recording" role="group" aria-label="Voice recording">
          <button
            type="button"
            class="mic-stop"
            ref={stopButton}
            aria-label="Stop and add to message"
            aria-describedby={timeId}
            onClick={() => mic().stop()}
          >
            <Icon name="stop" size={16} />
          </button>
          <span class="mic-bars" aria-hidden="true">
            <For each={mic().levels()}>
              {(level) => (
                <span class="mic-bar" style={{ "--lvl": level.toFixed(2) }} />
              )}
            </For>
          </span>
          <span class="mic-pill-text" id={timeId}>
            Listening…{" "}
            <span class="mic-time" aria-hidden="true">
              {clock(mic().elapsed())} / {clock(mic().max())}
            </span>
          </span>
        </div>
      </Match>
      <Match when={mic().waitingForPermission() || mic().transcribing()}>
        <div class="mic-pill working" role="group" aria-label="Voice message">
          <button
            type="button"
            class="mic-cancel"
            aria-label={
              mic().transcribing()
                ? "Cancel transcription"
                : "Cancel recording"
            }
            onClick={() => mic().cancel()}
          >
            <Icon name="close" size={16} />
          </button>
          <span class="mic-pill-text">
            {mic().transcribing() ? "Transcribing…" : "Waiting for microphone…"}
          </span>
        </div>
      </Match>
    </Switch>
  );
}

/** The one-time Meta transcription disclosure, as a compact notice above the composer. */
export function InlineMicNotice(props: { mic: InlineMic }) {
  return (
    <Show when={props.mic.disclosure()}>
      <div
        class="mic-notice"
        role="group"
        aria-label="Voice privacy notice"
      >
        <p>
          Your recording is sent to Meta to turn it into text. Check and edit
          the transcript before sending. Meta’s processing terms apply; this is
          not a promise of zero audio retention.
        </p>
        <div class="mic-notice-actions">
          <button
            type="button"
            class="btn"
            onClick={() => props.mic.acknowledge()}
          >
            Continue
          </button>
          <button
            type="button"
            class="btn speech-secondary"
            onClick={() => props.mic.declineDisclosure()}
          >
            Not now
          </button>
        </div>
      </div>
    </Show>
  );
}

/** Error and warning lines plus the polite live region, for placement under the textarea. */
export function InlineMicMessages(props: { mic: InlineMic }) {
  return (
    <>
      <span class="mic-live" role="status" aria-live="polite">
        {props.mic.announcement()}
      </span>
      <Show when={props.mic.errorText()}>
        <p class="mic-error" role="alert">
          {props.mic.errorText()}
        </p>
      </Show>
      <For each={props.mic.warnings()}>
        {(line) => (
          <p class="mic-warning" role="status">
            {line}
          </p>
        )}
      </For>
    </>
  );
}
