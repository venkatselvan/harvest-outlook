import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../services/hash";

/** 256-bit random token, URL-safe. Only its sha256 is ever stored. */
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => sha256Hex(token);

/**
 * CSRF value bound to the session token with the server secret. It is unguessable without the
 * secret or the session token, and lets GET /session re-issue it without storing the raw value.
 */
export const deriveCsrf = (secret: string, sessionToken: string): string =>
  createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
