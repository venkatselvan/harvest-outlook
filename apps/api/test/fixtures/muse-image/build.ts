import sharp from "sharp";

/**
 * SYNTHETIC image fixtures for the visuals tests. Nothing here is real provider output or a real farm photo.
 * Images are built programmatically so the scene-QA tests can state exactly what changed and where.
 */
export type Pt = [number, number];

/** Planting region used across the tests: a centred quadrilateral covering roughly 30% of the frame. */
export const REGION: Pt[] = [
  [0.3, 0.4],
  [0.7, 0.4],
  [0.75, 0.85],
  [0.25, 0.85],
];

/** A textured "scene": diagonal gradient plus a darker horizon band, so grayscale differences are measurable. */
export async function sceneJpeg(w = 320, h = 240): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * h * 0 + y * w + x) * 3;
      const band = y < h * 0.35 ? 40 : 0;
      raw[i] = Math.min(255, 60 + Math.round((x / w) * 120) + band);
      raw[i + 1] = Math.min(255, 90 + Math.round((y / h) * 100));
      raw[i + 2] = 70 + band;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

function inside(poly: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Returns a PNG equal to `base` except inside the polygon, where pixels become a strong green/dark pattern (the "growing crop"). */
export async function editRegionOnly(base: Buffer, poly: Pt[] = REGION): Promise<Buffer> {
  const { data, info } = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (!inside(poly, (x + 0.5) / info.width, (y + 0.5) / info.height)) continue;
      const i = (y * info.width + x) * 3;
      const stripe = (x >> 2) % 2 === 0;
      out[i] = stripe ? 20 : 40;
      out[i + 1] = stripe ? 200 : 120;
      out[i + 2] = stripe ? 40 : 20;
    }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

/** Returns a PNG where the WHOLE frame changed: inverted tones (a different scene), region included. */
export async function editWholeImage(base: Buffer): Promise<Buffer> {
  return sharp(base).removeAlpha().negate().png().toBuffer();
}

/** Same pixels as the base (a no-op edit). */
export async function editNothing(base: Buffer): Promise<Buffer> {
  return sharp(base).removeAlpha().png().toBuffer();
}

export const dataUrlToBuffer = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

/** Provider-shaped JSON success body (`data[0].b64_json`). SYNTHETIC. */
export const providerOk = (png: Buffer, id = "req_fixture_1"): Response =>
  new Response(JSON.stringify({ created: 0, data: [{ b64_json: png.toString("base64") }], usage: { fixture: true } }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": id },
  });
