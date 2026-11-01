import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SoilRating, type FarmSoilMarkers, type NutrientNeed, type SoilCheck, type SoilMarker } from '@harvest/contracts';
import { REPO_ROOT } from '../../catalogue/files';
import { DATA_FILES } from '../year-plan/data';
import { hasUnresolvedSoilWarnings } from '../soil-normalization';

/**
 * Soil comparison for crop fit (ROUND2_SPEC.md 4.1). Each confirmed field marker among pH, EC, organic carbon,
 * available N, P and K and the available micronutrients is rated by the soil-ratings module (packet P6, injected as
 * `rate`), and compared with the crop's need:
 *  - need class from crop-agronomy.json nutrientUptake scaled by the regional p50 yield: N < 60 low, 60 to 120 medium,
 *    > 120 high kg/ha; P2O5 < 30, 30 to 60, > 60; K2O < 60, 60 to 120, > 120 (boundaries inclusive in the medium class);
 *  - verdict: `short` when the soil rates low and the need is high, `watch` when low/medium soil meets a medium/high need,
 *    `ok` otherwise, `unknown` when the rating or the need is missing;
 *  - pH: inside the crop's cited range ok, outside watch (the range and source in the note), no cited range unknown.
 * Samples are never averaged: the most recent confirmed sample that carries a parameter supplies it.
 */

export type Nutrient = 'N' | 'P2O5' | 'K2O';
/**
 * One comparison row. `parameters` are tried in order: the available form first, then a form the ratings module may
 * rate as the available one with an explicit assumption (rateMarkerAssumed: nitrogen without a printed pool, total P,
 * total K), so a report that prints only those still gets a row with the assumption shown.
 */
interface ParamDef { key: string; parameters: readonly string[]; labels: Readonly<Record<string, string>>; nutrient?: Nutrient }
export const SOIL_PARAMETERS: readonly ParamDef[] = [
  { key: 'ph', parameters: ['ph'], labels: { ph: 'Soil pH' } },
  { key: 'ec', parameters: ['electrical_conductivity'], labels: { electrical_conductivity: 'Salinity (EC)' } },
  { key: 'oc', parameters: ['organic_carbon', 'organic_matter'], labels: { organic_carbon: 'Organic carbon', organic_matter: 'Organic matter' } },
  { key: 'n', parameters: ['nitrogen_available', 'nitrogen_unspecified'], labels: { nitrogen_available: 'Available nitrogen', nitrogen_unspecified: 'Nitrogen (pool not printed)' }, nutrient: 'N' },
  { key: 'p', parameters: ['phosphorus_available', 'phosphorus_total'], labels: { phosphorus_available: 'Available phosphorus', phosphorus_total: 'Total phosphorus' }, nutrient: 'P2O5' },
  { key: 'k', parameters: ['potassium_available', 'potassium_total'], labels: { potassium_available: 'Available potassium', potassium_total: 'Total potassium' }, nutrient: 'K2O' },
  { key: 's', parameters: ['sulphur_available'], labels: { sulphur_available: 'Available sulphur' } },
  { key: 'zn', parameters: ['zinc_available'], labels: { zinc_available: 'Available zinc' } },
  { key: 'fe', parameters: ['iron_available'], labels: { iron_available: 'Available iron' } },
  { key: 'mn', parameters: ['manganese_available'], labels: { manganese_available: 'Available manganese' } },
  { key: 'cu', parameters: ['copper_available'], labels: { copper_available: 'Available copper' } },
  { key: 'b', parameters: ['boron_available'], labels: { boron_available: 'Available boron' } },
];
/** Uptake thresholds in kg/ha (ROUND2_SPEC 4.1): below `low` is low, above `high` is high, otherwise medium. */
export const NEED_THRESHOLDS: Record<Nutrient, { low: number; high: number }> = { N: { low: 60, high: 120 }, P2O5: { low: 30, high: 60 }, K2O: { low: 60, high: 120 } };

// ------------------------------------------------------------------ nutrient uptake (crop-agronomy.json, read-only)
const Uptake = z.object({ basis: z.string(), yieldT: z.number().positive().optional(), N: z.number().optional(), P2O5: z.number().optional(), K2O: z.number().optional(), unit: z.string().optional(), source: z.string().optional(), note: z.string().optional() });
export type NutrientUptake = z.output<typeof Uptake>;
let uptakeCache: Map<string, NutrientUptake> | null = null;
/** Clears the cache; with `fixtures` (cropId -> raw uptake) later reads use them instead of the file (tests). */
export function setUptakeFixtures(fixtures: Record<string, unknown> | null): void {
  uptakeCache = fixtures ? new Map(Object.entries(fixtures).flatMap(([k, v]) => { const r = Uptake.safeParse(v); return r.success ? [[k, r.data] as const] : []; })) : null;
}
export function nutrientUptake(cropId: string): NutrientUptake | null {
  if (!uptakeCache) {
    const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, DATA_FILES.agronomy), 'utf8')) as { crops?: { cropId?: string; nutrientUptake?: unknown }[] };
    uptakeCache = new Map((raw.crops ?? []).flatMap((c) => { const r = Uptake.safeParse(c.nutrientUptake); return c.cropId && r.success ? [[c.cropId, r.data] as const] : []; }));
  }
  return uptakeCache.get(cropId) ?? null;
}

/**
 * Uptake of one nutrient at a yield (kg/ha of the product): per-tonne rows scale with the yield; rows stated at a yield
 * (per_ha_at_stated_yield) scale linearly from that yield (an engine assumption, named in the note). Null when the row
 * or the yield is missing.
 */
export function uptakeAt(u: NutrientUptake | null, nutrient: Nutrient, yieldKgPerHa: number | null): { kgPerHa: number; scaled: 'per_tonne' | 'linear_from_stated_yield' } | null {
  const v = u?.[nutrient];
  if (!u || v == null || yieldKgPerHa == null || !(yieldKgPerHa > 0)) return null;
  if (u.basis.startsWith('per_tonne')) return { kgPerHa: (v * yieldKgPerHa) / 1000, scaled: 'per_tonne' };
  if (u.basis === 'per_ha_at_stated_yield' && u.yieldT) return { kgPerHa: (v * yieldKgPerHa) / 1000 / u.yieldT, scaled: 'linear_from_stated_yield' };
  return null;
}
export function needClass(nutrient: Nutrient, kgPerHa: number): NutrientNeed {
  const t = NEED_THRESHOLDS[nutrient];
  return kgPerHa < t.low ? 'low' : kgPerHa > t.high ? 'high' : 'medium';
}

// ------------------------------------------------------------------ ratings (P6 soil-ratings.ts, injected)
export interface RatedMarker { rating: SoilRating; status: string; source: SoilCheck['ratingSource']; note: string | null; assumption: string | null }
/** Shape of soil-ratings.ts rateMarker (P6); read defensively so a field added there does not break crop fit. */
export type RateMarkerFn = (marker: SoilMarker) => { rating?: unknown; status?: unknown; source?: unknown; note?: unknown; assumption?: unknown } | null | undefined;
const RATINGS = new Set<string>(SoilRating.options);
const urlOrNull = (u: unknown): string | null => { if (typeof u !== 'string') return null; try { return /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; } };
export function normaliseRating(raw: ReturnType<RateMarkerFn>): RatedMarker {
  const rating = typeof raw?.rating === 'string' && RATINGS.has(raw.rating) ? (raw.rating as SoilRating) : 'unrated';
  const s = raw?.source as { id?: unknown; title?: unknown; url?: unknown } | null | undefined;
  const source = s && typeof s.id === 'string' && s.id ? { id: s.id.slice(0, 80), title: (typeof s.title === 'string' && s.title ? s.title : s.id).slice(0, 200), url: urlOrNull(s.url) } : null;
  const note = typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
  // An explicit assumption (rateMarkerAssumed) wins; a rated marker's note is also an assumption (method or element form).
  const assumption = typeof raw?.assumption === 'string' && raw.assumption.trim() ? raw.assumption.trim() : rating !== 'unrated' ? note : null;
  return { rating, status: typeof raw?.status === 'string' ? raw.status.slice(0, 60) : rating === 'unrated' ? 'unrated' : 'rated', source, note, assumption };
}
/** Soil level used by the verdict matrix. */
export function soilLevel(rating: SoilRating): 'low' | 'medium' | 'high' | null {
  if (rating === 'very_low' || rating === 'low' || rating === 'deficient') return 'low';
  if (rating === 'medium') return 'medium';
  if (rating === 'high' || rating === 'very_high' || rating === 'sufficient') return 'high';
  return null;
}
/** ROUND2_SPEC 4.1 verdict matrix. */
export function verdictFor(level: 'low' | 'medium' | 'high' | null, need: NutrientNeed | null): SoilCheck['verdict'] {
  if (!level || !need) return 'unknown';
  if (level === 'low' && need === 'high') return 'short';
  if ((level === 'low' || level === 'medium') && (need === 'medium' || need === 'high')) return 'watch';
  return 'ok';
}

// ------------------------------------------------------------------ field markers
type Sample = FarmSoilMarkers['samples'][number];
export interface SoilFact { def: ParamDef; marker: SoilMarker; sample: Sample; rated: RatedMarker }

/** Most recent confirmed soil-matrix marker per parameter (collection date, then confirmation time); never averaged. */
export function soilFacts(soil: FarmSoilMarkers, rate: RateMarkerFn | null): SoilFact[] {
  const samples = [...soil.samples].sort((a, b) => (b.collectionDate ?? '').localeCompare(a.collectionDate ?? '') || b.confirmedAt.localeCompare(a.confirmedAt));
  const out: SoilFact[] = [];
  for (const def of SOIL_PARAMETERS) {
    let found: { marker: SoilMarker; sample: Sample } | null = null;
    for (const parameter of def.parameters) {
      for (const sample of samples) {
        const marker = sample.markers.find((m) => m.parameter === parameter && m.reviewStatus === 'confirmed' && (m.matrix === 'soil' || m.matrix === 'unknown'));
        if (marker) { found = { marker, sample }; break; }
      }
      if (found) break;
    }
    if (!found) continue;
    let rated: RatedMarker = { rating: 'unrated', status: 'ratings_unavailable', source: null, note: 'Soil ratings are not available on this server.', assumption: null };
    if (rate) { try { rated = normaliseRating(rate(found.marker)); } catch { rated = { rating: 'unrated', status: 'rating_failed', source: null, note: 'The rating could not be computed.', assumption: null }; } }
    out.push({ def, marker: found.marker, sample: found.sample, rated });
  }
  return out;
}
export const hasConfirmedMarkers = (soil: FarmSoilMarkers): boolean => soil.samples.some((s) => s.markers.some((m) => m.reviewStatus === 'confirmed'));

export interface PhRange { min: number; max: number; source: string }
const comparablePh = (m: SoilMarker) => m.qualifier === 'exact' && m.canonical.unit === 'pH' && m.canonical.value !== null && !hasUnresolvedSoilWarnings(m) && !['low', 'unreadable'].includes(m.extractionConfidence)
  && !/cacl[₂2]?|kcl|calcium\s+chloride|potassium\s+chloride/i.test(`${m.method ?? ''} ${m.extractant ?? ''}`);
const kg = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
const RATING_TEXT = (r: SoilRating) => r.replace(/_/g, ' ');

/** One crop compared with the field's soil facts. `yieldKgPerHa` is the regional p50 the candidate is scored with. */
export function compareSoil(facts: readonly SoilFact[], soil: FarmSoilMarkers, crop: { cropId: string; cropName: string; yieldKgPerHa: number | null; phRange: PhRange | null }): { status: 'no_report' | 'compared'; checks: SoilCheck[] } {
  if (!hasConfirmedMarkers(soil)) return { status: 'no_report', checks: [] };
  const uptake = nutrientUptake(crop.cropId);
  const checks: SoilCheck[] = facts.slice(0, 12).map(({ def, marker, sample, rated }) => {
    let need: NutrientNeed | null = null;
    let verdict: SoilCheck['verdict'] = 'unknown';
    let note: string;
    const ratedText = rated.rating === 'unrated' ? `Not rated: ${rated.note ?? rated.status.replace(/_/g, ' ')}`.replace(/([^.])$/, '$1.') : `Rated ${RATING_TEXT(rated.rating)}${rated.source ? ` (${rated.source.title})` : ''}.`;
    if (def.key === 'ph') {
      const r = crop.phRange;
      if (!r) note = `${ratedText} No cited pH range for ${crop.cropName.toLowerCase()}.`;
      else if (!comparablePh(marker)) note = `${ratedText} This pH reading (method, qualifier or confidence) cannot be compared with the cited range pH ${r.min} to ${r.max}.`;
      else {
        const v = marker.canonical.value!;
        verdict = v < r.min || v > r.max ? 'watch' : 'ok';
        note = `${ratedText} ${verdict === 'ok' ? 'Inside' : 'Outside'} the cited range for ${crop.cropName.toLowerCase()}, pH ${r.min} to ${r.max} (${r.source}).`;
      }
    } else if (def.nutrient) {
      const at = uptakeAt(uptake, def.nutrient, crop.yieldKgPerHa);
      if (at) {
        need = needClass(def.nutrient, at.kgPerHa);
        verdict = verdictFor(soilLevel(rated.rating), need);
        note = `${ratedText} ${crop.cropName} takes up about ${kg(at.kgPerHa)} kg ${def.nutrient}/ha at the regional yield of ${Math.round(crop.yieldKgPerHa!)} kg/ha (${uptake!.source ?? 'nutrientUptake'}${at.scaled === 'linear_from_stated_yield' ? `, scaled linearly from the uptake stated at ${uptake!.yieldT} t/ha` : ''}): need ${need}.`;
      } else note = `${ratedText} ${!uptake || uptake[def.nutrient] == null ? `No sourced ${def.nutrient} uptake for ${crop.cropName.toLowerCase()}.` : 'No regional yield to scale the crop uptake.'}`;
    } else note = `${ratedText} No sourced crop requirement to compare with.`;
    return {
      parameter: marker.parameter.slice(0, 60), label: (def.labels[marker.parameter] ?? marker.rawLabel).slice(0, 80), value: marker.canonical.value ?? marker.numericValue ?? null, unit: (marker.canonical.unit ?? marker.rawUnit ?? null)?.slice(0, 30) ?? null,
      rating: rated.rating, need, verdict, note: note.slice(0, 600), assumption: rated.assumption ? rated.assumption.slice(0, 300) : null, markerId: marker.id.slice(0, 100), sampleId: sample.id, collectionDate: sample.collectionDate, ratingSource: rated.source,
    };
  });
  return { status: 'compared', checks };
}
