import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { ApiError, notFound } from "../services/errors";
import { sha256Hex } from "../services/hash";
import { parseIdempotencyKey, runIdempotent } from "../services/idempotency";
import { getMedia, processImage, readContent, setRegion, sniffImage, storeImage } from "../services/media";
import type { StorageAdapter } from "../storage/types";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { contentQuery, mediaOut, regionBody } from "./schemas/media";

const MULTIPART_OVERHEAD = 64 * 1024;

export async function mediaRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool; storage: StorageAdapter }) {
  const { config, pool, storage } = opts;
  const max = config.MAX_UPLOAD_IMAGE_BYTES;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/media",
    {
      schema: {
        tags: ["media"],
        description:
          `Uploads one private image (multipart, field "file"; JPEG/PNG/WebP by magic bytes; at most ${max} bytes, enforced while streaming). ` +
          'Optional farmId as query parameter or as a form field sent BEFORE the file. Stores the original and a metadata-stripped, orientation-normalised JPEG (max 1600 px). ' +
          "Returns a media id; there is no public URL. Supports Idempotency-Key.",
        querystring: z.object({ farmId: z.uuid().optional() }),
        response: { 201: envelopeSchema(mediaOut) },
      },
    },
    async (req, reply) => {
      const { ownerId } = requireAuth(req);
      if (!req.isMultipart()) throw new ApiError(415, "unsupported_media_type", "Expected multipart/form-data");
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max + MULTIPART_OVERHEAD) {
        reply.header("connection", "close");
        throw new ApiError(413, "payload_too_large", `Upload exceeds ${max} bytes`);
      }
      const key = parseIdempotencyKey(req.headers["idempotency-key"]);
      const part = await req.file({ limits: { fileSize: max, files: 1 } });
      if (!part || part.fieldname !== "file") throw new ApiError(400, "file_required", 'Multipart field "file" is required');
      const fieldFarm = (part.fields.farmId as { value?: unknown } | undefined)?.value;
      const farmParsed = z.uuid().optional().safeParse(req.query.farmId ?? fieldFarm);
      if (!farmParsed.success) throw new ApiError(400, "validation_error", "farmId must be a UUID");
      const farmId = farmParsed.data ?? null;

      // Stream with a hard cap: stop reading as soon as the limit is crossed, and reject bad magic bytes early.
      const chunks: Buffer[] = [];
      let total = 0;
      let sniffed = false;
      for await (const chunk of part.file as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > max) {
          part.file.destroy();
          reply.header("connection", "close");
          throw new ApiError(413, "payload_too_large", `Upload exceeds ${max} bytes`);
        }
        chunks.push(chunk);
        if (!sniffed && total >= 12) {
          sniffed = true;
          if (!sniffImage(Buffer.concat(chunks))) {
            part.file.destroy();
            reply.header("connection", "close");
            throw new ApiError(415, "unsupported_media_type", "Only JPEG, PNG and WebP images are accepted");
          }
        }
      }
      if (part.file.truncated) {
        reply.header("connection", "close");
        throw new ApiError(413, "payload_too_large", `Upload exceeds ${max} bytes`);
      }
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) throw new ApiError(400, "file_required", "Uploaded file is empty");

      const out = await runIdempotent(
        pool,
        { ownerId, key, route: "POST /api/v1/media", hashInput: { sha256: sha256Hex(buf), farmId } },
        async () => {
          const img = await processImage(buf);
          const media = await storeImage(pool, storage, ownerId, farmId, buf, img);
          return { status: 201, body: envelope(req.id, config.RUNTIME_MODE, media) };
        },
      );
      if (out.replay) reply.header("idempotent-replay", "true");
      return reply.code(out.status as 201).send(out.body as never);
    },
  );

  r.get(
    "/api/v1/media/:id",
    { schema: { tags: ["media"], description: "Owner-scoped media metadata.", params: uuidParam, response: { 200: envelopeSchema(mediaOut) } } },
    async (req) => {
      const m = await getMedia(pool, requireAuth(req).ownerId, req.params.id);
      if (!m) throw notFound("Media");
      return envelope(req.id, config.RUNTIME_MODE, m);
    },
  );

  r.get(
    "/api/v1/media/:id/content",
    {
      schema: {
        tags: ["media"],
        description: "Streams the private image to its owner only (Cache-Control: private, no-store). variant=original|normalized (default normalized).",
        params: uuidParam,
        querystring: contentQuery,
      },
    },
    async (req, reply) => {
      const c = await readContent(pool, storage, requireAuth(req).ownerId, req.params.id, req.query.variant);
      return reply
        .header("cache-control", "private, no-store")
        .header("content-type", c.contentType)
        .header("content-disposition", "inline")
        .send(Buffer.from(c.data));
    },
  );

  r.put(
    "/api/v1/media/:id/region",
    {
      schema: {
        tags: ["media"],
        description:
          "Saves a user-confirmed region: 3-64 points in normalised 0..1 coordinates of the orientation-corrected image, with the coordinate transform. Increments region_version. Coordinates are never logged.",
        params: uuidParam,
        body: regionBody,
        response: { 200: envelopeSchema(mediaOut) },
      },
    },
    async (req) => envelope(req.id, config.RUNTIME_MODE, await setRegion(pool, requireAuth(req).ownerId, req.params.id, req.body)),
  );
}
