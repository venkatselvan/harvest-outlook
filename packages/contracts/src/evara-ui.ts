import {z} from 'zod';

/**
 * Evara UI kit (2026-11-04, docs/research/EVARA_ACTIONS_SPEC.md section 2). The assistant's synthesis pass writes an Evara Lang
 * program (StructuredAssistantOutput.ui); the server resolves it after the output gate into this tree, filling every data
 * component from stored tool results and read-only services, and the web renders the tree. The model never writes a number
 * or a sentence into a node: `text` nodes carry gated answer blocks, every other string here is code-written.
 *
 * Actions are a fixed allowlist the web executes with the farmer's confirmation through the existing owner-scoped routes;
 * the resolver validates every id against the run's data before it reaches the client.
 */
const short = (n: number) => z.string().max(n);
const isoDate = z.iso.date();

export const EvaraOpenTarget = z.enum(['plan', 'fit', 'compare', 'today', 'journal']);
export type EvaraOpenTarget = z.infer<typeof EvaraOpenTarget>;

/** Code-written questions `@Ask(promptKey)` sends; the web has the text per language. */
export const EvaraPromptKey = z.enum(['care_15_days', 'plant_next', 'compare_season', 'weather_market', 'what_could_have_been', 'show_journey']);
export type EvaraPromptKey = z.infer<typeof EvaraPromptKey>;

const actionBase = {label: short(80)};
export const EvaraAction = z.discriminatedUnion('kind', [
 z.object({kind: z.literal('ask'), ...actionBase, promptKey: EvaraPromptKey}).strict(),
 z.object({kind: z.literal('show_journey'), ...actionBase, cropId: short(120), cropName: short(120), sowingDate: isoDate.nullable()}).strict(),
 z.object({kind: z.literal('compare'), ...actionBase, cropIds: z.array(short(120)).min(2).max(4)}).strict(),
 z.object({kind: z.literal('pick_crop'), ...actionBase, cropId: short(120), cropName: short(120), productId: short(200).nullable(), sowingDate: isoDate.nullable()}).strict(),
 z.object({kind: z.literal('use_plan'), ...actionBase, reviewId: z.uuid(), optionId: short(120), alternative: z.boolean(), fieldId: short(120).nullable()}).strict(),
 z.object({kind: z.literal('replace_season'), ...actionBase, rotationPlanId: short(160), fromCropName: short(120), cropId: short(120), cropName: short(120), productId: short(200).nullable(), sowingDate: isoDate.nullable()}).strict(),
 z.object({kind: z.literal('add_season'), ...actionBase, cropId: short(120), cropName: short(120), productId: short(200).nullable(), sowingDate: isoDate}).strict(),
 z.object({kind: z.literal('open'), ...actionBase, target: EvaraOpenTarget}).strict(),
]);
export type EvaraAction = z.infer<typeof EvaraAction>;

/** One formatted cell of a CropCompare row: code-written text with its unit, an optional tone for colouring, "—" when unknown. */
export const EvaraCell = z.object({text: short(80), tone: z.enum(['good', 'watch', 'short', 'neutral']).nullable(), note: short(200).nullable()}).strict();
export type EvaraCell = z.infer<typeof EvaraCell>;

export const EvaraCompareColumn = z.enum(['fit', 'sowing', 'duration', 'water', 'harvest', 'profit', 'replaces']);
export type EvaraCompareColumn = z.infer<typeof EvaraCompareColumn>;

/** `harvest` is null when no planned or engine harvest window exists (review fix 4: never a date made up from the sowing date). */
export const EvaraPlanSlot = z.object({cropName: short(120), productName: short(120).nullable(), kind: short(20), sowing: isoDate, harvest: z.object({earliest: isoDate, latest: isoDate}).strict().nullable(), profitForField: short(60).nullable(), replaces: short(160).nullable()}).strict();

export const EvaraPlanOption = z.object({
 optionId: short(120),
 reviewId: z.uuid().nullable(),
 label: short(60),
 chips: z.array(short(60)).max(4),
 slots: z.array(EvaraPlanSlot).max(6),
 actions: z.array(EvaraAction).max(3),
}).strict();

export const EvaraJourneyStage = z.object({stageId: short(80), name: short(80), from: isoDate, to: isoDate, basis: short(20)}).strict();

const textKind = z.enum(['text', 'numeric', 'warning', 'limitation', 'evidence']);

export type EvaraNode =
 | {type: 'stack'; children: EvaraNode[]}
 | {type: 'text'; blockId: string; kind: z.infer<typeof textKind>; text: string}
 | {type: 'callout'; tone: 'warning' | 'info' | 'good'; text: string; blockId: string | null}
 | {type: 'farm_snapshot'; fieldName: string | null; crop: string | null; stage: string | null; dayOfSeason: string | null; rainNext7Days: string | null; nextAction: string | null; nextActionWindow: string | null; openAlerts: number}
 | {type: 'crop_compare'; columns: EvaraCompareColumn[]; rows: {cropId: string; cropName: string; productName: string | null; cells: Partial<Record<EvaraCompareColumn, EvaraCell>>; actions: EvaraAction[]}[]; note: string | null}
 | {type: 'plan_options'; source: 'plan' | 'alternatives' | 'saved'; basis: 'replace_planned' | 'sown_comparison' | null; options: z.infer<typeof EvaraPlanOption>[]; note: string | null}
 | {type: 'growth_journey'; cropId: string; cropName: string; productId: string | null; fieldId: string | null; sowingDate: string; stages: z.infer<typeof EvaraJourneyStage>[]; journeyId: string | null; note: string | null}
 | {type: 'actions'; items: EvaraAction[]}
 | {type: 'choice'; prompt: string; blockId: string; options: EvaraAction[]};

export const EvaraNode: z.ZodType<EvaraNode> = z.lazy(() =>
 z.discriminatedUnion('type', [
  z.object({type: z.literal('stack'), children: z.array(EvaraNode).min(1).max(12)}).strict(),
  z.object({type: z.literal('text'), blockId: short(120), kind: textKind, text: z.string().min(1).max(4000)}).strict(),
  z.object({type: z.literal('callout'), tone: z.enum(['warning', 'info', 'good']), text: z.string().min(1).max(4000), blockId: short(120).nullable()}).strict(),
  z.object({
   type: z.literal('farm_snapshot'),
   fieldName: short(120).nullable(),
   crop: short(120).nullable(),
   stage: short(120).nullable(),
   dayOfSeason: short(40).nullable(),
   rainNext7Days: short(40).nullable(),
   nextAction: short(160).nullable(),
   nextActionWindow: short(60).nullable(),
   openAlerts: z.number().int().nonnegative(),
  }).strict(),
  z.object({
   type: z.literal('crop_compare'),
   columns: z.array(EvaraCompareColumn).min(1).max(7),
   rows: z.array(z.object({cropId: short(120), cropName: short(120), productName: short(120).nullable(), cells: z.partialRecord(EvaraCompareColumn, EvaraCell), actions: z.array(EvaraAction).max(3)}).strict()).min(2).max(4),
   note: short(300).nullable(),
  }).strict(),
  z.object({
   type: z.literal('plan_options'),
   source: z.enum(['plan', 'alternatives', 'saved']),
   basis: z.enum(['replace_planned', 'sown_comparison']).nullable(),
   options: z.array(EvaraPlanOption).min(1).max(5),
   note: short(300).nullable(),
  }).strict(),
  z.object({
   type: z.literal('growth_journey'),
   cropId: short(120),
   cropName: short(120),
   productId: short(200).nullable(),
   fieldId: short(120).nullable(),
   sowingDate: isoDate,
   stages: z.array(EvaraJourneyStage).min(1).max(12),
   journeyId: z.uuid().nullable(),
   note: short(300).nullable(),
  }).strict(),
  z.object({type: z.literal('actions'), items: z.array(EvaraAction).min(1).max(6)}).strict(),
  z.object({type: z.literal('choice'), prompt: z.string().min(1).max(4000), blockId: short(120), options: z.array(EvaraAction).min(1).max(6)}).strict(),
 ]),
);

/** A statement the resolver dropped, with the OpenUI-style code (never shown to the farmer; kept for the trace and tests). */
export const EvaraDropped = z.object({
 line: z.number().int().nonnegative(),
 code: z.enum(['parse-failed', 'unknown-component', 'unknown-action', 'missing-required', 'type-mismatch', 'excess-args', 'unknown-ref', 'cycle', 'prose-not-allowed', 'unknown-id', 'not-replaceable', 'empty-after-resolve', 'no-root']),
 detail: short(200).nullable(),
}).strict();

export const EvaraUi = z.object({
 version: z.literal('1'),
 /** 'model': the model's program resolved; 'fallback': the code composer built the tree (empty or invalid program, or a crop/plan intent without a data component). */
 origin: z.enum(['model', 'fallback']),
 root: EvaraNode,
 dropped: z.array(EvaraDropped).max(20),
}).strict();
export type EvaraUi = z.infer<typeof EvaraUi>;
