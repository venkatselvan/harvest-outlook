import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { clientFingerprint, REDACT_PATHS, reqSerializer } from "../src/security/logging";

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b|::1\b/i;

describe("F9: request logs never contain a raw client IP", () => {
  it("default request/response log lines carry no IPv4 or IPv6 literal, only a short keyed fingerprint", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _e, cb) => (lines.push(String(chunk)), cb()) });
    // Same logger options as buildServer in src/server.ts.
    const app = Fastify({ logger: { level: "info", stream, redact: { paths: REDACT_PATHS, censor: "[redacted]" }, serializers: { req: reqSerializer } }, trustProxy: true });
    app.get("/ping", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/ping?lat=12.3&x=1", remoteAddress: "203.0.113.77", headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.77" } });
    await app.inject({ method: "GET", url: "/ping", remoteAddress: "2001:db8::1234" });
    await app.close();
    const text = lines.join("");
    expect(text).toContain("incoming request");
    expect(text).not.toMatch(IPV4);
    expect(text).not.toMatch(IPV6);
    expect(text).not.toContain("remoteAddress");
    for (const l of lines) expect(Object.keys(JSON.parse(l).req ?? {})).not.toContain("hostname"); // pino's top-level "hostname" is the machine, not the client
    expect(text).toContain("[redacted]"); // location-like query still redacted
    const client = JSON.parse(lines[0]!).req.client as string;
    expect(client).toMatch(/^[0-9a-f]{12}$/);
  });

  it("the fingerprint is stable per IP and key, differs between IPs and keys", () => {
    expect(clientFingerprint("203.0.113.1", "k".repeat(32))).toBe(clientFingerprint("203.0.113.1", "k".repeat(32)));
    expect(clientFingerprint("203.0.113.1", "k".repeat(32))).not.toBe(clientFingerprint("203.0.113.2", "k".repeat(32)));
    expect(clientFingerprint("203.0.113.1", "k".repeat(32))).not.toBe(clientFingerprint("203.0.113.1", "j".repeat(32)));
  });
});
