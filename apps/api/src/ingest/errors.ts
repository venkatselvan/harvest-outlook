/** Duck-typed to match the worker's `retryable` convention without importing worker/main (avoids an import cycle). */
export class IngestError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
    public readonly code = "ingest_error",
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** A replay-mode read was attempted without an availability cutoff (BUILD_SPEC 8.2: every replay input obeys availableAt <= cutoff). */
export class ReplayCutoffRequiredError extends IngestError {
  constructor(what: string) {
    super(`replay read of ${what} requires availableBy (decision cutoff)`, false, "replay_cutoff_required");
    this.name = "ReplayCutoffRequiredError";
  }
}
