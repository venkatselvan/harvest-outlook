// SYNTHETIC test-fixture builder. Output mimics the documented SAM grammar; it is NOT a recording of a live response.
import { encodeBase85, type Base85Variant } from "../../../src/vision/sam/base85";

export function rectBits(W: number, H: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const b = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) b[y * W + x] = 1;
  return b;
}

export function packOneBit(bits: Uint8Array, W: number, H: number, o: { rowPadded?: boolean; lsb?: boolean } = {}): Uint8Array {
  const put = (arr: Uint8Array, i: number, v: number) => {
    if (v) arr[i >> 3]! |= o.lsb ? 1 << (i & 7) : 1 << (7 - (i & 7));
  };
  if (!o.rowPadded) {
    const out = new Uint8Array(Math.ceil((W * H) / 8));
    for (let p = 0; p < W * H; p++) put(out, p, bits[p]!);
    return out;
  }
  const rb = Math.ceil(W / 8);
  const out = new Uint8Array(rb * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bits[y * W + x]) out[y * rb + (x >> 3)]! |= o.lsb ? 1 << (x & 7) : 1 << (7 - (x & 7));
  return out;
}

export interface FixtureObject {
  id: number;
  box: { x1: number; y1: number; x2: number; y2: number; c?: number };
  mask?: { bits: Uint8Array; W: number; H: number; c?: number; variant: Base85Variant; enc?: "!" | "~"; rowPadded?: boolean };
}

export function record(o: FixtureObject, w: number, h: number): string {
  const b = o.box;
  let s = `${o.id}<|box;x1=${b.x1};y1=${b.y1};x2=${b.x2};y2=${b.y2};w=${w};h=${h}${b.c !== undefined ? `;c=${b.c}` : ""}|>`;
  if (o.mask) {
    const m = o.mask;
    const bytes = m.enc === "~" ? m.bits : packOneBit(m.bits, m.W, m.H, m.rowPadded ? { rowPadded: true } : {});
    s += `<|mask;x=0;y=0${m.c !== undefined ? `;c=${m.c}` : ""};data=${m.H},${m.W},${m.enc ?? "!"}${encodeBase85(bytes, m.variant)}|>`;
  }
  return s;
}

export const frame = (n: number, recs: string[]) => `<${n}f>\n${recs.join(",")}`;
