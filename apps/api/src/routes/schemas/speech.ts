import { z } from "zod";
import { SPEECH_LANGUAGES } from "../../speech/languages";

export const speechLanguage = z.enum(SPEECH_LANGUAGES);

export const transcriptionOut = z.object({
  transcript: z.string(),
  /** en/ta/hi when recognised, else the raw provider code; null if the provider gave none. */
  detectedLanguage: z.string().nullable(),
  /** Language-detection confidence only, not transcript accuracy. */
  languageProbability: z.number().nullable(),
  languageMismatch: z.boolean(),
  provider: z.object({ name: z.enum(["elevenlabs", "fixture"]), model: z.string(), requestId: z.string().nullable() }),
  /** Container-stated duration (or last word end); null when unknown. */
  usageSeconds: z.number().nullable(),
  synthetic: z.boolean(),
  words: z.array(z.object({ text: z.string(), type: z.string(), start: z.number().optional(), end: z.number().optional() })).optional(),
});

export const transcriptionQuery = z.object({ includeWords: z.enum(["true", "false"]).optional() });

export const synthesisBody = z.object({
  text: z.string().min(1).max(2000),
  language: speechLanguage,
  voiceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "voiceId has an invalid format")
    .optional(),
  /** sha256 hex of `text` exactly as issued by the assistant route in this session. */
  approvedTextHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export const statusOut = z.object({
  available: z.boolean(),
  live: z.boolean(),
  provider: z.enum(["elevenlabs", "fixture"]),
  languages: z.array(speechLanguage),
  maxSeconds: z.number(),
  maxBytes: z.number(),
  /** Always false until the qualification harness has been run with real recordings. */
  qualified: z.boolean(),
  ttsVoiceConfigured: z.boolean(),
});
