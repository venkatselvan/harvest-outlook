/** Read only EXIF date tags from sharp's TIFF/EXIF buffer. Offsets and entry counts are bounded; malformed metadata is ignored. */
export function exifCreatedDate(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  try {
    const start = bytes[0] === 0x45 && bytes[1] === 0x78 && bytes[2] === 0x69 && bytes[3] === 0x66 ? 6 : 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
    const little = view.getUint16(0) === 0x4949;
    if (!little && view.getUint16(0) !== 0x4d4d) return null;
    const u16 = (n: number) => view.getUint16(n, little);
    const u32 = (n: number) => view.getUint32(n, little);
    if (u16(2) !== 42) return null;
    const dates = new Map<number, string>();
    const seen = new Set<number>();
    const read = (offset: number) => {
      if (seen.has(offset) || seen.size >= 3) return;
      seen.add(offset);
      const count = Math.min(u16(offset), 256);
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        const tag = u16(entry), type = u16(entry + 2), length = u32(entry + 4), ptr = u32(entry + 8);
        if (tag === 0x8769 && type === 4 && length === 1) { read(ptr); continue; }
        if (![0x9003, 0x9004, 0x0132].includes(tag) || type !== 2 || length < 19 || length > 32 || ptr + length > view.byteLength) continue;
        const raw = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + ptr, 19));
        if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) continue;
        const date = raw.slice(0, 10).replaceAll(':', '-');
        const parsed = new Date(`${date}T00:00:00Z`);
        if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) dates.set(tag, date);
      }
    };
    read(u32(4));
    return dates.get(0x9003) ?? dates.get(0x9004) ?? dates.get(0x0132) ?? null;
  } catch { return null; }
}
