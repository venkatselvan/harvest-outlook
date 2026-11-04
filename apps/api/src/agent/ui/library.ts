import { z } from "zod";
import { EvaraOpenTarget, EvaraPromptKey, type EvaraAction, type EvaraNode } from "@harvest/contracts";

/**
 * Evara Lang component and action library v1 (docs/research/EVARA_ACTIONS_SPEC.md 2.4, 2.5; docs/EVARA_LANG.md).
 *
 * Every parameter is declared in positional order with a zod schema for its literal value. The resolver (resolve.ts) maps
 * positional arguments onto these declarations, the prompt generator (prompt.ts) renders them into the synthesis
 * instructions, and docs/EVARA_LANG.md lists the same table. Nothing here is model-written: the model only names these
 * components and actions; code fills every cell, chip, date and label.
 */

/** 2.3: a string literal is an id, a date or an enum word: no spaces, no prose. */
export const STRING_FORM = /^[A-Za-z0-9_.:\-/]{1,120}$/;
const idString = z.string().regex(STRING_FORM);
const isoDate = z.iso.date();

/**
 * value: a literal (or a ref to a literal statement) checked with `schema`.
 * nodes: a list of component refs or inline calls; dropped items are removed.
 * actions: a list of `@Action(...)` items or refs to them; dropped items are removed.
 */
export type ParamKind = "value" | "nodes" | "actions";

export interface ParamDecl {
  name: string;
  kind: ParamKind;
  /** For `value` params: the literal's schema. For lists: the schema of the surviving items' count is min/max below. */
  schema: z.ZodType;
  optional: boolean;
  /** List bounds (value lists, nodes and actions). Items beyond `max` are cut and recorded as `excess-args`. */
  min?: number;
  max?: number;
  /** Type text for the generated prompt and docs. */
  type: string;
}

export type ComponentName = "Stack" | "Text" | "Callout" | "FarmSnapshot" | "CropCompare" | "PlanOptions" | "GrowthJourney" | "Choice" | "Actions";
export type ActionName = "PickCrop" | "ShowJourney" | "Compare" | "UsePlan" | "ReplaceSeason" | "AddSeason" | "Open" | "Ask";

export interface ComponentDecl {
  name: ComponentName;
  nodeType: EvaraNode["type"];
  params: ParamDecl[];
  /** Data components are filled by code from stored tool results and read-only services. */
  data: boolean;
  /** One line for the prompt. */
  summary: string;
  /** What code fills it from (docs). */
  fills: string;
  /** When the resolver drops it (docs); the codes are enforced in resolve.ts / build.ts. */
  droppedWhen: string;
}

export interface ActionDecl {
  name: ActionName;
  kind: EvaraAction["kind"];
  params: ParamDecl[];
  summary: string;
  /** Id validation the resolver applies (docs). */
  validates: string;
}

const p = (name: string, kind: ParamKind, schema: z.ZodType, type: string, opts: { optional?: boolean; min?: number; max?: number } = {}): ParamDecl => ({
  name,
  kind,
  schema,
  type,
  optional: opts.optional ?? false,
  ...(opts.min !== undefined ? { min: opts.min } : {}),
  ...(opts.max !== undefined ? { max: opts.max } : {}),
});

export const TONES = ["warning", "info", "good"] as const;
export const PLAN_SOURCES = ["plan", "alternatives", "saved"] as const;
export const USE_PLAN_SOURCES = ["plan", "alternatives"] as const;

const enumText = (values: readonly string[]) => values.map((v) => `"${v}"`).join(" | ");

export const COMPONENTS: readonly ComponentDecl[] = [
  {
    name: "Stack",
    nodeType: "stack",
    params: [p("children", "nodes", z.array(z.unknown()), "ref[] (1 to 12 components)", { min: 1, max: 12 })],
    data: false,
    summary: "a vertical group of components in reading order",
    fills: "nothing (layout only)",
    droppedWhen: "no child survives (empty-after-resolve)",
  },
  {
    name: "Text",
    nodeType: "text",
    params: [p("blockId", "value", idString, "string (one of your answerBlocks ids)")],
    data: false,
    summary: "shows one of your answer blocks",
    fills: "the gated answer block (its kind is carried)",
    droppedWhen: "the block id is not an approved answer block (unknown-id)",
  },
  {
    name: "Callout",
    nodeType: "callout",
    params: [p("tone", "value", z.enum(TONES), enumText(TONES)), p("blockId", "value", idString, "string (one of your answerBlocks ids)")],
    data: false,
    summary: "shows one of your answer blocks highlighted with a tone",
    fills: "the gated answer block",
    droppedWhen: "the block id is not an approved answer block (unknown-id)",
  },
  {
    name: "FarmSnapshot",
    nodeType: "farm_snapshot",
    params: [],
    data: true,
    summary: "the viewed field's crop, stage, day of season, rain in the next 7 days, next action and open alerts",
    fills: "this run's get_farm_briefing result",
    droppedWhen: "the run has no farm briefing (empty-after-resolve)",
  },
  {
    name: "CropCompare",
    nodeType: "crop_compare",
    params: [p("cropIds", "value", z.array(idString), "string[] (2 to 4 catalogue crop ids)", { min: 2, max: 4 })],
    data: true,
    summary: "a table comparing crops: fit, sowing, duration, water, harvest, profit for the field, the planned season it replaces; each row can be picked",
    fills: "the stored crop-fit review of the viewed field (rank, score, sowing, duration, water, harvest, profit, replaces); else this run's screen_crops outcome and the catalogue compare service",
    droppedWhen: "fewer than 2 crop ids are catalogue crops (unknown-id per row, then empty-after-resolve)",
  },
  {
    name: "PlanOptions",
    nodeType: "plan_options",
    params: [p("source", "value", z.enum(PLAN_SOURCES).nullable(), `${enumText(PLAN_SOURCES)} | null (null: alternatives when present, else plan)`, { optional: true })],
    data: true,
    summary: "year-plan cards: the stored plan options, the alternatives when the year is full, or the saved seasons with sown or planned chips",
    fills: "the stored year-plan review of the viewed field and the field's saved seasons",
    droppedWhen: "the chosen source has nothing to show (empty-after-resolve)",
  },
  {
    name: "GrowthJourney",
    nodeType: "growth_journey",
    params: [p("cropId", "value", idString, "string (catalogue crop id)"), p("sowingDate", "value", isoDate.nullable(), "YYYY-MM-DD | null (null: the crop-fit sowing for the crop, else today)", { optional: true })],
    data: true,
    summary: "the crop's stage timeline from its sowing date; the farmer can ask for illustrative images",
    fills: "the stage calendar (services/today/stage-timeline.ts, the timeline the season preview uses)",
    droppedWhen: "the crop id is unknown (unknown-id) or the crop has no sourced stages (empty-after-resolve)",
  },
  {
    name: "Choice",
    nodeType: "choice",
    params: [p("blockId", "value", idString, "string (the answer block that asks the question)"), p("actions", "actions", z.array(z.unknown()), "action[] (1 to 6)", { min: 1, max: 6 })],
    data: false,
    summary: "one of your answer blocks as a question with buttons",
    fills: "the gated block as the prompt; labels written by code",
    droppedWhen: "the block is not approved (unknown-id) or no action survives (empty-after-resolve)",
  },
  {
    name: "Actions",
    nodeType: "actions",
    params: [p("actions", "actions", z.array(z.unknown()), "action[] (1 to 6)", { min: 1, max: 6 })],
    data: false,
    summary: "a row of buttons",
    fills: "labels written by code per action kind",
    droppedWhen: "no action survives (empty-after-resolve)",
  },
];

export const ACTIONS: readonly ActionDecl[] = [
  { name: "PickCrop", kind: "pick_crop", params: [p("cropId", "value", idString, "string (catalogue crop id)")], summary: "opens the plan-this-crop sheet (the farmer confirms any save there)", validates: "catalogue crop id" },
  { name: "ShowJourney", kind: "show_journey", params: [p("cropId", "value", idString, "string (catalogue crop id)")], summary: "shows how the crop grows, with illustrative images on request", validates: "catalogue crop id" },
  { name: "Compare", kind: "compare", params: [p("cropIds", "value", z.array(idString), "string[] (2 to 4 catalogue crop ids)", { min: 2, max: 4 })], summary: "opens the compare tool with these crops", validates: "catalogue crop ids, at least 2 survive" },
  {
    name: "UsePlan",
    kind: "use_plan",
    params: [p("source", "value", z.enum(USE_PLAN_SOURCES), enumText(USE_PLAN_SOURCES)), p("optionId", "value", idString, "string (an optionId of the stored year plan or of its alternatives)")],
    summary: "opens the year-plan option sheet for that option",
    validates: "option id of the stored review (or its alternatives); a sown_comparison alternative is not-replaceable",
  },
  {
    name: "ReplaceSeason",
    kind: "replace_season",
    params: [p("rotationPlanId", "value", idString, "string (a saved season id of the viewed field)"), p("cropId", "value", idString, "string (catalogue crop id)")],
    summary: "confirm sheet to replace a planned, unsown saved season with this crop",
    validates: "rotation plan id among the viewed field's saved seasons; a sown season is not-replaceable",
  },
  {
    name: "AddSeason",
    kind: "add_season",
    params: [p("cropId", "value", idString, "string (catalogue crop id)"), p("sowingDate", "value", isoDate.nullable(), "YYYY-MM-DD | null (null: the crop-fit sowing for the crop)", { optional: true })],
    summary: "confirm sheet to add the crop as a planned season",
    validates: "catalogue crop id; the sowing date is today or later",
  },
  { name: "Open", kind: "open", params: [p("target", "value", EvaraOpenTarget, enumText(EvaraOpenTarget.options))], summary: "navigates to a part of the app", validates: "enum" },
  { name: "Ask", kind: "ask", params: [p("promptKey", "value", EvaraPromptKey, enumText(EvaraPromptKey.options))], summary: "sends a code-written follow-up question", validates: "enum" },
];

export const COMPONENT_BY_NAME: ReadonlyMap<string, ComponentDecl> = new Map(COMPONENTS.map((c) => [c.name, c]));
export const ACTION_BY_NAME: ReadonlyMap<string, ActionDecl> = new Map(ACTIONS.map((a) => [a.name, a]));
export const DATA_NODE_TYPES: ReadonlySet<EvaraNode["type"]> = new Set(COMPONENTS.filter((c) => c.data).map((c) => c.nodeType));
