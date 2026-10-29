import { z } from "zod";
import { ApiError } from "../services/errors";
import { STT_LANGUAGE_CODE } from "./languages";
import type { SpeechProvider, SttInput, SttResult, TtsInput, TtsResult } from "./provider";
import type { SpeechConfig } from "./config";

/** Documented response of POST /v1/speech-to-text (fields we use; others ignored). */
export const sttResponseSchema = z.object({
  text: z.string(),
  language_code: z.string().nullish(),
  language_probability: z.number().nullish(),
  words: z
    .array(
      z.object({
        text: z.string(),
        type: z.string().optional(),
        start: z.number().nullish(),
        end: z.number().nullish(),
      }),
    )
    .nullish(),
});

export function redact(text: string, secret: string | undefined): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/xi-api-key\s*[:=]\s*\S+/gi, "xi-api-key: [redacted]").replace(/sk_[A-Za-z0-9]{16,}/g, "[redacted]");
}

/** Maps an ElevenLabs output_format prefix to a content type. */
export function contentTypeForFormat(format: string): string {
  if (format.startsWith("mp3_")) return "audio/mpeg";
  if (format.startsWith("opus_")) return "audio/ogg";
  if (format.startsWith("wav_")) return "audio/wav";
  if (format.startsWith("pcm_")) return "audio/L16";
  if (format.startsWith("ulaw_") || format.startsWith("alaw_")) return "audio/basic";
  return "application/octet-stream";
}

const TTS_LANGUAGE_PARAM_MODELS = /(flash_v2_5|turbo_v2_5)/;

export class ElevenLabsProvider implements SpeechProvider {
  readonly name = "elevenlabs" as const;
  readonly live = true;
  readonly sttModel: string;
  readonly ttsModel: string;

  constructor(
    private readonly cfg: SpeechConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!cfg.apiKey) throw new Error("ElevenLabsProvider requires an API key");
    this.sttModel = cfg.sttModel;
    this.ttsModel = cfg.ttsModel;
  }

  /** Builds the documented multipart body; exposed for tests. */
  buildSttForm(input: SttInput): FormData {
    const form = new FormData();
    form.append("model_id", this.cfg.sttModel);
    form.append("language_code", STT_LANGUAGE_CODE[input.language]);
    form.append("tag_audio_events", "false");
    form.append("diarize", "false");
    form.append("timestamps_granularity", "word");
    form.append("file", new Blob([input.audio as BlobPart], { type: input.mime }), "audio");
    return form;
  }

  private async call(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: sig, headers: { ...(init.headers as Record<string, string>), "xi-api-key": this.cfg.apiKey! } });
    } catch (e) {
      if (signal?.aborted) throw new ApiError(499, "client_cancelled", "Request cancelled");
      const reason = timeout.aborted ? "timed out" : "unreachable";
      throw new ApiError(424, "provider_error", `Speech provider ${reason}`, { cause: redact((e as Error).name, this.cfg.apiKey) });
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => undefined); // provider bodies may echo user text; never read, forwarded or logged
    if (res.status === 401 || res.status === 403) throw new ApiError(424, "provider_auth_failed", "Speech provider rejected the server credential");
    if (res.status === 422 || res.status === 400) throw new ApiError(422, "provider_rejected_input", "Speech provider could not process this input");
    if (res.status === 429) throw new ApiError(429, "provider_rate_limited", "Speech provider rate limit or credits exhausted; try again later");
    throw new ApiError(424, "provider_error", `Speech provider error (HTTP ${res.status})`);
  }

  async transcribe(input: SttInput): Promise<SttResult> {
    const res = await this.call(`${this.cfg.baseUrl}/v1/speech-to-text`, { method: "POST", body: this.buildSttForm(input) }, input.signal);
    let parsed: z.infer<typeof sttResponseSchema>;
    try {
      parsed = sttResponseSchema.parse(await res.json());
    } catch {
      throw new ApiError(424, "provider_bad_response", "Speech provider returned an unexpected response");
    }
    const words = (parsed.words ?? []).map((w) => ({ text: w.text, type: w.type ?? "word", ...(w.start != null ? { start: w.start } : {}), ...(w.end != null ? { end: w.end } : {}) }));
    return {
      transcript: parsed.text.trim(),
      detectedLanguage: parsed.language_code ?? null,
      languageProbability: parsed.language_probability ?? null,
      words,
      providerName: "elevenlabs",
      model: this.cfg.sttModel,
      requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id"),
      synthetic: false,
    };
  }

  buildTtsRequest(input: TtsInput): { url: string; body: Record<string, unknown> } {
    const body: Record<string, unknown> = { text: input.text, model_id: this.cfg.ttsModel };
    // language_code is documented as unsupported on multilingual_v2, so only send it for the v2.5 models.
    if (TTS_LANGUAGE_PARAM_MODELS.test(this.cfg.ttsModel)) body.language_code = input.language;
    const url = `${this.cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${encodeURIComponent(this.cfg.ttsOutputFormat)}`;
    return { url, body };
  }

  async synthesize(input: TtsInput): Promise<TtsResult> {
    const { url, body } = this.buildTtsRequest(input);
    const res = await this.call(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "*/*" } }, input.signal);
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.length === 0) throw new ApiError(424, "provider_bad_response", "Speech provider returned no audio");
    return {
      audio,
      contentType: contentTypeForFormat(this.cfg.ttsOutputFormat),
      characters: [...input.text].length,
      model: this.cfg.ttsModel,
      requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id"),
    };
  }
}
