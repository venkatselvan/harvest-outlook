import { sha256Hex } from "../services/hash";
import { makeWav } from "./audio";
import type { SpeechLanguage } from "./languages";
import { providerUnavailable, type SpeechProvider, type SttInput, type SttResult, type TtsInput, type TtsResult } from "./provider";

/** Deterministic synthetic clips. Their transcripts are invented labels, not recognition output. */
export const FIXTURE_CLIPS: { id: string; language: SpeechLanguage; audio: Buffer; transcript: string; detected: string }[] = [
  { id: "fixture-en", language: "en", audio: makeWav(0.3, { freq: 440 }), transcript: "I planted ginger on 2 acres in April", detected: "eng" },
  { id: "fixture-ta", language: "ta", audio: makeWav(0.4, { freq: 523 }), transcript: "நான் இரண்டு ஏக்கரில் இஞ்சி நட்டேன்", detected: "tam" },
  { id: "fixture-hi", language: "hi", audio: makeWav(0.5, { freq: 659 }), transcript: "मैंने दो एकड़ में अदरक लगाई है", detected: "hin" },
];
const BY_HASH = new Map(FIXTURE_CLIPS.map((c) => [sha256Hex(c.audio), c]));

export const FIXTURE_LABEL = "Synthetic fixture transcript (not real speech recognition)";

/** Used without a key or outside live mode. Never contacts a network; recognises only the fixture clips. */
export class FixtureProvider implements SpeechProvider {
  readonly name = "fixture" as const;
  readonly live = false;
  readonly sttModel = "fixture";
  readonly ttsModel = "fixture";

  async transcribe(input: SttInput): Promise<SttResult> {
    const clip = BY_HASH.get(sha256Hex(input.audio));
    if (!clip) throw providerUnavailable("no speech provider configured");
    return {
      transcript: clip.transcript,
      detectedLanguage: clip.detected,
      languageProbability: 1,
      providerName: "fixture",
      model: "fixture",
      requestId: null,
      synthetic: true,
    };
  }

  async synthesize(_input: TtsInput): Promise<TtsResult> {
    throw providerUnavailable("no speech provider configured");
  }
}
