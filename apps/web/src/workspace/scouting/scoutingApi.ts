import {
  CompleteCheckResult as completeCheckResultSchema,
  FieldChecks as fieldChecksSchema,
  FieldIssue as fieldIssueSchema,
  FieldIssues as fieldIssuesSchema,
  type AddIssueEvent,
  type CompleteCheck,
  type CompleteCheckResult,
  type CreateIssue,
  type FieldChecks,
  type FieldIssue,
  type FieldIssues,
  type IssueStatus,
} from "@harvest/contracts";
import { apiRequest, jsonInit } from "../../features/photo-region/http";
import { ApiError } from "../../lib/api";

/**
 * Typed clients for the scouting routes (docs/research/FIELD_OPERATIONS_SPEC.md 4.5 and 5.2). Every response is validated
 * against the shared contract and checked to belong to the requested farm (and issue). Writes send the client entry id as
 * the Idempotency-Key, so a retry of the same tap returns the stored result instead of a second journal entry.
 */
const farmPath = (farmId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}`;

/** The server answered with data that does not match the contract or belongs to another farm or issue. */
export class ScoutingDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoutingDataError";
  }
}

const query = (params: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
};

export const checksPath = (farmId: string, fieldId?: string | null) => `${farmPath(farmId)}/checks${query({ fieldId })}`;
export const completeCheckPath = (farmId: string) => `${farmPath(farmId)}/checks/complete`;
export const issuesPath = (farmId: string, opts: { fieldId?: string | null; status?: IssueStatus | null } = {}) =>
  `${farmPath(farmId)}/issues${query({ fieldId: opts.fieldId, status: opts.status })}`;
export const issuePath = (farmId: string, issueId: string) => `${farmPath(farmId)}/issues/${encodeURIComponent(issueId)}`;
export const issueEventsPath = (farmId: string, issueId: string) => `${issuePath(farmId, issueId)}/events`;

/** GET .../checks?fieldId= (on a farm with fields the field is required: 400 field_required). */
export async function loadChecks(farmId: string, fieldId?: string | null, fetchImpl?: typeof fetch): Promise<FieldChecks> {
  const env = await apiRequest<unknown>(checksPath(farmId, fieldId), undefined, fetchImpl);
  const parsed = fieldChecksSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.farmId !== farmId) throw new ScoutingDataError("The field checks could not be read.");
  return parsed.data;
}

/** POST .../checks/complete; 201 recorded, 200 with alreadyCompleted on a replay. */
export async function completeCheck(farmId: string, body: CompleteCheck, fetchImpl?: typeof fetch): Promise<CompleteCheckResult> {
  const env = await apiRequest<unknown>(completeCheckPath(farmId), jsonInit("POST", body, { "idempotency-key": body.clientEntryId }), fetchImpl);
  const parsed = completeCheckResultSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.check.id !== body.checkId) throw new ScoutingDataError("The check completion response did not match this check.");
  return parsed.data;
}

/** GET .../issues?fieldId=&status=: that field's issues plus the farm-wide ones (all issues without a field). */
export async function loadIssues(farmId: string, opts: { fieldId?: string | null; status?: IssueStatus | null } = {}, fetchImpl?: typeof fetch): Promise<FieldIssues> {
  const env = await apiRequest<unknown>(issuesPath(farmId, opts), undefined, fetchImpl);
  const parsed = fieldIssuesSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.farmId !== farmId) throw new ScoutingDataError("The issue list could not be read.");
  return parsed.data;
}

function ownIssue(data: unknown, farmId: string, issueId?: string): FieldIssue {
  const parsed = fieldIssueSchema.safeParse(data);
  if (!parsed.success || parsed.data.farmId !== farmId || (issueId && parsed.data.id !== issueId))
    throw new ScoutingDataError("The issue response did not match this farm.");
  return parsed.data;
}

/** GET .../issues/:issueId. */
export async function loadIssue(farmId: string, issueId: string, fetchImpl?: typeof fetch): Promise<FieldIssue> {
  return ownIssue((await apiRequest<unknown>(issuePath(farmId, issueId), undefined, fetchImpl)).data, farmId, issueId);
}

/** POST .../issues; 201 created, 200 on a replay of the same client entry id. */
export async function createIssue(farmId: string, body: CreateIssue, fetchImpl?: typeof fetch): Promise<FieldIssue> {
  const env = await apiRequest<unknown>(issuesPath(farmId), jsonInit("POST", body, { "idempotency-key": body.clientEntryId }), fetchImpl);
  return ownIssue(env.data, farmId);
}

/** POST .../issues/:issueId/events (status change, response or note); returns the updated issue. */
export async function addIssueEvent(farmId: string, issueId: string, body: AddIssueEvent, fetchImpl?: typeof fetch): Promise<FieldIssue> {
  const env = await apiRequest<unknown>(issueEventsPath(farmId, issueId), jsonInit("POST", body, { "idempotency-key": body.clientEntryId }), fetchImpl);
  return ownIssue(env.data, farmId, issueId);
}

/** The words shown under a failed scouting write; the draft stays on the device in every case. */
export const KEPT_ON_DEVICE = "Kept on this device; try again when online";

export interface ScoutingErrorInfo {
  /** network: the device could not reach the server (offline or a dropped connection). */
  kind: "network" | "conflict" | "outside" | "field" | "invalid" | "not_found" | "server";
  message: string;
  code?: string | undefined;
}

/** Plain-language error for a scouting read or write. */
export function describeScoutingError(error: unknown): ScoutingErrorInfo {
  if (error instanceof ScoutingDataError) return { kind: "invalid", message: `${error.message} Your saved records are unchanged.` };
  if (error instanceof ApiError) {
    const code = error.code;
    if (error.status === 0) return { kind: "network", message: "Could not reach the server.", code };
    if (code === "idempotency_conflict")
      return { kind: "conflict", message: "This form was already sent with different details. Start a new entry to record it again.", code };
    if (code === "location_outside_boundary")
      return { kind: "outside", message: "The location is outside the field. Mark a spot inside it, or leave the location empty.", code };
    if (code === "field_required") return { kind: "field", message: "This farm has fields. Choose the field first.", code };
    if (code === "field_not_found") return { kind: "field", message: "That field is no longer on this farm. Choose another field.", code };
    if (error.status === 404) return { kind: "not_found", message: error.message || "Not found.", code };
    if (code === "invalid_envelope" || code === "invalid_response" || code === "empty_response")
      return { kind: "invalid", message: "The server answer could not be read. Your saved records are unchanged.", code };
    return { kind: "server", message: error.message || "The server could not save this.", code };
  }
  return { kind: "server", message: "Something went wrong. Try again." };
}
