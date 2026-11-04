import { z } from "zod";

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
const positiveNum = (def: number) => z.coerce.number().positive().default(def);
const optionalString = z.string().trim().min(1).optional();
const boolString = (def: "true" | "false") => z.enum(["true", "false"]).default(def).transform((v) => v === "true");

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RUNTIME_MODE: z.enum(["live", "replay", "synthetic"]).default("synthetic"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  STORAGE_FS_ROOT: z.string().default(".data/storage"),
  MODEL_API_KEY: optionalString,
  META_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
  META_TEXT_MODEL: z.string().default("muse-spark-1.3"),
  META_ESCALATION_MODEL: z.string().default("muse-wonder-1.0"),
  /** AI satellite predictions per crop cycle in a rolling 24 hours; 0 disables the count cap. */
  FUTURE_LOOK_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(24),
  META_IMAGE_MODEL: z.string().default("muse-image-1.0"),
  META_STT_MODEL: z.literal("muse-voice-transcribe-1.0").default("muse-voice-transcribe-1.0"),
  META_SEGMENT_MODEL: z.string().default("sam-3.1"),
  BUDGET_TOTAL_USD: positiveNum(150),
  BUDGET_DEV_ALLOCATION_USD: positiveNum(120),
  BUDGET_DEMO_RESERVE_USD: positiveNum(30),
  BUDGET_PER_SESSION_USD: positiveNum(3),
  BUDGET_PER_OWNER_DAY_USD: positiveNum(10),
  /** Daily cap per client IP (salted hash), across all guest sessions from that IP. */
  BUDGET_PER_IP_DAY_USD: positiveNum(15),
  /**
   * Global daily USD cap (UTC day) for the automatic per-farm grounded alert review run by the farm.monitor worker.
   * Counts reserved and settled spend tagged farm_alert_review; when reached, the structured checks still run and
   * the news review is reported as paused.
   */
  MONITOR_META_DAILY_CAP_USD: z.coerce.number().nonnegative().default(3),
  /** Optional JSON object merged over the default price table (see services/pricing.ts). */
  PRICE_TABLE_JSON: optionalString,
  SESSION_TTL_DAYS: positiveInt(30),
  /** auto: Secure in production, otherwise Secure unless the origin is localhost. Secure cookies use the __Host- prefix. */
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  NODE_ENV: z.string().optional(),
  /** Idempotency keys and their stored responses are purged after this many hours. */
  IDEMPOTENCY_TTL_HOURS: positiveInt(24),
  /** Worker job lease; handlers are heartbeated every third of it. */
  JOB_LEASE_SECONDS: positiveInt(30),
  SESSION_CREATE_PER_HOUR: positiveInt(20),
  /** Non-browser tools (curl) send no Origin/Referer; accepted only when explicitly enabled. */
  ALLOW_MISSING_ORIGIN: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Set true only behind a trusted reverse proxy so req.ip honours X-Forwarded-For. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  MAX_UPLOAD_IMAGE_BYTES: positiveInt(10485760),
  MAX_VOICE_SECONDS: positiveInt(60),
  /** Assistant loop ceilings (docs/AGENT_RUNTIME.md). Defaults match agent/limits.ts DEFAULT_LIMITS. */
  AGENT_MAX_TOOL_ROUNDS: positiveInt(6),
  AGENT_MAX_TOOL_CALLS: positiveInt(12),
  /** Clamped to 1 by the loop. */
  AGENT_MAX_WONDER_ESCALATIONS: z.coerce.number().int().nonnegative().default(1),
  AGENT_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().nonnegative().default(2),
  AGENT_WONDER_ENABLED: boolString("false"),
  AGENT_MAX_OUTPUT_TOKENS: positiveInt(6000),
  AGENT_INTERPRETATION_MAX_OUTPUT_TOKENS: positiveInt(2000),
  /** Ceiling of the one output-cap recovery per run (the cap is doubled once, at most this). */
  AGENT_MAX_OUTPUT_TOKENS_CEILING: positiveInt(16000),
  AGENT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "max"]).optional(),
  AGENT_RAIN_HORIZON_DAYS: positiveInt(7),
  ASSISTANT_TURNS_PER_MINUTE: positiveInt(20),
  /** Synthetic mode only: which recorded fixture scenario the FixtureProvider replays. Never a client input. */
  AGENT_FIXTURE_SCENARIO: z.string().trim().min(1).default("profile_extraction"),
  /** SAM adapter flags (docs/PHOTO_REGION.md). Several parameter placements are UNVERIFIED against the live API. */
  SAM_STREAM: boolString("true"),
  SAM_MASK_ENCODING: z.enum(["onebit", "lossless", "none"]).default("onebit"),
  SAM_INCLUDE_CONFIDENCE: boolString("true"),
  SAM_BASE85_VARIANT: z.enum(["auto", "ascii85", "z85", "rfc1924"]).default("auto"),
  SAM_BIT_ORDER: z.enum(["msb", "lsb"]).default("msb"),
  SAM_MAX_IMAGE_SIDE: z.coerce.number().int().min(128).max(1024).default(1024),
  SAM_TIMEOUT_MS: positiveInt(45_000),
  /** Weather adapter: number of complete past years used for daily climatology and an optional explicit last year. */
  WEATHER_CLIMATOLOGY_YEARS: z.coerce.number().int().min(5).max(30).default(10),
  WEATHER_CLIMATOLOGY_END_YEAR: z.coerce.number().int().min(1950).max(2100).optional(),
  PORT: positiveInt(8787),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
  }
}

/** Parses env. Error messages name variables and rules only, never the supplied values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (e.g. `KEY=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = configSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const c = parsed.data;
  if (c.BUDGET_DEV_ALLOCATION_USD + c.BUDGET_DEMO_RESERVE_USD > c.BUDGET_TOTAL_USD) {
    throw new ConfigError(["BUDGET_DEV_ALLOCATION_USD + BUDGET_DEMO_RESERVE_USD must not exceed BUDGET_TOTAL_USD"]);
  }
  if (c.STORAGE_DRIVER === "s3") {
    throw new ConfigError(["STORAGE_DRIVER=s3 is not implemented yet; use fs"]);
  }
  return c;
}

/** The agent-limit env keys as a string map, so agent/limits.ts parses from the already-validated config. */
export function agentEnvFromConfig(c: Config): Record<string, string | undefined> {
  return {
    AGENT_MAX_TOOL_ROUNDS: String(c.AGENT_MAX_TOOL_ROUNDS),
    AGENT_MAX_TOOL_CALLS: String(c.AGENT_MAX_TOOL_CALLS),
    AGENT_MAX_WONDER_ESCALATIONS: String(c.AGENT_MAX_WONDER_ESCALATIONS),
    AGENT_MAX_REPAIR_ATTEMPTS: String(c.AGENT_MAX_REPAIR_ATTEMPTS),
    AGENT_WONDER_ENABLED: String(c.AGENT_WONDER_ENABLED),
    AGENT_MAX_OUTPUT_TOKENS: String(c.AGENT_MAX_OUTPUT_TOKENS),
    AGENT_INTERPRETATION_MAX_OUTPUT_TOKENS: String(c.AGENT_INTERPRETATION_MAX_OUTPUT_TOKENS),
    AGENT_MAX_OUTPUT_TOKENS_CEILING: String(c.AGENT_MAX_OUTPUT_TOKENS_CEILING),
    AGENT_REASONING_EFFORT: c.AGENT_REASONING_EFFORT,
    AGENT_RAIN_HORIZON_DAYS: String(c.AGENT_RAIN_HORIZON_DAYS),
    ASSISTANT_TURNS_PER_MINUTE: String(c.ASSISTANT_TURNS_PER_MINUTE),
  };
}

/** SAM flags as the env map `samOptionsFromEnv` expects. */
export function samEnvFromConfig(c: Config): Record<string, string | undefined> {
  return {
    SAM_STREAM: String(c.SAM_STREAM),
    SAM_MASK_ENCODING: c.SAM_MASK_ENCODING,
    SAM_INCLUDE_CONFIDENCE: String(c.SAM_INCLUDE_CONFIDENCE),
    SAM_BASE85_VARIANT: c.SAM_BASE85_VARIANT,
    SAM_BIT_ORDER: c.SAM_BIT_ORDER,
    SAM_MAX_IMAGE_SIDE: String(c.SAM_MAX_IMAGE_SIDE),
    SAM_TIMEOUT_MS: String(c.SAM_TIMEOUT_MS),
  };
}

/** Log-safe view: secrets replaced by booleans. */
export function sanitizedConfig(c: Config): Record<string, unknown> {
  const { SESSION_SECRET: _s, MODEL_API_KEY, DATABASE_URL: _d, ...rest } = c;
  return { ...rest, MODEL_API_KEY_configured: !!MODEL_API_KEY };
}
