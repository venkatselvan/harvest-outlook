import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { makeWav } from "../src/speech/audio";
import { approvedTextHash, recordApprovedText } from "../src/speech/approved";
import { ElevenLabsProvider } from "../src/speech/elevenlabs";
import { FIXTURE_CLIPS, FixtureProvider } from "../src/speech/fixture";
import { farmBody, login, multipart, setupHarness, type Client, type Harness } from "./helpers";
import { json, KEY, mockFetch, PNG, speechCfg, type Call } from "./speech-helpers";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/elevenlabs/${n}`, import.meta.url), "utf8"));
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 9, 9, 9, 9]);

let h: Harness;
let live: FastifyInstance;
let fixtureApp: FastifyInstance;
let liveCalls: Call[];
let sttBody: unknown = fx("stt-response-en.json");
let ttsStatus = 200;

const stt = (c: Client, audio: Buffer, fields: Record<string, string> = { language: "en" }, o: { type?: string } = {}) => {
  const m = multipart({ data: audio, filename: "a.webm", type: o.type ?? "audio/wav" }, fields);
  // multipart() names the file part "file"; the speech route expects "audio".
  const payload = Buffer.from(m.payload.toString("latin1").replace('name="file"', 'name="audio"'), "latin1");
  return c.call("POST", "/api/v1/speech/transcriptions", { payload, headers: m.headers });
};
const tts = (c: Client, body: unknown) => c.call("POST", "/api/v1/speech/synthesis", { payload: body, headers: { "content-type": "application/json" } });
const ledger = async () => (await h.pool.query("SELECT usage FROM usage_ledger WHERE provider='elevenlabs'")).rows;

beforeAll(async () => {
  h = await setupHarness();
  const m = mockFetch((c) => (c.url.includes("speech-to-text") ? json(sttBody, 200, { "request-id": "stt_req" }) : new Response(ttsStatus === 200 ? MP3 : "x", { status: ttsStatus, headers: { "request-id": "tts_req" } })));
  liveCalls = m.calls;
  live = await buildServer(h.config, h.pool, { storage: h.storage, speech: { config: { ...h.config, RUNTIME_MODE: "live" }, speech: speechCfg(), provider: new ElevenLabsProvider(speechCfg(), m.fetch) } });
  fixtureApp = await buildServer(h.config, h.pool, { storage: h.storage, speech: { config: h.config, speech: speechCfg({ apiKey: undefined }), provider: new FixtureProvider() } });
});
afterAll(async () => {
  await live.close();
  await fixtureApp.close();
  await h.close();
});

describe("POST /speech/transcriptions", () => {
  it("requires a session and CSRF", async () => {
    const c = await login(live);
    const m = multipart({ data: makeWav(1) });
    expect((await c.call("POST", "/api/v1/speech/transcriptions", { ...m, cookie: null })).statusCode).toBe(401);
    expect((await c.call("POST", "/api/v1/speech/transcriptions", { ...m, csrf: null })).statusCode).toBe(403);
  });

  it("transcribes, returns the documented fields, omits words, stores nothing and logs usage seconds", async () => {
    const c = await login(live);
    liveCalls.length = 0;
    sttBody = fx("stt-response-en.json");
    const res = await stt(c, makeWav(2.5));
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({
      transcript: "I planted ginger on 2 acres in April",
      detectedLanguage: "en",
      languageProbability: 0.98,
      languageMismatch: false,
      provider: { name: "elevenlabs", model: "scribe_v2", requestId: "stt_req" },
      usageSeconds: 2.5,
      synthetic: false,
    });
    expect(d).not.toHaveProperty("words");
    expect(liveCalls).toHaveLength(1);
    const rows = (await h.pool.query("SELECT * FROM usage_ledger WHERE provider='elevenlabs' AND usage->>'kind'='stt'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].settled_usd).toBeNull();
    expect(rows[0].usage).toMatchObject({ units: "seconds", amount: 2.5, usd: null, language: "en" });
    expect(JSON.stringify(rows)).not.toContain("planted ginger");
    // No table holds audio or transcript text.
    const stored = await h.pool.query("SELECT count(*)::int AS n FROM media_objects");
    expect(stored.rows[0].n).toBe(0);
    // Meta USD budget untouched.
    expect((await h.pool.query("SELECT count(*)::int AS n FROM usage_reservations")).rows[0].n).toBe(0);
  });

  it("includeWords=true returns words; language mismatch flagged", async () => {
    const c = await login(live);
    sttBody = fx("stt-response-hi-mismatch.json");
    const m = multipart({ data: makeWav(1) }, { language: "hi" });
    const payload = Buffer.from(m.payload.toString("latin1").replace('name="file"', 'name="audio"'), "latin1");
    const res = await c.call("POST", "/api/v1/speech/transcriptions?includeWords=true", { payload, headers: m.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ detectedLanguage: "en", languageMismatch: true });
    expect(res.json().data.words).toHaveLength(1);
  });

  it("rejects non-audio, oversize, over-long, bad language and missing parts before calling the provider", async () => {
    const c = await login(live);
    liveCalls.length = 0;
    expect((await stt(c, PNG)).statusCode).toBe(415);
    expect((await stt(c, Buffer.from("plain text, definitely not audio"))).statusCode).toBe(415);
    expect((await stt(c, makeWav(61.5, { sampleRate: 1000 }))).json().error.code).toBe("audio_too_long");
    expect((await stt(c, makeWav(1), { language: "fr" })).statusCode).toBe(400);
    expect((await stt(c, makeWav(1), {})).statusCode).toBe(400);
    const small = await buildServer(h.config, h.pool, { storage: h.storage, speech: { config: h.config, speech: speechCfg({ maxBytes: 2000 }), provider: new FixtureProvider() } });
    const c2 = await login(small);
    expect((await stt(c2, makeWav(1))).statusCode).toBe(413);
    await small.close();
    expect(liveCalls).toHaveLength(0);
  });

  it("farmId must belong to the caller", async () => {
    const a = await login(live);
    const b = await login(live);
    const farm = await a.call("POST", "/api/v1/farms", { payload: farmBody(), headers: { "content-type": "application/json" } });
    expect(farm.statusCode).toBe(201);
    {
      const id = farm.json().data.id;
      expect((await stt(b, makeWav(1), { language: "en", farmId: id })).statusCode).toBe(404);
      expect((await stt(a, makeWav(1), { language: "en", farmId: id })).statusCode).toBe(200);
    }
    expect((await stt(a, makeWav(1), { language: "en", farmId: "nope" })).statusCode).toBe(400);
  });

  it("provider failures surface as 424 provider errors, not internal_error", async () => {
    const m = mockFetch(() => new Response("{}", { status: 500 }));
    const bad = await buildServer(h.config, h.pool, { storage: h.storage, speech: { config: h.config, speech: speechCfg(), provider: new ElevenLabsProvider(speechCfg(), m.fetch) } });
    const cb = await login(bad);
    const res = await stt(cb, makeWav(1));
    expect(res.statusCode).toBe(424);
    expect(res.json().error.code).toBe("provider_error");
    expect(JSON.stringify(res.json())).not.toContain(KEY);
    await bad.close();
  });

  it("fixture mode: labelled synthetic transcript for a fixture clip, provider_unavailable otherwise, no ledger row", async () => {
    const c = await login(fixtureApp);
    const before = (await ledger()).length;
    const ok = await stt(c, FIXTURE_CLIPS[1]!.audio, { language: "ta" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ synthetic: true, provider: { name: "fixture" }, detectedLanguage: "ta" });
    expect(ok.json().warnings.map((w: { message: string }) => w.message).join(" ")).toMatch(/Synthetic fixture/);
    const other = await stt(c, makeWav(0.7, { freq: 1234 }));
    expect(other.statusCode).toBe(424);
    expect(other.json().error.code).toBe("provider_unavailable");
    expect((await ledger()).length).toBe(before);
  });

  it("status route reports availability honestly", async () => {
    const f = await login(fixtureApp);
    expect((await f.call("GET", "/api/v1/speech/status")).json().data).toMatchObject({ available: false, provider: "fixture", qualified: false });
    const l = await login(live);
    expect((await l.call("GET", "/api/v1/speech/status")).json().data).toMatchObject({ available: true, provider: "elevenlabs", maxSeconds: 60 });
  });
});

describe("POST /speech/synthesis", () => {
  const TEXT = "## Advice\n**Plant** ginger on 2 acres after the first rains.";

  it("requires an approved hash recorded for this owner; mismatch and unknown text are 403", async () => {
    const c = await login(live);
    const owner = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    liveCalls.length = 0;
    // not recorded yet
    expect((await tts(c, { text: TEXT, language: "en", approvedTextHash: approvedTextHash(TEXT) })).statusCode).toBe(403);
    await recordApprovedText(h.pool, owner, TEXT);
    // recorded but text altered (hash of original)
    const altered = await tts(c, { text: TEXT + " Apply 50 kg urea.", language: "en", approvedTextHash: approvedTextHash(TEXT) });
    expect(altered.statusCode).toBe(403);
    expect(altered.json().error.code).toBe("approved_text_mismatch");
    // altered text with its own hash but never recorded
    const t2 = TEXT + " Apply 50 kg urea.";
    expect((await tts(c, { text: t2, language: "en", approvedTextHash: approvedTextHash(t2) })).statusCode).toBe(403);
    expect(liveCalls).toHaveLength(0);
  });

  it("speaks an approved answer: strips markdown, streams audio, private cache, logs characters", async () => {
    const c = await login(live);
    const owner = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    const hash = await recordApprovedText(h.pool, owner, TEXT);
    liveCalls.length = 0;
    const res = await tts(c, { text: TEXT, language: "en", approvedTextHash: hash });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.rawPayload).toEqual(Buffer.from(MP3));
    expect(liveCalls).toHaveLength(1);
    const sent = JSON.parse(liveCalls[0]!.init.body as string);
    expect(sent.text).not.toMatch(/[#*]/);
    expect(sent.text).toContain("Plant ginger on 2 acres");
    expect(liveCalls[0]!.url).toContain("/v1/text-to-speech/VoiceId12345?output_format=mp3_22050_32");
    const rows = (await h.pool.query("SELECT * FROM usage_ledger WHERE provider='elevenlabs' AND usage->>'kind'='tts'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].settled_usd).toBeNull();
    expect(rows[0].usage).toMatchObject({ units: "characters", amount: sent.text.length, usd: null });
    expect(JSON.stringify(rows)).not.toContain("ginger");
  });

  it("another owner cannot use the hash", async () => {
    const a = await login(live);
    const ownerA = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    const b = await login(live);
    const hash = await recordApprovedText(h.pool, ownerA, "Only A may speak this.");
    liveCalls.length = 0;
    expect((await tts(b, { text: "Only A may speak this.", language: "en", approvedTextHash: hash })).statusCode).toBe(403);
    expect((await tts(a, { text: "Only A may speak this.", language: "en", approvedTextHash: hash })).statusCode).toBe(200);
  });

  it("expired hashes are refused", async () => {
    const c = await login(live);
    const owner = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    const hash = await recordApprovedText(h.pool, owner, "Old answer.");
    await h.pool.query("UPDATE speech_approved_texts SET created_at = now() - interval '3 hours' WHERE hash = $1", [hash]);
    expect((await tts(c, { text: "Old answer.", language: "en", approvedTextHash: hash })).statusCode).toBe(403);
  });

  it("validates input, and without a provider returns provider_unavailable", async () => {
    const c = await login(live);
    expect((await tts(c, { text: "x".repeat(2001), language: "en", approvedTextHash: "a".repeat(64) })).statusCode).toBe(400);
    expect((await tts(c, { text: "hi", language: "en", approvedTextHash: "short" })).statusCode).toBe(400);
    expect((await tts(c, { text: "hi", language: "en", voiceId: "../x", approvedTextHash: "a".repeat(64) })).statusCode).toBe(400);
    const f = await login(fixtureApp);
    const owner = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    const hash = await recordApprovedText(h.pool, owner, "Spoken text.");
    const res = await tts(f, { text: "Spoken text.", language: "en", approvedTextHash: hash });
    expect(res.statusCode).toBe(424);
    expect(res.json().error.code).toBe("provider_unavailable");
  });

  it("a request whose approved text strips to nothing is rejected", async () => {
    const c = await login(live);
    const owner = (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id as string;
    const hash = await recordApprovedText(h.pool, owner, "```\nonly code\n```");
    expect((await tts(c, { text: "```\nonly code\n```", language: "en", approvedTextHash: hash })).statusCode).toBe(400);
  });
});
