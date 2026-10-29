import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runRoundtrip } from "../src/speech/roundtrip";
import { checkFields, normaliseText, scoreCase, wer, type SpeechCase } from "../src/speech/score";
import type { SpeechProvider } from "../src/speech/provider";
import { makeWav } from "../src/speech/audio";

const load = (l: string) => JSON.parse(readFileSync(new URL(`../../../evals/cases/speech/${l}.json`, import.meta.url), "utf8")) as { language: string; cases: SpeechCase[] };

describe("qualification case files", () => {
  it.each(["en", "ta", "hi"])("%s has at least 12 well-formed cases covering numbers, units, dates, crops", (l) => {
    const f = load(l);
    expect(f.language).toBe(l);
    expect(f.cases.length).toBeGreaterThanOrEqual(12);
    const ids = new Set(f.cases.map((c) => c.id));
    expect(ids.size).toBe(f.cases.length);
    for (const c of f.cases) {
      expect(c.id.startsWith(`${l}-`)).toBe(true);
      expect(c.expect.length).toBeGreaterThan(0);
      for (const x of c.expect) expect(x.anyOf.length).toBeGreaterThan(0);
      // Each reference text must satisfy its own expectations, otherwise the case can never pass.
      expect(scoreCase(c, c.text).fieldsPassed, c.id).toBe(true);
    }
    const tags = new Set(f.cases.flatMap((c) => c.tags));
    for (const t of ["number", "unit", "date", "crop", "codeswitch"]) expect(tags.has(t), `${l} lacks ${t}`).toBe(true);
  });
});

describe("scoring", () => {
  it("wer counts substitutions and ignores case/punctuation", () => {
    expect(wer("I planted ginger", "i planted, GINGER!")).toBe(0);
    expect(wer("one two three four", "one too three four")).toBe(0.25);
    expect(wer("a b", "")).toBe(1);
  });
  it("normalises Indic digits and thousands separators", () => {
    expect(normaliseText("₹ 6,500")).toContain("6500");
    expect(normaliseText("१५ जून")).toBe("15 जून");
    expect(normaliseText("௧௫")).toBe("15");
  });
  it("field hits need whole numeric tokens: 15 must not match 2015", () => {
    const c: SpeechCase = { id: "x", text: "", tags: [], expect: [{ kind: "number", normalized: "15", anyOf: ["15"] }] };
    expect(checkFields(c, "sown in 2015")[0]!.hit).toBe(false);
    expect(checkFields(c, "sown on 15 june")[0]!.hit).toBe(true);
  });
  it("a wrong unit fails the case even with low WER", () => {
    const c = load("en").cases[0]!; // 2 acres ginger April
    expect(scoreCase(c, "I planted ginger on 2 hectares in April").fieldsPassed).toBe(false);
  });
});

describe("round-trip runner", () => {
  const fake = (over: Partial<SpeechProvider> = {}): SpeechProvider => ({
    name: "elevenlabs",
    live: true,
    sttModel: "m",
    ttsModel: "m",
    synthesize: async (i) => ({ audio: new Uint8Array(makeWav(0.2)), contentType: "audio/wav", characters: i.text.length, model: "m", requestId: null }),
    transcribe: async () => ({ transcript: "I planted ginger on 2 acres in April", detectedLanguage: "eng", languageProbability: 0.9, providerName: "elevenlabs", model: "m", requestId: null, synthetic: false }),
    ...over,
  });
  const items = load("en").cases.slice(0, 5).map((c) => ({ language: "en" as const, case: c }));

  it("never exceeds the call cap", async () => {
    let n = 0;
    const p = fake({ synthesize: async (i) => (n++, { audio: new Uint8Array(makeWav(0.2)), contentType: "audio/wav", characters: i.text.length, model: "m", requestId: null }) });
    const rows = await runRoundtrip(p, "v", items, { maxCalls: 3 });
    expect(rows).toHaveLength(3);
    expect(n).toBe(3);
    expect(rows[0]!.score.fieldsPassed).toBe(true);
    expect(rows[0]!.detectedLanguage).toBe("en");
  });

  it("records provider errors as failed rows instead of throwing", async () => {
    const p = fake({ transcribe: async () => Promise.reject(Object.assign(new Error("x"), { code: "provider_rate_limited" })) });
    const rows = await runRoundtrip(p, "v", items, { maxCalls: 2 });
    expect(rows.map((r) => r.error)).toEqual(["provider_rate_limited", "provider_rate_limited"]);
    expect(rows[0]!.score.fieldsPassed).toBe(false);
  });
});
