import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import { envelope } from "../envelope";
import type { JournalService } from "../journal/service";
import { ConfirmBody, CreateEntryBody, PreviewBody, TaskCompletionBody } from "../journal/types";
import { parseIdempotencyKey } from "../services/idempotency";
import type { IdempotencyHook } from "../plans";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { analysisQueuedOut, confirmOut, createEntryOut, previewOut, taskCompletionOut, timelineOut } from "./schemas/journal";

export interface JournalRouteDeps {
  config: Config;
  onEvidence?: (ownerId: string, entryId: string, sessionId: string | null) => Promise<void>;
  service: JournalService;
  /** Authenticated owner id from the session (INT2: `requireAuth(req).ownerId`). Never read from the body. */
  resolveOwner: (req: FastifyRequest) => string | Promise<string>;
  /** Optional session + CSRF guard (INT2: `privateRouteGuard(config, pool)`). */
  onRequest?: onRequestHookHandler;
  /** Session id for per-session budget accounting of the analysis job (optional). */
  resolveSession?: (req: FastifyRequest) => string | null;
  /** Idempotency storage (INT2: `{ run: (o, e) => runIdempotent(pool, o, e) }`). Without it the key is validated but not stored. */
  idempotency?: IdempotencyHook;
}

/** Registers the journal routes in their own encapsulated context. Not wired into server.ts here. */
export async function registerJournalRoutes(app: FastifyInstance, deps: JournalRouteDeps): Promise<void> {
  await app.register(async (scope) => {
    if (deps.onRequest) scope.addHook("onRequest", deps.onRequest);
    const r = scope.withTypeProvider<ZodTypeProvider>();
    const mode = deps.config.RUNTIME_MODE;
    const svc = deps.service;

    r.post(
      "/api/v1/journal",
      {
        schema: {
          tags: ["journal"],
          description:
            "Saves a journal entry exactly as the farmer entered it (farmer-reported; originals are never modified). clientEntryId is the stable client id; the same id with the same content replays the saved entry (200), different content is 409. Supports Idempotency-Key. Linked crop observations queue milestone previews; provider calls run in background workers.",
          body: CreateEntryBody,
          response: { 201: envelopeSchema(createEntryOut), 200: envelopeSchema(createEntryOut) },
        },
      },
      async (req, reply) => {
        const ownerId = await deps.resolveOwner(req);
        const key = parseIdempotencyKey(req.headers["idempotency-key"]);
        const exec = async () => {
          const out = await svc.createEntry(ownerId, req.body);
          await deps.onEvidence?.(ownerId,out.entry.id,deps.resolveSession?.(req) ?? null).catch(error => req.log.warn({error}, 'Journal milestone refresh deferred'));
          return { status: out.created ? 201 : 200, body: envelope(req.id, mode, { entry: out.entry }, out.created ? [] : ["replayed_existing_entry"]) };
        };
        const out = deps.idempotency ? await deps.idempotency.run({ ownerId, key, route: "POST /api/v1/journal", hashInput: req.body }, exec) : { ...(await exec()), replay: false };
        if (out.replay) reply.header("idempotent-replay", "true");
        return reply.code(out.status as 201).send(out.body as never);
      },
    );

    r.get(
      "/api/v1/farms/:id/journal",
      {
        schema: {
          tags: ["journal"],
          description: "Owner-scoped season story: entries with original, proposed and confirmed facts, completed tasks and plan revisions (with the engine's change summary). Other owners' farms are 404.",
          params: uuidParam,
          response: { 200: envelopeSchema(timelineOut) },
        },
      },
      async (req) => envelope(req.id, mode, await svc.timeline(await deps.resolveOwner(req), req.params.id) as never),
    );

    r.get(
      "/api/v1/journal/:id",
      {
        schema: { tags: ["journal"], description: "One owned entry with its facts and latest analysis.", params: uuidParam, response: { 200: envelopeSchema(createEntryOut) } },
      },
      async (req) => envelope(req.id, mode, { entry: await svc.getEntry(await deps.resolveOwner(req), req.params.id) }),
    );

    r.post(
      "/api/v1/journal/:id/analysis",
      {
        schema: {
          tags: ["journal"],
          description:
            "Queues the multimodal observation analysis (job type journal.analysis) and returns the job id. One live analysis per entry; a retry after failure queues a new one. Results are proposals only: poll GET /jobs/:id, then GET /journal/:id.",
          params: uuidParam,
          response: { 202: envelopeSchema(analysisQueuedOut) },
        },
      },
      async (req, reply) => {
        const ownerId = await deps.resolveOwner(req);
        const out = await svc.requestAnalysis(ownerId, req.params.id, deps.resolveSession?.(req) ?? null);
        return reply.code(202).send(envelope(req.id, mode, { jobId: out.jobId, analysisId: out.analysisId, state: out.status, deduplicated: out.deduplicated }));
      },
    );

    r.post(
      "/api/v1/journal/:id/revision-preview",
      {
        schema: {
          tags: ["journal"],
          description: "Runs the plan engine on the typed changes that accepting these proposals would make and rolls it back: old and new assumptions, changed tasks and economic delta, with nothing saved.",
          params: uuidParam,
          body: PreviewBody,
          response: { 200: envelopeSchema(previewOut) },
        },
      },
      async (req) => envelope(req.id, mode, (await svc.previewRevision(await deps.resolveOwner(req), req.params.id, req.body.factIds)) as never),
    );

    r.post(
      "/api/v1/journal/:id/confirmations",
      {
        schema: {
          tags: ["journal"],
          description:
            "Accept or reject proposed facts. expectedVersion must equal the entry version (409 version_conflict otherwise). Accepted facts that map to a typed plan change (observed_stage, irrigation_category, planting_date) create a plan revision through the plan engine and need expectedPlanContentHash. Proposals never confirm themselves.",
          params: uuidParam,
          body: ConfirmBody,
          response: { 200: envelopeSchema(confirmOut) },
        },
      },
      async (req) => {
        const ownerId = await deps.resolveOwner(req);
        const result = await svc.confirm(ownerId, req.params.id, req.body);
        await deps.onEvidence?.(ownerId,req.params.id,deps.resolveSession?.(req) ?? null).catch(error => req.log.warn({error}, 'Journal milestone refresh deferred'));
        return envelope(req.id,mode,result as never);
      },
    );

    r.post(
      "/api/v1/journal/:id/task-completions",
      {
        schema: {
          tags: ["journal"],
          description: "Marks a task of the entry's plan as done on a date. Feeds the plan timeline's done state.",
          params: uuidParam,
          body: TaskCompletionBody,
          response: { 200: envelopeSchema(taskCompletionOut) },
        },
      },
      async (req) => envelope(req.id, mode, await svc.completeTask(await deps.resolveOwner(req), req.params.id, req.body)),
    );

  });
}
