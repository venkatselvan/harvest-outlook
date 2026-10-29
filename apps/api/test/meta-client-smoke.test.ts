import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SKIP_MESSAGE, SMOKE_CAP_USD, runLiveSmoke } from "../src/providers/meta/smoke";

const KEY = "sk-smoke-SECRET-12345678";
const resp = (n: number, items: unknown[], usage = { input_tokens: 900, output_tokens: 60 }) =>
  new Response(JSON.stringify({ id: `resp_${n}`, model: "muse-spark-1.3", status: "completed", output: items, usage }), { status: 200, headers: { "x-request-id": `req-${n}` } });
const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

describe("live smoke harness (mocked transport: this is not a live run)", () => {
  it("prints the skip message and exits 0 without a key, never touching the network", async () => {
    const f = vi.fn();
    const log = vi.fn();
    const r = await runLiveSmoke({}, { fetchImpl: f as unknown as typeof fetch, log });
    expect(r).toEqual({ skipped: true, exitCode: 0 });
    expect(log).toHaveBeenCalledWith(SKIP_MESSAGE);
    expect(f).not.toHaveBeenCalled();
    expect(SKIP_MESSAGE).toBe("MODEL_API_KEY not set; skipping live smoke");
  });

  it("runs the three steps, records ids/usage/cost and writes a sanitized trace file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smoke-"));
    try {
      const profile = JSON.stringify({ intent: "explore_crops", language: "ta", cropMentions: [], facts: [{ field: "area", text: "2 acre", number: 2, unit: "acre", sourceSpan: null }], needsEscalation: false, clarificationQuestion: null });
      const calls = [
        () => resp(1, [message(profile)]),
        () => resp(2, [{ type: "function_call", call_id: "call_1", name: "resolve_crop_identity", arguments: JSON.stringify({ text: "ginger", language: "en", context: null }) }]),
        () => resp(3, [message("Ginger resolves to one catalogue crop.")]),
        () => resp(4, [message("Red")]),
      ];
      let i = 0;
      const bodies: Record<string, unknown>[] = [];
      const f = vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return calls[i++]!();
      });
      const log = vi.fn();
      const r = await runLiveSmoke({ MODEL_API_KEY: KEY }, { fetchImpl: f as unknown as typeof fetch, log, outDir: dir, now: new Date("2026-10-30T10:00:00Z") });
      expect(r.exitCode).toBe(0);
      expect(r.report!.steps.map((s) => s.ok)).toEqual([true, true, true]);
      expect(r.report!.steps.flatMap((s) => s.requestIds)).toEqual(["req-1", "req-2", "req-3", "req-4"]);
      expect(r.report!.totalEstimatedUsd).toBeCloseTo(4 * (900 * 1.25 + 60 * 4.25) / 1_000_000, 6);
      expect(r.report!.totalEstimatedUsd).toBeLessThan(SMOKE_CAP_USD);
      expect(r.report!.costBasis).toBe("estimated_from_reported_usage_not_billed");
      expect(await readdir(dir)).toEqual(["meta-2026-10-30.json"]);
      const file = await readFile(join(dir, "meta-2026-10-30.json"), "utf8");
      expect(file).not.toContain(KEY);
      // second request chains with previous_response_id and function_call_output; image goes as a data URL
      expect(bodies[2]).toMatchObject({ previous_response_id: "resp_2", input: [{ type: "function_call_output", call_id: "call_1" }] });
      expect(JSON.stringify(bodies[3])).toContain("data:image/jpeg;base64,");
      expect(JSON.stringify(bodies[3])).not.toMatch(/https?:\/\//);
      expect(log.mock.calls.flat().join("\n")).toContain("requestIds=req-1,req-2,req-3,req-4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops before a call that could cross the $0.25 hard cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smoke-"));
    try {
      const f = vi.fn();
      const expensive = JSON.stringify({ "muse-spark-1.3": { kind: "tokens", inputPerMTokUsd: 100, outputPerMTokUsd: 100 } });
      const r = await runLiveSmoke({ MODEL_API_KEY: KEY, PRICE_TABLE_JSON: expensive }, { fetchImpl: f as unknown as typeof fetch, log: () => undefined, outDir: dir });
      expect(f).not.toHaveBeenCalled();
      expect(r.exitCode).toBe(1);
      expect(r.report!.steps.every((s) => !s.ok && /hard cap/.test(s.error ?? ""))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a provider failure is recorded, redacted, and fails the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smoke-"));
    try {
      const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 }));
      const r = await runLiveSmoke({ MODEL_API_KEY: KEY }, { fetchImpl: f as unknown as typeof fetch, log: () => undefined, outDir: dir });
      expect(r.exitCode).toBe(1);
      expect(JSON.stringify(r.report)).not.toContain(KEY);
      expect(await readFile(r.file!, "utf8")).not.toContain(KEY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
