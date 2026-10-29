import { z } from "zod";
import { AssistantIntent, LanguageCode, Unit } from "@harvest/contracts";

/** Output of the interpretation pass: proposals only. Code maps these to ValueRecords and the farmer confirms. */
export const ProposedProfile = z
  .object({
    intent: AssistantIntent,
    language: LanguageCode,
    cropMentions: z.array(z.object({ text: z.string().min(1).max(200), language: LanguageCode }).strict()).max(10),
    facts: z
      .array(
        z
          .object({
            field: z.enum(["area", "irrigation", "water_availability", "district", "state", "budget", "labour", "planting_window", "soil", "experience", "other"]),
            text: z.string().min(1).max(200),
            number: z.number().finite().nullable(),
            unit: Unit.nullable(),
            sourceSpan: z.string().max(200).nullable(),
          })
          .strict(),
      )
      .max(20),
    needsEscalation: z.boolean(),
    clarificationQuestion: z.string().max(500).nullable(),
  })
  .strict();
export type ProposedProfile = z.infer<typeof ProposedProfile>;
