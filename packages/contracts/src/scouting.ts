import {z} from 'zod';
import {FieldId} from './workspace';

/**
 * Field operations (2026-11-03, docs/research/FIELD_OPERATIONS_SPEC.md sections 3 to 5): field checks (a recurring app action
 * at the farmer's own interval, never an agronomic claim), the issue log (what the farmer saw: category, severity and status
 * are farmer-reported, never a diagnosis) and responses (what the farmer did; the app never recommends a product, a rate or a
 * timing). A "label wait" is the farmer's own reading of a product label, turned into a date by arithmetic only.
 */
const clientEntryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

export const IssueCategory = z.enum(['pest', 'disease', 'weed', 'water_stress', 'nutrient', 'weather_damage', 'animal_damage', 'other']);
/** Farmer-reported. */
export const IssueSeverity = z.enum(['low', 'medium', 'high']);
export const IssueStatus = z.enum(['open', 'treating', 'resolved', 'dismissed']);
export const ResponseMethod = z.enum(['cultural', 'mechanical', 'biological', 'irrigation', 'nutrition', 'product_applied', 'other']);

/**
 * The spec's `GeoPoint` (latitude/longitude degrees). Named IssueLocation because common.ts already exports a GeoJSON
 * `GeoPoint` ({type: 'Point', coordinates}) through the same index.
 */
export const IssueLocation = z.object({lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180)}).strict();
/** A mark on one issue photo: normalised 0..1 from the top-left of the normalised derivative. */
export const PhotoMark = z.object({mediaId: z.uuid(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), label: z.string().trim().max(40).optional()}).strict();

export const CreateIssue = z.object({
 clientEntryId,
 /** Required when the farm has fields (400 field_required); an unknown field is 404 field_not_found. */
 fieldId: FieldId.optional(),
 /** Defaults to the field's (else the farm's) current cycle. */
 cycleId: z.string().min(1).max(120).optional(),
 observedOn: z.iso.date(),
 category: IssueCategory,
 severity: IssueSeverity,
 title: z.string().trim().min(1).max(120),
 detail: z.string().trim().max(2000).optional(),
 /** Must fall inside the farm boundary, and inside the field's polygon when fieldId is set (400 location_outside_boundary). */
 location: IssueLocation.optional(),
 mediaIds: z.array(z.uuid()).max(4).default([]),
 photoMarks: z.array(PhotoMark).max(12).default([]),
 /** The journal fact id of an accepted AI category suggestion, when the issue came from one (5.5). */
 fromFactId: z.uuid().optional(),
}).strict();

export const IssueEventKind = z.enum(['reported', 'status_changed', 'response_recorded', 'recheck_scheduled', 'note_added']);
/** What the farmer did, in the farmer's words. Never a recommendation. */
export const IssueResponse = z.object({
 method: ResponseMethod,
 description: z.string().trim().min(1).max(1000),
 /** The farmer's own words; optional (the farmer may not want to say). */
 productName: z.string().trim().max(120).optional(),
 quantity: z.object({value: z.number().positive().max(1e9), unit: z.enum(['kg', 'g', 'L', 'mL', 'ha', 'acre', 'other'])}).strict().optional(),
 /** Days before harvest, read by the farmer from the label; not checked by the app. */
 labelWaitDays: z.number().int().min(0).max(365).optional(),
 recheckOn: z.iso.date().optional(),
}).strict();
export const AddIssueEvent = z.object({
 clientEntryId,
 occurredOn: z.iso.date(),
 kind: z.enum(['status_changed', 'response_recorded', 'note_added']),
 /** Required for status_changed. */
 status: IssueStatus.optional(),
 /** Required for response_recorded. */
 response: IssueResponse.optional(),
 note: z.string().trim().max(2000).optional(),
 mediaIds: z.array(z.uuid()).max(4).default([]),
}).strict();

export const IssueEvent = z.object({
 id: z.uuid(), kind: IssueEventKind, occurredOn: z.iso.date(), status: IssueStatus.nullable(), response: IssueResponse.nullable(),
 note: z.string().nullable(), mediaIds: z.array(z.uuid()), journalEntryId: z.uuid().nullable(), createdAt: z.iso.datetime(),
}).strict();
export const FieldIssue = CreateIssue.omit({clientEntryId: true, fromFactId: true}).safeExtend({
 id: z.uuid(), farmId: z.uuid(), status: IssueStatus, cropId: z.string().nullable(), cropName: z.string().nullable(),
 journalEntryId: z.uuid(), events: z.array(IssueEvent), recheckOn: z.iso.date().nullable(),
 /** Arithmetic only: occurredOn of the latest response with labelWaitDays, plus the days; null when none. */
 earliestHarvestOn: z.iso.date().nullable(),
 /** Earlier issues of the same category on the same field (or farm when field-less), newest first, at most 5. */
 seenBefore: z.array(z.object({issueId: z.uuid(), observedOn: z.iso.date(), cropName: z.string().nullable(), status: IssueStatus}).strict()).max(5),
 createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), scope: z.enum(['field', 'farm']),
});
export const FieldIssues = z.object({
 farmId: z.uuid(), asOf: z.iso.date(), issues: z.array(FieldIssue),
 counts: z.object({open: z.number().int(), treating: z.number().int(), resolved: z.number().int(), dismissed: z.number().int()}).strict(),
 limitations: z.array(z.string()),
}).strict();

export const CheckKind = z.enum(['interval', 'recheck']);
export const CheckItem = z.object({
 text: z.string().max(300), kind: z.enum(['risk_window', 'general']), sourceName: z.string().max(200).nullable(), sourceUrl: z.string().nullable(),
 sourceDate: z.iso.date().nullable(), alertId: z.uuid().nullable(),
}).strict();
export const FieldCheck = z.object({
 /** Deterministic: `check:<cycleId>:<dueOn>` or `recheck:<issueId>:<dueOn>`. */
 id: z.string().max(160),
 kind: CheckKind, fieldId: z.string().nullable(), cycleId: z.string().nullable(), issueId: z.uuid().nullable(),
 cropName: z.string().nullable(), dueFrom: z.iso.date(), dueTo: z.iso.date(), status: z.enum(['upcoming', 'due', 'overdue', 'completed']),
 intervalDays: z.number().int().nullable(), checklist: z.array(CheckItem).max(20), completedOn: z.iso.date().nullable(), journalEntryId: z.uuid().nullable(),
 scope: z.enum(['field', 'farm']),
 /** Interval checks only: slots skipped when the check rolled forward to the latest slot on or before today (absent = none). */
 missedCount: z.number().int().nonnegative().optional(),
}).strict();
export const FieldChecks = z.object({farmId: z.uuid(), asOf: z.iso.date(), checks: z.array(FieldCheck), limitations: z.array(z.string())}).strict();
export const CompleteCheck = z.object({
 clientEntryId, checkId: z.string().max(160), completedOn: z.iso.date(),
 result: z.enum(['nothing_found', 'issues_found']), note: z.string().trim().max(2000).optional(), issueIds: z.array(z.uuid()).max(10).default([]),
}).strict();
export const CompleteCheckResult = z.object({check: FieldCheck, journalEntryId: z.uuid(), alreadyCompleted: z.boolean()}).strict();

/** Query strings of the scouting reads. */
export const FieldChecksQuery = z.object({fieldId: FieldId.optional()}).strict();
export const FieldIssuesQuery = z.object({fieldId: FieldId.optional(), status: IssueStatus.optional()}).strict();

export type IssueCategory = z.infer<typeof IssueCategory>;
export type IssueSeverity = z.infer<typeof IssueSeverity>;
export type IssueStatus = z.infer<typeof IssueStatus>;
export type ResponseMethod = z.infer<typeof ResponseMethod>;
export type IssueLocation = z.infer<typeof IssueLocation>;
export type PhotoMark = z.infer<typeof PhotoMark>;
export type CreateIssue = z.infer<typeof CreateIssue>;
export type IssueEventKind = z.infer<typeof IssueEventKind>;
export type IssueResponse = z.infer<typeof IssueResponse>;
export type AddIssueEvent = z.infer<typeof AddIssueEvent>;
export type IssueEvent = z.infer<typeof IssueEvent>;
export type FieldIssue = z.infer<typeof FieldIssue>;
export type FieldIssues = z.infer<typeof FieldIssues>;
export type CheckKind = z.infer<typeof CheckKind>;
export type CheckItem = z.infer<typeof CheckItem>;
export type FieldCheck = z.infer<typeof FieldCheck>;
export type FieldChecks = z.infer<typeof FieldChecks>;
export type CompleteCheck = z.infer<typeof CompleteCheck>;
export type CompleteCheckResult = z.infer<typeof CompleteCheckResult>;
