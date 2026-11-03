import { IsoDate } from "@harvest/contracts";
import { CERTAINTY, CHEMICAL_NOUNS, ROMAN_CHEMICAL_NOUNS, termRe } from "../agent/lexicon";
import { normaliseForChecks } from "../agent/numbers";
import { detectHighRisk } from "../agent/risk";
import { factToPlanChange } from "./mapping";
import { isIssueCategory, isPlanField, OBSERVED_ISSUE_FIELD, OBSERVED_ISSUE_NOTE_FIELD, OBSERVED_ISSUE_NOTE_MAX, type InterpretationOutput } from "./types";

// ---------------------------------------------------------------- observed_issue_note rules (FIELD_OPERATIONS_SPEC 5.5)
/**
 * A note is an observation of what is visible. These rules are stricter than the general prose detector, which only
 * drops a chemical when it comes with an application instruction or amount: here naming any chemical or product class
 * drops the note. The shared lexicon (agent/lexicon.ts CHEMICAL_NOUNS, including Hindi and Tamil terms) is extended with
 * any "-icide" word and a short list of active ingredients commonly sold in India. Conservative by design: a nutrient
 * word such as "nitrogen" or "potash" is in the shared lexicon and also drops the note.
 */
const NOTE_CHEMICAL_RES = [
  termRe(CHEMICAL_NOUNS),
  termRe(ROMAN_CHEMICAL_NOUNS),
  termRe({
    en: [
      "[a-z]*icides?",
      "glyphosate", "paraquat", "atrazine", "pendimethalin", "chlorantraniliprole", "emamectin(?:\\s+benzoate)?", "profenofos", "cypermethrin",
      "lambda[\\s-]?cyhalothrin", "thiamethoxam", "acephate", "monocrotophos", "dimethoate", "quinalphos", "fipronil", "spinosad",
      "hexaconazole", "propiconazole", "tebuconazole", "azoxystrobin", "difenoconazole", "streptocycline", "validamycin", "trichoderma",
      "sulph(?:ur|ate)", "sulf(?:ur|ate)", "ammonium", "superphosphate", "muriate",
    ],
  }),
];
/** Numbers followed by ml, g, kg, l, %, ppm (with spelled-out forms), or a "per litre/acre/ha" rate. Run on normalised text so number words count. */
const NOTE_DOSE_RES = [
  /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:ml|millilit(?:re|er)s?|g|gms?|grams?|grammes?|kg|kgs|kilo(?:gram)?s?|l|lit(?:re|er)s?|ppm)(?![\p{L}\p{M}\p{N}_])/iu,
  /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:%|percent(?![\p{L}])|per\s+cent(?![\p{L}]))/iu,
  /(?:(?<![\p{L}])per\s+|\/\s*)(?:lit(?:re|er)s?|l|acres?|ha|hectares?)(?![\p{L}\p{M}\p{N}_])/iu,
];
/** Certainty words. The spec's three plus the shared CERTAINTY lexicon, except "clearly", which is ordinary observation wording ("clearly visible holes"). */
const NOTE_CERTAINTY_RES = [/(?<![\p{L}])(?:certainly|definitely|confirmed)(?![\p{L}])/iu, termRe({ ...CERTAINTY, en: (CERTAINTY.en ?? []).filter((e) => e !== "clearly") })];

export type IssueNoteProblem = "observed_issue_note_chemical" | "observed_issue_note_dose" | "observed_issue_note_certainty";

/** Every rule an observed_issue_note breaks; empty when the note may be kept as a proposal. Pure. */
export function issueNoteProblems(note: string): IssueNoteProblem[] {
  const text = note.normalize("NFC");
  const numeric = normaliseForChecks(text, { englishDates: false });
  const out: IssueNoteProblem[] = [];
  if (NOTE_CHEMICAL_RES.some((re) => re.test(text))) out.push("observed_issue_note_chemical");
  if (NOTE_DOSE_RES.some((re) => re.test(numeric) || re.test(text))) out.push("observed_issue_note_dose");
  if (NOTE_CERTAINTY_RES.some((re) => re.test(text))) out.push("observed_issue_note_certainty");
  return out;
}

export interface GatedFact {
  field: string;
  value: string | number;
  unit: string | null;
  planMapped: boolean;
}

export interface GateIssue {
  code: string;
  detail: string;
}

export interface GatedInterpretation {
  facts: GatedFact[];
  candidateChanges: { type: string; stageId: string | null; category: string | null; date: string | null; note: string | null; rationale: string }[];
  visibleObservations: string[];
  competingInterpretations: { label: string; rationale: string }[];
  missingContext: string[];
  modelQualityIssues: string[];
  requestAnotherAngle: boolean;
  /** Prose from the model. Always an AI interpretation; null when the text tripped a high-risk detector. */
  narrative: string | null;
  issues: GateIssue[];
}

export interface GateContext {
  observedOn: string;
  entryId: string;
  /** Stage ids of the plan; null when the entry has no plan. */
  stageIds: ReadonlySet<string> | null;
  asOf: Date;
}

/**
 * Deterministic filter between the model and storage. The model cannot confirm anything: every fact leaves here as a
 * proposal. Prose that states a diagnosis as certain, doses, yield from a photo, guaranteed profit or a confidence
 * percentage is dropped. Proposals the plan cannot represent (unknown stage, bad value) are dropped, not repaired.
 * observed_issue is kept only with a known category; observed_issue_note only beside a kept observed_issue and only when
 * it names no chemical, no dose and no certainty word. Each drop leaves a gate issue code in the trace.
 */
export function gateInterpretation(out: InterpretationOutput, ctx: GateContext): GatedInterpretation {
  const issues: GateIssue[] = [];
  const risky = (text: string, where: string): boolean => {
    const hits = detectHighRisk(text, { asOf: ctx.asOf, rainHorizonDays: 7, allowConfidencePercent: false });
    for (const h of hits) issues.push({ code: `risk_${h.code}`, detail: where });
    return hits.length > 0;
  };

  const visibleObservations = out.visibleObservations.filter((o, i) => !risky(o, `visibleObservations[${i}]`));
  const competingInterpretations = out.competingInterpretations.filter((c, i) => !risky(`${c.label}. ${c.rationale}`, `competingInterpretations[${i}]`));
  const missingContext = out.missingContext.filter((m, i) => !risky(m, `missingContext[${i}]`));
  const narrative = out.aiNarrative.trim() && !risky(out.aiNarrative, "aiNarrative") ? out.aiNarrative.trim() : null;

  const withhold = out.requestAnotherAngle || out.imageQualityIssues.includes("no_crop_visible");
  const facts: GatedFact[] = [];
  const candidateChanges: GatedInterpretation["candidateChanges"] = [];
  if (withhold) {
    if (out.proposedFacts.length || out.candidatePlanChanges.length) issues.push({ code: "proposals_withheld", detail: "the model asked for another angle, so no proposal is kept" });
  } else {
    const seen = new Set<string>();
    const add = (f: GatedFact) => {
      const key = `${f.field}\u0000${String(f.value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      facts.push(f);
    };
    const mapCtx = { observedOn: ctx.observedOn, entryId: ctx.entryId, stageIds: ctx.stageIds };
    const planFact = (field: string, value: string | number, unit: string | null, where: string): GatedFact | null => {
      const m = factToPlanChange({ field, value }, mapCtx);
      if (!m.mapped) return null;
      if (!m.ok) {
        issues.push({ code: m.code, detail: `${where}: ${m.message}` });
        return null;
      }
      return { field, value, unit, planMapped: true };
    };
    // Issue category suggestion: at most one observed_issue and one note; the note is judged after the category is known.
    let issueKept = false;
    const notes: { value: string | number; where: string }[] = [];
    out.proposedFacts.forEach((f, i) => {
      const where = `proposedFacts[${i}]`;
      if (f.field === OBSERVED_ISSUE_FIELD) {
        if (!isIssueCategory(f.value)) {
          issues.push({ code: "observed_issue_unknown_category", detail: `${where}: '${String(f.value).slice(0, 40)}' is not an issue category` });
          return;
        }
        if (issueKept) {
          issues.push({ code: "observed_issue_duplicate", detail: `${where}: only one issue category is kept per observation` });
          return;
        }
        issueKept = true;
        // A category has no unit; the model's unit, if any, is not stored.
        add({ field: f.field, value: f.value, unit: null, planMapped: false });
        return;
      }
      if (f.field === OBSERVED_ISSUE_NOTE_FIELD) {
        notes.push({ value: f.value, where });
        return;
      }
      if (isPlanField(f.field)) {
        const g = planFact(f.field, f.value, null, where);
        if (g) add(g);
        return;
      }
      if (risky(`${f.field} ${String(f.value)} ${f.unit ?? ""}`, where)) return;
      add({ field: f.field, value: f.value, unit: f.unit, planMapped: false });
    });
    let noteKept = false;
    for (const n of notes) {
      if (!issueKept) {
        issues.push({ code: "observed_issue_note_without_issue", detail: `${n.where}: observed_issue was dropped or absent, so its note is dropped` });
        continue;
      }
      const text = typeof n.value === "string" ? n.value.trim() : "";
      if (!text || text.length > OBSERVED_ISSUE_NOTE_MAX) {
        issues.push({ code: "observed_issue_note_invalid", detail: `${n.where}: the note must be text of 1 to ${OBSERVED_ISSUE_NOTE_MAX} characters` });
        continue;
      }
      if (noteKept) {
        issues.push({ code: "observed_issue_note_duplicate", detail: `${n.where}: only one issue note is kept per observation` });
        continue;
      }
      const problems = issueNoteProblems(text);
      if (problems.length) {
        for (const code of problems) issues.push({ code, detail: n.where });
        continue;
      }
      if (risky(text, n.where)) continue;
      noteKept = true;
      add({ field: OBSERVED_ISSUE_NOTE_FIELD, value: text, unit: null, planMapped: false });
    }
    out.candidatePlanChanges.forEach((c, i) => {
      const where = `candidatePlanChanges[${i}]`;
      if (risky(c.rationale, where)) return;
      if (c.type === "note_only") {
        candidateChanges.push({ ...c });
        return;
      }
      const value = c.type === "observed_stage" ? c.stageId : c.type === "irrigation_category" ? c.category : c.date;
      if (value === null) {
        issues.push({ code: "invalid_value", detail: `${where}: ${c.type} needs a value` });
        return;
      }
      if (c.type === "planting_date" && !IsoDate.safeParse(value).success) {
        issues.push({ code: "invalid_value", detail: `${where}: not a valid date` });
        return;
      }
      const g = planFact(c.type, value, null, where);
      if (g) {
        add(g);
        candidateChanges.push({ ...c });
      }
    });
  }

  return { facts, candidateChanges, visibleObservations, competingInterpretations, missingContext, modelQualityIssues: [...out.imageQualityIssues], requestAnotherAngle: out.requestAnotherAngle, narrative, issues };
}
