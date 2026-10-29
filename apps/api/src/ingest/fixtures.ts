import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Pool } from "../db/pool";
import { normalizeMandiRecords } from "../providers/datagovin/normalize";
import { storeMarketRows } from "./market-store";
import { ensureSource, SYNTHETIC_SOURCE_ID } from "./sources";
import { insertVintage } from "./vintage";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(here, "../../../../data/fixtures/synthetic");
export const SYNTHETIC_PRODUCT_SLUG = "synthetic-ginger-like";

export class SyntheticFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticFixtureError";
  }
}

const marker = {
  synthetic: z.literal(true),
  sourceId: z.literal(SYNTHETIC_SOURCE_ID),
};

const marketFixture = z.object({
  ...marker,
  fixture: z.literal("market_synthetic_ginger_like"),
  label: z.string().min(1),
  seed: z.number().int(),
  records: z.array(z.object({ ...marker }).passthrough()).min(1),
});

const weatherRecord = z.object({
  ...marker,
  kind: z.enum(["observation", "forecast"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  issuedAt: z.string().datetime({ offset: true }).optional(),
  values: z.record(z.string(), z.number().nullable()),
  units: z.record(z.string(), z.string()),
});

const weatherFixture = z.object({
  ...marker,
  fixture: z.literal("weather_synthetic_hassan_like"),
  label: z.string().min(1),
  seed: z.number().int(),
  location: z.object({ key: z.string().min(1), lat: z.number(), lon: z.number() }),
  records: z.array(weatherRecord).min(1),
});

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const SYNTHETIC_WEATHER_UNITS = { precipitation_sum: "mm", temperature_2m_max: "°C", temperature_2m_min: "°C", et0_fao_evapotranspiration: "mm", shortwave_radiation_sum: "MJ/m²" } as const;
/** Current calendar date in India (the app's day boundary). */
export const istDate = (d: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
/** Observation window relative to the seed date: today-120 .. today-1 with a labelled gap, plus 3 forecast days from today. */
export const SYNTHETIC_WEATHER_WINDOW = { observedDaysBack: 120, gapFromDaysBack: 60, gapToDaysBack: 51, forecastDays: 3 } as const;

/**
 * Deterministic synthetic weather relative to `today` (IST date, YYYY-MM-DD): same seed gives the same weather *shape* on any day,
 * with dates shifted so the season explorer always shows observed, gap, forecast and scenario bands. Every number is invented.
 * The gap (no stored observation for those dates) is intentional: the UI must show "No record", not fill it.
 */
export function generateSyntheticWeather(today: string, seed: number): z.infer<typeof weatherRecord>[] {
  const rnd = mulberry32(seed);
  const w = SYNTHETIC_WEATHER_WINDOW;
  const day = (i: number) => {
    const wet = rnd() < 0.3 + 0.2 * Math.sin((i / 60) * Math.PI);
    const rain = wet ? Math.round(rnd() * 180) / 10 : 0;
    const tmax = Math.round((27 + 3 * Math.sin(i / 9) - (rain > 5 ? 2 : 0) + (rnd() - 0.5) * 2) * 10) / 10;
    return {
      precipitation_sum: rain,
      temperature_2m_max: tmax,
      temperature_2m_min: Math.round((tmax - 8 + (rnd() - 0.5)) * 10) / 10,
      et0_fao_evapotranspiration: Math.round((4.2 - (rain > 5 ? 1.2 : 0) + (rnd() - 0.5)) * 100) / 100,
      shortwave_radiation_sum: Math.round((19 - (rain > 5 ? 5 : 0) + (rnd() - 0.5) * 3) * 100) / 100,
    };
  };
  const units: Record<string, string> = { ...SYNTHETIC_WEATHER_UNITS };
  const out: z.infer<typeof weatherRecord>[] = [];
  for (let back = w.observedDaysBack; back >= 1; back--) {
    const values = day(w.observedDaysBack - back); // always advance the PRNG so the gap does not shift later days
    if (back <= w.gapFromDaysBack && back >= w.gapToDaysBack) continue;
    out.push({ synthetic: true, sourceId: SYNTHETIC_SOURCE_ID, kind: "observation", date: addDays(today, -back), values, units });
  }
  const issuedAt = `${today}T00:00:00+05:30`; // start of the IST day, never in the future
  for (let i = 0; i < w.forecastDays; i++) out.push({ synthetic: true, sourceId: SYNTHETIC_SOURCE_ID, kind: "forecast", issuedAt, date: addDays(today, i), values: day(w.observedDaysBack + i), units });
  return out;
}

/** Number of complete prior calendar years of synthetic daily observations generated for the climatology scenario band. */
export const SYNTHETIC_CLIMATOLOGY_YEARS = 5;

/**
 * Synthetic multi-year "climatology" history: full calendar years (today.year-5 .. today.year-1), one daily observation each,
 * from a separate seeded stream. Dates inside the recent observation window are skipped so they never collide with it.
 * Every number is invented; it only makes the seasonal-scenario band demonstrable (weather adapter needs >=5 years x 300 rows).
 */
export function generateSyntheticClimatology(today: string, seed: number): z.infer<typeof weatherRecord>[] {
  const windowStart = addDays(today, -SYNTHETIC_WEATHER_WINDOW.observedDaysBack);
  const thisYear = Number(today.slice(0, 4));
  const units: Record<string, string> = { ...SYNTHETIC_WEATHER_UNITS };
  const out: z.infer<typeof weatherRecord>[] = [];
  for (let y = thisYear - SYNTHETIC_CLIMATOLOGY_YEARS; y < thisYear; y++) {
    const rnd = mulberry32(seed + 1000 * (y - 2000));
    for (let d = `${y}-01-01`, i = 0; d < `${y + 1}-01-01`; d = addDays(d, 1), i++) {
      const season = Math.sin(((i - 120) / 365) * 2 * Math.PI); // wet mid-year, dry ends
      const wet = rnd() < 0.3 + 0.2 * season;
      const rain = wet ? Math.round(rnd() * 180) / 10 : 0;
      const tmax = Math.round((27 + 3 * Math.sin(i / 9) - (rain > 5 ? 2 : 0) + (rnd() - 0.5) * 2) * 10) / 10;
      if (d >= windowStart) continue; // later dates are all inside the window too, so skipping never shifts a kept day
      out.push({
        synthetic: true, sourceId: SYNTHETIC_SOURCE_ID, kind: "observation", date: d,
        values: {
          precipitation_sum: rain,
          temperature_2m_max: tmax,
          temperature_2m_min: Math.round((tmax - 8 + (rnd() - 0.5)) * 10) / 10,
          et0_fao_evapotranspiration: Math.round((4.2 - (rain > 5 ? 1.2 : 0) + (rnd() - 0.5)) * 100) / 100,
          shortwave_radiation_sum: Math.round((19 - (rain > 5 ? 5 : 0) + (rnd() - 0.5) * 3) * 100) / 100,
        },
        units,
      });
    }
  }
  return out;
}

/** Fixtures are loadable only in synthetic runtime mode; any other mode throws before touching the database. */
export function assertSyntheticMode(runtimeMode: string): void {
  if (runtimeMode !== "synthetic") {
    throw new SyntheticFixtureError(`refusing to load synthetic fixtures when RUNTIME_MODE=${runtimeMode}; they are only for synthetic mode`);
  }
}

export interface FixtureCounts {
  market: { inserted: number; revisions: number; unchanged: number; rejected: number };
  weatherObservations: number;
  /** Synthetic prior-year daily observations (climatology scenario support); not part of the recent window. */
  weatherClimatologyObservations: number;
  weatherForecasts: number;
}

export async function loadSyntheticFixtures(pool: Pool, runtimeMode: string, dir = FIXTURE_DIR, today: string = istDate()): Promise<FixtureCounts> {
  assertSyntheticMode(runtimeMode);
  const read = async (f: string) => JSON.parse(await readFile(resolve(dir, f), "utf8")) as unknown;
  const market = marketFixture.safeParse(await read("market_synthetic_ginger_like.json"));
  if (!market.success) throw new SyntheticFixtureError(`market fixture is not marked synthetic or is malformed: ${market.error.issues[0]?.message}`);
  const weather = weatherFixture.safeParse(await read("weather_synthetic_hassan_like.json"));
  if (!weather.success) throw new SyntheticFixtureError(`weather fixture is not marked synthetic or is malformed: ${weather.error.issues[0]?.message}`);

  const sourceId = await ensureSource(pool, SYNTHETIC_SOURCE_ID, {
    title: "Synthetic development fixtures",
    publisher: "Harvest Outlook (generated)",
    url: "local:data/fixtures/synthetic",
    licence: "synthetic, not real data",
    metadata: { synthetic: true },
  });
  const now = new Date();

  // Isolated synthetic catalogue entry; never reuses a real crop/product slug.
  const crop = await pool.query<{ id: string }>(
    `INSERT INTO crop_identities (slug, names, category) VALUES ($1,$2::jsonb,'synthetic')
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
    [SYNTHETIC_PRODUCT_SLUG, JSON.stringify({ en: "Synthetic ginger-like crop (fixture)" })],
  );
  await pool.query(
    `INSERT INTO crop_products (crop_id, slug, name, form, unit) VALUES ($1,$2,'Synthetic ginger-like product (fixture)','synthetic','quintal')
     ON CONFLICT (slug) DO NOTHING`,
    [crop.rows[0]!.id, SYNTHETIC_PRODUCT_SLUG],
  );

  const report = normalizeMandiRecords(market.data.records as Array<Record<string, unknown>>, {
    commodityMap: [{ sourceCommodity: "SyntheticGingerLike", productSlug: SYNTHETIC_PRODUCT_SLUG, verified: true }],
    sourceUnitVerified: true,
  });
  const stored = await storeMarketRows(pool, report.rows, { sourceId, mode: "synthetic", availableAt: now });

  let obs = 0;
  let clim = 0;
  let fc = 0;
  const loc = weather.data.location;
  // Dates move with the seed date, so earlier synthetic weather rows would linger as stale bands: replace them (synthetic rows only).
  await pool.query("DELETE FROM weather_observations WHERE is_synthetic AND location_key=$1", [loc.key]);
  await pool.query("DELETE FROM weather_forecasts WHERE is_synthetic AND location_key=$1", [loc.key]);
  // The committed weather JSON is a template (label, location, seed); the rows are generated here, relative to the seed date.
  const recent = generateSyntheticWeather(today, weather.data.seed);
  const climatology = generateSyntheticClimatology(today, weather.data.seed);
  const climSet = new Set(climatology);
  for (const r of [...recent, ...climatology]) {
    const meta = { synthetic: true, label: weather.data.label, units: r.units, seed: weather.data.seed, measurementKind: "synthetic" };
    // Same vintage rules as real rows (./vintage.ts): identical values add nothing, changed values add a vintage.
    if (r.kind === "observation") {
      await insertVintage(pool, {
        table: "weather_observations",
        identity: { location_key: loc.key, observed_on: r.date, source_id: sourceId },
        values: { variables: JSON.stringify(r.values) },
        other: { lon: loc.lon, lat: loc.lat, is_synthetic: true, mode: "synthetic", evidence_state: "illustrative", measurement_kind: "synthetic", available_at: now, meta: JSON.stringify(meta) },
        hasRevisedAt: true,
      });
      if (climSet.has(r)) clim++;
      else obs++;
    } else {
      if (!r.issuedAt) throw new SyntheticFixtureError("synthetic forecast record needs issuedAt");
      await insertVintage(pool, {
        table: "weather_forecasts",
        identity: { location_key: loc.key, issued_at: r.issuedAt, valid_on: r.date, source_id: sourceId },
        values: { variables: JSON.stringify(r.values) },
        other: { lon: loc.lon, lat: loc.lat, is_synthetic: true, mode: "synthetic", evidence_state: "illustrative", available_at: now, horizon_days: null, meta: JSON.stringify(meta) },
      });
      fc++;
    }
  }
  return { market: { inserted: stored.inserted, revisions: stored.revisions, unchanged: stored.unchanged, rejected: report.rejected.length }, weatherObservations: obs, weatherClimatologyObservations: clim, weatherForecasts: fc };
}
