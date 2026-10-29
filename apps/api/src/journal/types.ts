import { z } from "zod";
import { IsoDate, Sha256Hex } from "@harvest/contracts";

export const JOURNAL_JOB_TYPE = "journal.analysis";
export const AI_PROPOSAL_LABEL = "AI proposal — confirm before it changes your plan";
export const PROMPT_NAME = "harvest-journal-observation";
export const PROMPT_VERSION = "1";

/** Fields that map to a typed plan change. Anything else is stored and shown but never changes a plan. */
export const PLAN_FIELDS = ["observed_stage", "irrigation_category", "planting_date"] as const;
export type PlanField = (typeof PLAN_FIELDS)[number];
export const isPlanField = (f: string): f is PlanField => (PLAN_FIELDS as readonly string[]).includes(f);

export const ACTIVITIES = ["planting", "irrigation", "weeding", "fertilizer", "pest_check", "harvest", "sale", "expense", "other", "observation"] as const;
export const QUANTITY_UNITS = ["kg", "L", "m3", "mm", "ha", "acre", "days", "g", "t", "quintal"] as const;

const t = (n: number) => z.string().trim().min(1).max(n);

/** Strict structured output requested from Meta for one observation. Flat objects keep strict mode simple. */
export const InterpretationOutput = z
  .object({
    visibleObservations: z.array(t(300)).max(8),
    competingInterpretations: z.array(z.object({ label: t(120), rationale: t(400) }).strict()).max(5),
    missingContext: z.array(t(300)).max(6),
    proposedFacts: z
      .array(
        z
          .object({
            field: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
            value: z.union([z.string().max(200), z.number().finite()]),
            unit: z.string().max(20).nullable(),
            basis: z.literal("ai_proposed"),
            requiresConfirmation: z.literal(true),
          })
          .strict(),
      )
      .max(8),
    candidatePlanChanges: z
      .array(
        z
          .object({
            type: z.enum(["observed_stage", "irrigation_category", "planting_date", "note_only"]),
            stageId: z.string().max(100).nullable(),
            category: z.string().max(40).nullable(),
            date: z.string().max(10).nullable(),
            note: z.string().max(300).nullable(),
            rationale: t(300),
          })
          .strict(),
      )
      .max(4),
    imageQualityIssues: z.array(z.enum(["blur", "too_dark", "too_bright", "too_far", "occluded", "no_crop_visible", "other"])).max(6),
    requestAnotherAngle: z.boolean(),
    aiNarrative: z.string().max(800),
  })
  .strict();
export type InterpretationOutput = z.infer<typeof InterpretationOutput>;

// ---------------------------------------------------------------- request bodies
const money = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, "expected a non-negative amount with at most 2 decimals");

export const CreateEntryBody = z
  .object({
    clientEntryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    farmId: z.uuid(),
    planId: z.uuid().optional(),
    observedOn: IsoDate,
    note: z.string().trim().max(10000).optional(),
    language: z.enum(["en", "ta", "hi"]).optional(),
    mediaIds: z.array(z.uuid()).max(4).default([]),
    activity: z.enum(ACTIVITIES).optional(),
    quantity: z.object({ value: z.number().positive().max(1e9), unit: z.enum(QUANTITY_UNITS) }).strict().optional(),
    expense: z.object({ amountInr: money, category: t(60) }).strict().optional(),
    /** Farmer-selected stage. Stored as an original fact and as a proposed fact that needs confirmation before it can revise the plan. */
    stageId: z.string().trim().min(1).max(100).optional(),
    /** Client draft version for offline sync (T15); a stale value is refused with 409 once the entry has moved on. */
    version: z.number().int().positive().default(1),
  })
  .strict();
export type CreateEntryBody = z.infer<typeof CreateEntryBody>;

export const ConfirmBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    accept: z.array(z.uuid()).max(20).default([]),
    reject: z.array(z.uuid()).max(20).default([]),
    /** Required when an accepted fact maps to a typed plan change: the hash of the plan the farmer is looking at. */
    expectedPlanContentHash: Sha256Hex.optional(),
  })
  .strict()
  .refine((b) => b.accept.length + b.reject.length > 0, { message: "accept or reject at least one fact" })
  .refine((b) => !b.accept.some((id) => b.reject.includes(id)), { message: "a fact cannot be both accepted and rejected" });
export type ConfirmBody = z.infer<typeof ConfirmBody>;

export const PreviewBody = z.object({ factIds: z.array(z.uuid()).min(1).max(20) }).strict();
export const TaskCompletionBody = z.object({ taskId: z.string().min(1).max(200), completedOn: IsoDate }).strict();
export type TaskCompletionBody = z.infer<typeof TaskCompletionBody>;
