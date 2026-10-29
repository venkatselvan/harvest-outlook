import type { Pool } from "../db/pool";
import type { MandiRow } from "../providers/datagovin/normalize";

export interface MarketStoreCounts {
  inserted: number;
  updated: number;
  skippedNoProduct: number;
  skippedUnmapped: number;
  unresolvedProductSlugs: string[];
}

export interface MarketStoreOptions {
  sourceId: string;
  mode: "live" | "replay" | "synthetic";
  /** First availability: the fetch time (live) or load time (fixtures). Not overwritten on re-ingest. */
  availableAt: Date;
}

/**
 * Rows whose commodity maps to a product slug missing from crop_products are skipped and counted:
 * this code never invents catalogue entries. Re-ingest updates prices and keeps the first available_at.
 */
export async function storeMarketRows(pool: Pool, rows: MandiRow[], opts: MarketStoreOptions): Promise<MarketStoreCounts> {
  const counts: MarketStoreCounts = { inserted: 0, updated: 0, skippedNoProduct: 0, skippedUnmapped: 0, unresolvedProductSlugs: [] };
  const slugs = [...new Set(rows.map((r) => r.productSlug).filter((s): s is string => !!s))];
  const products = new Map<string, string>();
  if (slugs.length) {
    const r = await pool.query<{ id: string; slug: string }>("SELECT id, slug FROM crop_products WHERE slug = ANY($1::text[])", [slugs]);
    for (const p of r.rows) products.set(p.slug, p.id);
  }
  const unresolved = new Set<string>();
  const synthetic = opts.mode === "synthetic";
  for (const r of rows) {
    if (!r.productSlug) {
      counts.skippedUnmapped++;
      continue;
    }
    const productId = products.get(r.productSlug);
    if (!productId) {
      counts.skippedNoProduct++;
      unresolved.add(r.productSlug);
      continue;
    }
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO market_observations
         (market_id, product_id, observed_on, source_id, price_min, price_modal, price_max, arrivals, unit, is_synthetic, mode,
          evidence_state, market_name, state_name, district_name, variety, grade, variety_key, grade_key,
          price_min_inr_per_kg, price_modal_inr_per_kg, price_max_inr_per_kg, arrivals_unit, flags, raw, available_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26)
       ON CONFLICT (market_id, product_id, observed_on, source_id, variety_key, grade_key) DO UPDATE SET
         price_min=EXCLUDED.price_min, price_modal=EXCLUDED.price_modal, price_max=EXCLUDED.price_max, arrivals=EXCLUDED.arrivals,
         price_min_inr_per_kg=EXCLUDED.price_min_inr_per_kg, price_modal_inr_per_kg=EXCLUDED.price_modal_inr_per_kg,
         price_max_inr_per_kg=EXCLUDED.price_max_inr_per_kg, arrivals_unit=EXCLUDED.arrivals_unit,
         flags=EXCLUDED.flags, raw=EXCLUDED.raw
       RETURNING (xmax = 0) AS inserted`,
      [
        r.marketId, productId, r.observedOn, opts.sourceId, r.priceMin, r.priceModal, r.priceMax, r.arrivals, r.sourceUnit, synthetic, opts.mode,
        synthetic ? "illustrative" : "observed", r.marketName, r.state, r.district, r.variety, r.grade, (r.variety ?? "").toLowerCase(), (r.grade ?? "").toLowerCase(),
        r.priceMinPerKg, r.priceModalPerKg, r.priceMaxPerKg, r.arrivalsUnit, JSON.stringify(r.flags), JSON.stringify(r.raw), opts.availableAt,
      ],
    );
    res.rows[0]!.inserted ? counts.inserted++ : counts.updated++;
  }
  counts.unresolvedProductSlugs = [...unresolved].sort();
  return counts;
}
