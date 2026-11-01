import {z} from 'zod';

/**
 * Farm alerts for the Today view (docs/research/TODAY_VIEW_SPEC.md section 7).
 *
 * Every alert carries a dated source with a URL; alerts without one are dropped before storage. `origin` says how
 * the alert was produced: `rule` alerts are computed in code from stored forecasts, mandi observations or sourced
 * crop-risk windows; `grounded_review` alerts are news items that Meta muse-spark classified from its own web search
 * in that response, kept only when the URL was among the search's citations or retrieved sources. For grounded
 * alerts the source date is model-reported and checked for recency, not independently verified.
 *
 * Not yet re-exported from index.ts (orchestrator-owned); import by path until it is.
 */
/** 'satellite' (added 2026-11-01, open-source comparison): a code rule on the field's own Sentinel-2 index series; its source is the scene's STAC item. */
export const FarmAlertType = z.enum(['weather', 'price', 'market_event', 'crop_threat', 'satellite']);
export const FarmAlertSeverity = z.enum(['info', 'watch', 'warning']);
export const FarmAlertOrigin = z.enum(['rule', 'grounded_review']);

export const FarmAlertSource = z.object({
  name: z.string().min(1).max(200),
  url: z.url({protocol: /^https?$/}),
  /** Publication or issue date of the source (forecast issue date, last mandi observation, article date). */
  date: z.iso.date(),
}).strict();

export const FarmAlert = z.object({
  id: z.uuid(),
  farmId: z.uuid(),
  type: FarmAlertType,
  severity: FarmAlertSeverity,
  origin: FarmAlertOrigin,
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(600),
  source: FarmAlertSource,
  validFrom: z.iso.date(),
  validTo: z.iso.date(),
  suggestedStep: z.string().max(300).nullable(),
  createdAt: z.iso.datetime(),
}).strict();

/** State of the once-per-farm-per-day grounded news review. `paused` = global daily spend cap reached. */
export const FarmNewsReviewStatus = z.object({
  status: z.enum(['active', 'paused', 'not_run', 'unavailable']),
  reason: z.string().nullable(),
  lastReviewedAt: z.iso.datetime().nullable(),
}).strict();

export const FarmAlerts = z.object({
  farmId: z.uuid(),
  /** Calendar date (Asia/Kolkata) used for validity: alerts with validTo before it are not listed. */
  asOf: z.iso.date(),
  /** Active (validTo >= asOf), not dismissed, newest first. */
  alerts: z.array(FarmAlert),
  /** IMD district warnings need a user-obtained api.imd.gov.in key; until then they are not connected. */
  imdStatus: z.literal('not_connected'),
  newsReview: FarmNewsReviewStatus,
  limitations: z.array(z.string()),
}).strict();

export type FarmAlertType = z.infer<typeof FarmAlertType>;
export type FarmAlertSeverity = z.infer<typeof FarmAlertSeverity>;
export type FarmAlertOrigin = z.infer<typeof FarmAlertOrigin>;
export type FarmAlertSource = z.infer<typeof FarmAlertSource>;
export type FarmAlert = z.infer<typeof FarmAlert>;
export type FarmNewsReviewStatus = z.infer<typeof FarmNewsReviewStatus>;
export type FarmAlerts = z.infer<typeof FarmAlerts>;
