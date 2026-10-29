import { z } from "zod";
import { Mode, StructuredAssistantOutput, type Unit } from "@harvest/contracts";
import { Decimal, convertDecimal } from "@harvest/domain";
import type { Pool } from "../db/pool";
import { detectHighRisk, dosageMentions, normalizeDigits, stripDates } from "./risk";

/**
 * Independent output gate (BUILD_SPEC 9, PRD 13). The model and tool outputs cannot disable it: it is
 * invoked by the loop on every candidate answer and any failure inside the gate yields `unverified`,
 * never an approval. Meaning is not verified here beyond the rule checks listed below; narrative
 * agronomy without a claimEvidenceRef is not blocked by this gate and remains a labelled limitation.
 */

export const GateContext = z
  .object({
    ownerId: z.string().min(1),
    mode: Mode,
    agentRunId: z.string().min(1),
    asOf: z.iso.datetime({ offset: true }),
    language: z.string().min(2),
    /** Server-derived claim scope: farm district/state ids and the crops under discussion. */
    claimScope: z.object({ geographyIds: z.array(z.string()), cropIds: z.array(z.string()) }).strict(),
    /** The farmer's own message; numbers the farmer stated may be echoed without a reference. */
    userText: z.string().max(4000).default(""),
    rainHorizonDays: z.number().int().positive().default(7),
    allowConfidencePercent: z.boolean().default(false),
  })
  .strict();
export type GateContext = z.input<typeof GateContext>;

export interface StoredToolResult {
  id: string;
  ownerId: string;
  agentRunId: string;
  runMode: string;
  toolName: string;
  status: string;
  result: unknown;
}

export interface EvidenceFact {
  id: string;
  mode: string;
  validationStatus: string;
  geographyLevel: string | null;
  geographyIds: string[];
  cropIds: string[];
  effectiveAvailableAt: string | null;
  availabilityBasis: string | null;
}

export interface GateFacts {
  toolResults: Map<string, StoredToolResult>;
  evidence: Map<string, EvidenceFact>;
}

export interface GateIssue {
  code: string;
  message: string;
  blockIds: string[];
  /** Safe to describe to the model in a correction request. */
  correctable: boolean;
}

export type GateStatus = "approved" | "partial" | "correction_requested" | "unverified";

export interface GateResult {
  status: GateStatus;
  approvedBlocks: StructuredAssistantOutput["answerBlocks"];
  approvedNumericRefs: StructuredAssistantOutput["numericRefs"];
  approvedClaimEvidenceRefs: StructuredAssistantOutput["claimEvidenceRefs"];
  issues: GateIssue[];
  correctionRequest?: { instruction: string; issues: { code: string; message: string; blockIds: string[] }[] };
  incomplete?: { reasons: string[] };
  /** The strictly parsed output (only when the schema parse passed). */
  parsed?: StructuredAssistantOutput;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unverified = (reason: string): GateResult => ({
  status: "unverified",
  approvedBlocks: [],
  approvedNumericRefs: [],
  approvedClaimEvidenceRefs: [],
  issues: [{ code: reason, message: `gate could not verify the answer (${reason})`, blockIds: [], correctable: false }],
  incomplete: { reasons: [reason] },
});

// ---------------------------------------------------------------- pointer resolution
export function resolvePointer(doc: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  if (pointer === "") return { found: true, value: doc };
  if (!pointer.startsWith("/")) return { found: false };
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { found: false };
      const i = Number(key);
      if (i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (typeof cur === "object" && cur !== null) {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false };
      cur = (cur as Record<string, unknown>)[key];
    } else return { found: false };
  }
  return { found: true, value: cur };
}

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
function toDecimal(v: unknown): Decimal | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Decimal(v);
  if (typeof v === "string" && DECIMAL.test(v)) return new Decimal(v);
  return null;
}

/** Stored value -> presented value: permitted unit conversion (tested domain code), then declared rounding. */
export function presentedValue(stored: Decimal, sourceUnit: Unit, unit: Unit, rounding: { mode: "decimals" | "significant"; digits: number }): Decimal {
  const converted = sourceUnit === unit ? stored : convertDecimal(stored, sourceUnit, unit);
  return rounding.mode === "decimals" ? converted.toDecimalPlaces(rounding.digits, Decimal.ROUND_HALF_UP) : converted.toSignificantDigits(Math.max(1, rounding.digits), Decimal.ROUND_HALF_UP);
}

// ---------------------------------------------------------------- prose numbers
export function proseNumbers(text: string): Decimal[] {
  let t = normalizeDigits(text);
  t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " "); // ids
  t = stripDates(t);
  t = t.replace(/(^|\n)\s*\d{1,2}[.)]\s/g, "$1 "); // list ordinals
  const out: Decimal[] = [];
  for (const m of t.matchAll(/(?<![\p{L}\p{N}_])-?\d[\d,]*(?:\.\d+)?/gu)) {
    const cleaned = m[0].replace(/,/g, "");
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) out.push(new Decimal(cleaned));
  }
  return out;
}

const UNIT_WORDS: Partial<Record<Unit, RegExp>> = {
  ha: /\b(ha|hectares?)\b|हेक्टेयर|ஹெக்டேர்/iu,
  acre: /\b(acres?)\b|एकड़|ஏக்கர்/iu,
  kg: /\b(kg|kgs|kilograms?|kilos?)\b|किलो|கிலோ/iu,
  quintal: /\b(quintals?|qtl)\b|क्विंटल|குவிண்டால்/iu,
  t: /\b(t|tonnes?|tons?|mt)\b|टन|டன்/iu,
  INR: /₹|\b(inr|rs\.?|rupees?)\b|रुपय|ரூபாய்/iu,
  "INR/kg": /₹|\b(inr|rs\.?|rupees?)\b|रुपय|ரூபாய்/iu,
  "INR/quintal": /₹|\b(inr|rs\.?|rupees?)\b|रुपय|ரூபாய்/iu,
  "INR/ha": /₹|\b(inr|rs\.?|rupees?)\b|रुपय|ரூபாய்/iu,
  mm: /\b(mm|millimet(?:re|er)s?)\b|मिमी|மி\.?மீ/iu,
  L: /\b(l|litres?|liters?)\b|लीटर|லிட்டர்/iu,
  m3: /\b(m3|m³|cubic\s+met(?:re|er)s?)\b/iu,
  "kg/ha": /\bkg\s?(\/|per)\s?(ha|hectare)\b/iu,
  "kg/acre": /\bkg\s?(\/|per)\s?acre\b/iu,
  days: /\b(days?)\b|दिन|நாட்கள்|நாள்/iu,
  celsius: /°\s?c|\b(celsius|degrees?)\b|डिग्री|டிகிரி/iu,
  cm: /\b(cm|centimet(?:re|er)s?)\b|सेमी|செ\.?மீ/iu,
  m: /\b(m|met(?:re|er)s?)\b|मीटर|மீட்டர்/iu,
  g: /\b(g|gm|grams?)\b|ग्राम|கிராம்/iu,
  months: /\b(months?)\b|महीन|மாதம்|மாதங்கள்/iu,
  percent: /%|\b(percent|per\s?cent)\b|प्रतिशत|சதவீதம்/iu,
};

// ---------------------------------------------------------------- geography / evidence
export function evidenceCoversScope(e: EvidenceFact, ctx: z.output<typeof GateContext>): string[] {
  const problems: string[] = [];
  if (e.validationStatus !== "validated") problems.push("evidence_not_validated");
  const modeOk = ctx.mode === "synthetic" ? e.mode === "synthetic" : ctx.mode === "replay" ? e.mode === "replay" || e.mode === "live" : e.mode === "live";
  if (!modeOk) problems.push("evidence_mode_mismatch");
  const asOf = Date.parse(ctx.asOf);
  const avail = e.effectiveAvailableAt ? Date.parse(e.effectiveAvailableAt) : null;
  if (ctx.mode === "replay") {
    if (avail === null || e.availabilityBasis === "unverified" || avail > asOf) problems.push("evidence_not_available_at_cutoff");
  } else if (avail !== null && avail > asOf) problems.push("evidence_not_available_at_cutoff");
  const national = e.geographyLevel === "national";
  if (!national && !e.geographyIds.some((g) => ctx.claimScope.geographyIds.includes(g))) problems.push("evidence_scope_geography");
  if (ctx.claimScope.cropIds.length > 0 && !ctx.claimScope.cropIds.every((c) => e.cropIds.includes(c))) problems.push("evidence_scope_crop");
  return problems;
}

// ---------------------------------------------------------------- pure evaluation
export function evaluateGate(raw: unknown, ctxIn: GateContext, facts: GateFacts): GateResult {
  try {
    const ctxParsed = GateContext.safeParse(ctxIn);
    if (!ctxParsed.success) return unverified("malformed_gate_context");
    const ctx = ctxParsed.data;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unverified("malformed_gate_input");
    if (!(facts?.toolResults instanceof Map) || !(facts?.evidence instanceof Map)) return unverified("malformed_gate_facts");

    // Step 1: strict schema parse.
    const p = StructuredAssistantOutput.safeParse(raw);
    if (!p.success) {
      const issues = p.error.issues.slice(0, 8).map((i) => ({ code: "schema_invalid", message: `${i.path.join(".") || "(root)"}: ${i.message}`.slice(0, 200), blockIds: [] as string[] }));
      return {
        status: "correction_requested",
        approvedBlocks: [],
        approvedNumericRefs: [],
        approvedClaimEvidenceRefs: [],
        issues: issues.map((i) => ({ ...i, correctable: true })),
        correctionRequest: { instruction: "The output did not match the required schema. Return the complete JSON again with every field valid.", issues },
        incomplete: { reasons: ["schema_invalid"] },
      };
    }
    const out = p.data;
    const issues: GateIssue[] = [];
    const blockIssues = new Map<string, GateIssue[]>();
    const addBlockIssue = (blockId: string, code: string, message: string, correctable = true) => {
      const issue: GateIssue = { code, message, blockIds: [blockId], correctable };
      issues.push(issue);
      blockIssues.set(blockId, [...(blockIssues.get(blockId) ?? []), issue]);
    };

    // Steps 2-3: ownership, mode, source availability and numeric reference resolution.
    const refById = new Map<string, (typeof out.numericRefs)[number]>();
    const dupRefs = new Set<string>();
    for (const r of out.numericRefs) {
      if (refById.has(r.id)) dupRefs.add(r.id);
      refById.set(r.id, r);
    }
    const refProblem = new Map<string, { code: string; message: string }>();
    const refPresented = new Map<string, Decimal>();
    for (const r of out.numericRefs) {
      if (dupRefs.has(r.id)) {
        refProblem.set(r.id, { code: "numeric_ref_duplicate_id", message: `numericRef id ${r.id} is reused` });
        continue;
      }
      const tr = facts.toolResults.get(r.toolResultId);
      if (!tr) {
        refProblem.set(r.id, { code: "tool_result_unknown", message: `numericRef ${r.id} points at an unknown tool result` });
        continue;
      }
      if (tr.ownerId !== ctx.ownerId || tr.agentRunId !== ctx.agentRunId) {
        refProblem.set(r.id, { code: "tool_result_foreign", message: `numericRef ${r.id} points at a tool result outside this request` });
        continue;
      }
      if (tr.runMode !== ctx.mode) {
        refProblem.set(r.id, { code: "mode_mismatch", message: `numericRef ${r.id} points at a tool result from another runtime mode` });
        continue;
      }
      if (tr.status !== "ok") {
        refProblem.set(r.id, { code: "tool_result_not_ok", message: `numericRef ${r.id} points at a tool result that did not succeed` });
        continue;
      }
      const at = resolvePointer(tr.result, r.jsonPointer);
      if (!at.found) {
        refProblem.set(r.id, { code: "numeric_ref_pointer_unresolved", message: `numericRef ${r.id} pointer does not resolve in the stored result` });
        continue;
      }
      const dec = toDecimal(at.value);
      if (dec === null) {
        refProblem.set(r.id, { code: "numeric_ref_not_numeric", message: `numericRef ${r.id} does not point at a number` });
        continue;
      }
      try {
        refPresented.set(r.id, presentedValue(dec, r.presentation.sourceUnit, r.presentation.unit, r.presentation.rounding));
      } catch {
        refProblem.set(r.id, { code: "unit_conversion_not_permitted", message: `numericRef ${r.id}: ${r.presentation.sourceUnit} to ${r.presentation.unit} is not a permitted conversion` });
      }
    }

    // Step 4: claim evidence resolution and scope.
    const claimProblem = new Map<string, { code: string; message: string }>();
    for (const c of out.claimEvidenceRefs) {
      if (claimProblem.has(c.claimId)) continue;
      const rows = c.evidenceIds.map((id) => ({ id, row: facts.evidence.get(id) }));
      const missing = rows.filter((r) => !r.row);
      if (missing.length > 0) {
        claimProblem.set(c.claimId, { code: "evidence_missing", message: `claim ${c.claimId} cites evidence that does not exist` });
        continue;
      }
      const results = rows.map((r) => ({ id: r.id, problems: evidenceCoversScope(r.row!, ctx) }));
      if (!results.some((r) => r.problems.length === 0)) {
        const first = results[0]!.problems[0] ?? "evidence_scope";
        claimProblem.set(c.claimId, { code: first, message: `claim ${c.claimId}: cited evidence does not cover the claim (${[...new Set(results.flatMap((r) => r.problems))].join(", ")})` });
      }
    }

    // Steps 5-6 per block.
    const asOfDate = new Date(ctx.asOf);
    const userNumbers = proseNumbers(ctx.userText);
    for (const b of out.answerBlocks) {
      for (const id of b.numericRefIds) {
        const prob = refProblem.get(id);
        if (prob) addBlockIssue(b.id, prob.code, prob.message);
      }
      for (const id of b.claimIds) {
        const prob = claimProblem.get(id);
        if (prob) addBlockIssue(b.id, prob.code, prob.message);
      }
      if (b.kind === "evidence" && b.claimIds.length === 0) addBlockIssue(b.id, "evidence_block_without_claim", "an evidence block must cite a claim");

      const good = b.numericRefIds.filter((id) => refPresented.has(id));
      const presented = good.map((id) => ({ id, value: refPresented.get(id)!, ref: refById.get(id)! }));
      const nums = proseNumbers(b.text);
      // Displayed value must equal the stored value after the permitted conversion and rounding.
      for (const pv of presented) {
        if (!nums.some((n) => n.equals(pv.value))) addBlockIssue(b.id, "numeric_display_mismatch", `block ${b.id}: the text does not display ${pv.id} as ${pv.value.toString()} ${pv.ref.presentation.unit}`);
        else if (ctx.language === "en" && !(UNIT_WORDS[pv.ref.presentation.unit] ?? new RegExp(`\\b${pv.ref.presentation.unit}\\b`, "i")).test(b.text)) addBlockIssue(b.id, "unit_missing_in_prose", `block ${b.id}: the unit ${pv.ref.presentation.unit} is not stated next to the number`);
      }
      // Prose/number agreement: any other number needs a reference (or is the farmer's own stated number).
      const dosage = dosageMentions(b.text);
      for (const n of nums) {
        const covered = presented.some((pv) => pv.value.equals(n)) || userNumbers.some((u) => u.equals(n));
        if (!covered) {
          addBlockIssue(b.id, "prose_number_without_ref", `block ${b.id}: the number ${n.toString()} appears in the text without a numericRef`);
          break; // one correction item per block keeps the request bounded
        }
      }
      // High-risk assertions.
      for (const h of detectHighRisk(b.text, { asOf: asOfDate, rainHorizonDays: ctx.rainHorizonDays, allowConfidencePercent: ctx.allowConfidencePercent })) {
        if (h.code === "chemical_dosage") {
          // Only evidence-backed, reference-backed mass-per-area input rates may pass; never ml/g-per-litre doses.
          const allMassPerArea = dosage.every((d) => /kg\s?(\/|per)\s?(ha|hectare|acre)/iu.test(d.unit));
          const backed = dosage.every((d) => presented.some((pv) => pv.value.equals(new Decimal(d.value)) && ["kg/ha", "kg/acre"].includes(pv.ref.presentation.unit)));
          const cited = b.claimIds.length > 0 && b.claimIds.every((id) => !claimProblem.has(id));
          if (allMassPerArea && backed && cited) continue;
        }
        addBlockIssue(b.id, h.code, `block ${b.id}: ${h.message}`);
      }
    }

    const blocked = new Set(blockIssues.keys());
    const approvedBlocks = out.answerBlocks.filter((b) => !blocked.has(b.id));
    const usedRefs = new Set(approvedBlocks.flatMap((b) => b.numericRefIds));
    const usedClaims = new Set(approvedBlocks.flatMap((b) => b.claimIds));
    const result: GateResult = {
      status: blocked.size === 0 ? "approved" : approvedBlocks.length > 0 ? "partial" : "correction_requested",
      approvedBlocks,
      approvedNumericRefs: out.numericRefs.filter((r) => usedRefs.has(r.id)),
      approvedClaimEvidenceRefs: out.claimEvidenceRefs.filter((c) => usedClaims.has(c.claimId)),
      issues,
      parsed: out,
    };
    if (issues.length > 0) {
      result.correctionRequest = {
        instruction:
          "Some answer blocks were withheld by the verification gate. Rewrite only those blocks: state quantities exactly as their numericRef presents them with units, cite only existing evidence that covers the farm's district and crop, and remove forbidden content (doses, certain diagnoses, guarantees, confidence percentages, exact rain beyond the horizon, yield from photos). Return the complete JSON again.",
        issues: issues.map((i) => ({ code: i.code, message: i.message, blockIds: i.blockIds })),
      };
      result.incomplete = { reasons: [...new Set(issues.map((i) => i.code))] };
    }
    return result;
  } catch {
    return unverified("gate_internal_error");
  }
}

// ---------------------------------------------------------------- DB lookups + composition
export async function loadGateFacts(pool: Pool, raw: unknown): Promise<GateFacts> {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const trIds = new Set<string>();
  const evIds = new Set<string>();
  if (Array.isArray(o.numericRefs)) for (const r of o.numericRefs) if (typeof (r as { toolResultId?: unknown })?.toolResultId === "string") trIds.add((r as { toolResultId: string }).toolResultId);
  if (Array.isArray(o.claimEvidenceRefs)) for (const c of o.claimEvidenceRefs) if (Array.isArray((c as { evidenceIds?: unknown })?.evidenceIds)) for (const id of (c as { evidenceIds: unknown[] }).evidenceIds) if (typeof id === "string") evIds.add(id);
  const tr = [...trIds].filter((x) => UUID.test(x));
  const ev = [...evIds].filter((x) => UUID.test(x));
  const facts: GateFacts = { toolResults: new Map(), evidence: new Map() };
  if (tr.length > 0) {
    const r = await pool.query<{ id: string; owner_id: string; agent_run_id: string; mode: string; tool_name: string; status: string; result: unknown }>(
      `SELECT t.id, t.owner_id, t.agent_run_id, a.mode, t.tool_name, t.status, t.result
         FROM tool_results t JOIN agent_runs a ON a.id = t.agent_run_id WHERE t.id = ANY($1::uuid[])`,
      [tr],
    );
    for (const row of r.rows) facts.toolResults.set(row.id, { id: row.id, ownerId: row.owner_id, agentRunId: row.agent_run_id, runMode: row.mode, toolName: row.tool_name, status: row.status, result: row.result });
  }
  if (ev.length > 0) {
    const r = await pool.query<{ id: string; mode: string; validation_status: string; geography_level: string | null; geography_ids: string[]; crop_ids: string[]; effective_available_at: Date | null; availability_basis: string | null }>(
      `SELECT id, mode, validation_status, geography_level, geography_ids, crop_ids, effective_available_at, availability_basis FROM evidence_records WHERE id = ANY($1::uuid[])`,
      [ev],
    );
    for (const row of r.rows) {
      facts.evidence.set(row.id, {
        id: row.id,
        mode: row.mode,
        validationStatus: row.validation_status,
        geographyLevel: row.geography_level,
        geographyIds: row.geography_ids,
        cropIds: row.crop_ids,
        effectiveAvailableAt: row.effective_available_at ? row.effective_available_at.toISOString() : null,
        availabilityBasis: row.availability_basis,
      });
    }
  }
  return facts;
}

export async function runOutputGate(pool: Pool, raw: unknown, ctx: GateContext): Promise<GateResult> {
  try {
    const facts = await loadGateFacts(pool, raw);
    return evaluateGate(raw, ctx, facts);
  } catch {
    return unverified("gate_lookup_failed");
  }
}
