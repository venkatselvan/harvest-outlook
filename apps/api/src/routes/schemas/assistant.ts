import { z } from "zod";
import { FieldId, StructuredAssistantOutput } from "@harvest/contracts";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export const turnBody = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    /** Transcript the farmer reviewed and confirmed (speech pipeline). Exactly one of text/confirmedTranscript. */
    confirmedTranscript: z.string().trim().min(1).max(2000).optional(),
    language: z.enum(["en", "ta", "hi"]),
    farmId: z.uuid().optional(),
    /** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.5): the field selected in the shell; needs farmId and must name a field of that farm (404 field_not_found). */
    fieldId: FieldId.optional(),
    planId: z.uuid().optional(),
    selectedDate: z.string().regex(dateRe).optional(),
    scenarioId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/).optional(),
  })
  .strict()
  .refine((b) => (b.text === undefined) !== (b.confirmedTranscript === undefined), { message: "provide exactly one of text or confirmedTranscript" })
  .refine((b) => b.fieldId === undefined || b.farmId !== undefined, { message: "fieldId needs farmId", path: ["fieldId"] });
export type TurnBody = z.infer<typeof turnBody>;

const shape = StructuredAssistantOutput.shape;

export const turnOut = z.object({
  status: z.enum(["approved", "partial", "incomplete", "provider_unavailable", "budget_exceeded", "cancelled", "failed"]),
  /** `synthetic_fixture` answers come from recorded synthetic fixtures, never from a live model. */
  provenance: z.enum(["meta_live", "synthetic_fixture"]),
  traceId: z.string(),
  intent: z.string().nullable(),
  language: z.string(),
  gateStatus: z.enum(["approved", "partial", "correction_requested", "unverified"]).nullable(),
  /** Only blocks that passed the independent output gate. */
  answerBlocks: shape.answerBlocks,
  numericRefs: shape.numericRefs,
  claimEvidenceRefs: shape.claimEvidenceRefs,
  proposedFacts: shape.proposedFacts,
  clarifications: shape.clarifications,
  /** Exact text TTS may speak: approved block texts joined by a blank line; null when nothing was approved. */
  approvedText: z.string().nullable(),
  /** sha256 of approvedText, recorded server-side; echo it to the speech synthesis endpoint. */
  approvedTextHash: z.string().nullable(),
  limitations: z.array(z.string()),
  incomplete: z.object({ reasons: z.array(z.string()) }).nullable(),
  /**
   * What the output gate withheld (F8), so the client can say "withheld" honestly: removed blocks, claims,
   * limitations, clarifications/options with reason codes (no withheld text); evidence ids that are only
   * machine-grounded; and blocks whose text was replaced by a server template. Null when no gate ran.
   */
  gateReport: z
    .object({
      removed: z.array(
        z.object({
          field: z.enum(["answerBlock", "claimEvidenceRef", "limitation", "clarification", "clarificationOption"]),
          id: z.string().nullable(),
          index: z.number().int(),
          codes: z.array(z.string()),
        }),
      ),
      groundedEvidenceIds: z.array(z.string()),
      templateSubstituted: z.array(z.object({ blockId: z.string(), template: z.string() })),
    })
    .nullable(),
  costEstimate: z.object({ estimatedUsd: z.number(), settledUsd: z.number(), providerCalls: z.number(), billable: z.boolean(), basis: z.literal("estimated_not_billed") }),
});
export type TurnOut = z.infer<typeof turnOut>;
