import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Assumption, Id, SchemaVersion, VersionRef } from "@harvest/contracts";
import { REPO_ROOT } from "../catalogue/files";
import { TaskTemplate } from "./types";

/**
 * Curated task template sets (data/curated/tasks/<cropId>.<regionKey>.tasks.json).
 *
 * The loader is deliberately strict because tasks are the part of the plan a farmer acts on:
 * - every evidence id (templates and assumptions) must exist in the matching curated evidence file;
 * - `amount` must be null (no dose, quantity or numeric prescription ships in a template);
 * - every offset basis and trigger threshold must refer to an assumption declared in the same file;
 * - a template with no evidence is only allowed for `record_observation` (an app action, not an agronomic claim).
 */
const TaskTemplateFile = z
  .object({
    schemaVersion: SchemaVersion,
    cropId: Id,
    regionKey: Id,
    evidenceFile: z.string().optional(),
    templateSet: VersionRef,
    note: z.string().optional(),
    assumptions: z.array(Assumption).max(100),
    taskTemplates: z.array(TaskTemplate).max(200),
  })
  .strict();

export interface TaskTemplateSet {
  cropId: string;
  regionKey: string;
  templateSet: z.infer<typeof VersionRef>;
  assumptions: z.infer<typeof Assumption>[];
  taskTemplates: z.infer<typeof TaskTemplate>[];
}

export class TaskTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTemplateError";
  }
}

/** Validates a parsed template file against the set of known evidence ids. Pure. */
export function parseTaskTemplateSet(raw: unknown, knownEvidenceIds: ReadonlySet<string>): TaskTemplateSet {
  // Numeric amounts are rejected before the schema so the failure is specific.
  const rawTemplates = (raw as { taskTemplates?: { id?: string; amount?: unknown }[] } | null)?.taskTemplates;
  for (const t of Array.isArray(rawTemplates) ? rawTemplates : []) {
    if (t && t.amount !== null && t.amount !== undefined) throw new TaskTemplateError(`task template ${t.id ?? "?"}: amount must be null (no amounts or doses in templates)`);
  }
  const r = TaskTemplateFile.safeParse(raw);
  if (!r.success) throw new TaskTemplateError(`task template file invalid: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const f = r.data;
  const assumptionIds = new Set(f.assumptions.map((a) => a.id));
  if (assumptionIds.size !== f.assumptions.length) throw new TaskTemplateError("duplicate assumption id");
  const ids = new Set<string>();
  const unknownEvidence = (list: string[]) => list.filter((e) => !knownEvidenceIds.has(e));
  for (const a of f.assumptions) {
    const bad = unknownEvidence(a.evidenceIds);
    if (bad.length) throw new TaskTemplateError(`assumption ${a.id}: unknown evidence id ${bad.join(", ")}`);
  }
  for (const t of f.taskTemplates) {
    if (ids.has(t.id)) throw new TaskTemplateError(`duplicate task template id ${t.id}`);
    ids.add(t.id);
    const bad = unknownEvidence(t.evidenceIds);
    if (bad.length) throw new TaskTemplateError(`task template ${t.id}: unknown evidence id ${bad.join(", ")}`);
    if (t.evidenceIds.length === 0 && t.taskType !== "record_observation") throw new TaskTemplateError(`task template ${t.id}: evidenceIds required for ${t.taskType}`);
    if (t.amount !== null) throw new TaskTemplateError(`task template ${t.id}: amount must be null`);
    if (t.offsetBasis.kind === "assumption" && !assumptionIds.has(t.offsetBasis.assumptionId)) throw new TaskTemplateError(`task template ${t.id}: offset assumption ${t.offsetBasis.assumptionId} is not declared`);
    if (t.trigger && !assumptionIds.has(t.trigger.thresholdAssumptionId)) throw new TaskTemplateError(`task template ${t.id}: trigger assumption ${t.trigger.thresholdAssumptionId} is not declared`);
  }
  for (const t of f.taskTemplates) for (const d of t.dependsOn) if (!ids.has(d)) throw new TaskTemplateError(`task template ${t.id}: dependsOn unknown template ${d}`);
  return { cropId: f.cropId, regionKey: f.regionKey, templateSet: f.templateSet, assumptions: f.assumptions, taskTemplates: f.taskTemplates };
}

/** Region key used in file names: last segment of the stage set's scope id (IN-KA-hassan -> hassan). */
export const regionKeyOfScopeId = (id: string): string => id.split("-").pop()!.toLowerCase();

const evidenceCache = new Map<string, Set<string>>();
function evidenceIdsFor(root: string, cropId: string, regionKey: string): Set<string> | null {
  const path = join(root, "data", "curated", "evidence", `${cropId}.${regionKey}.evidence.json`);
  if (!existsSync(path)) return null;
  const hit = evidenceCache.get(path);
  if (hit) return hit;
  const ids = new Set((JSON.parse(readFileSync(path, "utf8")) as { id: string }[]).map((e) => e.id));
  evidenceCache.set(path, ids);
  return ids;
}

/**
 * Loads and validates data/curated/tasks/<cropId>.<regionKey>.tasks.json. Returns null when no file exists (the plan then has no
 * tasks and says so). A file that exists but is invalid throws, so a bad curation can never silently produce an empty plan.
 */
export function loadTaskTemplateSet(cropId: string, regionKey: string, root = REPO_ROOT): TaskTemplateSet | null {
  const path = join(root, "data", "curated", "tasks", `${cropId}.${regionKey}.tasks.json`);
  if (!existsSync(path)) return null;
  const known = evidenceIdsFor(root, cropId, regionKey);
  if (!known) throw new TaskTemplateError(`${path}: no curated evidence file for ${cropId}.${regionKey}`);
  const set = parseTaskTemplateSet(JSON.parse(readFileSync(path, "utf8")), known);
  if (set.cropId !== cropId || set.regionKey !== regionKey) throw new TaskTemplateError(`${path}: cropId/regionKey do not match the file name`);
  return set;
}
