export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PrecheckResult = { ok: true } | { ok: false; message: string };

/** Client-side convenience check; the server re-validates magic bytes and decodes the image. */
export function precheckFile(file: { name: string; type: string; size: number }, maxBytes = DEFAULT_MAX_BYTES): PrecheckResult {
  if (file.size === 0) return { ok: false, message: "That file is empty. Choose another photo." };
  if (file.size > maxBytes) {
    const mb = Math.round((maxBytes / 1024 / 1024) * 10) / 10;
    const have = Math.round((file.size / 1024 / 1024) * 10) / 10;
    return { ok: false, message: `This photo is ${have} MB. The limit is ${mb} MB. Choose a smaller photo or lower the camera quality.` };
  }
  const t = file.type.toLowerCase();
  if (t === "image/heic" || t === "image/heif" || /\.(heic|heif)$/i.test(file.name)) {
    return { ok: false, message: "HEIC photos are not supported. Choose a JPEG, PNG or WebP photo (on iPhone: Settings > Camera > Formats > Most Compatible)." };
  }
  if (!OK_TYPES.has(t)) {
    // Some browsers leave type empty; fall back to the extension, the server checks real content anyway.
    if (t === "" && /\.(jpe?g|png|webp)$/i.test(file.name)) return { ok: true };
    return { ok: false, message: "Only JPEG, PNG or WebP photos can be used." };
  }
  return { ok: true };
}
