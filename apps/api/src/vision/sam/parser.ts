import { Base85Error, decodeBase85, resolveVariant } from "./base85";
import type { SamOptions } from "./options";

export class SamParseError extends Error {
  constructor(
    public readonly code: "mask_encoding_unsupported" | "mask_length_mismatch" | "mask_payload_invalid" | "mask_geometry_unsupported",
    message: string,
  ) {
    super(message);
  }
}

export interface RawMask {
  x: number;
  y: number;
  confidence: number | null;
  height: number;
  width: number;
  /** '!' one-bit, '~' lossless. */
  encoding: string;
  payload: string;
}

export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  confidence: number | null;
}

export interface SamObject {
  id: string;
  box: SamBox | null;
  mask: RawMask | null;
}

export interface SamFrame {
  index: number;
  objects: SamObject[];
}

export interface ParsedSamOutput {
  frames: SamFrame[];
  warnings: string[];
}

const FRAME_RE = /<(\d+)f>/g;
const MASK_END = /\|>(?=\s*(?:,\s*-?\d+<\||$))/;

function attrs(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of body.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

function num(a: Map<string, string>, k: string): number | null {
  const v = a.get(k);
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function conf(a: Map<string, string>): number | null {
  const c = num(a, "c");
  return c !== null && c >= 0 && c <= 1 ? c : null;
}

function parseRecords(seg: string, warnings: string[]): SamObject[] {
  const out: SamObject[] = [];
  let pos = 0;
  const len = seg.length;
  const skipSep = () => {
    while (pos < len && /[\s,]/.test(seg[pos]!)) pos++;
  };
  skipSep();
  while (pos < len) {
    const idm = /^-?\d+/.exec(seg.slice(pos, pos + 24));
    if (!idm || seg.slice(pos + idm[0].length, pos + idm[0].length + 2) !== "<|") {
      warnings.push("unparseable_text_skipped");
      break;
    }
    const obj: SamObject = { id: idm[0], box: null, mask: null };
    pos += idm[0].length;
    // One or more <|tag;...|> blocks directly following the id.
    while (seg.startsWith("<|", pos)) {
      const tagEnd = seg.slice(pos + 2).search(/[;|]/);
      if (tagEnd < 0) {
        pos = len;
        break;
      }
      const tag = seg.slice(pos + 2, pos + 2 + tagEnd);
      const bodyStart = pos + 2;
      let end: number;
      if (tag === "mask") {
        const rest = seg.slice(bodyStart);
        const m = MASK_END.exec(rest);
        end = m ? bodyStart + m.index : len;
      } else {
        const e = seg.indexOf("|>", bodyStart);
        end = e < 0 ? len : e;
      }
      const body = seg.slice(bodyStart, end);
      pos = Math.min(len, end + 2);
      if (tag === "box") {
        const a = attrs(body);
        const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((k) => num(a, k));
        if ([x1, y1, x2, y2, w, h].some((v) => v === null)) warnings.push("box_incomplete");
        else obj.box = { x1: x1!, y1: y1!, x2: x2!, y2: y2!, w: w!, h: h!, confidence: conf(a) };
      } else if (tag === "mask") {
        const di = body.indexOf("data=");
        if (di < 0) {
          warnings.push("mask_without_data");
          continue;
        }
        const a = attrs(body.slice(0, di));
        const dm = /^(\d+),(\d+),([~!])([\s\S]*)$/.exec(body.slice(di + 5));
        if (!dm) {
          warnings.push("mask_data_header_invalid");
          continue;
        }
        obj.mask = { x: num(a, "x") ?? 0, y: num(a, "y") ?? 0, confidence: conf(a), height: Number(dm[1]), width: Number(dm[2]), encoding: dm[3]!, payload: dm[4]!.trim() };
      } else {
        warnings.push(`unsupported_tag_${tag.slice(0, 12)}`);
      }
    }
    out.push(obj);
    skipSep();
  }
  return out;
}

/**
 * Tokenises SAM output text: `<Nf>` frame markers followed by comma-separated records
 * `id<|box;...|><|mask;x=0;y=0[;c=];data=H,W,<enc><payload>|>`. Empty output, or a frame with no records, is
 * zero matches (valid). Text before the first marker is treated as frame 0.
 */
export function parseSamOutput(text: string): ParsedSamOutput {
  const warnings: string[] = [];
  const markers = [...text.matchAll(FRAME_RE)];
  const frames: SamFrame[] = [];
  if (markers.length === 0) {
    const objs = parseRecords(text.trim(), warnings);
    if (objs.length) frames.push({ index: 0, objects: objs });
    return { frames, warnings };
  }
  if (text.slice(0, markers[0]!.index).trim()) warnings.push("text_before_first_frame_ignored");
  markers.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1]!.index! : text.length;
    frames.push({ index: Number(m[1]), objects: parseRecords(text.slice(start, end).trim(), warnings) });
  });
  return { frames, warnings };
}

export interface MaskRaster {
  width: number;
  height: number;
  /** One byte per pixel, 1 = foreground, row-major. */
  bits: Uint8Array;
}

/**
 * Decodes the mask payload to a binary raster.
 * - '!' one-bit: base85 -> bytes -> bits, row-major. Both a flat bit stream (ceil(H*W/8) bytes) and per-row padded
 *   rows (H*ceil(W/8) bytes) are recognised by decoded length; MSB-first unless options.bitOrder is 'lsb'.
 * - '~' lossless: treated as one byte per pixel after base85 (foreground >= 128). A PNG-looking payload is rejected
 *   as unsupported. UNVERIFIED against live output; request onebit.
 */
export function decodeMask(mask: RawMask, options: Pick<SamOptions, "base85Variant" | "base85Fallback" | "bitOrder">): MaskRaster {
  const { width: W, height: H } = mask;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W * H > 16_000_000) throw new SamParseError("mask_payload_invalid", "mask dimensions invalid");
  let bytes: Uint8Array;
  try {
    bytes = decodeBase85(mask.payload, resolveVariant(mask.payload, options.base85Variant, options.base85Fallback));
  } catch (e) {
    if (e instanceof Base85Error) throw new SamParseError("mask_payload_invalid", e.message);
    throw e;
  }
  const bits = new Uint8Array(W * H);
  if (mask.encoding === "!") {
    const flat = Math.ceil((W * H) / 8);
    const rowBytes = Math.ceil(W / 8);
    const padded = H * rowBytes;
    const bit = (b: number, i: number) => (options.bitOrder === "msb" ? (b >> (7 - i)) & 1 : (b >> i) & 1);
    if (bytes.length === flat) {
      for (let p = 0; p < W * H; p++) bits[p] = bit(bytes[p >> 3]!, p & 7);
    } else if (bytes.length === padded) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bits[y * W + x] = bit(bytes[y * rowBytes + (x >> 3)]!, x & 7);
    } else {
      throw new SamParseError("mask_length_mismatch", `one-bit mask decoded to ${bytes.length} bytes; expected ${flat} (flat) or ${padded} (row padded)`);
    }
    return { width: W, height: H, bits };
  }
  if (mask.encoding === "~") {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      throw new SamParseError("mask_encoding_unsupported", "lossless mask is a PNG container; request mask_encoding=onebit");
    }
    if (bytes.length !== W * H) throw new SamParseError("mask_length_mismatch", `lossless mask decoded to ${bytes.length} bytes; expected ${W * H}`);
    for (let p = 0; p < bits.length; p++) bits[p] = bytes[p]! >= 128 ? 1 : 0;
    return { width: W, height: H, bits };
  }
  throw new SamParseError("mask_encoding_unsupported", "unknown mask encoding");
}
