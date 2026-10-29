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
