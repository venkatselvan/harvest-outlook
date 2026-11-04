import { exifCreatedDate } from "./exif-date";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { withTransaction, type Pool } from "../db/pool";
import type { MediaOut, RegionBody } from "../routes/schemas/media";
import type { StorageAdapter } from "../storage/types";
import { ApiError, notFound } from "./errors";
import { sha256Hex } from "./hash";

export const NORMALIZED_MAX_SIDE = 1600;
/** Decompression-bomb guard: reject images above this many pixels before decoding. */
export const MAX_INPUT_PIXELS = 64_000_000;

export type ImageKind = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

/** Magic-byte sniffing. Client-declared MIME and filename are ignored. SVG/GIF/others are rejected. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { mime: "image/png", ext: "png" };
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export interface ProcessedImage {
  kind: ImageKind;
  width: number;
  height: number;
  orientation: number | null;
  exifCreatedAt: string | null;
  orientedWidth: number;
  orientedHeight: number;
  normalized: { data: Buffer; width: number; height: number };
}

/** Fully decodes the image (proves it is real), applies EXIF rotation and strips all metadata. */
export async function processImage(buf: Buffer): Promise<ProcessedImage> {
  const kind = sniffImage(buf);
  if (!kind) throw new ApiError(415, "unsupported_media_type", "Only JPEG, PNG and WebP images are accepted");
  try {
    const base = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", sequentialRead: true });
    const meta = await base().metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    const orientation = meta.orientation ?? null;
    const swap = orientation !== null && orientation >= 5;
    // .rotate() with no args applies EXIF orientation; sharp drops EXIF/ICC/XMP unless withMetadata() is used.
    const out = await base()
      .rotate()
      .resize({ width: NORMALIZED_MAX_SIDE, height: NORMALIZED_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    return {
      kind,
      width: meta.width,
      height: meta.height,
      orientation,
      exifCreatedAt: exifCreatedDate(meta.exif),
      orientedWidth: swap ? meta.height : meta.width,
      orientedHeight: swap ? meta.width : meta.height,
      normalized: { data: out.data, width: out.info.width, height: out.info.height },
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = (e as Error).message ?? "";
    if (/pixel limit|exceeds pixel/i.test(msg)) throw new ApiError(413, "image_too_large", "Image dimensions exceed the processing limit");
    throw new ApiError(422, "invalid_image", "File is not a decodable image");
  }
}

interface MediaRow {
  id: string;
  farm_id: string | null;
  content_type: string;
  byte_size: string;
  sha256: string;
  width: number;
  height: number;
  exif_orientation: number | null;
  exif_created_at: string | Date | null;
  region_polygon: [number, number][] | null;
  region_transform: RegionBody["transform"] | null;
  region_source: "manual" | "sam_confirmed" | null;
  region_version: number;
  created_at: Date;
  n_width: number | null;
  n_height: number | null;
  n_bytes: string | null;
}

const SELECT = `SELECT o.id, o.farm_id, o.content_type, o.byte_size, o.sha256, o.width, o.height, o.exif_orientation, o.exif_created_at::text,
    o.region_polygon, o.region_transform, o.region_source, o.region_version, o.created_at,
    d.width AS n_width, d.height AS n_height, d.byte_size AS n_bytes
  FROM media_objects o LEFT JOIN media_objects d ON d.parent_media_id = o.id AND d.kind = 'derivative'
  WHERE o.kind = 'image' AND o.deleted_at IS NULL`;

function toOut(r: MediaRow): MediaOut {
  const swap = r.exif_orientation !== null && r.exif_orientation >= 5;
  return {
    id: r.id,
    farmId: r.farm_id,
    contentType: r.content_type,
    bytes: Number(r.byte_size),
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    exifOrientation: r.exif_orientation,
    exifCreatedAt: r.exif_created_at instanceof Date ? r.exif_created_at.toISOString().slice(0, 10) : r.exif_created_at ?? null,
    orientedWidth: swap ? r.height : r.width,
    orientedHeight: swap ? r.width : r.height,
    normalized: { width: r.n_width ?? 0, height: r.n_height ?? 0, bytes: Number(r.n_bytes ?? 0), contentType: "image/jpeg" },
    contentPath: `/api/v1/media/${r.id}/content`,
    region: r.region_polygon && r.region_transform && r.region_source ? { polygon: r.region_polygon, source: r.region_source, transform: r.region_transform, version: r.region_version } : null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function getMedia(db: Pool | PoolClient, ownerId: string, id: string): Promise<MediaOut | null> {
  const r = await db.query<MediaRow>(`${SELECT} AND o.id = $1 AND o.owner_id = $2`, [id, ownerId]);
  return r.rows[0] ? toOut(r.rows[0]) : null;
}

export async function storeImage(pool: Pool, storage: StorageAdapter, ownerId: string, farmId: string | null, buf: Buffer, img: ProcessedImage): Promise<MediaOut> {
  if (farmId) {
    const f = await pool.query("SELECT 1 FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [farmId, ownerId]);
    if (!f.rowCount) throw notFound("Farm");
  }
  const id = randomUUID();
  const origKey = `media/${id}/original.${img.kind.ext}`;
  const normKey = `media/${id}/derived/normalized.jpg`;
  await storage.put({ ownerId, key: origKey }, buf);
  try {
    await storage.put({ ownerId, key: normKey }, img.normalized.data);
    await withTransaction(pool, async (c) => {
      await c.query(
        `INSERT INTO media_objects (id, owner_id, farm_id, kind, storage_key, content_type, byte_size, sha256, width, height, exif_orientation, exif_created_at)
         VALUES ($1,$2,$3,'image',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, ownerId, farmId, origKey, img.kind.mime, buf.byteLength, sha256Hex(buf), img.width, img.height, img.orientation, img.exifCreatedAt],
      );
      await c.query(
        `INSERT INTO media_objects (owner_id, farm_id, kind, storage_key, content_type, byte_size, sha256, width, height, parent_media_id)
         VALUES ($1,$2,'derivative',$3,'image/jpeg',$4,$5,$6,$7,$8)`,
        [ownerId, farmId, normKey, img.normalized.data.byteLength, sha256Hex(img.normalized.data), img.normalized.width, img.normalized.height, id],
      );
    });
  } catch (e) {
    await storage.delete({ ownerId, key: origKey }).catch(() => undefined);
    await storage.delete({ ownerId, key: normKey }).catch(() => undefined);
    throw e;
  }
  return (await getMedia(pool, ownerId, id))!;
}

/** Shoelace area; rejects collapsed polygons that would select nothing. */
export function polygonArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export async function setRegion(pool: Pool, ownerId: string, id: string, body: RegionBody): Promise<MediaOut> {
  const cur = await getMedia(pool, ownerId, id);
  if (!cur) throw notFound("Media");
  if (polygonArea(body.polygon) < 1e-6) throw new ApiError(422, "degenerate_region", "Region polygon has no area");
  if (cur.exifOrientation !== null && cur.exifOrientation > 1 && !body.transform.orientationApplied) {
    throw new ApiError(422, "orientation_not_applied", "Image has EXIF orientation; region coordinates must be in the orientation-corrected frame");
  }
  if (body.transform.normalizedWidth !== cur.normalized.width || body.transform.normalizedHeight !== cur.normalized.height) {
    throw new ApiError(422, "transform_mismatch", "transform dimensions do not match the normalized image", { normalizedWidth: cur.normalized.width, normalizedHeight: cur.normalized.height });
  }
  await pool.query(
    `UPDATE media_objects SET region_polygon=$3::jsonb, region_transform=$4::jsonb, region_source=$5, region_version = region_version + 1
     WHERE id=$1 AND owner_id=$2 AND kind='image'`,
    [id, ownerId, JSON.stringify(body.polygon), JSON.stringify(body.transform), body.source],
  );
  return (await getMedia(pool, ownerId, id))!;
}

export async function readContent(pool: Pool, storage: StorageAdapter, ownerId: string, id: string, variant: "original" | "normalized") {
  const r =
    variant === "original"
      ? await pool.query<{ storage_key: string; content_type: string }>("SELECT storage_key, content_type FROM media_objects WHERE id=$1 AND owner_id=$2 AND kind='image' AND deleted_at IS NULL", [id, ownerId])
      : await pool.query<{ storage_key: string; content_type: string }>("SELECT storage_key, content_type FROM media_objects WHERE parent_media_id=$1 AND owner_id=$2 AND kind='derivative' AND deleted_at IS NULL", [id, ownerId]);
  const row = r.rows[0];
  if (!row) throw notFound("Media");
  try {
    return { data: await storage.get({ ownerId, key: row.storage_key }), contentType: row.content_type };
  } catch {
    throw notFound("Media");
  }
}
