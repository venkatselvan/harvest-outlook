import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { ApiError } from "../services/errors";
import { validateAudio } from "../speech/audio";
import { isApprovedText } from "../speech/approved";
import { loadSpeechConfig, type SpeechConfig } from "../speech/config";
import { ElevenLabsProvider } from "../speech/elevenlabs";
import { FIXTURE_LABEL, FixtureProvider } from "../speech/fixture";
import { normaliseLanguage, SPEECH_LANGUAGES, type SpeechLanguage } from "../speech/languages";
import { stripMarkdown } from "../speech/markdown";
import type { SpeechProvider } from "../speech/provider";
import { logSpeechUsage, ttsCapExceeded, ttsLimitsFromEnv, type TtsLimits } from "../speech/usage";
import { envelopeSchema } from "./schemas/common";
import { statusOut, synthesisBody, transcriptionOut, transcriptionQuery } from "./schemas/speech";

export interface SpeechRouteDeps {
  config: Config;
  pool: Pool;
  /** Defaults to env-derived config overlaid with the shared Config values. */
  speech?: SpeechConfig;
  /** Tests inject a provider; production derives it from config (live key + RUNTIME_MODE=live, else fixture). */
  provider?: SpeechProvider;
  fetchImpl?: typeof fetch;
  /** Per-owner TTS caps; defaults to SPEECH_TTS_DAILY_CHARS (20000) and 5 syntheses of one text per hour. */
  ttsLimits?: TtsLimits;
}

const MULTIPART_OVERHEAD = 64 * 1024;

export function speechConfigFor(config: Config): SpeechConfig {
  const env: Record<string, string | undefined> = { ...process.env, MAX_VOICE_SECONDS: String(config.MAX_VOICE_SECONDS) };
  if (config.ELEVENLABS_API_KEY) env.ELEVENLABS_API_KEY = config.ELEVENLABS_API_KEY;
  if (config.ELEVENLABS_STT_MODEL) env.ELEVENLABS_STT_MODEL = config.ELEVENLABS_STT_MODEL;
  if (config.ELEVENLABS_TTS_MODEL) env.ELEVENLABS_TTS_MODEL = config.ELEVENLABS_TTS_MODEL;
  if (config.ELEVENLABS_VOICE_ID) env.ELEVENLABS_VOICE_ID = config.ELEVENLABS_VOICE_ID;
  return loadSpeechConfig(env);
}

export function createSpeechProvider(config: Config, speech: SpeechConfig, fetchImpl?: typeof fetch): SpeechProvider {
  if (speech.apiKey && config.RUNTIME_MODE === "live") return new ElevenLabsProvider(speech, fetchImpl);
  return new FixtureProvider();
}

/** Fable wires this from routes/index.ts. The plugin is encapsulated so its guard covers only speech routes. */
export async function registerSpeechRoutes(app: FastifyInstance, deps: SpeechRouteDeps): Promise<void> {
  await app.register(speechRoutes, deps);
}

async function speechRoutes(app: FastifyInstance, deps: SpeechRouteDeps) {
  const { config, pool } = deps;
  const speech = deps.speech ?? speechConfigFor(config);
  const provider = deps.provider ?? createSpeechProvider(config, speech, deps.fetchImpl);
  const ttsLimits = deps.ttsLimits ?? ttsLimitsFromEnv();
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  r.get(
    "/api/v1/speech/status",
    { schema: { tags: ["speech"], description: "Whether speech can be used, so the UI can offer typing instead.", response: { 200: envelopeSchema(statusOut) } } },
    async (req) =>
      envelope(
        req.id,
        config.RUNTIME_MODE,
        {
          available: provider.live,
          live: provider.live,
          provider: provider.name,
          languages: [...SPEECH_LANGUAGES],
          maxSeconds: speech.maxSeconds,
          maxBytes: speech.maxBytes,
          qualified: false,
          ttsVoiceConfigured: !!speech.voiceId,
        },
        provider.live ? [] : ["Speech unavailable; type instead."],
      ),
  );

  r.post(
    "/api/v1/speech/transcriptions",
    {
      config: limit,
      schema: {
        tags: ["speech"],
        description:
          'Multipart: field "audio" (webm/ogg/wav/mp4/m4a/mp3 by magic bytes), field "language" (en|ta|hi), optional "farmId". ' +
          "Audio is held in memory for the provider call only and never stored; the transcript is returned, not persisted. " +
          "Duration is enforced where the container header states it; otherwise the byte cap and the client timer apply.",
        querystring: transcriptionQuery,
        response: { 200: envelopeSchema(transcriptionOut) },
      },
    },
    async (req, reply) => {
      const { ownerId } = requireAuth(req);
      if (!req.isMultipart()) throw new ApiError(415, "unsupported_media_type", "Expected multipart/form-data");
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > speech.maxBytes + MULTIPART_OVERHEAD) {
        reply.header("connection", "close");
        throw new ApiError(413, "payload_too_large", `Audio exceeds ${speech.maxBytes} bytes`);
      }

      const fields: Record<string, string> = {};
      let audio: Buffer | null = null;
      for await (const part of req.parts({ limits: { fileSize: speech.maxBytes, files: 1, fields: 6 } })) {
        if (part.type === "field") {
          if (typeof part.value === "string") fields[part.fieldname] = part.value;
          continue;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > speech.maxBytes) {
            part.file.destroy();
            reply.header("connection", "close");
            throw new ApiError(413, "payload_too_large", `Audio exceeds ${speech.maxBytes} bytes`);
          }
          chunks.push(chunk);
        }
        if (part.file.truncated) {
          reply.header("connection", "close");
          throw new ApiError(413, "payload_too_large", `Audio exceeds ${speech.maxBytes} bytes`);
        }
        if (part.fieldname === "audio" && !audio) audio = Buffer.concat(chunks);
      }
      if (!audio) throw new ApiError(400, "audio_required", 'Multipart field "audio" is required');

      const lang = z.enum(SPEECH_LANGUAGES).safeParse(fields.language);
      if (!lang.success) throw new ApiError(400, "validation_error", "language must be one of en, ta, hi");
      const language: SpeechLanguage = lang.data;
      if (fields.farmId !== undefined) {
        if (!z.uuid().safeParse(fields.farmId).success) throw new ApiError(400, "validation_error", "farmId must be a UUID");
        const f = await pool.query("SELECT 1 FROM farms WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL", [fields.farmId, ownerId]);
        if (f.rowCount === 0) throw new ApiError(404, "not_found", "Farm not found");
      }

      const check = validateAudio(audio, { maxBytes: speech.maxBytes, maxSeconds: speech.maxSeconds });

      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const res = await provider.transcribe({ audio, mime: check.mime, language, signal: abort.signal });
      const lastEnd = res.words?.reduce((m, w) => Math.max(m, w.end ?? 0), 0) || null;
      const usageSeconds = check.durationSeconds ?? lastEnd;
      if (res.providerName === "elevenlabs") {
        await logSpeechUsage(pool, {
          ownerId,
          requestId: req.id,
          kind: "stt",
          model: res.model,
          units: "seconds",
          amount: usageSeconds,
          providerRequestId: res.requestId,
          language,
        });
      }
      // Log shape only: never the transcript or audio.
      req.log.info({ speech: { kind: "stt", language, bytes: check.bytes, seconds: usageSeconds, format: check.format } }, "transcription complete");

      const detected = normaliseLanguage(res.detectedLanguage);
      const detectedLanguage = detected ?? res.detectedLanguage?.toLowerCase() ?? null;
      const includeWords = req.query.includeWords === "true" && res.words;
      return envelope(
        req.id,
        config.RUNTIME_MODE,
        {
          transcript: res.transcript,
          detectedLanguage,
          languageProbability: res.languageProbability,
          languageMismatch: detectedLanguage !== null && detectedLanguage !== language,
          provider: { name: res.providerName, model: res.model, requestId: res.requestId },
          usageSeconds,
          synthetic: res.synthetic,
          ...(includeWords ? { words: res.words } : {}),
        },
        res.synthetic ? [FIXTURE_LABEL] : [],
      );
    },
  );

  r.post(
    "/api/v1/speech/synthesis",
    {
      config: limit,
      schema: {
        tags: ["speech"],
        description:
          "Speaks an approved answer. The text must hash to approvedTextHash, a hash the assistant route recorded for this owner (60-minute window; 403 otherwise). " +
          "Markdown is stripped before synthesis. Per owner: a daily character cap and at most 5 syntheses of the same text per hour (429 rate_limited). Returns audio bytes (Cache-Control: private, no-store).",
        body: synthesisBody,
      },
    },
    async (req, reply) => {
      const { ownerId } = requireAuth(req);
      const { text, language, voiceId, approvedTextHash } = req.body;
      if (!(await isApprovedText(pool, ownerId, text, approvedTextHash))) {
        throw new ApiError(403, "approved_text_mismatch", "Only the approved answer text can be spoken");
      }
      const spoken = stripMarkdown(text);
      if (!spoken) throw new ApiError(400, "validation_error", "Nothing speakable in the text");
      const voice = voiceId ?? speech.voiceId;
      if (provider.live && !voice) throw new ApiError(424, "provider_unavailable", "Speech unavailable (no voice configured); read the text instead");

      if (provider.name === "elevenlabs") {
        const capped = await ttsCapExceeded(pool, ownerId, approvedTextHash.toLowerCase(), spoken.length, ttsLimits);
        if (capped) {
          throw new ApiError(429, "rate_limited", capped === "same_text" ? "This answer has already been spoken several times this hour; read the text instead" : "The daily speech limit was reached; read the text instead", { limit: capped });
        }
      }
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const res = await provider.synthesize({ text: spoken, language, voiceId: voice ?? "", signal: abort.signal });
      if (provider.name === "elevenlabs") {
        await logSpeechUsage(pool, {
          ownerId,
          requestId: req.id,
          kind: "tts",
          model: res.model,
          units: "characters",
          amount: res.characters,
          providerRequestId: res.requestId,
          language,
          approvedTextHash: approvedTextHash.toLowerCase(),
        });
      }
      req.log.info({ speech: { kind: "tts", language, characters: res.characters, bytes: res.audio.length } }, "synthesis complete");
      return reply
        .header("cache-control", "private, no-store")
        .header("content-type", res.contentType)
        .header("x-speech-source", "approved-answer")
        .send(Buffer.from(res.audio));
    },
  );
}
