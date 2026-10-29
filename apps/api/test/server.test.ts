import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import type { Pool } from "../src/db/pool";

const config = loadConfig({
  DATABASE_URL: "postgres://x/y",
  SESSION_SECRET: "k".repeat(32),
  ALLOWED_ORIGINS: "http://localhost:5173",
  MODEL_API_KEY: "sk-secret-123",
  LOG_LEVEL: "silent",
});

const downPool = { query: async () => { throw new Error("down"); } } as unknown as Pool;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer(config, downPool);
});
afterAll(async () => app.close());

describe("api server", () => {
  it("returns the standard envelope and reports an unreachable database as degraded", async () => {
    const res = await app.inject({ url: "/api/v1/health" });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ mode: "synthetic", data: { status: "degraded", database: false }, error: null, warnings: [] });
    expect(body.requestId).toBe(res.headers["x-request-id"]);
    expect(Date.parse(body.asOf)).not.toBeNaN();
  });

  it("capabilities exposes provider booleans but never secrets", async () => {
    const res = await app.inject({ url: "/api/v1/capabilities" });
    const body = res.json();
    expect(body.data.providers).toEqual({ meta: true, elevenlabs: false });
    expect(body.data.languages).toEqual(["en", "ta", "hi"]);
    expect(body.warnings.join(" ")).toMatch(/Synthetic/);
    expect(res.body).not.toContain("sk-secret-123");
    expect(res.body).not.toContain("k".repeat(32));
  });

  it("client cannot change the mode via query string", async () => {
    const res = await app.inject({ url: "/api/v1/health?mode=live", headers: { "x-runtime-mode": "live" } });
    expect(res.json().mode).toBe("synthetic");
  });

  it("unknown routes return an error envelope", async () => {
    const res = await app.inject({ url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ data: null, error: { code: "not_found" } });
  });

  it("rejects cross-origin preflight from a disallowed origin", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/v1/health", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await app.inject({ method: "OPTIONS", url: "/api/v1/health", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("serves OpenAPI generated from route schemas", async () => {
    const res = await app.inject({ url: "/api/v1/openapi.json" });
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/v1/health", "/api/v1/capabilities"]));
  });
});
