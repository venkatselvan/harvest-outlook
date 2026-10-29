import { z } from "zod";

const optionalString = z.string().trim().min(1).optional();
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

/**
 * Speech-only configuration, read straight from the environment so it does not touch the shared
 * config module. The key stays server-side; sanitizedSpeechConfig() never returns it.
 */
export const speechConfigSchema = z.object({
  ELEVENLABS_API_KEY: optionalString,
  /** Use https://api.in.residency.elevenlabs.io for India data residency (account must support it). */
  ELEVENLABS_BASE_URL: z.string().url().default("https://api.elevenlabs.io"),
  ELEVENLABS_STT_MODEL: z.string().trim().min(1).default("scribe_v2"),
  ELEVENLABS_TTS_MODEL: z.string().trim().min(1).default("eleven_flash_v2_5"),
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_TTS_OUTPUT_FORMAT: z
    .string()
    .regex(/^[a-z0-9_]+$/, "must look like mp3_22050_32")
    .default("mp3_22050_32"),
  MAX_VOICE_SECONDS: positiveInt(60),
  SPEECH_MAX_BYTES: positiveInt(10 * 1024 * 1024),
  SPEECH_PROVIDER_TIMEOUT_MS: positiveInt(30_000),
});

export interface SpeechConfig {
  apiKey: string | undefined;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  voiceId: string | undefined;
  ttsOutputFormat: string;
  maxSeconds: number;
  maxBytes: number;
  timeoutMs: number;
}

export function loadSpeechConfig(env: Record<string, string | undefined> = process.env): SpeechConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const p = speechConfigSchema.safeParse(cleaned);
  if (!p.success) {
    throw new Error(`Invalid speech configuration: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const c = p.data;
  return {
    apiKey: c.ELEVENLABS_API_KEY,
    baseUrl: c.ELEVENLABS_BASE_URL.replace(/\/+$/, ""),
    sttModel: c.ELEVENLABS_STT_MODEL,
    ttsModel: c.ELEVENLABS_TTS_MODEL,
    voiceId: c.ELEVENLABS_VOICE_ID,
    ttsOutputFormat: c.ELEVENLABS_TTS_OUTPUT_FORMAT,
    maxSeconds: c.MAX_VOICE_SECONDS,
    maxBytes: c.SPEECH_MAX_BYTES,
    timeoutMs: c.SPEECH_PROVIDER_TIMEOUT_MS,
  };
}

export function sanitizedSpeechConfig(c: SpeechConfig): Record<string, unknown> {
  const { apiKey, ...rest } = c;
  return { ...rest, apiKeyConfigured: !!apiKey };
}
