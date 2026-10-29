import type { Pool } from "../db/pool";
import type { MandiRow } from "../providers/datagovin/normalize";
import { emptyVintageCounts, insertVintage, tally, type VintageCounts } from "./vintage";

export interface MarketStoreCounts extends VintageCounts {
  /** Stored rows whose commodity mapping is unverified (validation_status='unverified_mapping'; hidden from default reads). */
  storedUnverifiedMapping: number;
  skippedNoProduct: number;
  skippedUnmapped: number;
  unresolvedProductSlugs: string[];
}

export interface MarketStoreOptions {
  sourceId: string;
  mode: "live" | "replay" | "synthetic";
  /** Availability of THIS fetch: the fetch time (live) or load time (fixtures). A changed value becomes a new vintage with this time. */
  availableAt: Date;
}

/**
 * Rows whose commodity maps to a product slug missing from crop_products are skipped and counted:
 * this code never invents catalogue entries. Re-ingest is vintage-preserving (./vintage.ts): a changed
 * price/arrivals/unit adds a new vintage; identical values add nothing. Rows from an unverified
 * commodity mapping are stored with validation_status='unverified_mapping' and are excluded from
 * default reads (scope.ts). validation_status is identity-level curation: it is set on all vintages of
 * the identity on every ingest (e.g. after a mapping is verified); source values are never rewritten.
 * `flags` stay per vintage as recorded by normalisation at ingest time.
 */
export async function storeMarketRows(pool: Pool, rows: MandiRow[], opts: MarketStoreOptions): Promise<MarketStoreCounts> {
  const counts: MarketStoreCounts = { ...emptyVintageCounts(), storedUnverifiedMapping: 0, skippedNoProduct: 0, skippedUnmapped: 0, unresolvedProductSlugs: [] };
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
    const validation = r.mappingVerified ? "valid" : "unverified_mapping";
    const o = await insertVintage(pool, {
      table: "market_observations",
      identity: {
        market_id: r.marketId, product_id: productId, observed_on: r.observedOn, source_id: opts.sourceId,
        variety_key: (r.variety ?? "").toLowerCase(), grade_key: (r.grade ?? "").toLowerCase(),
      },
      values: { price_min: r.priceMin, price_modal: r.priceModal, price_max: r.priceMax, arrivals: r.arrivals, unit: r.sourceUnit, arrivals_unit: r.arrivalsUnit },
      other: {
        is_synthetic: synthetic, mode: opts.mode, evidence_state: synthetic ? "illustrative" : "observed",
        market_name: r.marketName, state_name: r.state, district_name: r.district, variety: r.variety, grade: r.grade,
        price_min_inr_per_kg: r.priceMinPerKg, price_modal_inr_per_kg: r.priceModalPerKg, price_max_inr_per_kg: r.priceMaxPerKg,
        flags: JSON.stringify(r.flags), raw: JSON.stringify(r.raw), available_at: opts.availableAt,
      },
      hasRevisedAt: true,
      curation: { validation_status: validation },
    });
    tally(counts, o);
    if (o !== "unchanged" && validation !== "valid") counts.storedUnverifiedMapping++;
  }
  counts.unresolvedProductSlugs = [...unresolved].sort();
  return counts;
}
