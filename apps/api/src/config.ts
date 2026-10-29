import { z } from "zod";

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
const positiveNum = (def: number) => z.coerce.number().positive().default(def);
const optionalString = z.string().trim().min(1).optional();

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
  META_IMAGE_MODEL: z.string().default("muse-image-1.0"),
  META_SEGMENT_MODEL: z.string().default("sam-3.1"),
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_STT_MODEL: optionalString,
  ELEVENLABS_TTS_MODEL: optionalString,
  ELEVENLABS_VOICE_ID: optionalString,
  BUDGET_TOTAL_USD: positiveNum(150),
  BUDGET_DEV_ALLOCATION_USD: positiveNum(120),
  BUDGET_DEMO_RESERVE_USD: positiveNum(30),
  BUDGET_PER_SESSION_USD: positiveNum(3),
  BUDGET_PER_OWNER_DAY_USD: positiveNum(10),
  /** Optional JSON object merged over the default price table (see services/pricing.ts). */
  PRICE_TABLE_JSON: optionalString,
  SESSION_TTL_DAYS: positiveInt(30),
  SESSION_CREATE_PER_HOUR: positiveInt(20),
  /** Non-browser tools (curl) send no Origin/Referer; accepted only when explicitly enabled. */
  ALLOW_MISSING_ORIGIN: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Set true only behind a trusted reverse proxy so req.ip honours X-Forwarded-For. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  MAX_UPLOAD_IMAGE_BYTES: positiveInt(10485760),
  MAX_VOICE_SECONDS: positiveInt(60),
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

/** Log-safe view: secrets replaced by booleans. */
export function sanitizedConfig(c: Config): Record<string, unknown> {
  const { SESSION_SECRET: _s, MODEL_API_KEY, ELEVENLABS_API_KEY, DATABASE_URL: _d, ...rest } = c;
  return { ...rest, MODEL_API_KEY_configured: !!MODEL_API_KEY, ELEVENLABS_API_KEY_configured: !!ELEVENLABS_API_KEY };
}
