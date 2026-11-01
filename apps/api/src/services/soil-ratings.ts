import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SoilRating, type FarmSoilMarkers, type SoilRatingBand, type SoilRatingSource } from '@harvest/contracts';
import { REPO_ROOT } from '../catalogue/files';
import { hasUnresolvedSoilWarnings } from './soil-normalization';

/**
 * Soil ratings (ROUND2_SPEC.md section 5.1): confirmed soil markers compared with cited soil-test bands. Code rates;
 * nothing here is a fertilizer dose or crop advice. Every figure lives in data/research/soil/soil-ratings.json with its
 * source and a verified flag, and a figure whose source is not verified never rates a marker (status 'unrated').
 * Bands are applied exactly as the source prints them (inclusive or exclusive limits are in the file).
 */
export const SOIL_RATINGS_FILE = 'data/research/soil/soil-ratings.json';
/** Must equal `version` in the ratings file (checked by a test); changes invalidate cached soil reviews. */
export const SOIL_RATINGS_VERSION = '2026-11-01';

export type RatableMarker = FarmSoilMarkers['samples'][number]['markers'][number];
export type RatingStatus = 'rated' | 'unrated' | 'unit_mismatch' | 'qualifier';

const BandFile = z.object({
  label: SoilRating,
  from: z.number().nullable(),
  to: z.number().nullable(),
  fromExclusive: z.boolean().optional(),
  toInclusive: z.boolean().optional(),
  note: z.string().nullable(),
}).strict();
const ProfileFile = z.object({
  id: z.string(),
  parameter: z.string(),
  label: z.string(),
  unit: z.string(),
  ratedUnit: z.string(),
  form: z.enum(['element', 'oxide']).nullable(),
  sourceId: z.string(),
  axis: z.object({ min: z.number(), max: z.number() }).strict(),
  methodAccept: z.string().nullable(),
  methodReject: z.string().nullable(),
  rejectNote: z.string().nullable(),
  assumeNote: z.string().nullable(),
  derivedFrom: z.object({ profile: z.string(), factor: z.number(), conversionId: z.string() }).strict().optional(),
  bands: z.array(BandFile).min(1).max(8),
  limitations: z.string(),
}).strict();
const SourceFile = z.object({ id: z.string().max(80), title: z.string().max(400), url: z.url().nullable(), locator: z.string().max(400).nullable(), verified: z.boolean() }).strict();
const ConversionFile = z.object({ id: z.string(), from: z.string(), to: z.string(), factor: z.number(), sourceId: z.string(), verified: z.boolean(), note: z.string().optional() }).strict();
const RatingsFile = z.object({
  version: z.string().max(40),
  description: z.string(),
  sources: z.array(SourceFile),
  conversions: z.array(ConversionFile),
  profiles: z.array(ProfileFile),
}).strict();
export type SoilRatingsData = z.infer<typeof RatingsFile>;
type Profile = SoilRatingsData['profiles'][number];

export function parseSoilRatings(raw: unknown): SoilRatingsData { return RatingsFile.parse(raw); }

let cached: SoilRatingsData | null = null;
export function loadSoilRatings(): SoilRatingsData {
  cached ??= parseSoilRatings(JSON.parse(readFileSync(resolve(REPO_ROOT, SOIL_RATINGS_FILE), 'utf8')));
  return cached;
}

/** Every source in the ratings file, including unverified ones (verified:false figures never rate). */
export function soilRatingSources(): SoilRatingSource[] {
  return loadSoilRatings().sources.map(s => ({ id: s.id, title: s.title.slice(0, 200), url: s.url, locator: s.locator ? s.locator.slice(0, 200) : null, verified: s.verified }));
}

export interface MarkerRating {
  rating: SoilRating;
  status: RatingStatus;
  bands: SoilRatingBand[];
  axis: { min: number; max: number } | null;
  ratedValue: number | null;
  ratedUnit: string | null;
  source: SoilRatingSource | null;
  /** Why a marker is not rated, or an assumption applied when it is (missing method, element form). */
  note: string | null;
  profileId: string | null;
}

const none = (status: RatingStatus, note: string, profileId: string | null = null): MarkerRating => ({ rating: 'unrated', status, bands: [], axis: null, ratedValue: null, ratedUnit: null, source: null, note, profileId });

const OXIDE_P = /P\s*2\s*O\s*5|P₂O₅|phosphate/i;
const OXIDE_K = /K\s*2\s*O|K₂O|potash/i;

function profileFor(marker: RatableMarker, ratings: SoilRatingsData): { profile: Profile | null; formNote: string | null } {
  const candidates = ratings.profiles.filter(p => p.parameter === marker.parameter);
  if (!candidates.length) return { profile: null, formNote: null };
  if (candidates.length === 1) return { profile: candidates[0]!, formNote: null };
  const text = [marker.analyteForm, marker.rawLabel, marker.rawUnit].filter(Boolean).join(' ');
  const oxide = (marker.parameter === 'phosphorus_available' ? OXIDE_P : OXIDE_K).test(text);
  const profile = candidates.find(p => p.form === (oxide ? 'oxide' : 'element')) ?? null;
  const name = marker.parameter === 'phosphorus_available' ? 'P' : 'K';
  return { profile, formNote: oxide ? null : `Rated as elemental ${name} because the report does not name the ${name === 'P' ? 'P2O5' : 'K2O'} form.` };
}

function bandMatches(band: Profile['bands'][number], v: number): boolean {
  const lowerOk = band.from === null || (band.fromExclusive ? v > band.from : v >= band.from);
  const upperOk = band.to === null || (band.toInclusive ? v <= band.to : v < band.to);
  return lowerOk && upperOk;
}

function bandNote(band: Profile['bands'][number]): string | null {
  const base = band.note ?? '';
  const note = band.toInclusive && !base.includes('included') ? `${base}${base ? ' ' : ''}(upper limit included)` : base;
  return note ? note.slice(0, 200) : null;
}

/**
 * Rates one marker. Only confirmed soil-matrix markers with an exact qualifier, a numeric canonical value in the band
 * unit and no unresolved review warnings are rated; ranges, limits and below-detection results are 'qualifier', an
 * unconvertible unit is 'unit_mismatch', everything else is 'unrated' with the reason in `note`.
 */
export function rateMarkerWith(marker: RatableMarker, ratings: SoilRatingsData): MarkerRating {
  if (marker.reviewStatus !== 'confirmed') return none('unrated', 'The marker is not confirmed, so it is not rated.');
  if (marker.matrix !== 'soil') return none('unrated', 'Only soil results are rated; this result is not from a soil matrix.');
  const { profile, formNote } = profileFor(marker, ratings);
  if (!profile) return none('unrated', 'No cited rating band covers this parameter.');
  if (marker.qualifier !== 'exact' || marker.numericValue === null) return none('qualifier', 'Printed as a range, limit, below-detection or text result; a single exact value is needed to rate.', profile.id);
  const value = marker.canonical.value;
  if (value === null || !Number.isFinite(value)) return none('unit_mismatch', marker.canonical.missingReason ?? 'The printed unit could not be converted to the rating unit.', profile.id);
  if (marker.canonical.unit !== profile.unit) {
    const note = marker.canonical.unit === 'mg/kg' && profile.unit === 'kg/ha'
      ? 'Reported in mg/kg; the rating is in kg/ha, which needs the soil depth and bulk density. The common 2.24 factor is not verified from a primary source, so no conversion is applied.'
      : `Reported in ${marker.canonical.unit ?? 'an unknown unit'}; the cited bands are in ${profile.unit}.`;
    return none('unit_mismatch', note, profile.id);
  }
  if (hasUnresolvedSoilWarnings(marker) || ['low', 'unreadable'].includes(marker.extractionConfidence)) return none('unrated', 'Review warnings or low extraction confidence remain on this marker, so it is not rated.', profile.id);
  const source = ratings.sources.find(s => s.id === profile.sourceId);
  if (!source || !source.verified) return none('unrated', 'The source for these bands is not verified, so no rating is given.', profile.id);
  if (profile.derivedFrom) {
    const conversion = ratings.conversions.find(c => c.id === profile.derivedFrom!.conversionId);
    if (!conversion?.verified) return none('unrated', 'The conversion behind these bands is not verified, so no rating is given.', profile.id);
  }
  const methodText = [marker.method, marker.extractant].filter(Boolean).join(' ').trim();
  let assumption: string | null = null;
  if (methodText && profile.methodReject && new RegExp(profile.methodReject, 'i').test(methodText)) return none('unrated', profile.rejectNote ?? 'The stated method differs from the one the bands are defined for.', profile.id);
  if (profile.methodAccept) {
    if (!methodText) assumption = profile.assumeNote;
    else if (!new RegExp(profile.methodAccept, 'i').test(methodText)) return none('unrated', profile.rejectNote ?? 'The stated method differs from the one the bands are defined for.', profile.id);
  } else if (!methodText) assumption = profile.assumeNote;
  const hit = profile.bands.find(b => bandMatches(b, value));
  if (!hit) return none('unrated', 'The value falls outside every cited band.', profile.id);
  const notes = [formNote, assumption].filter((n): n is string => Boolean(n));
  return {
    rating: hit.label,
    status: 'rated',
    bands: profile.bands.map(b => ({ label: b.label, from: b.from, to: b.to, note: bandNote(b) })),
    axis: { ...profile.axis },
    ratedValue: value,
    ratedUnit: profile.ratedUnit,
    source: { id: source.id, title: source.title.slice(0, 200), url: source.url, locator: source.locator ? source.locator.slice(0, 200) : null, verified: source.verified },
    note: notes.length ? notes.join(' ') : null,
    profileId: profile.id,
  };
}

export function rateMarker(marker: RatableMarker): MarkerRating { return rateMarkerWith(marker, loadSoilRatings()); }

/** The profile label for a parameter (for rows), or null when no band set covers it. */
export function soilRatingLabel(parameter: string): string | null { return loadSoilRatings().profiles.find(p => p.parameter === parameter)?.label ?? null; }

export interface AssumedRating extends MarkerRating {
  /** Non-null exactly when the rating rests on an inferred form (never set by `rateMarker`). */
  assumption: string | null;
}

const OM_TO_OC = 'om_to_oc';
/**
 * Like `rateMarker`, but a marker that cannot rate only because its analyte form is not printed is rated on a flagged
 * inference and `status` is 'rated' with a non-null `assumption`. The inferences (ROUND2 pass 2 decision):
 *  - nitrogen_unspecified in kg/ha as available N (alkaline permanganate, the usual soil health card form);
 *  - phosphorus_total and potassium_total in kg/ha as available P (Olsen) and K (ammonium acetate);
 *  - organic_matter in % as organic carbon at the DAC manual's OM to organic C factor (0.580, verified).
 * Every other marker is rated or refused exactly as `rateMarker` does (confirmed, soil, exact, canonical unit, method,
 * verified source), and a result that is rated without an inference keeps `assumption: null`.
 */
export function rateMarkerAssumedWith(marker: RatableMarker, ratings: SoilRatingsData): AssumedRating {
  const strict = rateMarkerWith(marker, ratings);
  if (strict.status === 'rated') return { ...strict, assumption: null };
  const label = marker.rawLabel.slice(0, 60);
  const rate = (copy: RatableMarker, text: string): AssumedRating => {
    const r = rateMarkerWith(copy, ratings);
    return { ...r, assumption: r.status === 'rated' ? text.slice(0, 300) : null };
  };
  const unitOf = marker.canonical.unit;
  if (marker.parameter === 'nitrogen_unspecified' && unitOf === 'kg/ha')
    return rate({ ...marker, parameter: 'nitrogen_available' }, `The report prints "${label}" without saying which nitrogen pool; rated as available N (alkaline permanganate), the usual soil health card form in kg/ha.`);
  if ((marker.parameter === 'phosphorus_total' || marker.parameter === 'potassium_total') && unitOf === 'kg/ha') {
    const p = marker.parameter === 'phosphorus_total';
    return rate({ ...marker, parameter: p ? 'phosphorus_available' : 'potassium_available' },
      `The report labels this "${label}", but a kg/ha figure on a soil report is normally the available form; rated as available ${p ? 'P (Olsen)' : 'K (ammonium acetate)'}. Confirm with the laboratory.`);
  }
  if (marker.parameter === 'organic_matter' && unitOf === '%') {
    const conversion = ratings.conversions.find(c => c.id === OM_TO_OC);
    const v = marker.canonical.value;
    if (!conversion?.verified || v === null || !Number.isFinite(v)) return { ...strict, assumption: null };
    const oc = Math.round(v * conversion.factor * 1000) / 1000;
    return rate({ ...marker, parameter: 'organic_carbon', canonical: { ...marker.canonical, value: oc } },
      `The report gives organic matter (${v} %), not organic carbon; converted to organic carbon (${oc} %) with the DAC manual factor ${conversion.factor} and rated on the organic carbon bands.`);
  }
  if (['nitrogen_unspecified', 'phosphorus_total', 'potassium_total', 'organic_matter'].includes(marker.parameter) && marker.reviewStatus === 'confirmed' && marker.matrix === 'soil' && strict.status === 'unrated' && strict.profileId === null)
    return { ...strict, assumption: null, note: marker.parameter === 'organic_matter' ? `Organic matter is rated only when reported in % (reported in ${unitOf ?? 'an unknown unit'}).` : `This form is rated only when reported in kg/ha (reported in ${unitOf ?? 'an unknown unit'}).` };
  return { ...strict, assumption: null };
}
export function rateMarkerAssumed(marker: RatableMarker): AssumedRating { return rateMarkerAssumedWith(marker, loadSoilRatings()); }
