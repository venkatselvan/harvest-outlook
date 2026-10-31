import { describe, expect, it } from "vitest";
import { encodeMonoPcm16 } from "./wav";

describe("Meta transcription WAV encoding", () => {
  it("writes mono PCM16 little-endian headers and exact clipped sample values", () => {
    const bytes = encodeMonoPcm16(
      new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]),
    );
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(16);
    expect(
      Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true)),
    ).toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  });
  it("accepts the other supported rate and rejects empty or invalid formats", () => {
    expect(
      new DataView(encodeMonoPcm16(new Float32Array([0]), 24000)).getUint32(
        24,
        true,
      ),
    ).toBe(24000);
    expect(() => encodeMonoPcm16(new Float32Array())).toThrow("empty");
    expect(() => encodeMonoPcm16(new Float32Array([0]), 48000)).toThrow(
      "sample rate",
    );
  });
});
