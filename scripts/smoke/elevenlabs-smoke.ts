/**
 * Opt-in live ElevenLabs smoke test: `pnpm smoke:elevenlabs`.
 * Runs only when ELEVENLABS_API_KEY is set; otherwise prints a skip and exits 0.
 * At most 3 TTS calls and 3 STT calls (one English, Tamil and Hindi sentence with numbers and units).
 * Writes sanitised results (no key, no audio) to evals/results/live-smoke/elevenlabs-<date>.json.
 */
import "../../apps/api/src/env";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpeechConfig, sanitizedSpeechConfig } from "../../apps/api/src/speech/config";
import { ElevenLabsProvider } from "../../apps/api/src/speech/elevenlabs";
import { runRoundtrip, type RoundtripItem } from "../../apps/api/src/speech/roundtrip";

async function main(): Promise<void> {
  const cfg = loadSpeechConfig();
  if (!cfg.apiKey) {
    console.log("elevenlabs smoke: skipped (ELEVENLABS_API_KEY is not set). No network calls were made.");
    process.exit(0);
  }
  if (!cfg.voiceId) {
    console.log("elevenlabs smoke: skipped (ELEVENLABS_VOICE_ID is not set; choose a stock voice from GET /v1/voices). No network calls were made.");
    process.exit(0);
  }

  const items: RoundtripItem[] = [
    { language: "en", case: { id: "smoke-en", text: "I planted ginger on 2 acres in April", tags: [], expect: [{ kind: "quantity", normalized: "2 acre", anyOf: ["2 acres", "two acres"] }, { kind: "crop", normalized: "ginger", anyOf: ["ginger"] }] } },
    { language: "ta", case: { id: "smoke-ta", text: "நான் இரண்டு ஏக்கரில் இஞ்சி நட்டேன்", tags: [], expect: [{ kind: "quantity", normalized: "2 acre", anyOf: ["இரண்டு ஏக்கர்", "2 ஏக்கர்", "இரண்டு ஏக்கரில்", "2 ஏக்கரில்"] }, { kind: "crop", normalized: "ginger", anyOf: ["இஞ்சி"] }] } },
    { language: "hi", case: { id: "smoke-hi", text: "मैंने दो एकड़ में अदरक लगाई है", tags: [], expect: [{ kind: "quantity", normalized: "2 acre", anyOf: ["दो एकड़", "2 एकड़"] }, { kind: "crop", normalized: "ginger", anyOf: ["अदरक"] }] } },
  ];

  const rows = await runRoundtrip(new ElevenLabsProvider(cfg), cfg.voiceId, items, { maxCalls: 3 });
  const date = new Date().toISOString().slice(0, 10);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../evals/results/live-smoke", `elevenlabs-${date}.json`);
  await mkdir(dirname(out), { recursive: true });
  const result = {
    date,
    kind: "live-smoke-synthetic-roundtrip",
    caveat: "TTS-generated audio through STT; not real farmer speech and not a language qualification.",
    config: sanitizedSpeechConfig(cfg),
    calls: { tts: rows.length, stt: rows.filter((r) => !r.error).length },
    rows: rows.map((r) => ({
      id: r.id,
      language: r.language,
      detectedLanguage: r.detectedLanguage,
      languageProbability: r.languageProbability,
      transcript: r.transcript,
      wer: r.score.wer,
      tokenAgreement: Math.max(0, 1 - r.score.wer),
      fieldHits: r.score.fieldHits,
      ttsMs: r.ttsMs,
      sttMs: r.sttMs,
      ttsCharacters: r.ttsCharacters,
      error: r.error ?? null,
    })),
  };
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, rows: result.rows.map((r) => ({ id: r.id, detected: r.detectedLanguage, tokenAgreement: r.tokenAgreement, error: r.error })) }, null, 2));
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).name}`);
  process.exit(1);
});
