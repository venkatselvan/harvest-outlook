import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { withTransaction } from "../db/pool";
import { ApiError } from "../services/errors";
import { hashClientIp } from "../services/budget";
import { sha256Hex } from "../services/hash";
import { deriveCsrf, hashToken, newToken } from "./tokens";

export const SESSION_COOKIE = "ho_session";
/** Used when cookies are Secure: the __Host- prefix pins them to this exact host, path=/ and https. */
export const SECURE_SESSION_COOKIE = "__Host-ho_session";
export const CSRF_COOKIE = "ho_csrf";
const DAY_MS = 86_400_000;

export interface AuthContext {
  ownerId: string;
  sessionId: string;
  sessionToken: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether cookies are Secure. COOKIE_SECURE=true/false is explicit; auto is Secure in production and
 * otherwise Secure unless the (already origin-validated) request is for localhost. The Host header is
 * only consulted in the non-production auto case, so a proxy forwarding Host: localhost cannot downgrade production.
 */
export function cookieSecure(req: FastifyRequest, config: Config): boolean {
  if (config.COOKIE_SECURE === "true") return true;
  if (config.COOKIE_SECURE === "false") return false;
  if (config.NODE_ENV === "production") return true;
  return !isLocalRequest(req);
}

export const sessionCookieName = (secure: boolean): string => (secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

export function isLocalRequest(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      return LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {
      /* fall through */
    }
  }
  return LOCAL_HOSTS.has(req.hostname.replace(/:\d+$/, ""));
}

export function setSessionCookies(reply: FastifyReply, req: FastifyRequest, config: Config, token: string): { csrf: string; expiresAt: Date } {
  const maxAge = config.SESSION_TTL_DAYS * 86_400;
  const secure = cookieSecure(req, config);
  const csrf = deriveCsrf(config.SESSION_SECRET, token);
  reply.setCookie(sessionCookieName(secure), token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
  reply.setCookie(CSRF_COOKIE, csrf, { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge });
  return { csrf, expiresAt: new Date(Date.now() + maxAge * 1000) };
}

export function clearSessionCookies(reply: FastifyReply, req: FastifyRequest, config: Config): void {
  const secure = cookieSecure(req, config);
  reply.clearCookie(sessionCookieName(secure), { httpOnly: true, sameSite: "lax", secure, path: "/" });
  reply.clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: "lax", secure, path: "/" });
}

export async function createSession(pool: Pool, config: Config, userAgent: string | undefined, clientIp?: string): Promise<{ token: string; sessionId: string; ownerId: string }> {
  const token = newToken();
  return withTransaction(pool, async (c) => {
    const o = await c.query<{ id: string }>("INSERT INTO owners DEFAULT VALUES RETURNING id");
    const ownerId = o.rows[0]!.id;
    const s = await c.query<{ id: string }>(
      `INSERT INTO sessions (owner_id, token_hash, expires_at, user_agent_hash, ip_hash)
       VALUES ($1,$2, now() + make_interval(days => $3), $4, $5) RETURNING id`,
      [ownerId, hashToken(token), config.SESSION_TTL_DAYS, userAgent ? sha256Hex(userAgent) : null, hashClientIp(clientIp, config.SESSION_SECRET)],
    );
    return { token, sessionId: s.rows[0]!.id, ownerId };
  });
}

/** Resolves the session from the cookie only; a client-supplied owner id is never consulted. */
export async function resolveSession(pool: Pool, config: Config, req: FastifyRequest, reply?: FastifyReply): Promise<AuthContext | null> {
  // In Secure mode only the __Host- cookie counts: a plain cookie planted by a sibling subdomain is ignored.
  const token = req.cookies[sessionCookieName(cookieSecure(req, config))];
  if (!token || token.length > 128) return null;
  const r = await pool.query<{ id: string; owner_id: string; expires_at: Date }>(
    `SELECT s.id, s.owner_id, s.expires_at FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND o.deleted_at IS NULL`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Sliding expiry: extend at most once a day to avoid a write per request.
  if (row.expires_at.getTime() - Date.now() < (config.SESSION_TTL_DAYS - 1) * DAY_MS) {
    await pool.query("UPDATE sessions SET expires_at = now() + make_interval(days => $2) WHERE id = $1", [row.id, config.SESSION_TTL_DAYS]);
    if (reply) setSessionCookies(reply, req, config, token);
  }
  return { ownerId: row.owner_id, sessionId: row.id, sessionToken: token };
}

/**
 * Replaces the token of a live session in place (same session row and owner, so per-session budget
 * counters carry over); the previous token stops resolving immediately. Returns null if the old token
 * was already rotated by a concurrent request.
 */
export async function rotateSession(pool: Pool, config: Config, auth: AuthContext): Promise<string | null> {
  const token = newToken();
  const r = await pool.query(
    `UPDATE sessions SET token_hash = $3, expires_at = now() + make_interval(days => $4)
     WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
    [auth.sessionId, hashToken(auth.sessionToken), hashToken(token), config.SESSION_TTL_DAYS],
  );
  return r.rowCount ? token : null;
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

export const requireAuth = (req: FastifyRequest): AuthContext => {
  if (!req.auth) throw new ApiError(401, "unauthenticated", "A guest session is required");
  return req.auth;
};
