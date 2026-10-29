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

/** Fixtures are loadable only in synthetic runtime mode; any other mode throws before touching the database. */
export function assertSyntheticMode(runtimeMode: string): void {
  if (runtimeMode !== "synthetic") {
    throw new SyntheticFixtureError(`refusing to load synthetic fixtures when RUNTIME_MODE=${runtimeMode}; they are only for synthetic mode`);
  }
}

export interface FixtureCounts {
  market: { inserted: number; revisions: number; unchanged: number; rejected: number };
  weatherObservations: number;
  weatherForecasts: number;
}

export async function loadSyntheticFixtures(pool: Pool, runtimeMode: string, dir = FIXTURE_DIR): Promise<FixtureCounts> {
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
  let fc = 0;
  const loc = weather.data.location;
  for (const r of weather.data.records) {
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
      obs++;
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
  return { market: { inserted: stored.inserted, revisions: stored.revisions, unchanged: stored.unchanged, rejected: report.rejected.length }, weatherObservations: obs, weatherForecasts: fc };
}
