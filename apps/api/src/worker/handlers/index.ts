import { createIngestHandlers } from "./ingest";

/** Job-type -> handler registry for T05a. Imported by worker/main.ts. */
export const ingestHandlers = createIngestHandlers();
