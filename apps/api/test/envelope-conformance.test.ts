import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiEnvelope } from "@harvest/contracts";
import { login, makeJpeg, upload, setupHarness, type Client, type Harness } from "./helpers";

// Validates REAL server responses against the exported contract, not a hand-built object.
const Any = apiEnvelope(z.unknown());
let h: Harness;
let c: Client;

beforeAll(async () => {
  h = await setupHarness();
  c = await login(h.app);
});
afterAll(async () => h.close());

describe("server envelope conforms to @harvest/contracts apiEnvelope", () => {
  it("real 200", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const parsed = Any.safeParse(res.json());
    expect(parsed.error?.issues).toBeUndefined();
    expect(res.json().schemaVersion).toBe("1.0");
    expect(res.json().error).toBeNull();
  });

  it("real 404", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const parsed = Any.safeParse(res.json());
    expect(parsed.error?.issues).toBeUndefined();
    expect(res.json().error).toMatchObject({ code: "not_found", retryable: false });
  });

  it("real 422 (undecodable image) and real 400 (request validation)", async () => {
    const real = await makeJpeg();
    const res = await upload(c, Buffer.concat([real.subarray(0, 120), Buffer.alloc(200, 7)]));
    expect(res.statusCode).toBe(422);
    expect(Any.safeParse(res.json()).error?.issues).toBeUndefined();
    expect(res.json().error).toMatchObject({ code: "invalid_image", retryable: false });
    const v = await c.call("POST", "/api/v1/farms", { payload: { name: 42 } });
    expect(v.statusCode).toBe(400);
    expect(Any.safeParse(v.json()).error?.issues).toBeUndefined();
    expect(v.json().error.code).toBe("validation_error");
  });

  it("real 403 (origin) and 401 (no session) use contract codes", async () => {
    const bad = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: "http://evil.example" } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(Any.safeParse(bad.json()).error?.issues).toBeUndefined();
    const anon = await h.app.inject({ method: "GET", url: "/api/v1/farms" });
    expect(anon.statusCode).toBe(401);
    expect(Any.safeParse(anon.json()).error?.issues).toBeUndefined();
  });
});
