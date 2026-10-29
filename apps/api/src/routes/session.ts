import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { checkOrigin } from "../security/guards";
import { clearSessionCookies, createSession, resolveSession, revokeSession, setSessionCookies } from "../security/session";
import { deriveCsrf } from "../security/tokens";
import { envelope } from "../envelope";
import { checkCsrf } from "../security/guards";
import { ApiError } from "../services/errors";
import { envelopeSchema } from "./schemas/common";
import { sessionDeletedOut, sessionOut } from "./schemas/session";

export const GUEST_CAVEAT =
  "This is a device guest workspace. Your farms and photos are tied to this browser; clearing site data, switching device or signing out loses access and there is no account recovery.";

export async function sessionRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool }) {
  const { config, pool } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/v1/session",
    { schema: { tags: ["session"], description: "Reports whether the cookie holds a valid guest session; re-issues the CSRF value.", response: { 200: envelopeSchema(sessionOut) } } },
    async (req) => {
      const auth = await resolveSession(pool, config, req);
      if (!auth) return envelope(req.id, config.RUNTIME_MODE, { authenticated: false });
      return envelope(req.id, config.RUNTIME_MODE, {
        authenticated: true,
        scope: "device_guest" as const,
        csrfToken: deriveCsrf(config.SESSION_SECRET, auth.sessionToken),
        caveat: GUEST_CAVEAT,
      });
    },
  );

  r.post(
    "/api/v1/session",
    {
      config: { rateLimit: { max: config.SESSION_CREATE_PER_HOUR, timeWindow: "1 hour" } },
      schema: {
        tags: ["session"],
        description: "Creates a device guest workspace (owner + session) and sets ho_session (HttpOnly) and ho_csrf cookies. An existing valid session is reused rather than creating another owner.",
        response: { 200: envelopeSchema(sessionOut), 201: envelopeSchema(sessionOut) },
      },
    },
    async (req, reply) => {
      checkOrigin(req, config);
      const existing = await resolveSession(pool, config, req, reply);
      if (existing) {
        const { csrf, expiresAt } = setSessionCookies(reply, req, config, existing.sessionToken);
        return envelope(req.id, config.RUNTIME_MODE, { authenticated: true, scope: "device_guest" as const, expiresAt: expiresAt.toISOString(), csrfToken: csrf, reused: true, caveat: GUEST_CAVEAT });
      }
      const ua = req.headers["user-agent"];
      const { token } = await createSession(pool, config, typeof ua === "string" ? ua : undefined);
      const { csrf, expiresAt } = setSessionCookies(reply, req, config, token);
      reply.code(201);
      return envelope(req.id, config.RUNTIME_MODE, { authenticated: true, scope: "device_guest" as const, expiresAt: expiresAt.toISOString(), csrfToken: csrf, reused: false, caveat: GUEST_CAVEAT });
    },
  );

  r.delete(
    "/api/v1/session",
    { schema: { tags: ["session"], description: "Revokes the current session and clears cookies.", response: { 200: envelopeSchema(sessionDeletedOut) } } },
    async (req, reply) => {
      checkOrigin(req, config);
      const auth = await resolveSession(pool, config, req);
      if (!auth) throw new ApiError(401, "unauthenticated", "A guest session is required");
      checkCsrf(req, config, auth.sessionToken);
      await revokeSession(pool, auth.sessionId);
      clearSessionCookies(reply, req);
      return envelope(req.id, config.RUNTIME_MODE, { revoked: true });
    },
  );
}
