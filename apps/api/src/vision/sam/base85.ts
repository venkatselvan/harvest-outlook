/**
 * Base85 decoding for SAM mask payloads.
 *
 * The Meta docs say "base85" without naming the alphabet. Three common variants are implemented and
 * the active one is a flag (SamOptions.base85Variant). UNVERIFIED against a live response: confirm in
 * the live smoke test (docs/PHOTO_REGION.md). 'auto' picks the only variant whose alphabet admits
 * every payload character and falls back to the configured default when several do.
 */

export type Base85Variant = "ascii85" | "z85" | "rfc1924";
export const BASE85_VARIANTS: readonly Base85Variant[] = ["ascii85", "z85", "rfc1924"];

const ALPHABETS: Record<Base85Variant, string> = {
  // Ascii85/btoa: '!' (0x21) .. 'u' (0x75), 'z' = four zero bytes.
  ascii85: Array.from({ length: 85 }, (_, i) => String.fromCharCode(33 + i)).join(""),
  // ZeroMQ Z85.
  z85: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#",
  // RFC 1924 as used by Python base64.b85encode.
  rfc1924: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~",
};

export class Base85Error extends Error {
  readonly code = "base85_invalid";
}

const tables = new Map<Base85Variant, Int16Array>();
function table(v: Base85Variant): Int16Array {
  let t = tables.get(v);
  if (!t) {
    t = new Int16Array(256).fill(-1);
    for (let i = 0; i < 85; i++) t[ALPHABETS[v].charCodeAt(i)] = i;
    tables.set(v, t);
  }
  return t;
}

/** Variants whose alphabet contains every character of the payload (ascii85 also admits 'z'). */
export function compatibleVariants(payload: string): Base85Variant[] {
  return BASE85_VARIANTS.filter((v) => {
    const t = table(v);
    for (let i = 0; i < payload.length; i++) {
      const c = payload.charCodeAt(i);
      if (c > 255 || (t[c] === -1 && !(v === "ascii85" && payload[i] === "z"))) return false;
    }
    return true;
  });
}

export function decodeBase85(payload: string, variant: Base85Variant): Uint8Array {
  let s = payload.trim();
  if (variant === "ascii85") {
    if (s.startsWith("<~")) s = s.slice(2);
    if (s.endsWith("~>")) s = s.slice(0, -2);
  }
  const t = table(variant);
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  const pad = 84;
  const flush = (count: number) => {
    // count = number of digits in this group (2..5); decoded bytes = count - 1.
    let v = acc;
    for (let i = count; i < 5; i++) v = v * 85 + pad;
    if (v > 0xffffffff) throw new Base85Error("base85 group overflows 32 bits");
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let i = 0; i < count - 1; i++) out.push(b[i]!);
    acc = 0;
    n = 0;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (variant === "ascii85" && ch === "z") {
      if (n !== 0) throw new Base85Error("'z' inside an ascii85 group");
      out.push(0, 0, 0, 0);
      continue;
    }
    const d = t[s.charCodeAt(i)] ?? -1;
    if (d < 0) throw new Base85Error(`character not in ${variant} alphabet`);
    acc = acc * 85 + d;
    n++;
    if (n === 5) {
      if (acc > 0xffffffff) throw new Base85Error("base85 group overflows 32 bits");
      out.push((acc >>> 24) & 255, (acc >>> 16) & 255, (acc >>> 8) & 255, acc & 255);
      acc = 0;
      n = 0;
    }
  }
  if (n === 1) throw new Base85Error("dangling single base85 digit");
  if (n > 1) flush(n);
  return Uint8Array.from(out);
}

/** Used by self-tests and fixtures; mirrors Python a85encode (no folding) / b85encode / Z85. */
export function encodeBase85(bytes: Uint8Array, variant: Base85Variant): string {
  const a = ALPHABETS[variant];
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const len = Math.min(4, bytes.length - i);
    let v = 0;
    for (let j = 0; j < 4; j++) v = v * 256 + (j < len ? bytes[i + j]! : 0);
    if (variant === "ascii85" && len === 4 && v === 0) {
      out += "z";
      continue;
    }
    const d: string[] = [];
    for (let j = 0; j < 5; j++) {
      d.unshift(a[v % 85]!);
      v = Math.floor(v / 85);
    }
    out += d.slice(0, len + 1).join("");
  }
  return out;
}

/** Known-answer vectors (generated with Python base64.a85encode / b85encode and the Z85 spec example). */
export const BASE85_VECTORS: { variant: Base85Variant; bytes: number[]; text: string }[] = [
  { variant: "ascii85", bytes: [...Buffer.from("Man ")], text: "9jqo^" },
  { variant: "ascii85", bytes: [...Buffer.from("hello world")], text: "BOu!rD]j7BEbo7" },
  { variant: "ascii85", bytes: [0, 0, 0, 0], text: "z" },
  { variant: "rfc1924", bytes: [...Buffer.from("hello world")], text: "Xk~0{Zy<MXa%^M" },
  { variant: "rfc1924", bytes: [255, 255, 255, 255, 255], text: "|NsC0{{" },
  { variant: "z85", bytes: [0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b], text: "HelloWorld" },
];

/** Returns the failing vectors (empty array = decoder passes). */
export function base85SelfTest(): string[] {
  const bad: string[] = [];
  for (const v of BASE85_VECTORS) {
    const got = Array.from(decodeBase85(v.text, v.variant));
    if (got.join(",") !== v.bytes.join(",")) bad.push(`${v.variant}:${v.text}`);
  }
  return bad;
}

export function resolveVariant(payload: string, configured: Base85Variant | "auto", fallback: Base85Variant): Base85Variant {
  if (configured !== "auto") return configured;
  const c = compatibleVariants(payload);
  return c.length === 1 ? c[0]! : c.includes(fallback) ? fallback : (c[0] ?? fallback);
}
