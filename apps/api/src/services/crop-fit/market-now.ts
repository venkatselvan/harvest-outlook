import type { CropFitCandidate, Mode } from '@harvest/contracts';
import type { Pool } from '../../db/pool';
import { MARKET_PRICE_COLUMNS, scopedQuery } from '../../ingest/scope';
import { MIN_VALID_DAYS } from '../../plans/adapters/market-outlook';
import { canonicalMarketKey } from '../../providers/datagovin/market-alias';
import { districtKey, median, resolveStateName } from '../price-series';

/**
 * "Price now" for crop fit (ROUND2_SPEC.md 4.1 marketNow): the median wholesale mandi modal price (INR/kg) over the last
 * 14 trading days with quotes, from stored market_observations only (no new ingest, no provider call).
 *
 * Rows are read through the same mode-scoped, vintage-aware helper as services/price-series.ts (scopedQuery: live
 * never sees synthetic rows, replay needs the availability cutoff) and aggregated with the same rules: a row is valid
 * when modal > 0 and min <= modal <= max; a market-day value is the median of that market's valid rows on that date;
 * markets are state + canonicalMarketKey(name). priceSeries only buckets by week or month, so the 14-trading-day
 * median is computed here from the same rows. Scope: the farm's district when it has at least MIN_VALID_DAYS trading
 * days in the look-back, else the state.
 */
export const TRADING_DAYS = 14;
export const LOOKBACK_DAYS = 60;

type MarketNow = NonNullable<CropFitCandidate['marketNow']>;
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** node-postgres parses `date` as local midnight; read the local calendar fields back (as price-series.ts does). */
const dateOf = (v: unknown): string => (v instanceof Date ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10) : String(v).slice(0, 10));
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

interface Row { date: string; modal: number; marketKey: string; stateKey: string | null; districtKey: string | null }

export interface MarketNowArgs { productId: string; stateCode: string | null; districtName: string | null; asOf: string }

/** Pure aggregation over loaded rows (exported for tests). */
export function marketNowFromRows(rows: readonly Row[], args: { stateName: string | null; districtName: string | null }): MarketNow | null {
  const sk = args.stateName ? norm(args.stateName) : null;
  const dk = districtKey(args.districtName);
  if (!sk) return null;
  const state = rows.filter((r) => r.stateKey === sk);
  const district = dk ? state.filter((r) => r.districtKey === dk) : [];
  const days = (xs: readonly Row[]) => new Set(xs.map((r) => r.date)).size;
  const useDistrict = district.length > 0 && days(district) >= MIN_VALID_DAYS;
  const scope = useDistrict ? district : state;
  if (!scope.length) return null;
  const dates = [...new Set(scope.map((r) => r.date))].sort().reverse().slice(0, TRADING_DAYS);
  const keep = new Set(dates);
  const byMarketDay = new Map<string, number[]>();
  for (const r of scope) if (keep.has(r.date)) byMarketDay.set(`${r.marketKey}#${r.date}`, [...(byMarketDay.get(`${r.marketKey}#${r.date}`) ?? []), r.modal]);
  const values = [...byMarketDay.values()].map(median);
  const markets = new Set([...byMarketDay.keys()].map((k) => k.split('#')[0]!)).size;
  const p50 = Math.round(median(values) * 100) / 100;
  const latest = dates[0]!;
  const place = useDistrict ? `${args.districtName} district` : `${args.stateName}`;
  return { p50, date: latest, markets, scopeLabel: `${place} mandis, last ${dates.length} trading day${dates.length === 1 ? '' : 's'} to ${fmt(latest)}`.slice(0, 160) };
}

/** Reads one product's last LOOKBACK_DAYS of stored quotes and returns the 14-trading-day median, or null. */
export async function marketNow(pool: Pool, mode: Mode, args: MarketNowArgs): Promise<MarketNow | null> {
  const stateName = resolveStateName(args.stateCode);
  if (!stateName) return null;
  const product = (await pool.query<{ id: string }>('SELECT id::text AS id FROM crop_products WHERE slug=$1 LIMIT 1', [args.productId])).rows[0];
  if (!product) return null;
  const availableBy = mode === 'replay' ? new Date(`${args.asOf}T23:59:59.999Z`) : undefined;
  const raw = await scopedQuery(mode).marketObservations(pool, { productId: product.id, from: addDays(args.asOf, -LOOKBACK_DAYS), to: args.asOf, availableBy, columns: MARKET_PRICE_COLUMNS, shared: true });
  const rows: Row[] = [];
  for (const r of raw) {
    const modal = num(r.price_modal_inr_per_kg);
    const lo = num(r.price_min_inr_per_kg);
    const hi = num(r.price_max_inr_per_kg);
    if (modal === null || !Number.isFinite(modal) || !(modal > 0) || (lo !== null && lo > modal) || (hi !== null && modal > hi)) continue;
    const stateKey = r.state_name ? norm(String(r.state_name)) : null;
    rows.push({ date: dateOf(r.observed_on), modal, stateKey, districtKey: districtKey(r.district_name as string | null), marketKey: `${stateKey ?? ''}|${canonicalMarketKey(String(r.market_name ?? r.market_id))}` });
  }
  return marketNowFromRows(rows, { stateName, districtName: args.districtName });
}
