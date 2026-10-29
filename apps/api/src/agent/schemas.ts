import { z } from "zod";
import { AssistantIntent, ClaimEvidenceRef, LanguageCode, Unit } from "@harvest/contracts";

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

/** Profile fields a clarification question may target (same enum as ProposedProfile facts). */
export const PROFILE_FIELDS: readonly string[] = ProposedProfile.shape.facts.element.shape.field.options;

/**
 * Claim scope fields (F8: promoted into @harvest/contracts ClaimEvidenceRef; re-exported here). The gate
 * still splits them off before the strict parse so it can check them against server-derived scope.
 */
export { ClaimGranularity } from "@harvest/contracts";
export const ClaimScopeExtras = ClaimEvidenceRef.pick({ cropIds: true, productIds: true, granularity: true }).strict();
export type ClaimScopeExtras = z.infer<typeof ClaimScopeExtras>;
/** Same schema as the contract (kept as a named export for the loop's JSON schema). */
export const AgentClaimEvidenceRef = ClaimEvidenceRef;

const EXTRA_KEYS = ["cropIds", "productIds", "granularity"] as const;

/** Splits the agent-local claim fields off a raw output. Never throws; invalid extras are reported. */
export function splitClaimExtras(raw: unknown): { ok: true; stripped: unknown; extras: Map<string, ClaimScopeExtras> } | { ok: false; message: string } {
  const extras = new Map<string, ClaimScopeExtras>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: true, stripped: raw, extras };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.claimEvidenceRefs)) return { ok: true, stripped: raw, extras };
  const refs: unknown[] = [];
  for (const [i, c] of o.claimEvidenceRefs.entries()) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      refs.push(c);
      continue;
    }
    const rest: Record<string, unknown> = {};
    const ex: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if ((EXTRA_KEYS as readonly string[]).includes(k)) {
        if (v !== null && v !== undefined) ex[k] = v;
      } else rest[k] = v;
    }
    const parsed = ClaimScopeExtras.safeParse(ex);
    if (!parsed.success) return { ok: false, message: `claimEvidenceRefs.${i}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`.slice(0, 300) };
    if (typeof rest.claimId === "string") extras.set(rest.claimId, parsed.data);
    refs.push(rest);
  }
  return { ok: true, stripped: { ...o, claimEvidenceRefs: refs }, extras };
}

/** Re-attaches declared claim extras (used when the server rebuilds an output, e.g. template substitution). */
export function attachClaimExtras<T extends { claimEvidenceRefs: { claimId: string }[] }>(out: T, extras: Map<string, ClaimScopeExtras>): T {
  return { ...out, claimEvidenceRefs: out.claimEvidenceRefs.map((c) => ({ ...c, ...(extras.get(c.claimId) ?? {}) })) };
}
