import { z } from "zod";
import { Mode, StructuredAssistantOutput, type Unit } from "@harvest/contracts";
import { Decimal, convertDecimal } from "@harvest/domain";
import type { Pool } from "../db/pool";
import { CERTAINTY, CHEMICAL_NOUNS, DISEASE, DOSAGE_VERBS, DRY_CROP_EN, DRY_NOT_PRODUCT_EN, DRY_SUBJECT_NOT_PRODUCT_EN, DRY_WORD_EN, GRANULARITY_LABEL, GUARANTEE, INDIC_SCRIPT, MONTH_NAMES_INDIC, PRODUCT_FORM_WORDS, ROMAN_CHEMICAL_NOUNS, ROMAN_DOSAGE_VERBS, SEASON_MARKER, UNIT_TERMS, termRe, termSource } from "./lexicon";
import { MONTH_RE, compatNormalise, contextWord, latinWordBeforeQuantity, numberTokens, proseNumbers, unitAdjacent, unitAt, unsupportedNumberChar, unsupportedNumberWord, type NumberToken } from "./numbers";
import { farmPlaces, isRegistryPlace, placeRegistry, placesNamedIn } from "./place-names";
import { detectFutureRain, detectHighRisk, detectSeasonalRain, dosageMentions, hasApplicationWords, isApplicationContext, nativeLexiconHits, type RiskCode } from "./risk";
import { PROFILE_FIELDS, splitClaimExtras, type ClaimGranularity, type ClaimScopeExtras } from "./schemas";
import { isForecastBriefingPointer, isYieldPointer, unitAtPointer } from "./tool-units";

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
 * F8: units come from the stored tool output, never from the model (tool-units.ts); a claim that names a
 * product form must be scoped to products of that form and cite evidence covering those products;
 * clarification options must be short profile values. When the turn language is hi/ta, Latin-script text
 * is fail-closed as well (romanised Hindi/Tamil).
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
        /** Server-derived product ids (catalogue slugs) of the plan; used only for product-form claims. */
        productIds: z.array(z.string()).default([]),
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
  /** Catalogue product ids the evidence covers; empty/absent = crop-level evidence only. */
  productIds?: string[];
  effectiveAvailableAt: string | null;
  availabilityBasis: string | null;
}

export interface GateFacts {
  toolResults: Map<string, StoredToolResult>;
  evidence: Map<string, EvidenceFact>;
  /** Catalogue crop ids that exist (for claim-declared crops). Missing = none verifiable. */
  knownCropIds?: Set<string>;
  /** Catalogue product id -> product basis (fresh, dry ...). Missing = form unverifiable (fail closed). */
  productForms?: Map<string, string>;
  /**
   * F13: catalogue crop id -> names and aliases (all languages). Used to detect evidence-cited text that names
   * a crop outside the claim's crops. Missing/empty = no crop-name check possible (recorded as a limitation).
   */
  cropNames?: Map<string, string[]>;
  /** L5: catalogue slug -> crop UUID for claim cropIds given as slugs (screen_crops reports slugs). */
  cropUuidBySlug?: Map<string, string>;
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
  /* "clarification" entries with code clarification_limit are added by the loop when it trims to one question. */
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
export function evidenceCoversScope(e: EvidenceFact, ctx: Ctx, scope: { cropIds: string[]; granularity: ClaimGranularity; productIds?: string[] }, geo: FarmGeo = farmGeo(ctx)): string[] {
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
  // F8: product-specific claims need evidence that names every claimed product; crop-level evidence
  // (no product ids) supports crop-level claims only.
  const claimed = scope.productIds ?? [];
  if (claimed.length > 0 && !claimed.every((p) => (e.productIds ?? []).includes(p))) problems.push("evidence_scope_product");
  return problems;
}

// ---------------------------------------------------------------- text checks
/** F14: tools whose stored output is a rain forecast or rain scenario (water balance runs carry forecast rain). */
const isForecastTool = (tool: string) => tool === "calculate_water_balance" || /forecast|weather/i.test(tool);
/** 2026-11-02: a farm-briefing ref is forecast-backed only by pointer (its weather forecast part), never by tool name. */
const isForecastRef = (tool: string, pointer: string) => (tool === "get_farm_briefing" ? isForecastBriefingPointer(pointer) : isForecastTool(tool));
interface Presented {
  id: string;
  value: Decimal;
  unit: Unit;
  /** F13: the ref points at a mapped yield/marketable-quantity field (a kg/ha there is a yield, not a dose). */
  yieldField?: boolean;
  /** F14: the ref comes from the water-balance (rain forecast/scenario) tool or a forecast/weather tool. */
  forecast?: boolean;
  /** 2026-11-02: the ref points into a get_farm_briefing result (its forecast backs only 7-day, non-seasonal sentences). */
  briefing?: boolean;
}

const SEASON_MARKER_RE = termRe(SEASON_MARKER);
/**
 * Review fix 2 (2026-11-02): a farm-briefing forecast ref (/weather/forecast/..., /weather/rainNext7Days) is a 7-day forecast,
 * so it backs a seasonal-rain hit only sentence by sentence: every sentence the seasonal detector flags (with the same code)
 * must display one of those briefing forecast numbers with its unit, carry no seasonal marker (monsoon, season, month, year,
 * Kharif, Rabi, and the Hindi/Tamil equivalents) and state no horizon beyond rainHorizonDays (the future-rain detector's
 * date, relative-day and weekday readings, applied to the sentence as a rain sentence). "This monsoon season will bring
 * 32 mm" with a rainNext7Days ref is therefore refused. Other tools' forecast refs keep the block-level F14 rule.
 */
function briefingForecastBacks(text: string, code: RiskCode, briefingRefs: Presented[], ctx: Ctx, native: boolean): boolean {
  const flagged = text.normalize("NFC").split(/(?<=[.!?।॥])\s+|\n+/u).map((x) => x.trim()).filter((x) => x && detectSeasonalRain(x)?.code === code);
  if (flagged.length === 0) return false;
  return flagged.every((sentence) => {
    if (SEASON_MARKER_RE.test(sentence)) return false;
    if (detectFutureRain(`rain ${sentence}`, new Date(ctx.asOf), ctx.rainHorizonDays) !== null) return false;
    const { tokens } = numberTokens(sentence, { englishDates: !native });
    return tokens.some((t) => briefingRefs.some((p) => t.value.equals(p.value) && unitAdjacent(t, p.unit)));
  });
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
  o: { label: string; presented: Presented[]; requireDisplayed: boolean; farmer: FarmerToken[]; supported: boolean; dosageAllowed?: (m: ReturnType<typeof dosageMentions>) => boolean; forecastBacked?: boolean },
): TextCheck {
  const issues: { code: string; message: string }[] = [];
  const native = isNativeText(ctx.language, text);
  if (UNSUPPORTED_SCRIPT.test(text)) issues.push({ code: "unsupported_script", message: `${o.label}: text in a script other than Latin, Devanagari or Tamil cannot be verified` });
  // F13: a numeric character that does not normalise to an ASCII digit cannot be verified (fail closed).
  const oddNumber = unsupportedNumberChar(text);
  if (oddNumber !== null) issues.push({ code: "unsupported_number", message: `${o.label}: a number written with an unsupported numeral character (U+${oddNumber.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}) cannot be verified; use ASCII digits with a numericRef` });
  // F14: unreadable Tamil compound numerals, ASCII Roman numerals and letter homoglyphs used as quantities.
  const oddWord = oddNumber === null ? unsupportedNumberWord(text) : null;
  if (oddWord !== null) issues.push({ code: "unsupported_number", message: `${o.label}: "${oddWord}" is written like a number that cannot be verified; use ASCII digits with a numericRef` });

  const { text: normText, tokens } = numberTokens(text, { englishDates: !native });
  const sentenceAt = (pos: number) => {
    const before = normText.slice(0, pos);
    const start = Math.max(before.search(/[.!?।\n][^.!?।\n]*$/u), 0);
    const endRel = normText.slice(pos).search(/[.!?।\n]/u);
    return normText.slice(start, endRel < 0 ? normText.length : pos + endRel);
  };
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
    // A farmer-stated number may be echoed, but never inside an input-application sentence (F8): there it reads as a dose.
    const farmerOk = !native && key !== null && o.farmer.some((f) => f.key === key && f.value.equals(t.value)) && !isApplicationContext(sentenceAt(t.start));
    if (farmerOk) continue;
    issues.push({
      code: "prose_number_without_ref",
      message: native
        ? `${o.label}: the number ${t.value.toString()} has no matching numericRef with its unit (Hindi/Tamil text: every number needs one)`
        : `${o.label}: the number ${t.value.toString()} appears without a matching numericRef and unit`,
    });
    break; // one item per text keeps the correction request bounded
  }
  // F14 (review R5 #4): in a hi/ta turn a Latin word right before a unit/multiplier is an unlisted romanised number.
  if (/^(hi|ta)(-|$)/i.test(ctx.language) && !issues.some((i) => i.code === "prose_number_without_ref")) {
    const w = latinWordBeforeQuantity(normText);
    if (w !== null) issues.push({ code: "prose_number_without_ref", message: `${o.label}: "${w}" stands where a number should be (before a unit); state the number with a numericRef` });
  }

  const risks: RiskCode[] = [];
  for (const h of detectHighRisk(text, { asOf: new Date(ctx.asOf), rainHorizonDays: ctx.rainHorizonDays, allowConfidencePercent: ctx.allowConfidencePercent })) {
    if (h.code === "chemical_dosage" && o.dosageAllowed?.(dosageMentions(text))) continue;
    // F14: a seasonal rain statement passes only with a forecast-tool reference or a verified evidence claim (F16: so does
    // a current-season present-perfect weather statement, `weather_claim_unsourced`).
    if (h.code === "future_rain_unsourced" || h.code === "weather_claim_unsourced") {
      if (o.forecastBacked === true || o.presented.some((p) => p.forecast && !p.briefing)) continue;
      const briefingRefs = o.presented.filter((p) => p.forecast && p.briefing);
      if (briefingRefs.length > 0 && briefingForecastBacks(text, h.code, briefingRefs, ctx, native)) continue;
    }
    risks.push(h.code);
    issues.push({ code: h.code, message: `${o.label}: ${h.message}` });
  }
  if (native && !o.supported) {
    // F8: in a hi/ta turn Latin-script text (romanised Hindi/Tamil or English) is fail-closed too.
    const hits = nativeLexiconHits(text, { latin: /^(hi|ta)(-|$)/i.test(ctx.language) });
    if (hits.length > 0) issues.push({ code: "native_risk_term_unsupported", message: `${o.label}: Hindi/Tamil high-risk wording (${hits.join(", ")}) without a validated numericRef or claim` });
  }
  return { issues, risks };
}

const labelRe = (g: "state" | "region" | "national") => termRe(GRANULARITY_LABEL[g]);

// ---------------------------------------------------------------- product forms
const FORM_RES = Object.entries(PRODUCT_FORM_WORDS).map(([basis, list]) => [basis, termRe(list)] as const);
/** Product bases named in a text ("dry ginger" -> dry). */
const DRY_CROP_RE = new RegExp(`\\b${DRY_CROP_EN}\\b`, "iu");
const DRY_WORD_RE = new RegExp(`\\b${DRY_WORD_EN}\\b`, "giu");
const DRY_NOT_AFTER = new RegExp(`^\\s+(?:(?:the|your|a|this|that)\\s+)?${DRY_NOT_PRODUCT_EN}\\b`, "iu");
const DRY_NOT_BEFORE = new RegExp(`\\b${DRY_SUBJECT_NOT_PRODUCT_EN}\\s+(?:(?:to|is|are|will|must|should|can|has|have|get|gets|stay|stays|remain|remains|become|becomes|turn|turns|be|been)\\s+){0,2}$`, "iu");
/**
 * F14: English heuristic. A sentence that names a crop and a drying word is about the dry product, unless every
 * drying word qualifies weather/soil/land ("dry spell", "drying the field", "the beds dry out").
 */
function englishDryProduct(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
    if (!DRY_CROP_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(DRY_WORD_RE)) {
      const after = sentence.slice(m.index! + m[0].length);
      const before = sentence.slice(0, m.index);
      if (!DRY_NOT_AFTER.test(after) && !DRY_NOT_BEFORE.test(before)) return true;
    }
  }
  return false;
}
export function productFormsIn(text: string): string[] {
  const t = text.normalize("NFC");
  const forms = FORM_RES.filter(([, re]) => re.test(t)).map(([b]) => b);
  if (!forms.includes("dry") && englishDryProduct(t)) forms.push("dry");
  return forms;
}

// ---------------------------------------------------------------- claim text scope (F13)
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const cropNameRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escRe(name.normalize("NFC"))}(?:s|es)?(?![\\p{L}\\p{M}\\p{N}_])`, "giu");
const toStateId = (s: string) => (/^IN-/i.test(s) ? s.toUpperCase() : `IN-${s.toUpperCase()}`);

/**
 * F13 (review R4 #3): evidence-cited text must not name a catalogue crop outside the claim's crops, or a
 * district/state other than the farm's own (the farm's state name is allowed). A crop name inside a longer
 * in-scope name ("pea" inside "pigeon pea") is not counted. When the farm district id does not resolve in the
 * registry, other districts of the farm's own state cannot be told apart and are not flagged (documented gap).
 */
export function textScopeProblems(texts: string[], claimCrops: string[], cropNames: Map<string, string[]> | undefined, geo: { districtIds: string[]; stateIds: string[] }): string[] {
  const out: string[] = [];
  const t = texts.map((x) => x.normalize("NFC")).join("\n");
  if (cropNames && cropNames.size > 0) {
    const spans: [number, number][] = [];
    for (const id of claimCrops) for (const n of cropNames.get(id) ?? []) for (const m of t.matchAll(cropNameRe(n))) spans.push([m.index!, m.index! + m[0].length]);
    for (const [id, names] of cropNames) {
      if (claimCrops.includes(id)) continue;
      for (const n of names)
        for (const m of t.matchAll(cropNameRe(n))) {
          const a = m.index!;
          const b = a + m[0].length;
          if (!spans.some(([x, y]) => x <= a && b <= y)) out.push(`crop "${m[0]}"`);
        }
    }
  }
  const farm = farmPlaces(geo.districtIds, geo.stateIds);
  const reg = placeRegistry();
  const districtResolved = reg.some((p) => p.level === "district" && farm.has(p.id));
  const states = new Set([...geo.stateIds.map(toStateId), ...[...farm].filter((id) => /^IN-[A-Z]{2}$/i.test(id)).map((x) => x.toUpperCase())]);
  for (const p of placesNamedIn(t)) {
    if (farm.has(p.id)) continue;
    const area = reg.find((r) => r.id === p.id)!;
    const ok = area.level === "state" ? states.has(area.id.toUpperCase()) : !districtResolved && states.has(area.stateId.toUpperCase());
    if (!ok) out.push(`place "${p.name}"`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- clarification options
const OPTION_UNSAFE_RE = new RegExp(
  [DOSAGE_VERBS, CHEMICAL_NOUNS, DISEASE, GUARANTEE, CERTAINTY, ROMAN_DOSAGE_VERBS, ROMAN_CHEMICAL_NOUNS].map(termSource).join("|"),
  "iu",
);
/** F13 (review R4 #5): a yes/no/not-sure option must be exactly one of these (whole option, optional end punctuation). */
const YES_NO = new RegExp(
  `^(?:${["yes", "no", "not\\s+sure", "(?:i\\s+)?don'?t\\s+know", "unknown", "maybe", "none", "haan", "haa", "han", "ji\\s+haan", "nahi", "nahin", "pata\\s+nahi", "aamaa?", "aam", "illai", "illa", "theriyadhu", "theriyathu", "हाँ", "हां", "जी हाँ", "जी हां", "जी", "नहीं", "जी नहीं", "पता नहीं", "मालूम नहीं", "शायद", "ஆம்", "ஆமாம்", "இல்லை", "தெரியாது", "தெரியவில்லை"].map((x) => x.normalize("NFC")).join("|")})\\s*[.!?।]?$`,
  "iu",
);
const FIELD_VOCAB: Record<string, string[]> = {
  irrigation: ["rain[\\s-]?fed", "irrigated", "(?:partly|partially)\\s+irrigated", "drip", "sprinkler", "flood", "furrow", "bore\\s?well", "open\\s+well", "well", "canal", "tank", "river", "pond", "rain\\s+only", "no\\s+irrigation", "limited", "adequate", "plenty", "assured", "protective"],
  water_availability: ["low", "medium", "moderate", "high", "scarce", "limited", "adequate", "enough", "plenty", "assured", "seasonal", "year[\\s-]round", "rain\\s+only"],
  soil: ["sandy", "loamy", "loam", "clay", "clayey", "sandy\\s+loam", "clay\\s+loam", "silty", "red", "black", "laterite", "lateritic", "alluvial", "well[\\s-]drained", "poorly\\s+drained", "moderately\\s+drained", "waterlogged", "acidic", "alkaline", "saline", "(?:red|black|sandy|clay|loamy|alluvial|laterite)\\s+soil"],
  labour: ["low", "medium", "high", "family(?:\\s+labou?r)?", "hired(?:\\s+labou?r)?", "limited", "enough", "plenty", "only\\s+family", "me\\s+only", "just\\s+me"],
  experience: ["first\\s+time", "beginner", "new", "some", "experienced", "very\\s+experienced", "never\\s+grown", "grown\\s+before"],
  planting_window: ["this\\s+season", "next\\s+season", "kharif", "rabi", "zaid", "summer", "monsoon", "winter", "now", "not\\s+decided", "soon"],
};
const MONTH_OPT = new RegExp(`^(?:early|mid|late|end\\s+of|start\\s+of)?\\s*${MONTH_RE}(?:\\s*(?:-|–|to)\\s*${MONTH_RE})?(?:\\s+\\d{4})?$`, "iu");
const MONTH_INDIC = termRe({ indic: MONTH_NAMES_INDIC });
const QTY_UNIT = [UNIT_TERMS.acre!, UNIT_TERMS.ha!, UNIT_TERMS.months!, UNIT_TERMS.weeks!, UNIT_TERMS.days!, { en: ["years?", "yrs?", "lakhs?", "thousands?", "rupees?", "rs\\.?", "inr", "cents?", "guntas?", "bighas?"], indic: ["साल", "वर्ष", "லட்ச", "ஆயிர", "ஆண்டு", "வருட"] }].map(termSource).join("|");
const NUMBER_OPT = new RegExp(`^(?:about|around|approx\\.?|under|over|less\\s+than|more\\s+than|up\\s*to|below|above|<|>)?\\s*(?:₹|rs\\.?|inr)?\\s*\\d[\\d,.]*(?:\\s*(?:-|–|to)\\s*(?:₹|rs\\.?)?\\s*\\d[\\d,.]*)?\\s*(?:(?:${QTY_UNIT})\\s*){0,2}(?:or\\s+(?:more|less))?$`, "iu");

/**
 * F8 (review R3a #5): a clarification option is a short profile value, never an instruction. Returns an
 * issue code, or null when the option is acceptable for the field.
 */
export function clarificationOptionProblem(field: string, option: string): string | null {
  const t = compatNormalise(option).trim();
  const words = t.split(/\s+/u).filter(Boolean);
  if (t.length === 0 || t.length > 40 || words.length > 6) return "clarification_option_not_value";
  if (OPTION_UNSAFE_RE.test(t)) return "clarification_option_unsafe";
  if (YES_NO.test(t)) return null;
  if (NUMBER_OPT.test(t) && ["area", "budget", "experience", "water_availability", "labour"].includes(field)) return null;
  if ((MONTH_OPT.test(t) || (MONTH_INDIC.test(t) && words.length <= 4)) && field === "planting_window") return null;
  const vocab = FIELD_VOCAB[field];
  if (vocab && new RegExp(`^(?:${vocab.join("|")})(?:\\s+(?:soil|irrigation|labou?r|water))?$`, "iu").test(t)) return null;
  // F13: district/state options must be registry names (data/curated/districts.json), case-insensitive.
  if ((field === "district" || field === "state") && isRegistryPlace(t, field)) return null;
  return "clarification_option_not_value";
}

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
      // F8: the source unit is derived from the stored tool output; the model's declaration must agree.
      const derived = unitAtPointer(tr.toolName, tr.result, r.jsonPointer);
      if (!derived) {
        refProblem.set(r.id, { code: "numeric_ref_unit_unknown", message: `numericRef ${r.id}: the tool output carries no unit for this value; point at a value with a unit (e.g. .../value of a quantity record)` });
        continue;
      }
      if (derived.unit !== r.presentation.sourceUnit) {
        refProblem.set(r.id, { code: "numeric_ref_unit_mismatch", message: `numericRef ${r.id}: the stored value is in ${derived.unit}, not ${r.presentation.sourceUnit}` });
        continue;
      }
      try {
        const shown = presentedValue(dec, derived.unit, r.presentation.unit, r.presentation.rounding);
        // Review fix 1 (2026-11-02): a farm-briefing soil reading or satellite index that is not zero may not be shown as 0
        // ("Zinc is 0 ppm" for 0.004 ppm); the presentation rounding must keep a significant digit.
        if (tr.toolName === "get_farm_briefing" && /^\/(soil|satellite)\//.test(r.jsonPointer) && !dec.isZero() && shown.isZero()) {
          refProblem.set(r.id, { code: "numeric_ref_rounds_to_zero", message: `numericRef ${r.id}: the stored value ${dec.toString()} is not zero; round it so a significant digit stays (for example significant digits)` });
          continue;
        }
        refPresented.set(r.id, shown);
        refTool.set(r.id, tr.toolName);
      } catch {
        refProblem.set(r.id, { code: "unit_conversion_not_permitted", message: `numericRef ${r.id}: ${r.presentation.sourceUnit} to ${r.presentation.unit} is not a permitted conversion` });
      }
    }
    const presentedOf = (ids: string[]): Presented[] =>
      ids.filter((id) => refPresented.has(id)).map((id) => {
        const ref = refById.get(id)!;
        const tr = facts.toolResults.get(ref.toolResultId);
        const monitorRecord = tr?.toolName === 'get_farm_context' && /^\/farm\/monitoring\/references\/\d+\/value$/.test(ref.jsonPointer)
          ? resolvePointer(tr.result, ref.jsonPointer.replace(/\/value$/, '')) : null;
        const monitorForecast = monitorRecord?.found && (monitorRecord.value as { evidenceState?: string } | null)?.evidenceState === 'forecast';
        const tool = refTool.get(id) ?? "";
        return { id, value: refPresented.get(id)!, unit: ref.presentation.unit, yieldField: isYieldPointer(tool, ref.jsonPointer), forecast: isForecastRef(tool, ref.jsonPointer) || !!monitorForecast, briefing: tool === "get_farm_briefing" };
      });

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
        // L5: a catalogue slug ("ginger", as screen_crops reports it) is the same crop as its UUID.
        const declared = ex.cropIds.map((x) => facts.cropUuidBySlug?.get(x) ?? x);
        if (!declared.every((x) => knownCrops.has(x))) probs.push({ code: "claim_crop_unknown", message: `claim ${c.claimId} declares a crop id that is not in the catalogue` });
        crops = declared;
      } else probs.push({ code: "claim_crop_scope_missing", message: `claim ${c.claimId} must declare cropIds (no plan crop is in scope)` });
      // F8 product scope: a claim that names a product form, or declares productIds, is product-specific.
      const citingTexts = [c.text, ...out.answerBlocks.filter((b) => b.claimIds.includes(c.claimId)).map((b) => b.text)];
      const forms = [...new Set(citingTexts.flatMap(productFormsIn))];
      let products: string[] = [];
      const productSpecific = forms.length > 0 || (ex.productIds?.length ?? 0) > 0;
      if (productSpecific) {
        const planProducts = ctx.claimScope.productIds;
        if (ex.productIds && ex.productIds.length > 0) {
          products = ex.productIds;
          if (planProducts.length > 0 && products.some((x) => !planProducts.includes(x))) probs.push({ code: "claim_product_outside_scope", message: `claim ${c.claimId} declares products outside the plan's product` });
        } else products = planProducts;
        if (products.length === 0) probs.push({ code: "claim_product_scope_missing", message: `claim ${c.claimId} names a product form (${forms.join(", ")}); declare productIds and cite product-specific evidence` });
        else {
          const known = facts.productForms;
          const productBases = products.map((x) => known?.get(x));
          if (productBases.some((x) => x === undefined)) probs.push({ code: "claim_product_unknown", message: `claim ${c.claimId} declares a product id that is not in the catalogue` });
          else if (forms.some((f) => !productBases.includes(f))) probs.push({ code: "claim_product_form_mismatch", message: `claim ${c.claimId}: the text names ${forms.join(", ")} but the claim's products are ${[...new Set(productBases)].join(", ")}` });
        }
      }
      // F13: the cited text may only name the claim's crops and the farm's own district/state.
      const outOfScope = textScopeProblems(citingTexts, crops, facts.cropNames, geo);
      if (outOfScope.length > 0) probs.push({ code: "claim_text_scope_mismatch", message: `claim ${c.claimId}: the text names ${outOfScope.join(", ")}, which the claim's crops and the farm's geography do not cover` });
      const granularity = ex.granularity ?? defaultGranularity;
      claimGranularity.set(c.claimId, { granularity, declaredCoarser: ex.granularity !== undefined && GRANULARITY_RANK[ex.granularity] > GRANULARITY_RANK[defaultGranularity] });
      if (probs.length === 0) {
        const rows = c.evidenceIds.map((id) => ({ id, row: facts.evidence.get(id) }));
        if (rows.some((r) => !r.row)) probs.push({ code: "evidence_missing", message: `claim ${c.claimId} cites evidence that does not exist` });
        else {
          const results = rows.map((r) => ({ id: r.id, row: r.row!, problems: evidenceCoversScope(r.row!, ctx, { cropIds: crops, granularity, productIds: productSpecific ? products : [] }, geo) }));
          const ok = results.filter((r) => r.problems.length === 0);
          if (ok.length === 0) {
            const first = results[0]!.problems[0] ?? "evidence_scope";
            probs.push({ code: first, message: `claim ${c.claimId}: cited evidence does not cover the claim (${[...new Set(results.flatMap((r) => r.problems))].join(", ")})` });
          } else claimGrounded.set(c.claimId, ok.every((r) => r.row.validationStatus === "grounded") ? ok.map((r) => r.id) : []);
        }
      }
      // The claim text is model-written prose: it gets the full number and high-risk checks.
      const citing = out.answerBlocks.filter((b) => b.claimIds.includes(c.claimId));
      const t = checkText(c.text, ctx, { label: `claim ${c.claimId}`, presented: presentedOf(citing.flatMap((b) => b.numericRefIds)), requireDisplayed: false, farmer, supported: probs.length === 0, forecastBacked: probs.length === 0 });
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
        forecastBacked: claimsOk,
        requireDisplayed: true,
        farmer,
        supported,
        // Only evidence-backed, reference-backed mass-per-area input rates may pass; never ml/g-per-litre doses.
        dosageAllowed: (ms) =>
          ms.length > 0 &&
          ((claimsOk && ms.every((d) => d.rate !== null && presented.some((pv) => pv.value.equals(new Decimal(d.value)) && pv.unit === d.rate))) ||
            // F13 (review R4 #6): a kg/ha or kg/acre figure from a mapped yield field is a yield, not a dose,
            // provided the text has no application verb or input noun ("apply 8000 kg/ha urea" stays blocked).
            (ms.every((d) => d.rate !== null && presented.some((pv) => pv.yieldField && pv.value.equals(new Decimal(d.value)) && pv.unit === d.rate)) && !hasApplicationWords(b.text))),
      });
      for (const i of t.issues) addBlockIssue(b.id, i.code, i.message);
      if (blockIssues.has(b.id)) {
        const validRefIds = b.numericRefIds.filter((id) => refPresented.has(id) && !refProblem.has(id) && !["kg/ha", "kg/acre"].includes(refById.get(id)!.presentation.unit));
        withheld.push({ blockId: b.id, riskCodes: t.risks, validRefIds, forecastRefIds: validRefIds.filter((id) => { const tn = refTool.get(id) ?? ""; return tn === "get_farm_briefing" ? isForecastBriefingPointer(refById.get(id)!.jsonPointer) : /forecast|weather/i.test(tn); }) });
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
        const shape = clarificationOptionProblem(q.field!, opt);
        const all = [...ot.issues, ...(shape ? [{ code: shape, message: `clarification ${q.id} option ${j}: options must be short profile values for ${q.field} (no instructions, inputs or diagnoses)` }] : [])];
        if (all.length === 0) return true;
        report.removed.push({ field: "clarificationOption", id: q.id, index: j, codes: [...new Set(all.map((x) => x.code))] });
        for (const x of all) addIssue(x.code, x.message);
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
export async function loadGateFacts(pool: Pool, raw: unknown, scopeProductIds: string[] = []): Promise<GateFacts> {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const trIds = new Set<string>();
  const evIds = new Set<string>();
  const cropIds = new Set<string>();
  const productIds = new Set<string>(scopeProductIds);
  if (Array.isArray(o.numericRefs)) for (const r of o.numericRefs) if (typeof (r as { toolResultId?: unknown })?.toolResultId === "string") trIds.add((r as { toolResultId: string }).toolResultId);
  if (Array.isArray(o.claimEvidenceRefs))
    for (const c of o.claimEvidenceRefs) {
      if (Array.isArray((c as { evidenceIds?: unknown })?.evidenceIds)) for (const id of (c as { evidenceIds: unknown[] }).evidenceIds) if (typeof id === "string") evIds.add(id);
      if (Array.isArray((c as { cropIds?: unknown })?.cropIds)) for (const id of (c as { cropIds: unknown[] }).cropIds) if (typeof id === "string") cropIds.add(id);
      if (Array.isArray((c as { productIds?: unknown })?.productIds)) for (const id of (c as { productIds: unknown[] }).productIds) if (typeof id === "string" && id.length <= 200) productIds.add(id);
    }
  const tr = [...trIds].filter((x) => UUID.test(x));
  const ev = [...evIds].filter((x) => UUID.test(x));
  const crops = [...cropIds].filter((x) => UUID.test(x));
  const facts: GateFacts = { toolResults: new Map(), evidence: new Map(), knownCropIds: new Set(), productForms: new Map(), cropNames: new Map() };
  if (evIds.size > 0 || Array.isArray(o.claimEvidenceRefs)) {
    // F13: every catalogue crop's names/aliases (small table) for the claim text-scope check.
    const r = await pool.query<{ id: string; slug: string; names: unknown }>("SELECT id, slug, names FROM crop_identities");
    for (const row of r.rows) facts.cropNames!.set(row.id, cropNameList(row.slug, row.names));
  }
  if (tr.length > 0) {
    const r = await pool.query<{ id: string; owner_id: string; agent_run_id: string; mode: string; tool_name: string; status: string; result: unknown }>(
      `SELECT t.id, t.owner_id, t.agent_run_id, a.mode, t.tool_name, t.status, t.result
         FROM tool_results t JOIN agent_runs a ON a.id = t.agent_run_id WHERE t.id = ANY($1::uuid[])`,
      [tr],
    );
    for (const row of r.rows) facts.toolResults.set(row.id, { id: row.id, ownerId: row.owner_id, agentRunId: row.agent_run_id, runMode: row.mode, toolName: row.tool_name, status: row.status, result: row.result });
  }
  if (ev.length > 0) {
    const r = await pool.query<{ id: string; mode: string; validation_status: string; geography_level: string | null; geography_ids: string[]; crop_ids: string[]; product_ids: string[] | null; effective_available_at: Date | null; availability_basis: string | null }>(
      `SELECT id, mode, validation_status, geography_level, geography_ids, crop_ids, product_ids, effective_available_at, availability_basis FROM evidence_records WHERE id = ANY($1::uuid[])`,
      [ev],
    );
    // L5: curated evidence rows store catalogue slugs ("ginger") while claims declare crop UUIDs; both forms count.
    const idsBySlug = new Map<string, string>();
    const slugs = [...new Set(r.rows.flatMap((x) => x.crop_ids))];
    if (slugs.length > 0) for (const c of (await pool.query<{ id: string; slug: string }>("SELECT id::text AS id, slug FROM crop_identities WHERE slug = ANY($1::text[])", [slugs])).rows) idsBySlug.set(c.slug, c.id);
    for (const row of r.rows) {
      row.crop_ids = [...new Set([...row.crop_ids, ...row.crop_ids.flatMap((c) => (idsBySlug.has(c) ? [idsBySlug.get(c)!] : []))])];
      facts.evidence.set(row.id, {
        id: row.id,
        mode: row.mode,
        validationStatus: row.validation_status,
        geographyLevel: row.geography_level,
        geographyIds: row.geography_ids,
        cropIds: row.crop_ids,
        productIds: row.product_ids ?? [],
        effectiveAvailableAt: row.effective_available_at ? row.effective_available_at.toISOString() : null,
        availabilityBasis: row.availability_basis,
      });
    }
  }
  if (crops.length > 0) {
    const r = await pool.query<{ id: string }>("SELECT id FROM crop_identities WHERE id = ANY($1::uuid[])", [crops]);
    for (const row of r.rows) facts.knownCropIds!.add(row.id);
  }
  const slugIds = [...cropIds].filter((x) => !UUID.test(x));
  if (slugIds.length > 0) {
    facts.cropUuidBySlug = new Map();
    const r = await pool.query<{ id: string; slug: string }>("SELECT id::text AS id, slug FROM crop_identities WHERE slug = ANY($1::text[])", [slugIds]);
    for (const row of r.rows) {
      facts.cropUuidBySlug.set(row.slug, row.id);
      facts.knownCropIds!.add(row.id);
    }
  }
  if (productIds.size > 0) {
    const r = await pool.query<{ slug: string; form: string }>("SELECT slug, form FROM crop_products WHERE slug = ANY($1::text[])", [[...productIds]]);
    for (const row of r.rows) facts.productForms!.set(row.slug, row.form);
  }
  return facts;
}

/** Crop names from crop_identities.names ({en: "x"} or {en: [{text}], hi: [...]}) plus the slug. */
export function cropNameList(slug: string, names: unknown): string[] {
  const out = new Set<string>();
  const add = (x: string) => {
    for (const part of x.replace(/\([^)]*\)/g, " ").split("/")) {
      const p = part.trim().replace(/\s+/g, " ");
      if (p.length >= 3) out.add(p.normalize("NFC"));
    }
  };
  if (!slug.startsWith("synthetic")) add(slug.replace(/-/g, " "));
  if (typeof names === "object" && names !== null)
    for (const v of Object.values(names as Record<string, unknown>)) {
      if (typeof v === "string") add(v);
      else if (Array.isArray(v)) for (const item of v) typeof item === "string" ? add(item) : typeof (item as { text?: unknown })?.text === "string" && add((item as { text: string }).text);
    }
  return [...out];
}

export async function runOutputGate(pool: Pool, raw: unknown, ctx: GateContext): Promise<GateResult> {
  try {
    const facts = await loadGateFacts(pool, raw, ctx.claimScope?.productIds ?? []);
    return evaluateGate(raw, ctx, facts);
  } catch {
    return unverified("gate_lookup_failed");
  }
}

export type { ClaimScopeExtras };
