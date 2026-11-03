import {z} from 'zod';
import {FarmAlert} from './alerts';
import {FieldCheck, FieldIssue, IssueCategory} from './scouting';
import {CropCycle, FieldId} from './workspace';

/**
 * Season report (2026-11-03, docs/research/FIELD_OPERATIONS_SPEC.md section 8): one crop cycle's journal entries, completed
 * field checks, issues, care completions, stored alerts and stored satellite readings, as a printable page plus CSV. Everything
 * in it is what the farmer recorded or what was stored with a dated source; nothing is an estimate. Totals (harvest, sales,
 * water, fertiliser) are NOT in the payload: the web adds the entries with the same functions as the Journal's Season totals,
 * so one arithmetic lives in one place.
 */
const isoDate = z.iso.date();

/** Optional selectors: `cycleId` or `fieldId` (that field's current cycle); a farm with fields needs one of them (400 field_required). */
export const SeasonReportQuery = z.object({
  cycleId: z.string().trim().min(1).max(120).optional(),
  fieldId: FieldId.optional(),
}).strict();

/** The journal entry as the farm timeline returns it, without the AI analysis block (the report carries the farmer's record). */
export const ReportFact = z.object({
  id: z.string(), field: z.string(), kind: z.enum(['original', 'proposed', 'confirmed']), source: z.enum(['farmer', 'ai']),
  status: z.enum(['proposed', 'confirmed', 'rejected', 'recorded']), value: z.unknown(), unit: z.string().nullable(),
  evidenceState: z.enum(['farmer_reported', 'derived', 'illustrative']),
}).strict();
export const ReportEntry = z.object({
  id: z.string(), observedOn: isoDate, activity: z.string().nullable(), note: z.string().nullable(),
  quantity: z.object({value: z.number(), unit: z.string()}).strict().nullable(),
  expense: z.object({amountInr: z.string(), category: z.string()}).strict().nullable(),
  sale: z.object({amountInr: z.string(), note: z.string().nullable()}).strict().nullable(),
  /** `contentPath` is the normalised derivative; the report page prints it as a thumbnail with the entry date. */
  media: z.array(z.object({id: z.string(), contentPath: z.string(), label: z.string()}).strict()),
  facts: z.array(ReportFact),
  provenanceLabel: z.string(),
}).strict();

export const ReportCareCompletion = z.object({taskId: z.string(), title: z.string(), completedOn: isoDate}).strict();
/** A stored alert valid inside the period; dismissed alerts are kept and carry the dismissal time. */
export const ReportAlert = FarmAlert.safeExtend({dismissedAt: z.iso.datetime().nullable()});
/** A stored Sentinel-2 reading for the field polygon. `verdict` is the usability rule's outcome ("usable" or the rejection reason). */
export const ReportNdviReading = z.object({
  date: isoDate, meanNdvi: z.number().min(-1).max(1).nullable(), clearFraction: z.number().min(0).max(1).nullable(), verdict: z.string().max(80),
}).strict();
export const IssueTrendWeek = z.object({
  /** The Monday of the week (ISO date). */
  weekStart: isoDate,
  counts: z.object(Object.fromEntries(IssueCategory.options.map((c) => [c, z.number().int().min(0)])) as Record<IssueCategory, z.ZodNumber>).strict(),
}).strict();
export const PreviousSeason = z.object({
  cycleId: z.string(), cropName: z.string(), sowingDate: isoDate, harvestDate: isoDate.nullable(),
  issueCount: z.number().int().min(0), checksCompleted: z.number().int().min(0),
}).strict();

export const SeasonReport = z.object({
  farm: z.object({id: z.uuid(), name: z.string(), district: z.string().nullable(), state: z.string().nullable(), areaHa: z.number().nullable()}).strict(),
  field: z.object({id: z.string(), name: z.string(), areaHa: z.number()}).strict().nullable(),
  cycle: CropCycle,
  /** First day counted (establishment, else sowing) to the last attributed day (harvest + 90 days capped before the next crop, or today). */
  period: z.object({from: isoDate, to: isoDate}).strict(),
  entries: z.array(ReportEntry),
  /** Completed checks of this cycle (and of its field without a cycle) inside the period. */
  checks: z.array(FieldCheck),
  issues: z.array(FieldIssue),
  careCompletions: z.array(ReportCareCompletion),
  alerts: z.array(ReportAlert),
  ndvi: z.array(ReportNdviReading),
  issueTrend: z.array(IssueTrendWeek),
  /** Earlier cycles on the same field (farm-wide records when the cycle has no field), newest first, at most 5. */
  previousSeasons: z.array(PreviousSeason).max(5),
  generatedAt: z.iso.datetime(),
  limitations: z.array(z.string()),
}).strict();

export type SeasonReportQuery = z.infer<typeof SeasonReportQuery>;
export type ReportFact = z.infer<typeof ReportFact>;
export type ReportEntry = z.infer<typeof ReportEntry>;
export type ReportCareCompletion = z.infer<typeof ReportCareCompletion>;
export type ReportAlert = z.infer<typeof ReportAlert>;
export type ReportNdviReading = z.infer<typeof ReportNdviReading>;
export type IssueTrendWeek = z.infer<typeof IssueTrendWeek>;
export type PreviousSeason = z.infer<typeof PreviousSeason>;
export type SeasonReport = z.infer<typeof SeasonReport>;
