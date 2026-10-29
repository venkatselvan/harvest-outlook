import { ApiError } from "../services/errors";
import type { SpeechLanguage } from "./languages";

export interface SttInput {
  audio: Uint8Array;
  mime: string;
  language: SpeechLanguage;
  signal?: AbortSignal;
}
export interface SttResult {
  transcript: string;
  /** Provider-reported language as returned (e.g. "eng"); normalise with normaliseLanguage(). */
  detectedLanguage: string | null;
  /** Language-detection confidence only; NOT transcript accuracy. */
  languageProbability: number | null;
  /** Seconds, from the last word timestamp when the provider returns words. */
  words?: { text: string; type: string; start?: number; end?: number }[];
  providerName: "elevenlabs" | "fixture";
  model: string;
  requestId: string | null;
  /** True for fixture transcripts: never real recognition. */
  synthetic: boolean;
}

export interface TtsInput {
  text: string;
  language: SpeechLanguage;
  voiceId: string;
  signal?: AbortSignal;
}
export interface TtsResult {
  audio: Uint8Array;
  contentType: string;
  characters: number;
  model: string;
  requestId: string | null;
}

export interface SpeechProvider {
  readonly name: "elevenlabs" | "fixture";
  /** True when this provider can really transcribe/synthesise arbitrary input. */
  readonly live: boolean;
  readonly sttModel: string;
  readonly ttsModel: string;
  transcribe(input: SttInput): Promise<SttResult>;
  synthesize(input: TtsInput): Promise<TtsResult>;
}

/** 424 (not 5xx) on purpose: the shared error handler masks 5xx codes as internal_error, and the UI needs to tell "speech unavailable" apart. */
export const providerUnavailable = (what: string) =>
  new ApiError(424, "provider_unavailable", `Speech unavailable (${what}); type instead`);
