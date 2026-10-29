import { sniffAudio, AUDIO_MIME } from "./audio";
import type { SpeechLanguage } from "./languages";
import { normaliseLanguage } from "./languages";
import type { SpeechProvider } from "./provider";
import { scoreCase, type CaseScore, type SpeechCase } from "./score";

export interface RoundtripItem {
  language: SpeechLanguage;
  case: SpeechCase;
}

export interface RoundtripRow {
  id: string;
  language: SpeechLanguage;
  detectedLanguage: string | null;
  languageProbability: number | null;
  transcript: string;
  score: CaseScore;
  ttsCharacters: number;
  audioBytes: number;
  ttsMs: number;
  sttMs: number;
  error?: string;
}

/**
 * TTS then STT through the real adapters. This measures the pipeline on synthetic speech only: it is
 * NOT a substitute for recordings of real farmers (accent, noise, field conditions).
 * Hard caps bound spend: stops once maxCalls TTS calls have been made.
 */
export async function runRoundtrip(
  provider: SpeechProvider,
  voiceId: string,
  items: RoundtripItem[],
  opts: { maxCalls: number; saveAudio?: (id: string, audio: Uint8Array, ext: string) => Promise<void> },
): Promise<RoundtripRow[]> {
  const rows: RoundtripRow[] = [];
  let calls = 0;
  for (const it of items) {
    if (calls >= opts.maxCalls) break;
    calls++;
    const base = { id: it.case.id, language: it.language };
    const empty = { detectedLanguage: null, languageProbability: null, transcript: "", ttsCharacters: 0, audioBytes: 0, ttsMs: 0, sttMs: 0 };
    try {
      const t0 = Date.now();
      const tts = await provider.synthesize({ text: it.case.text, language: it.language, voiceId });
      const ttsMs = Date.now() - t0;
      const fmt = sniffAudio(tts.audio);
      const mime = fmt ? AUDIO_MIME[fmt] : tts.contentType;
      await opts.saveAudio?.(it.case.id, tts.audio, fmt ?? "bin");
      const t1 = Date.now();
      const stt = await provider.transcribe({ audio: tts.audio, mime, language: it.language });
      const sttMs = Date.now() - t1;
      rows.push({
        ...base,
        detectedLanguage: normaliseLanguage(stt.detectedLanguage) ?? stt.detectedLanguage,
        languageProbability: stt.languageProbability,
        transcript: stt.transcript,
        score: scoreCase(it.case, stt.transcript),
        ttsCharacters: tts.characters,
        audioBytes: tts.audio.length,
        ttsMs,
        sttMs,
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      rows.push({ ...empty, ...base, score: { id: it.case.id, wer: 1, fieldHits: [], fieldsPassed: false }, error: code });
    }
  }
  return rows;
}
