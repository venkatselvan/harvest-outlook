import { z } from "zod";
import { Mode, StructuredAssistantOutput, type Unit } from "@harvest/contracts";
import { Decimal, convertDecimal } from "@harvest/domain";
import type { Pool } from "../db/pool";
import { GRANULARITY_LABEL, INDIC_SCRIPT, termRe } from "./lexicon";
import { contextWord, numberTokens, proseNumbers, unitAdjacent, unitAt, type NumberToken } from "./numbers";
import { detectHighRisk, dosageMentions, nativeLexiconHits, type RiskCode } from "./risk";
import { PROFILE_FIELDS, splitClaimExtras, type ClaimGranularity, type ClaimScopeExtras } from "./schemas";

export { proseNumbers };

/**
 * Independent output gate (BUILD_SPEC 9, PRD 13). The model and tool outputs cannot disable it: it is
 * invoked by the loop on every candidate answer and any failure inside the gate yields `unverified`,
 * never an approval.
 *
 * Every model-written text field is checked: answer block text, claim text, limitations, and
 * clarification questions and options. A field that fails is removed from the approved output and
 * the removal is recorded in `report.removed`; nothing that failed is passed through.
 *
 * Hindi and Tamil text fails closed: any number (digits in any script, number words, multipliers) must
 * be displayed from a validated numericRef of the same block with its unit, and any Hindi/Tamil
 * high-risk lexicon term needs a validated numericRef or claim on the block. The farmer-number and
 * date exemptions apply to English text only.
 *
 * This is a rule-based gate. It does not verify meaning: narrative agronomy that avoids the lexicons
 * and carries no number is not detected, and no semantic verifier exists yet.
 */

export const GateContext = z
  .object({
    ownerId: z.string().min(1),
    mode: Mode,
    agentRunId: z.string().min(1),
    asOf: z.iso.datetime({ offset: true }),
    language: z.string().min(2),
    /**
     * Server-derived claim scope. `cropIds` come from the plan (or another server-owned selection); when
     * empty, every claim must declare `cropIds` that exist in the catalogue. Geography ids are the
     * owned farm's district/state (and region, when known). `geographyIds` is the legacy flat list,
     * classified by id pattern only when the explicit lists are empty.
     */
    claimScope: z
      .object({
        geographyIds: z.array(z.string()).default([]),
        districtIds: z.array(z.string()).default([]),
        stateIds: z.array(z.string()).default([]),
        regionIds: z.array(z.string()).default([]),
        cropIds: z.array(z.string()),
      })
      .strict(),
    /** The farmer's own message; numbers the farmer stated may be echoed (English, same unit) without a reference. */
    userText: z.string().max(4000).default(""),
    rainHorizonDays: z.number().int().positive().default(7),
    allowConfidencePercent: z.boolean().default(false),
  })
  .strict();
export type GateContext = z.input<typeof GateContext>;
type Ctx = z.output<typeof GateContext>;

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
  /** Catalogue crop ids that exist (for claim-declared crops). Missing = none verifiable. */
  knownCropIds?: Set<string>;
}

export interface GateIssue {
  code: string;
  message: string;
  blockIds: string[];
  /** Safe to describe to the model in a correction request. */
  correctable: boolean;
}

export type GateStatus = "approved" | "partial" | "correction_requested" | "unverified";

export interface RemovedItem {
  field: "answerBlock" | "claimEvidenceRef" | "limitation" | "clarification" | "clarificationOption";
  /** Block id, claim id or clarification id; null for limitations. */
  id: string | null;
  index: number;
  codes: string[];
}

export interface GateReport {
  removed: RemovedItem[];
  /** Evidence ids cited by approved claims that are machine-grounded (human review pending). */
  groundedEvidenceIds: string[];
  /** Filled by the loop when server templates replaced withheld statements. */
  templated: { blockId: string; template: string; numericRefIds: string[] }[];
}

/** A withheld answer block and the verified material a server template may use for it. */
export interface WithheldBlock {
  blockId: string;
  riskCodes: RiskCode[];
  /** numericRefs of the block whose stored value, conversion and rounding were verified. */
  validRefIds: string[];
  /** Subset of validRefIds whose stored result is a forecast/weather output. */
  forecastRefIds: string[];
}

export interface GateResult {
  status: GateStatus;
  approvedBlocks: StructuredAssistantOutput["answerBlocks"];
  approvedNumericRefs: StructuredAssistantOutput["numericRefs"];
  approvedClaimEvidenceRefs: StructuredAssistantOutput["claimEvidenceRefs"];
  approvedLimitations: string[];
  approvedClarifications: StructuredAssistantOutput["clarifications"];
  issues: GateIssue[];
  report: GateReport;
  withheld: WithheldBlock[];
  correctionRequest?: { instruction: string; issues: { code: string; message: string; blockIds: string[] }[] };
  incomplete?: { reasons: string[] };
  /** The strictly parsed output (only when the schema parse passed). */
  parsed?: StructuredAssistantOutput;
  /** Declared claim scope extras (agent-local fields stripped from `parsed`). */
  claimExtras?: Map<string, ClaimScopeExtras>;
  /** Verified presented value per numericRef id (after permitted conversion and rounding). */
  presented?: Map<string, Decimal>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyReport = (): GateReport => ({ removed: [], groundedEvidenceIds: [], templated: [] });
const nothing = () => ({ approvedBlocks: [], approvedNumericRefs: [], approvedClaimEvidenceRefs: [], approvedLimitations: [], approvedClarifications: [], report: emptyReport(), withheld: [] });
const unverified = (reason: string): GateResult => ({
  status: "unverified",
  ...nothing(),
  issues: [{ code: reason, message: `gate could not verify the answer (${reason})`, blockIds: [], correctable: false }],
  incomplete: { reasons: [reason] },
});
const schemaInvalid = (issues: { code: string; message: string; blockIds: string[] }[]): GateResult => ({
  status: "correction_requested",
  ...nothing(),
  issues: issues.map((i) => ({ ...i, correctable: true })),
  correctionRequest: { instruction: "The output did not match the required schema. Return the complete JSON again with every field valid.", issues },
  incomplete: { reasons: ["schema_invalid"] },
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

// ---------------------------------------------------------------- language and geography helpers
/** Hindi/Tamil rules apply when the turn language is hi/ta or the text contains Devanagari/Tamil script. */
export function isNativeText(language: string, text: string): boolean {
  return /^(hi|ta)(-|$)/i.test(language) || INDIC_SCRIPT.test(text);
}
const UNSUPPORTED_SCRIPT = /(?![\p{Script=Latin}\p{Script=Devanagari}\p{Script=Tamil}])[\p{L}]/u;

const LEVEL_RANK: Record<string, number> = { district: 1, state: 2, region: 3, market: 3, national: 4 };
const GRANULARITY_RANK: Record<ClaimGranularity, number> = { district: 1, state: 2, region: 3, national: 4 };

interface FarmGeo {
  districtIds: string[];
  stateIds: string[];
  regionIds: string[];
  present: boolean;
}
function farmGeo(ctx: Ctx): FarmGeo {
  const s = ctx.claimScope;
  let districtIds = s.districtIds;
  let stateIds = s.stateIds;
  if (districtIds.length === 0 && stateIds.length === 0 && s.geographyIds.length > 0) {
    districtIds = s.geographyIds.filter((g) => /^IN-[A-Z]{2}-[A-Z0-9]+$/i.test(g));
    stateIds = s.geographyIds.filter((g) => /^(IN-)?[A-Z]{2}$/i.test(g) && g.toUpperCase() !== "IN");
  }
  return { districtIds, stateIds, regionIds: s.regionIds, present: districtIds.length > 0 || stateIds.length > 0 };
}

/** Problems that stop one evidence row from supporting a claim at the given crops and granularity. */
export function evidenceCoversScope(e: EvidenceFact, ctx: Ctx, scope: { cropIds: string[]; granularity: ClaimGranularity }, geo: FarmGeo = farmGeo(ctx)): string[] {
  const problems: string[] = [];
  if (e.validationStatus !== "validated" && e.validationStatus !== "grounded") problems.push("evidence_not_validated");
  const modeOk = ctx.mode === "synthetic" ? e.mode === "synthetic" : ctx.mode === "replay" ? e.mode === "replay" || e.mode === "live" : e.mode === "live";
  if (!modeOk) problems.push("evidence_mode_mismatch");
  const asOf = Date.parse(ctx.asOf);
  const avail = e.effectiveAvailableAt ? Date.parse(e.effectiveAvailableAt) : null;
  if (ctx.mode === "replay") {
    if (avail === null || e.availabilityBasis === "unverified" || avail > asOf) problems.push("evidence_not_available_at_cutoff");
  } else if (avail !== null && avail > asOf) problems.push("evidence_not_available_at_cutoff");
  // Geography: evidence must be at the claim's granularity or finer, and cover the farm at its own level.
  const rank = e.geographyLevel ? LEVEL_RANK[e.geographyLevel] : undefined;
  if (rank === undefined) problems.push("evidence_scope_geography");
  else if (rank > GRANULARITY_RANK[scope.granularity]) problems.push("evidence_scope_granularity");
  else {
    const covers =
      e.geographyLevel === "national"
        ? true
        : e.geographyLevel === "district"
          ? e.geographyIds.some((g) => geo.districtIds.includes(g))
          : e.geographyLevel === "state"
            ? e.geographyIds.some((g) => geo.stateIds.includes(g))
            : e.geographyIds.some((g) => geo.regionIds.includes(g) || geo.districtIds.includes(g) || geo.stateIds.includes(g));
    if (!covers) problems.push("evidence_scope_geography");
  }
  if (scope.cropIds.length === 0 || !scope.cropIds.every((c) => e.cropIds.includes(c))) problems.push("evidence_scope_crop");
  return problems;
}

// ---------------------------------------------------------------- text checks
interface Presented {
  id: string;
  value: Decimal;
  unit: Unit;
}
interface FarmerToken {
  value: Decimal;
  key: string | null;
}
const tokenKey = (t: NumberToken): string | null => unitAt(t) ?? contextWord(t);

interface TextCheck {
  issues: { code: string; message: string }[];
  risks: RiskCode[];
}

function checkText(
  text: string,
  ctx: Ctx,
  o: { label: string; presented: Presented[]; requireDisplayed: boolean; farmer: FarmerToken[]; supported: boolean; dosageAllowed?: (m: ReturnType<typeof dosageMentions>) => boolean },
): TextCheck {
  const issues: { code: string; message: string }[] = [];
  const native = isNativeText(ctx.language, text);
  if (UNSUPPORTED_SCRIPT.test(text)) issues.push({ code: "unsupported_script", message: `${o.label}: text in a script other than Latin, Devanagari or Tamil cannot be verified` });

  const { tokens } = numberTokens(text, { englishDates: !native });
  const covered = new Set<NumberToken>();
  for (const pv of o.presented) {
    const same = tokens.filter((t) => t.value.equals(pv.value));
    const withUnit = same.filter((t) => unitAdjacent(t, pv.unit));
    withUnit.forEach((t) => covered.add(t));
    if (!o.requireDisplayed) continue;
    if (same.length === 0) issues.push({ code: "numeric_display_mismatch", message: `${o.label}: the text does not display ${pv.id} as ${pv.value.toString()} ${pv.unit}` });
    else if (withUnit.length === 0) issues.push({ code: "unit_missing_in_prose", message: `${o.label}: the unit ${pv.unit} is not stated next to ${pv.value.toString()}` });
  }
  for (const t of tokens) {
    if (covered.has(t)) continue;
    const key = tokenKey(t);
    const farmerOk = !native && key !== null && o.farmer.some((f) => f.key === key && f.value.equals(t.value));
    if (farmerOk) continue;
    issues.push({
      code: "prose_number_without_ref",
      message: native
        ? `${o.label}: the number ${t.value.toString()} has no matching numericRef with its unit (Hindi/Tamil text: every number needs one)`
        : `${o.label}: the number ${t.value.toString()} appears without a matching numericRef and unit`,
    });
    break; // one item per text keeps the correction request bounded
  }

  const risks: RiskCode[] = [];
  for (const h of detectHighRisk(text, { asOf: new Date(ctx.asOf), rainHorizonDays: ctx.rainHorizonDays, allowConfidencePercent: ctx.allowConfidencePercent })) {
    if (h.code === "chemical_dosage" && o.dosageAllowed?.(dosageMentions(text))) continue;
    risks.push(h.code);
    issues.push({ code: h.code, message: `${o.label}: ${h.message}` });
  }
  if (native && !o.supported) {
    const hits = nativeLexiconHits(text);
    if (hits.length > 0) issues.push({ code: "native_risk_term_unsupported", message: `${o.label}: Hindi/Tamil high-risk wording (${hits.join(", ")}) without a validated numericRef or claim` });
  }
  return { issues, risks };
}

const labelRe = (g: "state" | "region" | "national") => termRe(GRANULARITY_LABEL[g]);

// ---------------------------------------------------------------- pure evaluation
export function evaluateGate(raw: unknown, ctxIn: GateContext, facts: GateFacts): GateResult {
  try {
    const ctxParsed = GateContext.safeParse(ctxIn);
    if (!ctxParsed.success) return unverified("malformed_gate_context");
    const ctx = ctxParsed.data;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unverified("malformed_gate_input");
    if (!(facts?.toolResults instanceof Map) || !(facts?.evidence instanceof Map)) return unverified("malformed_gate_facts");
    if (facts.knownCropIds !== undefined && !(facts.knownCropIds instanceof Set)) return unverified("malformed_gate_facts");
    const knownCrops = facts.knownCropIds ?? new Set<string>();

    // Step 1: strict schema parse (agent-local claim fields are split off first).
    const split = splitClaimExtras(raw);
    if (!split.ok) return schemaInvalid([{ code: "schema_invalid", message: split.message, blockIds: [] }]);
    const p = StructuredAssistantOutput.safeParse(split.stripped);
    if (!p.success) return schemaInvalid(p.error.issues.slice(0, 8).map((i) => ({ code: "schema_invalid", message: `${i.path.join(".") || "(root)"}: ${i.message}`.slice(0, 200), blockIds: [] as string[] })));
    const out = p.data;
    const extras = split.extras;
    const geo = farmGeo(ctx);
    const issues: GateIssue[] = [];
    const report = emptyReport();
    const blockIssues = new Map<string, GateIssue[]>();
    const addBlockIssue = (blockId: string, code: string, message: string, correctable = true) => {
      const issue: GateIssue = { code, message, blockIds: [blockId], correctable };
      issues.push(issue);
      blockIssues.set(blockId, [...(blockIssues.get(blockId) ?? []), issue]);
    };
    const addIssue = (code: string, message: string) => issues.push({ code, message, blockIds: [], correctable: true });
    const farmer: FarmerToken[] = numberTokens(ctx.userText, { englishDates: true }).tokens.map((t) => ({ value: t.value, key: tokenKey(t) }));

    // Steps 2-3: ownership, mode, source availability and numeric reference resolution.
    const refById = new Map<string, (typeof out.numericRefs)[number]>();
    const dupRefs = new Set<string>();
    for (const r of out.numericRefs) {
      if (refById.has(r.id)) dupRefs.add(r.id);
      refById.set(r.id, r);
    }
    const refProblem = new Map<string, { code: string; message: string }>();
    const refPresented = new Map<string, Decimal>();
    const refTool = new Map<string, string>();
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
        refTool.set(r.id, tr.toolName);
      } catch {
        refProblem.set(r.id, { code: "unit_conversion_not_permitted", message: `numericRef ${r.id}: ${r.presentation.sourceUnit} to ${r.presentation.unit} is not a permitted conversion` });
      }
    }
    const presentedOf = (ids: string[]): Presented[] => ids.filter((id) => refPresented.has(id)).map((id) => ({ id, value: refPresented.get(id)!, unit: refById.get(id)!.presentation.unit }));

    // Step 4: claim evidence resolution, crop scope, granularity, and the claim text itself.
    const claimProblem = new Map<string, { code: string; message: string }[]>();
    const claimGranularity = new Map<string, { granularity: ClaimGranularity; declaredCoarser: boolean }>();
    const claimGrounded = new Map<string, string[]>();
    const defaultGranularity: ClaimGranularity = geo.present ? "district" : "national";
    const seenClaims = new Set<string>();
    for (const c of out.claimEvidenceRefs) {
      const probs: { code: string; message: string }[] = [];
      if (seenClaims.has(c.claimId)) probs.push({ code: "claim_duplicate_id", message: `claim id ${c.claimId} is reused` });
      seenClaims.add(c.claimId);
      const ex = extras.get(c.claimId) ?? {};
      // Crop scope: server-derived (plan) first; otherwise the claim must declare catalogue crops.
      let crops: string[] = [];
      if (ctx.claimScope.cropIds.length > 0) {
        crops = ctx.claimScope.cropIds;
        const outside = (ex.cropIds ?? []).filter((x) => !crops.includes(x));
        if (outside.length > 0) probs.push({ code: "claim_crop_outside_scope", message: `claim ${c.claimId} declares crops outside the plan's crop` });
      } else if (ex.cropIds && ex.cropIds.length > 0) {
        if (!ex.cropIds.every((x) => knownCrops.has(x))) probs.push({ code: "claim_crop_unknown", message: `claim ${c.claimId} declares a crop id that is not in the catalogue` });
        crops = ex.cropIds;
      } else probs.push({ code: "claim_crop_scope_missing", message: `claim ${c.claimId} must declare cropIds (no plan crop is in scope)` });
      const granularity = ex.granularity ?? defaultGranularity;
      claimGranularity.set(c.claimId, { granularity, declaredCoarser: ex.granularity !== undefined && GRANULARITY_RANK[ex.granularity] > GRANULARITY_RANK[defaultGranularity] });
      if (probs.length === 0) {
        const rows = c.evidenceIds.map((id) => ({ id, row: facts.evidence.get(id) }));
        if (rows.some((r) => !r.row)) probs.push({ code: "evidence_missing", message: `claim ${c.claimId} cites evidence that does not exist` });
        else {
          const results = rows.map((r) => ({ id: r.id, row: r.row!, problems: evidenceCoversScope(r.row!, ctx, { cropIds: crops, granularity }, geo) }));
          const ok = results.filter((r) => r.problems.length === 0);
          if (ok.length === 0) {
            const first = results[0]!.problems[0] ?? "evidence_scope";
            probs.push({ code: first, message: `claim ${c.claimId}: cited evidence does not cover the claim (${[...new Set(results.flatMap((r) => r.problems))].join(", ")})` });
          } else claimGrounded.set(c.claimId, ok.every((r) => r.row.validationStatus === "grounded") ? ok.map((r) => r.id) : []);
        }
      }
      // The claim text is model-written prose: it gets the full number and high-risk checks.
      const citing = out.answerBlocks.filter((b) => b.claimIds.includes(c.claimId));
      const t = checkText(c.text, ctx, { label: `claim ${c.claimId}`, presented: presentedOf(citing.flatMap((b) => b.numericRefIds)), requireDisplayed: false, farmer, supported: probs.length === 0 });
      probs.push(...t.issues);
      if (probs.length > 0) {
        claimProblem.set(c.claimId, probs);
        report.removed.push({ field: "claimEvidenceRef", id: c.claimId, index: out.claimEvidenceRefs.indexOf(c), codes: [...new Set(probs.map((x) => x.code))] });
        for (const pr of probs) addIssue(pr.code, pr.message);
      }
    }

    // Steps 5-6 per block.
    const withheld: WithheldBlock[] = [];
    for (const b of out.answerBlocks) {
      for (const id of b.numericRefIds) {
        const prob = refProblem.get(id);
        if (prob) addBlockIssue(b.id, prob.code, prob.message);
      }
      for (const id of b.claimIds) {
        if (claimProblem.has(id)) addBlockIssue(b.id, "claim_not_verified", `block ${b.id}: cited claim ${id} was withheld`);
        const g = claimGranularity.get(id);
        if (g?.declaredCoarser && !labelRe(g.granularity as "state" | "region" | "national").test(b.text.normalize("NFC"))) {
          addBlockIssue(b.id, "claim_granularity_unlabelled", `block ${b.id}: claim ${id} is ${g.granularity}-level evidence; the text must say so (e.g. "at ${g.granularity} level")`);
        }
      }
      if (b.kind === "evidence" && b.claimIds.length === 0) addBlockIssue(b.id, "evidence_block_without_claim", "an evidence block must cite a claim");

      const presented = presentedOf(b.numericRefIds);
      const claimsOk = b.claimIds.length > 0 && b.claimIds.every((id) => !claimProblem.has(id));
      const supported = presented.length > 0 || claimsOk;
      const t = checkText(b.text, ctx, {
        label: `block ${b.id}`,
        presented,
        requireDisplayed: true,
        farmer,
        supported,
        // Only evidence-backed, reference-backed mass-per-area input rates may pass; never ml/g-per-litre doses.
        dosageAllowed: (ms) => ms.length > 0 && claimsOk && ms.every((d) => d.rate !== null && presented.some((pv) => pv.value.equals(new Decimal(d.value)) && pv.unit === d.rate)),
      });
      for (const i of t.issues) addBlockIssue(b.id, i.code, i.message);
      if (blockIssues.has(b.id)) {
        const validRefIds = b.numericRefIds.filter((id) => refPresented.has(id) && !refProblem.has(id) && !["kg/ha", "kg/acre"].includes(refById.get(id)!.presentation.unit));
        withheld.push({ blockId: b.id, riskCodes: t.risks, validRefIds, forecastRefIds: validRefIds.filter((id) => /forecast|weather/i.test(refTool.get(id) ?? "")) });
        report.removed.push({ field: "answerBlock", id: b.id, index: out.answerBlocks.indexOf(b), codes: [...new Set(blockIssues.get(b.id)!.map((i) => i.code))] });
      }
    }

    // Limitations and clarifications are model-written prose too.
    const approvedLimitations: string[] = [];
    out.limitations.forEach((l, i) => {
      const t = checkText(l, ctx, { label: `limitation ${i}`, presented: [], requireDisplayed: false, farmer, supported: false });
      if (t.issues.length === 0) approvedLimitations.push(l);
      else {
        report.removed.push({ field: "limitation", id: null, index: i, codes: [...new Set(t.issues.map((x) => x.code))] });
        for (const x of t.issues) addIssue(x.code, x.message);
      }
    });
    const approvedClarifications: StructuredAssistantOutput["clarifications"] = [];
    out.clarifications.forEach((q, i) => {
      const codes: string[] = [];
      if (q.field === null || !PROFILE_FIELDS.includes(q.field)) codes.push("clarification_field_unknown");
      const t = checkText(q.question, ctx, { label: `clarification ${q.id}`, presented: [], requireDisplayed: false, farmer, supported: false });
      codes.push(...t.issues.map((x) => x.code));
      for (const x of t.issues) addIssue(x.code, x.message);
      if (codes.length > 0) {
        if (codes.includes("clarification_field_unknown")) addIssue("clarification_field_unknown", `clarification ${q.id}: field must be one of ${PROFILE_FIELDS.join(", ")}`);
        report.removed.push({ field: "clarification", id: q.id, index: i, codes: [...new Set(codes)] });
        return;
      }
      const options = q.options.filter((opt, j) => {
        const ot = checkText(opt, ctx, { label: `clarification ${q.id} option ${j}`, presented: [], requireDisplayed: false, farmer, supported: false });
        if (ot.issues.length === 0) return true;
        report.removed.push({ field: "clarificationOption", id: q.id, index: j, codes: [...new Set(ot.issues.map((x) => x.code))] });
        for (const x of ot.issues) addIssue(x.code, x.message);
        return false;
      });
      approvedClarifications.push({ ...q, options });
    });

    const blocked = new Set(blockIssues.keys());
    const approvedBlocks = out.answerBlocks.filter((b) => !blocked.has(b.id));
    const usedRefs = new Set(approvedBlocks.flatMap((b) => b.numericRefIds));
    const usedClaims = new Set(approvedBlocks.flatMap((b) => b.claimIds));
    report.groundedEvidenceIds = [...new Set([...usedClaims].flatMap((id) => claimGrounded.get(id) ?? []))];
    const result: GateResult = {
      status: issues.length === 0 ? "approved" : approvedBlocks.length > 0 ? "partial" : "correction_requested",
      approvedBlocks,
      approvedNumericRefs: out.numericRefs.filter((r) => usedRefs.has(r.id)),
      approvedClaimEvidenceRefs: out.claimEvidenceRefs.filter((c) => usedClaims.has(c.claimId) && !claimProblem.has(c.claimId)),
      approvedLimitations,
      approvedClarifications,
      issues,
      report,
      withheld,
      parsed: out,
      claimExtras: extras,
      presented: refPresented,
    };
    if (issues.length > 0) {
      result.correctionRequest = {
        instruction:
          "Some parts were withheld by the verification gate. Rewrite them: state every quantity exactly as its numericRef presents it with its unit next to the number (in Hindi or Tamil every number, including number words, needs a numericRef on that block); cite only existing evidence that covers the farm's district and the claim's crops (declare cropIds on each claim when no plan crop is given; declare granularity and say 'at state level' or similar when the evidence is coarser than the district); keep claim text, limitations and clarification questions free of unreferenced numbers and forbidden content (doses, certain diagnoses, guarantees or multiplied income, confidence percentages, exact rain beyond the horizon, yield from photos); clarifications must name a profile field. Return the complete JSON again.",
        issues: issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message.slice(0, 300), blockIds: i.blockIds })),
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
  const cropIds = new Set<string>();
  if (Array.isArray(o.numericRefs)) for (const r of o.numericRefs) if (typeof (r as { toolResultId?: unknown })?.toolResultId === "string") trIds.add((r as { toolResultId: string }).toolResultId);
  if (Array.isArray(o.claimEvidenceRefs))
    for (const c of o.claimEvidenceRefs) {
      if (Array.isArray((c as { evidenceIds?: unknown })?.evidenceIds)) for (const id of (c as { evidenceIds: unknown[] }).evidenceIds) if (typeof id === "string") evIds.add(id);
      if (Array.isArray((c as { cropIds?: unknown })?.cropIds)) for (const id of (c as { cropIds: unknown[] }).cropIds) if (typeof id === "string") cropIds.add(id);
    }
  const tr = [...trIds].filter((x) => UUID.test(x));
  const ev = [...evIds].filter((x) => UUID.test(x));
  const crops = [...cropIds].filter((x) => UUID.test(x));
  const facts: GateFacts = { toolResults: new Map(), evidence: new Map(), knownCropIds: new Set() };
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
  if (crops.length > 0) {
    const r = await pool.query<{ id: string }>("SELECT id FROM crop_identities WHERE id = ANY($1::uuid[])", [crops]);
    for (const row of r.rows) facts.knownCropIds!.add(row.id);
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

export type { ClaimScopeExtras };
