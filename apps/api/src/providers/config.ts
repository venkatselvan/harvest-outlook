import { z } from "zod";

/**
 * Provider configuration for the public-data pipeline (T05a). Kept separate from src/config.ts so
 * the core config stays stable; keys here are optional and never required to boot the API.
 * No value from this module may be logged: use `sanitizedProviderConfig`.
 */
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

export const providerConfigSchema = z.object({
  /** data.gov.in free API key. Absent => the mandi adapter reports `api_key_missing` without any network call. */
  DATA_GOV_IN_API_KEY: z.string().trim().min(1).optional(),
  DATA_GOV_IN_BASE_URL: z.string().url().default("https://api.data.gov.in"),
  OPENMETEO_FORECAST_URL: z.string().url().default("https://api.open-meteo.com/v1/forecast"),
  OPENMETEO_ARCHIVE_URL: z.string().url().default("https://archive-api.open-meteo.com/v1/archive"),
  PROVIDER_TIMEOUT_MS: positiveInt(15_000),
  /** Retries after the first attempt. Hard-capped at 2 by the HTTP helper. */
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(2),
  OPENMETEO_ARCHIVE_TTL_SECONDS: positiveInt(24 * 3600),
  OPENMETEO_FORECAST_TTL_SECONDS: positiveInt(3 * 3600),
  DATA_GOV_IN_MAX_PAGES: positiveInt(20),
  DATA_GOV_IN_MAX_RECORDS: positiveInt(10_000),
  RUNTIME_MODE: z.enum(["live", "replay", "synthetic"]).default("synthetic"),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export function loadProviderConfig(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = providerConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid provider configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function sanitizedProviderConfig(c: ProviderConfig): Record<string, unknown> {
  const { DATA_GOV_IN_API_KEY, ...rest } = c;
  return { ...rest, DATA_GOV_IN_API_KEY_configured: !!DATA_GOV_IN_API_KEY };
}
