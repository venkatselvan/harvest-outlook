import { createHmac, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";

const SENSITIVE_QUERY = /([?&](?:lat|lon|lng|latitude|longitude|polygon|token|csrf)=)[^&]*/gi;

/** Key for the log-side client fingerprint: SESSION_SECRET when set in the environment, else a per-process random key. */
const FALLBACK_KEY = randomBytes(32);
const logKey = (): string | Buffer => process.env.SESSION_SECRET || FALLBACK_KEY;

/** Short keyed fingerprint (12 hex chars) so abuse can be correlated in logs without storing the raw IP. */
export function clientFingerprint(ip: string | undefined, key: string | Buffer = logKey()): string | undefined {
  return ip ? createHmac("sha256", key).update(`log-ip:${ip}`).digest("hex").slice(0, 12) : undefined;
}

/**
 * Request serializer factory: method, path and a keyed client fingerprint only, with location-like query values redacted.
 * Replacing the serializer also removes Fastify's default `hostname` and `remoteAddress`; raw IPs are never logged.
 * `secret` is the validated config SESSION_SECRET; without one the per-process random key is used.
 */
export function makeReqSerializer(secret?: string | Buffer) {
  return (req: FastifyRequest) => ({
    method: req.method,
    url: req.url.replace(SENSITIVE_QUERY, "$1[redacted]"),
    client: clientFingerprint(req.ip, secret || logKey()),
  });
}

/** Serializer keyed from the environment (fallback only; the server passes its validated config secret). */
export const reqSerializer = makeReqSerializer();

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
