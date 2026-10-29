import { IsoDate } from "@harvest/contracts";
import { detectHighRisk } from "../agent/risk";
import { factToPlanChange } from "./mapping";
import { isPlanField, type InterpretationOutput } from "./types";

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
    out.proposedFacts.forEach((f, i) => {
      const where = `proposedFacts[${i}]`;
      if (isPlanField(f.field)) {
        const g = planFact(f.field, f.value, null, where);
        if (g) add(g);
        return;
      }
      if (risky(`${f.field} ${String(f.value)} ${f.unit ?? ""}`, where)) return;
      add({ field: f.field, value: f.value, unit: f.unit, planMapped: false });
    });
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
