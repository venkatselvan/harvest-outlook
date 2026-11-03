import type { FarmWorkspace, ValueRecord,CurrentMandiQuotes } from '@harvest/contracts';
import type { Config } from '../config';
import type { Pool } from '../db/pool';
import type { FetchLike } from '../ingest/http';
import { pgCache } from '../ingest/cache';
import { storeForecast } from '../ingest/weather-store';
import { createWeatherSource } from '../plans/adapters/weather-source';
import { priceReferencesFor, type PriceDeps, type PriceReferenceBlock } from '../plans/adapters/market-outlook';
import { fetchForecast, OPENMETEO_ATTRIBUTION } from '../providers/openmeteo/client';
import {currentMandiQuotes} from './market-quotes';
import { getFarm } from './farms';
import { getWorkspace } from './workspace';
import { notFound } from './errors';

/**
 * One forecast day. The optional deeper fields are Open-Meteo model estimates for the grid cell, never field readings;
 * absent or null means the stored forecast did not carry them (the gust alert then notes `wind_gust_check_skipped`).
 */
export interface MonitoringWeatherDay {
  date: string; rainMm: number | null; tMinC: number | null; tMaxC: number | null; et0Mm: number | null;
  gustMaxKmh?: number | null; rhMeanPct?: number | null; soilMoisture0to7?: number | null;
}

export interface MonitoringSnapshot {
  mode: Config['RUNTIME_MODE'];
  farmId: string; checkedAt: string;
  weather: {
    status: 'fresh' | 'stale' | 'unavailable'; reason: string | null; issuedAt: string | null; attribution: string;
    point: { lat: number; lon: number } | null;
    coordinateBasis: 'farm_location' | 'boundary_center' | 'missing';
    days: MonitoringWeatherDay[];
  };
  market: { currentQuotes?:CurrentMandiQuotes;status: 'available' | 'stale' | 'unavailable'; reason: string | null; products: { productId: string; reference: PriceReferenceBlock }[] };
  meta: { status: 'available' | 'unavailable'; reason: string | null; automatic: false };
}

export interface MonitoringDeps { config: Config; pool: Pool; prices?: PriceDeps | undefined; fetchImpl?: FetchLike | undefined; now?: (() => Date) | undefined }

/** Explicit rotation products narrow market reads; unselected cycles/history retain crop-level coverage. */
export async function workspaceMarketProducts(pool: Pool, workspace: FarmWorkspace, includePreviousHarvest=true): Promise<string[]> {
  const crops=[...new Set([...workspace.cycles.filter(c=>!c.productId).map(c=>c.cropId),...workspace.rotationPlans.filter(r=>!r.productId).map(r=>r.cropId),...(includePreviousHarvest&&workspace.previousHarvest.status==='known'?[workspace.previousHarvest.cropId]:[])])];
  const selected=[...new Set([...workspace.cycles,...workspace.rotationPlans].flatMap(r=>r.productId?[r.productId]:[]))];
  if(!crops.length&&!selected.length)return [];
  const rows=await pool.query<{slug:string}>(`SELECT p.slug FROM crop_products p JOIN crop_identities c ON c.id=p.crop_id
    WHERE c.slug=ANY($1::text[]) OR c.id::text=ANY($1::text[]) OR p.slug=ANY($2::text[]) OR p.id::text=ANY($2::text[]) ORDER BY p.slug LIMIT 12`,[crops,selected]);
  return rows.rows.map(p=>p.slug);
}

/** A paused worker cannot leave an old forecast labelled fresh in future assistant turns. */
export function monitoringAt(snapshot: MonitoringSnapshot, asOf: string): MonitoringSnapshot {
  const copy = structuredClone(snapshot);
  const now = Date.parse(asOf);
  const today = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  copy.weather.days = copy.weather.days.filter((day) => day.date >= today);
  if (!copy.weather.days.length) { copy.weather.status = 'unavailable'; copy.weather.reason = 'forecast_horizon_expired'; }
  else if (now - Date.parse(copy.weather.issuedAt ?? copy.checkedAt) > 6 * 3600_000) { copy.weather.status = 'stale'; copy.weather.reason = 'forecast_refresh_overdue'; }
  const quotes = copy.market.products.flatMap((p) => p.reference.state === 'historical_reference' ? [p.reference.lastQuote.date] : []);
  if (quotes.length && quotes.every((date) => Date.parse(`${date}T00:00:00Z`) < now - 7 * 86400_000)) { copy.market.status = 'stale'; copy.market.reason = 'latest_quotes_older_than_seven_days'; }
  return copy;
}

/** Reads real forecasts only in live mode. Cache expiry and missing data are explicit. */
export async function monitoringSnapshot(deps: MonitoringDeps, ownerId: string, farmId: string): Promise<MonitoringSnapshot> {
  const { config, pool } = deps;
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace: FarmWorkspace = await getWorkspace(pool, ownerId, farmId);
  const now = (deps.now ?? (() => new Date()))();
  const checkedAt = now.toISOString();
  const today = new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const vertices = workspace.boundary?.coordinates[0]?.slice(0, -1);
  const point = vertices?.length ? { lon: vertices.reduce((s, p) => s + p[0], 0) / vertices.length, lat: vertices.reduce((s, p) => s + p[1], 0) / vertices.length }
    : farm.location.lat !== null && farm.location.lon !== null ? { lat: farm.location.lat, lon: farm.location.lon } : null;
  const weather: MonitoringSnapshot['weather'] = {
    status: 'unavailable', reason: point ? 'live_weather_requires_live_mode' : 'farm_coordinates_missing',
    issuedAt: null, attribution: OPENMETEO_ATTRIBUTION, point,
    coordinateBasis: !point ? 'missing' : vertices?.length ? 'boundary_center' : 'farm_location', days: [],
  };
  if (point && config.RUNTIME_MODE === 'live') {
    const forecast = await fetchForecast({ ...point, days: 7 }, { cache: pgCache(pool), fetchImpl: deps.fetchImpl, now: () => now });
    if (forecast.status === 'ok') {
      weather.status = forecast.data.stale ? 'stale' : 'fresh';
      weather.reason = forecast.data.stale ? 'provider_refresh_failed_using_cached_forecast' : null;
      weather.issuedAt = forecast.data.fetchedAt;
      weather.days = forecast.data.rows.filter((r) => r.validDate >= today).map((r) => ({ date: r.validDate, rainMm: r.values.precipitation_sum ?? null, tMinC: r.values.temperature_2m_min ?? null, tMaxC: r.values.temperature_2m_max ?? null, et0Mm: r.values.et0_fao_evapotranspiration ?? null, gustMaxKmh: r.values.wind_gusts_10m_max ?? null, rhMeanPct: r.values.relative_humidity_2m_mean ?? null, soilMoisture0to7: r.values.soil_moisture_0_to_7cm_mean ?? null }));
      await storeForecast(pool, forecast.data);
    } else {
      weather.reason = forecast.reason;
      // A prior successful forecast is still useful, but never reported as a current refresh.
      const stored = await createWeatherSource({ pool, mode: 'live', autoIngest: false }).getForecast({ farmId, districtId: farm.location.districtId, stateId: farm.location.stateCode, point }, { issuedAtOrBefore: checkedAt });
      if (stored) {
        weather.days = stored.days.filter((d) => d.date >= today).map((d) => ({ date: d.date, rainMm: d.rainMm, tMinC: d.tMinC, tMaxC: d.tMaxC, et0Mm: d.et0Mm, gustMaxKmh: d.agro?.gustMaxKmh ?? null, rhMeanPct: d.agro?.rhMeanPct ?? null, soilMoisture0to7: d.agro?.soilMoisture0to7 ?? null }));
        weather.issuedAt = stored.issuedAt;
        if (weather.days.length) weather.status = 'stale';
      }
    }
    if (!weather.days.length && weather.status !== 'unavailable') { weather.status = 'unavailable'; weather.reason = 'forecast_horizon_expired'; }
  }

  // Match only products belonging to crops this farmer is tracking, never substitute ginger globally.
  const cropIds = [...new Set([...workspace.cycles.map((c) => c.cropId), ...workspace.rotationPlans.map((r) => r.cropId), ...(workspace.previousHarvest.status === 'known' ? [workspace.previousHarvest.cropId] : [])])];
  const products = await workspaceMarketProducts(pool,workspace);
  const refs = deps.prices ? await priceReferencesFor(deps.prices.source, pool, config.RUNTIME_MODE, { productIds: products, issueDate: today, stateId: farm.location.stateCode, districtName: farm.location.districtName, keyConfigured: deps.prices.keyConfigured }) : {};
  const marketProducts = Object.entries(refs).map(([productId, reference]) => ({ productId, reference }));
  const available = marketProducts.filter((p) => p.reference.state === 'historical_reference');
  const stale = available.length && available.every((p) => p.reference.state === 'historical_reference' && Date.parse(`${p.reference.lastQuote.date}T00:00:00Z`) < now.getTime() - 7 * 86400_000);
  const market: MonitoringSnapshot['market'] = {
    status: !available.length ? 'unavailable' : stale ? 'stale' : 'available',
    reason: !cropIds.length ? 'no_tracked_crops' : !available.length ? 'qualified_market_quotes_missing' : stale ? 'latest_quotes_older_than_seven_days' : null,
    products: marketProducts,currentQuotes:await currentMandiQuotes({pool,config,fetchImpl:deps.fetchImpl as unknown as typeof fetch},ownerId,farmId),
  };
  return { mode: config.RUNTIME_MODE, farmId, checkedAt, weather, market, meta: { status: config.RUNTIME_MODE === 'live' && config.MODEL_API_KEY ? 'available' : 'unavailable', reason: config.RUNTIME_MODE !== 'live' ? 'live_meta_requires_live_mode' : !config.MODEL_API_KEY ? 'meta_key_missing' : null, automatic: false } };
}

/** Unit-bearing, server-origin quantities available to the existing independent numeric gate. */
export function monitoringReferences(snapshot: MonitoringSnapshot): ValueRecord[] {
  const refs: ValueRecord[] = [];
  for (const day of snapshot.weather.days) {
    for (const [key, unit] of [['rainMm', 'mm'], ['tMinC', 'celsius'], ['tMaxC', 'celsius'], ['et0Mm', 'mm']] as const) {
      const value = day[key];
      if (value === null) continue;
      refs.push({ schemaVersion: '1.0', kind: 'quantity', value, unit, evidenceState: 'forecast', scope: { level: 'farm', ids: [snapshot.farmId] }, validFrom: day.date, validTo: day.date, issuedAt: snapshot.weather.issuedAt, evidenceIds: [], assumptionIds: [], methodVersion: `open-meteo/${key}/${snapshot.weather.status}`, validationStatus: 'pending', missingReason: null });
    }
  }
  for (const product of snapshot.market.products) {
    if (product.reference.state !== 'historical_reference') continue;
    const quote = product.reference.lastQuote;
    refs.push({ schemaVersion: '1.0', kind: 'quantity', value: quote.inrPerKg, unit: 'INR/kg', evidenceState: 'observed', scope: { level: 'market', ids: [product.reference.marketId] }, validFrom: quote.date, validTo: quote.date, issuedAt: null, evidenceIds: quote.evidenceIds, assumptionIds: [], methodVersion: 'market-historical-reference/1', validationStatus: 'pending', missingReason: null });
  }
  return refs.slice(0, 50);
}
