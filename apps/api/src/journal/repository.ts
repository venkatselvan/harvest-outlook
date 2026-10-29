import type { PoolClient } from "pg";
import type { Pool } from "../db/pool";
import { AI_PROPOSAL_LABEL } from "./types";

type Db = Pool | PoolClient;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

export interface EntryRow {
  id: string;
  owner_id: string;
  farm_id: string;
  plan_id: string | null;
  client_entry_id: string | null;
  status: "draft" | "final";
  entry_date: string;
  observed_at: Date | null;
  uploaded_at: Date | null;
  text_body: string | null;
  language: string | null;
  media_ids: string[];
  activity: string | null;
  quantity: string | null;
  quantity_unit: string | null;
  expense_inr: string | null;
  expense_category: string | null;
  transcript: unknown;
  mode: "live" | "replay" | "synthetic";
  payload_hash: string | null;
  processing_status: "draft" | "submitted" | "processing" | "ready" | "failed";
  image_quality: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const ENTRY_COLS = `id, owner_id, farm_id, plan_id, client_entry_id, status, to_char(entry_date,'YYYY-MM-DD') AS entry_date, observed_at, uploaded_at,
  text_body, language, media_ids, activity, quantity::text AS quantity, quantity_unit, expense_inr::text AS expense_inr, expense_category, transcript, mode,
  payload_hash, processing_status, image_quality, version, created_at, updated_at`;

export async function findEntry(db: Db, ownerId: string, id: string, forUpdate = false): Promise<EntryRow | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<EntryRow>(`SELECT ${ENTRY_COLS} FROM journal_entries WHERE id=$1 AND owner_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [id, ownerId]);
  return r.rows[0] ?? null;
}

export async function findEntryByClientId(db: Db, ownerId: string, clientEntryId: string): Promise<EntryRow | null> {
  const r = await db.query<EntryRow>(`SELECT ${ENTRY_COLS} FROM journal_entries WHERE owner_id=$1 AND client_entry_id=$2`, [ownerId, clientEntryId]);
  return r.rows[0] ?? null;
}

export async function listEntries(db: Db, ownerId: string, farmId: string, limit = 100): Promise<EntryRow[]> {
  const r = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM journal_entries WHERE owner_id=$1 AND farm_id=$2 ORDER BY entry_date DESC, created_at DESC, id LIMIT $3`,
    [ownerId, farmId, limit],
  );
  return r.rows;
}

export interface FactRow {
  id: string;
  entry_id: string;
  fact_key: string;
  value: unknown;
  unit: string | null;
  kind: "original" | "proposed" | "confirmed";
  source: "farmer" | "ai";
  status: "proposed" | "confirmed" | "rejected" | "recorded";
  requires_confirmation: boolean;
  evidence_state: "farmer_reported" | "derived" | "illustrative";
  confirmed_at: Date | null;
  rejected_at: Date | null;
  supersedes_id: string | null;
  analysis_id: string | null;
  agent_run_id: string | null;
  created_at: Date;
}
const FACT_COLS = "id, entry_id, fact_key, value, unit, kind, source, status, requires_confirmation, evidence_state, confirmed_at, rejected_at, supersedes_id, analysis_id, agent_run_id, created_at";

export async function factsForEntries(db: Db, ownerId: string, entryIds: string[]): Promise<FactRow[]> {
  if (entryIds.length === 0) return [];
  const r = await db.query<FactRow>(`SELECT ${FACT_COLS} FROM journal_facts WHERE owner_id=$1 AND entry_id = ANY($2::uuid[]) ORDER BY created_at, id`, [ownerId, entryIds]);
  return r.rows;
}

export async function factsByIds(db: Db, ownerId: string, entryId: string, ids: string[], forUpdate = false): Promise<FactRow[]> {
  const r = await db.query<FactRow>(
    `SELECT ${FACT_COLS} FROM journal_facts WHERE owner_id=$1 AND entry_id=$2 AND id = ANY($3::uuid[]) ORDER BY created_at, id${forUpdate ? " FOR UPDATE" : ""}`,
    [ownerId, entryId, ids],
  );
  return r.rows;
}

export interface NewFact {
  ownerId: string;
  entryId: string;
  field: string;
  value: string | number;
  unit: string | null;
  kind: "original" | "proposed" | "confirmed";
  source: "farmer" | "ai";
  evidenceState: "farmer_reported" | "derived" | "illustrative";
  requiresConfirmation: boolean;
  analysisId?: string | null;
  agentRunId?: string | null;
  supersedesId?: string | null;
  confirmedAt?: Date | null;
}

export async function insertFact(db: Db, f: NewFact): Promise<string> {
  const status = f.kind === "original" ? "recorded" : f.kind === "confirmed" ? "confirmed" : "proposed";
  const r = await db.query<{ id: string }>(
    `INSERT INTO journal_facts (owner_id, entry_id, fact_key, value, unit, kind, source, status, requires_confirmation, evidence_state, analysis_id, agent_run_id, supersedes_id, confirmed_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [f.ownerId, f.entryId, f.field, JSON.stringify(f.value), f.unit, f.kind, f.source, status, f.requiresConfirmation, f.evidenceState, f.analysisId ?? null, f.agentRunId ?? null, f.supersedesId ?? null, f.confirmedAt ?? null],
  );
  return r.rows[0]!.id;
}

export interface AnalysisRow {
  id: string;
  entry_id: string;
  job_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "unavailable";
  error_code: string | null;
  provenance: "meta_live" | "synthetic_fixture" | null;
  model: string | null;
  prompt_version: string | null;
  agent_run_id: string | null;
  result: unknown;
  ai_narrative: string | null;
  narrative_evidence_state: "derived" | "illustrative" | null;
  gate_issues: unknown;
  quality: unknown;
  created_at: Date;
  updated_at: Date;
}
const ANALYSIS_COLS = "id, entry_id, job_id, status, error_code, provenance, model, prompt_version, agent_run_id, result, ai_narrative, narrative_evidence_state, gate_issues, quality, created_at, updated_at";

export async function latestAnalyses(db: Db, ownerId: string, entryIds: string[]): Promise<Map<string, AnalysisRow>> {
  const out = new Map<string, AnalysisRow>();
  if (entryIds.length === 0) return out;
  const r = await db.query<AnalysisRow>(
    `SELECT DISTINCT ON (entry_id) ${ANALYSIS_COLS} FROM journal_analyses WHERE owner_id=$1 AND entry_id = ANY($2::uuid[]) ORDER BY entry_id, created_at DESC, id`,
    [ownerId, entryIds],
  );
  for (const a of r.rows) out.set(a.entry_id, a);
  return out;
}

export async function findAnalysis(db: Db, ownerId: string, id: string, forUpdate = false): Promise<AnalysisRow | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<AnalysisRow>(`SELECT ${ANALYSIS_COLS} FROM journal_analyses WHERE id=$1 AND owner_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [id, ownerId]);
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------- output shapes
export interface FactOut {
  id: string;
  entryId: string;
  field: string;
  kind: FactRow["kind"];
  source: FactRow["source"];
  status: FactRow["status"];
  value: unknown;
  unit: string | null;
  requiresConfirmation: boolean;
  evidenceState: FactRow["evidence_state"];
  confirmedAt: string | null;
  rejectedAt: string | null;
  supersedesId: string | null;
  analysisId: string | null;
  planMapped: boolean;
  label: string | null;
}

export const factOut = (f: FactRow, planFields: ReadonlySet<string>): FactOut => ({
  id: f.id,
  entryId: f.entry_id,
  field: f.fact_key,
  kind: f.kind,
  source: f.source,
  status: f.status,
  value: f.value,
  unit: f.unit,
  requiresConfirmation: f.requires_confirmation,
  evidenceState: f.evidence_state,
  confirmedAt: f.confirmed_at?.toISOString() ?? null,
  rejectedAt: f.rejected_at?.toISOString() ?? null,
  supersedesId: f.supersedes_id,
  analysisId: f.analysis_id,
  planMapped: planFields.has(f.fact_key),
  label: f.source === "ai" && f.kind === "proposed" ? AI_PROPOSAL_LABEL : f.source === "farmer" && f.kind === "proposed" ? "Your selection — confirm before it changes your plan" : null,
});

export interface AnalysisOut {
  id: string;
  jobId: string | null;
  status: AnalysisRow["status"];
  errorCode: string | null;
  provenance: AnalysisRow["provenance"];
  model: string | null;
  label: string;
  aiNarrative: { text: string; evidenceState: "derived" | "illustrative"; label: string } | null;
  visibleObservations: string[];
  competingInterpretations: { label: string; rationale: string }[];
  missingContext: string[];
  imageQualityIssues: string[];
  requestAnotherAngle: boolean;
  gateIssues: { code: string; detail: string }[];
  createdAt: string;
}

export function analysisOut(a: AnalysisRow): AnalysisOut {
  const res = (a.result ?? {}) as Partial<Pick<AnalysisOut, "visibleObservations" | "competingInterpretations" | "missingContext" | "requestAnotherAngle">> & { imageQualityIssues?: string[] };
  return {
    id: a.id,
    jobId: a.job_id,
    status: a.status,
    errorCode: a.error_code,
    provenance: a.provenance,
    model: a.model,
    label: AI_PROPOSAL_LABEL,
    aiNarrative: a.ai_narrative ? { text: a.ai_narrative, evidenceState: a.narrative_evidence_state ?? "illustrative", label: "AI interpretation of your photo, not an observation" } : null,
    visibleObservations: res.visibleObservations ?? [],
    competingInterpretations: res.competingInterpretations ?? [],
    missingContext: res.missingContext ?? [],
    imageQualityIssues: res.imageQualityIssues ?? [],
    requestAnotherAngle: res.requestAnotherAngle ?? false,
    gateIssues: Array.isArray(a.gate_issues) ? (a.gate_issues as { code: string; detail: string }[]) : [],
    createdAt: a.created_at.toISOString(),
  };
}

export interface EntryOut {
  id: string;
  clientEntryId: string | null;
  farmId: string;
  planId: string | null;
  mode: EntryRow["mode"];
  version: number;
  status: EntryRow["status"];
  observedOn: string;
  observedAt: string | null;
  uploadedAt: string | null;
  mediaIds: string[];
  media: { id: string; contentPath: string; label: string }[];
  note: string | null;
  language: string | null;
  activity: string | null;
  quantity: { value: number; unit: string } | null;
  expense: { amountInr: string; category: string } | null;
  processingStatus: EntryRow["processing_status"];
  imageQuality: unknown;
  facts: FactOut[];
  analysis: AnalysisOut | null;
  provenanceLabel: string;
}

export function entryOut(e: EntryRow, facts: FactRow[], analysis: AnalysisRow | undefined, planFields: ReadonlySet<string>): EntryOut {
  return {
    id: e.id,
    clientEntryId: e.client_entry_id,
    farmId: e.farm_id,
    planId: e.plan_id,
    mode: e.mode,
    version: e.version,
    status: e.status,
    observedOn: e.entry_date,
    observedAt: e.observed_at?.toISOString() ?? null,
    uploadedAt: e.uploaded_at?.toISOString() ?? null,
    mediaIds: e.media_ids,
    media: e.media_ids.map((id) => ({ id, contentPath: `/api/v1/media/${id}/content?variant=normalized`, label: `Your photo · ${e.entry_date}` })),
    note: e.text_body,
    language: e.language,
    activity: e.activity,
    quantity: e.quantity !== null && e.quantity_unit ? { value: Number(e.quantity), unit: e.quantity_unit } : null,
    expense: e.expense_inr !== null ? { amountInr: e.expense_inr, category: e.expense_category ?? "other" } : null,
    processingStatus: e.processing_status,
    imageQuality: e.image_quality ?? null,
    facts: facts.filter((f) => f.entry_id === e.id).map((f) => factOut(f, planFields)),
    analysis: analysis ? analysisOut(analysis) : null,
    provenanceLabel: "Farmer-reported. Saved as you entered it.",
  };
}
