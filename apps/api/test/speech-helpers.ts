import type { SpeechConfig } from "../src/speech/config";

export const KEY = "sk_test_0123456789abcdef0123456789abcdef";

export const speechCfg = (over: Partial<SpeechConfig> = {}): SpeechConfig => ({
  apiKey: KEY,
  baseUrl: "https://api.elevenlabs.io",
  sttModel: "scribe_v2",
  ttsModel: "eleven_flash_v2_5",
  voiceId: "VoiceId12345",
  ttsOutputFormat: "mp3_22050_32",
  maxSeconds: 60,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 5000,
  ...over,
});

export interface Call {
  url: string;
  init: RequestInit;
}

export function mockFetch(handler: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// ---- container generators (headers only; payload is filler) ----
const ebml = (id: number[], payload: Buffer) => {
  const len = payload.length;
  const size = len < 127 ? Buffer.from([0x80 | len]) : Buffer.from([0x40 | (len >> 8), len & 0xff]);
  return Buffer.concat([Buffer.from(id), size, payload]);
};

/** webm with an Info element stating Duration (ms timecode scale), or none. */
export function makeWebm(seconds: number | null): Buffer {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])); // DocType webm
  const infoParts: Buffer[] = [ebml([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))]; // 1,000,000 ns
  if (seconds !== null) {
    const d = Buffer.alloc(8);
    d.writeDoubleBE(seconds * 1000);
    infoParts.push(ebml([0x44, 0x89], d));
  }
  const info = ebml([0x15, 0x49, 0xa9, 0x66], Buffer.concat(infoParts));
  const segPayload = Buffer.concat([info, Buffer.alloc(40, 1)]);
  // Segment with unknown size (live recording style).
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), segPayload]);
  return Buffer.concat([header, segment]);
}

export function makeOgg(seconds: number): Buffer {
  const page = (granule: bigint, payload: Buffer, seq: number) => {
    const h = Buffer.alloc(27 + 1);
    h.write("OggS", 0, "ascii");
    h.writeBigUInt64LE(granule, 6);
    h.writeUInt32LE(seq, 18);
    h[26] = 1;
    h[27] = payload.length;
    return Buffer.concat([h, payload]);
  };
  const head = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11, 0)]);
  return Buffer.concat([page(0n, head, 0), page(BigInt(Math.round(seconds * 48000)), Buffer.alloc(30, 2), 1)]);
}

export function makeMp4(seconds: number | null, brand = "isom"): Buffer {
  const box = (type: string, payload: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, "ascii");
    return Buffer.concat([h, payload]);
  };
  const ftyp = box("ftyp", Buffer.concat([Buffer.from(brand), Buffer.alloc(4), Buffer.from(brand)]));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(seconds === null ? 0 : Math.round(seconds * 1000), 16);
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd)), box("mdat", Buffer.alloc(16))]);
}

export const makeMp3 = () => Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32, 0)]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
