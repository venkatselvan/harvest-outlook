import type { FastifyRequest } from "fastify";

const SENSITIVE_QUERY = /([?&](?:lat|lon|lng|latitude|longitude|polygon|token|csrf)=)[^&]*/gi;

/** Request serializer: method/path/ip only, with location-like query values redacted. */
export function reqSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: req.url.replace(SENSITIVE_QUERY, "$1[redacted]"),
    remoteAddress: req.ip,
  };
}

/** Defence in depth for any object accidentally logged with coordinates, cookies or file bytes. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  "*.lat",
  "*.lon",
  "*.polygon",
  "*.latitude",
  "*.longitude",
  "*.token",
  "*.cookie",
  "*.buffer",
  "*.body",
];
