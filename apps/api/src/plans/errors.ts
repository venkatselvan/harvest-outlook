import { ApiError } from "../services/errors";

/** Plan-engine errors are ApiErrors so the server error handler renders them into the standard envelope. */
export class PlanError extends ApiError {
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(statusCode, code, message, details);
    this.name = "PlanError";
  }
}

export const planNotFound = () => new PlanError(404, "not_found", "Plan not found");
export const versionConflict = (message: string, details?: unknown) => new PlanError(409, "version_conflict", message, details);
export const invalidPlanInput = (message: string, details?: unknown) => new PlanError(422, "validation_failed", message, details);
export const modeMismatch = (message: string) => new PlanError(409, "mode_mismatch", message);

/** Replay leakage: a data row would not have been available at the decision cutoff. Thrown, never filtered silently. */
export class ReplayLeakError extends PlanError {
  constructor(message: string, details?: unknown) {
    super(422, "replay_leakage", message, details);
    this.name = "ReplayLeakError";
  }
}
