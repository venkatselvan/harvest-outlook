import {z} from 'zod';

/**
 * Sentinel-2 L2A NDVI read for a farm boundary (Today view, Stream B).
 * Numbers are computed in code from B04/B08 digital numbers with the SCL mask; they are observations of
 * the provider's surface-reflectance product, not field-validated crop measurements.
 */
const fraction = z.number().min(0).max(1);
const ndvi = z.number().min(-1).max(1);
const isoDate = z.iso.date();

export const NdviRejection = z.enum(['no_pixels', 'implausible_band_values', 'insufficient_clear_pixels', 'low_clear_fraction']);

/**
 * Spectral indices beyond NDVI (open-source comparison, 2026-11-01; docs/research/OPEN_SOURCE_COMPARISON.md section 1).
 * Each is computed in code over the same clear pixels as NDVI, from offset-corrected L2A digital numbers scaled to
 * reflectance. Formulas (Sentinel-2 band names; L2A reflectance): EVI 2.5 (B8 - B4) / (B8 + 6 B4 - 7.5 B2 + 1);
 * NDRE (B8 - B5) / (B8 + B5); GNDVI (B8 - B3) / (B8 + B3); SAVI 1.5 (B8 - B4) / (B8 + B4 + 0.5); NDMI (B8 - B11) / (B8 + B11);
 * LSWI (B8A - B11) / (B8A + B11); NDWI (McFeeters) (B3 - B8) / (B3 + B8). B5, B8A and B11 are 20 m bands resampled to the 10 m grid.
 */
export const IndexId = z.enum(['evi', 'ndre', 'gndvi', 'savi', 'ndmi', 'lswi', 'ndwi']);
export const INDEX_IDS = IndexId.options;
const indexValue = z.number().min(-2).max(2);
/** Summary of one index over the clear pixels of one scene. Null statistics mean no clear pixel survived the mask. */
export const IndexSummary = z.object({
  mean: indexValue.nullable(),
  median: indexValue.nullable(),
  p10: indexValue.nullable(),
  p90: indexValue.nullable(),
}).strict();
/** One summary per index. A whole index is null when a band it needs was not returned for the scene. */
export const IndexSummaries = z.object({
  evi: IndexSummary.nullable(), ndre: IndexSummary.nullable(), gndvi: IndexSummary.nullable(), savi: IndexSummary.nullable(),
  ndmi: IndexSummary.nullable(), lswi: IndexSummary.nullable(), ndwi: IndexSummary.nullable(),
}).strict();

/** Pixel statistics over the clear pixels of one scene. Null statistics mean no clear pixel survived the mask. */
export const NdviStats = z.object({
  mean: ndvi.nullable(),
  median: ndvi.nullable(),
  p10: ndvi.nullable(),
  p90: ndvi.nullable(),
  clearPixels: z.number().int().min(0),
  totalPixels: z.number().int().min(0),
  clearFraction: fraction,
  /** Pixels inside the area classified as cloud (SCL 8, 9, 10) or cloud shadow (SCL 3), as a fraction of totalPixels. */
  cloudOrShadowFraction: fraction,
  /** 95th percentile of raw B04 digital numbers inside the area; at or below 255 marks an implausible (8-bit looking) scene. */
  b04P95: z.number().min(0).nullable(),
  usable: z.boolean(),
  rejection: NdviRejection.nullable(),
  /** Added 2026-11-01: the other spectral indices over the same clear pixels. Absent on rows analysed before the indices existed; such rows are re-analysed. */
  indices: IndexSummaries.optional(),
}).strict();

export const NdviReading = z.object({
  itemId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  date: isoDate,
  acquiredAt: z.iso.datetime(),
  tileId: z.string().max(16).nullable(),
  baseline: z.string().max(16).nullable(),
  offsetApplied: z.boolean(),
  sceneCloudPct: z.number().min(0).max(100).nullable(),
  /** Field-level usability: clear fraction >= 0.6, at least 8 clear pixels and the B04 plausibility guard. */
  usable: z.boolean(),
  field: NdviStats,
  /** About 1 km around the field (field pixels included). Null when the buffer could not be read. */
  neighbourhood: NdviStats.nullable(),
}).strict();

export const NdviSeries = z.object({
  farmId: z.uuid(),
  status: z.enum(['available', 'unavailable']),
  reason: z.string().max(80).nullable(),
  window: z.object({from: isoDate, to: isoDate}).strict(),
  polygonBasis: z.enum(['boundary', 'farm_point_square']).nullable(),
  /** Pixels inside the field polygon at 10 m (from the newest analysed scene). */
  polygonPixels: z.number().int().min(0).nullable(),
  /** True when the boundary covers fewer than 12 pixels; the neighbourhood value is the safer reference. */
  smallField: z.boolean(),
  /** [minLon, minLat, maxLon, maxLat] of the rendered scene images, rounded to 4 decimals, for drawing the outline. */
  imageBbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  scenesListed: z.number().int().min(0),
  scenesAnalysed: z.number().int().min(0),
  scenesPending: z.number().int().min(0),
  scenesFailed: z.number().int().min(0),
  readings: z.array(NdviReading).max(500),
  latestUsable: NdviReading.nullable(),
  method: z.object({
    version: z.string(),
    /** Version of the index formulas and scaling. Stored rows are re-analysed when they lack `indices`; a later formula change would need a stored marker as well. */
    indexMethodVersion: z.string().optional(),
    sclClassesKept: z.array(z.number().int().min(0).max(11)),
    minClearFraction: fraction,
    minClearPixels: z.number().int(),
    maxSceneCloudPct: z.number().min(0).max(100),
  }).strict(),
  attribution: z.string(),
  limitations: z.array(z.string().max(400)).max(20),
}).strict();

export const NeighbourhoodSeasonality = z.object({
  farmId: z.uuid(),
  status: z.enum(['available', 'unavailable']),
  reason: z.string().max(80).nullable(),
  window: z.object({from: isoDate, to: isoDate}).strict(),
  /** Mean NDVI at or above this value marks an active (green) month. A design threshold, not a validated one. */
  activeThreshold: ndvi,
  months: z.array(z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    monthOfYear: z.number().int().min(1).max(12),
    meanNdvi: ndvi.nullable(),
    usableScenes: z.number().int().min(0),
    analysedScenes: z.number().int().min(0),
  }).strict()).max(12),
  /** Calendar months (1-12) whose neighbourhood mean met the threshold. Months with no usable scene are never active. */
  activeMonths: z.array(z.number().int().min(1).max(12)).max(12),
  scenesPending: z.number().int().min(0),
  limitations: z.array(z.string().max(400)).max(20),
}).strict();

export type IndexId = z.infer<typeof IndexId>;
export type IndexSummary = z.infer<typeof IndexSummary>;
export type IndexSummaries = z.infer<typeof IndexSummaries>;
export type NdviRejection = z.infer<typeof NdviRejection>;
export type NdviStats = z.infer<typeof NdviStats>;
export type NdviReading = z.infer<typeof NdviReading>;
export type NdviSeries = z.infer<typeof NdviSeries>;
export type NeighbourhoodSeasonality = z.infer<typeof NeighbourhoodSeasonality>;
