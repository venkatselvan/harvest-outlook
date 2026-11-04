import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, sanitizedConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://u:pw-secret@localhost/db", SESSION_SECRET: "x".repeat(32) };

describe("loadConfig", () => {
  it("applies defaults and synthetic mode", () => {
    const c = loadConfig(base);
    expect(c.RUNTIME_MODE).toBe("synthetic");
    expect(c.PORT).toBe(8787);
    expect(c.FUTURE_LOOK_DAILY_LIMIT).toBe(24);
    expect(c.META_TEXT_MODEL).toBe("muse-spark-1.3");
    expect(c.ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("rejects a short session secret without echoing it", () => {
    const secret = "short-secret-value";
    try {
      loadConfig({ ...base, SESSION_SECRET: secret });
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("SESSION_SECRET");
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("rejects an unknown runtime mode and an over-allocated budget", () => {
    expect(() => loadConfig({ ...base, RUNTIME_MODE: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, BUDGET_DEV_ALLOCATION_USD: "140" })).toThrow(/BUDGET_TOTAL_USD/);
  });

  it("treats empty strings as unset so .env placeholders do not enable providers", () => {
    const c = loadConfig({ ...base, MODEL_API_KEY: "", ELEVENLABS_API_KEY: "" });
    expect(c.MODEL_API_KEY).toBeUndefined();
  });

  it("sanitizedConfig never contains secret values", () => {
    const c = loadConfig({ ...base, MODEL_API_KEY: "sk-very-secret", SESSION_SECRET: "s".repeat(40) });
    const json = JSON.stringify(sanitizedConfig(c));
    expect(json).not.toContain("sk-very-secret");
    expect(json).not.toContain("pw-secret");
    expect(json).not.toContain("s".repeat(40));
    expect(json).toContain('"MODEL_API_KEY_configured":true');
  });
});

it('accepts zero as unlimited or a positive image cap, rejecting negative and fractional counts',()=>{
  expect(loadConfig({...base,FUTURE_LOOK_DAILY_LIMIT:'0'}).FUTURE_LOOK_DAILY_LIMIT).toBe(0);
  expect(loadConfig({...base,FUTURE_LOOK_DAILY_LIMIT:'48'}).FUTURE_LOOK_DAILY_LIMIT).toBe(48);
  for(const value of ['-1','1.5','invalid']) expect(()=>loadConfig({...base,FUTURE_LOOK_DAILY_LIMIT:value})).toThrow(ConfigError);
});
