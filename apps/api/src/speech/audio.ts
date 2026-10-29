import { ApiError } from "../services/errors";

export type AudioFormat = "webm" | "ogg" | "wav" | "mp4" | "m4a" | "mp3";

export const AUDIO_MIME: Record<AudioFormat, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

/** The provider rejects clips under 100 ms; so do we, when the container tells us the duration. */
export const MIN_AUDIO_SECONDS = 0.1;

/** Identifies the container by magic bytes only; the client-declared type and filename are ignored. */
export function sniffAudio(b: Uint8Array): AudioFormat | null {
  if (b.length < 12) return null;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm"; // EBML (webm; also mkv)
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(4, 4) === "ftyp") return ascii(8, 4) === "M4A " ? "m4a" : "mp4";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return "mp3"; // MPEG audio frame sync
  return null;
}

// ---------------------------------------------------------------- duration parsing (headers only)

function wavDuration(b: Buffer): number | null {
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt " && off + 8 + 12 <= b.length) byteRate = b.readUInt32LE(off + 16);
    if (id === "data") {
      if (!byteRate) return null;
      // Streamed WAVs carry 0 or 0xFFFFFFFF; fall back to the bytes actually present.
      const bytes = size === 0 || size === 0xffffffff || off + 8 + size > b.length ? b.length - (off + 8) : size;
      return bytes / byteRate;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Reads an EBML variable-length id (marker bit kept) or size (marker removed). */
function ebmlVint(b: Buffer, off: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  if (off >= b.length) return null;
  const first = b[off]!;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[off + i]!;
    if (b[off + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

function webmDuration(b: Buffer): number | null {
  // Walk top-level elements to Segment, then to Info. Live MediaRecorder output usually has no Duration: null.
  const scan = (start: number, end: number, target: number, descend: number[]): { start: number; end: number } | null => {
    let o = start;
    while (o < end) {
      const id = ebmlVint(b, o, true);
      if (!id) return null;
      const sz = ebmlVint(b, o + id.len, false);
      if (!sz) return null;
      const dataStart = o + id.len + sz.len;
      const dataEnd = sz.unknown ? end : Math.min(end, dataStart + sz.value);
      if (id.value === target) return { start: dataStart, end: dataEnd };
      if (descend.includes(id.value)) {
        const inner = scan(dataStart, dataEnd, target, descend);
        if (inner) return inner;
      }
      if (sz.unknown) return null;
      o = dataEnd;
    }
    return null;
  };
  const info = scan(0, b.length, ID_INFO, [ID_SEGMENT]);
  if (!info) return null;
  let scale = 1_000_000;
  let duration: number | null = null;
  let o = info.start;
  while (o < info.end) {
    const id = ebmlVint(b, o, true);
    const sz = id && ebmlVint(b, o + id.len, false);
    if (!id || !sz || sz.unknown) break;
    const ds = o + id.len + sz.len;
    if (ds + sz.value > info.end) break;
    if (id.value === ID_TIMECODE_SCALE && sz.value >= 1 && sz.value <= 6) {
      let v = 0;
      for (let i = 0; i < sz.value; i++) v = v * 256 + b[ds + i]!;
      scale = v;
    } else if (id.value === ID_DURATION) {
      if (sz.value === 4) duration = b.readFloatBE(ds);
      else if (sz.value === 8) duration = b.readDoubleBE(ds);
    }
    o = ds + sz.value;
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  return (duration * scale) / 1e9;
}

function oggDuration(b: Buffer): number | null {
  const head = b.indexOf("OpusHead");
  let rate: number | null = null;
  if (head >= 0 && head < 200) rate = 48000;
  else {
    const v = b.indexOf("\x01vorbis", 0, "latin1");
    if (v >= 0 && v < 200 && v + 16 <= b.length) rate = b.readUInt32LE(v + 12);
  }
  if (!rate) return null;
  const idx = b.lastIndexOf("OggS");
  if (idx < 0 || idx + 14 > b.length) return null;
  const granule = b.readBigUInt64LE(idx + 6);
  if (granule <= 0n || granule === 0xffffffffffffffffn) return null;
  return Number(granule) / rate;
}

function mp4Duration(b: Buffer): number | null {
  const findBox = (start: number, end: number, type: string): { start: number; end: number } | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = b.readUInt32BE(o);
      const t = b.toString("latin1", o + 4, o + 8);
      let hdr = 8;
      if (size === 1) {
        if (o + 16 > end) return null;
        size = Number(b.readBigUInt64BE(o + 8));
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr) return null;
      if (t === type) return { start: o + hdr, end: Math.min(end, o + size) };
      o += size;
    }
    return null;
  };
  const moov = findBox(0, b.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov.start, moov.end, "mvhd");
  if (!mvhd) return null;
  const v = b[mvhd.start];
  let timescale: number;
  let duration: number;
  if (v === 1) {
    if (mvhd.start + 32 > b.length) return null;
    timescale = b.readUInt32BE(mvhd.start + 20);
    duration = Number(b.readBigUInt64BE(mvhd.start + 24));
  } else {
    if (mvhd.start + 20 > b.length) return null;
    timescale = b.readUInt32BE(mvhd.start + 12);
    duration = b.readUInt32BE(mvhd.start + 16);
  }
  // Fragmented MP4 (MediaRecorder on Safari) reports 0 here: unknown, not "empty".
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return duration / timescale;
}

/**
 * Duration in seconds when the container header states it; null when it cannot be determined
 * (live-recorded webm/fragmented mp4 usually omit it; mp3 is not parsed). Callers must then rely on
 * the byte cap and the client-side timer.
 */
export function parseDurationSeconds(buf: Uint8Array, format: AudioFormat): number | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    switch (format) {
      case "wav":
        return wavDuration(b);
      case "webm":
        return webmDuration(b);
      case "ogg":
        return oggDuration(b);
      case "mp4":
      case "m4a":
        return mp4Duration(b);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface AudioCheck {
  format: AudioFormat;
  mime: string;
  bytes: number;
  /** null when the container does not state a duration (see parseDurationSeconds). */
  durationSeconds: number | null;
}

export function validateAudio(buf: Uint8Array, limits: { maxBytes: number; maxSeconds: number }): AudioCheck {
  if (buf.length === 0) throw new ApiError(400, "audio_required", "Uploaded audio is empty");
  if (buf.length > limits.maxBytes) throw new ApiError(413, "payload_too_large", `Audio exceeds ${limits.maxBytes} bytes`);
  const format = sniffAudio(buf);
  if (!format) throw new ApiError(415, "unsupported_media_type", "Unsupported audio format (accepted: webm, ogg, wav, mp4/m4a, mp3)");
  const durationSeconds = parseDurationSeconds(buf, format);
  if (durationSeconds !== null) {
    if (durationSeconds > limits.maxSeconds + 0.5) {
      throw new ApiError(413, "audio_too_long", `Audio is longer than ${limits.maxSeconds} seconds`, { maxSeconds: limits.maxSeconds });
    }
    if (durationSeconds < MIN_AUDIO_SECONDS) throw new ApiError(422, "audio_too_short", "Audio is too short to transcribe");
  }
  return { format, mime: AUDIO_MIME[format], bytes: buf.length, durationSeconds };
}

// ---------------------------------------------------------------- generators (fixtures and tests)

/** Minimal 16-bit mono PCM WAV with a quiet sine tone; deterministic for hashing. */
export function makeWav(seconds: number, opts: { sampleRate?: number; freq?: number } = {}): Buffer {
  const rate = opts.sampleRate ?? 8000;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (opts.freq ?? 440) * i) / rate) * 2000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
