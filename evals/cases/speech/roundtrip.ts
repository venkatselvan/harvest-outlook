/**
 * Round-trip speech qualification generator (opt-in, spends ElevenLabs credits).
 *
 *   pnpm --filter @harvest/api exec tsx ../../evals/cases/speech/roundtrip.ts [--lang en,ta,hi] [--max 36]
 *
 * Needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID. Without them it prints a skip and exits 0.
 * Synthesises each case text with TTS, transcribes the audio with STT, scores token agreement and
 * expected number/unit/date/crop forms, and writes evals/results/speech/<runId>/results.json (+ audio/).
 * Synthetic speech is not real farmer speech: this does not qualify a language.
 */
import "../../../apps/api/src/env";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpeechConfig, sanitizedSpeechConfig } from "../../../apps/api/src/speech/config";
import { ElevenLabsProvider } from "../../../apps/api/src/speech/elevenlabs";
import { SPEECH_LANGUAGES, type SpeechLanguage } from "../../../apps/api/src/speech/languages";
import { runRoundtrip, type RoundtripItem } from "../../../apps/api/src/speech/roundtrip";
import { summarise, type SpeechCase } from "../../../apps/api/src/speech/score";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };

  const cfg = loadSpeechConfig();
  if (!cfg.apiKey || !cfg.voiceId) {
    console.log("roundtrip: skipped (set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to run; this spends provider credits).");
    process.exit(0);
  }

  const langs = (arg("lang") ?? SPEECH_LANGUAGES.join(",")).split(",").filter((l): l is SpeechLanguage => (SPEECH_LANGUAGES as readonly string[]).includes(l));
  const max = Number(arg("max") ?? 36);
  const items: RoundtripItem[] = [];
  for (const language of langs) {
    const f = JSON.parse(await readFile(join(here, `${language}.json`), "utf8")) as { cases: SpeechCase[] };
    for (const c of f.cases) items.push({ language, case: c });
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(here, "../../results/speech", runId);
  await mkdir(join(out, "audio"), { recursive: true });
  const provider = new ElevenLabsProvider(cfg);
  const rows = await runRoundtrip(provider, cfg.voiceId, items, {
    maxCalls: max,
    saveAudio: (id, audio, ext) => writeFile(join(out, "audio", `${id}.${ext}`), audio),
  });

  const perLanguage = Object.fromEntries(
    langs.map((l) => {
      const r = rows.filter((x) => x.language === l);
      return [l, { ...summarise(r.map((x) => x.score)), errors: r.filter((x) => x.error).length, languageDetectedCorrectly: r.filter((x) => x.detectedLanguage === l).length }];
    }),
  );
  const result = {
    runId,
    kind: "roundtrip-synthetic-speech",
    caveat: "TTS-generated audio, not real farmer speech. Languages remain unqualified until real recordings are scored.",
    config: sanitizedSpeechConfig(cfg),
    perLanguage,
    rows: rows.map(({ ...r }) => r),
  };
  await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ runId, out, perLanguage }, null, 2));
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).name}`);
  process.exit(1);
});
