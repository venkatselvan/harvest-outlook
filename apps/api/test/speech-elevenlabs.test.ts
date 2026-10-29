import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeWav } from "../src/speech/audio";
import { loadSpeechConfig, sanitizedSpeechConfig } from "../src/speech/config";
import { ElevenLabsProvider, redact } from "../src/speech/elevenlabs";
import { FIXTURE_CLIPS, FixtureProvider } from "../src/speech/fixture";
import { normaliseLanguage, STT_LANGUAGE_CODE } from "../src/speech/languages";
import { stripMarkdown } from "../src/speech/markdown";
import { createSpeechProvider } from "../src/routes/speech";
import { testConfig } from "./helpers";
import { json, KEY, mockFetch, speechCfg } from "./speech-helpers";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/elevenlabs/${n}`, import.meta.url), "utf8"));
const audio = new Uint8Array(makeWav(0.5));

describe("speech config", () => {
  it("applies documented defaults and never exposes the key", () => {
    const c = loadSpeechConfig({ ELEVENLABS_API_KEY: KEY });
    expect(c).toMatchObject({ baseUrl: "https://api.elevenlabs.io", sttModel: "scribe_v2", ttsModel: "eleven_flash_v2_5", ttsOutputFormat: "mp3_22050_32", maxSeconds: 60, maxBytes: 10485760 });
    expect(JSON.stringify(sanitizedSpeechConfig(c))).not.toContain(KEY);
    expect(loadSpeechConfig({ ELEVENLABS_BASE_URL: "https://api.in.residency.elevenlabs.io/" }).baseUrl).toBe("https://api.in.residency.elevenlabs.io");
    expect(loadSpeechConfig({ ELEVENLABS_API_KEY: "" }).apiKey).toBeUndefined();
  });
  it("rejects bad values without echoing them", () => {
    expect(() => loadSpeechConfig({ ELEVENLABS_BASE_URL: "not a url" })).toThrow(/ELEVENLABS_BASE_URL/);
    expect(() => loadSpeechConfig({ ELEVENLABS_TTS_OUTPUT_FORMAT: "../etc" })).toThrow(/FORMAT/);
  });
});

describe("language mapping", () => {
  it("sends ISO-639-3 and normalises both code forms", () => {
    expect(STT_LANGUAGE_CODE).toEqual({ en: "eng", ta: "tam", hi: "hin" });
    expect(normaliseLanguage("tam")).toBe("ta");
    expect(normaliseLanguage("HI")).toBe("hi");
    expect(normaliseLanguage("en-IN")).toBe("en");
    expect(normaliseLanguage("fra")).toBeNull();
    expect(normaliseLanguage(null)).toBeNull();
  });
});

describe("ElevenLabs STT adapter", () => {
  it("builds the documented multipart request and parses the documented response", async () => {
    const m = mockFetch(() => json(fx("stt-response-en.json"), 200, { "request-id": "req_abc" }));
    const p = new ElevenLabsProvider(speechCfg(), m.fetch);
    const r = await p.transcribe({ audio, mime: "audio/wav", language: "ta" });

    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(c.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    const form = c.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("tam");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.get("diarize")).toBe("false");
    const file = form.get("file") as File;
    expect(file.size).toBe(audio.length);
    expect(file.type).toBe("audio/wav");
    expect(form.get("source_url")).toBeNull();

    expect(r).toMatchObject({ transcript: "I planted ginger on 2 acres in April", detectedLanguage: "eng", languageProbability: 0.98, requestId: "req_abc", providerName: "elevenlabs", model: "scribe_v2", synthetic: false });
    expect(r.words?.at(-1)).toMatchObject({ text: "acres", end: 2.1 });
  });

  it("uses the configured residency host", async () => {
    const m = mockFetch(() => json(fx("stt-response-en.json")));
    await new ElevenLabsProvider(speechCfg({ baseUrl: "https://api.in.residency.elevenlabs.io" }), m.fetch).transcribe({ audio, mime: "audio/wav", language: "en" });
    expect(m.calls[0]!.url.startsWith("https://api.in.residency.elevenlabs.io/")).toBe(true);
  });

  it("rejects a response that is not the documented shape", async () => {
    const m = mockFetch(() => json({ nope: 1 }));
    await expect(new ElevenLabsProvider(speechCfg(), m.fetch).transcribe({ audio, mime: "audio/wav", language: "en" })).rejects.toMatchObject({ code: "provider_bad_response" });
  });

  it.each([
    [401, "provider_auth_failed"],
    [422, "provider_rejected_input"],
    [429, "provider_rate_limited"],
    [500, "provider_error"],
  ])("maps HTTP %i to %s and never leaks the key or provider body", async (status, code) => {
    const m = mockFetch(() => new Response(`{"detail":"bad key ${KEY} for user text secret-words"}`, { status }));
    const err = await new ElevenLabsProvider(speechCfg(), m.fetch).transcribe({ audio, mime: "audio/wav", language: "en" }).catch((e) => e);
    expect(err.code).toBe(code);
    expect(JSON.stringify({ m: err.message, d: err.details, s: String(err.stack) })).not.toContain(KEY);
    expect(err.message).not.toContain("secret-words");
  });

  it("network failure is a provider error without the key", async () => {
    const m = mockFetch(() => {
      throw new TypeError(`fetch failed for key ${KEY}`);
    });
    const err = await new ElevenLabsProvider(speechCfg(), m.fetch).transcribe({ audio, mime: "audio/wav", language: "en" }).catch((e) => e);
    expect(err.code).toBe("provider_error");
    expect(JSON.stringify([err.message, err.details])).not.toContain(KEY);
  });

  it("redact scrubs the key and header-like strings", () => {
    expect(redact(`oops ${KEY} xi-api-key: abc123`, KEY)).not.toMatch(/sk_test|abc123/);
  });
});

describe("ElevenLabs TTS adapter", () => {
  it("builds the documented JSON request and returns audio with characters counted", async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
    const m = mockFetch(() => new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "tts_1" } }));
    const p = new ElevenLabsProvider(speechCfg(), m.fetch);
    const r = await p.synthesize({ text: "இரண்டு ஏக்கர்", language: "ta", voiceId: "VoiceId12345" });
    const c = m.calls[0]!;
    expect(c.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/VoiceId12345?output_format=mp3_22050_32");
    expect((c.init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(c.init.body as string)).toEqual({ text: "இரண்டு ஏக்கர்", model_id: "eleven_flash_v2_5", language_code: "ta" });
    expect(r).toMatchObject({ contentType: "audio/mpeg", characters: [..."இரண்டு ஏக்கர்"].length, requestId: "tts_1", model: "eleven_flash_v2_5" });
    expect(r.audio).toEqual(bytes);
  });

  it("omits language_code for multilingual_v2 (documented as unsupported) and encodes the voice id", () => {
    const p = new ElevenLabsProvider(speechCfg({ ttsModel: "eleven_multilingual_v2" }), mockFetch(() => json({})).fetch);
    const { url, body } = p.buildTtsRequest({ text: "x", language: "hi", voiceId: "a/b?c" });
    expect(body).not.toHaveProperty("language_code");
    expect(url).toContain("/v1/text-to-speech/a%2Fb%3Fc?");
  });

  it("empty audio is an error", async () => {
    const m = mockFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    await expect(new ElevenLabsProvider(speechCfg(), m.fetch).synthesize({ text: "x", language: "en", voiceId: "VoiceId12345" })).rejects.toMatchObject({ code: "provider_bad_response" });
  });
});

describe("fixture provider and provider selection", () => {
  it("returns labelled synthetic transcripts only for known fixture clips", async () => {
    const p = new FixtureProvider();
    for (const c of FIXTURE_CLIPS) {
      const r = await p.transcribe({ audio: c.audio, mime: "audio/wav", language: c.language });
      expect(r).toMatchObject({ synthetic: true, providerName: "fixture", transcript: c.transcript });
    }
    await expect(p.transcribe({ audio: new Uint8Array(makeWav(0.25, { freq: 999 })), mime: "audio/wav", language: "en" })).rejects.toMatchObject({ code: "provider_unavailable", statusCode: 424 });
    await expect(p.synthesize({ text: "x", language: "en", voiceId: "v" })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("without a key, or outside live mode, no network is ever attempted", async () => {
    const m = mockFetch(() => json(fx("stt-response-en.json")));
    const noKey = createSpeechProvider(testConfig({ RUNTIME_MODE: "live" }), speechCfg({ apiKey: undefined }), m.fetch);
    const synthetic = createSpeechProvider(testConfig({ RUNTIME_MODE: "synthetic" }), speechCfg(), m.fetch);
    for (const p of [noKey, synthetic]) {
      expect(p.live).toBe(false);
      await expect(p.transcribe({ audio, mime: "audio/wav", language: "en" })).rejects.toMatchObject({ code: "provider_unavailable" });
      await expect(p.synthesize({ text: "x", language: "en", voiceId: "v" })).rejects.toMatchObject({ code: "provider_unavailable" });
    }
    expect(m.calls).toHaveLength(0);
    expect(createSpeechProvider(testConfig({ RUNTIME_MODE: "live" }), speechCfg(), m.fetch).name).toBe("elevenlabs");
  });
});

describe("markdown stripping", () => {
  it("removes markup, keeps words and numbers", () => {
    const out = stripMarkdown("## Plan\n- **Sow** 2 acres of [ginger](http://x.y)\n- `water` weekly\n\n```js\ncode()\n```\n> note _here_");
    expect(out).not.toMatch(/[#*`>_\[\]]|http|code\(\)/);
    expect(out).toContain("Sow 2 acres of ginger");
    expect(out).toContain("water weekly");
  });
});
