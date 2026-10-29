import { describe, expect, it } from "vitest";
import { makeWav, parseDurationSeconds, sniffAudio, validateAudio } from "../src/speech/audio";
import { ApiError } from "../src/services/errors";
import { makeMp3, makeMp4, makeOgg, makeWebm, PNG } from "./speech-helpers";

const limits = { maxBytes: 1024 * 1024, maxSeconds: 60 };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).code;
  }
  return null;
};

describe("audio magic bytes", () => {
  it.each([
    ["webm", makeWebm(1)],
    ["ogg", makeOgg(1)],
    ["wav", makeWav(0.5)],
    ["mp4", makeMp4(1)],
    ["m4a", makeMp4(1, "M4A ")],
    ["mp3", makeMp3()],
  ] as const)("accepts %s", (fmt, buf) => {
    expect(sniffAudio(buf)).toBe(fmt);
    expect(validateAudio(buf, limits).format).toBe(fmt);
  });

  it("rejects an image, text and short buffers regardless of declared type", () => {
    expect(code(() => validateAudio(PNG, limits))).toBe("unsupported_media_type");
    expect(code(() => validateAudio(Buffer.from("this is plain text, not audio"), limits))).toBe("unsupported_media_type");
    expect(code(() => validateAudio(Buffer.alloc(0), limits))).toBe("audio_required");
    expect(sniffAudio(Buffer.from([0x1a, 0x45]))).toBeNull();
  });

  it("enforces the byte cap before sniffing", () => {
    expect(code(() => validateAudio(makeWav(2), { maxBytes: 1000, maxSeconds: 60 }))).toBe("payload_too_large");
  });
});

describe("duration parsing from generated headers", () => {
  it("wav", () => expect(parseDurationSeconds(makeWav(2.5), "wav")).toBeCloseTo(2.5, 3));
  it("wav with streamed/zero data size falls back to bytes present", () => {
    const w = makeWav(1);
    w.writeUInt32LE(0, 40);
    expect(parseDurationSeconds(w, "wav")).toBeCloseTo(1, 3);
  });
  it("webm with Duration under an unknown-size Segment", () => expect(parseDurationSeconds(makeWebm(12.5), "webm")).toBeCloseTo(12.5, 3));
  it("webm without Duration (live MediaRecorder) is unknown, not zero", () => expect(parseDurationSeconds(makeWebm(null), "webm")).toBeNull());
  it("ogg opus from the last granule position", () => expect(parseDurationSeconds(makeOgg(7), "ogg")).toBeCloseTo(7, 3));
  it("mp4 mvhd; fragmented mp4 (duration 0) is unknown", () => {
    expect(parseDurationSeconds(makeMp4(9.5), "mp4")).toBeCloseTo(9.5, 3);
    expect(parseDurationSeconds(makeMp4(null), "mp4")).toBeNull();
  });
  it("mp3 is not parsed", () => expect(parseDurationSeconds(makeMp3(), "mp3")).toBeNull());
  it("truncated or garbage containers never throw", () => {
    const w = makeWebm(3).subarray(0, 20);
    expect(parseDurationSeconds(w, "webm")).toBeNull();
    expect(parseDurationSeconds(Buffer.alloc(30, 0xff), "mp4")).toBeNull();
  });
});

describe("duration limits", () => {
  it("rejects over-long audio where the header states it, allows the cap and a small tolerance", () => {
    expect(code(() => validateAudio(makeWav(61.5, { sampleRate: 1000 }), limits))).toBe("audio_too_long");
    expect(code(() => validateAudio(makeWebm(75), limits))).toBe("audio_too_long");
    expect(validateAudio(makeWav(60, { sampleRate: 1000 }), limits).durationSeconds).toBeCloseTo(60, 2);
  });
  it("rejects clips under 100 ms", () => {
    expect(code(() => validateAudio(makeWav(0.05), limits))).toBe("audio_too_short");
  });
  it("accepts unknown-duration containers (byte cap + client timer apply)", () => {
    expect(validateAudio(makeWebm(null), limits).durationSeconds).toBeNull();
  });
});
