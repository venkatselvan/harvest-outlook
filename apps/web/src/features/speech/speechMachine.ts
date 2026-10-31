/**
 * Pure state machine for Meta voice input. No DOM access, so every transition,
 * including the recording cap and the unsupported-browser fallback, is unit-testable.
 */

export type SpeechLang = "en" | "ta" | "hi";
export const LANGUAGE_NAMES: Record<SpeechLang, string> = {
  en: "English",
  ta: "Tamil",
  hi: "Hindi",
};
export const DEFAULT_MAX_SECONDS = 60;

export interface TranscriptResult {
  transcript: string;
  detectedLanguage: string | null;
  languageProbability: number | null;
  synthetic: boolean;
  providerName: string;
  model?: string | null;
}

export type VoiceState =
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "disclosure" }
  | { kind: "requesting_permission" }
  | { kind: "recording"; elapsed: number; capReached: boolean }
  | { kind: "preparing" }
  | { kind: "uploading"; progress: number }
  | { kind: "processing" }
  | { kind: "review"; result: TranscriptResult }
  | { kind: "error"; code: string; message: string };

export type VoiceEvent =
  | { type: "tap_record"; supported: boolean; disclosureAcknowledged: boolean }
  | { type: "acknowledge_disclosure" }
  | { type: "permission_granted" }
  | { type: "permission_denied" }
  | { type: "tick"; elapsed: number; maxSeconds: number }
  | { type: "recorded" }
  | { type: "prepared" }
  | { type: "upload_progress"; fraction: number }
  | { type: "upload_sent" }
  | { type: "result"; result: TranscriptResult }
  | { type: "fail"; code: string; message?: string }
  | { type: "cancel" }
  | { type: "reset" };

export function initialVoiceState(supported: boolean): VoiceState {
  return supported ? { kind: "idle" } : { kind: "unsupported" };
}

export const UNAVAILABLE_MESSAGE = "Speech unavailable; type instead.";

/** Farmer-facing text for an API/transport error code. The typed text is never touched by errors. */
export function errorMessage(code: string): string {
  switch (code) {
    case "provider_unavailable":
    case "provider_error":
    case "provider_auth_failed":
    case "provider_bad_response":
    case "provider_rate_limited":
    case "speech_not_supported":
    case "speech_not_qualified":
      return UNAVAILABLE_MESSAGE;
    case "network_error":
      return "No connection. Your text is kept; try again or type instead.";
    case "payload_too_large":
    case "audio_too_long":
      return "That recording is too long. Record a shorter note or type instead.";
    case "audio_too_short":
      return "That recording was too short. Try again or type instead.";
    case "unsupported_media_type":
      return "This browser's audio format is not supported. Type instead.";
    case "audio_preparation_failed":
      return "This recording could not be prepared. Type instead.";
    case "recording_failed":
      return "Could not record audio. Your microphone has been released. Type instead.";
    case "permission_denied":
      return "Microphone access was blocked. Allow it in your browser settings, or type instead.";
    case "rate_limited":
      return "Too many voice requests. Wait a minute or type instead.";
    default:
      return "Could not transcribe that recording. Type instead.";
  }
}

export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "tap_record":
      if (!e.supported) return { kind: "unsupported" };
      if (s.kind !== "idle" && s.kind !== "error" && s.kind !== "review")
        return s;
      return e.disclosureAcknowledged
        ? { kind: "requesting_permission" }
        : { kind: "disclosure" };
    case "acknowledge_disclosure":
      return s.kind === "disclosure" ? { kind: "requesting_permission" } : s;
    case "permission_granted":
      return s.kind === "requesting_permission"
        ? { kind: "recording", elapsed: 0, capReached: false }
        : s;
    case "permission_denied":
      return s.kind === "requesting_permission"
        ? {
            kind: "error",
            code: "permission_denied",
            message: errorMessage("permission_denied"),
          }
        : s;
    case "tick": {
      if (s.kind !== "recording") return s;
      const elapsed = Math.min(e.elapsed, e.maxSeconds);
      return {
        kind: "recording",
        elapsed,
        capReached: s.capReached || e.elapsed >= e.maxSeconds,
      };
    }
    case "recorded":
      return s.kind === "recording" ? { kind: "preparing" } : s;
    case "prepared":
      return s.kind === "preparing" ? { kind: "uploading", progress: 0 } : s;
    case "upload_progress":
      return s.kind === "uploading"
        ? { kind: "uploading", progress: Math.max(0, Math.min(1, e.fraction)) }
        : s;
    case "upload_sent":
      return s.kind === "uploading" ? { kind: "processing" } : s;
    case "result":
      return s.kind === "uploading" || s.kind === "processing"
        ? { kind: "review", result: e.result }
        : s;
    case "fail":
      if (s.kind === "idle" || s.kind === "unsupported") return s;
      return {
        kind: "error",
        code: e.code,
        message: e.message ?? errorMessage(e.code),
      };
    case "cancel":
      return s.kind === "unsupported" ? s : { kind: "idle" };
    case "reset":
      return s.kind === "unsupported" ? s : { kind: "idle" };
  }
}

export const isBusy = (s: VoiceState): boolean =>
  s.kind === "requesting_permission" ||
  s.kind === "recording" ||
  s.kind === "preparing" ||
  s.kind === "uploading" ||
  s.kind === "processing";

/** 0:12 style timer. */
export function formatTimer(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const;

/** First MediaRecorder type the browser can record, in preference order; null means text-only. */
export function pickMimeType(
  isTypeSupported: ((t: string) => boolean) | undefined,
): string | null {
  if (!isTypeSupported) return null;
  for (const t of CANDIDATES) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function normaliseDetected(
  code: string | null,
): SpeechLang | string | null {
  if (!code) return null;
  const c = code.toLowerCase().split(/[-_]/)[0]!;
  const map: Record<string, SpeechLang> = {
    en: "en",
    eng: "en",
    ta: "ta",
    tam: "ta",
    hi: "hi",
    hin: "hi",
  };
  return map[c] ?? c;
}

/** Warning text when the detected language differs from the selected one; null when they agree or are unknown. */
export function languageMismatchWarning(
  detected: string | null,
  selected: SpeechLang,
): string | null {
  const d = normaliseDetected(detected);
  if (!d || d === selected) return null;
  const heard = d in LANGUAGE_NAMES ? LANGUAGE_NAMES[d as SpeechLang] : d;
  return `This sounded like ${heard}, but ${LANGUAGE_NAMES[selected]} is selected. Check the text before using it.`;
}
