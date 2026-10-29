import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { ApiError } from "../services/errors";
import { CSRF_COOKIE, resolveSession } from "./session";
import { deriveCsrf, safeEqual } from "./tokens";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Origin (or Referer) must match ALLOWED_ORIGINS; absent only when explicitly allowed by config. */
export function checkOrigin(req: FastifyRequest, config: Config): void {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    if (!config.ALLOWED_ORIGINS.includes(origin)) throw new ApiError(403, "origin_not_allowed", "Origin not allowed");
    return;
  }
  const referer = req.headers.referer;
  if (typeof referer === "string") {
    let o: string;
    try {
      o = new URL(referer).origin;
    } catch {
      throw new ApiError(403, "origin_not_allowed", "Origin not allowed");
    }
    if (!config.ALLOWED_ORIGINS.includes(o)) throw new ApiError(403, "origin_not_allowed", "Origin not allowed");
    return;
  }
  if (!config.ALLOW_MISSING_ORIGIN) throw new ApiError(403, "origin_required", "Origin or Referer header required");
}

export function checkCsrf(req: FastifyRequest, config: Config, sessionToken: string): void {
  const header = req.headers["x-csrf-token"];
  const cookie = req.cookies[CSRF_COOKIE];
  const expected = deriveCsrf(config.SESSION_SECRET, sessionToken);
  if (typeof header !== "string" || !safeEqual(header, cookie) || !safeEqual(header, expected)) {
    throw new ApiError(403, "csrf_invalid", "Missing or invalid CSRF token");
  }
}

/** onRequest hook for private routes: origin + session + CSRF, before any body is read. */
export function privateRouteGuard(config: Config, pool: Pool) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const unsafe = !SAFE.has(req.method);
    if (unsafe) checkOrigin(req, config);
    const auth = await resolveSession(pool, config, req, reply);
    if (!auth) throw new ApiError(401, "unauthenticated", "A guest session is required");
    if (unsafe) checkCsrf(req, config, auth.sessionToken);
    req.auth = auth;
  };
}
